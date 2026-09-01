import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  interpolateEnv,
  loadConfig,
  normalizeBaseUrl,
  sessionName,
  unsupportedComponents,
  unsupportedKeys,
  type ResolvedConfig,
} from "../src/core-shim.ts";

// HONCHO_API_KEY in the developer's own shell legitimately outranks the config
// file (env is the top of the RFC resolution ladder), so these tests must run
// without it or they assert the developer's environment instead of the code.
const SAVED_ENV = { ...process.env };
beforeEach(() => {
  for (const key of ["HONCHO_API_KEY", "HONCHO_BASE_URL", "HONCHO_PEER_NAME", "HONCHO_HOST", "HONCHO_CONFIG_DIR"]) {
    delete process.env[key];
  }
});
afterEach(() => {
  process.env = { ...SAVED_ENV };
});
import { isHarnessInjected, readCursor, selectMessages, summarizeTool, writeCursor } from "../src/capture.ts";
import { assembleByPriority, filterRepresentation, renderMemory, trimConclusions } from "../src/memory.ts";
import { redactSecrets } from "../src/redact.ts";

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-honcho-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("normalizeBaseUrl", () => {
  test("all documented spellings resolve identically, with no /v3 (the SDK adds it)", () => {
    const expected = "https://api.honcho.dev";
    for (const input of [
      "api.honcho.dev",
      "API.honcho.dev",
      "https://api.honcho.dev",
      "https://api.honcho.dev/",
      "https://api.honcho.dev/v3",
      "https://api.honcho.dev/v3/",
      "  https://API.honcho.dev/v3  ",
    ]) {
      expect(normalizeBaseUrl(input)).toBe(expected);
    }
  });

  test("localhost gets http, not https", () => {
    expect(normalizeBaseUrl("localhost:8000")).toBe("http://localhost:8000");
  });

  test("a path-prefixed proxy keeps its prefix and gains no /v3", () => {
    expect(normalizeBaseUrl("https://proxy.internal/honcho/v3")).toBe("https://proxy.internal/honcho");
  });

  test("garbage falls back to production rather than throwing", () => {
    expect(normalizeBaseUrl("http://")).toBe("https://api.honcho.dev");
  });
});

describe("interpolateEnv", () => {
  test("substitutes set variables and blanks unset ones", () => {
    process.env.DSH_HONCHO_TEST_KEY = "hch-secret";
    expect(interpolateEnv("${DSH_HONCHO_TEST_KEY}")).toBe("hch-secret");
    expect(interpolateEnv("${DSH_HONCHO_DEFINITELY_UNSET}")).toBe("");
    delete process.env.DSH_HONCHO_TEST_KEY;
  });
});

describe("loadConfig", () => {
  const base = {
    peerName: "vineeth",
    workspace: "honcho",
    auth: { apiKey: "root-key" },
    hosts: { dsh: { workspace: "dsh" } },
  };

  test("host block beats root; aiPeer defaults to the host name", () => {
    const config = loadConfig({ configPath: writeConfig(base), host: "dsh" });
    expect(config.workspace).toBe("dsh");
    expect(config.aiPeer).toBe("dsh");
    expect(config.peerName).toBe("vineeth");
    expect(config.apiKey).toBe("root-key");
  });

  test("coding bucket defaults observationMode to unified", () => {
    expect(loadConfig({ configPath: writeConfig(base), host: "dsh" }).observationMode).toBe("unified");
  });

  test("legacy root apiKey and endpoint are accepted (still legal at root)", () => {
    const path = writeConfig({ apiKey: "legacy-key", endpoint: { environment: "local" } });
    const config = loadConfig({ configPath: path, host: "dsh" });
    expect(config.apiKey).toBe("legacy-key");
    expect(config.baseUrl).toBe("http://localhost:8000");
  });

  test("a legacy behavioral key at root is ignored, not honored", () => {
    // saveMessages is illegal at root under the canonical shape.
    const path = writeConfig({ ...base, saveMessages: false });
    expect(loadConfig({ configPath: path, host: "dsh" }).capture.saveMessages).toBe(true);
  });

  test("an unknown sessionStrategy fails loudly rather than silently", () => {
    const path = writeConfig({ ...base, hosts: { dsh: { sessionStrategy: "per-tuesday" } } });
    expect(() => loadConfig({ configPath: path, host: "dsh" })).toThrow(/unknown sessionStrategy/);
  });

  test("a partial injection block does not wipe sibling defaults", () => {
    const path = writeConfig({ ...base, hosts: { dsh: { injection: { searchTopK: 3 } } } });
    const config = loadConfig({ configPath: path, host: "dsh" });
    expect(config.injection.searchTopK).toBe(3);
    expect(config.injection.maxConclusions).toBe(15);
    // A nested object would be replaced wholesale by a naive spread.
    expect(config.injection.cadence.ttlSeconds).toBe(300);
  });

  test("saveToolUse defaults off", () => {
    expect(loadConfig({ configPath: writeConfig(base), host: "dsh" }).capture.saveToolUse).toBe(false);
  });
});

