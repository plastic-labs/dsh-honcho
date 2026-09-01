/**
 * Canonical `~/.honcho/config.json` resolution + Honcho client factory.
 *
 * THIS FILE IS TEMPORARY. It stands in for the shared integration core's
 * canonical config resolution and client factory. When that ships, delete this
 * file and import the same shape from core. Everything else in this plugin
 * imports config through here so the swap is one import edit.
 *
 * Scope rule that keeps it deletable: we read legacy spellings ONLY for keys
 * that are still legal at root under the canonical shape — `apiKey` and
 * `endpoint`. Every behavioral key is canonical-only. dsh-honcho has no users,
 * so there is no back-compat surface to preserve, and legacy parsing is exactly
 * the part that would never get deleted (claude-honcho's config.ts is 1,014
 * lines, mostly for that reason).
 *
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { currentBranch, repoRoot } from "./git.js";

export const HOST_DEFAULT = "dsh";

/** Coding-assistant bucket: two peers, the user models themselves. */
export type ObservationMode = "unified" | "directional";

/**
 * How a dsh session maps to a Honcho session.
 *
 * A caution that belongs with the type rather than the docs: Honcho's guidance
 * is not to scope sessions too thin, because the background Deriver needs a
 * single session to accumulate enough material to reason over. `git-branch` and
 * `per-session` both split a project's memory, and `per-session` discards it
 * every restart. `per-directory` is the default for that reason.
 */
export const SESSION_STRATEGIES = ["per-directory", "per-repo", "git-branch", "per-session", "global"] as const;
export type SessionStrategy = (typeof SESSION_STRATEGIES)[number];

/**
 * Injection components, per the canonical config schema. Not all are meaningful
 * in dsh; `unsupportedComponents()` reports which are ignored and why, so a
 * user who configures one is told rather than left wondering.
 */
export const SESSION_START_COMPONENTS = ["directives", "summary", "peerCard", "representation", "briefing"] as const;
export const PER_TURN_COMPONENTS = ["userContext", "assistantContext", "sessionContext", "dialectic"] as const;

const UNSUPPORTED: Record<string, string> = {
  briefing: "no MCP briefing tool in this plugin — session-start memory is injected directly",
  assistantContext: "not implemented; it needs a second context() call for the AI peer",
  sessionContext: "redundant in dsh — recent messages are already in the transcript",
};

/** Configured components and options this plugin ignores, as `[name, reason]`. */
export function unsupportedComponents(injection: InjectionConfig): [string, string][] {
  const out: [string, string][] = [...injection.sessionStart, ...injection.perTurn]
    .filter((c) => c in UNSUPPORTED)
    .map((c) => [c, UNSUPPORTED[c] as string]);
  if (injection.perTurn.includes("dialectic") && injection.dialectic.depth !== 2) {
    out.push([
      "injection.dialectic.depth",
      "Honcho's DialecticOptions has no depth parameter, so this value has no effect",
    ]);
  }
  return out;
}

export interface InjectionConfig {
  sessionStart: string[];
  perTurn: string[];
  tools: boolean;
  searchTopK: number;
  searchMaxDistance: number;
  maxConclusions: number;
  contextTokens: number;
  /** How many conclusions survive client-side filtering into the prompt.
   *  Distinct from `maxConclusions`, which bounds what Honcho RETURNS: this
   *  bounds what is left after medium/low patterns and provenance are stripped,
   *  a layer the server's token budget cannot see. A dsh-honcho extension
   *  proposed for the canonical schema, not yet in it. */
  maxRenderedConclusions: number;
  /** `userContext` and `dialectic` are turn counts: refresh that component
   *  every Nth turn. `ttlSeconds` bounds how long any snapshot is reused. */
  cadence: { userContext: number; dialectic: number; ttlSeconds: number };
  /** Shape of the periodic background dialectic. */
  dialectic: DialecticConfig;
}

export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface DialecticConfig {
  /** Query sent to `peer.chat()`. `%{user_query}` is replaced with the user's
   *  current message; a template without it is a standing question. */
  template: string;
  /** Honcho reasoning tier. `low` keeps a periodic background call affordable. */
  reasoning: ReasoningLevel;
  /** Accepted for canonical-schema compatibility and NOT implemented: Honcho's
   *  DialecticOptions has no depth parameter (session_id, filters, scope,
   *  target, query, stream, reasoning_level, response_format). Kept so a shared
   *  config does not fail to load; a non-default value is reported at startup. */
  depth: number;
  /** Hard cap on injected characters — this bounds the prompt, not the spend. */
  maxChars: number;
}

