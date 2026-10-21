// Backend del catálogo: lista, agrega, edita y borra productos, y guarda sus fotos.
// Todo se guarda en Netlify Blobs y, si se configura, se respalda solo en GitHub (carpeta /respaldo).
// Las acciones de escritura exigen la contraseña que se define en la variable de entorno ADMIN_PASSWORD.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const CATEGORIAS = ['parejas', 'caballero', 'llaveros', 'collares'];
const MAX_PRODUCTOS = 150;
const MAX_FOTOS = 4;
const MAX_BYTES_FOTO = 1_500_000;
const MAX_BYTES_VIDEO = 5_000_000;      // la respuesta de una función de Netlify no puede pasar de ~6 MB
const MAX_BYTES_PARTE = 2_000_000;      // el video se sube en pedazos para no pasar el límite de cada petición
const MAX_PARTES = 4;

const catalogo = () => getStore({ name: 'catalogo', consistency: 'strong' });
const fotos = () => getStore({ name: 'fotos', consistency: 'strong' });
const videos = () => getStore({ name: 'videos', consistency: 'strong' });
const partesVideo = () => getStore({ name: 'videos-partes', consistency: 'strong' });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fallo = (mensaje, status = 400) => json({ error: mensaje }, status);

const huella = (s) => createHash('sha256').update(String(s)).digest();

function revisarClave(req) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) return 'sin-configurar';
  const dada = req.headers.get('x-admin-password') || '';
  return timingSafeEqual(huella(real), huella(dada)) ? 'ok' : 'incorrecta';
}

const texto = (valor, max) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function leerLista() {
  return (await catalogo().get('lista', { type: 'json' })) || [];
}
async function guardarLista(lista) {
  await catalogo().setJSON('lista', lista);
}

// ---- Ajustes: productos ocultos/agotados, precios de los fijos y tasa del día ----
const AJUSTES_BASE = { ocultos: [], agotados: [], precios: {}, fijos: {}, tasaModo: 'auto', tasaManual: null, tasaManualFecha: null };
async function leerAjustes() {
  return { ...AJUSTES_BASE, ...((await catalogo().get('ajustes', { type: 'json' })) || {}) };
}
const ID_OK = /^[A-Za-z0-9]{1,40}$/;
const idsValidos = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && ID_OK.test(x)))].slice(0, 400);

// Tasa del euro (BCV). Se consulta una API pública y se guarda 2 horas para no abusar de ella.
const URL_TASA = 'https://ve.dolarapi.com/v1/euros/oficial';
async function tasaAuto() {
  const cache = await catalogo().get('tasa-cache', { type: 'json' });
  if (cache && Date.now() - cache.leido < 2 * 3600 * 1000) return cache;
  try {
    const r = await fetch(URL_TASA, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const v = Number(d.promedio ?? d.venta ?? d.compra);
      if (isFinite(v) && v > 0) {
        const nuevo = { valor: Math.round(v * 10000) / 10000, fecha: d.fechaActualizacion || null, leido: Date.now() };
        await catalogo().setJSON('tasa-cache', nuevo);
        return nuevo;
      }
    }
  } catch (e) { /* sin respuesta: se usa la última tasa guardada */ }
  return cache || null;
}

const claveDeUrl = (url) => (typeof url === 'string' && url.startsWith('/api/img/') ? url.slice(9) : null);

async function subirFotos(dataUrls) {
  const urls = [];
  for (const d of dataUrls) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(d));
    if (!m) throw new Error('Una de las fotos no tiene un formato válido (usa JPG, PNG o WebP).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_BYTES_FOTO) throw new Error('Una de las fotos es demasiado pesada.');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const clave = `${randomBytes(12).toString('hex')}.${ext}`;
    const datos = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    await fotos().set(clave, datos, { metadata: { type: `image/${m[1]}` } });
    urls.push(`/api/img/${clave}`);
  }
  return urls;
}

const claveDeVideo = (url) => (typeof url === 'string' && url.startsWith('/api/video/') ? url.slice(11) : null);
const CLAVE_VIDEO = /^[a-f0-9]{24}\.(mp4|webm)$/;

async function borrarVideo(url) {
  const k = claveDeVideo(url);
  if (k && CLAVE_VIDEO.test(k)) await videos().delete(k);
}

