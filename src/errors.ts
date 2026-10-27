/**
 * Readable text for a thrown value.
 *
 * `@honcho-ai/sdk` does not always throw an `Error`: a failed request can
 * surface a plain response object, or an array of them. `String(value)` renders
 * both as `[object Object]`, discarding the only diagnostic the failure has.
 */

import { inspect } from "node:util";

/**
 * @param error - any thrown value.
 * @returns the message of an `Error`, JSON for structured data, and an inspected form otherwise.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const json = JSON.stringify(error);
    // `{}` carries nothing; fall through to inspect, which at least shows the shape.
    if (json && json !== "{}") return json;
  } catch {
    // Circular or otherwise unserializable: inspect handles both.
  }
  return inspect(error, { depth: 2, breakLength: Infinity });
}
