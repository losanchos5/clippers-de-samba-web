// Regenera public/datos/partidos.json desde la API de la liga. Es el respaldo
// que usa la web si /api/calendario falla. Se lanza solo antes de cada deploy.
//   node scripts/calendario.mjs              → actualiza el JSON
//   node scripts/calendario.mjs --descubrir  → lista grupos (para una nueva temporada)
import { writeFile } from 'node:fs/promises';
import { obtenerCalendario, descubrir } from '../src/swish.js';

const DESTINO = new URL('../public/datos/partidos.json', import.meta.url);

if (process.argv.includes('--descubrir')) {
  for (const c of await descubrir()) {
    console.log(`\n${c.temporada} · ${c.competicion}`);
    for (const g of c.grupos) console.log(`  ${g.id}  ${g.nombre}`);
  }
} else {
  const datos = await obtenerCalendario();
  await writeFile(DESTINO, JSON.stringify(datos, null, 2) + '\n');
  for (const [clave, e] of Object.entries(datos.equipos)) {
    const jugados = e.partidos.filter((p) => p.resultado).length;
    const proximo = e.partidos.find((p) => !p.resultado && p.inicio);
    console.log(`${clave} · ${e.nombre} · ${e.division} · ${e.posicion}º de ${e.total} · ${jugados}/${e.partidos.length} jugados · próximo: ${proximo ? `${proximo.fecha} ${proximo.hora} vs ${proximo.rival}` : '—'}`);
  }
}