// Un video es válido si ya está guardado en el servidor (/api/video/...), o es uno de fábrica (videos/...).
async function videoValido(url, permitirFabrica = false) {
  if (typeof url !== 'string' || !url) return false;
  if (permitirFabrica && /^videos\/[\w.-]+\.(mp4|webm)$/.test(url)) return true;
  const k = claveDeVideo(url);
  if (!k || !CLAVE_VIDEO.test(k)) return false;
  return !!(await videos().getMetadata(k));
}

// Recibe el video por partes y, al llegar la última, lo arma y lo guarda.
async function recibirParteVideo(c) {
  const id = String(c.id || '');
  const n = Number(c.n), total = Number(c.total);
  const tipo = c.tipo === 'webm' ? 'webm' : 'mp4';
  if (!/^[a-f0-9]{24}$/.test(id) || !Number.isInteger(n) || !Number.isInteger(total) || total < 1 || total > MAX_PARTES || n < 0 || n >= total) {
    throw new Error('Falta información para subir el video. Intenta de nuevo.');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(String(c.data || ''))) throw new Error('El video no se pudo leer. Intenta de nuevo.');
  const buf = Buffer.from(c.data, 'base64');
  if (!buf.length || buf.length > MAX_BYTES_PARTE) throw new Error('El video es demasiado pesado (máximo 5 MB).');
  const pasa = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  await partesVideo().set(`${id}.${n}`, pasa(buf));
  if (n < total - 1) return { ok: true };

  const trozos = [];
  for (let i = 0; i < total; i++) {
    const t = await partesVideo().get(`${id}.${i}`, { type: 'arrayBuffer' });
    if (!t) throw new Error('Se perdió una parte del video. Intenta subirlo de nuevo.');
    trozos.push(Buffer.from(t));
  }
  const video = Buffer.concat(trozos);
  for (let i = 0; i < total; i++) await partesVideo().delete(`${id}.${i}`);
  if (video.length > MAX_BYTES_VIDEO) throw new Error('El video es demasiado pesado (máximo 5 MB).');
  const esMp4 = video.length > 12 && video.subarray(4, 8).toString('latin1') === 'ftyp';
  const esWebm = video.length > 4 && video[0] === 0x1a && video[1] === 0x45 && video[2] === 0xdf && video[3] === 0xa3;
  if (!esMp4 && !esWebm) throw new Error('El video no tiene un formato válido (usa MP4 o WebM).');
  const ext = esWebm ? 'webm' : 'mp4';
  const clave = `${id}.${ext}`;
  await videos().set(clave, pasa(video), { metadata: { type: `video/${ext}` } });
  return { ok: true, url: `/api/video/${clave}` };
}

async function borrarFotos(urls) {
  for (const u of urls) {
    const k = claveDeUrl(u);
    if (k && /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(k)) await fotos().delete(k);
  }
}

// ---- Respaldo automático en GitHub ----------------------------------------------------------
// Cada vez que el dueño publica/edita/borra algo, se copian las fotos nuevas y el listado de
// productos a la carpeta  respaldo/  del repositorio (un solo commit por cambio).
// Variables de entorno en Netlify:  GITHUB_TOKEN  (token con permiso "Contents: Read and write"),
//   GITHUB_REPO = usuario/repositorio   y, si la rama no es "main",  GITHUB_BRANCH.
const RESPALDO_DIR = 'respaldo';
const respaldoConfig = () => {
  const token = process.env.GITHUB_TOKEN;
  const repo = (process.env.GITHUB_REPO || '').trim();
  const rama = (process.env.GITHUB_BRANCH || 'main').trim();
  const ok = !!token && /^[\w.-]+\/[\w.-]+$/.test(repo) && /^[\w./-]+$/.test(rama);
  return { ok, token, repo, rama };
};

