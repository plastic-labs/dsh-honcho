/**
 * Best-effort secret redaction for anything uploaded to Honcho.
 *
 * Started as a port of claude-honcho (`plugins/honcho/src/redact.ts`) and has
 * since grown the formats that port missed (see the second half of
 * DEFAULT_RULES). Regex-based, so novel secret formats still pass through, and
 * some common ones cannot be matched at all without redacting ordinary text (a
 * bare 40-character AWS secret looks like any hash). Users extend the defaults
 * via `capture.noisePatterns`.
 *
 * This runs on EVERY captured message, not only tool summaries. A coding
 * harness has whatever is on screen in its buffer — pasted keys, .env contents,
 * customer data — and capture without scrubbing is an exfiltration path.
 */

interface RedactRule {
  pattern: RegExp;
  replacement: string;
}

/** Names that mark a value as secret. `tokens` (as in `max_tokens`) and `pwd` (the shell's
 *  working directory) are deliberately left out of the colon-style rules below. */
const SECRET_NAME = String.raw`[\w-]*(?:password|passwd|secret|token(?!s)|api[_-]?key|access[_-]?key|credentials?)[\w-]*`;

const DEFAULT_RULES: RedactRule[] = [
  // KEY=value assignments with a secret-bearing key (PGPASSWORD=..., AWS_SECRET_ACCESS_KEY=...)
  {
    pattern:
      /\b(\w*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|CREDENTIALS?)\w*)\s*=\s*("[^"]*"|'[^']*'|[^\s;|&"']+)/gi,
    replacement: "$1=***",
  },
  // --password / --token style CLI flags
  {
    pattern: /(--(?:password|passwd|pwd|token|api-?key|secret|auth)[= ])(?:"[^"]*"|'[^']*'|[^\s;|&"']+)/gi,
    replacement: "$1***",
  },
  // Authorization headers
  {
    pattern: /(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi,
    replacement: "$1***",
  },
  // Credentials embedded in URLs (scheme://user:pass@host)
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s]+@/gi,
    replacement: "$1***@",
  },
  // Well-known token shapes: Honcho, AWS, OpenAI/Anthropic-style sk-, GitHub, Slack, GitLab, npm
  {
    pattern:
      /\b(?:hch[_-]?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})\b/g,
    replacement: "***",
  },
  // ── Formats the first five rules miss ──────────────────────────────────────
  // Private key blocks, whole and truncated (a message cut by the upload budget has no END line)
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "***",
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, replacement: "***" },
  // JWTs
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: "***",
  },
  // JSON fields with a secret-bearing name: "api_key": "…"
  {
    pattern: new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)(?:"[^"]*"|[^\s,}\]]+)`, "gi"),
    replacement: '$1"***"',
  },
  // YAML / header style: password: …, api-key: …, X-Api-Key: …
  {
    pattern: new RegExp(String.raw`\b(${SECRET_NAME}\s*:\s*)(?!\*\*\*)(?:"[^"]*"|'[^']*'|[^\s,;]+)`, "gi"),
    replacement: "$1***",
  },
  // Cookie headers carry session ids under arbitrary names
  { pattern: /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, replacement: "$1***" },
  // Prose: "password is …", "密码是 …"
  { pattern: /(\b(?:password|passcode|passwd)\s+is\s+)\S+/gi, replacement: "$1***" },
  { pattern: /((?:密码|口令)\s*(?:是|为|[:：])\s*)\S+/g, replacement: "$1***" },
  // Azure connection strings and SAS keys
  { pattern: /\b((?:AccountKey|SharedAccessKey|SharedAccessSignature)=)[^;\s"']+/gi, replacement: "$1***" },
  // Slack incoming-webhook URLs
  { pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, replacement: "***" },
  // More token shapes: Stripe secret/restricted keys, Google API keys, Telegram bot tokens
  {
    pattern: /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35}|\d{8,10}:[A-Za-z0-9_-]{30,})/g,
    replacement: "***",
  },
];

/** Validate a user-supplied pattern. Returns an error message, or null if it compiles. */
export function validateRedactPattern(source: string): string | null {
  try {
    new RegExp(source);
    return null;
  } catch (e) {
    return `Invalid regex ${JSON.stringify(source)}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Redact secrets from `text`. `extraPatterns` are additive to the built-in
 * defaults. Patterns that fail to compile are skipped rather than throwing —
 * a hand-edited config file must not be able to break capture.
 */
export function redactSecrets(text: string, extraPatterns?: readonly string[]): string {
  let result = text;
  for (const rule of DEFAULT_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  for (const source of extraPatterns ?? []) {
    try {
      result = result.replace(new RegExp(source, "gi"), "***");
    } catch {
      continue;
    }
  }
  return result;
}
