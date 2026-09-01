# Changelog

## 0.1.0 — unreleased

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

### Known limitations

- Only the environment layer of the `ctx.credentials` seam is read, because config resolution is
  synchronous and `resolve()` is not. Set `HONCHO_API_KEY` or `auth.apiKey`.
- `globalOverride` from the legacy config shape is not supported; it inverts the resolution order.
- No Web Client surface yet — no statusline, tool cards, or settings panel.
