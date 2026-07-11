function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export function registerServiceWorker(): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) {
    return
  }

  const baseUrl = normalizeBaseUrl(import.meta.env.BASE_URL)
  const serviceWorkerUrl = `${baseUrl}sw.js`

  window.addEventListener('load', () => {
    navigator.serviceWorker.register(serviceWorkerUrl, { scope: baseUrl }).catch(() => {
      // Registration failures should not block the storage app itself.
    })
  })
}
