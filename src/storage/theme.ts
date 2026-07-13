// Theme preference — light/dark/auto, stored in localStorage and applied as
// a `data-theme` attribute on the document root so src/styles/tokens.css can
// swap CSS custom properties. "auto" clears the attribute entirely so the
// `@media (prefers-color-scheme: dark)` block in tokens.css takes over and
// follows the OS setting (tc-travel two-stage dark mode model). Defensive
// try/catch mirrors onboarding.ts.
//
// Backward compatible: existing stored values of "light"/"dark" keep working
// exactly as before; only a stored "auto" (or an explicit user choice going
// forward) opts into OS-following. No stored value still defaults to "light".

const themeKey = 'tc-storage-theme-v1'

export type ThemePreference = 'light' | 'dark' | 'auto'

export function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeKey)
    return stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'light'
  } catch {
    return 'light'
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(themeKey, preference)
  } catch {
    // Non-fatal; worst case the preference doesn't persist across reloads.
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
}
