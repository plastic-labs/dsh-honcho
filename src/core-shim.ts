/**
 * Canonical `~/.honcho/config.json` resolution + Honcho client factory.
 *
 * THIS FILE IS TEMPORARY. It stands in for integration core v0.2 (Linear
 * DEV-2452, "canonical config resolution and client factory"). When that ships,
 * delete this file and import the same shape from core. Everything else in this
 * plugin imports config through here so the swap is one import edit.
 *
 * Scope rule that keeps it deletable: we read legacy spellings ONLY for keys
 * that are still legal at root under the canonical shape — `apiKey` and
 * `endpoint`. Every behavioral key is canonical-only. dsh-honcho has no users,
 * so there is no back-compat surface to preserve, and legacy parsing is exactly
 * the part that would never get deleted (claude-honcho's config.ts is 1,014
 * lines, mostly for that reason).
 *
 * Spec: https://linear.app/plastic-labs/document/proposal-honchoconfigjson-ff54bd93cc93
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";

export const HOST_DEFAULT = "dsh";

/** Coding-assistant bucket: two peers, the user models themselves. */
export type ObservationMode = "unified" | "directional";

/** v1 ships one strategy. `git-branch` and `per-session` are Phase 2, and are
 *  worth re-arguing first: Honcho's own guidance is "don't scope sessions too
 *  thin" — the Deriver needs a single session to accumulate enough tokens to
 *  reason, and both alternatives split a project's memory. */
export type SessionStrategy = "per-directory";

export interface InjectionConfig {
  sessionStart: string[];
  perTurn: string[];
  tools: boolean;
  searchTopK: number;
  searchMaxDistance: number;
  maxConclusions: number;
  contextTokens: number;
  /** Character cap on the assembled injection block. Lowered from 8000 by
   *  dsh-honcho-sync after live use; treat as a starting value. */
  injectionMaxChars: number;
  /** Observations kept from a representation after filtering. Same provenance. */
  reprMaxObs: number;
}

export interface CaptureConfig {
  saveMessages: boolean;
  /** Additive to the built-in secret patterns in redact.ts. */
  redactPatterns: string[];
  /** Debounce before a flush, in ms. */
  debounceMs: number;
  /** Per-message character cap on upload. */
  messageMaxChars: number;
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
    perTurn: ["userContext"],
    tools: true,
    searchTopK: 10,
    searchMaxDistance: 0.6,
    maxConclusions: 15,
    contextTokens: 1500,
    injectionMaxChars: 4000,
    reprMaxObs: 4,
  } satisfies InjectionConfig,
  capture: {
    saveMessages: true,
    redactPatterns: [] as string[],
    debounceMs: 3_000,
    messageMaxChars: 25_000,
  } satisfies CaptureConfig,
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
  injection?: Partial<InjectionConfig>;
  capture?: Partial<CaptureConfig>;
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

  const strategy = host?.sessionStrategy ?? BUILTIN.sessionStrategy;
  if (strategy !== "per-directory") {
    throw new Error(
      `[honcho] sessionStrategy ${JSON.stringify(strategy)} is not implemented yet — ` +
        `v1 supports "per-directory" plus the root \`sessions\` override map.`,
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
    sessions: file.sessions ?? {},
    injection: { ...BUILTIN.injection, ...(host?.injection ?? {}) },
    capture: { ...BUILTIN.capture, ...(host?.capture ?? {}) },
  };
}

// ── session naming ─────────────────────────────────────────────────────────

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

/**
 * `<peerName>-<dir>`, matching claude-honcho's `deriveSessionName`
 * (`plugins/honcho/src/config.ts:778`) so a user's sessions line up across
 * integrations. An explicit `sessions[cwd]` override always wins.
 */
export function sessionName(config: ResolvedConfig, cwd: string | undefined): string {
  if (cwd) {
    const override = config.sessions[cwd];
    if (override) return override;
  }
  const dirPart = sanitize(cwd ? basename(cwd) : "unknown");
  if (!config.sessionPeerPrefix) return dirPart;
  return `${sanitize(config.peerName)}-${dirPart}`;
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
