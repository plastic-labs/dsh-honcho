# dsh-honcho

[English](README.md) | [中文](README.zh.md) | Русский

Постоянная память для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) на базе
[Honcho](https://honcho.dev).

Когда сессия заканчивается, `dsh` забывает всё. Этот плагин даёт ему память, которая не пропадает: над чем вы
работаете, как вам удобнее работать, что вы решили на прошлой неделе и почему. Он читает тот же
`~/.honcho/config.json`, что и другие интеграции Honcho, поэтому все они настраиваются в одном месте, а если
направить две из них на один `workspace`, у них будет общая память.

## Установка

```sh
dsh plugin --profile <name> add @honcho-ai/dsh-honcho
```

Затем укажите свой API-ключ и имя в `~/.honcho/config.json`:

```json
{
  "peerName": "your-name",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "hosts": {
    "dsh": { "workspace": "dsh" }
  }
}
```

Ключ можно получить на [app.honcho.dev](https://app.honcho.dev). Достаточно и одной переменной окружения
`HONCHO_API_KEY` — конфигурационный файл нужен только для изменения значений по умолчанию.

## Что делает плагин

**В начале сессии подставляет то, что знает Honcho**: вашу peer card (карточку профиля), сводку сессии этого
проекта на данный момент и conclusions (выводы) Honcho, относящиеся к вашему последнему вопросу. Один вызов API,
объём ограничен бюджетом символов, данные обновляются по ходу работы.

**Сохраняет каждый ход диалога.** Сообщения пользователя и ассистента отправляются в Honcho в фоне, с
debounce-задержкой, и записываются в конце каждого хода, перед сжатием контекста (compaction) и при завершении
работы. Секреты предварительно маскируются.

**Даёт модели три инструмента:**

| Инструмент        | Назначение                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ |
| `honcho_search`   | Поиск информации. Ищет по исходным сообщениям _и_ по выведенным conclusions.         |
| `honcho_chat`     | Вопрос, требующий суждения. Рассуждает на основе всего, что знает Honcho. Медленно.  |
| `honcho_remember` | Сохранение долговечного факта, предпочтения или решения.                             |

**`/honcho`** показывает статус и ссылку на сессию в панели управления Honcho — см. «Команды» ниже.

## Настройка

Все настройки поведения находятся в `~/.honcho/config.json` в разделе `hosts.dsh` — это тот же файл, который
читают `claude-honcho`, `codex-honcho` и другие интеграции. На корневом уровне хранятся идентификация и
подключение, в блоке host — поведение.

Файл читается как строгий JSON: комментарии и завершающие запятые в примере ниже служат только для пояснения. Если
их оставить, весь файл будет пропущен без предупреждения, и все настройки вернутся к значениям по умолчанию.

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

Перевод английских комментариев из примера:

| Параметр                 | Комментарий                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| `baseUrl`                | Можно указать только хост или адрес с `…/v3`                                      |
| `enabled`                | Общий выключатель                                                                 |
| (комментарий в корне)    | `sessions` можно также задать в корне как запасной вариант; блок host приоритетнее |
| `aiPeer`                 | По умолчанию совпадает с именем host                                              |
| `observationMode`        | `unified` или `directional`                                                       |
| `sessionStrategy`        | См. «Сессии» ниже                                                                 |
| `sessionPeerPrefix`      | Имена сессий имеют вид `<peer>-<dir>`                                             |
| `sessionPrefix`          | Фиксированный префикс для каждого генерируемого имени, например `"vps-"`          |
| `sessions`               | Закрепить имя сессии за путём                                                     |
| `sessionStart`           | Можно добавить `representation`                                                   |
| `perTurn`                | `userContext` = representation + peer card                                        |
| `maxConclusions`         | Сколько conclusions **возвращает** Honcho                                         |
| `maxRenderedConclusions` | Сколько из них после фильтрации попадает в промпт                                 |
| `reasoning`              | `minimal`, `low`, `medium`, `high` или `max`                                      |
| `saveToolUse`            | Однострочные сводки работы инструментов                                           |
| `writeFrequency`         | `async` или `sync`                                                                |
| `noisePatterns`          | Дополняют встроенные шаблоны для маскирования секретов                            |

### Компоненты подстановки

Два набора различаются **частотой обновления**, а не тем, что они могут содержать.

`injection.sessionStart` подставляется один раз при открытии сессии: `directives` (указания по работе с памятью),
`summary`, `peerCard`, `representation`.

`injection.perTurn` обновляется по ходу работы:

- **`userContext`** — свежий контекст peer, подобранный под текущий запрос: **representation (представление) +
  peer card**. Поисковым запросом служит ваше текущее сообщение, поэтому извлекается связанное по смыслу, а не
  просто недавнее. Это единый пакет: он всегда содержит оба компонента, что бы ни было указано в `sessionStart`.
  Чтобы получить только один из них, укажите его в `sessionStart` и задайте `perTurn: []` — ценой отказа от
  обновления на каждом ходе.
- **`dialectic`** — обоснованный ответ Honcho о вас, запускается каждые `cadence.dialectic` ходов, форма задаётся
  `injection.dialectic`. После первого хода ничто его не ждёт, поэтому запоздавший ответ попадёт в следующий ход.

Компоненты, которые есть в canonical schema (общей схеме конфигурации), но не реализованы в этом плагине —
`briefing`, `assistantContext`, `sessionContext`, — выводятся в отчёт при запуске, а не отбрасываются молча. То
же касается ключей схемы, которые плагин не обрабатывает (`showContents`, `statusline`, `globalOverride`,
детальный `observation`, `multiUser`), и ключей, переименованных после предыдущих версий. Ничто здесь не
принимается, чтобы затем быть тихо проигнорированным.

Собственная конфигурация плагина в `cordis.yml` содержит только служебные параметры: `configPath`, `apiKeyRef`,
`host`, `enabled`. Задайте `host`, чтобы запустить profile с изолированными учётными данными (`"dsh_work"`) на той
же установке.

### Общая память с другими интеграциями

Каждая интеграция по умолчанию использует собственный `workspace` в Honcho — здесь `dsh`, у claude-honcho —
`claude_code`, — а workspace является границей изоляции, поэтому **по умолчанию они не видят память друг друга.**
Чтобы объединить их, направьте их на один `workspace`:

```jsonc
"hosts": {
  "dsh":         { "workspace": "shared" },
  "claude_code": { "workspace": "shared" }
}
```

Также используйте во всех них одинаковый `peerName`, поскольку conclusions хранятся отдельно для каждого peer.
Для claude-honcho тоже предложены `sessionStrategy: "git-remote"` и `sessionPrefix`, чтобы репозиторий, с которым
работают из обеих интеграций, можно было намеренно направить в одну сессию, а не случайно.

### Сессии

По умолчанию: одна долгоживущая сессия на каталог проекта с именем `<peerName>-<dir>`, как в claude-honcho. Для
любого пути можно закрепить другое имя через корневую карту `sessions` — переопределение всегда приоритетнее.

| `sessionStrategy`            | Имя сессии                 | Примечания                                                                     |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `per-directory` (по умолч.)  | `<peer>-<dir>`             | Не меняется при перезапусках и смене веток                                     |
| `per-repo`                   | `<peer>-<repo-root>`       | Одна и та же память из любого подкаталога                                      |
| `git-remote`                 | `<peer>-<host-owner-repo>` | Берётся из URL `origin`, поэтому один репозиторий на двух машинах — одна сессия. Вне репозитория или без `origin` используется `per-directory` |
| `git-branch`                 | `<peer>-<dir>-<branch>`    | Вне репозитория или в состоянии detached HEAD используется `per-directory`     |
| `per-session`                | `<peer>-chat-<id>`         | Чистый лист при каждом перезапуске                                             |
| `global`                     | `<peer>`                   | Одна память для всего                                                          |

`per-directory` и `per-repo` называют сессию по имени папки, поэтому два разных проекта, которые лежат в каталоге
`web`, незаметно делят одну память между машинами. Решение — `git-remote`: он сводит URL `origin` к
`host/owner/repo`, так что `git@github.com:you/web.git` и `https://github.com/you/web` совпадают, а `you/web` и
`someone-else/web` — нет. URL сравнивается в том виде, в каком он записан в конфигурации, поэтому машины,
клонирующие через разные ssh-псевдонимы `Host` — `github.com-work` на одной и `github.com` на другой, — всё равно
получают разные сессии.

**`sessionPrefix`** добавляет фиксированную строку перед каждым генерируемым именем — `"vps-"` даёт `vps-you-web`
— на случай, когда по имени сессии должно быть видно, с какой машины она пришла. Работает со всеми стратегиями.
Имя, закреплённое в `sessions`, используется ровно так, как записано, и префикс к нему не добавляется.

**Выбирайте более широкие области.** Honcho рекомендует не дробить сессии слишком мелко: фоновому процессу
Deriver нужно накопить в одной сессии достаточно материала, чтобы делать хорошие выводы. `git-branch` разделяет
память проекта по веткам, а `per-session` сбрасывает её при каждом перезапуске.

## Команды

| Команда          | Действие                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `/honcho`        | Статус: peer, workspace, сессия, стратегия, ожидающие отправки, последняя синхронизация и загрузка |
| `/honcho config` | Итоговые настройки, файл, из которого они взяты, и проигнорированные компоненты подстановки       |
| `/honcho flush`  | Синхронизировать сейчас                                                                          |

## Требования

- Node `^22.19.0 || >=24.0.0`
- Запущенный `dsh` (плагин разработан и проверен на типы с версией `0.1.2-alpha.3`)
- API-ключ Honcho или собственный сервер Honcho по адресу `baseUrl`

## Разработка

```sh
bun install
bun test
bun run typecheck
bun run build
```

Устройство плагина и обоснование каждой точки расширения описаны в [ARCHITECTURE.md](ARCHITECTURE.md) (на
английском).

## Благодарности

Исходный дизайн этого плагина вдохновлён проектом
[**dsh-honcho-sync**](https://github.com/nanpaidashi/dsh-honcho-sync) от
[@nanpaidashi](https://github.com/nanpaidashi) (MIT).

Формат `~/.honcho/config.json`, соглашение об именовании сессий и `src/redact.ts` взяты из родственных
интеграций Honcho — [claude-honcho](https://github.com/plastic-labs/claude-honcho),
[codex-honcho](https://github.com/plastic-labs/codex-honcho) и других.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) распространяется по лицензии MIT, а его
модель плагинов [Cordis](https://github.com/cordiverse/cordis) — то, благодаря чему имело смысл написать нативную
интеграцию вместо моста на хуках.

## Лицензия

MIT
