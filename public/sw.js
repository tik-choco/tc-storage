const CACHE_PREFIX = 'tc-storage'
const CACHE_VERSION = 'v1'
const APP_SHELL_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}-app-shell`
const STATIC_CACHE = `${CACHE_PREFIX}-${CACHE_VERSION}-static`
const CURRENT_CACHES = [APP_SHELL_CACHE, STATIC_CACHE]

const APP_SHELL_URLS = [
  './',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-icon-192.png',
  './icons/maskable-icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './'))
    return
  }

  if (isStaticAssetRequest(request, url)) {
    event.respondWith(cacheFirst(request))
  }
})

function isStaticAssetRequest(request, url) {
  if (['font', 'image', 'script', 'style', 'worker'].includes(request.destination)) {
    return true
  }

  const scopePath = new URL(self.registration.scope).pathname
  const staticPaths = [
    `${scopePath}assets/`,
    `${scopePath}icons/`,
    `${scopePath}favicon.svg`,
    `${scopePath}manifest.webmanifest`,
  ]

  return staticPaths.some((path) => url.pathname.startsWith(path))
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE)
    await cache.put(request, response.clone())
  }

  return response
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) return cached

    const fallback = await caches.match(fallbackUrl)
    if (fallback) return fallback

    throw error
  }
}
