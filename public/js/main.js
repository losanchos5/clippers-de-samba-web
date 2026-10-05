import { CONFIG } from './config.js';
import { iniciarAudio } from './audio.js';
import { h, svg } from './dom.js';
import { pintarEstadisticas, reiniciarEstadisticas } from './estadisticas.js';
import { pintarLiga } from './liga.js';

const ZONA = 'Europe/Madrid';
const PARTIDOS_VISIBLES = 6;
const NOMBRE_EQUIPO = { A: 'Clippers A', B: 'Clippers B' };

// undefined = cargando, null = no se pudo cargar
const estado = {
  equipo: 'A',
  calendario: undefined,
  plantillas: undefined,
  estadisticas: undefined,
  liga: undefined,
  verTodos: false,
};

// ---------- Utilidades ----------

function leer(objeto, ruta) {
  return ruta.split('.').reduce((o, k) => (o == null ? o : o[k]), objeto);
}

async function cargarJSON(rutas, tiempoMaxMs = 6000) {
  for (const ruta of rutas) {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), tiempoMaxMs);
    try {
      const res = await fetch(ruta, { headers: { Accept: 'application/json' }, signal: control.signal });
      if (res.ok) return await res.json();
    } catch {
      // probamos la siguiente fuente
    } finally {
      clearTimeout(temporizador);
    }
  }
  return null;
}

const fmtDia = new Intl.DateTimeFormat('es-ES', { day: 'numeric', timeZone: ZONA });
const fmtMes = new Intl.DateTimeFormat('es-ES', { month: 'short', timeZone: ZONA });
const fmtLargo = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: ZONA });
const fmtActualizado = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: ZONA });

function sinPunto(texto) {
  return texto.replace('.', '');
}

// ---------- Configuración en el HTML ----------

function aplicarConfig() {
  document.querySelectorAll('[data-config]').forEach((el) => {
    const valor = leer(CONFIG, el.dataset.config);
    if (valor) el.textContent = valor;
  });
  document.querySelectorAll('[data-config-href]').forEach((el) => {
    const valor = leer(CONFIG, el.dataset.configHref);
    if (valor) el.href = valor;
  });
  const instagram = `https://www.instagram.com/${encodeURIComponent(CONFIG.instagram)}/`;
  document.querySelectorAll('[data-instagram]').forEach((el) => { el.href = instagram; });
  document.querySelectorAll('[data-instagram-dm]').forEach((el) => { el.href = `https://ig.me/m/${encodeURIComponent(CONFIG.instagram)}`; });
  const whatsapp = document.querySelector('[data-whatsapp]');
  if (whatsapp && CONFIG.whatsapp) {
    whatsapp.href = `https://wa.me/${CONFIG.whatsapp.replace(/\D/g, '')}`;
    whatsapp.hidden = false;
  }
  const email = document.querySelector('[data-email]');
  if (email && CONFIG.email) {
    email.href = `mailto:${CONFIG.email}`;
    email.hidden = false;
  }
  const anio = document.getElementById('anio');
  if (anio) anio.textContent = String(new Date().getFullYear());
}

// ---------- Cabecera y menú ----------

