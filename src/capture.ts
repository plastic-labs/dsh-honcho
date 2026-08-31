/**
 * Turn capture.
 *
 * dsh already owns a durable, replayable session log, so this does NOT keep a
 * message queue. It keeps a CURSOR: an event count per Honcho session,
 * persisted to disk and advanced only after a successful upload. On each flush
 * we re-derive the unsent slice from `ctx.sessionQuery.readSession()`. Retry
 * across network failure, crash durability, and torn-write tolerance all fall
 * out of that, with no queue format to own.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "./core-shim.js";
import { redactSecrets } from "./redact.js";

export interface CapturedMessage {
  role: "user" | "assistant";
  content: string;
  peerId: string;
}

/**
 * Shell commands that read rather than change anything. A review or search turn
 * would otherwise flood memory with `ran: grep ...` lines that say nothing about
 * the user. Ported from codex-honcho's list.
 */
const READ_ONLY_SHELL = [
  "cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type", "grep", "rg", "find", "fd",
  "wc", "sed", "awk", "less", "more", "stat", "file", "tree", "du", "df", "env", "printf",
  "sort", "uniq", "cut", "jq", "open", "true", "sleep", "date",
  "git status", "git log", "git diff", "git show", "git branch",
];

const SHELL_TOOLS = new Set(["bash", "shell", "pwsh", "exec", "run_code"]);

/**
 * One line describing a tool call, or "" when it carries no signal about the
 * user. Pure, so it is directly testable.
 */
export function summarizeTool(name: string, args: Record<string, unknown>): string {
  if (!name) return "";
  // Recording that we queried memory is circular noise in the representation.
  if (name.startsWith("honcho_")) return "";

  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const raw = args.command ?? args.cmd ?? args.code;
    const command = (Array.isArray(raw) ? raw.join(" ") : typeof raw === "string" ? raw : "").trim();
    if (!command) return "";
    if (READ_ONLY_SHELL.some((t) => command === t || command.startsWith(`${t} `))) return "";
    return `ran: ${command.slice(0, 120)}`;
  }

  const path = args.path ?? args.file_path ?? args.filePath;
  if (typeof path === "string" && path) {
    const verb = /write|edit|create/i.test(name) ? "edited" : "read";
    if (verb === "read") return "";
    return `edited: ${path}`;
  }

  return `used ${name}`;
}

/** Minimal shape of a durable session event we care about. */
interface LogEvent {
  type?: string;
  data?: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * Prompts the harness injected rather than the user typing them. dsh commits
 * these as ordinary `user/message` events, and claude-honcho filters the same
 * shapes out of its transcript before upload.
 */
const HARNESS_INJECTED = [
  /^<[a-z-]+-reminder>/i,
  /^<command-(?:name|message|args)>/i,
  /^\[SYSTEM NOTIFICATION/i,
  /^<task-notification>/i,
  /^Caveat: The messages below were generated/i,
];

export function isHarnessInjected(text: string): boolean {
  const trimmed = text.trim();
  return HARNESS_INJECTED.some((p) => p.test(trimmed));
}

/**
 * Pure: durable events → messages worth sending.
 *
 * The `source.kind === "user"` check is the load-bearing line. dsh commits
 * runtime-context snapshots, `agent.inject()` context, and compaction summaries
 * as durable `user/message` events with `source.kind === "plugin"`
 * (`packages/core/agent-loop/src/runtime-context.ts:73`). Without this filter we
 * would upload Honcho's own injected memory back into Honcho every turn — a
 * closed loop that degrades the representation.
 */
export function selectMessages(events: readonly LogEvent[], config: ResolvedConfig): CapturedMessage[] {
  const out: CapturedMessage[] = [];
  const cap = config.capture.messageMaxChars;
  const patterns = config.capture.redactPatterns;

  for (const event of events) {
    if (!event?.data) continue;

    if (event.type === "user/message") {
      const message = event.data as { content?: unknown; source?: { kind?: string } };
      if (message.source?.kind !== "user") continue;
      const text = extractText(message.content);
      if (!text.trim() || isHarnessInjected(text)) continue;
      out.push({ role: "user", content: redactSecrets(text.slice(0, cap), patterns), peerId: config.peerName });
      continue;
    }

    if (event.type === "assistant/message") {
      const envelope = event.data as { message?: { content?: unknown } };
      const text = extractText(envelope.message?.content);
      if (!text.trim()) continue;
      out.push({ role: "assistant", content: redactSecrets(text.slice(0, cap), patterns), peerId: config.aiPeer });
      continue;
    }

    // Tool activity rides the same durable log, so it needs no second listener —
    // just a wider selection when the user asks for it. `tool/call` carries the
    // name and arguments; `tool/result` carries only the outcome.
    if (event.type === "tool/call" && config.capture.saveToolUse) {
      const call = event.data as { name?: string; arguments?: string };
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments ?? "{}");
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        // Malformed logged arguments still summarize as `used <name>`.
      }
      const summary = summarizeTool(call.name ?? "", args);
      if (!summary) continue;
      out.push({
        role: "assistant",
        content: redactSecrets(`[tool] ${summary}`.slice(0, cap), patterns),
        peerId: config.aiPeer,
      });
    }
  }
  return out;
}

