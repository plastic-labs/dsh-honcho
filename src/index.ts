/**
 * @honcho-ai/dsh-honcho — Honcho memory for DeepSeek Harness.
 *
 * Everything here is wiring. The seam choices and their justification live in
 * ARCHITECTURE.md; the short version:
 *
 *   agent/session-start   materialize the Honcho session (emit — NOT awaited)
 *   agent/pre-step        fetch + register memory (waterfall — the only awaited
 *                         seam that runs before the first model request)
 *   session/event         capture user/assistant turns; flush on compaction
 *   agent/turn-stopping   flush (serial, awaited at the turn boundary)
 *   ctx.effect disposer   final flush (the only awaited teardown dsh provides)
 */

import Schema from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
// Type-only side-effect imports: cordis services and events reach `Context`
// through declaration merging, so each package we touch must be imported for
// its augmentation even though we call nothing from it directly.
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-commands";
import { loadConfig, sessionName, type ResolvedConfig } from "./core-shim.js";
import { createGateway, type Gateway } from "./honcho.js";
import { createCapture, type Capture } from "./capture.js";
import { DIRECTIVES, renderMemory } from "./memory.js";
import { createTools } from "./tools.js";
import { createCommand } from "./commands.js";

export const name = "honcho";

/** Hard requirements. Optional seams (`sessionQuery`, `commands`, `credentials`)
 *  are queried with `ctx.get()` at their use site so a deployment missing one
 *  degrades instead of refusing to load the plugin. */
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** Override `~/.honcho/config.json`. Test seam; leave unset in normal use. */
  configPath?: string;
  /** Credential reference resolved through `ctx.credentials`, when mounted. */
  apiKeyRef?: string;
  /** Host key inside config.json. Change for a credential-isolated profile. */
  host?: string;
  /** Kill switch that needs no config-file edit. */
  enabled?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  configPath: Schema.string(),
  apiKeyRef: Schema.string().default("HONCHO_API_KEY"),
  host: Schema.string().default("dsh"),
  enabled: Schema.boolean().default(true),
});

/** Section/context sort orders. dsh gained `getSectionOrder`/`getContextOrder`
 *  for centrally-owned placements after 0.1.1-rc.2; a plain number works on
 *  every version and nothing else competes for these slots. */
const DIRECTIVES_ORDER = 500;
const MEMORY_ORDER = 500;

/** How long turn 1 may wait for memory before proceeding without it.
 *  claude-honcho blocks EVERY turn for up to 120s; we block only the first,
 *  and only this long. */
const FIRST_TURN_BUDGET_MS = 5_000;
/** Re-fetch at most this often; later turns never block on it. */
const REFRESH_TTL_MS = 300_000;

interface AgentLike {
  session?: { id?: string; header?: { cwd?: string } };
}