function iniciarCabecera() {
  const cabecera = document.getElementById('cabecera');
  const boton = document.getElementById('hamburguesa');
  const menu = document.getElementById('menu');

  const alHacerScroll = () => cabecera.classList.toggle('con-fondo', window.scrollY > 24);
  alHacerScroll();
  window.addEventListener('scroll', alHacerScroll, { passive: true });

  // Con el menú abierto en móvil, el resto de la página no recibe foco.
  const fondoMenu = [document.getElementById('contenido'), document.querySelector('.pie'), document.getElementById('boton-sonido')];
  const abrir = (abierto) => {
    document.body.classList.toggle('menu-abierto', abierto);
    boton.setAttribute('aria-expanded', String(abierto));
    boton.setAttribute('aria-label', abierto ? 'Cerrar menú' : 'Abrir menú');
    fondoMenu.forEach((el) => { if (el) el.inert = abierto; });
    if (abierto) menu.querySelector('a')?.focus();
  };
  boton.addEventListener('click', () => abrir(boton.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) abrir(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-abierto')) {
      abrir(false);
      boton.focus();
    }
  });
  matchMedia('(min-width: 960px)').addEventListener('change', () => abrir(false));

  // Enlace activo según la sección visible
  const enlaces = new Map([...menu.querySelectorAll('a')].map((a) => [a.hash.slice(1), a]));
  const observador = new IntersectionObserver((entradas) => {
    for (const entrada of entradas) {
      if (!entrada.isIntersecting) continue;
      enlaces.forEach((a) => a.classList.remove('activo'));
      enlaces.get(entrada.target.id)?.classList.add('activo');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  enlaces.forEach((_, id) => { const s = document.getElementById(id); if (s) observador.observe(s); });
}

// ---------- Pestañas A / B (sincronizadas entre secciones) ----------

function iniciarPestanas() {
  const grupos = document.querySelectorAll('[data-grupo-equipo]');
  grupos.forEach((grupo) => {
    const tabs = [...grupo.querySelectorAll('[role="tab"]')];
    grupo.addEventListener('click', (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab) elegirEquipo(tab.dataset.equipo);
    });
    grupo.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let siguiente = null;
      if (e.key === 'ArrowRight') siguiente = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') siguiente = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') siguiente = tabs[0];
      if (e.key === 'End') siguiente = tabs[tabs.length - 1];
      if (!siguiente) return;
      e.preventDefault();
      elegirEquipo(siguiente.dataset.equipo);
      siguiente.focus();
    });
  });
}

function elegirEquipo(clave) {
  estado.equipo = clave;
  estado.verTodos = false;
  document.querySelectorAll('[data-grupo-equipo]').forEach((grupo) => {
    grupo.querySelectorAll('[role="tab"]').forEach((tab) => {
      const activo = tab.dataset.equipo === clave;
      tab.setAttribute('aria-selected', String(activo));
      tab.tabIndex = activo ? 0 : -1;
      if (activo) document.getElementById(tab.getAttribute('aria-controls'))?.setAttribute('aria-labelledby', tab.id);
    });
  });
  pintarEquipo();
  pintarCalendario();
  reiniciarEstadisticas();
  pintarSeccionEstadisticas();
  pintarLiga(estado.liga, estado.equipo);
}

function pintarSeccionEstadisticas() {
  pintarEstadisticas({ clave: estado.equipo, estadisticas: estado.estadisticas, plantillas: estado.plantillas });
}

// ---------- Equipos ----------

function camiseta(dorsal) {
  return svg('svg', { class: 'camiseta', viewBox: '0 0 120 140', 'aria-hidden': 'true' },
    svg('path', { class: 'camiseta__cuerpo', d: 'M34 4H46Q50 24 60 24Q70 24 74 4H86Q90 34 112 40L110 136H10L8 40Q30 34 34 4Z' }),
    svg('path', { class: 'camiseta__ribete', d: 'M46 4Q50 24 60 24Q70 24 74 4M86 4Q90 34 112 40M34 4Q30 34 8 40' }),
    svg('path', { class: 'camiseta__ribete camiseta__ribete--fino', d: 'M42 4Q47 30 60 30Q73 30 78 4' }),
    Object.assign(svg('text', { class: 'camiseta__dorsal', x: '60', y: '96', 'text-anchor': 'middle' }), { textContent: String(dorsal ?? '') }),
  );
}

function pintarEquipo() {
  const clave = estado.equipo;
  const plantilla = estado.plantillas?.[clave];
  const liga = estado.calendario?.equipos?.[clave];
  const panel = document.getElementById('panel-equipos');

  panel.querySelector('[data-campo="nombre"]').textContent = liga?.nombre ?? plantilla?.nombre ?? `Clippers de Samba ${clave}`;
  panel.querySelector('[data-campo="division"]').textContent = liga?.division ?? plantilla?.division ?? '';
  panel.querySelector('[data-campo="staff"]').textContent = plantilla?.staff ?? '';

  const stats = document.getElementById('equipo-stats');
  stats.replaceChildren();
  if (liga?.stats) {
    const s = liga.stats;
    stats.append(
      h('li', {}, h('b', {}, `${liga.posicion}º`), ` de ${liga.total}`),
      h('li', {}, h('b', {}, `${s.pg}-${s.pp}`), ' balance'),
    );
    if (s.pj > 0) {
      stats.append(
        h('li', {}, h('b', {}, s.ppp), ' pts a favor'),
        h('li', {}, h('b', {}, s.pcpp), ' en contra'),
      );
    }
  }

  const actas = estado.estadisticas?.equipos?.[clave];
  const statsPorDorsal = new Map((actas?.jugadores ?? []).map((j) => [j.dorsal, j]));

  const lista = document.getElementById('plantilla');
  const jugadores = [...(plantilla?.jugadores ?? [])].sort((a, b) => (a.dorsal ?? 999) - (b.dorsal ?? 999));
  lista.replaceChildren(...jugadores.map((j, i) => {
    const st = statsPorDorsal.get(j.dorsal);
    return h('li', { class: 'jugador', style: { '--i': i } },
      camiseta(j.dorsal),
      h('p', { class: 'jugador__nombre' }, j.nombre),
      j.posicion ? h('p', { class: 'jugador__pos' }, j.posicion) : null,
      st?.pj > 0 ? h('p', { class: 'jugador__stats' },
        h('span', {}, h('b', {}, st.puntos), 'pts'),
        h('span', {}, h('b', {}, (st.puntos / st.pj).toFixed(1).replace('.', ',')), 'ppp'),
        st.t3 > 0 ? h('span', {}, h('b', {}, st.t3), 'triples') : null,
      ) : null,
    );
  }));
  document.getElementById('aviso-plantilla').hidden = !estado.plantillas?.provisional;
  pintarLideres(actas, plantilla);
}