async function gh(cfg, ruta, opciones = {}) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}${ruta}`, {
    ...opciones,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'catalogo-respaldo',
      ...(opciones.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) {
    const e = new Error(`GitHub respondió ${r.status} en ${opciones.method || 'GET'} ${ruta.split('?')[0]}`);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? null : r.json();
}

async function guardarEstadoRespaldo(estado) {
  try { await catalogo().setJSON('respaldo-estado', { ...estado, fecha: new Date().toISOString() }); } catch (e) { /* no es crítico */ }
}

// Sube a GitHub hasta `limite` fotos que falten y el listado actual. Devuelve cuántas quedan pendientes.
async function sincronizarRespaldo(limite = 10, intento = 0) {
  const cfg = respaldoConfig();
  if (!cfg.ok) return { ok: false, sinConfigurar: true, pendientes: 0 };
  try {
    const lista = await leerLista();
    const ajustes = await leerAjustes();
    const todos = [...lista, ...Object.values(ajustes.fijos || {})];
    const clavesFoto = [...new Set(todos.flatMap((p) => (p.imgs || []).map(claveDeUrl)).filter(Boolean))];
    const clavesVideo = [...new Set(todos.map((p) => claveDeVideo(p.video)).filter(Boolean))];

    const listar = async (carpeta) => {
      try {
        const dir = await gh(cfg, `/contents/${RESPALDO_DIR}/${carpeta}?ref=${encodeURIComponent(cfg.rama)}`);
        return new Set((Array.isArray(dir) ? dir : []).map((f) => f.name));
      } catch (e) { if (e.status === 404) return new Set(); throw e; }
    };
    const [fotosEnRepo, videosEnRepo] = await Promise.all([listar('fotos'), listar('videos')]);

    const faltan = [
      ...clavesFoto.filter((k) => !fotosEnRepo.has(k)).map((k) => ({ k, tipo: 'fotos' })),
      ...clavesVideo.filter((k) => !videosEnRepo.has(k)).map((k) => ({ k, tipo: 'videos' })),
    ];
    // Los videos pesan más: se suben pocos por vez (el botón "Respaldar ahora" repite hasta terminar).
    const lote = [];
    let peso = 0;
    for (const it of faltan) {
      const w = it.tipo === 'videos' ? 5 : 1;
      if (lote.length && peso + w > limite) break;
      lote.push(it); peso += w;
    }

    const ref = await gh(cfg, `/git/ref/heads/${encodeURIComponent(cfg.rama)}`);
    const commitBase = await gh(cfg, `/git/commits/${ref.object.sha}`);

    const entradas = [];
    for (const { k, tipo } of lote) {
      const datos = await (tipo === 'videos' ? videos() : fotos()).get(k, { type: 'arrayBuffer' });
      if (!datos) continue;
      const blob = await gh(cfg, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: Buffer.from(datos).toString('base64'), encoding: 'base64' }) });
      entradas.push({ path: `${RESPALDO_DIR}/${tipo}/${k}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const aRuta = (u) => (claveDeUrl(u) ? `${RESPALDO_DIR}/fotos/${claveDeUrl(u)}` : claveDeVideo(u) ? `${RESPALDO_DIR}/videos/${claveDeVideo(u)}` : u);
    const conRutas = (p) => ({ ...p, ...(p.imgs ? { imgs: p.imgs.map(aRuta) } : {}), ...(p.video ? { video: aRuta(p.video) } : {}) });
    const listado = {
      aviso: 'Copia automática hecha desde el panel de administrador. No la edites a mano: se reescribe en cada cambio.',
      productos: lista.map(conRutas),
      ajustes: { ...ajustes, fijos: Object.fromEntries(Object.entries(ajustes.fijos || {}).map(([id, p]) => [id, conRutas(p)])) },
    };
    const blobLista = await gh(cfg, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(listado, null, 2), encoding: 'utf-8' }) });
    entradas.push({ path: `${RESPALDO_DIR}/productos.json`, mode: '100644', type: 'blob', sha: blobLista.sha });

    const arbol = await gh(cfg, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: commitBase.tree.sha, tree: entradas }) });
    const commit = await gh(cfg, '/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: `Respaldo del catálogo (${entradas.length - 1} archivo(s) nuevo(s)) [skip netlify]`, tree: arbol.sha, parents: [ref.object.sha] }),
    });
    await gh(cfg, `/git/refs/heads/${encodeURIComponent(cfg.rama)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });

    const pendientes = Math.max(0, faltan.length - lote.length);
    await guardarEstadoRespaldo({ ok: true, fotosSubidas: entradas.length - 1, pendientes });
    return { ok: true, subidas: entradas.length - 1, pendientes };
  } catch (e) {
    // Si alguien subió algo a la rama justo en ese momento, se reintenta una vez.
    if (intento < 1 && (e.status === 422 || e.status === 409)) {
      await new Promise((r) => setTimeout(r, 800));
      return sincronizarRespaldo(limite, intento + 1);
    }
    console.error('Respaldo en GitHub falló:', e.message);
    const mensaje = e.status === 401 || e.status === 403 ? 'GitHub no aceptó el token (revisa GITHUB_TOKEN y que tenga permiso de escritura en Contents).'
      : e.status === 404 ? 'GitHub no encontró el repositorio o la rama (revisa GITHUB_REPO y GITHUB_BRANCH).'
      : 'No se pudo conectar con GitHub. Se reintentará con el próximo cambio.';
    await guardarEstadoRespaldo({ ok: false, error: mensaje });
    return { ok: false, error: mensaje, pendientes: null };
  }
}

// Después de cada cambio: respalda sin hacer esperar al dueño.
function respaldarEnSegundoPlano(context) {
  if (!respaldoConfig().ok) return;
  const tarea = sincronizarRespaldo();
  if (context && typeof context.waitUntil === 'function') context.waitUntil(tarea);
  else tarea.catch(() => {});
}

// Valida los campos de texto y las fotos. `previo` es el producto existente (al editar).
async function armarProducto(cuerpo, previo) {
  const nombre = texto(cuerpo.nombre, 80);
  if (!nombre) throw new Error('Falta el título del producto.');
  const cat = CATEGORIAS.includes(cuerpo.cat) ? cuerpo.cat : null;
  if (!cat) throw new Error('Elige una categoría.');

  const existentes = previo ? previo.imgs : [];
  const mantener = (Array.isArray(cuerpo.mantener) ? cuerpo.mantener : []).filter((u) => existentes.includes(u));
  const nuevas = Array.isArray(cuerpo.nuevas) ? cuerpo.nuevas : [];
  if (mantener.length + nuevas.length < 1) throw new Error('Agrega al menos una foto.');
  if (mantener.length + nuevas.length > MAX_FOTOS) throw new Error(`Máximo ${MAX_FOTOS} fotos por producto.`);

  let video = '';
  if (cuerpo.video) {
    if (previo && previo.video === cuerpo.video) video = previo.video;
    else if (await videoValido(cuerpo.video)) video = cuerpo.video;
    else throw new Error('El video no se subió bien. Vuelve a elegirlo.');
  }
  const subidas = await subirFotos(nuevas);
  const quitadas = existentes.filter((u) => !mantener.includes(u));
  return {
    producto: {
      id: previo ? previo.id : `n${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      nombre,
      precio: texto(cuerpo.precio, 20),
      cat,
      imgs: [...mantener, ...subidas],
      ...(video ? { video } : {}),
      creado: previo ? previo.creado : Date.now(),
    },
    quitadas,
    videoQuitado: previo && previo.video && previo.video !== video ? previo.video : null,
  };
}