describe("unsupportedComponents", () => {
  test("names the components this plugin ignores, with a reason", () => {
    const ignored = unsupportedComponents({
      sessionStart: ["directives", "summary", "briefing"],
      perTurn: ["userContext", "sessionContext"],
    } as ResolvedConfig["injection"]);
    expect(ignored.map(([n]) => n).sort()).toEqual(["briefing", "sessionContext"]);
    expect(ignored.every(([, reason]) => reason.length > 10)).toBe(true);
  });

  test("dialectic is implemented, so it is NOT reported as ignored", () => {
    const ignored = unsupportedComponents({
      sessionStart: ["directives"],
      perTurn: ["userContext", "dialectic"],
    } as ResolvedConfig["injection"]);
    expect(ignored).toEqual([]);
  });

  test("a key the schema defines but this plugin ignores is reported, not swallowed", () => {
    // `depth` and `cadence.userContext` were accepted-and-inert; they are gone
    // from the config type now, so a file that sets them must say so on load.
    const found = unsupportedKeys({
      injection: { dialectic: { depth: 5 }, cadence: { userContext: 1 }, showContents: [] },
      statusline: "full",
      globalOverride: true,
    });
    expect(found.map(([k]) => k).sort()).toEqual([
      "globalOverride",
      "injection.cadence.userContext",
      "injection.dialectic.depth",
      "injection.showContents",
      "statusline",
    ]);
    expect(found.every(([, reason]) => reason.length > 10)).toBe(true);
  });

  test("a clean host block reports nothing", () => {
    expect(unsupportedKeys({ workspace: "dsh", injection: { perTurn: ["userContext"] } })).toEqual([]);
    expect(unsupportedKeys(undefined)).toEqual([]);
  });

  test("a default config reports nothing ignored", () => {
    expect(unsupportedComponents({
      sessionStart: ["directives", "summary", "peerCard"],
      perTurn: ["userContext", "dialectic"],
    } as ResolvedConfig["injection"])).toEqual([]);
  });

  test("a missing config file yields defaults and no key, not a crash", () => {
    const config = loadConfig({ configPath: "/nonexistent/honcho/config.json", host: "dsh" });
    expect(config.apiKey).toBe("");
    expect(config.workspace).toBe("dsh");
  });
});

