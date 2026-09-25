# dsh-honcho

[English](README.md) | 中文 | [Русский](README.ru.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供持久记忆，由 [Honcho](https://honcho.dev)
驱动。

`dsh` 在会话结束时会忘掉一切。这个插件为它提供不会丢失的记忆：你在做什么、你习惯怎么工作、你上周做了什么决定以及为什么。它与其他
Honcho 集成读取同一个 `~/.honcho/config.json`，所有集成只需在一处配置；把其中两个指向同一个 `workspace`，它们就共享同一份记忆。

## 安装

```sh
dsh plugin --profile <name> add @honcho-ai/dsh-honcho
```

然后在 `~/.honcho/config.json` 中填入你的 API key 和名字：

```json
{
  "peerName": "your-name",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "hosts": {
    "dsh": { "workspace": "dsh" }
  }
}
```

在 [app.honcho.dev](https://app.honcho.dev) 获取 key。只设置环境变量 `HONCHO_API_KEY` 也能直接使用，只有需要修改默认值时才用到配置文件。

## 功能

**会话开始时注入 Honcho 已知的内容**：你的 peer card（用户画像）、本项目会话到目前为止的摘要，以及 Honcho 已得出的、与你刚才提问相关的
conclusions（结论）。只需一次 API 调用，按字符预算裁剪，并在你工作时持续刷新。

**记录每一轮对话。** 用户和助手的消息在后台发送给 Honcho，经过防抖，并在每轮结束时、上下文压缩（compaction）前以及退出时写入。发送前会先对密钥等敏感信息脱敏。

**为模型提供三个工具：**

| 工具              | 用途                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `honcho_search`   | 查找信息。同时搜索原始消息**和**推导出的 conclusions。           |
| `honcho_chat`     | 提出需要判断的问题。基于 Honcho 已知的全部内容推理作答。速度较慢。 |
| `honcho_remember` | 保存长期有效的事实、偏好或决定。                                 |

**`/honcho`** 显示状态，并附上该会话在 Honcho 控制台中的链接，详见下文「命令」。

## 配置

所有行为配置都位于 `~/.honcho/config.json` 的 `hosts.dsh` 下，与 `claude-honcho`、`codex-honcho` 及其他集成读取的是同一个文件。根层级存放身份与连接信息，host 块存放行为配置。

该文件按严格 JSON 解析：下方示例中的注释和末尾逗号仅作说明。如果保留它们，整个文件会被跳过且不会有任何提示，所有设置都会回退到默认值。

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
}
```

示例中的英文注释含义：

| 配置项                   | 注释说明                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| `baseUrl`                | 只写主机名或带 `…/v3` 均可                                         |
| `enabled`                | 全局总开关                                                         |
| （根层级注释）           | `sessions` 也可放在根层级作为兜底；与 host 块冲突时以 host 块为准 |
| `aiPeer`                 | 默认等于 host 名                                                   |
| `observationMode`        | 可选 `unified` 或 `directional`                                    |
| `sessionStrategy`        | 见下文「会话」                                                     |
| `sessionPeerPrefix`      | 会话名为 `<peer>-<dir>`                                            |
| `sessionPrefix`          | 加在每个自动生成的会话名前的固定前缀，例如 `"vps-"`               |
| `sessions`               | 为指定路径固定会话名                                               |
| `sessionStart`           | 还可加入 `representation`                                          |
| `perTurn`                | `userContext` = representation + peer card                         |
| `maxConclusions`         | Honcho **返回**多少条 conclusions                                  |
| `maxRenderedConclusions` | 经过筛选后最终写入提示词的条数                                     |
| `reasoning`              | 可选 `minimal`、`low`、`medium`、`high`、`max`                     |
| `saveToolUse`            | 为工具调用记录一行摘要                                             |
| `writeFrequency`         | 可选 `async` 或 `sync`                                             |
| `noisePatterns`          | 在内置密钥过滤规则之外追加的规则                                   |

### 注入组件

两组选项的区别在于**刷新节奏**，而不在于能携带什么内容。

`injection.sessionStart` 在会话打开时注入一次：`directives`（如何使用记忆的指引）、`summary`、`peerCard`、`representation`。

`injection.perTurn` 在你工作时持续刷新：

- **`userContext`**：一份按当前提示词检索的最新 peer 上下文，包含 **representation（表征）+ peer card**。它以你当前的消息作为检索词，因此召回的是相关内容，而不只是最近的内容。它是一个组合包，无论
  `sessionStart` 中写了什么，都会同时提供两者。如果只想要其中之一，就在 `sessionStart` 中写上它，并设置 `perTurn: []`，代价是失去每轮刷新。
- **`dialectic`**：由 Honcho 推理得出的一段关于你的回答，每隔 `cadence.dialectic` 轮运行一次，并由 `injection.dialectic`
  控制其形式。第一轮之后不会等待它返回，迟到的结果会在下一轮送达。

canonical schema（通用配置规范）中列出、但本插件未实现的组件（`briefing`、`assistantContext`、`sessionContext`）会在启动时报告，而不是被静默丢弃。本插件不处理的配置键（`showContents`、`statusline`、`globalOverride`、细粒度的
`observation`、`multiUser`）以及早期版本之后改过名的键也同样会报告。这里没有任何配置会被接受后又悄悄忽略。

插件自身的 `cordis.yml` 配置只包含底层参数：`configPath`、`apiKeyRef`、`host`、`enabled`。设置 `host`
可以在同一套安装上运行一个凭据隔离的 profile（如 `"dsh_work"`）。

### 与其他集成共享记忆

每个集成默认使用自己的 Honcho `workspace`（本插件为 `dsh`，claude-honcho 为 `claude_code`），而 workspace 是隔离边界，所以**默认情况下它们看不到彼此的记忆**。把它们指向同一个 `workspace` 即可合并：

```jsonc
"hosts": {
  "dsh":         { "workspace": "shared" },
  "claude_code": { "workspace": "shared" }
}
```

同时请在各集成中保持 `peerName` 一致，因为 conclusions 是按 peer 存储的。claude-honcho 也计划支持 `sessionStrategy: "git-remote"` 和
`sessionPrefix`，这样同时在两边处理的仓库就可以有意地指向同一个会话，而不是碰巧撞在一起。

### 会话

默认：每个项目目录对应一个长期会话，命名为 `<peerName>-<dir>`，与 claude-honcho 一致。可以用根层级的 `sessions` 映射为任意路径固定另一个会话名，覆盖值始终优先。

| `sessionStrategy`         | 会话名                     | 说明                                                                                   |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------- |
| `per-directory`（默认）   | `<peer>-<dir>`             | 重启和切换分支后保持不变                                                               |
| `per-repo`                | `<peer>-<repo-root>`       | 在任意子目录中都使用同一份记忆                                                         |
| `git-remote`              | `<peer>-<host-owner-repo>` | 取自 `origin` URL，因此两台机器上的同一个仓库对应同一个会话。不在仓库中或没有 `origin` 时回退为 `per-directory` |
| `git-branch`              | `<peer>-<dir>-<branch>`    | 不在仓库中或处于 detached HEAD 时回退为 `per-directory`                               |
| `per-session`             | `<peer>-chat-<id>`         | 每次重启都从零开始                                                                     |
| `global`                  | `<peer>`                   | 所有内容共用一份记忆                                                                   |

`per-directory` 和 `per-repo` 按文件夹名命名会话，所以两个不同的项目如果都放在名为 `web` 的目录中，就会在不同机器间悄悄共用同一份记忆。`git-remote` 解决了这个问题：它把
`origin` URL 归一为 `host/owner/repo`，于是 `git@github.com:you/web.git` 和 `https://github.com/you/web` 被视为同一个，而 `you/web` 与
`someone-else/web` 则不同。它比较的是配置中写的 URL，所以通过不同 ssh `Host` 别名克隆的机器（一台用 `github.com-work`，另一台用 `github.com`）仍会得到不同的会话。

**`sessionPrefix`** 在每个自动生成的会话名前加上一段固定字符串，例如 `"vps-"` 会得到 `vps-you-web`，适用于希望从会话名看出它来自哪台机器的情况。它对所有策略都生效。在 `sessions`
中固定的会话名会原样使用，不会加前缀。

**尽量使用范围更大的策略。** Honcho 的建议是不要把会话划分得太细：后台的 Deriver 需要在单个会话中积累足够的材料，才能推理得好。`git-branch` 会按分支拆分项目的记忆，而 `per-session` 每次重启都会丢弃记忆。

## 命令

| 命令             | 作用                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `/honcho`        | 状态：peer、workspace、会话、会话策略、待上传条数、上次同步时间、上次获取时间 |
| `/honcho config` | 最终生效的设置、设置所在的文件，以及被忽略的注入组件                          |
| `/honcho flush`  | 立即同步                                                                      |

## 环境要求

- Node `^22.19.0 || >=24.0.0`
- 正在运行的 `dsh`（基于 `0.1.2-alpha.3` 开发并通过类型检查）
- Honcho API key，或位于 `baseUrl` 的自托管 Honcho

## 开发

```sh
bun install
bun test
bun run typecheck
bun run build
```

设计思路以及每个扩展点背后的考量，见 [ARCHITECTURE.md](ARCHITECTURE.md)（英文）。

## 致谢

本插件的初始设计受到 [@nanpaidashi](https://github.com/nanpaidashi) 的
[**dsh-honcho-sync**](https://github.com/nanpaidashi/dsh-honcho-sync)（MIT）启发。

`~/.honcho/config.json` 的配置约定、会话命名规则以及 `src/redact.ts` 来自同系列的 Honcho 集成：[claude-honcho](https://github.com/plastic-labs/claude-honcho)、[codex-honcho](https://github.com/plastic-labs/codex-honcho)
等。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 采用 MIT 许可证，正是它的 [Cordis](https://github.com/cordiverse/cordis)
插件模型让我们值得编写原生集成，而不是用钩子做桥接。

## 许可证

MIT
