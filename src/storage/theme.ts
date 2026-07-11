// Theme preference — light/dark, stored in localStorage and applied as a
// `data-theme` attribute on the document root so src/styles/tokens.css can
// swap CSS custom properties. Defensive try/catch mirrors onboarding.ts.

const themeKey = 'tc-storage-theme-v1'

export type ThemePreference = 'light' | 'dark'

export function loadThemePreference(): ThemePreference {
  try {
    return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light'
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
  document.documentElement.setAttribute('data-theme', preference)
}
