const RETRY_DELAYS_MS = [500, 1000]

const TRANSIENT_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
]

export function isTransientError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const err = error as Record<string, unknown>
  if (typeof err?.status === "number") return false
  if (err?.constructor?.name === "ConnectionError") return false
  const msg = error instanceof Error ? error.message : String(error)
  return TRANSIENT_PATTERNS.some((p) => p.test(msg))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  log: (msg: string) => void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (attempt < RETRY_DELAYS_MS.length && isTransientError(e)) {
        const delay = RETRY_DELAYS_MS[attempt]
        log(`${label}: attempt ${attempt + 1} failed, retrying in ${delay}ms`)
        await new Promise((r) => setTimeout(r, delay))
      } else {
        throw e
      }
    }
  }
  throw lastError
}
