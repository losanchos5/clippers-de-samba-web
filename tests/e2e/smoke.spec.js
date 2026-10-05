import { test, expect } from '@playwright/test';

// Calendario de prueba: la jornada 2 se ha aplazado a una fecha posterior a la 3.
const CALENDARIO = {
  temporada: '26/27',
  actualizado: '2026-10-05T10:00:00.000Z',
  equipos: {
    A: {
      nombre: 'CLIPPERS DE SAMBA A', division: 'Tercera División', posicion: 1, total: 2,
      stats: { pj: 1, pg: 1, pp: 0, ppp: 60, pcpp: 42, dif: 18 },
      partidos: [
        { id: 'a1', jornada: 1, inicio: '2026-10-04T14:20:00.000Z', fecha: '2026-10-04', hora: '16:20', rival: 'RIVAL UNO', rivalLogo: '/api/logo/AAAAAAAA.jpg', local: true, estado: 'CLOSED', resultado: { clippers: 60, rival: 42 } },
        { id: 'a2', jornada: 2, inicio: '2026-11-29T16:00:00.000Z', fecha: '2026-11-29', hora: '17:00', rival: 'RIVAL APLAZADO', rivalLogo: null, local: false, estado: 'NOT_STARTED', resultado: null },
        { id: 'a3', jornada: 3, inicio: '2026-10-25T15:20:00.000Z', fecha: '2026-10-25', hora: '16:20', rival: 'RIVAL TRES', rivalLogo: null, local: true, estado: 'NOT_STARTED', resultado: null },
      ],
    },
    B: {
      nombre: 'CLIPPERS DE SAMBA B', division: 'Quinta División', posicion: 2, total: 2,
      stats: { pj: 0, pg: 0, pp: 0, ppp: null, pcpp: null, dif: null },
      partidos: [
        { id: 'b1', jornada: 1, inicio: '2026-10-17T18:00:00.000Z', fecha: '2026-10-17', hora: '20:00', rival: 'RIVAL B', rivalLogo: null, local: true, estado: 'NOT_STARTED', resultado: null },
      ],
    },
  },
  clasificacion: { A: [], B: [] },
};

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function vigilarErrores(page) {
  const errores = [];
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
  page.on('pageerror', (e) => errores.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) errores.push(`${r.status()} ${r.url()}`); });
  return errores;
}

async function simularLiga(page, calendario = CALENDARIO) {
  await page.route('**/api/calendario', (r) => r.fulfill({ json: calendario }));
  await page.route('**/api/logo/**', (r) => r.fulfill({ body: PNG_1PX, contentType: 'image/png' }));
}

// Recorrido principal. La CSP es estricta (_headers), así que cualquier recurso
// bloqueado aparece como error de consola y hace fallar el test.
test('entrar con sonido arranca la música y la web carga equipos y calendario', async ({ page }) => {
  const errores = vigilarErrores(page);
  await simularLiga(page);

  await page.goto('/');
  await page.locator('#entrar-con-sonido').click();
  await expect(page.locator('#entrada')).toBeHidden();

  await expect.poll(() => page.evaluate(() => {
    const audio = document.getElementById('musica');
    return !audio.paused && audio.currentTime > 0;
  }), { timeout: 10_000 }).toBe(true);
  await expect(page.locator('#boton-sonido')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#boton-sonido').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('musica').paused)).toBe(true);

  await expect(page.locator('#partidos .partido').first()).toBeVisible();
  await expect(page.locator('#plantilla .jugador').first()).toBeVisible();
  await expect(page.locator('#panel-estadisticas .est-tabla tbody tr').first()).toBeVisible();

  await page.locator('#tab-cal-B').click();
  await expect(page.locator('#tab-equipos-B')).toHaveAttribute('aria-selected', 'true');

  const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(desborde).toBeLessThanOrEqual(0);
  expect(errores).toEqual([]);
});

test('si la API de la liga falla, el calendario sale del JSON de respaldo', async ({ page }) => {
  await page.route('**/api/calendario', (r) => r.fulfill({ status: 502, json: { error: 'caída' } }));
  await page.goto('/');
  await page.locator('#entrar-sin-sonido').click();

  await expect(page.locator('#partidos .partido').first()).toBeVisible();
  await expect(page.locator('#partidos')).not.toContainText('no está disponible');
});

test('el próximo partido se elige por fecha aunque una jornada anterior esté aplazada', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-10T10:00:00Z'));
  await simularLiga(page);
  await page.goto('/');
  await page.locator('#entrar-sin-sonido').click();

  const proximoA = page.locator('#proximos .proximo').first();
  await expect(proximoA).toContainText('RIVAL TRES');
  await expect(proximoA).toContainText('Último: victoria 60–42');
  await expect(page.locator('#partidos .partido--proximo')).toContainText('RIVAL TRES');
});
