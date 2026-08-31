import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { interpolateEnv, loadConfig, normalizeBaseUrl, sessionName, type ResolvedConfig } from "../src/core-shim.ts";

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
import { isHarnessInjected, selectMessages } from "../src/capture.ts";
import { assembleByPriority, filterRepresentation, trimObservations } from "../src/memory.ts";
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

  test("an unimplemented sessionStrategy fails loudly rather than silently", () => {
    const path = writeConfig({ ...base, hosts: { dsh: { sessionStrategy: "git-branch" } } });
    expect(() => loadConfig({ configPath: path, host: "dsh" })).toThrow(/not implemented/);
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
});

describe("selectMessages", () => {
  const config = {
    peerName: "vineeth",
    aiPeer: "dsh",
    capture: { messageMaxChars: 1000, redactPatterns: [] as string[] },
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

describe("trimObservations", () => {
  test("keeps the most recent N timestamped blocks", () => {
    const raw = ["[2026-01-01] one", "[2026-01-02] two", "[2026-01-03] three"].join("\n");
    expect(trimObservations(raw, 2)).toBe("[2026-01-02] two\n[2026-01-03] three");
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
