/**
 * Model-facing Honcho tools.
 *
 * Three, deliberately. claude-honcho registers eleven and the community
 * dsh plugin shipped twenty-five before cutting to four for context efficiency
 * — every schema costs tokens on every request.
 *
 * These go through `defineTool`, NOT a raw `ToolDefinition`. The two accept
 * different shapes: `defineTool` takes a per-property DSL that it compiles into
 * an implicit object root, while `ctx.tools.register()` on its own expects
 * finished JSON Schema. Handing the DSL straight to `register()` produces a
 * schema with no `properties`, so the model can call the tool but cannot pass
 * it anything — every call arrives with empty arguments.
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
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

/**
 * Canonical output for all three: one text field the renderer surfaces.
 * A fresh object per tool so each `defineTool` call infers its own arg type;
 * `additionalProperties` is required on an object value schema.
 */
function textOutput() {
  return {
    schema: {
      type: "object",
      // Required-ness is per-property here; the value schema DSL rejects a
      // top-level `required` array (typecheck accepts it, the runtime does not).
      properties: { text: { type: "string", required: true } },
      additionalProperties: false,
    },
    // dsh requires an ARRAY of content blocks here; a bare string fails at
    // runtime with "content is not iterable".
    render: (_args: unknown, value: { text: string }) => [{ type: "text" as const, text: value.text }],
  } as const;
}

function sessionOf(exec: ToolRunContext): [cwd: string | undefined, id: string | undefined] {
  const session = (exec.agent as { session?: { id?: string; header?: { cwd?: string } } } | undefined)?.session;
  return [session?.header?.cwd, session?.id];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createTools(config: ResolvedConfig, honcho: HonchoGateway): ToolDefinition[] {
  return [
    defineTool({
      name: "honcho_search",
      description:
        "Search the user's Honcho memory across all past sessions. Returns both raw messages and derived " +
        "conclusions. Use when you need history beyond what was already injected into context.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "The search query to find relevant information from past sessions.",
        },
        limit: { type: "number", description: "Results per source (default 5, max 10)." },
      },
      output: textOutput(),
      async execute(args) {
        const query = args.query.trim();
        if (!query) return { text: "Search query was empty." };
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
        // Both layers, in parallel. Messages alone miss everything the Deriver
        // and Dreamer inferred; conclusions alone miss what was actually said.
        const [messages, conclusions] = await Promise.all([
          honcho.searchMessages(query, limit).catch((e: unknown) => [`[message search failed: ${errText(e)}]`]),
          honcho.searchConclusions(query, limit).catch((e: unknown) => [`[conclusion search failed: ${errText(e)}]`]),
        ]);
        const lines = [...messages, ...conclusions];
        return { text: lines.length ? lines.join("\n") : "No results in messages or conclusions." };
      },
    }),

    defineTool({
      name: "honcho_chat",
      description:
        "Ask Honcho a reasoned question about the user, answered over everything it has learned across all " +
        "sessions. Use for questions of judgment or preference — how they like to work, what they would " +
        "prefer — rather than for looking up something that was said.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "The question to ask about the user based on their history.",
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const query = args.query.trim();
        if (!query) return { text: "Question was empty." };
        const sessionName = honcho.currentSessionName(...sessionOf(exec));
        // observationMode decides who is asking about whom: unified queries the
        // user peer directly; directional asks from the AI peer's perspective.
        const targetPeerId = config.observationMode === "directional" ? config.peerName : undefined;
        try {
          const answer = await honcho.chat(query, { targetPeerId, sessionId: sessionName });
          return { text: answer.trim() || "Honcho has nothing relevant on that yet." };
        } catch (e) {
          return { text: `Honcho could not answer: ${errText(e)}` };
        }
      },
    }),

    defineTool({
      name: "honcho_remember",
      description:
        "Save a durable fact, preference, or decision about the user to Honcho so it survives into future " +
        "sessions. Use when the user states something worth carrying forward, not for transient task detail.",
      parameters: {
        content: {
          type: "string",
          required: true,
          description: "The information to remember about the user for future sessions.",
        },
      },
      output: textOutput(),
      async execute(args, exec) {
        const content = args.content.trim();
        if (!content) return { text: "Nothing to remember — `content` was empty." };
        try {
          await honcho.remember(content, honcho.currentSessionName(...sessionOf(exec)));
          return { text: "Saved to Honcho memory." };
        } catch (e) {
          return { text: `Could not save to Honcho: ${errText(e)}` };
        }
      },
    }),
  ];
}
