// Sección «Estadísticas»: todo lo que sale de las actas oficiales de la liga
// (scripts/estadisticas.py → /datos/estadisticas.json). Las actas no registran
// minutos, rebotes, asistencias ni +/-, así que no se muestran.
import { h, svg } from './dom.js';

const fmtFecha = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const NOMBRE_PERIODO = ['1º', '2º', '3º', '4º'];

let orden = { columna: 'puntos', dir: 'desc' };
let abiertos = new Set(); // dorsales con la ficha desplegada

const uno = (n) => (Number.isFinite(n) ? n.toFixed(1).replace('.', ',') : '—');
const entero = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
const periodo = (i) => NOMBRE_PERIODO[i] ?? `Pr${i - 3}`;
const fecha = (iso) => (iso ? fmtFecha.format(new Date(`${iso}T12:00:00Z`)).replace('.', '') : '');

// «GILABERT PEREA, X» → «X. Gilabert Perea» (si el jugador no está en equipos.json)
function nombreDesdeActa(nombre = '') {
  const menores = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
  const titulo = (t) => t.toLowerCase().split(/\s+/).map((w) => (menores.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  const [apellidos, inicial] = nombre.split(',').map((x) => x.trim());
  return inicial ? `${inicial.replace(/\.$/, '').toUpperCase()}. ${titulo(apellidos)}` : titulo(apellidos);
}

function columnas(totalEquipo, periodos) {
  const base = [
    { id: 'dorsal', titulo: '#', largo: 'Dorsal', valor: (j) => j.dorsal },
    { id: 'nombre', titulo: 'Jugador', largo: 'Jugador', valor: (j) => j.nombre, texto: true },
    { id: 'pj', titulo: 'PJ', largo: 'Partidos jugados', valor: (j) => j.pj },
    { id: 'titular', titulo: 'TIT', largo: 'Partidos como titular', valor: (j) => j.titular },
    { id: 'puntos', titulo: 'PTS', largo: 'Puntos', valor: (j) => j.puntos, destacada: true },
    { id: 'ppp', titulo: 'PPP', largo: 'Puntos por partido', valor: (j) => j.puntos / j.pj, formato: uno },
    { id: 'max', titulo: 'MÁX', largo: 'Máximo de puntos en un partido', valor: (j) => j.maxPuntos },
    { id: 'eq', titulo: '%EQ', largo: 'Porcentaje de los puntos del equipo', valor: (j) => (totalEquipo ? (j.puntos * 100) / totalEquipo : NaN), formato: (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '—') },
    { id: 't3', titulo: 'T3', largo: 'Triples anotados', valor: (j) => j.t3 },
    { id: 't2', titulo: 'T2', largo: 'Canastas de 2 anotadas', valor: (j) => j.t2 },
    { id: 't1', titulo: 'TL', largo: 'Tiros libres anotados', valor: (j) => j.t1 },
    { id: 'faltas', titulo: 'FAL', largo: 'Faltas personales', valor: (j) => j.faltas },
    { id: 'fpp', titulo: 'FPP', largo: 'Faltas por partido', valor: (j) => j.faltas / j.pj, formato: uno },
  ];
  const cuartos = Array.from({ length: periodos }, (_, i) => ({
    id: `c${i}`, titulo: periodo(i), largo: `Puntos en el ${periodo(i)} cuarto`, valor: (j) => j.porCuarto?.[i] ?? NaN, cuarto: true,
  }));
  return [...base, ...cuartos];
}

function jugadoresConNombre(equipo, plantilla) {
  const nombres = new Map((plantilla?.jugadores ?? []).map((j) => [j.dorsal, j.nombre]));
  return (equipo.jugadores ?? [])
    .filter((j) => j.pj > 0)
    .map((j) => ({ ...j, nombre: nombres.get(j.dorsal) ?? nombreDesdeActa(j.nombreActa) }));
}

// Si el JSON es de la versión anterior (sin «resumen»), se calcula lo básico.
function resumenDe(equipo) {
  if (equipo.resumen) return equipo.resumen;
  const jugados = (equipo.partidos ?? []).filter((p) => p.cuadra);
  const suma = (f) => (equipo.jugadores ?? []).reduce((t, j) => t + (j[f] ?? 0), 0);
  return {
    pj: jugados.length,
    puntos: jugados.reduce((t, p) => t + (p.puntos ?? 0), 0),
    puntosRival: jugados.reduce((t, p) => t + (p.puntosRival ?? 0), 0),
    t3: suma('t3'), t2: suma('t2'), t1: suma('t1'), faltas: suma('faltas'),
  };
}

// ---------- Resumen del equipo ----------

function pintarResumen(r) {
  const pj = r.pj || 0;
  const pct = r.tl?.intentos ? Math.round((r.tl.anotados * 100) / r.tl.intentos) : null;
  const fichas = [
    ['Partidos', entero(pj), 'con acta'],
    ['Puntos', uno(r.puntos / pj), 'por partido'],
    ['Recibidos', uno(r.puntosRival / pj), 'por partido'],
    ['Triples', uno(r.t3 / pj), 'por partido'],
    r.tl ? ['Tiros libres', `${r.tl.anotados}/${r.tl.intentos}`, pct != null ? `${pct}% de acierto` : ''] : null,
    ['Faltas', uno(r.faltas / pj), 'por partido'],
  ].filter(Boolean);
  return h('ul', { class: 'est-fichas' }, fichas.map(([titulo, valor, nota]) => h('li', { class: 'est-ficha' },
    h('span', { class: 'est-ficha__titulo' }, titulo),
    h('b', { class: 'est-ficha__valor' }, valor),
    h('span', { class: 'est-ficha__nota' }, nota),
  )));
}

// ---------- Puntos por cuarto (columnas agrupadas + tabla) ----------

function pintarCuartos(r) {
  if (!r.porCuarto?.length || !r.pj) return null;
  const n = Math.max(r.porCuarto.length, r.porCuartoRival?.length ?? 0);
  const media = (arr, i) => (arr?.[i] ?? 0) / r.pj;
  const datos = Array.from({ length: n }, (_, i) => ({ nombre: periodo(i), nosotros: media(r.porCuarto, i), ellos: media(r.porCuartoRival, i) }));
  const max = Math.max(4, ...datos.flatMap((d) => [d.nosotros, d.ellos]));
  const tope = Math.ceil(max / 5) * 5;

  const W = 320; const H = 170; const base = 140; const arriba = 16; const izq = 26;
  const ancho = (W - izq) / n; const barra = Math.min(22, ancho / 3.2);
  const y = (v) => base - ((base - arriba) * v) / tope;
  const columna = (x, v, clase) => {
    const alto = Math.max(0, base - y(v));
    const r4 = Math.min(4, alto);
    // extremo de datos redondeado, base recta
    const d = `M${x},${base}V${base - alto + r4}Q${x},${base - alto} ${x + r4},${base - alto}H${x + barra - r4}Q${x + barra},${base - alto} ${x + barra},${base - alto + r4}V${base}Z`;
    return svg('path', { class: clase, d });
  };

  const rejilla = [0, tope / 2, tope].map((v) => svg('g', { class: 'est-graf__eje' },
    svg('line', { x1: izq, x2: W, y1: y(v), y2: y(v) }),
    Object.assign(svg('text', { x: izq - 6, y: y(v) + 4, 'text-anchor': 'end' }), { textContent: String(v) }),
  ));
  const grupos = datos.map((d, i) => {
    const x0 = izq + i * ancho + (ancho - barra * 2 - 2) / 2;
    const g = svg('g', { class: 'est-graf__grupo', 'data-i': String(i) },
      svg('rect', { class: 'est-graf__zona', x: izq + i * ancho, y: arriba - 8, width: ancho, height: base - arriba + 30 }),
      columna(x0, d.nosotros, 'est-graf__nosotros'),
      columna(x0 + barra + 2, d.ellos, 'est-graf__ellos'),
      Object.assign(svg('text', { class: 'est-graf__x', x: izq + i * ancho + ancho / 2, y: base + 18, 'text-anchor': 'middle' }), { textContent: d.nombre }),
    );
    return g;
  });

  const etiqueta = datos.map((d) => `${d.nombre} cuarto: Clippers ${uno(d.nosotros)}, rival ${uno(d.ellos)}`).join('; ');
  const grafico = svg('svg', { class: 'est-graf__svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Puntos por cuarto de media. ${etiqueta}` },
    ...rejilla, ...grupos,
    svg('line', { class: 'est-graf__base', x1: izq, x2: W, y1: base, y2: base }));
  const aviso = h('div', { class: 'est-graf__aviso', role: 'status', hidden: true });
  const caja = h('div', { class: 'est-graf__caja' }, grafico, aviso);

  // Aviso al pasar por encima de cada cuarto
  grafico.addEventListener('pointermove', (e) => {
    const g = e.target.closest?.('.est-graf__grupo');
    if (!g) { aviso.hidden = true; return; }
    const d = datos[Number(g.dataset.i)];
    aviso.replaceChildren(
      h('strong', {}, `${d.nombre} cuarto`),
      h('span', {}, h('i', { class: 'muestra muestra--nosotros' }), `Clippers ${uno(d.nosotros)}`),
      h('span', {}, h('i', { class: 'muestra muestra--ellos' }), `Rival ${uno(d.ellos)}`),
    );
    const caj = caja.getBoundingClientRect();
    const zona = g.getBoundingClientRect();
    aviso.hidden = false;
    aviso.style.left = `${Math.min(caj.width - 150, Math.max(0, zona.left - caj.left + zona.width / 2 - 75))}px`;
  });
  grafico.addEventListener('pointerleave', () => { aviso.hidden = true; });

  const tabla = h('table', { class: 'est-mini' },
    h('caption', { class: 'sr-only' }, 'Puntos por cuarto, media por partido'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, ''), datos.map((d) => h('th', { scope: 'col' }, d.nombre)))),
    h('tbody', {},
      h('tr', {}, h('th', { scope: 'row' }, h('i', { class: 'muestra muestra--nosotros' }), 'Clippers'), datos.map((d) => h('td', {}, uno(d.nosotros)))),
      h('tr', {}, h('th', { scope: 'row' }, h('i', { class: 'muestra muestra--ellos' }), 'Rival'), datos.map((d) => h('td', {}, uno(d.ellos)))),
    ),
  );

  return h('div', { class: 'est-bloque est-cuartos' },
    h('h3', { class: 'subtitulo' }, 'Puntos por cuarto'),
    h('p', { class: 'est-nota' }, r.pj > 1 ? `Media por partido (${r.pj} partidos).` : 'Del único partido con acta.'),
    h('ul', { class: 'leyenda' },
      h('li', {}, h('i', { class: 'muestra muestra--nosotros' }), 'Clippers'),
      h('li', {}, h('i', { class: 'muestra muestra--ellos' }), 'Rival')),
    caja,
    tabla,
  );
}

// ---------- Tabla de jugadores (ordenable, con ficha desplegable) ----------

function fichaJugador(dorsal, partidos) {
  const lineas = partidos
    .filter((p) => p.cuadra)
    .map((p) => ({ p, j: (p.jugadores ?? []).find((x) => x.dorsal === dorsal) }))
    .filter(({ j }) => j?.jugo !== false && j);
  if (!lineas.length) return h('p', { class: 'est-nota' }, 'Sin partidos con acta.');
  return h('ol', { class: 'est-ficha-partidos' }, lineas.map(({ p, j }) => h('li', {},
    h('span', { class: 'est-ficha-partidos__cuando' }, `${fecha(p.fecha)} · ${p.local === false ? '@' : 'vs'} ${p.rival ?? 'rival'}`),
    h('span', { class: 'est-ficha-partidos__datos' },
      h('b', {}, `${j.puntos} pts`),
      ` · T3 ${j.t3} · T2 ${j.t2} · TL ${j.t1} · ${j.faltas} ${j.faltas === 1 ? 'falta' : 'faltas'}`,
      j.titular ? ' · titular' : '',
      j.porCuarto?.length ? ` · por cuartos ${j.porCuarto.join('/')}` : ''),
  )));
}

function pintarTabla(equipo, plantilla, totalEquipo) {
  const jugadores = jugadoresConNombre(equipo, plantilla);
  if (!jugadores.length) return null;
  const periodos = Math.max(0, ...jugadores.map((j) => j.porCuarto?.length ?? 0));
  const cols = columnas(totalEquipo, periodos)
    .filter((c) => c.id !== 'titular' || jugadores.some((j) => j.titular != null))
    .filter((c) => c.id !== 'max' || jugadores.some((j) => j.maxPuntos != null));
  const col = cols.find((c) => c.id === orden.columna) ?? cols.find((c) => c.id === 'puntos');

  const comparar = (a, b) => {
    const va = col.valor(a); const vb = col.valor(b);
    const r = col.texto ? String(va).localeCompare(String(vb), 'es') : (Number.isFinite(va) ? va : -1) - (Number.isFinite(vb) ? vb : -1);
    return (orden.dir === 'asc' ? r : -r) || a.dorsal - b.dorsal;
  };
  const filas = [...jugadores].sort(comparar);
  const maxPuntos = Math.max(1, ...jugadores.map((j) => j.puntos));

  const thead = h('thead', {}, h('tr', {}, cols.map((c) => {
    const activa = c.id === col.id;
    return h('th', { scope: 'col', class: c.cuarto ? 'col-cuarto' : null, 'aria-sort': activa ? (orden.dir === 'asc' ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', class: 'est-orden', 'data-col': c.id, title: c.largo }, c.titulo, activa ? h('span', { 'aria-hidden': 'true' }, orden.dir === 'asc' ? ' ▲' : ' ▼') : null));
  })));

  const tbody = h('tbody', {});
  filas.forEach((j) => {
    const abierto = abiertos.has(j.dorsal);
    tbody.append(h('tr', { class: abierto ? 'abierto' : null }, cols.map((c) => {
      if (c.id === 'nombre') {
        return h('th', { scope: 'row', class: 'est-jugador' },
          h('button', { type: 'button', class: 'est-desplegar', 'data-dorsal': String(j.dorsal), 'aria-expanded': String(abierto) }, j.nombre));
      }
      const v = c.valor(j);
      const texto = (c.formato ?? entero)(v);
      if (c.id === 'puntos') {
        return h('td', { class: 'est-pts' }, h('span', { class: 'est-barra', style: { '--p': String(j.puntos / maxPuntos) }, 'aria-hidden': 'true' }), h('b', {}, texto));
      }
      return h('td', { class: c.cuarto ? 'col-cuarto' : null }, texto);
    })));
    if (abierto) {
      tbody.append(h('tr', { class: 'est-detalle' }, h('td', { colspan: String(cols.length) }, fichaJugador(j.dorsal, equipo.partidos ?? []))));
    }
  });

  const tabla = h('table', { class: 'est-tabla' },
    h('caption', { class: 'sr-only' }, 'Estadísticas por jugador. Las cabeceras ordenan la tabla.'),
    thead, tbody);

  return h('div', { class: 'est-bloque' },
    h('h3', { class: 'subtitulo' }, 'Jugadores'),
    h('p', { class: 'est-nota' }, 'Toca una cabecera para ordenar y un nombre para ver sus partidos.'),
    h('div', { class: 'tabla-envoltura est-envoltura', tabindex: '0', role: 'region', 'aria-label': 'Tabla de estadísticas por jugador' }, tabla),
    h('p', { class: 'est-leyenda' },
      'PJ partidos · TIT titular · PTS puntos · PPP puntos por partido · MÁX máximo en un partido · %EQ parte de los puntos del equipo · T3/T2/TL canastas de 3, de 2 y tiros libres anotados · FAL faltas · FPP faltas por partido',
      periodos ? ' · 1º–4º puntos en cada cuarto' : ''),
  );
}

// ---------- Partido a partido ----------

function pintarPartidos(equipo, plantilla) {
  const partidos = [...(equipo.partidos ?? [])].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  if (!partidos.length) return null;
  const nombres = new Map((plantilla?.jugadores ?? []).map((j) => [j.dorsal, j.nombre]));

  return h('div', { class: 'est-bloque' },
    h('h3', { class: 'subtitulo' }, 'Partido a partido'),
    h('div', { class: 'est-partidos' }, partidos.map((p) => {
      const gana = p.puntos > p.puntosRival;
      const jugadores = (p.jugadores ?? []).filter((j) => j.jugo !== false).sort((a, b) => b.puntos - a.puntos || a.dorsal - b.dorsal);
      const nCuartos = Math.max(p.cuartos?.length ?? 0, ...jugadores.map((j) => j.porCuarto?.length ?? 0));
      return h('details', { class: 'est-partido' },
        h('summary', {},
          h('span', { class: 'est-partido__fecha' }, fecha(p.fecha)),
          h('span', { class: 'est-partido__rival' }, `${p.local === false ? '@' : 'vs'} ${p.rival ?? 'Rival'}`),
          p.puntos != null ? h('span', { class: 'est-partido__marcador' }, `${p.puntos}–${p.puntosRival}`) : null,
          p.puntos != null ? h('span', { class: `chapa ${gana ? 'chapa--v' : 'chapa--d'}` }, gana ? 'V' : 'D') : null),
        h('div', { class: 'est-partido__cuerpo' },
          p.cuartos?.length ? h('p', { class: 'est-partido__cuartos' }, 'Por cuartos: ',
            p.cuartos.map((c, i) => h('span', {}, h('small', {}, periodo(i)), ` ${c.clippers}–${c.rival}`))) : null,
          !p.cuadra ? h('p', { class: 'est-nota' }, 'El acta de este partido no se ha podido leer bien; no cuenta en las estadísticas.') : null,
          p.cuadra && jugadores.length ? h('div', { class: 'tabla-envoltura est-envoltura', tabindex: '0', role: 'region', 'aria-label': `Estadísticas del partido contra ${p.rival ?? 'el rival'}` },
            h('table', { class: 'est-tabla est-tabla--partido' },
              h('thead', {}, h('tr', {},
                h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Jugador'), h('th', { scope: 'col' }, 'PTS'),
                h('th', { scope: 'col' }, 'T3'), h('th', { scope: 'col' }, 'T2'), h('th', { scope: 'col' }, 'TL'), h('th', { scope: 'col' }, 'FAL'),
                Array.from({ length: nCuartos }, (_, i) => h('th', { scope: 'col', class: 'col-cuarto' }, periodo(i))))),
              h('tbody', {}, jugadores.map((j) => h('tr', {},
                h('td', {}, j.dorsal),
                h('th', { scope: 'row', class: 'est-jugador' }, nombres.get(j.dorsal) ?? nombreDesdeActa(j.nombreActa), j.titular ? h('span', { class: 'est-titular', title: 'Titular' }, ' ★') : null),
                h('td', {}, h('b', {}, j.puntos)), h('td', {}, j.t3), h('td', {}, j.t2), h('td', {}, j.t1), h('td', {}, j.faltas),
                Array.from({ length: nCuartos }, (_, i) => h('td', { class: 'col-cuarto' }, j.porCuarto?.[i] ?? '—')))))),
          ) : null,
          h('p', { class: 'est-partido__extra' },
            jugadores.some((j) => j.titular) ? '★ titular' : null,
            p.tl ? ` · Tiros libres: ${p.tl.anotados}/${p.tl.intentos}` : null,
            p.tiemposMuertos ? ` · Tiempos muertos pedidos: ${p.tiemposMuertos.length}` : null),
        ),
      );
    })),
  );
}

// ---------- Entrada ----------

export function pintarEstadisticas({ clave, estadisticas, plantillas }) {
  const panel = document.getElementById('panel-estadisticas');
  if (!panel || estadisticas === undefined) return;
  const equipo = estadisticas?.equipos?.[clave];
  const plantilla = plantillas?.[clave];
  const r = equipo ? resumenDe(equipo) : null;

  if (!equipo || !r?.pj) {
    panel.replaceChildren(h('p', { class: 'partidos__vacio' }, 'Todavía no hay actas de esta temporada para este equipo.'));
    return;
  }

  panel.replaceChildren(
    pintarResumen(r),
    pintarTabla(equipo, plantilla, r.puntos),
    h('div', { class: 'est-rejilla' }, pintarCuartos(r), pintarPartidos(equipo, plantilla)),
  );

  panel.querySelectorAll('.est-orden').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.col;
    orden = orden.columna === id ? { columna: id, dir: orden.dir === 'desc' ? 'asc' : 'desc' } : { columna: id, dir: id === 'nombre' || id === 'dorsal' ? 'asc' : 'desc' };
    pintarEstadisticas({ clave, estadisticas, plantillas });
    panel.querySelector(`.est-orden[data-col="${id}"]`)?.focus();
  }));
  panel.querySelectorAll('.est-desplegar').forEach((b) => b.addEventListener('click', () => {
    const dorsal = Number(b.dataset.dorsal);
    if (abiertos.has(dorsal)) abiertos.delete(dorsal); else abiertos.add(dorsal);
    pintarEstadisticas({ clave, estadisticas, plantillas });
    panel.querySelector(`.est-desplegar[data-dorsal="${dorsal}"]`)?.focus();
  }));
}

export function reiniciarEstadisticas() {
  abiertos = new Set();
}