export interface CaptureConfig {
  saveMessages: boolean;
  /** Capture one-line summaries of tool activity (default false — low signal,
   *  and largely restated by the assistant's own messages). A dsh-honcho
   *  extension proposed for the canonical schema, not yet in it. */
  saveToolUse: boolean;
  /** `async` buffers and flushes in the background; `sync` flushes inline at
   *  each turn boundary. */
  writeFrequency: "async" | "sync";
  /** Content matching these is dropped before capture, additive to the
   *  built-in secret patterns in redact.ts. */
  noisePatterns: string[];
}

/** Per-message upload limits, matching claude-honcho's block of the same name. */
export interface MessageUploadConfig {
  maxUserTokens: number;
  maxAssistantTokens: number;
}

export interface ResolvedConfig {
  apiKey: string;
  peerName: string;
  workspace: string;
  aiPeer: string;
  baseUrl: string;
  timeoutMs: number;
  enabled: boolean;
  observationMode: ObservationMode;
  sessionStrategy: SessionStrategy;
  sessionPeerPrefix: boolean;
  sessions: Record<string, string>;
  injection: InjectionConfig;
  capture: CaptureConfig;
  messageUpload: MessageUploadConfig;
}

/** The SDK builds `/v3/...` paths itself (`dist/client.js:122`), so a base URL
 *  must NOT carry a `/v3` suffix — with a path-prefixed proxy that would produce
 *  `/honcho/v3/v3/...`. Normalization strips it rather than adding it. */
const DEFAULT_BASE_URL = "https://api.honcho.dev";

const BUILTIN = {
  workspace: HOST_DEFAULT,
  timeoutMs: 30_000,
  sessionStrategy: "per-directory" as SessionStrategy,
  sessionPeerPrefix: true,
  injection: {
    sessionStart: ["directives", "summary", "peerCard"],
    perTurn: ["userContext", "dialectic"],
    tools: true,
    searchTopK: 10,
    searchMaxDistance: 0.6,
    maxConclusions: 15,
    contextTokens: 1500,
    maxRenderedConclusions: 4,
    // Matches hermes: a periodic background profile refresh, not a per-turn
    // answer. At cadence 5 the lateness is the design.
    cadence: { userContext: 1, dialectic: 5, ttlSeconds: 300 },
    dialectic: {
      template:
        "In two or three sentences, what should I know about this user to work with them well? " +
        "Durable preferences, current projects, working style. Third person, factual, no questions.",
      reasoning: "low",
      depth: 2,
      maxChars: 600,
    },
  } satisfies InjectionConfig,
  capture: {
    saveMessages: true,
    saveToolUse: false,
    writeFrequency: "async" as const,
    noisePatterns: [] as string[],
  } satisfies CaptureConfig,
  messageUpload: {
    // ~25k characters at the usual 4 chars/token, matching the previous cap.
    maxUserTokens: 6_000,
    maxAssistantTokens: 6_000,
  } satisfies MessageUploadConfig,
};

/** Coding bucket → unified. The multi-user bucket defaults to directional. */
const BUCKET_OBSERVATION: ObservationMode = "unified";

// ── on-disk shape ──────────────────────────────────────────────────────────

interface HostBlock {
  workspace?: string;
  aiPeer?: string;
  peerName?: string;
  auth?: { apiKey?: string };
  observationMode?: ObservationMode;
  sessionStrategy?: string;
  sessionPeerPrefix?: boolean;
  /** The RFC places pinned session names in the HOST block. Root is read as a
   *  fallback so an existing file keeps working, but the host is authoritative. */
  sessions?: Record<string, string>;
  injection?: Partial<InjectionConfig>;
  capture?: Partial<CaptureConfig>;
  messageUpload?: Partial<MessageUploadConfig>;
}

