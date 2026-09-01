# Architecture

How `dsh-honcho` is built, and why each piece is where it is. For usage, see the
[README](README.md).

Verified against DeepSeek Harness `0.1.2-alpha.3`, `@deepseek-ai/cordis` `4.0.2`, and
`@honcho-ai/sdk` `2.4.0`. Claims below carry `file:line` where they were checked against source.

---

## Shape: a native Cordis plugin

dsh is "everything is a plugin" on [Cordis](https://github.com/cordiverse/cordis). This is an ordinary plugin
exporting `apply(ctx, config)`, distributed as a bundle (`dsh.bundle` in `package.json` pointing at
`cordis.patch.yml`).

dsh also ships `@deepseek-ai/dsh-hooks-claude-code`, which can run an existing Claude Code `hooks.json` against
its extension points. Pointing that at `claude-honcho`'s hooks would have been the zero-code option, and it was
rejected: **23 of Claude Code's 30 hook events are unsupported**, including `PreCompact` and `SessionEnd`; only
shell-form command handlers run, one process per hook per event; one process-level `configPath` is read once at
startup; and `SessionStart` runs detached, so "context can miss the first request". Its own README calls it "a
compatibility adapter, not a power tool… bespoke behavior belongs in a native plugin on the same extension
points." (`packages/hooks/hooks-claude-code/README.md`)

---

## Extension points

Each behavior is a listener on one documented seam.

| Behavior | Seam | Mode | Note |
|---|---|---|---|
| Materialize the Honcho session | `agent/session-start` | emit | **Not awaited.** Re-fires on `clear` and `compact`. |
| Fetch + register memory | `agent/pre-step` | waterfall | Awaited. The only seam that runs before the first model request. |
| Capture user turns | `session/event` → `user/message` | emit | Filtered on `source.kind` — see below. |
| Capture assistant turns | `session/event` → `assistant/message` | emit | Envelope is `{ turn, step, message }`. |
| Capture tool activity | `session/event` → `tool/call` | emit | Under `capture.saveToolUse`; no extra listener, just a wider selection. |
| Flush before context loss | `session/event` → `compaction/start` | emit | The lock brackets the whole operation. |
| Flush at the turn boundary | `agent/turn-stopping` | serial | Awaited before the boundary commits. |
| Final flush | `ctx.effect` disposer | — | See "Teardown". |
| Tools | `ctx.tools.register` | — | Three; see "Tools". |
| `/honcho` | `ctx.commands.register` | — | Executes without creating a model message. |
| Skill | `skill-filesystem` `customSkillDirs` | — | Zero code; a config row. |

`inject = ["tools", "systemPrompt"]` are hard requirements. `sessionQuery`, `commands`, and `credentials` are
queried with `ctx.get()` at their use site, because each is an abstract seam that a deployment may not have
mounted — a missing one degrades that feature instead of refusing to load the plugin.

### Teardown

There is exactly one awaited teardown, and it is the `ctx.effect` disposer. `session/flush` is **not** a
session-end signal — it is an ad-hoc durability checkpoint that fires only when someone calls
`SessionStore.flush()`, which compaction, ACP, and the headless bundle do but the interactive path does not
(`packages/bundle/headless/src/index.ts:199`). `session/disposed` and `agent/disposed` are emit, so nothing
awaits them (`packages/core/session/src/index.ts:62`). Async disposers *are* awaited on unload
(`docs/cordis-api/fiber.md:301`), so that is where the final flush lives.

---

## Injection

Three surfaces.

**Directives** — a `ctx.systemPrompt.section()`. Constant for the process, so it sits in the cached prompt
prefix at no recurring cost.

**Ambient memory** — profile, session summary, and the relevant slice of the representation, via
`ctx.systemPrompt.context()`. This is dsh's cache-safe dynamic-context slot: it lands *after* retained history
and is logged only when it changed, where a prompt section would invalidate the whole KV-cache prefix.

**Dialectic is deliberately not injected.** It is a question asked about the *current* message, so a
background-refreshed snapshot would answer the previous turn's question inside this turn's prompt, with no
marker saying so. It is a tool instead, where it runs against the actual question and its latency is visible.

### Registering resolved text, not a cache read

`PromptContext.text` accepts `string | ((ctx) => string)` and the callback form is **synchronous**
(`packages/core/system-prompt/src/index.ts:83`), while Honcho calls are not. Rather than have a sync callback
read an async-refreshed cache, we fetch first and register the resolved string —
`ctx.systemPrompt.context()` returns a disposer, so an update is dispose-then-re-register.

That removes three failure modes structurally rather than by guard:

- **No cold cache.** Nothing is registered until there is something to register, so dsh's visible
  `Current runtime context: none. Earlier runtime-context snapshots no longer apply.` line
  (`packages/core/agent-loop/src/runtime-context.ts:13,66`) cannot be emitted.
- **No sync/async impedance** — the callback form is unused.
- **No stale-vs-fresh ambiguity** inside one assembly.

Two constraints remain: all contributors join into **one** snapshot ordered by `order`, and a composition can
drop runtime context entirely — `ctx.systemPrompt.suppressRuntimeContext()` scope-wide, or
`includeRuntimeContext: false` on the system-prompt plugin. Either way injection silently stops working, so a
`system-prompt/assemble` listener checks whether our context actually survived into a real assembly and warns
once if it did not. `/honcho` reports it too.

Section and context orders are plain numbers rather than `getSectionOrder`/`getContextOrder`, which do not
exist in every supported dsh version. The directives section sits at 650, between the harness's `TEAM_POLICY`
(600) and `PTC_ONLY` (800) — 500 would collide with `PLAN_POLICY`. Runtime contexts are centrally allocated
only up to 120, so memory at 500 sorts last among them.

### Turn 1

`agent/session-start` is `emit`, so it is not awaited (`packages/core/agent/src/runtime-types.ts:224`), and an
async fetch started there can resolve after turn 1's `pre-step` has claimed its batch. `agent.inject()` carries
the same caveat in its own docs — "may miss a request whose pre-step already claimed its batch"
(`runtime-types.ts:141-148`). That is precisely the defect that disqualified the hook bridge, and it is
reproducible natively.

So the fetch happens in `agent/pre-step`, which is a waterfall and therefore awaited. It also carries the
incoming messages, which supply the semantic search query — one seam, both properties. The first request waits
up to **5 seconds**; every later turn refreshes in the background and never blocks. For comparison,
claude-honcho's per-turn hook budgets `DIALECTIC_TIMEOUT_MS = 120000` against a 125s ceiling and says so in
its own comment: "the user's turn blocks for up to this long when dialectic is enabled"
(`claude-honcho/plugins/honcho/src/hooks/user-prompt.ts:55-64`).

The trade is observability: a fetch that errors or times out reuses the previous snapshot, which is
indistinguishable from success. `/honcho` reports `last fetch` and the last error for exactly that reason.

### What gets fetched, and what gets stripped

One call. `session.context({ peerTarget, peerPerspective, representationOptions })` returns messages, summary,
`peerRepresentation`, and `peerCard` together (`repos/honcho/src/schemas/api.py:499-512`).

- The current user message is passed as `searchQuery`, making recall associative rather than merely recent.
- **`limitToSession` is deliberately not set.** It "narrows recall the same way `sessions` does: explicit-only
  conclusions, and the peer card is omitted because it carries no per-session provenance"
  (`repos/honcho/src/routers/sessions.py:740-744`) — discarding exactly the cross-session synthesis the Deriver
  and Dreamer produce.
- Representations are filtered before injection: `**Pattern** [medium]` and `[low]` blocks go entirely, as do
  `Type:`, `Sources:`, and `Premises:` provenance lines. The model needs the high-confidence claims, not the
  evidence chain it still pays tokens for.
- Parts are assembled under a character budget by priority — **peer card > session summary > representation** —
  whole or not at all, because a representation cut mid-observation is noise.
- `injection.sessionStart` selects which parts appear at all, and `injection.perTurn` decides whether the
  snapshot is refreshed as the conversation moves or pinned at session start. Components in the canonical
  schema that this plugin does not implement are reported at startup instead of being silently dropped.

---

## Capture

```
session/event ─┬─ user/message      ─▶ source filter ─▶ redact ─▶ cursor
               ├─ assistant/message ─▶ redact ─▶ cursor
               └─ compaction/start  ─▶ flush now
agent/turn-stopping                 ─▶ flush
effect disposer (awaited)           ─▶ flush
```

### The source filter

dsh commits runtime-context snapshots, `agent.inject()` context, and compaction summary replacements as durable
`user/message` events carrying `source: { kind: 'plugin', … }`
(`packages/core/agent-loop/src/runtime-context.ts:73`). A naive `user/message` subscription therefore **uploads
Honcho's own injected memory back into Honcho**, a closed loop that degrades the representation every turn.

Capture filters on `source.kind === "user"` (`packages/llm/llm/src/message.ts:102-107`), then additionally
drops harness-injected prompts — system reminders, task notifications, command envelopes — or every wake-up
lands in memory as something the user said.

### Cursor, not queue

dsh already owns a durable, replayable session log, and `ctx.sessionQuery.readSession(id)` returns it
(`packages/session-query/session-query/src/index.ts:165`). So there is no message queue: there is a **cursor**,
an event count persisted to `~/.honcho/dsh/cursors.json` and advanced only after a successful upload. Each
flush re-derives the unsent slice with `events.slice(sent)`.

**The cursor is keyed by dsh session id, not by Honcho session name**, and the distinction is load-bearing.
Many dsh sessions map to one Honcho session: every `dsh --profile headless` invocation opens a new one, and so
does each fresh chat in the same directory. Their event logs are independent and each starts at zero, so a
counter shared across them compares the second run's event count against the first run's high-water mark and
silently uploads nothing. Verified on a real VM — three headless runs in one directory produced three session
logs (82, 90, and 66 events) all targeting the Honcho session `<peer>-<dir>`. Only the dsh session id is a key
under which "events already uploaded" means anything; the Honcho session name is the upload *target*, nothing
more. Entries are pruned after 14 days, and the older bare-number file shape is still read so an upgrade does
not re-upload a session's whole history.

Retry across network failure, crash durability, and torn-write tolerance all fall out of that, with no queue
format to own. A failed upload leaves the cursor where it was, so the slice retries on the next flush.

`ctx.sessionQuery` is an abstract seam (`docs/subsystems/session-query.md:369`) and may be absent; capture is
then disabled and injection and tools continue.

### Redaction

Every captured message is scrubbed before upload, using the rules ported from `claude-honcho/src/redact.ts`
plus any user `capture.noisePatterns`. A coding harness holds whatever is on screen — pasted keys, `.env`
contents, customer data — so capture without scrubbing is an exfiltration path, and the two ship together.

### Subagents

Global `session/event` listeners see subagent sessions too; scope filtering narrows only agent-scoped listeners
(`packages/core/session/src/index.ts:74`). Subagents read the parent's context and write nothing, matching
`observe_others: true / observe_me: false`.

---

## Configuration

`~/.honcho/config.json`, shared with `claude-honcho`, `codex-honcho`, and the other integrations. Root holds
identity and connection; `hosts.dsh` holds behavior. Resolution:

```
HONCHO_* env
  ▶ credential seam (when mounted)
  ▶ hosts.dsh.<key>
  ▶ root (identity + connection + switches only)
  ▶ bucket default (coding → observationMode: unified)
  ▶ built-in
```

Two deliberate omissions:

- **`globalOverride` is unsupported.** Both legacy readers implement it as a root boolean that *inverts* this
  ladder (`claude-honcho/src/config.ts:324-327`), so the resolved workspace can differ from what the file
  appears to say.
- **Legacy behavioral keys at root are ignored.** Only `apiKey` and `endpoint` are read in their legacy
  spelling, because those are the two still legal at root under the canonical shape. This is the rule that
  keeps `core-shim.ts` deletable — `claude-honcho`'s `config.ts` is 1,014 lines and legacy support is most of
  why.

`baseUrl` is normalized by **stripping** any `/v3` suffix, not adding one: the SDK builds its own `/v3` request
paths (`@honcho-ai/sdk/dist/client.js:122`), so a suffixed base URL double-versions behind a path-prefixed
proxy.

The plugin's own `cordis.yml` schema carries plumbing only — `configPath`, `apiKeyRef`, `host`, `enabled`.
Duplicating Honcho's keys into YAML would fork a source of truth shared by six integrations.

### Sessions

`<peerName>-<dir>`, matching claude-honcho's `deriveSessionName` (`plugins/honcho/src/config.ts:778`) so
sessions line up across integrations. An explicit root `sessions[cwd]` entry always wins.
`SessionHeader.cwd` is optional (`packages/core/session/src/types.ts:68`), so its absence falls back rather
than assuming `process.cwd()` — dsh sessions can be remote or sandboxed.

All five canonical strategies are implemented — `per-directory`, `per-repo`, `git-branch`, `per-session`,
`global` — and an unrecognized value throws at load rather than silently doing something else. Two details
worth keeping: `git-branch` collapses to the per-directory name outside a repo or on a detached HEAD rather
than inventing a placeholder that would fork memory; and `per-session` strips dsh's `session-` id prefix
instead of truncating, because dsh mints ids as `session-<n>` and a fixed truncation maps every session to one
name.

Honcho's guidance is still not to scope sessions too thin: the Deriver needs a single session to accumulate
enough material to reason over, and both `git-branch` and `per-session` split a project's memory.

---

## Tools

Three. `claude-honcho` registers eleven by default and a community dsh plugin shipped twenty-five before
cutting to four for context efficiency; every schema costs tokens on every request.

| Tool | Notes |
|---|---|
| `honcho_search` | Fans out to message search **and** conclusion query in parallel. Messages alone miss everything the Deriver and Dreamer inferred. |
| `honcho_chat` | Dialectic. Slow by nature — the tool description says so, because the model should choose it deliberately. |
| `honcho_remember` | Writes a conclusion. |

Deferred: `get_context` (injection already puts it in the prompt), `get_briefing` (`/honcho` plus a fetch), and
the config/list/delete tools (`/honcho`, not model vocabulary).

`observationMode` is not a one-line default — it rewires every call. Unified routes through the user peer with
no target; directional routes through the AI peer with the user as target and changes which peer owns the
conclusion scope (`claude-honcho/plugins/honcho/src/mcp/server.ts:1097-1103`). That routing lives in
`src/honcho.ts` so it is expressed once.

Tools are registered through `defineTool`, which handles strict JSON-Schema parameter shapes and the
content-block `render` contract that raw `ToolDefinition` registration makes you hand-write. Note that
`presentCall`/`presentResult` buy nothing in the shipped Web Client without a client-half plugin registering
into the `tool.call.toolview` slot (`docs/cookbook/adding-a-tool.md`).

---

## Layout

```
src/index.ts       seam wiring, and nothing else
src/core-shim.ts   config resolution + client factory — TEMPORARY, see below
src/honcho.ts      SDK gateway; observationMode routing lives here
src/memory.ts      fetch shaping: representation filter, priority assembly
src/capture.ts     source filter, cursor, debounce, flush
src/redact.ts      ported from claude-honcho
src/tools.ts       three tools
src/commands.ts    /honcho, /honcho config, /honcho flush
src/git.ts         branch + repo root for session naming (core's job eventually)
```

`core-shim.ts` is deliberately temporary. It stands in for the shared integration core's canonical config
resolution and client factory; when that ships, the file is deleted and the same shape is imported from core.
Everything else routes config through it so the swap is one import edit.

---

## Versions

Every dependency is pinned exactly, for two reasons. dsh states "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"
(`README.md:13`). And the `@deepseek-ai/dsh-*` **`latest` dist-tag is stale** at `0.0.1-rc.1` while the current
publish is `0.1.2-alpha.3`, so an unpinned install silently gets a months-old placeholder.

`getSectionOrder`/`getContextOrder` exist in `0.1.2-alpha.3` but not `0.1.1-rc.2`. Plain order constants are
used instead — they work on every version and nothing competes for those slots.

`bunfig.toml` exempts `@deepseek-ai/*` and `@honcho-ai/*` from a machine-wide `minimumReleaseAge` gate, by
explicit name: wildcards are not supported, and a project bunfig **replaces** that key rather than merging it,
so a globally-exempted package has to be restated locally.