export default async (req, context) => {
  try {
    const { pathname } = new URL(req.url);
    const ruta = pathname.replace(/\/+$/, '');
    const metodo = req.method;

    // ---- Fotos (público) ----
    if (ruta.startsWith('/api/img/') && metodo === 'GET') {
      const clave = decodeURIComponent(ruta.slice(9));
      if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(clave)) return new Response('No encontrada', { status: 404 });
      const foto = await fotos().getWithMetadata(clave, { type: 'arrayBuffer' });
      if (!foto) return new Response('No encontrada', { status: 404 });
      return new Response(foto.data, {
        headers: {
          'content-type': foto.metadata?.type || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // ---- Videos (público, con soporte de "Range" para que se puedan adelantar en el celular) ----
    if (ruta.startsWith('/api/video/') && metodo === 'GET') {
      const clave = decodeURIComponent(ruta.slice(11));
      if (!CLAVE_VIDEO.test(clave)) return new Response('No encontrado', { status: 404 });
      const v = await videos().getWithMetadata(clave, { type: 'arrayBuffer' });
      if (!v) return new Response('No encontrado', { status: 404 });
      const datos = Buffer.from(v.data);
      const tipo = v.metadata?.type || 'video/mp4';
      const base = { 'content-type': tipo, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
      if (m && (m[1] || m[2])) {
        let ini = m[1] ? Number(m[1]) : datos.length - Number(m[2]);
        let fin = m[1] && m[2] ? Number(m[2]) : datos.length - 1;
        ini = Math.max(0, ini); fin = Math.min(fin, datos.length - 1);
        if (ini > fin) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${datos.length}` } });
        return new Response(datos.subarray(ini, fin + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${ini}-${fin}/${datos.length}`, 'content-length': String(fin - ini + 1) } });
      }
      return new Response(datos, { headers: { ...base, 'content-length': String(datos.length) } });
    }

    // ---- Lista (público) ----
    if (ruta === '/api/productos' && metodo === 'GET') {
      return json(await leerLista());
    }

    // ---- Ajustes y tasa (público) ----
    if (ruta === '/api/ajustes' && metodo === 'GET') return json(await leerAjustes());
    if (ruta === '/api/tasa' && metodo === 'GET') {
      const aj = await leerAjustes();
      const manual = aj.tasaManual > 0 ? { valor: aj.tasaManual, fuente: 'manual', fecha: aj.tasaManualFecha } : null;
      if (aj.tasaModo === 'manual' && manual) return json(manual);
      const t = await tasaAuto();
      if (t) return json({ valor: t.valor, fuente: 'BCV', fecha: t.fecha });
      return json(manual || { valor: null });
    }

    // ---- Todo lo demás exige contraseña ----
    const acceso = revisarClave(req);
    if (acceso === 'sin-configurar') {
      return fallo('Falta configurar la variable ADMIN_PASSWORD en Netlify.', 500);
    }
    if (acceso !== 'ok') {
      await new Promise((r) => setTimeout(r, 700));
      return fallo('Contraseña incorrecta.', 401);
    }

    if (ruta === '/api/login' && metodo === 'POST') return json({ ok: true });

    if (ruta === '/api/respaldo' && metodo === 'GET') {
      const cfg = respaldoConfig();
      const estado = (await catalogo().get('respaldo-estado', { type: 'json' })) || null;
      return json({ configurado: cfg.ok, repo: cfg.ok ? cfg.repo : null, estado });
    }
    if (ruta === '/api/respaldo' && metodo === 'POST') return json(await sincronizarRespaldo(10));

    if (ruta === '/api/video-parte' && metodo === 'POST') return json(await recibirParteVideo(await req.json()));

    const f = /^\/api\/fijos\/([A-Za-z0-9]{1,40})$/.exec(ruta);
    if (f && metodo === 'PUT') {
      const id = f[1];
      const c = await req.json();
      const aj = await leerAjustes();
      const previo = aj.fijos[id] || { imgs: [], video: null };
      if (!aj.fijos[id] && Object.keys(aj.fijos).length >= 100) return fallo('Demasiados productos modificados.');
      const nombre = texto(c.nombre, 80);
      if (!nombre) throw new Error('Falta el título del producto.');
      const mantener = (Array.isArray(c.mantener) ? c.mantener : []).filter((u) =>
        typeof u === 'string' && (previo.imgs.includes(u) || /^imagenes\/[\w.-]+\.(jpg|jpeg|png|webp)$/.test(u)));
      const nuevas = Array.isArray(c.nuevas) ? c.nuevas : [];
      if (mantener.length + nuevas.length < 1) throw new Error('Agrega al menos una foto.');
      if (mantener.length + nuevas.length > MAX_FOTOS) throw new Error(`Máximo ${MAX_FOTOS} fotos por producto.`);
      let video = '';   // '' = sin video
      if (c.video) {
        if (previo.video === c.video || await videoValido(c.video, true)) video = c.video;
        else throw new Error('El video no se subió bien. Vuelve a elegirlo.');
      }
      const subidas = await subirFotos(nuevas);
      const imgs = [...mantener, ...subidas];
      const quitadas = previo.imgs.filter((u) => !imgs.includes(u));
      aj.fijos[id] = { nombre, imgs, video };
      if ('precio' in c) {
        const t = texto(c.precio, 20);
        if (t) aj.precios[id] = t; else delete aj.precios[id];
      }
      await catalogo().setJSON('ajustes', aj);
      await borrarFotos(quitadas);
      if (previo.video && previo.video !== video) await borrarVideo(previo.video);
      respaldarEnSegundoPlano(context);
      return json(aj);
    }
    if (f && metodo === 'DELETE') {   // volver al producto original de fábrica
      const aj = await leerAjustes();
      const previo = aj.fijos[f[1]];
      if (previo) {
        delete aj.fijos[f[1]];
        await catalogo().setJSON('ajustes', aj);
        await borrarFotos(previo.imgs);
        if (previo.video) await borrarVideo(previo.video);
        respaldarEnSegundoPlano(context);
      }
      return json(aj);
    }

    if (ruta === '/api/productos' && metodo === 'POST') {
      const lista = await leerLista();
      if (lista.length >= MAX_PRODUCTOS) return fallo('Llegaste al máximo de productos.');
      const { producto } = await armarProducto(await req.json(), null);
      lista.unshift(producto);
      await guardarLista(lista);
      respaldarEnSegundoPlano(context);
      return json(producto, 201);
    }

    if (ruta === '/api/ajustes' && metodo === 'PUT') {
      const c = await req.json();
      const aj = await leerAjustes();
      if ('ocultos' in c) aj.ocultos = idsValidos(c.ocultos);
      if ('agotados' in c) aj.agotados = idsValidos(c.agotados);
      if ('precios' in c) {
        const p = {};
        for (const [k, v] of Object.entries(c.precios && typeof c.precios === 'object' ? c.precios : {}).slice(0, 400)) {
          const t = texto(v, 20);
          if (ID_OK.test(k) && t) p[k] = t;
        }
        aj.precios = p;
      }
      if ('tasaModo' in c) {
        aj.tasaModo = c.tasaModo === 'manual' ? 'manual' : 'auto';
        if (aj.tasaModo === 'manual') {
          const v = Number(String(c.tasaManual ?? '').replace(',', '.'));
          if (!isFinite(v) || v <= 0 || v > 1e7) throw new Error('Falta escribir la tasa manual (un número mayor que 0).');
          aj.tasaManual = Math.round(v * 10000) / 10000;
          aj.tasaManualFecha = new Date().toISOString();
        }
      }
      await catalogo().setJSON('ajustes', aj);
      respaldarEnSegundoPlano(context);
      return json(aj);
    }

    const m = /^\/api\/productos\/([A-Za-z0-9]+)$/.exec(ruta);
    if (m && (metodo === 'PUT' || metodo === 'DELETE')) {
      const lista = await leerLista();
      const i = lista.findIndex((p) => p.id === m[1]);
      if (i < 0) return fallo('Ese producto ya no existe.', 404);

      if (metodo === 'DELETE') {
        const [borrado] = lista.splice(i, 1);
        await guardarLista(lista);
        await borrarFotos(borrado.imgs);
        if (borrado.video) await borrarVideo(borrado.video);
        const aj = await leerAjustes();
        if (aj.agotados.includes(borrado.id) || aj.precios[borrado.id]) {
          aj.agotados = aj.agotados.filter((x) => x !== borrado.id);
          delete aj.precios[borrado.id];
          await catalogo().setJSON('ajustes', aj);
        }
        respaldarEnSegundoPlano(context);
        return json({ ok: true });
      }

      const { producto, quitadas, videoQuitado } = await armarProducto(await req.json(), lista[i]);
      lista[i] = producto;
      await guardarLista(lista);
      await borrarFotos(quitadas);
      if (videoQuitado) await borrarVideo(videoQuitado);
      respaldarEnSegundoPlano(context);
      return json(producto);
    }

    return fallo('Ruta no encontrada.', 404);
  } catch (e) {
    const esDeUsuario = /^(Falta|Elige|Agrega|Máximo|Una de las fotos|El video|Se perdió)/.test(e.message);
    if (!esDeUsuario) console.error(e);
    return fallo(esDeUsuario ? e.message : 'Ocurrió un error en el servidor. Intenta de nuevo.', esDeUsuario ? 400 : 500);
  }
};

export const config = {
  path: ['/api/productos', '/api/productos/*', '/api/img/*', '/api/login', '/api/ajustes', '/api/tasa', '/api/respaldo', '/api/video/*', '/api/video-parte', '/api/fijos/*'],
};
