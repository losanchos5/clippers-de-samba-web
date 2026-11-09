import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarEquipo, normalizarLiga, normalizarPartido } from '../src/swish.js';

const CLIPPERS = { id: 'c', name: 'CLIPPERS DE SAMBA `B´', logo: null };
const NAROVELLA = { id: 'n', name: 'AT.C. NAROVELLA `B´', logo: 'https://cdn.leverade.com/thumbnails/AaogUi1SP2s7.500x500.jpg' };
const POBLA = { id: 'p', name: 'C.B. POBLA DE FARNALS', logo: null };
const OTRO = { id: 'o', name: 'OTRO EQUIPO', logo: null };

const clasificacion = [
  { teamId: 'n', name: NAROVELLA.name, position: 2, logo: null, stats: { playedMatches: 1, wonMatches: 0, lostMatches: 1, pointsPerGame: 35, opponentsPointsPerGame: 40 } },
  { teamId: 'c', name: CLIPPERS.name, position: 1, logo: null, stats: { playedMatches: 1, wonMatches: 1, lostMatches: 0, pointsPerGame: 40, opponentsPointsPerGame: 35 } },
];

function partido(id, local, visitante, date, status, totales = []) {
  return { id, homeTeam: local, awayTeam: visitante, date, status, score: { totals: totales } };
}

const calendario = {
  rounds: [
    { name: 'Jornada 1', matches: [
      // Clippers juega fuera y el marcador del local va primero en la lista
      partido('j1', NAROVELLA, CLIPPERS, '2026-10-03T16:00:00.000Z', 'CLOSED', [{ teamId: 'n', total: 35 }, { teamId: 'c', total: 40 }]),
      partido('x1', POBLA, OTRO, '2026-10-03T18:00:00.000Z', 'CLOSED', [{ teamId: 'p', total: 50 }, { teamId: 'o', total: 48 }]),
    ] },
    { name: 'Jornada 2', matches: [partido('j2', CLIPPERS, POBLA, '2026-11-07T17:30:00.000Z', 'NOT_STARTED')] },
    { name: 'Jornada 3', matches: [partido('j3', POBLA, CLIPPERS, '1970-01-01T00:00:00.000Z', 'NOT_STARTED')] },
    { name: 'Jornada 4', matches: [partido('j4', CLIPPERS, NAROVELLA, '2027-04-10T16:00:00.000Z', 'NOT_STARTED')] },
  ],
};

const grupo = { id: 'g', division: 'Quinta División' };

test('se queda solo con los partidos de Clippers y orienta el marcador desde su lado', () => {
  const { equipo } = normalizarEquipo(calendario, clasificacion, grupo);
  assert.equal(equipo.nombre, 'CLIPPERS DE SAMBA B');
  assert.deepEqual(equipo.partidos.map((p) => p.id), ['j1', 'j2', 'j3', 'j4']);

  const [j1, j2] = equipo.partidos;
  assert.equal(j1.local, false);
  assert.equal(j1.rival, 'AT.C. NAROVELLA B');
  assert.deepEqual(j1.resultado, { clippers: 40, rival: 35 });
  assert.equal(j1.rivalLogo, '/api/logo/AaogUi1SP2s7.jpg');
  assert.equal(j2.local, true);
  assert.equal(j2.resultado, null);
});

test('pasa las fechas a hora de Madrid (con cambio de horario) y deja sin fecha las jornadas sin programar', () => {
  const { equipo } = normalizarEquipo(calendario, clasificacion, grupo);
  const [j1, j2, j3, j4] = equipo.partidos;
  assert.deepEqual([j1.fecha, j1.hora], ['2026-10-03', '18:00']); // CEST, UTC+2
  assert.deepEqual([j2.fecha, j2.hora], ['2026-11-07', '18:30']); // CET, UTC+1
  assert.deepEqual([j3.inicio, j3.fecha, j3.hora], [null, null, null]);
  assert.deepEqual([j4.fecha, j4.hora], ['2027-04-10', '18:00']);
});

test('ordena la clasificación por posición y marca a Clippers', () => {
  const { clasificacion: tabla, equipo } = normalizarEquipo(calendario, clasificacion, grupo);
  assert.deepEqual(tabla.map((t) => [t.pos, t.equipo, t.clippers]), [
    [1, 'CLIPPERS DE SAMBA B', true],
    [2, 'AT.C. NAROVELLA B', false],
  ]);
  assert.deepEqual([equipo.posicion, equipo.total, equipo.stats.pg, equipo.stats.pp], [1, 2, 1, 0]);
});

test('la liga asigna cada marcador a su equipo y marca los partidos de Clippers', () => {
  const { jornadas } = normalizarLiga(calendario, clasificacion, grupo);
  assert.deepEqual(jornadas.map((j) => j.numero), [1, 2, 3, 4]);

  const [conClippers, otro] = jornadas[0].partidos;
  assert.equal(conClippers.clippers, true);
  assert.deepEqual([conClippers.local.nombre, conClippers.local.puntos], ['AT.C. NAROVELLA B', 35]);
  assert.deepEqual([conClippers.visitante.nombre, conClippers.visitante.puntos], ['CLIPPERS DE SAMBA B', 40]);
  assert.equal(otro.clippers, false);
  assert.deepEqual([otro.local.puntos, otro.visitante.puntos], [50, 48]);

  const sinJugar = jornadas[1].partidos[0];
  assert.equal(sinJugar.jugado, false);
  assert.deepEqual([sinJugar.local.puntos, sinJugar.visitante.puntos], [null, null]);
});

