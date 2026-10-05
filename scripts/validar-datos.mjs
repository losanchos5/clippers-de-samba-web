// Comprueba los JSON de public/datos antes de desplegar. equipos.json se edita a
// mano, así que aquí se cazan dorsales repetidos, campos vacíos o JSON roto.
//   node scripts/validar-datos.mjs
import { readFile } from 'node:fs/promises';

const errores = [];
const error = (ruta, mensaje) => errores.push(`${ruta}: ${mensaje}`);

async function leerJSON(fichero) {
  try {
    return JSON.parse(await readFile(new URL(`../public/datos/${fichero}`, import.meta.url), 'utf8'));
  } catch (e) {
    error(fichero, `no se puede leer como JSON (${e.message})`);
    return null;
  }
}

const esTexto = (v) => typeof v === 'string' && v.trim() !== '';
const esEntero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validarEquipos(datos) {
  if (!datos) return;
  for (const clave of ['A', 'B']) {
    const equipo = datos[clave];
    const ruta = `equipos.json › ${clave}`;
    if (!equipo || typeof equipo !== 'object') { error(ruta, 'falta el equipo'); continue; }
    if (!Array.isArray(equipo.jugadores)) { error(ruta, '«jugadores» debe ser una lista'); continue; }
    const dorsales = new Set();
    equipo.jugadores.forEach((j, i) => {
      const rj = `${ruta} › jugador ${i + 1}`;
      if (!esEntero(j.dorsal, 0, 99)) error(rj, `dorsal no válido (${JSON.stringify(j.dorsal)}); debe ser un número de 0 a 99`);
      else if (dorsales.has(j.dorsal)) error(rj, `el dorsal ${j.dorsal} está repetido`);
      dorsales.add(j.dorsal);
      if (!esTexto(j.nombre)) error(rj, 'falta el nombre');
      if (j.posicion != null && !esTexto(j.posicion)) error(rj, '«posicion» debe ser texto o no aparecer');
    });
  }
}

function validarPartidos(datos) {
  if (!datos) return;
  for (const clave of ['A', 'B']) {
    const equipo = datos.equipos?.[clave];
    const ruta = `partidos.json › ${clave}`;
    if (!equipo || !Array.isArray(equipo.partidos)) { error(ruta, 'faltan los partidos'); continue; }
    equipo.partidos.forEach((p, i) => {
      const rp = `${ruta} › partido ${i + 1}`;
      if (!esEntero(p.jornada, 1, 99)) error(rp, 'jornada no válida');
      if (!esTexto(p.rival)) error(rp, 'falta el rival');
      if (typeof p.local !== 'boolean') error(rp, '«local» debe ser true o false');
      if (p.inicio !== null && Number.isNaN(Date.parse(p.inicio))) error(rp, `«inicio» no es una fecha (${p.inicio})`);
      if (p.resultado !== null) {
        const r = p.resultado ?? {};
        if (!esEntero(r.clippers, 0, 300) || !esEntero(r.rival, 0, 300)) error(rp, 'resultado no válido');
      }
    });
  }
}

validarEquipos(await leerJSON('equipos.json'));
validarPartidos(await leerJSON('partidos.json'));

if (errores.length) {
  console.error(`✗ ${errores.length} problema(s) en los datos:\n  - ${errores.join('\n  - ')}`);
  process.exit(1);
}
console.log('✓ Datos correctos');
