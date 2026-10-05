// Balón 3D de la hero (three.js en local). La textura se genera en un canvas:
// cuero con grano y las costuras de un balón de 8 paneles (ecuador, meridiano y
// dos lazos laterales). Se puede arrastrar y acelera con el scroll.
// Sin WebGL se queda el SVG de respaldo que hay en el HTML.

const VELOCIDAD_BASE = 0.55; // rad/s alrededor del eje inclinado
const INCLINACION = 0.38;    // rad, inclinación del eje de giro

export async function iniciarBalon() {
  const contenedor = document.getElementById('balon');
  if (!contenedor || !soportaWebGL()) return;

  let THREE;
  try {
    THREE = await import('/vendor/three.module.min.js');
  } catch {
    return;
  }

  const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camara.position.set(0, 0, 5.2);

  const { mapa, relieve } = crearTexturas(THREE, window.innerWidth < 700 ? 512 : 1024);
  mapa.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const bola = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.MeshStandardMaterial({ map: mapa, bumpMap: relieve, bumpScale: 1.4, roughness: 0.68, metalness: 0 }),
  );
  bola.rotation.set(0.2, -0.6, 0);
  escena.add(bola);

  escena.add(new THREE.HemisphereLight(0xfff1e2, 0x06301a, 1.1));
  const principal = new THREE.DirectionalLight(0xffffff, 2.6);
  principal.position.set(-3, 3.5, 4);
  escena.add(principal);
  const borde = new THREE.DirectionalLight(0x6dffa8, 3.2);
  borde.position.set(3.5, -1.5, -2.5);
  escena.add(borde);
  const relleno = new THREE.DirectionalLight(0xffd2a8, 0.6);
  relleno.position.set(2, -2, 3);
  escena.add(relleno);

  // --- Movimiento ---
  const ejeGiro = new THREE.Vector3(Math.sin(INCLINACION), Math.cos(INCLINACION), 0).normalize();
  const ejeX = new THREE.Vector3(1, 0, 0);
  const ejeY = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const base = reducido ? 0 : VELOCIDAD_BASE;
  let velGiro = base;   // alrededor de ejeGiro
  let velX = 0;         // alrededor del eje X (arrastre vertical)
  let impulsoScroll = 0;

  function rotar(eje, angulo) {
    q.setFromAxisAngle(eje, angulo);
    bola.quaternion.premultiply(q);
  }

  let arrastrando = false;
  let ultimo = null;
  contenedor.addEventListener('pointerdown', (e) => {
    arrastrando = true;
    ultimo = { x: e.clientX, y: e.clientY, t: performance.now() };
    contenedor.setPointerCapture(e.pointerId);
    despertar();
  });
  contenedor.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    const ahora = performance.now();
    const dt = Math.max(8, ahora - ultimo.t) / 1000;
    const dx = (e.clientX - ultimo.x) * 0.012;
    const dy = (e.clientY - ultimo.y) * 0.012;
    rotar(ejeY, dx);
    rotar(ejeX, dy);
    velGiro = dx / dt;
    velX = dy / dt;
    ultimo = { x: e.clientX, y: e.clientY, t: ahora };
  });
  const soltar = () => { arrastrando = false; };
  contenedor.addEventListener('pointerup', soltar);
  contenedor.addEventListener('pointercancel', soltar);

  let scrollPrevio = window.scrollY;
  window.addEventListener('scroll', () => {
    const delta = Math.abs(window.scrollY - scrollPrevio);
    scrollPrevio = window.scrollY;
    if (!reducido) impulsoScroll = Math.min(9, impulsoScroll + delta * 0.03);
  }, { passive: true });

  // --- Tamaño ---
  function ajustar() {
    const lado = Math.round(renderer.domElement.clientWidth || contenedor.clientWidth * 1.24);
    renderer.setSize(lado, lado, false);
    camara.aspect = 1;
    camara.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(ajustar).observe(contenedor);

  // --- Bucle: solo corre si el balón está en pantalla y la pestaña visible ---
  let visible = true;
  let corriendo = false;
  let previo = 0;
  new IntersectionObserver(([entrada]) => {
    visible = entrada.isIntersecting;
    despertar();
  }).observe(contenedor);
  document.addEventListener('visibilitychange', despertar);

  function render() { renderer.render(escena, camara); }

  function despertar() {
    if (corriendo || !visible || document.hidden) return;
    corriendo = true;
    previo = performance.now();
    requestAnimationFrame(cuadro);
  }

  function cuadro(ahora) {
    if (!visible || document.hidden) { corriendo = false; return; }
    const dt = Math.min(0.05, (ahora - previo) / 1000);
    previo = ahora;

    if (!arrastrando) {
      const k = 1 - Math.exp(-dt * 1.6);
      velGiro += (base + impulsoScroll - velGiro) * k;
      velX += (0 - velX) * (1 - Math.exp(-dt * 2.2));
      impulsoScroll *= Math.exp(-dt * 2.5);
      rotar(ejeGiro, velGiro * dt);
      rotar(ejeX, velX * dt);
    }
    render();

    const quieto = !arrastrando && Math.abs(velGiro) + Math.abs(velX) + impulsoScroll < 0.002;
    if (reducido && quieto) { corriendo = false; return; }
    requestAnimationFrame(cuadro);
  }

  contenedor.prepend(renderer.domElement);
  contenedor.classList.add('balon--3d');
  ajustar();
  despertar();
}

function soportaWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Textura equirectangular: para cada píxel se calcula su punto en la esfera y la
// distancia angular a la costura más cercana.
function crearTexturas(THREE, ancho) {
  const W = ancho;
  const H = ancho / 2;
  const color = document.createElement('canvas');
  const alto = document.createElement('canvas');
  color.width = alto.width = W;
  color.height = alto.height = H;
  const cctx = color.getContext('2d');
  const actx = alto.getContext('2d');
  const img = cctx.createImageData(W, H);
  const rel = actx.createImageData(W, H);

  const COSTURA = 0.026;            // semiancho de la costura (rad)
  const SUAVE = (Math.PI * 2) / W;  // antialias de un píxel
  const CUERO = [226, 112, 38];
  const HILO = [24, 16, 11];

  for (let j = 0; j < H; j++) {
    const theta = ((j + 0.5) / H) * Math.PI;
    const st = Math.sin(theta);
    const y = Math.cos(theta);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W) * Math.PI * 2;
      const x = -Math.cos(phi) * st;
      const z = Math.sin(phi) * st;

      const dEcuador = Math.abs(Math.asin(y));
      const dMeridiano = Math.abs(Math.asin(x));
      const alfa = Math.acos(Math.min(1, Math.abs(x)));
      const psi = Math.atan2(z, y);
      const dLazo = Math.abs(alfa - (0.95 + 0.2 * Math.cos(2 * psi)));
      const d = Math.min(dEcuador, dMeridiano, dLazo);

      // 1 en el centro de la costura, 0 en el cuero
      const enCostura = 1 - suavizar(COSTURA - SUAVE, COSTURA + SUAVE, d);
      // borde del surco un poco oscurecido
      const sombraBorde = 1 - 0.18 * (1 - suavizar(COSTURA, COSTURA * 2.4, d));

      const g = grano(i, j);
      const brillo = (0.93 + 0.11 * g) * sombraBorde;
      const k = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[k + c] = CUERO[c] * brillo * (1 - enCostura) + HILO[c] * enCostura;
      }
      img.data[k + 3] = 255;

      const h = (0.62 + 0.32 * g) * (1 - enCostura) * (0.75 + 0.25 * suavizar(COSTURA, COSTURA * 2.4, d));
      rel.data[k] = rel.data[k + 1] = rel.data[k + 2] = h * 255;
      rel.data[k + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);
  actx.putImageData(rel, 0, 0);

  const mapa = new THREE.CanvasTexture(color);
  mapa.colorSpace = THREE.SRGBColorSpace;
  const relieve = new THREE.CanvasTexture(alto);
  return { mapa, relieve };
}

function suavizar(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Grano de cuero: puntitos de 2×2 px con ruido determinista.
function grano(i, j) {
  const a = Math.floor(i / 2);
  const b = Math.floor(j / 2);
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