// Forma de match/<id>, match/<id>/players y match/<id>/stats/players de Swish.
function stat(teamId, playerId, extra) {
  return {
    teamId, playerId, points: 0, inArcThrowsMade: 0, inArcThrowsFailed: 0, outArcThrowsMade: 0, outArcThrowsFailed: 0,
    freeThrowsMade: 0, freeThrowsFailed: 0, fouls: 0, timePlayed: 0, plusMinus: 0, assists: 0, steals: 0, ...extra,
  };
}
const MATCH = {
  id: 'm1', date: '2026-10-04T14:20:00.000Z', status: 'CLOSED', scoresheetUrl: 'https://acta.pdf',
  homeTeam: CLIPPERS, awayTeam: POBLA,
  score: {
    totals: [{ teamId: 'c', total: 9 }, { teamId: 'p', total: 2 }],
    // desordenados a propósito: la API no garantiza el orden
    partials: [{ teamId: 'c', period: 2, partial: 4 }, { teamId: 'p', period: 1, partial: 2 }, { teamId: 'c', period: 1, partial: 5 }, { teamId: 'p', period: 2, partial: 0 }],
  },
};
const FICHAS = [
  { teamId: 'c', id: 'j7', name: 'Ana', lastName: 'Ruiz', number: '7' },
  { teamId: 'c', id: 'j4', name: 'Leo', lastName: 'Gil', number: '4' },
  { teamId: 'p', id: 'r9', name: 'Rival', lastName: 'Uno', number: '9' },
];
const STATS = [
  stat('c', 'j4', { points: 2, inArcThrowsMade: 1, fouls: 1, timePlayed: 610 }),
  stat('c', 'j7', { points: 7, outArcThrowsMade: 2, freeThrowsMade: 1, freeThrowsFailed: 1, timePlayed: 1200, plusMinus: 7 }),
  stat('p', 'r9', { points: 2, inArcThrowsMade: 1, timePlayed: 1800, plusMinus: -7 }),
  stat('c', 'hueco'), // fila a cero sin ficha, como las que manda Swish
];

test('el partido reparte a cada jugador en su equipo con dorsal, nombre y tiros', () => {
  const p = normalizarPartido(MATCH, FICHAS, STATS);
  assert.deepEqual([p.local.nombre, p.local.puntos, p.local.clippers], ['CLIPPERS DE SAMBA B', 9, true]);
  assert.deepEqual([p.visitante.puntos, p.visitante.clippers], [2, false]);
  assert.deepEqual(p.local.jugadores.map((j) => [j.dorsal, j.nombre, j.pts]), [[7, 'Ana Ruiz', 7], [4, 'Leo Gil', 2]]);
  assert.deepEqual(p.local.jugadores[0].tl, { m: 1, i: 2 });
  assert.deepEqual([p.local.jugadores[1].min, p.local.jugadores[1].t2], [10, 1]);
  assert.deepEqual(p.visitante.jugadores.map((j) => j.dorsal), [9]);
  assert.equal(p.acta, 'https://acta.pdf');
  assert.equal(normalizarPartido({ ...MATCH, scoresheetUrl: 'javascript:alert(1)' }).acta, null);
});

test('los cuartos salen en orden aunque la API los mande desordenados', () => {
  const p = normalizarPartido(MATCH, FICHAS, STATS);
  assert.deepEqual([p.local.cuartos, p.visitante.cuartos], [[5, 4], [2, 0]]);
  // Si falta un periodo, el siguiente no se corre a su columna
  const sinPrimero = { ...MATCH, score: { ...MATCH.score, partials: [{ teamId: 'c', period: 2, partial: 4 }] } };
  assert.deepEqual(normalizarPartido(sinPrimero).local.cuartos, [null, 4]);
});

test('solo hay columnas para los datos que la mesa ha apuntado', () => {
  const sinFaltasNiMasMenos = STATS.map((s) => ({ ...s, fouls: 0, plusMinus: 0 }));
  assert.deepEqual(normalizarPartido(MATCH, FICHAS, sinFaltasNiMasMenos).columnas, ['pts', 't2', 't3', 'tl', 'min']);
  assert.deepEqual(normalizarPartido({ ...MATCH, status: 'NOT_STARTED' }, [], []).columnas, []);
});

test('sin estado LIVE, el partido cuenta como en juego solo dentro de su horario', () => {
  const inicio = Date.parse(MATCH.date);
  const sinCerrar = { ...MATCH, status: 'NOT_STARTED' };
  assert.equal(normalizarPartido(sinCerrar, [], [], inicio + 3600e3).enJuego, true);
  assert.equal(normalizarPartido(sinCerrar, [], [], inicio - 3600e3).enJuego, false);
  assert.equal(normalizarPartido(sinCerrar, [], [], inicio + 4 * 3600e3).enJuego, false);
  assert.equal(normalizarPartido(MATCH, [], [], inicio + 3600e3).enJuego, false); // ya cerrado
  assert.equal(normalizarPartido({ ...MATCH, status: 'LIVE' }, [], [], inicio + 5 * 3600e3).enJuego, true);
});