function pintarLideres(actas, plantilla) {
  const bloque = document.getElementById('bloque-lideres');
  const fuente = document.getElementById('fuente-estadisticas');
  const nombres = new Map((plantilla?.jugadores ?? []).map((j) => [j.dorsal, j.nombre]));
  const top = (actas?.jugadores ?? [])
    .filter((j) => j.pj > 0 && j.puntos > 0 && nombres.has(j.dorsal))
    .sort((a, b) => b.puntos - a.puntos || a.dorsal - b.dorsal)
    .slice(0, 3);

  bloque.hidden = top.length === 0;
  document.getElementById('lideres').replaceChildren(...top.map((j, i) => h('li', { class: 'lider' },
    h('span', { class: 'lider__puesto', 'aria-hidden': 'true' }, i + 1),
    h('span', { class: 'lider__nombre' }, h('small', {}, `#${j.dorsal}`), nombres.get(j.dorsal)),
    h('span', { class: 'lider__puntos' }, h('b', {}, j.puntos), ' pts'),
  )));

  const jugados = actas?.partidos?.filter((p) => p.cuadra).length ?? 0;
  fuente.hidden = jugados === 0;
  fuente.textContent = jugados
    ? `Estadísticas de ${jugados} ${jugados === 1 ? 'partido' : 'partidos'}, sacadas de las actas oficiales de la liga.`
    : '';
}

// ---------- Calendario ----------

function etiquetaEstado(p, esProximo) {
  if (p.resultado) {
    const gana = p.resultado.clippers > p.resultado.rival;
    return h('span', { class: `chapa ${gana ? 'chapa--v' : 'chapa--d'}`, title: gana ? 'Victoria' : 'Derrota' }, gana ? 'V' : 'D');
  }
  if (p.estado === 'LIVE') return h('span', { class: 'chapa chapa--prox' }, 'En juego');
  if (p.estado === 'DEFERRED') return h('span', { class: 'chapa chapa--d' }, 'Aplazado');
  if (esProximo) return h('span', { class: 'chapa chapa--prox' }, 'Próximo');
  return null;
}

function rivalConLogo(p) {
  return [
    p.rivalLogo ? h('img', { class: 'partido__logo', src: p.rivalLogo, alt: '', width: 28, height: 28, loading: 'lazy', decoding: 'async' }) : null,
    h('span', {}, `${p.local ? 'vs' : '@'} ${p.rival}`),
  ];
}

