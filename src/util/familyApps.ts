// The tik-choco app family is deployed as sibling paths on one origin
// (https://tik-choco.github.io/<app>/ in production, http://localhost:8080/<app>/
// behind dev-proxy), so another app's URL resolves relative to this app's base.

export function familyAppUrl(
  app: string,
  baseUrl: string = import.meta.env.BASE_URL,
  origin: string = location.origin,
): string {
  return new URL(`../${app}/`, new URL(baseUrl, origin)).toString()
}
