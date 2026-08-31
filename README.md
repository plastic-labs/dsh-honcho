# dsh-honcho

Persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), powered by
[Honcho](https://honcho.dev).

`dsh` forgets everything when a session ends. This plugin gives it memory that doesn't: what you're building,
how you like to work, what you decided last week and why. Memory is shared with the other Honcho integrations
through one config file, so what Claude Code learns about you, `dsh` knows too.

## Install

```sh
dsh plugin --profile <name> add @honcho-ai/dsh-honcho
```

Then put your API key and name in `~/.honcho/config.json`:

```jsonc
{
  "peerName": "your-name",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "hosts": {
    "dsh": { "workspace": "dsh" },
  },
}
```

Get a key at [app.honcho.dev](https://app.honcho.dev). `HONCHO_API_KEY` in the environment also works on its
own — the config file is only needed to change defaults.

## What it does

**Injects what Honcho knows at the start of a session** — your profile, a summary of this project's session so
far, and the conclusions Honcho has drawn that are relevant to what you just asked. One API call, shaped to a
character budget, refreshed as you work.

**Captures every turn.** User and assistant messages go to Honcho in the background, debounced, and flushed at
turn boundaries, before compaction, and on shutdown. Secrets are redacted first.

**Gives the model three tools:**

| Tool              | For                                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| `honcho_search`   | Looking something up. Searches raw messages _and_ derived conclusions.     |
| `honcho_chat`     | Asking a question of judgment. Reasons over everything Honcho knows. Slow. |
| `honcho_remember` | Saving a durable fact, preference, or decision.                            |

**`/honcho`** shows status and a link to the session in the Honcho dashboard — see Commands below.

## Configuration

Everything behavioral lives in `~/.honcho/config.json` under `hosts.dsh` — the same file `claude-honcho`,
`codex-honcho`, and the other integrations read. Root holds identity and connection; the host block holds
behavior.

```jsonc
{
  "peerName": "your-name",
  "workspace": "honcho",
  "baseUrl": "https://api.honcho.dev", // bare host or …/v3 both fine
  "timeoutMs": 30000,
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "enabled": true, // global kill switch
  "sessions": { "/path/to/repo": "pinned-session-name" },

  "hosts": {
    "dsh": {
      "workspace": "dsh",
      "aiPeer": "dsh", // defaults to the host name
      "observationMode": "unified", // unified | directional
      "sessionStrategy": "per-directory", // see Sessions below
      "sessionPeerPrefix": true, // session names are <peer>-<dir>
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"], // + representation
        "perTurn": ["userContext"], // [] pins memory to the session-start snapshot
        "tools": true,
        "searchTopK": 10,
        "searchMaxDistance": 0.6,
        "maxConclusions": 15,
        "contextTokens": 1500,
        "injectionMaxChars": 4000,
        "reprMaxObs": 4,
        "cadence": { "ttlSeconds": 300 }, // how long a snapshot is reused
      },
      "capture": {
        "saveMessages": true,
        "saveToolUse": false, // one-line summaries of tool activity
        "redactPatterns": [], // additive to the built-in secret patterns
        "debounceMs": 3000,
        "messageMaxChars": 25000,
      },
    },
  },
}
```

### Injection components

`injection.sessionStart` selects what appears in the injected block: `directives` (guidance on using memory),
`summary`, `peerCard`, and `representation`. Drop what you don't want to pay for — `["directives", "peerCard"]`
gives a profile and nothing else.

`injection.perTurn` containing `userContext` re-fetches as you work, using your current message as the search
query so recall is associative rather than merely recent. Set it to `[]` to fetch once at session start and
never again.

The canonical schema names components this plugin doesn't implement — `briefing`, `assistantContext`,
`sessionContext`, and `dialectic`. Configuring one logs why it's ignored at startup rather than silently
honoring a subset; `/honcho config` lists them too. `dialectic` is the notable one: it's the `honcho_chat` tool
here, so it runs against the actual question instead of a turn-old snapshot.

The plugin's own `cordis.yml` config carries plumbing only — `configPath`, `apiKeyRef`, `host`, `enabled`. Set
`host` to run a credential-isolated profile (`"dsh_work"`) against the same install.

### Sessions

Default: one long-lived session per project directory, named `<peerName>-<dir>`, matching claude-honcho. Pin a
different name for any path with the root `sessions` map — an override always wins.

| `sessionStrategy`         | Session name            | Notes                                                              |
| ------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `per-directory` (default) | `<peer>-<dir>`          | Stable across restarts and branches                                |
| `per-repo`                | `<peer>-<repo-root>`    | Same memory from any subdirectory                                  |
| `git-branch`              | `<peer>-<dir>-<branch>` | Falls back to `per-directory` outside a repo or on a detached HEAD |
| `per-session`             | `<peer>-chat-<id>`      | A clean slate every restart                                        |
| `global`                  | `<peer>`                | One memory for everything                                          |

**Prefer the wider scopes.** Honcho's guidance is not to scope sessions too thin: the background Deriver needs
a single session to accumulate enough material before it can reason well. `git-branch` splits a project's
memory per branch, and `per-session` discards it on every restart.

## Commands

| Command          | Does                                                                               |
| ---------------- | ---------------------------------------------------------------------------------- |
| `/honcho`        | Status: peer, workspace, session, strategy, pending uploads, last sync, last fetch |
| `/honcho config` | Resolved settings, the file they came from, and any ignored injection components   |
| `/honcho flush`  | Sync now                                                                           |

## Requirements

- Node `^22.19.0 || >=24.0.0`
- A running `dsh` (developed and typechecked against `0.1.2-alpha.3`)
- A Honcho API key, or a self-hosted Honcho at `baseUrl`

## Development

```sh
bun install
bun test
bun run typecheck
bun run build
```

`bunfig.toml` exempts `@deepseek-ai/*` and `@honcho-ai/*` from a machine-wide `minimumReleaseAge` gate, because
dsh publishes prereleases daily and typing against an older version than users run defeats the point. Every
version is pinned exactly, so nothing new is picked up without an explicit edit. Regenerate the list after
adding a dsh dependency — the command is in the file.

`src/core-shim.ts` is deliberately temporary — it stands in for the shared integration core (Linear DEV-2452)
and gets deleted when that ships. Everything else imports config through it.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind each extension point.

## Credit

[**dsh-honcho-sync**](https://github.com/nanpaidashi/dsh-honcho-sync) by
[@nanpaidashi](https://github.com/nanpaidashi) (MIT) inspired the initial design of this plugin

The `~/.honcho/config.json` contract, the session-naming convention, and `src/redact.ts` come from the sibling
Honcho integrations — [claude-honcho](https://github.com/plastic-labs/claude-honcho),
[codex-honcho](https://github.com/plastic-labs/codex-honcho), and their relatives — which is also why memory
written by one of them shows up in the others.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is MIT-licensed, and its
[Cordis](https://github.com/cordiverse/cordis) plugin model is what made a native integration worth writing
instead of a hook bridge.

## License

MIT
