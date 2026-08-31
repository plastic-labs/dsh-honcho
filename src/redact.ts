/**
 * Best-effort secret redaction for anything uploaded to Honcho.
 *
 * Ported from claude-honcho (`plugins/honcho/src/redact.ts`) so the two
 * integrations scrub identically. Regex-based, so novel secret formats pass
 * through; users extend the defaults via `capture.redactPatterns`.
 *
 * This runs on EVERY captured message, not only tool summaries. A coding
 * harness has whatever is on screen in its buffer — pasted keys, .env contents,
 * customer data — and capture without scrubbing is an exfiltration path.
 */

interface RedactRule {
  pattern: RegExp;
  replacement: string;
}

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
