// Backend del catálogo: lista, agrega, edita y borra productos, y guarda sus fotos.
// Todo se guarda en Netlify Blobs. Las acciones de escritura exigen la contraseña
// que se define en la variable de entorno ADMIN_PASSWORD.
import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const CATEGORIAS = ['parejas', 'caballero', 'llaveros', 'collares'];
const MAX_PRODUCTOS = 150;
const MAX_FOTOS = 4;
const MAX_BYTES_FOTO = 1_500_000;

const catalogo = () => getStore({ name: 'catalogo', consistency: 'strong' });
const fotos = () => getStore({ name: 'fotos', consistency: 'strong' });

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
const textoLargo = (valor, max) => String(valor ?? '').replace(/\r/g, '').trim().slice(0, max);

async function leerLista() {
  return (await catalogo().get('lista', { type: 'json' })) || [];
}
async function guardarLista(lista) {
  await catalogo().setJSON('lista', lista);
}

// ---- Ajustes: productos ocultos/agotados, precios de los fijos y tasa del día ----
const AJUSTES_BASE = { ocultos: [], agotados: [], precios: {}, tasaModo: 'auto', tasaManual: null, tasaManualFecha: null };
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

async function borrarFotos(urls) {
  for (const u of urls) {
    const k = claveDeUrl(u);
    if (k && /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(k)) await fotos().delete(k);
  }
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

  const subidas = await subirFotos(nuevas);
  const quitadas = existentes.filter((u) => !mantener.includes(u));
  return {
    producto: {
      id: previo ? previo.id : `n${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
      nombre,
      desc: textoLargo(cuerpo.desc, 400),
      precio: texto(cuerpo.precio, 20),
      cat,
      imgs: [...mantener, ...subidas],
      creado: previo ? previo.creado : Date.now(),
    },
    quitadas,
  };
}

export default async (req) => {
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

    if (ruta === '/api/productos' && metodo === 'POST') {
      const lista = await leerLista();
      if (lista.length >= MAX_PRODUCTOS) return fallo('Llegaste al máximo de productos.');
      const { producto } = await armarProducto(await req.json(), null);
      lista.unshift(producto);
      await guardarLista(lista);
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
        const aj = await leerAjustes();
        if (aj.agotados.includes(borrado.id) || aj.precios[borrado.id]) {
          aj.agotados = aj.agotados.filter((x) => x !== borrado.id);
          delete aj.precios[borrado.id];
          await catalogo().setJSON('ajustes', aj);
        }
        return json({ ok: true });
      }

      const { producto, quitadas } = await armarProducto(await req.json(), lista[i]);
      lista[i] = producto;
      await guardarLista(lista);
      await borrarFotos(quitadas);
      return json(producto);
    }

    return fallo('Ruta no encontrada.', 404);
  } catch (e) {
    const esDeUsuario = /^(Falta|Elige|Agrega|Máximo|Una de las fotos)/.test(e.message);
    if (!esDeUsuario) console.error(e);
    return fallo(esDeUsuario ? e.message : 'Ocurrió un error en el servidor. Intenta de nuevo.', esDeUsuario ? 400 : 500);
  }
};

export const config = {
  path: ['/api/productos', '/api/productos/*', '/api/img/*', '/api/login', '/api/ajustes', '/api/tasa'],
};
