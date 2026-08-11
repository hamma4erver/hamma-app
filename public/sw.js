const CACHE_NAME = 'hamma-chat-v1';
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/favicon.png',
    '/badge.png',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .catch(() => { /* offline shell caching is a nice-to-have, never block install */ })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

// This is a live chat app, so we always prefer fresh content from the network.
// The cache is only a fallback for when the connection drops (e.g. so the app
// shell still opens instead of a blank "no internet" page).
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    // Never intercept the live socket.io connection
    if (event.request.url.includes('/socket.io/')) return;

    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
