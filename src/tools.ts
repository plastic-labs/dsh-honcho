/**
 * Model-facing Honcho tools.
 *
 * Three, deliberately. claude-honcho registers eleven and the community
 * dsh plugin shipped twenty-five before cutting to four for context efficiency
 * — every schema costs tokens on every request. `get_context` is redundant with
 * what injection already puts in the prompt, and the config/list/delete tools
 * belong in `/honcho`, not in the model's vocabulary.
 */

import type { ResolvedConfig } from "./core-shim.js";

/** Honcho SDK surface we depend on, narrowed to what these tools call. */
export interface HonchoGateway {
  /** Reasoned dialectic answer about a peer. Slow — 2–5 minutes is normal. */
  chat(query: string, options: { targetPeerId?: string; sessionId?: string }): Promise<string>;
  /** Full-text/semantic search over messages. */
  searchMessages(query: string, limit: number): Promise<string[]>;
  /** Semantic search over derived conclusions — the reasoned layer. */
  searchConclusions(query: string, limit: number): Promise<string[]>;
  /** Persist a durable fact about the user. */
  remember(content: string, sessionName: string): Promise<void>;
  currentSessionName(cwd?: string, dshSessionId?: string): string;
}

/** Shape accepted by `defineTool` from `@deepseek-ai/dsh-tools`. Declared
 *  structurally so this module does not need the dsh types at runtime. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: { text: string }): { type: "text"; text: string }[];
  };
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<{ text: string }>;
}

interface ToolExec {
  agent?: { session?: { id?: string; header?: { cwd?: string } } };
}

const textOutput = {
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  // dsh requires an ARRAY of content blocks here; returning a bare string
  // fails at runtime with "content is not iterable".
  render: (_args: unknown, value: { text: string }) => [{ type: "text" as const, text: value.text }],
};

function sessionOf(exec: ToolExec): [cwd: string | undefined, id: string | undefined] {
  return [exec.agent?.session?.header?.cwd, exec.agent?.session?.id];
}

export function createTools(config: ResolvedConfig, honcho: HonchoGateway): ToolSpec[] {
  return [
    {
      name: "honcho_search",
      description:
        "Search the user's Honcho memory across all past sessions. Returns both raw messages and derived " +
        "conclusions. Use when you need history beyond what was already injected into context.",
      parameters: {
        query: { type: "string", required: true, description: "What you are looking for." },
        limit: { type: "number", description: "Results per source (default 5, max 10)." },
      },
      output: textOutput,
      async execute(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
        const query = String(args.query ?? "");
        // Both layers, in parallel. Messages alone miss everything the Deriver
        // and Dreamer inferred; conclusions alone miss what was actually said.
        const [messages, conclusions] = await Promise.all([
          honcho.searchMessages(query, limit).catch((e: unknown) => [`[message search failed: ${errText(e)}]`]),
          honcho.searchConclusions(query, limit).catch((e: unknown) => [`[conclusion search failed: ${errText(e)}]`]),
        ]);
        const lines = [...messages, ...conclusions];
        return { text: lines.length ? lines.join("\n") : "No results in messages or conclusions." };
      },
    },
    {
      name: "honcho_chat",
      description:
        "Ask Honcho a reasoned question about the user, answered over everything it has learned across all " +
        "sessions. Slower than honcho_search (often 30s+, occasionally minutes) — use for questions of " +
        "judgment or preference, not for lookups.",
      parameters: {
        query: { type: "string", required: true, description: "The question about the user." },
      },
      output: textOutput,
      async execute(args, exec) {
        const sessionName = honcho.currentSessionName(...sessionOf(exec));
        // observationMode decides who is asking about whom: unified queries the
        // user peer directly; directional asks from the AI peer's perspective.
        const targetPeerId = config.observationMode === "directional" ? config.peerName : undefined;
        try {
          const answer = await honcho.chat(String(args.query ?? ""), { targetPeerId, sessionId: sessionName });
          return { text: answer.trim() || "Honcho has nothing relevant on that yet." };
        } catch (e) {
          return { text: `Honcho could not answer: ${errText(e)}` };
        }
      },
    },
    {
      name: "honcho_remember",
      description:
        "Save a durable fact, preference, or decision about the user to Honcho so it survives into future " +
        "sessions. Use when the user states something worth carrying forward, not for transient task detail.",
      parameters: {
        content: { type: "string", required: true, description: "The fact to remember, in one sentence." },
      },
      output: textOutput,
      async execute(args, exec) {
        const content = String(args.content ?? "").trim();
        if (!content) return { text: "Nothing to remember — `content` was empty." };
        try {
          await honcho.remember(content, honcho.currentSessionName(...sessionOf(exec)));
          return { text: "Saved to Honcho memory." };
        } catch (e) {
          return { text: `Could not save to Honcho: ${errText(e)}` };
        }
      },
    },
  ];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
