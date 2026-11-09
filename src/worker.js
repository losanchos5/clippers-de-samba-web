// Worker de Cloudflare: sirve la web estática (binding ASSETS) y las rutas de API.
//   /api/calendario  → calendario, resultados y clasificación de A y B (caché 10 min)
//   /api/liga        → todos los partidos de Tercera y Quinta por jornada (caché 10 min)
//   /api/logo/<id>   → escudos de los rivales desde cdn.leverade.com (caché 7 días)
//   /api/partido/<id> → marcador, cuartos y estadística de un partido de Clippers
//                       (caché 60 s si se está jugando, 1 día si ha terminado, 10 min si no)
//
// Dos niveles de caché: memoria del isolate (funciona también en *.workers.dev, donde la
// Cache API no guarda nada) y Cache API del edge (con dominio propio).
import { obtenerPartido, obtenerTodo } from './swish.js';

const DOMINIO = 'clippersdesamba.com';
const CACHE_CALENDARIO_S = 600;
const CACHE_LOGO_S = 604800;
const CACHE_LOGO_FALLO_S = 3600;
const LOGO = /^\/api\/logo\/([A-Za-z0-9_-]{6,40})\.(jpg|jpeg|png)$/;
const TIPOS_IMAGEN = /^image\/(jpeg|png|webp)$/;
const MEDIA = /^\/assets\/(video|audio)\/[\w-]+\.(mp4|mp3)$/;
const PARTIDO = /^\/api\/partido\/([a-f0-9]{24})$/;
const CACHE_PARTIDO_S = { enJuego: 60, cerrado: 86400, otro: 600 };

let ligaEnMemoria = null; // { calendario, liga, hasta } (cuerpos JSON ya serializados)
const logosEnMemoria = new Map(); // id → { cuerpo, tipo, hasta } | { fallo: true, hasta }
const MAX_LOGOS_EN_MEMORIA = 300;
const partidosEnMemoria = new Map(); // id → { cuerpo, segundos, hasta }
const MAX_PARTIDOS_EN_MEMORIA = 100;

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
    const partido = PARTIDO.exec(url.pathname);
    if (partido) return datosPartido(request, env, ctx, partido[1]);
    if (url.pathname.startsWith('/api/')) return json({ error: 'No encontrado' }, 404);
    if (MEDIA.test(url.pathname) && request.headers.has('Range')) return conRango(request, env);
    return env.ASSETS.fetch(request);
  },
};

// Lee la liga una vez cada 10 min para /api/calendario, /api/liga y la validación de /api/partido.
// Las peticiones simultáneas comparten la misma lectura en curso.
let ligaEnCurso = null;
function cargarLiga(env) {
  ligaEnCurso ??= obtenerTodo(env.SWISH_API_KEY || undefined)
    .then(({ calendario, liga }) => {
      const ids = new Set(Object.values(calendario.equipos).flatMap((e) => e.partidos.map((p) => p.id)));
      ligaEnMemoria = { calendario: JSON.stringify(calendario), liga: JSON.stringify(liga), ids, hasta: Date.now() + CACHE_CALENDARIO_S * 1000 };
      return ligaEnMemoria;
    })
    .finally(() => { ligaEnCurso = null; });
  return ligaEnCurso;
}

async function datosLiga(request, env, ctx, parte) {
  if (ligaEnMemoria && ligaEnMemoria.hasta > Date.now()) return respuestaJSON(ligaEnMemoria[parte]);

  const cache = caches.default;
  const clave = new Request(new URL(`/api/${parte}`, request.url).toString());
  const enCache = await cache.match(clave);
  if (enCache) return enCache;

  try {
    const respuesta = respuestaJSON((await cargarLiga(env))[parte]);
    ctx.waitUntil(cache.put(clave, respuesta.clone()));
    return respuesta;
  } catch (error) {
    console.error(parte, error);
    // Mejor datos de hace un rato que nada; si no hay, el front usa /datos/*.json
    if (ligaEnMemoria) return respuestaJSON(ligaEnMemoria[parte], 60);
    return json({ error: 'No se pudo leer la liga' }, 502, { 'Cache-Control': 'no-store' });
  }
}

// Ids de partidos de Clippers. Solo se sirven esos: así el Worker no hace de proxy de ids al azar.
// Si la liga no se puede leer, vale la lista caducada: los ids de la temporada no cambian.
async function idsClippers(env) {
  if (ligaEnMemoria && ligaEnMemoria.hasta > Date.now()) return ligaEnMemoria.ids;
  try {
    return (await cargarLiga(env)).ids;
  } catch (error) {
    if (ligaEnMemoria) return ligaEnMemoria.ids;
    throw error;
  }
}