function textOf(messages: readonly { content?: unknown }[] | undefined): string {
  if (!messages?.length) return "";
  const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  return blocks
    .filter((b: unknown): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: string };
      return block?.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join(" ")
    .trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ]).catch(() => null);
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = (msg: string) => console.error(`[honcho] ${msg}`);

  let resolved: ResolvedConfig;
  try {
    resolved = loadConfig({
      configPath: config.configPath,
      host: config.host,
      credential: readCredential(ctx, config.apiKeyRef),
    });
  } catch (e) {
    log(`disabled — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (config.enabled === false || !resolved.enabled) {
    log("disabled by configuration.");
    return;
  }
  if (!resolved.apiKey) {
    log("no API key — set HONCHO_API_KEY, or auth.apiKey in ~/.honcho/config.json. Memory is off.");
    return;
  }

  const honcho = createGateway(resolved);
  const sessionNameFor = (cwd: string | undefined) => sessionName(resolved, cwd);

  // ── capture ──────────────────────────────────────────────────────────────

  const sessionQuery = ctx.get("sessionQuery") as
    | { readSession(id: string): Promise<{ session?: { cwd?: string }; events?: readonly unknown[] }> }
    | undefined;

  let capture: Capture | undefined;
  if (sessionQuery && resolved.capture.saveMessages) {
    capture = createCapture(resolved, {
      readSession: (id) => sessionQuery.readSession(id) as never,
      honchoSessionName: sessionNameFor,
      upload: (name, messages) => honcho.upload(name, messages),
      onError: (message) => log(`capture: ${message}`),
    });
  } else if (resolved.capture.saveMessages) {
    log("ctx.sessionQuery is unavailable — turn capture is off. Injection and tools still work.");
  }

  // ── injection ────────────────────────────────────────────────────────────

  let disposeMemory: (() => void) | undefined;
  let lastFetchAt: number | undefined;
  let lastFetchError: string | undefined;
  let refreshing: Promise<void> | undefined;

  ctx.systemPrompt.section({ name: "honcho:directives", order: DIRECTIVES_ORDER, text: DIRECTIVES });

  async function refreshMemory(cwd: string | undefined, searchQuery: string): Promise<void> {
    try {
      const context = await honcho.fetchContext(cwd, searchQuery || undefined);
      const block = renderMemory(resolved, context, []);
      lastFetchAt = Date.now();
      lastFetchError = undefined;
      if (!block) return;
      // Register the RESOLVED text. Nothing is registered until there is
      // something to register, so an empty runtime context — which dsh renders
      // as a visible "Current runtime context: none." line — cannot happen.
      const next = ctx.systemPrompt.context({
        name: "honcho:memory",
        order: MEMORY_ORDER,
        text: block.text,
      });
      disposeMemory?.();
      disposeMemory = next;
    } catch (e) {
      lastFetchError = e instanceof Error ? e.message : String(e);
      // Keep the previous registration: stale memory beats none. The failure is
      // visible in `/honcho`, which is why that line exists.
      log(`memory fetch failed: ${lastFetchError}`);
    }
  }

  ctx.on("agent/session-start", (payload: { agent: AgentLike }) => {
    // Emit, not awaited — so this only starts the write that materializes the
    // session. The read that turn 1 depends on happens in pre-step below.
    void honcho.ensureSession(payload.agent.session?.header?.cwd).catch((e: unknown) => {
      log(`session setup failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  ctx.on(
    "agent/pre-step",
    async (
      payload: { agent: AgentLike; messages?: readonly { content?: unknown }[]; step: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      const cwd = payload.agent.session?.header?.cwd;
      const query = textOf(payload.messages);
      const stale = !lastFetchAt || Date.now() - lastFetchAt > REFRESH_TTL_MS;

      if (!lastFetchAt && !lastFetchError) {
        // First request of the session: this waterfall is awaited, so it is the
        // only place memory can land BEFORE the model sees the prompt. Bounded,
        // and only paid once.
        await withTimeout(refreshMemory(cwd, query), FIRST_TURN_BUDGET_MS);
      } else if (stale && !refreshing) {
        // Later turns never block. A turn either gets fresh memory or the
        // previous snapshot.
        refreshing = refreshMemory(cwd, query).finally(() => {
          refreshing = undefined;
        });
      }
      return next();
    },
    { prepend: true },
  );

  // ── capture wiring ───────────────────────────────────────────────────────

  if (capture) {
    const activeCapture = capture;

    ctx.on("session/event", (session: { id?: string }, event: { type?: string }) => {
      if (!session.id) return;
      if (event.type === "user/message" || event.type === "assistant/message") {
        activeCapture.schedule(session.id);
      } else if (event.type === "compaction/start") {
        // The lock brackets the whole operation, so this fires before any
        // history is shadowed. Last chance to capture what is about to go.
        void activeCapture.flush(session.id);
      }
    });

    ctx.on("agent/turn-stopping", async (payload: { agent: AgentLike }) => {
      const id = payload.agent.session?.id;
      if (id) await activeCapture.flush(id);
    });
  }

  // ── tools ────────────────────────────────────────────────────────────────

  if (resolved.injection.tools) {
    for (const tool of createTools(resolved, honcho)) {
      ctx.tools.register(tool as never);
    }
  }

  // ── command ──────────────────────────────────────────────────────────────

  const commands = ctx.get("commands") as { register(def: unknown): () => void } | undefined;
  if (commands && capture) {
    commands.register(
      createCommand(resolved, {
        capture,
        sessionNameFor,
        cwdOf: (agent) => (agent as AgentLike)?.session?.header?.cwd,
        lastFetchAt: () => lastFetchAt,
        lastFetchError: () => lastFetchError,
        injectionActive: () => disposeMemory !== undefined,
      }),
    );
  }

  // ── teardown ─────────────────────────────────────────────────────────────

  ctx.effect(() => async () => {
    // Async disposers ARE awaited on unload. `session/flush` is not a
    // session-end signal and `session/disposed` is emit-only, so this is the
    // one place a final flush is guaranteed to complete.
    disposeMemory?.();
    await capture?.dispose();
  });

  log(`ready — workspace ${resolved.workspace}, peer ${resolved.peerName}, ${resolved.observationMode}`);
}

/** `ctx.credentials` is an abstract seam that may be absent, and `resolve()` is
 *  async while config loading is not. We therefore read only the synchronous
 *  env layer here; a mounted provider's async layers are a Phase 2 concern. */
function readCredential(ctx: Context, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const credentials = ctx.get("credentials");
  if (!credentials) return process.env[ref];
  return process.env[ref];
}
