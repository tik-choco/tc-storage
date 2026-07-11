const debugLogsEnabled =
  typeof import.meta.env !== 'undefined' &&
  (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEBUG_LOGS === 'true')

export function debugInfo(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!debugLogsEnabled) return
  console.info(`[tc-storage:${scope}]`, message, details ?? '')
}

export function debugWarn(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!debugLogsEnabled) return
  console.warn(`[tc-storage:${scope}]`, message, details ?? '')
}