interface FileConfig {
  peerName?: string;
  workspace?: string;
  baseUrl?: string;
  timeoutMs?: number;
  auth?: { apiKey?: string };
  enabled?: boolean;
  sessions?: Record<string, string>;
  hosts?: Record<string, HostBlock>;
  /** Legal-at-root legacy spelling of auth.apiKey. */
  apiKey?: string;
  /** Legal-at-root legacy spelling of baseUrl. */
  endpoint?: { environment?: "production" | "local"; baseUrl?: string };
}

const LEGACY_ENVIRONMENT_URLS = {
  production: "https://api.honcho.dev",
  local: "http://localhost:8000",
} as const;

export function configPath(override?: string): string {
  if (override) return override.replace(/^~(?=$|\/)/, homedir());
  const dir = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(dir, "config.json");
}

function readFile(path: string): FileConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as FileConfig) : {};
  } catch {
    // Missing or malformed: fall through to env + defaults rather than refusing
    // to start. A missing API key is what disables the plugin, not a missing file.
    return {};
  }
}

/** `${ENV_VAR}` interpolation, per the RFC. An unset variable yields "" so the
 *  caller's "no API key" path handles it, rather than throwing at load. */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

/**
 * Normalize a base URL: accept a bare host, any casing, with or without a
 * trailing `/v3`. The RFC requires `api.honcho.dev`, `API.honcho.dev`, and
 * `https://api.honcho.dev/v3` to resolve identically — and the SDK appends the
 * version segment itself, so the normal form has no `/v3`.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return DEFAULT_BASE_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
    url = `${local ? "http" : "https"}://${url}`;
  }
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    // Strip any number of trailing /v3 segments; the SDK adds its own.
    parsed.pathname = parsed.pathname.replace(/(?:\/v3)+\/?$/i, "").replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function resolveApiKey(file: FileConfig, host: HostBlock | undefined): string {
  const candidates = [
    process.env.HONCHO_API_KEY,
    host?.auth?.apiKey,
    file.auth?.apiKey,
    file.apiKey, // legal-at-root legacy spelling
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = interpolateEnv(candidate).trim();
    if (resolved) return resolved;
  }
  return "";
}

function resolveBaseUrl(file: FileConfig): string {
  if (process.env.HONCHO_BASE_URL) return normalizeBaseUrl(process.env.HONCHO_BASE_URL);
  if (file.baseUrl) return normalizeBaseUrl(file.baseUrl);
  // Legal-at-root legacy spelling.
  if (file.endpoint?.baseUrl) return normalizeBaseUrl(file.endpoint.baseUrl);
  if (file.endpoint?.environment) return normalizeBaseUrl(LEGACY_ENVIRONMENT_URLS[file.endpoint.environment]);
  return DEFAULT_BASE_URL;
}

export function resolvePeerName(file: FileConfig, host: HostBlock | undefined): string {
  return (
    process.env.HONCHO_PEER_NAME ||
    host?.peerName ||
    file.peerName ||
    process.env.USER ||
    process.env.USERNAME ||
    "user"
  );
}

export interface LoadOptions {
  configPath?: string;
  host?: string;
  /** Already-resolved credential value, e.g. from ctx.credentials. Wins over
   *  every file source but not over HONCHO_API_KEY. */
  credential?: string;
}

/**
 * Resolution order (RFC): env → credential seam → hosts.<host> → root
 * (identity + connection + switches only) → bucket default → built-in.
 *
 * `globalOverride` is deliberately unsupported: both legacy readers implement
 * it as a root boolean that INVERTS this ladder, which means the resolved
 * workspace can differ from what the file appears to say.
 */
