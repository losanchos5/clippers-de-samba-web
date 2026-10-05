import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarEquipo, normalizarLiga } from '../src/swish.js';

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
