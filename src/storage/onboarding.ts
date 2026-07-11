// First-run onboarding state — a single "completed" flag in localStorage plus
// a tiny same-tab request channel so other views (e.g. settings) can ask the
// app shell to re-open the wizard.

const onboardingDoneKey = 'tc-storage-onboarding-done-v1'

/** The localSnapshot.ts storage key, read directly (not imported) to avoid pulling in a heavy dependency here. */
const snapshotKey = 'tc-storage-snapshot-v1'

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(onboardingDoneKey) === '1'
  } catch {
    // Storage unavailable — treat as done so the wizard can't loop forever.
    return true
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(onboardingDoneKey, '1')
  } catch {
    // Non-fatal; worst case the wizard shows again next launch.
  }
}

/**
 * Whether the wizard should open on launch: only on a genuinely fresh
 * install. An existing install (a stored snapshot with files already
 * present but no flag — i.e. a user from before onboarding shipped) is
 * marked done silently so they're never interrupted.
 */
export function shouldShowOnboarding(): boolean {
  if (isOnboardingDone()) return false
  if (hasExistingSnapshotFiles()) {
    markOnboardingDone()
    return false
  }
  return true
}

function hasExistingSnapshotFiles(): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(snapshotKey) ?? '') as { files?: unknown }
    return Array.isArray(parsed.files) && parsed.files.length > 0
  } catch {
    return false
  }
}

// --- Re-open requests (e.g. settings screen -> app shell) -------------------

const listeners = new Set<() => void>()

/** App shell subscribes once; returns an unsubscribe fn. */
export function subscribeOnboardingRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Asks the app shell to open the onboarding wizard (e.g. from settings). */
export function requestOnboarding(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('onboarding: listener threw', error)
    }
  }
}
