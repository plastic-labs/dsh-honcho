# Changelog

## Unreleased

**Fixed.** The built-in redaction let most common secret formats reach Honcho verbatim: 13 of 16 tested
(#14). Captured text now also has JSON and YAML secret fields (`"api_key": "…"`, `password: …`), private key
blocks, JWTs, `Cookie` and `X-Api-Key` headers, `密码是 …` prose, Azure `AccountKey` strings, Slack webhook URLs,
and Stripe, Google and Telegram tokens scrubbed. A bare 40-character AWS secret is still not matched, since it cannot be told apart from a hash.
`max_tokens:` and `pwd:` are left alone.

**Docs.** The README no longer says secrets "are redacted" as a guarantee. It says common formats are, that this
is best-effort, and points at `capture.noisePatterns`.
**Fixed.** An unreachable Honcho killed the whole dsh turn: dsh exited 1 with no output and
`fatal load failure: ConnectionError: fetch failed`. In `backgroundDialectic`, `chat` and `remember`,
`await client()` sat inside a `Promise.all` array after `activePeer()` had already started. It threw while
the array was still being built, so the rejection of `activePeer()` had no handler and Node ended the process.
The client is now awaited first, and a Honcho outage costs a turn its memory, not the turn (#12).

## 0.1.4 — 2026-10-27

**dsh 0.2.1 support.** 0.1.2 would not install on any dsh after 0.2.0-rc.1. dsh rejected it with
`Plugin @honcho-ai/dsh-honcho@0.1.2 is incompatible with dsh 0.2.1-rc.3`, and 0.2.1-rc.3 is the build the
dsh-plugin.org hub installs into from the DeepSeek Harness desktop app (#17, #18). #16 widened the
`@deepseek-ai/dsh-*` peers to admit 0.2.1; they are now a floor, `>=0.1.2-rc.1`, with no cap, so a new dsh
release no longer locks the plugin out (#19). No dsh API the plugin uses changed between 0.2.0-rc.1 and
0.2.1-rc.4. Installed on 0.2.1-rc.2, rc.3 and rc.4, and run on rc.4. The devDependencies move to dsh
`0.2.1-rc.2`, cordis `4.0.5` and schemastery `3.18.5` (#16).

**Fixed.** Failures that `@honcho-ai/sdk` reports as something other than an `Error`, such as a plain response
object, were logged and shown as `[object Object]`. Capture, the memory fetch, the dialectic, session setup,
`/honcho flush` and the three tools now print the failure's message or its JSON (#16).

**Fixed.** Memory containing a `{{…}}` group, such as a GitHub Actions `${{ secrets.DEPLOY_TOKEN }}` or a
Jinja template, made every turn that took a second step fail with `malformed prompt variable reference … in
context "honcho:memory"`, because dsh interpolates prompt variables in runtime contexts. Memory is now
registered with `interpolate: false` and reaches the model verbatim. dsh 0.2.1-alpha.2 and later honor the flag;
earlier dsh ignores it and still fails on such memory (#19).

**Security.** Stored memory could close the `<honcho-memory>` block early. `honcho_remember` content that
contained `</honcho-memory>` came back verbatim in the peer card, summary, representation and dialectic, so
whatever followed it sat outside the block that the directives frame as background, not instructions. The
fence tags are now escaped (`<` becomes `&lt;`) in the injected block and in `honcho_search` and `honcho_chat`
output (#15).

**No 0.1.3.** The version number is skipped: a repackaged copy of 0.1.2 already reports itself as 0.1.3.

## 0.1.2 — 2026-09-28

**dsh 0.1.7 and 0.2.0 support.** 0.1.1 would not install on dsh 0.1.7 or later, and forcing it with
`dsh plugin allow-version` crashed the first turn of any session that had memory to inject
(`format v4 message requires a producer-owned source kind`). Session setup now listens for `agent/created`,
which replaced `agent/session-start` and also fires on resume, clear and compaction. The turn-1 memory message
declares its own `honcho` source kind in place of the removed catch-all `plugin` kind (#9, #10).

**Peer range instead of exact pins.** From 0.1.7, dsh refuses to install or load a plugin whose
`@deepseek-ai/dsh-*` peers don't match the running dsh version, so an exact pin broke on every prerelease. The
peers are now `<=0.2.0-rc.1`, which dsh also matches against every earlier 0.1.x prerelease. Installed and run
on 0.1.2-rc.1, 0.1.5-rc.1, 0.1.7-rc.1, 0.1.7-rc.2 and 0.2.0-rc.1. cordis and schemastery, which dsh does not
check, move to `~4.0.2` and `~3.18.2`. The devDependencies stay exact, now at `0.2.0-rc.1`, so the typecheck
runs against the newest dsh.

**Docs.** Mandarin and Russian READMEs (#11).

## 0.1.1 — 2026-09-17

**Telemetry.** Every Honcho request now carries `X-Honcho-Host` (`dsh/<harness version> (<platform>)`),
`X-Honcho-Plugin` (`dsh-honcho/<version>`), and `X-Honcho-Agent-Model` (`<provider>/<model>`, once dsh has
named one — which is one request before the first answer). The harness version is read off the installation,
since dsh exposes it to a plugin nowhere else, and the model from the durable session log, so a mid-session
switch is reflected on the next request. `/honcho` shows the identity as a `client` line. Formatting comes
from `@honcho-ai/harness-plugin-core` 0.1.1, the first release a Node-hosted plugin can import.

**Session naming across machines.** `sessionStrategy: "git-remote"` names the session from the repo's `origin`
URL, normalized to `host/owner/repo`, so one repo cloned on two machines is one session and two projects that
share a folder name are not merged. Scheme, `user@`, credentials, a port, `.git` and scp-style `:` all fold
away; an ssh `Host` alias spelled differently per machine is the one difference it cannot reconcile. It falls
back to `per-directory` outside a repo, without an `origin`, or without git. `sessionPrefix` (default empty)
puts a literal string such as `vps-` in front of every generated name; a name pinned in `sessions` is never
prefixed.

**Packaging.** `main` and the `.` export now point at a committed root `index.js` that forwards to the build
in `lib/`, so catalogs that verify a plugin from its git tree can resolve the entry. This landed just after
0.1.0 went to npm, so it reaches users for the first time here.

## 0.1.0 — 2026-09-02

First release. Honcho memory for DeepSeek Harness, as a native Cordis plugin.

**Fixed.** `/honcho`, `/honcho config`, and `/honcho flush` failed with `handler must return a
CommandResult`. Results now carry the `kind` discriminator dsh requires.

**Fixed.** `/honcho flush` reported success when the upload had failed. It now returns an error, and
`/honcho` shows the last upload error until the next successful sync.

**Fixed.** A Honcho outage at boot was permanent. `@honcho-ai/sdk` 2.4.0 caches a rejected
workspace promise, so the gateway now keeps a client only once its first call has succeeded.

**Memory injection.** Session profile, summary, and the relevant slice of the Honcho
representation are injected through `ctx.systemPrompt.context()`, dsh's cache-safe dynamic-context
slot. One `session.context()` call fetches all three, using the current message as a semantic search
query so recall is associative rather than merely recent. The first request waits up to 5s for
memory; later turns refresh in the background and never block. Selectable per component via
`injection.sessionStart` and `injection.perTurn`.

**Turn capture.** User and assistant turns ride `session/event` — no transcript parsing — and are
debounced, then flushed at turn boundaries, before compaction, and on shutdown. Capture is
cursor-based rather than queued: dsh's session log is already durable, so a per-session event-count
high-water-mark is persisted and the unsent slice re-derived on each flush, which makes retry across
network failure fall out for free. Secrets are redacted before upload, extensible via
`capture.redactPatterns`. Optional one-line tool-activity summaries under `capture.saveToolUse`.

**Tools.** `honcho_search` (messages and derived conclusions in parallel), `honcho_chat`,
`honcho_remember`.

**Commands.** `/honcho` for status, `/honcho config` for resolved settings, `/honcho flush` to sync
now.

**Configuration.** Reads the shared `~/.honcho/config.json` under `hosts.dsh`, so memory is shared
with the other Honcho integrations. Five session-naming strategies, `<peer>-<dir>` by default to
match claude-honcho.

**Skill.** `honcho-memory`, served from the packaged skills directory.

## Known limitations

- Only the environment layer of the `ctx.credentials` seam is read, because config resolution is
  synchronous and `resolve()` is not. Set `HONCHO_API_KEY` or `auth.apiKey`.
- `globalOverride` from the legacy config shape is not supported; it inverts the resolution order.
- No Web Client surface yet — no statusline, tool cards, or settings panel.
