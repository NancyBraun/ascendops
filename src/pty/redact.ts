/**
 * PTY output redaction.
 *
 * Secret-bearing output can reach the PTY capture stream whenever an agent
 * runs a shell command that prints credentials — curl -v against an
 * authenticated endpoint, wget --debug, openssl s_client, dumping a cookie
 * jar, etc. The PTY's OutputBuffer ring captures everything the child
 * process emits and also streams it verbatim to a persisted stdout.log.
 * Without redaction, any JWT, bearer token, or session cookie that happens
 * to appear in the agent's terminal ends up persisted to disk indefinitely.
 *
 * Origin: discovered via a baseline gitleaks audit of agent stdout logs
 * which found 16 JWTs (`authjs.session-token=eyJ...`) emitted to stdout
 * by `curl -v` against an authenticated NextAuth endpoint. Initial
 * hypothesis was that a logging code path was at fault; the actual cause
 * turned out to be agent-level shell commands the PTY captured faithfully.
 * The fix therefore lives at the PTY layer (defense-in-depth for any
 * future exposure via any tool) rather than in an individual code path.
 *
 * Chunk-boundary handling: PTY data arrives in OS-buffered chunks
 * (typically 4KB on Linux). If a chunk boundary falls inside a JWT,
 * neither chunk matches the regex on its own. `splitTrailingPartialJwt`
 * closes this gap: OutputBuffer.push() holds back a trailing substring
 * that could be the prefix of a JWT and prepends it to the next chunk,
 * so the reassembled token is redacted before anything reaches the disk
 * log. The holdback is bounded (MAX_PARTIAL_HOLDBACK) so legitimate
 * base64 output that merely starts with `eyJ` cannot be withheld
 * indefinitely. See the chunk-boundary tests in output-buffer.test.ts.
 */

import { redactSSN } from '../utils/ssn-redaction.js';

/**
 * JWT shape: three base64url segments separated by dots, each at least
 * 10 characters long. The length qualifier prevents false positives on
 * random short alphanumeric sequences that happen to contain two dots
 * (e.g. "a.b.c" or "v1.2.3" would not match). `eyJ` prefix anchors on
 * the standard JWT header (base64 encoding of `{"alg":...` or
 * `{"typ":...`).
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Redact secret-bearing tokens from a PTY output chunk.
 *
 * Replaces each JWT with `[REDACTED_JWT]` and each Social Security Number
 * with `[REDACTED-SSN]`, in-place. Non-token content (TUI ANSI escapes,
 * regular stdout, shell prompts, etc.) passes through unchanged. Safe to
 * call on every PTY chunk — the regexes are stateless and scale linearly
 * with input length.
 *
 * SSN scrubbing here is the conservative ruleset (formatted + per-chunk
 * context-keyed) — see `redactSSN`. The common same-chunk case
 * (`SSN: 123-45-6789`) is caught directly. A label and its number split across
 * a chunk boundary is CLOSED by the label-region and mid-label holdbacks in
 * OutputBuffer.push() (`splitTrailingPartialSsnLabel` /
 * `splitTrailingPartialSsnLabelPrefix`), and a formatted SSN split across the
 * boundary is reassembled via the partial-SSN holdback. See SPEC.md
 * "Label-context separation dimensions" for the closed forms and the bounded
 * residuals (1-char-aligned label split; number-mid-run past the holdback
 * window).
 */
export function redactSecrets(data: string): string {
  return redactSSN(data.replace(JWT_PATTERN, '[REDACTED_JWT]'));
}

/**
 * Maximum number of trailing characters that may be held back as a
 * potential partial JWT across a chunk boundary. JWTs observed in the
 * origin audit were 300-500 bytes; 2KB covers outsized tokens while
 * bounding the worst case for legitimate base64 output that merely
 * starts with `eyJ` (base64 of `{"` — any base64-encoded JSON).
 */
export const MAX_PARTIAL_HOLDBACK = 2048;

/**
 * A trailing substring that could be the PREFIX of a JWT split across a
 * chunk boundary: `eyJ` followed by up to two dot-separated base64url
 * segments, anchored at end-of-string. Note: segments here have no
 * minimum length — a boundary can fall anywhere inside the token,
 * INCLUDING inside the `eyJ` header prefix itself. The `ey?` alternative
 * holds back a bare trailing `e` or `ey` so a token split after the
 * first or second prefix byte (chunk 1 ends `...e`, chunk 2 starts
 * `yJ...`) is still reassembled and redacted. Without it, neither chunk
 * matches JWT_PATTERN on its own and the full token reaches the disk
 * log once OutputBuffer's writes are concatenated. The cost is tiny: at
 * most 2 extra bytes deferred to the next chunk (or flushed verbatim at
 * close() — a bare prefix fragment carries no token material).
 */
const PARTIAL_JWT_AT_END = /(?:eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}|ey?)$/;

/**
 * A held tail that is ONLY a fragment of the `eyJ` header prefix —
 * contains no header/payload/signature bytes, so it is safe to emit
 * verbatim if the stream ends while it is held (see OutputBuffer.close).
 */
export const BARE_PREFIX_FRAGMENT = /^(?:e|ey|eyJ)$/;

/** A string that is, in its entirety, a complete JWT shape. */
const COMPLETE_JWT = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

/**
 * Split a chunk into `[emit, hold]` where `hold` is a trailing substring
 * that could be the prefix of a JWT continuing in the next chunk.
 *
 * The caller (OutputBuffer.push) prepends `hold` to the next incoming
 * chunk before redacting, so a token split across the OS chunk boundary
 * is reassembled and caught by `redactSecrets`.
 *
 * Two deliberate non-holds:
 * - Candidate longer than MAX_PARTIAL_HOLDBACK: almost certainly a
 *   legitimate base64 blob, not a credential — emit unchanged rather
 *   than withhold large amounts of output.
 * - Candidate that is ALREADY a complete JWT shape: redactSecrets will
 *   catch it in this chunk. Emitting now avoids indefinitely withholding
 *   the final output of a session. (If the token actually continues into
 *   the next chunk, only a signature fragment can appear in the log —
 *   header and payload are redacted here, so nothing usable leaks.)
 */
export function splitTrailingPartialJwt(data: string): [string, string] {
  const m = data.match(PARTIAL_JWT_AT_END);
  if (!m || m.index === undefined) return [data, ''];
  const candidate = m[0];
  if (candidate.length > MAX_PARTIAL_HOLDBACK) return [data, ''];
  if (COMPLETE_JWT.test(candidate)) return [data, ''];
  return [data.slice(0, m.index), candidate];
}
