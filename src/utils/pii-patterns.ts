/**
 * Shared PII / secret detection patterns.
 *
 * Single source of truth for the pattern set used by BOTH:
 *   - the community catalog pre-submission scan (`src/bus/catalog.ts`,
 *     `prepareSubmission()`), which scans staged community contributions
 *     before they are published, and
 *   - the repo-wide CI lint (`scripts/pii-lint.mjs`), which scans every
 *     tracked file on every push/PR.
 *
 * Keeping the patterns here means the two scanners can never drift: a
 * pattern tightened or added in one place is automatically honored by the
 * other. The `jwt` pattern is folded in from the PTY redactor
 * (`src/pty/redact.ts`) so the JWT secret class is covered everywhere.
 *
 * IMPORTANT: the regexes below are byte-for-byte identical to the ones that
 * previously lived inline in catalog.ts (email, phone, credential,
 * telegram_chat_id, deployment_url). Do not change them without re-running
 * the catalog tests — `prepareSubmission()` behavior must stay identical.
 */

export type PiiSeverity = 'high' | 'medium';

export interface PiiPattern {
  /** Stable machine name, used in finding output (e.g. "credential"). */
  name: string;
  /** Detection regex. Unanchored, used with `.test()` / `.exec()`. */
  regex: RegExp;
  severity: PiiSeverity;
}

/**
 * The canonical pattern set. Order is stable so findings are deterministic.
 *
 * NOTE on flags: catalog.ts historically used these patterns WITHOUT a
 * global flag (single `.test()` per file). The line-scanning CI lint needs
 * a fresh match per line; it reads `.regex.source`/`.flags` (or constructs
 * its own RegExp) rather than sharing a stateful global-flagged instance.
 * To keep both consumers safe, these are declared WITHOUT the `g` flag —
 * stateless `.test()` is correct for catalog, and the lint re-instantiates.
 */
export const PII_PATTERNS: PiiPattern[] = [
  {
    name: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    severity: 'medium',
  },
  {
    name: 'phone',
    regex: /\+?[0-9]{1,3}[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/,
    severity: 'medium',
  },
  {
    name: 'credential',
    regex: /(sk-|ghp_|xoxb-|AKIA|token=|key=|password=|secret=)/,
    severity: 'high',
  },
  {
    name: 'telegram_chat_id',
    regex: /chat_id[:\s]*[0-9]{6,}/,
    severity: 'high',
  },
  {
    name: 'deployment_url',
    regex: /https?:\/\/[a-z0-9.-]+\.(railway\.app|vercel\.app|herokuapp\.com|netlify\.app)/,
    severity: 'medium',
  },
  {
    name: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    severity: 'high',
  },
  {
    // Formatted SSN (XXX-XX-XXXX / XXX XX XXXX / XXX.XX.XXXX). The \b
    // boundaries keep a 10-digit phone (XXX-XXX-XXXX) from matching the
    // XXX-XX-XXXX shape. Separator class `[-.\t ]` (horizontal only, no
    // newline) matches the redactor in src/utils/ssn-redaction.ts; this entry
    // only lets the community-catalog pre-submission scan flag SSNs in staged
    // contributions. Detection-only — do not treat this as the scrub source.
    name: 'ssn',
    regex: /\b\d{3}[-.\t ]\d{2}[-.\t ]\d{4}\b/,
    severity: 'high',
  },
];

/**
 * Backwards-compatible keyed lookup matching the shape catalog.ts used
 * previously (`PII_PATTERNS.email`, etc.). Lets the catalog refactor be a
 * pure import swap with no call-site changes beyond the import line.
 */
export const PII_PATTERNS_BY_NAME: Record<string, RegExp> = Object.fromEntries(
  PII_PATTERNS.map((p) => [p.name, p.regex]),
);
