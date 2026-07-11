export const folderRouteParam = 'folder'

export function readFolderRoute(search = browserSearch()): string | null {
  return decodeFolderRouteValue(new URLSearchParams(search).get(folderRouteParam))
}

export function buildFolderRoutePath(folderId: string | null, href = browserHref()): string {
  const url = new URL(href, 'http://localhost/')
  const routeValue = encodeFolderRouteValue(folderId)
  if (routeValue) url.searchParams.set(folderRouteParam, routeValue)
  else url.searchParams.delete(folderRouteParam)
  return `${url.pathname}${url.search}${url.hash}`
}

export function replaceFolderRoute(folderId: string | null): void {
  const locationValue = browserLocation()
  const historyValue = globalThis.history
  if (!locationValue || !historyValue) return
  const nextPath = buildFolderRoutePath(folderId, locationValue.href)
  const currentPath = `${locationValue.pathname}${locationValue.search}${locationValue.hash}`
  if (nextPath !== currentPath) historyValue.replaceState(null, document.title, nextPath)
}

export function removeFolderRouteFromUrl(href: string): string {
  const url = new URL(href, 'http://localhost/')
  url.searchParams.delete(folderRouteParam)
  return url.toString()
}

function encodeFolderRouteValue(folderId: string | null): string | null {
  const normalizedFolderId = folderId?.trim()
  if (!normalizedFolderId) return null
  const unprefixed = normalizedFolderId.replace(/^folder-/, '')
  return isUuid(unprefixed) ? unprefixed : normalizedFolderId
}

function decodeFolderRouteValue(value: string | null): string | null {
  const routeValue = value?.trim()
  if (!routeValue) return null
  if (routeValue.startsWith('folder-')) return routeValue
  return isUuid(routeValue) ? `folder-${routeValue}` : routeValue
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function browserHref(): string {
  return browserLocation()?.href ?? 'http://localhost/'
}

function browserSearch(): string {
  return browserLocation()?.search ?? ''
}

function browserLocation(): Location | undefined {
  return typeof globalThis.location === 'undefined' ? undefined : globalThis.location
}