function itemPartido(p, i, idProximo) {
  const fecha = p.inicio ? new Date(p.inicio) : null;
  const esProximo = p.id === idProximo;
  return h('li', { class: `partido${p.resultado ? ' partido--jugado' : ''}${esProximo ? ' partido--proximo' : ''}`, style: { '--i': i } },
    h('div', { class: 'partido__fecha', 'aria-hidden': 'true' },
      h('span', { class: 'partido__dia' }, fecha ? fmtDia.format(fecha) : `J${p.jornada}`),
      h('span', { class: 'partido__mes' }, fecha ? sinPunto(fmtMes.format(fecha)) : 's/f'),
    ),
    h('div', { class: 'partido__info' },
      h('p', { class: 'partido__rival' },
        h('small', {}, `Jornada ${p.jornada} · ${p.local ? 'En casa' : 'Fuera'}`),
        h('span', { class: 'partido__nombre' }, ...rivalConLogo(p)),
      ),
      h('p', { class: 'partido__detalle' }, fecha ? `${sinPunto(fmtLargo.format(fecha))} · ${p.hora}` : 'Fecha por confirmar'),
    ),
    h('div', { class: 'partido__resultado' },
      p.resultado ? h('span', { class: 'marcador', 'aria-label': `${p.resultado.clippers} a ${p.resultado.rival}` }, `${p.resultado.clippers}–${p.resultado.rival}`) : null,
      etiquetaEstado(p, esProximo),
    ),
  );
}

// Por fecha y no por jornada: una jornada aplazada puede jugarse más tarde que la siguiente.
function proximoPartido(partidos) {
  const ahora = Date.now();
  return partidos
    .filter((p) => !p.resultado && p.inicio && p.estado !== 'DEFERRED' && Date.parse(p.inicio) + 2 * 3600e3 > ahora)
    .sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio))[0];
}

function ultimoPartido(partidos) {
  const cuando = (p) => (p.inicio ? Date.parse(p.inicio) : 0);
  return partidos
    .filter((p) => p.resultado)
    .sort((a, b) => cuando(b) - cuando(a) || b.jornada - a.jornada)[0];
}

function pintarCalendario() {
  const datos = estado.calendario;
  const lista = document.getElementById('partidos');
  const boton = document.getElementById('ver-todos');
  const equipo = datos?.equipos?.[estado.equipo];

  if (datos === undefined) return; // todavía cargando
  if (!equipo) {
    lista.replaceChildren(h('li', { class: 'partidos__vacio' }, 'El calendario no está disponible ahora mismo. Consulta la web oficial de la liga.'));
    boton.hidden = true;
    return;
  }

  const proximo = proximoPartido(equipo.partidos);
  const jugados = equipo.partidos.filter((p) => p.resultado).length;
  const limite = Math.max(PARTIDOS_VISIBLES, jugados + 4);
  const visibles = estado.verTodos ? equipo.partidos : equipo.partidos.slice(0, limite);
  lista.replaceChildren(...visibles.map((p, i) => itemPartido(p, i, proximo?.id)));
  boton.hidden = equipo.partidos.length <= limite;
  boton.setAttribute('aria-expanded', String(estado.verTodos));
  boton.textContent = estado.verTodos ? 'Ver menos' : `Ver calendario completo (${equipo.partidos.length})`;
}

function iniciales(nombre) {
  return nombre.split(/\s+/).filter((w) => /^[A-ZÁÉÍÓÚÑ]/i.test(w)).slice(0, 2).map((w) => w[0]).join('');
}

function ladoDuelo(nombre, escudo) {
  return h('div', { class: 'duelo__equipo' }, h('span', { class: 'duelo__marco' }, escudo), h('span', { class: 'duelo__nombre' }, nombre));
}

function cuentaAtras(inicio) {
  const ms = new Date(inicio).getTime() - Date.now();
  if (ms <= 0) return h('p', { class: 'proximo__cuando' }, '¡Se está jugando!');
  const d = Math.floor(ms / 864e5);
  const hrs = Math.floor((ms % 864e5) / 36e5);
  const min = Math.floor((ms % 36e5) / 6e4);
  return h('div', { class: 'cuenta', role: 'timer', 'aria-label': `Faltan ${d} días, ${hrs} horas y ${min} minutos` },
    h('span', {}, h('b', {}, d), h('small', {}, d === 1 ? 'día' : 'días')),
    h('span', {}, h('b', {}, String(hrs).padStart(2, '0')), h('small', {}, 'horas')),
    h('span', {}, h('b', {}, String(min).padStart(2, '0')), h('small', {}, 'min')),
  );
}

