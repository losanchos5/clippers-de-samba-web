// Ventana de un partido de Clippers: marcador, puntos por cuarto y estadística por jugador
// (/api/partido/<id>). Mientras se juega se refresca cada minuto, solo con la ventana abierta
// y la pestaña visible; el Worker cachea 60 s, así que la API de la liga no nota las visitas.
import { cargarJSON, h } from './dom.js';

const REFRESCO_MS = 60_000;
const ANTES_MS = 15 * 60e3;
const DESPUES_MS = 3 * 3600e3;

// La mesa de nuestra liga no apunta rebotes, asistencias ni robos: solo estas columnas.
const COLUMNAS = {
  pts: { corto: 'PTS', largo: 'Puntos', valor: (j) => j.pts },
  t2: { corto: 'T2', largo: 'Canastas de 2', valor: (j) => j.t2 },
  t3: { corto: 'T3', largo: 'Triples', valor: (j) => j.t3 },
  tl: { corto: 'TL', largo: 'Tiros libres anotados / intentados', valor: (j) => `${j.tl.m}/${j.tl.i}` },
  faltas: { corto: 'F', largo: 'Faltas', valor: (j) => j.faltas },
  min: { corto: 'MIN', largo: 'Minutos', valor: (j) => j.min },
  masMenos: { corto: '+/-', largo: 'Más/menos: diferencia de puntos con el jugador en pista', valor: (j) => (j.masMenos > 0 ? `+${j.masMenos}` : j.masMenos) },
};

const fmtFecha = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' });
const fmtHora = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

let idAbierto = null;
let temporizador = null;
let peticion = 0; // descarta respuestas que llegan tarde
let tanteoAnunciado = '';

// Misma regla que el Worker: la liga nunca ha mandado el estado LIVE, así que se deduce por la hora.
export function partidoEnJuego(p, ahora = Date.now()) {
  if (p.estado === 'LIVE') return true;
  if (p.resultado || !p.inicio || ['CLOSED', 'FINISHED', 'DEFERRED'].includes(p.estado)) return false;
  const t = Date.parse(p.inicio);
  return ahora >= t - ANTES_MS && ahora <= t + DESPUES_MS;
}

function escudo(equipo) {
  if (equipo.logo) return h('img', { class: 'ficha__escudo', src: equipo.logo, alt: '', width: 56, height: 56, decoding: 'async' });
  const iniciales = equipo.nombre.split(/\s+/).filter((w) => /^[A-ZÁÉÍÓÚÑ]/i.test(w)).slice(0, 2).map((w) => w[0]).join('');
  return h('span', { class: 'ficha__escudo ficha__escudo--vacio', 'aria-hidden': 'true' }, iniciales);
}

function marcador(d) {
  const hayPuntos = d.cerrado || d.enJuego;
  const lado = (e) => h('div', { class: `ficha__equipo${e.clippers ? ' ficha__equipo--clippers' : ''}` },
    escudo(e), h('span', { class: 'ficha__nombre' }, e.nombre));
  return h('div', { class: 'ficha__marcador' },
    lado(d.local),
    h('p', { class: 'ficha__tanteo', 'aria-label': hayPuntos ? `${d.local.puntos ?? 0} a ${d.visitante.puntos ?? 0}` : 'Sin empezar' },
      hayPuntos ? `${d.local.puntos ?? 0}–${d.visitante.puntos ?? 0}` : 'vs'),
    lado(d.visitante));
}

function tablaCuartos(d) {
  const n = Math.max(d.local.cuartos.length, d.visitante.cuartos.length);
  if (!n) return null;
  const periodos = Array.from({ length: n }, (_, i) => (i < 4 ? `${i + 1}º` : `PR${n > 5 ? i - 3 : ''}`));
  const fila = (e) => h('tr', { class: e.clippers ? 'es-clippers' : null },
    h('th', { scope: 'row' }, e.nombre), periodos.map((_, i) => h('td', {}, e.cuartos[i] ?? '–')));
  return h('div', { class: 'tabla-envoltura' },
    h('table', { class: 'clasificacion ficha__cuartos' },
      h('caption', { class: 'sr-only' }, 'Puntos por cuarto'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Cuarto'), periodos.map((p) => h('th', { scope: 'col' }, p)))),
      h('tbody', {}, fila(d.local), fila(d.visitante))));
}

function tablaJugadores(equipo, columnas) {
  if (!equipo.jugadores.length) return null;
  return h('div', { class: 'ficha__bloque' },
    h('h3', { class: 'subtitulo' }, equipo.nombre),
    h('div', { class: 'tabla-envoltura' },
      h('table', { class: `clasificacion ficha__jugadores${equipo.clippers ? ' ficha__jugadores--clippers' : ''}` },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, 'Jugador'),
          columnas.map((c) => h('th', { scope: 'col' }, h('abbr', { title: COLUMNAS[c].largo }, COLUMNAS[c].corto))))),
        h('tbody', {}, equipo.jugadores.map((j) => h('tr', {},
          h('td', {}, j.dorsal ?? ''), h('td', {}, j.nombre),
          columnas.map((c) => h('td', {}, COLUMNAS[c].valor(j)))))))));
}