describe("sessionName", () => {
  const config = {
    peerName: "Vineeth",
    sessionPeerPrefix: true,
    sessionStrategy: "per-directory",
    sessions: {} as Record<string, string>,
  } as ResolvedConfig;

  test("claude-honcho convention: <peer>-<dir>, sanitized", () => {
    expect(sessionName(config, "/Users/v/workspace/Plastic Labs")).toBe("vineeth-plastic-labs");
  });

  test("an explicit sessions[cwd] override wins", () => {
    const pinned = { ...config, sessions: { "/repo": "pinned" } } as ResolvedConfig;
    expect(sessionName(pinned, "/repo")).toBe("pinned");
  });

  test("prefix can be turned off", () => {
    expect(sessionName({ ...config, sessionPeerPrefix: false } as ResolvedConfig, "/a/dedenne")).toBe("dedenne");
  });

  test("per-session keeps dsh's short ids distinct", () => {
    const perSession = { ...config, sessionStrategy: "per-session" } as ResolvedConfig;
    // dsh mints `session-<n>`; a fixed 8-char truncation would map every one of
    // these to the same Honcho session.
    expect(sessionName(perSession, "/a/dedenne", "session-1")).toBe("vineeth-chat-1");
    expect(sessionName(perSession, "/a/dedenne", "session-2")).toBe("vineeth-chat-2");
    expect(sessionName(perSession, "/a/dedenne", "session-17")).toBe("vineeth-chat-17");
  });

  test("per-session shortens a long opaque id", () => {
    const perSession = { ...config, sessionStrategy: "per-session" } as ResolvedConfig;
    const name = sessionName(perSession, "/a/dedenne", "0f8c2b1e-9a44-4d2e-b6f1-7c3a5e9d1b02");
    expect(name).toBe("vineeth-chat-0f8c2b1e-9a44-4d");
    expect(name.length).toBeLessThan(40);
  });

  test("per-session without an id falls back to the directory rather than inventing one", () => {
    const perSession = { ...config, sessionStrategy: "per-session" } as ResolvedConfig;
    expect(sessionName(perSession, "/a/dedenne")).toBe("vineeth-dedenne");
  });

  test("global collapses to the peer", () => {
    expect(sessionName({ ...config, sessionStrategy: "global" } as ResolvedConfig, "/a/dedenne")).toBe("vineeth");
  });

  test("git-branch outside a repo collapses to per-directory, not a placeholder", () => {
    const gitBranch = { ...config, sessionStrategy: "git-branch" } as ResolvedConfig;
    // /tmp is not a git repo, so there is no branch to append.
    expect(sessionName(gitBranch, "/tmp")).toBe("vineeth-tmp");
  });

  test("an override still wins under every strategy", () => {
    const pinned = { ...config, sessionStrategy: "global", sessions: { "/repo": "pinned" } } as ResolvedConfig;
    expect(sessionName(pinned, "/repo")).toBe("pinned");
  });
});

describe("summarizeTool", () => {
  test("records mutating shell commands", () => {
    expect(summarizeTool("bash", { command: "pnpm run build" })).toBe("ran: pnpm run build");
  });

  test("skips read-only shell noise", () => {
    for (const command of ["ls -la", "git status", "grep -rn foo .", "cat README.md"]) {
      expect(summarizeTool("bash", { command })).toBe("");
    }
  });

  test("never records honcho's own calls — that is circular", () => {
    expect(summarizeTool("honcho_search", { query: "x" })).toBe("");
    expect(summarizeTool("honcho_remember", { content: "x" })).toBe("");
  });

  test("names edited files but not read ones", () => {
    expect(summarizeTool("write", { path: "/a/b.ts" })).toBe("edited: /a/b.ts");
    expect(summarizeTool("read", { path: "/a/b.ts" })).toBe("");
  });

  test("falls back to the tool name", () => {
    expect(summarizeTool("web_search", { query: "x" })).toBe("used web_search");
  });
});

