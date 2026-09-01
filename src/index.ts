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
import { loadConfig, sessionName, unsupportedComponents, configPath, type ResolvedConfig } from "./core-shim.js";
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
 *  for centrally-owned placements after 0.1.1-rc.2, so plain numbers are used
 *  instead — they work on every version. 650 sits between the harness's
 *  TEAM_POLICY (600) and PTC_ONLY (800); 500 would collide with PLAN_POLICY. */
const DIRECTIVES_ORDER = 650;
/** Runtime contexts are centrally allocated only up to 120, so memory sorts
 *  last among them, which is where the least policy-like content belongs. */
const MEMORY_ORDER = 500;

/** Name our runtime context registers under, and the key we look for in an
 *  assembly to detect that the composition is dropping it. */
const MEMORY_CONTEXT_NAME = "honcho:memory";

/** How long turn 1 may wait for memory before proceeding without it.
 *  claude-honcho blocks EVERY turn for up to 120s; we block only the first,
 *  and only this long. */
const FIRST_TURN_BUDGET_MS = 5_000;

interface AgentLike {
  session?: { id?: string; header?: { cwd?: string } };
}

function sessionOf(agent: AgentLike | undefined): [cwd: string | undefined, id: string | undefined] {
  return [agent?.session?.header?.cwd, agent?.session?.id];
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
  const sessionNameFor = (cwd: string | undefined, dshSessionId?: string) =>
    sessionName(resolved, cwd, dshSessionId);

  // Tell the user which configured components this plugin ignores, rather than
  // silently honoring a subset of what their config asks for.
  for (const [name, reason] of unsupportedComponents(resolved.injection)) {
    log(`injection component "${name}" is ignored — ${reason}`);
  }

  const wantsDirectives = resolved.injection.sessionStart.includes("directives");
  /** Without `userContext`, memory is fetched once and never refreshed. */
  const wantsPerTurnRefresh = resolved.injection.perTurn.includes("userContext");
  const wantsDialectic = resolved.injection.perTurn.includes("dialectic");
  const refreshTtlMs = resolved.injection.cadence.ttlSeconds * 1_000;

  // ── capture ──────────────────────────────────────────────────────────────

  // `ctx.sessionQuery` is an abstract seam, and services publish asynchronously:
  // a bare `ctx.get()` during apply() races whichever backend provides it and
  // would disable capture permanently on a lost race. `ctx.inject` waits for the
  // service, re-runs if it is replaced, and tears this down if it goes away —
  // which is the difference between "optional" and "queried too early".
  let capture: Capture | undefined;

  if (resolved.capture.saveMessages) {
    ctx.inject(["sessionQuery"], (scoped) => {
      const sessionQuery = scoped.sessionQuery as unknown as {
        readSession(id: string): Promise<{ session?: { cwd?: string }; events?: readonly unknown[] }>;
      };

      const active = createCapture(resolved, {
        readSession: (id) => sessionQuery.readSession(id) as never,
        honchoSessionName: (cwd, dshSessionId) => sessionNameFor(cwd, dshSessionId),
        upload: (name, messages) => honcho.upload(name, messages),
        onError: (message) => log(`capture: ${message}`),
      });
      capture = active;

      scoped.on("session/event", (session: { id?: string }, event: { type?: string }) => {
        if (!session.id) return;
        if (event.type === "user/message" || event.type === "assistant/message") {
          active.schedule(session.id);
        } else if (event.type === "compaction/start") {
          // The lock brackets the whole operation, so this fires before any
          // history is shadowed. Last chance to capture what is about to go.
          void active.flush(session.id);
        }
      });

      scoped.on("agent/turn-stopping", async (payload: { agent: AgentLike }) => {
        const id = payload.agent.session?.id;
        if (id) await active.flush(id);
      });

      scoped.effect(() => async () => {
        await active.dispose();
        if (capture === active) capture = undefined;
      });

      log("capture on.");
    });
  } else {
    log("capture is off by configuration (capture.saveMessages).");
  }

  // ── injection ────────────────────────────────────────────────────────────

  let disposeMemory: (() => void) | undefined;
  let lastFetchAt: number | undefined;
  let lastFetchError: string | undefined;
  let refreshing: Promise<void> | undefined;
  let suppressed = false;
  /** Latest resolved background dialectic, and the guards around producing it. */
  let dialecticText: string | null = null;
  let dialecticInFlight = false;
  let turnCount = 0;
  let lastContext: Awaited<ReturnType<typeof honcho.fetchContext>> = null;

  if (wantsDirectives) {
    ctx.systemPrompt.section({ name: "honcho:directives", order: DIRECTIVES_ORDER, text: DIRECTIVES });
  }

  // A composition can drop every runtime context — `suppressRuntimeContext()`
  // scope-wide, or `includeRuntimeContext: false` on the system-prompt plugin.
  // Either way injection silently stops working, so watch an actual assembly
  // rather than trusting that our registration is being honored.
  ctx.on("system-prompt/assemble", async (assembly, _context, next) => {
    const result = await next();
    if (disposeMemory) {
      const present = result.contexts.some((c) => c.name === MEMORY_CONTEXT_NAME);
      if (!present && !suppressed) {
        suppressed = true;
        log("runtime context is suppressed by this composition — injected memory is not reaching the model.");
      } else if (present && suppressed) {
        suppressed = false;
      }
    }
    return result;
  });

  async function refreshMemory(
    cwd: string | undefined,
    dshSessionId: string | undefined,
    searchQuery: string,
  ): Promise<void> {
    try {
      const context = await honcho.fetchContext(cwd, dshSessionId, searchQuery || undefined);
      lastContext = context;
      const block = renderMemory(resolved, context, [], dialecticText);
      lastFetchAt = Date.now();
      lastFetchError = undefined;
      if (!block) {
        // Silence here was untraceable: a fetch that succeeds but renders
        // nothing looked identical to one that never ran.
        log(
          `no memory to inject (card=${context?.peerCard?.length ?? 0} ` +
            `summary=${context?.summary ? "y" : "n"} ` +
            `repr=${context?.peerRepresentation?.length ?? 0} chars ` +
            `dialectic=${dialecticText ? "y" : "n"})`,
        );
        return;
      }
      log(`injected ${block.text.length} chars of memory`);
      // Register the RESOLVED text. Nothing is registered until there is
      // something to register, so an empty runtime context — which dsh renders
      // as a visible "Current runtime context: none." line — cannot happen.
      // Dispose BEFORE registering: dsh rejects a duplicate context name within
      // a layer, so register-then-swap throws on every refresh after the first.
      disposeMemory?.();
      disposeMemory = ctx.systemPrompt.context({
        name: MEMORY_CONTEXT_NAME,
        order: MEMORY_ORDER,
        text: block.text,
      });
    } catch (e) {
      lastFetchError = e instanceof Error ? e.message : String(e);
      // Keep the previous registration: stale memory beats none. The failure is
      // visible in `/honcho`, which is why that line exists.
      log(`memory fetch failed: ${lastFetchError}`);
    }
  }

  /** Re-render from the last fetch, so a late dialectic reaches the prompt
   *  without paying for another context() call. */
  function rerender(): void {
    const block = renderMemory(resolved, lastContext, [], dialecticText);
    if (!block) return;
    disposeMemory?.();
    disposeMemory = ctx.systemPrompt.context({ name: MEMORY_CONTEXT_NAME, order: MEMORY_ORDER, text: block.text });
  }

  /** Fire-and-forget: the dialectic is minutes-slow, so nothing ever waits on
   *  it. At cadence N it is a periodic profile refresh, not an answer to the
   *  current message — which is why arriving a turn late is acceptable here and
   *  would not be at cadence 1. */
  function maybeDialectic(cwd: string | undefined, id: string | undefined, query: string): void {
    if (!wantsDialectic || dialecticInFlight) return;
    const every = Math.max(1, resolved.injection.cadence.dialectic);
    if (turnCount % every !== 1 % every) return;
    dialecticInFlight = true;
    void honcho
      .backgroundDialectic(cwd, id, query)
      .then((answer) => {
        if (!answer) return;
        dialecticText = answer;
        rerender();
      })
      .catch((e: unknown) => log(`dialectic failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        dialecticInFlight = false;
      });
  }

  ctx.on("agent/session-start", (payload: { agent: AgentLike }) => {
    // Emit, not awaited — so this only starts the write that materializes the
    // session. The read that turn 1 depends on happens in pre-step below.
    void honcho.ensureSession(...sessionOf(payload.agent)).catch((e: unknown) => {
      log(`session setup failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  ctx.on(
    "agent/pre-step",
    async (
      payload: { agent: AgentLike; messages?: readonly { content?: unknown }[]; step: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      const [cwd, id] = sessionOf(payload.agent);
      const query = textOf(payload.messages);
      const stale = !lastFetchAt || Date.now() - lastFetchAt > refreshTtlMs;
      turnCount += 1;
      maybeDialectic(cwd, id, query);

      if (!lastFetchAt && !lastFetchError) {
        // First request of the session: this waterfall is awaited, so it is the
        // only place memory can land BEFORE the model sees the prompt. Bounded,
        // and only paid once.
        await withTimeout(refreshMemory(cwd, id, query), FIRST_TURN_BUDGET_MS);
      } else if (wantsPerTurnRefresh && stale && !refreshing) {
        // Later turns never block. A turn either gets fresh memory or the
        // previous snapshot.
        refreshing = refreshMemory(cwd, id, query).finally(() => {
          refreshing = undefined;
        });
      }
      return next();
    },
    { prepend: true },
  );

  // ── capture wiring ───────────────────────────────────────────────────────

  // ── tools ────────────────────────────────────────────────────────────────

  if (resolved.injection.tools) {
    for (const tool of createTools(resolved, honcho)) {
      ctx.tools.register(tool);
    }
  }

  // ── command ──────────────────────────────────────────────────────────────

  ctx.inject(["commands"], (scoped) => {
    const commands = scoped.commands as unknown as { register(def: unknown): () => void };
    commands.register(
      createCommand(resolved, {
        capture: () => capture,
        sessionNameFor,
        cwdOf: (agent) => (agent as AgentLike)?.session?.header?.cwd,
        lastFetchAt: () => lastFetchAt,
        lastFetchError: () => lastFetchError,
        injectionActive: () => disposeMemory !== undefined,
        injectionSuppressed: () => suppressed,
        configFile: () => configPath(config.configPath),
      }),
    );
  });

  // ── teardown ─────────────────────────────────────────────────────────────

  ctx.effect(() => async () => {
    // Async disposers ARE awaited on unload. `session/flush` is not a
    // session-end signal and `session/disposed` is emit-only, so this is the
    // one place a final flush is guaranteed to complete. The capture half has
    // its own disposer inside the sessionQuery injection.
    disposeMemory?.();
  });

  log(`ready — workspace ${resolved.workspace}, peer ${resolved.peerName}, ${resolved.observationMode}`);
}

/**
 * `ctx.credentials` is an abstract seam that may be absent, and `resolve()` is
 * async while config loading is synchronous — so only the env layer is read
 * here. A mounted provider's other layers (its own store, `.env` files) are NOT
 * consulted, which means a key that lives only there will not be found; set
 * HONCHO_API_KEY or `auth.apiKey` instead.
 *
 * Closing that gap means making config resolution async, which belongs to the
 * shared integration core this file stands in for rather than being worth
 * restructuring the plugin around first.
 */
function readCredential(ctx: Context, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const credentials = ctx.get("credentials");
  if (!credentials) return process.env[ref];
  return process.env[ref];
}
