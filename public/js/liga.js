// Sección «La liga»: todos los partidos de Tercera y Quinta por jornada, con un
// selector de jornada, y la clasificación completa. Los datos (/api/liga) se piden
// solo cuando la sección se acerca a la pantalla.
import { h } from './dom.js';

const fmtDia = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });
const sinPunto = (t) => t.replace('.', '');

const jornadaElegida = {}; // clave de grupo → número de jornada

// Jornada por defecto: la última con algún partido terminado; si no hay, la primera.
function jornadaInicial(jornadas) {
  const jugadas = jornadas.filter((j) => j.partidos.some((p) => p.jugado));
  return (jugadas.at(-1) ?? jornadas[0])?.numero;
}

function escudo(equipo, tam = 36) {
  if (equipo.logo) return h('img', { class: 'liga-escudo', src: equipo.logo, alt: '', width: tam, height: tam, loading: 'lazy', decoding: 'async' });
  const iniciales = equipo.nombre.split(/\s+/).filter((w) => /^[A-ZÁÉÍÓÚÑ]/i.test(w)).slice(0, 2).map((w) => w[0]).join('');
  return h('span', { class: 'liga-escudo liga-escudo--vacio', 'aria-hidden': 'true' }, iniciales);
}

function filaPartido(p) {
  const gana = (a, b) => p.jugado && a.puntos > b.puntos;
  const centro = p.jugado
    ? h('span', { class: 'liga-partido__marcador', 'aria-label': `${p.local.puntos} a ${p.visitante.puntos}` },
      h('b', { class: gana(p.local, p.visitante) ? 'gana' : null }, p.local.puntos), '–',
      h('b', { class: gana(p.visitante, p.local) ? 'gana' : null }, p.visitante.puntos))
    : h('span', { class: 'liga-partido__hora' },
      p.estado === 'DEFERRED' ? 'Aplazado' : p.estado === 'LIVE' ? 'En juego' : p.inicio ? p.hora : 'Por fijar');

  return h('li', { class: `liga-partido${p.clippers ? ' liga-partido--clippers' : ''}` },
    h('span', { class: 'liga-partido__equipo liga-partido__equipo--local' },
      h('span', { class: `liga-partido__nombre${gana(p.local, p.visitante) ? ' gana' : ''}` }, p.local.nombre), escudo(p.local)),
    centro,
    h('span', { class: 'liga-partido__equipo' },
      escudo(p.visitante), h('span', { class: `liga-partido__nombre${gana(p.visitante, p.local) ? ' gana' : ''}` }, p.visitante.nombre)),
  );
}

// Los partidos de una jornada agrupados por día.
function pintarJornada(jornada) {
  const porDia = new Map();
  for (const p of jornada.partidos) {
    const dia = p.inicio ? sinPunto(fmtDia.format(new Date(p.inicio))) : 'Fecha por confirmar';
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(p);
  }
  return [...porDia].map(([dia, partidos]) => h('div', { class: 'liga-dia' },
    h('h4', { class: 'liga-dia__fecha' }, dia),
    h('ol', { class: 'liga-partidos' }, partidos.map(filaPartido))));
}

function pintarClasificacion(tabla) {
  if (!tabla?.length) return null;
  return h('div', { class: 'liga-bloque' },
    h('h3', { class: 'subtitulo' }, 'Clasificación'),
    h('div', { class: 'tabla-envoltura' },
      h('table', { class: 'clasificacion' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Equipo'),
          h('th', { scope: 'col' }, h('abbr', { title: 'Partidos jugados' }, 'PJ')),
          h('th', { scope: 'col' }, h('abbr', { title: 'Ganados' }, 'G')),
          h('th', { scope: 'col' }, h('abbr', { title: 'Perdidos' }, 'P')),
          h('th', { scope: 'col' }, h('abbr', { title: 'Diferencia de puntos' }, 'Dif')))),
        h('tbody', {}, tabla.map((t) => {
          const dif = t.dif ?? (t.ppp != null && t.pcpp != null ? Math.round((t.ppp - t.pcpp) * t.pj) : 0);
          return h('tr', { class: t.clippers ? 'es-clippers' : null },
            h('td', {}, t.pos),
            h('td', {}, h('span', { class: 'clasificacion__equipo' },
              t.logo ? h('img', { src: t.logo, alt: '', width: 22, height: 22, loading: 'lazy', decoding: 'async' }) : null, t.equipo)),
            h('td', {}, t.pj), h('td', {}, t.pg), h('td', {}, t.pp),
            h('td', {}, dif > 0 ? `+${dif}` : dif));
        })))));
}

export function pintarLiga(liga, clave) {
  const panel = document.getElementById('panel-liga');
  if (!panel) return;
  if (liga === undefined) { panel.replaceChildren(h('p', { class: 'partidos__vacio' }, 'Cargando la liga…')); return; }
  const grupo = liga?.grupos?.[clave];
  if (!grupo?.jornadas?.length) {
    panel.replaceChildren(h('p', { class: 'partidos__vacio' }, 'Los resultados de la liga no están disponibles ahora mismo. Consulta la web oficial.'));
    return;
  }

  const numeros = grupo.jornadas.map((j) => j.numero);
  if (!numeros.includes(jornadaElegida[clave])) jornadaElegida[clave] = jornadaInicial(grupo.jornadas);
  const actual = grupo.jornadas.find((j) => j.numero === jornadaElegida[clave]);
  const indice = numeros.indexOf(actual.numero);

  const ir = (numero, foco) => {
    jornadaElegida[clave] = numero;
    pintarLiga(liga, clave);
    const el = document.getElementById(foco);
    (el && !el.disabled ? el : document.getElementById('liga-selector'))?.focus();
  };
  const selector = h('select', { id: 'liga-selector', class: 'liga-nav__select', 'aria-label': 'Elegir jornada' },
    grupo.jornadas.map((j) => {
      const jugados = j.partidos.filter((p) => p.jugado).length;
      const op = h('option', { value: String(j.numero) }, `Jornada ${j.numero}${jugados === j.partidos.length && jugados ? ' ✓' : ''}`);
      if (j.numero === actual.numero) op.selected = true;
      return op;
    }));
  selector.addEventListener('change', () => ir(Number(selector.value), 'liga-selector'));
  const anterior = h('button', { type: 'button', id: 'liga-anterior', class: 'liga-nav__flecha', 'aria-label': 'Jornada anterior', disabled: indice === 0 }, '‹');
  const siguiente = h('button', { type: 'button', id: 'liga-siguiente', class: 'liga-nav__flecha', 'aria-label': 'Jornada siguiente', disabled: indice === numeros.length - 1 }, '›');
  anterior.addEventListener('click', () => ir(numeros[indice - 1], 'liga-anterior'));
  siguiente.addEventListener('click', () => ir(numeros[indice + 1], 'liga-siguiente'));

  panel.replaceChildren(
    h('div', { class: 'liga-rejilla' },
      h('div', { class: 'liga-bloque' },
        h('div', { class: 'liga-nav' }, anterior, selector, siguiente),
        h('div', { class: 'liga-jornada', 'aria-live': 'polite' }, pintarJornada(actual))),
      pintarClasificacion(liga.clasificacion?.[clave])),
  );
}