describe("selectMessages", () => {
  const config = {
    peerName: "vineeth",
    aiPeer: "dsh",
    capture: { noisePatterns: [] as string[], saveToolUse: false, writeFrequency: "async" },
    messageUpload: { maxUserTokens: 250, maxAssistantTokens: 250 },
  } as ResolvedConfig;

  const userEvent = (text: string, kind = "user") => ({
    type: "user/message",
    data: { content: [{ type: "text", text }], source: { kind } },
  });

  test("THE critical filter: plugin-sourced user messages are never captured", () => {
    // dsh commits runtime-context snapshots and agent.inject() context as
    // durable user/message events. Capturing them feeds Honcho's own memory
    // back into Honcho.
    const events = [userEvent("real question"), userEvent("<honcho-memory>…</honcho-memory>", "plugin")];
    const selected = selectMessages(events, config);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.content).toBe("real question");
  });

  test("harness-injected prompts are dropped", () => {
    expect(isHarnessInjected("<system-reminder>\nbackground\n</system-reminder>")).toBe(true);
    expect(isHarnessInjected("[SYSTEM NOTIFICATION - NOT USER INPUT]")).toBe(true);
    expect(isHarnessInjected("what does this repo do?")).toBe(false);
    expect(selectMessages([userEvent("<task-notification>done</task-notification>")], config)).toHaveLength(0);
  });

  test("assistant messages unwrap the envelope and use the AI peer", () => {
    const events = [{ type: "assistant/message", data: { message: { content: [{ type: "text", text: "hi" }] } } }];
    const selected = selectMessages(events, config);
    expect(selected[0]).toEqual({ role: "assistant", content: "hi", peerId: "dsh" });
  });

  test("secrets are redacted before upload", () => {
    const selected = selectMessages([userEvent("run with AWS_SECRET_ACCESS_KEY=abc123xyz")], config);
    expect(selected[0]!.content).toContain("***");
    expect(selected[0]!.content).not.toContain("abc123xyz");
  });

  test("empty and unknown events are skipped", () => {
    expect(selectMessages([{ type: "turn/start", data: {} }, userEvent("   ")], config)).toHaveLength(0);
  });

  test("tool calls are ignored unless saveToolUse is on", () => {
    const call = { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "pnpm build" }) } };
    expect(selectMessages([call], config)).toHaveLength(0);

    const withTools = { ...config, capture: { ...config.capture, saveToolUse: true } } as ResolvedConfig;
    const selected = selectMessages([call], withTools);
    expect(selected).toEqual([{ role: "assistant", content: "[tool] ran: pnpm build", peerId: "dsh" }]);
  });

  test("malformed logged tool arguments degrade instead of throwing", () => {
    const withTools = { ...config, capture: { ...config.capture, saveToolUse: true } } as ResolvedConfig;
    const call = { type: "tool/call", data: { name: "web_search", arguments: "{not json" } };
    expect(selectMessages([call], withTools)[0]!.content).toBe("[tool] used web_search");
  });

  test("secrets in a captured command are redacted too", () => {
    const withTools = { ...config, capture: { ...config.capture, saveToolUse: true } } as ResolvedConfig;
    const call = {
      type: "tool/call",
      data: { name: "bash", arguments: JSON.stringify({ command: "deploy --token ghp_aaaaaaaaaaaaaaaaaaaaaaaa" }) },
    };
    expect(selectMessages([call], withTools)[0]!.content).not.toContain("ghp_aaaa");
  });
});

describe("cursors", () => {
  // The bug this guards: the cursor was keyed by HONCHO session name while
  // counting events in a DSH session log. Every `dsh --profile headless` run
  // opens a new dsh session with its own log starting at zero, and many dsh
  // sessions map to one Honcho session — so run 2 compared its own event count
  // against run 1's high-water mark and silently uploaded nothing.
  function tmpCursorFile(): string {
    return join(mkdtempSync(join(tmpdir(), "dsh-cursor-")), "cursors.json");
  }

  test("two dsh sessions sharing one Honcho session keep independent cursors", () => {
    const path = tmpCursorFile();
    writeCursor("session-aaa", 40, path);
    // A second dsh session in the same directory starts fresh.
    expect(readCursor("session-bbb", path)).toBe(0);
    expect(readCursor("session-aaa", path)).toBe(40);
  });

  test("a cursor round-trips and advances", () => {
    const path = tmpCursorFile();
    expect(readCursor("s1", path)).toBe(0);
    writeCursor("s1", 12, path);
    expect(readCursor("s1", path)).toBe(12);
    writeCursor("s1", 30, path);
    expect(readCursor("s1", path)).toBe(30);
  });

  test("the pre-TTL bare-number shape still reads, rather than re-uploading history", () => {
    const path = tmpCursorFile();
    writeFileSync(path, JSON.stringify({ "session-legacy": 17 }));
    expect(readCursor("session-legacy", path)).toBe(17);
  });

  test("a missing or corrupt file reads as zero instead of throwing", () => {
    expect(readCursor("s", "/nonexistent/cursors.json")).toBe(0);
    const path = tmpCursorFile();
    writeFileSync(path, "{not json");
    expect(readCursor("s", path)).toBe(0);
  });
});

