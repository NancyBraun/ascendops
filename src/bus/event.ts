import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths, Heartbeat } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';
import { redactSSN, piiLabelKeyHint } from '../utils/ssn-redaction.js';

/**
 * Recursively scrub PII from every string value in an event metadata object
 * (Layer-2 never-STORE guarantee). Numbers/booleans/null are left untouched —
 * a PII value persisted as a bare JS number is not a realistic shape (leading
 * zeros would be lost) and scrubbing the serialized JSON would risk producing
 * invalid JSON for numeric values.
 *
 * `inheritedKey` carries — bounded to ONE wrapper level — the promoting PII KEY
 * of the immediate containing object, so `{ein:{value:"X"}}` /
 * `{bank_account:{value:"X"}}` / `{ssn:{value:"X"}}` all promote their nested
 * `value` under the right PII label, not just SSN. The inherited key is the
 * ORIGINAL parent key (resolved via the registry resolver `piiLabelKeyHint`,
 * the SINGLE source of truth — NOT a hand-rolled label list here), so redactSSN
 * re-tests it against every entry's predicate and the matching entry redacts.
 */
function scrubMetaStrings(value: unknown, keyHint?: string, inheritedKey?: string): unknown {
  // A leaf value's promoting label is its immediate KEY (keyHint) if that key is
  // itself a PII label, else — bounded to ONE wrapper level — the PII key of its
  // immediate containing object (inheritedKey). So {"ein":"X"} and
  // {"ein":{"value":"X"}} both promote, but a number nested deeper under a PII-ish
  // ancestor ({"ein":{"a":{"b":N}}}) is NOT promoted (conservative: don't nuke an
  // unrelated deep number — inheritance does not accumulate past one wrapper).
  // Only a key that ANCHORED-resolves to a real PII label (piiLabelKeyHint) — or a
  // one-wrapper inherited PII key — promotes a value. The raw `?? keyHint` fallback
  // was REMOVED: it passed an unresolved organic key (caffeine_level, routing_table)
  // straight to redactSSN's intentionally-unanchored labelHint predicate, which
  // re-over-matched the substring and false-redacted the value. Unresolved key ->
  // no labelHint -> conservative scrub (the value's own in-text labels still apply).
  const hint = piiLabelKeyHint(keyHint) ?? inheritedKey;
  if (typeof value === 'string') return redactSSN(value, { labelHint: hint });
  if (typeof value === 'number') {
    // A 9-digit numeric value under a PII-ish key is PII stored as a JSON number
    // (e.g. {"ssn":987654321}). Reuse redactSSN+labelHint on the stringified
    // value; if it changes, return the placeholder string.
    const asStr = String(value);
    const scrubbed = redactSSN(asStr, { labelHint: hint });
    return scrubbed === asStr ? value : scrubbed;
  }
  // Array elements inherit their array's labeling context unchanged.
  if (Array.isArray(value)) return value.map((v) => scrubMetaStrings(v, keyHint, inheritedKey));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // ONE wrapper level: a child inherits THIS object's key as its promoting
    // label only if THIS key is itself a PII label — it does not accumulate down
    // deeper levels. piiLabelKeyHint returns the key (any enabled PII entry
    // matched) or undefined.
    const childInherits = piiLabelKeyHint(keyHint);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Redact the KEY too — metadata keys are user-controlled and could carry
      // PII (e.g. {"tenant 123-45-6789":"present"}). The ORIGINAL key is the
      // child's labelHint so a bare-9 value under a PII key promotes.
      out[redactSSN(k)] = scrubMetaStrings(v, k, childInherits);
    }
    return out;
  }
  return value;
}

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Side-effect: if this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. Activity is liveness — if the agent is
 * logging events, it is by definition alive, so the stale-heartbeat
 * monitor should not page on it. Other fields (status, mode, etc.) are
 * preserved from the last explicit update-heartbeat call. Best-effort:
 * a failing heartbeat refresh never blocks the event write itself.
 * If no heartbeat file exists yet we do nothing — the first
 * update-heartbeat call creates it with full field values.
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  // Layer-2 backstop: never STORE an SSN. Scrub the event name and every
  // string value in the metadata before it is written to the JSONL log.
  const safeEventName = redactSSN(eventName);
  meta = scrubMetaStrings(meta) as Record<string, unknown>;

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: safeEventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp as a side-effect. See doc comment above.
  refreshHeartbeatTimestamp(paths, timestamp);
}

/**
 * Bump the `last_heartbeat` timestamp on the existing heartbeat.json,
 * preserving every other field. No-op when the file does not exist yet
 * or when any step fails — event writes are the authoritative record
 * and must never be blocked by heartbeat housekeeping.
 */
function refreshHeartbeatTimestamp(paths: BusPaths, timestamp: string): void {
  try {
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    if (!existsSync(hbPath)) return;
    // The read-modify-write below is NOT atomic against a concurrent
    // updateHeartbeat() overwrite: without a lock, this reader can load a
    // stale heartbeat, an explicit update-heartbeat can write new status/
    // mode/task fields, and then this write clobbers them back to stale
    // (TOCTOU lost-update). Take the per-agent stateDir lock — the SAME lock
    // updateHeartbeat() takes — so the read+write is serialized against it.
    // withFileLockSync may throw on timeout; the surrounding try/catch keeps
    // the refresh best-effort and never blocks the already-persisted event.
    withFileLockSync(paths.stateDir, () => {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      hb.last_heartbeat = timestamp;
      atomicWriteSync(hbPath, JSON.stringify(hb));
    });
  } catch {
    // Best-effort — event already persisted, heartbeat refresh is secondary.
  }
}
