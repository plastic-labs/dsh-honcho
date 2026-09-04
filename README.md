# dsh-honcho

Persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), powered by
[Honcho](https://honcho.dev).

`dsh` forgets everything when a session ends. This plugin gives it memory that doesn't: what you're building,
how you like to work, what you decided last week and why. It reads the same `~/.honcho/config.json` as the
other Honcho integrations, so there is one place to configure all of them — and pointing two of them at the
same `workspace` gives them one shared memory.

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
  // sessions may also sit here as a fallback; the host block wins

  "hosts": {
    "dsh": {
      "workspace": "dsh",
      "aiPeer": "dsh", // defaults to the host name
      "observationMode": "unified", // unified | directional
      "sessionStrategy": "per-directory", // see Sessions below
      "sessionPeerPrefix": true, // session names are <peer>-<dir>
      "sessionPrefix": "", // literal prefix on every generated name, e.g. "vps-"
      "sessions": { "/path/to/repo": "pinned-session-name" }, // pin a session
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"], // + representation
        "perTurn": ["userContext", "dialectic"], // userContext = representation + card
        "tools": true,
        "searchTopK": 10,
        "searchMaxDistance": 0.6,
        "maxConclusions": 15, // how many conclusions Honcho RETURNS
        "maxRenderedConclusions": 4, // how many survive filtering into the prompt
        "contextTokens": 1500,
        "cadence": { "dialectic": 5, "ttlSeconds": 300 },
        "dialectic": {
          "reasoning": "low", // minimal | low | medium | high | max
          "maxChars": 600,
        },
      },
      "capture": {
        "saveMessages": true,
        "saveToolUse": false, // one-line summaries of tool activity
        "writeFrequency": "async", // async | sync
        "noisePatterns": [], // additive to the built-in secret patterns
      },
      "messageUpload": {
        "maxUserTokens": 6000,
        "maxAssistantTokens": 6000,
      },
      },
    },
  },
}
```

### Injection components

The two menus differ in **cadence**, not in what they can carry.

`injection.sessionStart` is injected once when a session opens: `directives` (guidance on using memory),
`summary`, `peerCard`, `representation`.

`injection.perTurn` refreshes as you work:

- **`userContext`** — a fresh, prompt-scoped peer context blob: **representation + peer card**, retrieved using
  your current message as the search query so recall is associative rather than merely recent. It is a bundle,
  so it supplies both regardless of what `sessionStart` names. To get one without the other, name it in
  `sessionStart` and set `perTurn: []` — at the cost of per-turn refresh.
- **`dialectic`** — a reasoned answer about you, run every `cadence.dialectic` turns and shaped by
  `injection.dialectic`. Nothing waits on it after the first turn, so a late answer reaches the next one.

Components the canonical schema names but this plugin does not implement — `briefing`, `assistantContext`,
`sessionContext` — are reported at startup rather than silently dropped, as are schema keys it does not act on
(`showContents`, `statusline`, `globalOverride`, granular `observation`, `multiUser`) and any key renamed since
an earlier version. Nothing here is accepted and quietly ignored.

The plugin's own `cordis.yml` config carries plumbing only — `configPath`, `apiKeyRef`, `host`, `enabled`. Set
`host` to run a credential-isolated profile (`"dsh_work"`) against the same install.

### Sharing memory with other integrations

Each integration defaults to its own Honcho `workspace` — `dsh` here, `claude_code` for claude-honcho — and a
workspace is the isolation boundary, so **by default they do not see each other's memory.** Point them at the
same `workspace` to merge them:

```jsonc
"hosts": {
  "dsh":         { "workspace": "shared" },
  "claude_code": { "workspace": "shared" }
}
```

Keep `peerName` identical across them too, since conclusions are stored per peer. `sessionStrategy:
"git-remote"` and `sessionPrefix` are proposed for claude-honcho as well, so a repo worked on from both can be
pointed at one session on purpose rather than by accident.

### Sessions

Default: one long-lived session per project directory, named `<peerName>-<dir>`, matching claude-honcho. Pin a
different name for any path with the root `sessions` map — an override always wins.

| `sessionStrategy`         | Session name            | Notes                                                              |
| ------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `per-directory` (default) | `<peer>-<dir>`          | Stable across restarts and branches                                |
| `per-repo`                | `<peer>-<repo-root>`    | Same memory from any subdirectory                                  |
| `git-remote`              | `<peer>-<host-owner-repo>` | From the `origin` URL, so the same repo on two machines is one session. Falls back to `per-directory` outside a repo or without an `origin` |
| `git-branch`              | `<peer>-<dir>-<branch>` | Falls back to `per-directory` outside a repo or on a detached HEAD |
| `per-session`             | `<peer>-chat-<id>`      | A clean slate every restart                                        |
| `global`                  | `<peer>`                | One memory for everything                                          |

`per-directory` and `per-repo` name a session after a folder, so two different projects that both live in a
`web` directory silently share one memory across machines. `git-remote` is the fix: it reduces the `origin` URL
to `host/owner/repo`, so `git@github.com:you/web.git` and `https://github.com/you/web` agree, and `you/web` and
`someone-else/web` do not.

**`sessionPrefix`** puts a literal string in front of every generated name — `"vps-"` gives `vps-you-web` — for
when the machine a session came from should be visible in it. It applies to every strategy. A name pinned in
`sessions` is used exactly as written and is never prefixed.

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind each extension point, and
[RUNBOOK.md](RUNBOOK.md) for a throwaway-VM test pass.

## Credit

[**dsh-honcho-sync**](https://github.com/nanpaidashi/dsh-honcho-sync) by
[@nanpaidashi](https://github.com/nanpaidashi) (MIT) inspired the initial design of this plugin

The `~/.honcho/config.json` contract, the session-naming convention, and `src/redact.ts` come from the sibling
Honcho integrations — [claude-honcho](https://github.com/plastic-labs/claude-honcho),
[codex-honcho](https://github.com/plastic-labs/codex-honcho), and their relatives.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is MIT-licensed, and its
[Cordis](https://github.com/cordiverse/cordis) plugin model is what made a native integration worth writing
instead of a hook bridge.

## License

MIT
