// Datos generales del club. Es el único fichero que hay que tocar para cambiar
// enlaces y contacto. Los campos vacíos ('') ocultan su botón en la web.
export const CONFIG = {
  temporada: '26/27',

  // Usuario de Instagram sin la @. Ojo: confirmar que está libre al crear la cuenta.
  instagram: 'clippersdesamba',

  // Contacto opcional. WhatsApp con prefijo y sin espacios, p. ej. '34600111222'.
  whatsapp: '',
  email: '',

  liga: {
    nombre: 'Liga Senior Quirónsalud',
    web: 'https://www.alqueriadelbasket.com/?r=torneoscantera/ContenidoTorneo&id=16&idioma=cas',
    // App Swish de NBN23, donde la liga publica actas y estadísticas. En el móvil
    // abre la app; en el ordenador muestra los enlaces de descarga.
    app: 'https://nbn23.com/swish-deeplink/?projectKey=alqueriabasket&competitionFid=1342549',
  },

  sede: {
    nombre: "L'Alqueria del Basket",
    mapa: "https://www.google.com/maps/search/?api=1&query=L'Alqueria+del+Basket+Valencia",
  },

  // De dónde se leen los datos, por orden. /api/calendario lo sirve el Worker con
  // datos en vivo de la liga; si falla, se usa la copia estática del último deploy.
  fuentes: {
    calendario: ['/api/calendario', '/datos/partidos.json'],
    equipos: ['/datos/equipos.json'],
    // Puntos, tiros y faltas por jugador, sacados de las actas (scripts/estadisticas.py)
    estadisticas: ['/datos/estadisticas.json'],
  },
};