function segundosDeCache(partido) {
  if (partido.enJuego) return CACHE_PARTIDO_S.enJuego;
  // Cerrado pero sin estadística o sin acta: la mesa aún puede publicarlas, no se guarda un día.
  const completo = partido.local.jugadores.length && partido.visitante.jugadores.length && partido.acta;
  return partido.cerrado && completo ? CACHE_PARTIDO_S.cerrado : CACHE_PARTIDO_S.otro;
}

const partidosEnCurso = new Map(); // id → Promise<{ cuerpo, segundos }>

async function datosPartido(request, env, ctx, id) {
  const ahora = Date.now();
  const enMemoria = partidosEnMemoria.get(id);
  if (enMemoria && enMemoria.hasta > ahora) {
    return enMemoria.cuerpo ? respuestaPartido(enMemoria.cuerpo, enMemoria.segundos) : errorPartido();
  }

  const cache = caches.default;
  const clave = new Request(new URL(`/api/partido/${id}`, request.url).toString());
  const enCache = await cache.match(clave);
  if (enCache) return enCache;

  if (!(await idsClippers(env).catch(() => null))?.has(id)) {
    return ligaEnMemoria ? json({ error: 'No encontrado' }, 404) : errorPartido();
  }

  // Una sola tanda a Swish por partido aunque lleguen muchas visitas a la vez.
  let tarea = partidosEnCurso.get(id);
  if (!tarea) {
    tarea = obtenerPartido(id, env.SWISH_API_KEY || undefined)
      .then((partido) => ({ cuerpo: JSON.stringify(partido), segundos: segundosDeCache(partido) }))
      .finally(() => partidosEnCurso.delete(id));
    partidosEnCurso.set(id, tarea);
  }

  try {
    const { cuerpo, segundos } = await tarea;
    guardarPartido(id, cuerpo, segundos);
    const respuesta = respuestaPartido(cuerpo, segundos);
    ctx.waitUntil(cache.put(clave, respuesta.clone()));
    return respuesta;
  } catch (error) {
    console.error('partido', id, error);
    // El fallo también se recuerda 30 s: con Swish caído, las visitas no lo martillean.
    guardarPartido(id, enMemoria?.cuerpo ?? null, 30);
    return enMemoria?.cuerpo ? respuestaPartido(enMemoria.cuerpo, 30) : errorPartido();
  }
}

function guardarPartido(id, cuerpo, segundos) {
  if (partidosEnMemoria.size > MAX_PARTIDOS_EN_MEMORIA) partidosEnMemoria.clear();
  partidosEnMemoria.set(id, { cuerpo, segundos, hasta: Date.now() + segundos * 1000 });
}

function errorPartido() {
  return json({ error: 'No se pudo leer el partido' }, 502, { 'Cache-Control': 'no-store' });
}

function respuestaPartido(cuerpo, segundos) {
  return new Response(cuerpo, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // El navegador refresca cada 60 s; el edge comparte la respuesta entre todos los visitantes.
      'Cache-Control': `public, max-age=${Math.min(segundos, 30)}, s-maxage=${segundos}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// Safari (iPhone) solo reproduce vídeo y audio si el servidor responde a peticiones Range
// con 206, y los assets estáticos del Worker no lo hacen: se recorta aquí.
async function conRango(request, env) {
  const original = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));
  if (!original.ok) return original;
  const datos = await original.arrayBuffer();
  const total = datos.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  let inicio = m?.[1] ? Number(m[1]) : null;
  let fin = m?.[2] ? Number(m[2]) : null;
  if (inicio === null && fin !== null) { inicio = Math.max(0, total - fin); fin = total - 1; } // «bytes=-500»: los últimos
  inicio ??= 0;
  fin = Math.min(fin ?? total - 1, total - 1);
  const cabeceras = new Headers(original.headers);
  cabeceras.set('Accept-Ranges', 'bytes');
  if (!m || inicio > fin) {
    cabeceras.set('Content-Range', `bytes */${total}`);
    return new Response(null, { status: 416, headers: cabeceras });
  }
  cabeceras.set('Content-Range', `bytes ${inicio}-${fin}/${total}`);
  cabeceras.set('Content-Length', String(fin - inicio + 1));
  return new Response(request.method === 'HEAD' ? null : datos.slice(inicio, fin + 1), { status: 206, headers: cabeceras });
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