describe("dialectic injection", () => {
  const base = {
    peerName: "vineeth",
    injection: {
      sessionStart: ["directives", "summary", "peerCard"],
      perTurn: ["userContext", "dialectic"],
      maxRenderedConclusions: 4,
      contextTokens: 1500,
    },
  } as unknown as ResolvedConfig;

  test("carries content when peer card and summary are both empty", () => {
    // The state that made injection unreachable before: a workspace with a
    // representation but no card and no summary injected nothing at all.
    const block = renderMemory(base, { summary: null, peerCard: null, peerRepresentation: null }, [], "Prefers bun.");
    expect(block).not.toBeNull();
    expect(block!.text).toContain("Prefers bun.");
  });

  test("is gated by perTurn, not by the session-start menu", () => {
    const off = { ...base, injection: { ...base.injection, perTurn: ["userContext"] } } as ResolvedConfig;
    expect(renderMemory(off, { summary: null, peerCard: null, peerRepresentation: null }, [], "Prefers bun.")).toBeNull();
  });

  test("still returns null when there is genuinely nothing", () => {
    expect(renderMemory(base, null, [], null)).toBeNull();
    expect(renderMemory(base, null, [], "   ")).toBeNull();
  });

  test("sorts below the peer card but above the representation", () => {
    const block = renderMemory(
      base,
      { summary: null, peerCard: ["IDENTITY: Engineer"], peerRepresentation: null },
      [],
      "Prefers bun.",
    )!;
    expect(block.text.indexOf("IDENTITY: Engineer")).toBeLessThan(block.text.indexOf("Prefers bun."));
  });
});

describe("filterRepresentation", () => {
  test("drops medium/low patterns and all provenance, keeps high claims", () => {
    const raw = [
      "[2026-08-31 10:00:00] Works in TypeScript.",
      "**Pattern** [high]: Prefers minimal dependencies.",
      "**Type**: tendency",
      "**Sources**:",
      "- message 4",
      "- message 9",
      "**Pattern** [medium]: Might like tabs.",
      "**Type**: guess",
      "[2026-08-31 11:00:00] Uses bun.",
    ].join("\n");
    const out = filterRepresentation(raw);
    expect(out).toContain("Prefers minimal dependencies");
    expect(out).toContain("Uses bun");
    expect(out).not.toContain("Might like tabs");
    expect(out).not.toContain("Sources");
    expect(out).not.toContain("message 4");
    expect(out).not.toContain("tendency");
  });

  test("empty input stays empty", () => {
    expect(filterRepresentation("")).toBe("");
  });
});

describe("trimConclusions", () => {
  test("keeps the most recent N timestamped blocks", () => {
    const raw = ["[2026-01-01] one", "[2026-01-02] two", "[2026-01-03] three"].join("\n");
    expect(trimConclusions(raw, 2)).toBe("[2026-01-02] two\n[2026-01-03] three");
  });
});

