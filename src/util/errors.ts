export function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') {
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== '{}') return serialized
    } catch {
      // Fall through to the caller's fallback message.
    }
  }
  return fallback
}
