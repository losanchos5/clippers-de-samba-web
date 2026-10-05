// Cliente de la API pública del widget de NBN23 (Swish), la misma que usa la web de
// L'Alqueria del Basket para mostrar calendario y clasificación de la Liga Senior.
// Lo usan el Worker (/api/calendario) y scripts/calendario.mjs (JSON de respaldo).
// Sin dependencias: solo fetch e Intl, sirve en Workers y en Node 18+.

export const API = 'https://api.swish.nbn23.com';
// Clave pública del widget, visible en la propia web de la liga (swish_widget_app.init).
export const API_KEY_PUBLICA = 'b76058c6-d42e-4672-b229-286d909e0444';

export const TEMPORADA = '26/27';
export const COMPETICION = 'Liga Quirónsalud Alqueria Masculina 26/27';

// Grupos de la temporada 26/27. Para otra temporada: node scripts/calendario.mjs --descubrir
export const GRUPOS = {
  A: { id: '6ab154cfd73638d9954bcd68', division: 'Tercera División' },
  B: { id: '6ab154cfd73638d9954bcd6a', division: 'Quinta División' },
};

const CLUB = /CLIPPERS DE SAMBA/i;
const TIEMPO_MAX_MS = 8000;
const JUGADO = new Set(['CLOSED', 'FINISHED']);

export async function pedir(ruta, apiKey = API_KEY_PUBLICA) {
  const res = await fetch(`${API}/${ruta}`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(TIEMPO_MAX_MS),
  });
  if (!res.ok) throw new Error(`Swish ${res.status} en ${ruta}`);
  return res.json();
}

// «CLIPPERS DE SAMBA `A´» → «CLIPPERS DE SAMBA A»
export function limpiarNombre(nombre) {
  return String(nombre ?? '').replace(/[`´]/g, '').replace(/\s+/g, ' ').trim();
}

// Las fotos de los equipos vienen de cdn.leverade.com; se sirven a través de
// /api/logo/<id> para no hacer peticiones a terceros desde el navegador.
export function logoLocal(url) {
  const m = /cdn\.leverade\.com\/thumbnails\/([A-Za-z0-9_-]+)\.\d+x\d+\.(jpg|jpeg|png)$/.exec(url ?? '');
  return m ? `/api/logo/${m[1]}.${m[2]}` : null;
}

// Fecha UTC → fecha y hora de Madrid. Las jornadas sin programar llegan como 1970-01-01.
export function horaMadrid(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return { inicio: null, fecha: null, hora: null };
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { inicio: d.toISOString(), fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

function numeroJornada(nombre, indice) {
  const m = /(\d+)/.exec(nombre ?? '');
  return m ? Number(m[1]) : indice + 1;
}

export function normalizarEquipo(calendario, clasificacion, grupo) {
  const yo = clasificacion.find((t) => CLUB.test(t.name));
  if (!yo) throw new Error('No aparece Clippers de Samba en la clasificación del grupo');

  const partidos = [];
  calendario.rounds.forEach((ronda, indice) => {
    for (const m of ronda.matches) {
      const local = m.homeTeam?.id === yo.teamId;
      if (!local && m.awayTeam?.id !== yo.teamId) continue;
      const rival = local ? m.awayTeam : m.homeTeam;
      const totales = Object.fromEntries((m.score?.totals ?? []).map((t) => [t.teamId, t.total]));
      const jugado = JUGADO.has(m.status) && totales[yo.teamId] != null && totales[rival.id] != null;
      partidos.push({
        id: m.id,
        jornada: numeroJornada(ronda.name, indice),
        ...horaMadrid(m.date),
        rival: limpiarNombre(rival.name),
        rivalLogo: logoLocal(rival.logo),
        local,
        estado: m.status,
        resultado: jugado ? { clippers: totales[yo.teamId], rival: totales[rival.id] } : null,
      });
    }
  });
  partidos.sort((a, b) => a.jornada - b.jornada);

  return {
    equipo: {
      nombre: limpiarNombre(yo.name),
      division: grupo.division,
      posicion: yo.position,
      total: clasificacion.length,
      stats: estadisticas(yo.stats),
      partidos,
    },
    clasificacion: clasificacion
      .map((t) => ({
        pos: t.position,
        equipo: limpiarNombre(t.name),
        logo: logoLocal(t.logo),
        ...estadisticas(t.stats),
        clippers: t.teamId === yo.teamId,
      }))
      .sort((a, b) => a.pos - b.pos),
  };
}

function estadisticas(s = {}) {
  const pj = s.playedMatches ?? 0;
  const conMedias = typeof s.pointsPerGame === 'number' && typeof s.opponentsPointsPerGame === 'number';
  return {
    pj,
    pg: s.wonMatches ?? 0,
    pp: s.lostMatches ?? 0,
    ppp: redondear(s.pointsPerGame),
    pcpp: redondear(s.opponentsPointsPerGame),
    // Diferencia total de puntos, con las medias sin redondear
    dif: conMedias ? Math.round((s.pointsPerGame - s.opponentsPointsPerGame) * pj) : null,
  };
}

function redondear(n) {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : null;
}

export async function obtenerCalendario(apiKey = API_KEY_PUBLICA) {
  const salida = {
    temporada: TEMPORADA,
    competicion: COMPETICION,
    actualizado: new Date().toISOString(),
    fuente: 'swish',
    equipos: {},
    clasificacion: {},
  };
  await Promise.all(Object.entries(GRUPOS).map(async ([clave, grupo]) => {
    const [calendario, clasificacion] = await Promise.all([
      pedir(`calendar?groupId=${grupo.id}`, apiKey),
      pedir(`standings?groupId=${grupo.id}`, apiKey),
    ]);
    const { equipo, clasificacion: tabla } = normalizarEquipo(calendario, clasificacion, grupo);
    salida.equipos[clave] = equipo;
    salida.clasificacion[clave] = tabla;
  }));
  return salida;
}

// Lista temporadas, competiciones y grupos para actualizar GRUPOS en una nueva temporada.
export async function descubrir(apiKey = API_KEY_PUBLICA) {
  const temporadas = await pedir('seasons', apiKey);
  const resultado = [];
  for (const t of temporadas.slice(-2)) {
    const competiciones = await pedir(`competitions?seasonId=${t._id ?? t.id}`, apiKey);
    for (const c of competiciones) {
      resultado.push({ temporada: t.name, competicion: c.name, grupos: (c.groups ?? []).map((g) => ({ id: g.id, nombre: g.name })) });
    }
  }
  return resultado;
}
