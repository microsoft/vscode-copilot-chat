const CACHE_NAME = 'copilot-sidecar-v2';
const STATIC_ASSETS = [
	'./',
	'./index.html',
	'./manifest.json',
	'./css/style.css',
	'./js/app.js',
	'./js/ws-client.js',
	'./js/chat-renderer.js',
	'./js/qr-scanner.js',
	'./icons/copilot.png',
];

self.addEventListener('install', event => {
	event.waitUntil(
		caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
	);
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil(
		caches.keys().then(keys => Promise.all(
			keys
				.filter(key => key !== CACHE_NAME)
				.map(key => caches.delete(key))
		))
	);
	self.clients.claim();
});

self.addEventListener('fetch', event => {
	if (event.request.method !== 'GET') {
		return;
	}

	const requestUrl = new URL(event.request.url);
	if (requestUrl.origin !== self.location.origin) {
		return;
	}

	event.respondWith(
		caches.match(event.request).then(cached => {
			if (cached) {
				return cached;
			}

			return fetch(event.request).then(response => {
				if (!response || response.status !== 200 || response.type !== 'basic') {
					return response;
				}

				const cloned = response.clone();
				caches.open(CACHE_NAME).then(cache => {
					cache.put(event.request, cloned);
				});
				return response;
			});
		})
	);
});
