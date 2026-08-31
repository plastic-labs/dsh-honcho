/**
 * `/honcho` — human commands, executed against the agent without creating a
 * model message.
 *
 * `last successful sync` is not decoration. Injection is fire-and-forget and a
 * failed fetch reuses the previous snapshot, so a Honcho outage otherwise looks
 * exactly like a working plugin. This is where that becomes visible.
 */

import { sessionUrl, unsupportedComponents, type ResolvedConfig } from "./core-shim.js";
import type { Capture } from "./capture.js";

export interface CommandDeps {
  capture: Capture;
  sessionNameFor(cwd: string | undefined): string;
  cwdOf(agent: unknown): string | undefined;
  /** Timestamp of the last successful memory fetch, or undefined. */
  lastFetchAt(): number | undefined;
  /** Message from the last failed memory fetch, if the latest attempt failed. */
  lastFetchError(): string | undefined;
  injectionActive(): boolean;
  /** True when a deployment or agent preset is suppressing runtime context. */
  injectionSuppressed(): boolean;
  /** Path the shared config file was read from. */
  configFile(): string;
}

function ago(at: number | undefined): string {
  if (!at) return "never";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export interface CommandDefinition {
  name: string;
  description: string;
  input: { hint: string };
  handler(invocation: { agent: unknown; rawInput?: string }): Promise<{ text: string }>;
}

export function createCommand(config: ResolvedConfig, deps: CommandDeps): CommandDefinition {
  return {
    name: "honcho",
    description: "Honcho memory status. `config` shows resolved settings, `flush` syncs now.",
    input: { hint: "config | flush" },
    async handler({ agent, rawInput }) {
      const sub = (rawInput ?? "").trim().toLowerCase();
      const cwd = deps.cwdOf(agent);
      const name = deps.sessionNameFor(cwd);

      if (sub === "flush") {
        try {
          await deps.capture.flushAll();
          return { text: `Flushed to Honcho session \`${name}\`.` };
        } catch (e) {
          return { text: `Flush failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }

      if (sub === "config") {
        // Resolved values, not per-key provenance: tracking the source layer for
        // every key roughly doubles the resolver, and the file path plus the
        // resolution order in the docs answers the same question.
        const redacted = { ...config, apiKey: config.apiKey ? `${config.apiKey.slice(0, 7)}…` : "(unset)" };
        const ignored = unsupportedComponents(config.injection);
        const lines = [
          `config file  ${deps.configFile()}`,
          "",
          JSON.stringify(redacted, null, 2),
        ];
        if (ignored.length) {
          lines.push("", "ignored injection components:");
          for (const [name, reason] of ignored) lines.push(`  ${name} — ${reason}`);
        }
        return { text: lines.join("\n") };
      }

      if (sub && sub !== "status") {
        return { text: `Unknown subcommand \`${sub}\`. Use \`/honcho\`, \`/honcho config\`, or \`/honcho flush\`.` };
      }

      const fetchError = deps.lastFetchError();
      const lines = [
        `peer         ${config.peerName}`,
        `ai peer      ${config.aiPeer}`,
        `workspace    ${config.workspace}`,
        `session      ${name}`,
        `endpoint     ${config.baseUrl}`,
        `observation  ${config.observationMode}`,
        `strategy     ${config.sessionStrategy}`,
        `capture      ${config.capture.saveMessages ? "on" : "off"}${config.capture.saveToolUse ? " +tools" : ""} · ${deps.capture.pending()} pending · last sync ${ago(deps.capture.lastFlushedAt())}`,
        `injection    ${deps.injectionActive() ? "active" : "inactive"} · last fetch ${ago(deps.lastFetchAt())}`,
      ];
      if (deps.injectionSuppressed()) {
        lines.push("⚠ runtime context is suppressed by this composition — injected memory is not reaching the model");
      }
      if (fetchError) lines.push(`⚠ last fetch failed: ${fetchError}`);
      if (!config.apiKey) lines.push("⚠ no API key — set HONCHO_API_KEY or auth.apiKey in ~/.honcho/config.json");
      lines.push("", sessionUrl(config.workspace, name));
      return { text: lines.join("\n") };
    },
  };
}
