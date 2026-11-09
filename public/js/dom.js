// Helpers para crear nodos sin innerHTML: los nombres de equipos vienen de APIs externas.
export function h(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (valor == null || valor === false) continue;
    if (clave === 'class') nodo.className = valor;
    else if (clave === 'style') Object.entries(valor).forEach(([k, v]) => nodo.style.setProperty(k, v));
    else nodo.setAttribute(clave, valor === true ? '' : valor);
  }
  for (const hijo of hijos.flat()) {
    if (hijo == null || hijo === false) continue;
    nodo.append(hijo instanceof Node ? hijo : String(hijo));
  }
  return nodo;
}

export function svg(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElementNS('http://www.w3.org/2000/svg', etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) nodo.setAttribute(clave, valor);
  nodo.append(...hijos);
  return nodo;
}

// Prueba cada ruta en orden y devuelve el primer JSON que llegue; null si fallan todas.
export async function cargarJSON(rutas, tiempoMaxMs = 6000) {
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