function pintar(d) {
  const cuerpo = document.getElementById('partido-cuerpo');
  if (!d) {
    cuerpo.replaceChildren(h('p', { class: 'partidos__vacio' }, 'No se ha podido cargar el partido. Prueba en un rato o mira la app Swish.'));
    return;
  }
  const estado = d.enJuego
    ? h('span', { class: 'chapa chapa--directo' }, 'En directo')
    : d.cerrado ? h('span', { class: 'chapa chapa--v' }, 'Final') : null;
  const dia = d.inicio ? fmtFecha.format(new Date(d.inicio)) : '';
  const fecha = d.inicio ? `${dia[0].toUpperCase()}${dia.slice(1)} · ${d.hora}` : 'Fecha por confirmar';
  const columnas = d.columnas.filter((c) => COLUMNAS[c]);
  const tablas = [d.local, d.visitante].sort((a, b) => b.clippers - a.clippers).map((e) => tablaJugadores(e, columnas)).filter(Boolean);

  // replaceChildren no aplana arrays ni ignora null (los pintaría como texto)
  cuerpo.replaceChildren(...[
    h('p', { class: 'ficha__estado' }, estado, h('span', {}, fecha)),
    marcador(d),
    tablaCuartos(d),
    ...(tablas.length ? tablas : [h('p', { class: 'partidos__vacio' },
      d.enJuego ? 'La estadística por jugador aparecerá cuando la mesa la publique.' : 'No hay estadística de este partido.')]),
    h('p', { class: 'ficha__pie' },
      d.enJuego ? `Se actualiza cada minuto. Último dato: ${fmtHora.format(new Date(d.actualizado))}. ` : '',
      'La mesa no apunta rebotes ni asistencias. ',
      d.acta ? h('a', { href: d.acta, target: '_blank', rel: 'noopener' }, 'Ver el acta oficial') : null),
  ].filter(Boolean));

  // Al lector de pantalla solo se le anuncia el tanteo cuando cambia, no la ventana entera.
  const tanteo = d.cerrado || d.enJuego ? `${d.local.nombre} ${d.local.puntos ?? 0}, ${d.visitante.nombre} ${d.visitante.puntos ?? 0}` : '';
  if (tanteo !== tanteoAnunciado) {
    tanteoAnunciado = tanteo;
    document.getElementById('partido-anuncio').textContent = tanteo;
  }
}

async function cargar(id, enDirecto = false) {
  const n = ++peticion;
  const datos = await cargarJSON([`/api/partido/${id}`], 10_000);
  if (n !== peticion || idAbierto !== id) return; // se cerró, o ya hay una petición más nueva
  // En directo, un fallo puntual deja el último marcador y se reintenta al minuto.
  if (!datos && temporizador) return;
  pintar(datos);
  clearInterval(temporizador);
  const seguir = datos ? datos.enJuego : enDirecto;
  temporizador = seguir ? setInterval(() => { if (!document.hidden) cargar(id, true); }, REFRESCO_MS) : null;
}

export function abrirPartido(id, titulo, enDirecto = false) {
  const dialogo = document.getElementById('partido-dialogo');
  idAbierto = id;
  tanteoAnunciado = '';
  document.getElementById('partido-titulo').textContent = titulo;
  document.getElementById('partido-cuerpo').replaceChildren(h('p', { class: 'partidos__vacio' }, 'Cargando el partido…'));
  if (!dialogo.open) dialogo.showModal();
  clearInterval(temporizador);
  temporizador = null;
  cargar(id, enDirecto);
}

export function iniciarPartido() {
  const dialogo = document.getElementById('partido-dialogo');
  dialogo.addEventListener('close', () => {
    const id = idAbierto;
    idAbierto = null;
    clearInterval(temporizador);
    temporizador = null;
    // La portada se repinta cada 30 s: si el botón de origen ya no existe, el foco va al nuevo.
    if (document.activeElement === document.body) document.querySelector(`[data-partido="${id}"]`)?.focus();
  });
  // Al volver a la pestaña, el directo se pone al día sin esperar al siguiente minuto.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && idAbierto && temporizador) cargar(idAbierto, true); });
  // Clic fuera de la caja (en el fondo del <dialog>) también cierra.
  dialogo.addEventListener('click', (e) => { if (e.target === dialogo) dialogo.close(); });
  document.getElementById('partido-cerrar').addEventListener('click', () => dialogo.close());
  document.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-partido]');
    if (boton) abrirPartido(boton.dataset.partido, boton.dataset.titulo, 'directo' in boton.dataset);
  });
}
