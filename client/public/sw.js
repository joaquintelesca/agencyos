// Service worker mínimo: solo con que exista y controle la página ya alcanza para que Chrome/
// Android ofrezcan "Instalar app". A propósito NO cachea nada — esta app es en tiempo real (chat,
// pagos, videos), cachear respuestas viejas podría mostrar datos desactualizados o una versión
// rota del bundle después de un deploy. Si en algún momento se pide soporte offline de verdad, ahí
// sí vale la pena una estrategia de cache real (network-first con fallback) — no antes.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // no intercepta nada — el navegador maneja la request normal
