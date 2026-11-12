import { describe, expect, test } from "bun:test"
import { isTransientError, withRetry } from "../src/retry"

describe("isTransientError", () => {
  test("TypeError is transient", () => {
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true)
  })

  test("ECONNREFUSED is transient", () => {
    expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:80"))).toBe(true)
  })

  test("404 is not transient", () => {
    expect(isTransientError(new Error("HTTP 404"))).toBe(false)
  })
})

describe("withRetry", () => {
  test("returns on first success", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      return "ok"
    }, "test", () => {})
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries on transient error then succeeds", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      if (calls < 2) throw new TypeError("fetch failed")
      return "recovered"
    }, "test", () => {})
    expect(result).toBe("recovered")
    expect(calls).toBe(2)
  })

  test("throws immediately on non-transient error", async () => {
    let calls = 0
    try {
      await withRetry(async () => {
        calls++
        throw new Error("HTTP 500")
      }, "test", () => {})
      expect.unreachable()
    } catch (e) {
      expect(calls).toBe(1)
    }
  })

  test("gives up after max retries", async () => {
    let calls = 0
    try {
      await withRetry(async () => {
        calls++
        throw new TypeError("fetch failed")
      }, "test", () => {})
      expect.unreachable()
    } catch {
      expect(calls).toBe(3)
    }
  })
})