describe("assembleByPriority", () => {
  test("higher priority wins the budget; a part is dropped rather than shredded", () => {
    const out = assembleByPriority(
      { "peer-card": "A".repeat(60), "session-summary": "B".repeat(60), representation: "C".repeat(60) },
      100,
    );
    expect(out).toContain("A".repeat(60));
    // 40 chars left is under half of B's 60, so B is dropped whole.
    expect(out).not.toContain("B");
    expect(out).not.toContain("C");
  });

  test("everything fits when the budget allows", () => {
    const out = assembleByPriority({ "peer-card": "card", "session-summary": "sum" }, 1000);
    expect(out).toBe("card\n\nsum");
  });
});

describe("renderMemory", () => {
  const base = {
    peerName: "vineeth",
    injection: {
      sessionStart: ["directives", "summary", "peerCard", "representation"],
      perTurn: ["userContext"],
      maxRenderedConclusions: 4,
      contextTokens: 1500,
    },
  } as unknown as ResolvedConfig;

  const context = {
    summary: { content: "Refactored the parser." },
    peerCard: ["IDENTITY: Engineer"],
    peerRepresentation: "[2026-08-31 10:00:00] Prefers bun.",
  };

  test("includes every configured component", () => {
    const block = renderMemory(base, context, [])!;
    expect(block.text).toContain("IDENTITY: Engineer");
    expect(block.text).toContain("Refactored the parser.");
    expect(block.text).toContain("Prefers bun.");
  });

  test("omits components the config leaves out", () => {
    // perTurn emptied too: `userContext` is a content component and would
    // otherwise contribute the card and representation on its own.
    const cardOnly = {
      ...base,
      injection: { ...base.injection, sessionStart: ["directives", "peerCard"], perTurn: [] },
    } as ResolvedConfig;
    const block = renderMemory(cardOnly, context, [])!;
    expect(block.text).toContain("IDENTITY: Engineer");
    expect(block.text).not.toContain("Refactored the parser.");
    expect(block.text).not.toContain("Prefers bun.");
  });

  test("perTurn userContext carries representation + card on its own", () => {
    // claude-honcho defines userContext as "a fresh, prompt-scoped peer.context()
    // blob" — representation and card. Gating those on sessionStart alone is what
    // made injection unreachable in a workspace with no card and no summary.
    const perTurnOnly = {
      ...base,
      injection: { ...base.injection, sessionStart: ["directives"], perTurn: ["userContext"] },
    } as ResolvedConfig;
    const block = renderMemory(perTurnOnly, context, [])!;
    expect(block.text).toContain("IDENTITY: Engineer");
    expect(block.text).toContain("Prefers bun.");
    // summary belongs to the session-start menu only.
    expect(block.text).not.toContain("Refactored the parser.");
  });

  test("returns null rather than an empty block when nothing is selected", () => {
    const none = {
      ...base,
      injection: { ...base.injection, sessionStart: ["directives"], perTurn: [] },
    } as ResolvedConfig;
    // An empty runtime context would make dsh emit a visible "context: none" line.
    expect(renderMemory(none, context, [])).toBeNull();
    expect(renderMemory(base, null, [])).toBeNull();
  });

  test("partial-fetch warnings ride along as a comment", () => {
    const block = renderMemory(base, context, ["card:timeout"])!;
    expect(block.text).toContain("<!-- honcho: partial (card:timeout) -->");
  });
});

describe("redactSecrets", () => {
  test("redacts known token shapes and credential URLs", () => {
    expect(redactSecrets("key hch-abcdefghijklmnopqrst")).toContain("***");
    expect(redactSecrets("psql postgres://u:hunter2@host/db")).toContain(":***@");
    expect(redactSecrets("curl --token supersecretvalue")).toContain("***");
  });

  test("user patterns are additive and a bad regex is skipped, not thrown", () => {
    expect(redactSecrets("internal-codename", ["codename"])).toBe("internal-***");
    expect(() => redactSecrets("safe", ["([unclosed"])).not.toThrow();
  });

  test("ordinary prose is untouched", () => {
    expect(redactSecrets("please refactor the parser")).toBe("please refactor the parser");
  });
});
