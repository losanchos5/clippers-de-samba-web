// Worker de Cloudflare: sirve la web estática (binding ASSETS) y dos rutas de API.
//   /api/calendario  → calendario, resultados y clasificación de A y B (caché 10 min)
//   /api/liga        → todos los partidos de Tercera y Quinta por jornada (caché 10 min)
//   /api/logo/<id>   → escudos de los rivales desde cdn.leverade.com (caché 7 días)
//
// Dos niveles de caché: memoria del isolate (funciona también en *.workers.dev, donde la
// Cache API no guarda nada) y Cache API del edge (con dominio propio).
import { obtenerTodo } from './swish.js';

const DOMINIO = 'clippersdesamba.com';
const CACHE_CALENDARIO_S = 600;
const CACHE_LOGO_S = 604800;
const CACHE_LOGO_FALLO_S = 3600;
const LOGO = /^\/api\/logo\/([A-Za-z0-9_-]{6,40})\.(jpg|jpeg|png)$/;
const TIPOS_IMAGEN = /^image\/(jpeg|png|webp)$/;

let ligaEnMemoria = null; // { calendario, liga, hasta } (cuerpos JSON ya serializados)
const logosEnMemoria = new Map(); // id → { cuerpo, tipo, hasta } | { fallo: true, hasta }
const MAX_LOGOS_EN_MEMORIA = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Una sola dirección pública: www y *.workers.dev van al dominio principal.
    if (url.hostname === `www.${DOMINIO}` || url.hostname.endsWith('.workers.dev')) {
      return Response.redirect(`https://${DOMINIO}${url.pathname}${url.search}`, 301);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Método no permitido', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (url.pathname === '/api/calendario') return datosLiga(request, env, ctx, 'calendario');
    if (url.pathname === '/api/liga') return datosLiga(request, env, ctx, 'liga');
    const logo = LOGO.exec(url.pathname);
    if (logo) return escudo(request, ctx, logo[1], logo[2]);
    if (url.pathname.startsWith('/api/')) return json({ error: 'No encontrado' }, 404);
    return env.ASSETS.fetch(request);
  },
};

async function datosLiga(request, env, ctx, parte) {
  const ahora = Date.now();
  if (ligaEnMemoria && ligaEnMemoria.hasta > ahora) return respuestaJSON(ligaEnMemoria[parte]);

  const cache = caches.default;
  const clave = new Request(new URL(`/api/${parte}`, request.url).toString());
  const enCache = await cache.match(clave);
  if (enCache) return enCache;

  try {
    const { calendario, liga } = await obtenerTodo(env.SWISH_API_KEY || undefined);
    ligaEnMemoria = { calendario: JSON.stringify(calendario), liga: JSON.stringify(liga), hasta: ahora + CACHE_CALENDARIO_S * 1000 };
    const respuesta = respuestaJSON(ligaEnMemoria[parte]);
    ctx.waitUntil(cache.put(clave, respuesta.clone()));
    return respuesta;
  } catch (error) {
    console.error(parte, error);
    // Mejor datos de hace un rato que nada; si no hay, el front usa /datos/*.json
    if (ligaEnMemoria) return respuestaJSON(ligaEnMemoria[parte], 60);
    return json({ error: 'No se pudo leer la liga' }, 502, { 'Cache-Control': 'no-store' });
  }
}

function respuestaJSON(cuerpo, maxAge = 300) {
  return new Response(cuerpo, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${CACHE_CALENDARIO_S}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function escudo(request, ctx, id, ext) {
  const ahora = Date.now();
  const enMemoria = logosEnMemoria.get(id);
  if (enMemoria && enMemoria.hasta > ahora) {
    return enMemoria.fallo ? new Response(null, { status: 404 }) : respuestaLogo(enMemoria.cuerpo, enMemoria.tipo);
  }

  const cache = caches.default;
  const clave = new Request(new URL(`/api/logo/${id}.${ext}`, request.url).toString());
  const enCache = await cache.match(clave);
  if (enCache) return enCache;

  let origen;
  try {
    origen = await fetch(`https://cdn.leverade.com/thumbnails/${id}.200x200.${ext}`, { signal: AbortSignal.timeout(6000) });
  } catch {
    return new Response(null, { status: 502 });
  }
  const tipo = (origen.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!origen.ok || !TIPOS_IMAGEN.test(tipo)) {
    if (logosEnMemoria.size > MAX_LOGOS_EN_MEMORIA) logosEnMemoria.clear();
    logosEnMemoria.set(id, { fallo: true, hasta: ahora + CACHE_LOGO_FALLO_S * 1000 });
    return new Response(null, { status: 404 });
  }

  const cuerpo = await origen.arrayBuffer();
  if (logosEnMemoria.size > MAX_LOGOS_EN_MEMORIA) logosEnMemoria.clear();
  logosEnMemoria.set(id, { cuerpo, tipo, hasta: ahora + CACHE_LOGO_S * 1000 });
  const respuesta = respuestaLogo(cuerpo, tipo);
  ctx.waitUntil(cache.put(clave, respuesta.clone()));
  return respuesta;
}

function respuestaLogo(cuerpo, tipo) {
  return new Response(cuerpo, {
    headers: {
      'Content-Type': tipo,
      'Cache-Control': `public, max-age=${CACHE_LOGO_S}`,
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function json(datos, status = 200, cabeceras = {}) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...cabeceras,
    },
  });
}
