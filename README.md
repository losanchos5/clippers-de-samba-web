# Web de Clippers de Samba

Web del club de baloncesto **Clippers de Samba** (Valencia). El club tiene dos equipos en la Liga
Senior Quirónsalud de L'Alqueria del Basket: **A en Tercera** y **B en Quinta**. Es una página única
estática servida por un Worker de Cloudflare, sin framework ni build.

- Pantalla de entrada con «Entrar 🔊». Al pulsar suena *Mas Que Nada* desde 0:21. Los navegadores
  no dejan sonar audio sin un gesto del usuario, por eso existe esa pantalla.
- Balón 3D en la hero (three.js en local). Se puede arrastrar y acelera con el scroll.
- **Calendario, resultados y clasificación en vivo** desde la API pública de la liga, en
  `/api/calendario`, con 10 min de caché en Cloudflare.
- **La liga:** todos los partidos de Tercera y Quinta por jornada, con escudos, y la clasificación
  completa, en `/api/liga`. Se carga al llegar a la sección.
- **Estadísticas** sacadas de las actas oficiales en PDF:
  - por jugador: puntos, puntos por partido, máximo, % del equipo, triples, canastas de 2, tiros libres,
    faltas, titularidades y puntos por cuarto;
  - por equipo: tanteo por cuartos y tiros libres anotados/intentados;
  - partido a partido.
  Las actas no recogen minutos, rebotes, asistencias ni +/-; no hay fotos de jugadores públicas.
- Mobile-first, sin cookies y sin peticiones a terceros desde el navegador. CSP estricta en
  `public/_headers`.

## Requisitos

- Node 18 o superior (`npm install` instala wrangler y Playwright).
- Python 3 con PyMuPDF para las estadísticas: `pip install -r requirements.txt`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Web en local con el Worker: http://localhost:8787 |
| `npm run datos` | Actualiza el respaldo del calendario y las estadísticas, y valida los JSON |
| `npm run deploy` | `datos` y luego publica en Cloudflare |
| `npm test` | Tests unitarios (JS y Python) + smoke e2e (móvil y escritorio) |
| `npm run validar` | Solo valida `public/datos/*.json` |

## Qué editar

| Quiero cambiar… | Fichero |
|---|---|
| Instagram, WhatsApp, email, enlaces | `public/js/config.js` |
| Nombres, dorsales y posiciones de los jugadores | `public/datos/equipos.json` |
| Texto del club, secciones | `public/index.html` |
| Colores y tipografías | `public/css/styles.css` (tokens en `:root`) |

`equipos.json` es la fuente de los **nombres**. Las estadísticas se cruzan por **dorsal**. Si en un
acta aparece un dorsal que no está en `equipos.json`, `npm run datos` avisa. Después de editarlo,
ejecuta `npm run validar`.

## De dónde salen los datos

- **Calendario y clasificación:** API del widget de NBN23 (`api.swish.nbn23.com`), la misma que usa
  la web de L'Alqueria. El Worker la consulta, la normaliza (`src/swish.js`) y la cachea. Si falla,
  la web usa `public/datos/partidos.json`, que se regenera en cada deploy. La API no trae la pista ni
  los puntos de clasificación; por eso la tabla muestra PJ, G, P y diferencia de puntos.
- **Estadísticas por jugador:** `scripts/estadisticas.py` lee la API pública de Leverade, descarga
  las actas en PDF (caché en `.cache/actas/`) y suma los puntos y tiros de cada dorsal. Un partido
  solo cuenta si la suma cuadra con el marcador final. Hay que volver a ejecutarlo tras cada
  jornada; `npm run deploy` lo hace solo.
- **Todos los partidos de la liga:** misma API, servidos en `/api/liga`. Respaldo en
  `public/datos/liga.json`.
- **Escudos de los rivales:** se sirven a través de `/api/logo/…` (proxy con caché de 7 días).

**Nueva temporada:** `node scripts/calendario.mjs --descubrir` lista los grupos de la competición.
Con eso se actualizan `GRUPOS` en `src/swish.js` y los IDs al principio de `scripts/estadisticas.py`.

## Publicar en Cloudflare

La web está en **https://clippersdesamba.com**. El dominio es de Cloudflare Registrar y está
configurado como *Custom Domain* del Worker en `routes` de `wrangler.jsonc`. `www.` y
`*.workers.dev` redirigen al dominio principal.

- Lo normal es no desplegar a mano: el GitHub Action publica con cada push a `main` (ver más abajo).
- Para desplegar desde tu PC: `npx wrangler login`, una vez, y luego `npm run deploy`.

## Actualización automática

- **Calendario, resultados y clasificación:** se actualizan solos y en vivo, a través de
  `/api/calendario` con 10 min de caché.
- **Estadísticas de jugadores:** el GitHub Action `.github/workflows/actualizar.yml` regenera los
  datos y vuelve a publicar la web. Se ejecuta todos los días por la mañana, los sábados y domingos
  por la noche y con cada `push` a `main`. También se puede lanzar a mano desde *Actions → Actualizar
  datos y publicar → Run workflow*.
- Secretos del repo: `CLOUDFLARE_API_TOKEN` (token de cuenta con permiso de Workers) y
  `CLOUDFLARE_ACCOUNT_ID`. Para cambiar el token: `gh secret set CLOUDFLARE_API_TOKEN`.
- Si editas `public/datos/equipos.json` desde la web de GitHub y guardas, la web se vuelve a
  publicar sola.

## Instagram

El usuario está en `public/js/config.js` (`instagram`). Ahora es `clippersdesamba`: confirma que está
libre al crear la cuenta. En la bio de Instagram pon el enlace a la web.

## Avisos

- **Música:** *Mas Que Nada* (Sérgio Mendes) tiene derechos de autor. Publicarla sin licencia es
  responsabilidad del club. Para quitarla, borra `public/assets/audio/mas-que-nada.mp3` y el
  `<audio>` de `index.html`.
- **Datos personales:** los nombres de los jugadores salen de las actas públicas de la liga, pero
  publicarlos en la web del club requiere su consentimiento (RGPD). Revisa `equipos.json` antes de
  publicar. Algunos nombres vienen cortados en el acta («Peñalver Sebast», «González Tárreg»).
- **Logos del kit de diseño:** los SVG y EPS de `Clippers_de_Samba/logos/` vienen **volteados
  verticalmente** y el SVG del escudo es de baja calidad. La web usa una copia corregida. Revísalo
  antes de mandar esos ficheros a imprimir.