export function loadConfig(options: LoadOptions = {}): ResolvedConfig {
  const hostKey = options.host || process.env.HONCHO_HOST || HOST_DEFAULT;
  const file = readFile(configPath(options.configPath));
  const host = file.hosts?.[hostKey];

  const apiKey = process.env.HONCHO_API_KEY?.trim() || options.credential?.trim() || resolveApiKey(file, host);

  const strategy = (host?.sessionStrategy ?? BUILTIN.sessionStrategy) as SessionStrategy;
  if (!SESSION_STRATEGIES.includes(strategy)) {
    throw new Error(
      `[honcho] unknown sessionStrategy ${JSON.stringify(strategy)} — ` +
        `expected one of ${SESSION_STRATEGIES.join(", ")}.`,
    );
  }

  return {
    apiKey,
    peerName: resolvePeerName(file, host),
    workspace: host?.workspace ?? file.workspace ?? BUILTIN.workspace,
    // Canonical ruling: aiPeer defaults to the host name.
    aiPeer: host?.aiPeer ?? hostKey,
    baseUrl: resolveBaseUrl(file),
    timeoutMs: file.timeoutMs ?? BUILTIN.timeoutMs,
    enabled: file.enabled !== false,
    observationMode: host?.observationMode ?? BUCKET_OBSERVATION,
    sessionStrategy: strategy,
    sessionPeerPrefix: host?.sessionPeerPrefix ?? BUILTIN.sessionPeerPrefix,
    // Host block wins; root is a fallback for files written before the split.
    sessions: host?.sessions ?? file.sessions ?? {},
    injection: {
      ...BUILTIN.injection,
      ...(host?.injection ?? {}),
      // Nested objects would otherwise be replaced wholesale by a partial.
      cadence: { ...BUILTIN.injection.cadence, ...(host?.injection?.cadence ?? {}) },
      dialectic: { ...BUILTIN.injection.dialectic, ...(host?.injection?.dialectic ?? {}) },
    },
    capture: { ...BUILTIN.capture, ...(host?.capture ?? {}) },
    messageUpload: { ...BUILTIN.messageUpload, ...(host?.messageUpload ?? {}) },
  };
}

// ── session naming ─────────────────────────────────────────────────────────

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

/**
 * Honcho session name. Prefix and shape follow claude-honcho's
 * `deriveSessionName` (`plugins/honcho/src/config.ts:778`) so a user's sessions
 * line up across integrations. An explicit `sessions[cwd]` override always wins.
 *
 * `dshSessionId` is only consulted by `per-session`; every other strategy is a
 * pure function of `cwd` plus git state, which is what makes them stable across
 * restarts.
 */
export function sessionName(
  config: ResolvedConfig,
  cwd: string | undefined,
  dshSessionId?: string,
): string {
  if (cwd) {
    const override = config.sessions[cwd];
    if (override) return override;
  }

  const peer = sanitize(config.peerName);
  const prefix = (rest: string) => (config.sessionPeerPrefix ? `${peer}-${rest}` : rest);

  switch (config.sessionStrategy) {
    case "global":
      return config.sessionPeerPrefix ? peer : "honcho";

    case "per-repo": {
      const root = cwd ? repoRoot(cwd) : undefined;
      return prefix(sanitize(basename(root ?? cwd ?? "unknown")));
    }

    case "git-branch": {
      const dir = sanitize(basename(cwd ?? "unknown"));
      const branch = cwd ? currentBranch(cwd) : undefined;
      // No branch (not a repo, detached HEAD) collapses to the per-directory
      // name rather than inventing a placeholder that would fork memory.
      return prefix(branch ? `${dir}-${sanitize(branch)}` : dir);
    }

    case "per-session": {
      // dsh mints ids as `session-<n>` (SessionStore.create), so a fixed
      // truncation would collapse every session to the same name. Strip the
      // redundant prefix and keep the rest whole; only a long opaque id is
      // shortened.
      const raw = dshSessionId ? sanitize(dshSessionId).replace(/^session-/, "") : "";
      const id = raw.length > 16 ? raw.slice(0, 16) : raw;
      return id ? prefix(`chat-${id}`) : prefix(sanitize(basename(cwd ?? "unknown")));
    }

    case "per-directory":
    default:
      return prefix(sanitize(basename(cwd ?? "unknown")));
  }
}

/** Deep link into the Honcho GUI. The web app lives at the production host
 *  regardless of API endpoint, matching the other integrations. */
export function sessionUrl(workspace: string, session: string): string {
  return `https://app.honcho.dev/explore?workspace=${encodeURIComponent(workspace)}&view=sessions&session=${encodeURIComponent(session)}`;
}

// ── client factory ─────────────────────────────────────────────────────────

export interface HonchoClientOptions {
  apiKey: string;
  baseURL: string;
  workspaceId: string;
  timeout: number;
  maxRetries: number;
}

export function clientOptions(config: ResolvedConfig): HonchoClientOptions {
  return {
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    workspaceId: config.workspace,
    timeout: config.timeoutMs,
    maxRetries: 1,
  };
}