// ── cursor persistence ─────────────────────────────────────────────────────

function cursorPath(): string {
  const dir = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(dir, "dsh", "cursors.json");
}

type CursorFile = Record<string, number>;

export function readCursors(path = cursorPath()): CursorFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as CursorFile) : {};
  } catch {
    return {};
  }
}

export function writeCursor(sessionName: string, count: number, path = cursorPath()): void {
  try {
    const cursors = readCursors(path);
    cursors[sessionName] = count;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cursors, null, 2), { mode: 0o600 });
  } catch {
    // A cursor we cannot persist means the next process re-sends this slice.
    // Honcho dedupes on its side; losing the turn would be worse.
  }
}

// ── the capture loop ───────────────────────────────────────────────────────

export interface CaptureDeps {
  /** `ctx.sessionQuery.readSession` — an abstract seam, so it may be absent. */
  readSession(sessionId: string): Promise<{ session?: { cwd?: string }; events?: readonly LogEvent[] }>;
  /** Resolve the Honcho session name for a dsh session. */
  honchoSessionName(cwd: string | undefined, dshSessionId: string): string;
  /** Upload. Must throw on failure so the cursor does not advance. */
  upload(sessionName: string, messages: CapturedMessage[]): Promise<void>;
  onError?(message: string): void;
}

export interface Capture {
  schedule(sessionId: string): void;
  flush(sessionId: string): Promise<void>;
  flushAll(): Promise<void>;
  /** Flush everything outstanding, then stop. Await this from the plugin's
   *  `ctx.effect` disposer — async disposers ARE awaited on unload, and that is
   *  the only awaited teardown dsh gives us (`session/flush` is not one). */
  dispose(): Promise<void>;
  /** Timestamp of the last successful upload, for `/honcho` status. */
  lastFlushedAt(): number | undefined;
  pending(): number;
}

export function createCapture(config: ResolvedConfig, deps: CaptureDeps): Capture {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<void>>();
  const known = new Set<string>();
  let lastFlushed: number | undefined;
  let pendingCount = 0;
  let disposed = false;

  async function run(sessionId: string): Promise<void> {
    if (disposed || !config.capture.saveMessages) return;

    const snapshot = await deps.readSession(sessionId);
    const events = snapshot.events ?? [];
    const name = deps.honchoSessionName(snapshot.session?.cwd, sessionId);

    const cursors = readCursors();
    const sent = cursors[name] ?? 0;
    if (events.length <= sent) return;

    const slice = events.slice(sent);
    const messages = selectMessages(slice, config);
    pendingCount = messages.length;

    if (messages.length === 0) {
      // Nothing worth sending, but these events are accounted for.
      writeCursor(name, events.length);
      pendingCount = 0;
      return;
    }

    // Throws on failure → cursor stays put → the slice retries next flush.
    await deps.upload(name, messages);
    writeCursor(name, events.length);
    lastFlushed = Date.now();
    pendingCount = 0;
  }

  function guarded(sessionId: string): Promise<void> {
    // One flush per session at a time; a second request waits for the first so
    // two uploads can never race the same cursor.
    const existing = inflight.get(sessionId);
    const next = (existing ?? Promise.resolve())
      .catch(() => {})
      .then(() => run(sessionId))
      .catch((e: unknown) => {
        deps.onError?.(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (inflight.get(sessionId) === next) inflight.delete(sessionId);
      });
    inflight.set(sessionId, next);
    return next;
  }

  return {
    schedule(sessionId) {
      if (disposed) return;
      known.add(sessionId);
      const existing = timers.get(sessionId);
      if (existing) clearTimeout(existing);
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          void guarded(sessionId);
        }, config.capture.debounceMs),
      );
    },
    flush(sessionId) {
      const timer = timers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(sessionId);
      }
      known.add(sessionId);
      return guarded(sessionId);
    },
    async flushAll() {
      await Promise.all([...known].map((id) => this.flush(id)));
    },
    async dispose() {
      // Order matters: stop new debounced work, drain what is outstanding, and
      // only then latch `disposed` — latching first would make every drained
      // run return early and silently drop the final turn.
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await this.flushAll();
      await Promise.all([...inflight.values()].map((p) => p.catch(() => {})));
      disposed = true;
    },
    lastFlushedAt: () => lastFlushed,
    pending: () => pendingCount,
  };
}