function pintarProximos() {
  const caja = document.getElementById('proximos');
  const equipos = estado.calendario?.equipos;
  if (!equipos) { caja.replaceChildren(); return; }

  caja.replaceChildren(...['A', 'B'].filter((k) => equipos[k]).map((clave) => {
    const e = equipos[clave];
    const p = proximoPartido(e.partidos);
    const ultimo = ultimoPartido(e.partidos);
    const cabecera = h('p', { class: 'proximo__equipo' }, `${NOMBRE_EQUIPO[clave]} · ${e.division}`);
    const resumenUltimo = ultimo
      ? h('p', { class: 'proximo__ultimo' },
        `Último: ${ultimo.resultado.clippers > ultimo.resultado.rival ? 'victoria' : 'derrota'} ${ultimo.resultado.clippers}–${ultimo.resultado.rival} ${ultimo.local ? 'ante' : 'en casa de'} ${ultimo.rival}`)
      : null;

    if (!p) {
      return h('article', { class: 'proximo proximo--vacio' }, cabecera,
        h('p', { class: 'proximo__duelo' }, 'Próximas fechas por confirmar'), resumenUltimo);
    }
    const nosotros = ladoDuelo(NOMBRE_EQUIPO[clave], h('img', { class: 'duelo__escudo', src: '/assets/escudo-verde.webp', alt: '', width: 64, height: 56 }));
    const ellos = ladoDuelo(p.rival, p.rivalLogo
      ? h('img', { class: 'duelo__escudo', src: p.rivalLogo, alt: '', width: 64, height: 64, loading: 'lazy', decoding: 'async' })
      : h('span', { class: 'duelo__escudo duelo__escudo--vacio', 'aria-hidden': 'true' }, iniciales(p.rival)));
    return h('article', { class: 'proximo', 'aria-label': `Próximo partido de ${NOMBRE_EQUIPO[clave]}` },
      cabecera,
      h('div', { class: 'duelo' }, p.local ? nosotros : ellos, h('span', { class: 'proximo__vs' }, 'vs'), p.local ? ellos : nosotros),
      h('p', { class: 'proximo__cuando' }, `${sinPunto(fmtLargo.format(new Date(p.inicio)))} · ${p.hora} · ${p.local ? 'En casa' : 'Fuera'} · L'Alqueria`),
      cuentaAtras(p.inicio),
      resumenUltimo,
    );
  }));

  const actualizado = document.getElementById('actualizado');
  if (estado.calendario.actualizado) {
    actualizado.textContent = `Actualizado el ${fmtActualizado.format(new Date(estado.calendario.actualizado))}.`;
  }
}

// ---------- Equipación: inclinación suave con el puntero ----------

function iniciarTilt() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('[data-tilt]').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--ry', `${x * 10}deg`);
      el.style.setProperty('--rx', `${-y * 10}deg`);
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
    });
  });
}

// ---------- Arranque ----------

// Cada fuente se pinta en cuanto llega: si la API de la liga tarda, la plantilla ya se ve.
function cargarDatos() {
  cargarJSON(CONFIG.fuentes.calendario).then((datos) => {
    estado.calendario = datos;
    pintarEquipo();
    pintarCalendario();
    pintarProximos();
  });
  cargarJSON(CONFIG.fuentes.equipos).then((datos) => {
    estado.plantillas = datos;
    pintarEquipo();
    pintarSeccionEstadisticas();
  });
  cargarJSON(CONFIG.fuentes.estadisticas).then((datos) => {
    estado.estadisticas = datos;
    pintarEquipo();
    pintarSeccionEstadisticas();
  });
  setInterval(pintarProximos, 30_000);

  // La liga entera pesa más: se pide al acercarse a su sección.
  pintarLiga(undefined, estado.equipo);
  const seccionLiga = document.getElementById('liga');
  const observador = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    observador.disconnect();
    cargarJSON(CONFIG.fuentes.liga, 10_000).then((datos) => {
      estado.liga = datos;
      pintarLiga(estado.liga, estado.equipo);
    });
  }, { rootMargin: '800px 0px' });
  observador.observe(seccionLiga);
}

// El balón 3D (three.js + textura generada) solo se carga al cruzar la pantalla de
// entrada: hasta entonces no se ve y así no frena la primera carga.
function cargarBalon() {
  document.addEventListener('clippers:entrada', () => {
    const arrancar = () => import('./balon.js').then((m) => m.iniciarBalon()).catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(arrancar, { timeout: 1200 });
    else setTimeout(arrancar, 400);
  }, { once: true });
}

aplicarConfig();
iniciarAudio();
iniciarCabecera();
iniciarPestanas();
iniciarTilt();
document.getElementById('ver-todos').addEventListener('click', () => {
  estado.verTodos = !estado.verTodos;
  pintarCalendario();
});
cargarDatos();
cargarBalon();
