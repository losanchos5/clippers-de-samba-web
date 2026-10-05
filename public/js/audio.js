// Pantalla de entrada + música. Los navegadores solo dejan sonar audio tras un
// gesto del usuario, así que el clic en «Entrar» es el que arranca la canción.
// El fundido usa audio.volume; en iOS es de solo lectura y simplemente no hay fundido.

const FUNDIDO_ENTRADA_MS = 1400;
const FUNDIDO_SALIDA_MS = 350;

export function iniciarAudio() {
  const audio = document.getElementById('musica');
  const entrada = document.getElementById('entrada');
  const boton = document.getElementById('boton-sonido');
  const conSonido = document.getElementById('entrar-con-sonido');
  const sinSonido = document.getElementById('entrar-sin-sonido');
  const contenido = document.getElementById('contenido');
  const fondo = [document.querySelector('.saltar'), document.getElementById('cabecera'), contenido, document.querySelector('.pie'), boton];

  let quiereSonido = false;
  let pausadoPorOcultar = false;
  let pausaPropia = false; // la pausa la hace la página (al ocultarse), no el usuario
  let fundidoActual = 0;

  fondo.forEach((el) => { if (el) el.inert = true; });
  document.documentElement.classList.add('con-entrada');
  conSonido.focus({ preventScroll: true });

  // El MP3 pesa ~4 MB: se empieza a descargar cuando la página ya ha cargado,
  // para que no compita con el logo y las fuentes. Si se pulsa antes, play() lo pide igual.
  const precargar = () => {
    const entroSinSonido = entrada.classList.contains('entrando') && !quiereSonido;
    if (entroSinSonido || navigator.connection?.saveData) return;
    if (audio.paused && audio.currentTime === 0 && !quiereSonido) {
      audio.preload = 'auto';
      audio.load();
    }
  };
  const alCargar = () => ('requestIdleCallback' in window ? requestIdleCallback(precargar, { timeout: 2000 }) : setTimeout(precargar, 500));
  if (document.readyState === 'complete') alCargar();
  else window.addEventListener('load', alCargar, { once: true });

  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Mas Que Nada',
      artist: 'Sérgio Mendes',
      album: 'Clippers de Samba',
      artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }

  function marcar(sonando) {
    boton.setAttribute('aria-pressed', String(sonando));
    boton.setAttribute('aria-label', sonando ? 'Silenciar música' : 'Activar música');
  }

  function fundido(hasta, ms) {
    const id = ++fundidoActual;
    const desde = audio.volume;
    const inicio = performance.now();
    return new Promise((resolver) => {
      function paso(ahora) {
        if (id !== fundidoActual) return resolver(false);
        // El timestamp de rAF puede ser algo anterior a performance.now(): se acota t.
        const t = Math.min(1, Math.max(0, (ahora - inicio) / ms));
        audio.volume = Math.min(1, Math.max(0, desde + (hasta - desde) * t));
        if (t < 1) requestAnimationFrame(paso);
        else resolver(true);
      }
      requestAnimationFrame(paso);
    });
  }

  async function sonar() {
    quiereSonido = true;
    audio.volume = 0;
    try {
      await audio.play();
      marcar(true);
      fundido(1, FUNDIDO_ENTRADA_MS);
    } catch {
      quiereSonido = false;
      audio.volume = 1;
      marcar(false);
    }
  }

  async function callar() {
    quiereSonido = false;
    marcar(false);
    const completo = await fundido(0, FUNDIDO_SALIDA_MS);
    if (completo && !quiereSonido) audio.pause();
  }

  const DURACION_BALON_MS = 620;

  // El balón sale del centro del botón pulsado y escala hasta cubrir la esquina más lejana.
  function cerrarEntrada(origen = conSonido) {
    if (entrada.classList.contains('entrando')) return;
    const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = origen.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radio = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    entrada.style.setProperty('--x', `${x}px`);
    entrada.style.setProperty('--y', `${y}px`);
    entrada.style.setProperty('--escala', String(((radio * 2) / 96) * 1.08));
    entrada.classList.add('entrando');

    document.body.classList.remove('bloqueado');
    fondo.forEach((el) => { if (el) el.inert = false; });
    contenido.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('clippers:entrada'));

    setTimeout(() => {
      entrada.classList.add('oculta');
      document.documentElement.classList.add('entrado');
      const esconder = () => { entrada.hidden = true; };
      entrada.addEventListener('transitionend', (e) => { if (e.target === entrada) esconder(); });
      setTimeout(esconder, 900);
    }, reducido ? 0 : DURACION_BALON_MS);
  }

  conSonido.addEventListener('click', () => { sonar(); cerrarEntrada(conSonido); });
  sinSonido.addEventListener('click', () => cerrarEntrada(sinSonido));
  entrada.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarEntrada(sinSonido); });
  boton.addEventListener('click', () => (quiereSonido ? callar() : sonar()));

  // Cualquier pausa que no haga la propia página (pantalla de bloqueo, auriculares,
  // una llamada...) cuenta como decisión del usuario y no se reanuda sola.
  audio.addEventListener('pause', () => {
    if (pausaPropia) { pausaPropia = false; return; }
    pausadoPorOcultar = false;
    if (quiereSonido) { quiereSonido = false; marcar(false); }
  });
  audio.addEventListener('play', () => { quiereSonido = true; marcar(true); });

  // Al cambiar de app o pestaña se pausa, y al volver sigue donde iba.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !audio.paused) {
      pausadoPorOcultar = true;
      pausaPropia = true;
      audio.pause();
    } else if (!document.hidden && pausadoPorOcultar) {
      pausadoPorOcultar = false;
      if (quiereSonido) audio.play().catch(() => marcar(false));
    }
  });
}
