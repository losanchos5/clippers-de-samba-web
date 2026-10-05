// Regenera public/datos/partidos.json y liga.json desde la API de la liga. Son el
// respaldo que usa la web si /api/calendario o /api/liga fallan. Se lanza antes de cada deploy.
//   node scripts/calendario.mjs              → actualiza los JSON
//   node scripts/calendario.mjs --descubrir  → lista grupos (para una nueva temporada)
import { writeFile } from 'node:fs/promises';
import { obtenerTodo, descubrir } from '../src/swish.js';

const DESTINO = new URL('../public/datos/partidos.json', import.meta.url);
const DESTINO_LIGA = new URL('../public/datos/liga.json', import.meta.url);

if (process.argv.includes('--descubrir')) {
  for (const c of await descubrir()) {
    console.log(`\n${c.temporada} · ${c.competicion}`);
    for (const g of c.grupos) console.log(`  ${g.id}  ${g.nombre}`);
  }
} else {
  const { calendario: datos, liga } = await obtenerTodo();
  await writeFile(DESTINO, JSON.stringify(datos, null, 2) + '\n');
  await writeFile(DESTINO_LIGA, JSON.stringify(liga) + '\n');
  for (const [clave, e] of Object.entries(datos.equipos)) {
    const jugados = e.partidos.filter((p) => p.resultado).length;
    const proximo = e.partidos.find((p) => !p.resultado && p.inicio);
    console.log(`${clave} · ${e.nombre} · ${e.division} · ${e.posicion}º de ${e.total} · ${jugados}/${e.partidos.length} jugados · próximo: ${proximo ? `${proximo.fecha} ${proximo.hora} vs ${proximo.rival}` : '—'}`);
  }
}
