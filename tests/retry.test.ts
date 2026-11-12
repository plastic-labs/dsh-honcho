import { describe, expect, test } from "bun:test"
import { isTransientError, withRetry } from "../src/retry"

describe("isTransientError", () => {
  test("TypeError is transient", () => {
    expect(isTransientError(new TypeError("fetch failed"))).toBe(true)
  })

  test("ECONNREFUSED is transient", () => {
    expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:80"))).toBe(true)
  })

  test("HTTP error with status is not transient", () => {
    const err = Object.assign(new Error("network unavailable"), { status: 503 })
    expect(isTransientError(err)).toBe(false)
  })

  test("ConnectionError is not transient (SDK already retried)", () => {
    class ConnectionError extends Error {}
    expect(isTransientError(new ConnectionError("fetch failed"))).toBe(false)
  })

  test("HTTP 404 without status property is not transient by message", () => {
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
    const fn = async () => {
      calls++
      throw new Error("HTTP 500")
    }
    await expect(withRetry(fn, "test", () => {})).rejects.toThrow("HTTP 500")
    expect(calls).toBe(1)
  })

  test("gives up after max retries", async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new TypeError("fetch failed")
    }
    await expect(withRetry(fn, "test", () => {})).rejects.toThrow("fetch failed")
    expect(calls).toBe(3)
  })
})
