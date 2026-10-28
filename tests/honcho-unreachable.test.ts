/**
 * An unreachable Honcho must cost a turn its memory, never the turn itself.
 *
 * `await client()` written as a later `Promise.all` element throws while the
 * array is still being built, orphaning the rejection of an earlier element.
 * That surfaces as an unhandled rejection, which dsh reports as
 * "fatal load failure" and exits 1. So this asserts on the process-level event,
 * not just on what the plugin's own catch paths logged.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../src/index.ts";

function stubContext() {
  const handlers = new Map<string, Function[]>();
  const tools: { name: string; execute: Function }[] = [];
  const ctx = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    inject() {},
    effect() {},
    get: () => undefined,
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    tools: { register: (tool: { name: string; execute: Function }) => tools.push(tool) },
  };
  const fire = (name: string, ...args: unknown[]) =>
    Promise.all((handlers.get(name) ?? []).map((handler) => handler(...args)));
  const call = (name: string, args: Record<string, unknown>) =>
    tools.find((tool) => tool.name === name)!.execute(args, {
      agent: { session: { id: "session-1", header: { cwd: "/tmp/project" } } },
    });
  return { ctx, fire, call };
}

test("a refused connection never escapes as an unhandled rejection", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "dsh-honcho-down-")), "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ peerName: "abigail", auth: { apiKey: "test-key" }, injection: { perTurn: ["userContext", "dialectic"] } }),
  );

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  try {
    const { ctx, fire, call } = stubContext();
    apply(ctx as never, { configPath });

    // Turn 1 runs memory fetch and the background dialectic against a dead Honcho.
    await fire(
      "agent/pre-step",
      { agent: { session: { id: "session-1", header: { cwd: "/tmp/project" } } }, messages: [], step: 1 },
      async () => ({ kind: "enter", messages: [] }),
    );
    // The model-callable tools that share the same call shape. They report the
    // failure as text; they must not throw and must not orphan a rejection.
    await call("honcho_chat", { query: "what do I like?" });
    await call("honcho_remember", { content: "prefers tabs" });
    await call("honcho_search", { query: "tabs" });

    // Orphaned rejections are reported on a later tick, after the awaits above.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(unhandled).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
    process.off("unhandledRejection", onUnhandled);
  }
});
