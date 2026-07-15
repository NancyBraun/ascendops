import { describe, it, expect } from 'vitest';

// Unit tests for context-threshold % extraction logic.
// These test the regex and ANSI-stripping that Signal 3 uses,
// isolated from the full FastChecker class.

const ANSI_STRIP_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Mirrors the production regex in src/daemon/fast-checker.ts (Signal 3 / F9):
// anchor on the FULL status-line shape "<marker>NN% context used", where
// <marker> is a progress-bar block (█/░) or status dot (🔴/🟡/🟢) that the live
// status line always carries immediately before the percent. Constraints:
//   - LEADING MARKER (F9, Codex P2 on c34f7b7): the F8 shape was unanchored, so
//     a bare literal "97%contextused" / "97% context used" printed anywhere
//     (source/diff/test/bus) matched as a status line and false-restarted. The
//     marker is the discriminator real renders have and prose does not.
//   - /u flag REQUIRED: the dots are astral (>U+FFFF); without /u JS matches a
//     lone surrogate half = broken.
//   - "used" ONLY (not "left"/"remaining") — the captured percent feeds a
//     USED-percent threshold; the inverse would silently under-trigger.
//   - [^\S\n] (same-line whitespace), NOT \s — \s matches newlines in JS, which
//     would let the match span adjacent stdout lines.
//   - BOTH gaps zero-or-more ({0,3} and *). ANSI is stripped FIRST; on the live
//     wire the cursor-position escapes are the only separators, so the stripped
//     status line collapses to "<marker>97%contextused" (zero whitespace).
const CTX_PCT_RE = /[█░\u{1F534}\u{1F7E1}\u{1F7E2}][^\S\n]*(\d{1,3})%[^\S\n]{0,3}context[^\S\n]*used/u;

// Build markers at RUNTIME so this test SOURCE file carries no matchable
// "<marker>NN% context used" sequence (it would otherwise become its own FP
// vector when an agent echoes this file to stdout — the very bug under test).
const BAR = String.fromCodePoint(0x2591); // ░ progress-bar block
const BLK = String.fromCodePoint(0x2588); // █ filled progress-bar block
const DOT = String.fromCodePoint(0x1F534); // 🔴 status dot (>=70%)
const YEL = String.fromCodePoint(0x1F7E1); // 🟡 status dot (mid)
const GRN = String.fromCodePoint(0x1F7E2); // 🟢 status dot (<70%)

function extractCtxPct(tail: string): number | null {
  const stripped = tail.replace(ANSI_STRIP_RE, '');
  const m = stripped.match(CTX_PCT_RE);
  return m ? parseInt(m[1], 10) : null;
}

describe('context threshold % extraction', () => {
  it('extracts % from a spaced marker status line (real render shape)', () => {
    // The live render carries a progress bar then a dot immediately before the
    // context-percent: "[Opus 4.8] main <bar>95%<dot> 97% context used" (markers
    // spelled out here so this comment is not itself an FP vector). The dot, not
    // the bar's 95%, anchors the capture → 97 (the context-used number).
    const tail = `[Opus 4.8] main ${BAR}95%${DOT} 97% context used`;
    expect(extractCtxPct(tail)).toBe(97);
  });

  it('extracts % from a fully ANSI-collapsed marker line (the live wire)', () => {
    // Production strips ANSI first; the cursor-position escapes are the only
    // separators, so the real line collapses to "<dot>97%contextused".
    const tail = `${DOT}97%contextused`;
    expect(extractCtxPct(tail)).toBe(97);
  });

  it('extracts % from a marker line with ANSI cursor escapes between tokens', () => {
    // Raw pre-strip shape: bar, dot, then ESC[NNNG column jumps between
    // percent / context / used. After strip → "<bar>95%<dot>97%contextused".
    const tail = `[Opus 4.8] main ${BLK}${BAR}95%${DOT}\x1b[183G97%\x1b[187Gcontext\x1b[195Gused`;
    expect(extractCtxPct(tail)).toBe(97);
  });

  it('extracts low % with a green dot (<70% color) — model/threshold agnostic', () => {
    const tail = `${GRN}12%contextused`;
    expect(extractCtxPct(tail)).toBe(12);
  });

  it('extracts % when the marker line is buried in surrounding output', () => {
    const tail = `some output\n[Opus 4.5] feature ${BAR}80%${DOT} 82% context used\nmore output`;
    expect(extractCtxPct(tail)).toBe(82);
  });

  it('ACCEPTED RESIDUAL: a faithful full-marker quote still matches (not 0-FP)', () => {
    // The content-matcher is defeated by a faithful quotation that reproduces a
    // real "<marker>NN% context used" render verbatim (e.g. this feature being
    // debugged in a bus message). This is the KNOWN, ACCEPTED residual —
    // near-zero in steady state, elevated only while this code is discussed.
    // The quotation-proof hardening (ANSI cursor envelope) is documented in
    // fast-checker.ts but intentionally not used (it would false-negative on
    // space-rendering terminals = Signal 3 silently disabled = worse failure).
    expect(extractCtxPct(`${DOT}97%contextused`)).toBe(97);
  });

  it('returns null for a MARKERLESS context-used literal (the production FP)', () => {
    // This is exactly the false positive F9 fixes: an agent echoing source, a
    // diff, a test fixture, or a bus message containing the bare literal — no
    // bar/dot marker — must NOT be read as a 97% status line.
    expect(extractCtxPct('97%contextused')).toBeNull();
    expect(extractCtxPct('[Opus 4.8] main · 97% context used')).toBeNull();
    expect(extractCtxPct('the session hit 85% context used last night')).toBeNull();
  });

  it('returns null when no status line present', () => {
    const tail = 'normal tool output without a status line';
    expect(extractCtxPct(tail)).toBeNull();
  });

  it('returns null for uppercase log-tag percentages without a context suffix', () => {
    for (const tail of [
      '[INFO] download progress 85%',
      '[WARN] retry budget 90%',
      '[ERROR] disk usage 95%',
      '[BUILD] bundle shrunk 88%',
    ]) {
      expect(extractCtxPct(tail)).toBeNull();
    }
  });

  it('returns null for marker "context left"/"remaining" — inverse semantics (Codex P2)', () => {
    // We match "used" ONLY. Even WITH a leading marker, a "left"/"remaining"
    // line reports the inverse (71% left = 29% used), so matching it would feed
    // the wrong number into pct >= ctxThresholdPct. Until a (100 - pct)
    // conversion exists, these must NOT match.
    expect(extractCtxPct(`[Opus 4.8] main ${DOT} 71% context left`)).toBeNull();
    expect(extractCtxPct(`[Opus 4.8] main ${DOT} 71% context remaining`)).toBeNull();
  });

  it('returns null when marker+percent and "context used" are on separate lines (Codex P2)', () => {
    // [^\S\n] pins the whole match to ONE line — a marker+percent on one stdout
    // line must not match "context used" on the next.
    expect(extractCtxPct(`${DOT}85%\ncontext used`)).toBeNull();
    expect(extractCtxPct(`build ${BAR}85%\n[Opus 4.8] main · context used`)).toBeNull();
  });

  it('returns null for prose where a percent precedes the word "context" (F8 FP fix)', () => {
    // Markerless prose — already killed by F8's "used" + same-line gap; stays
    // null under F9 (no marker either). "85% context switches" was a real FP.
    for (const tail of [
      '85% context switches',
      'reduced churn by 85% in the context of PR review',
      'hit the 85% proactive-context-reset',
      '85% of the context budget is gone',
      `${DOT}85% context switches`, // marker present but suffix is not "used"
    ]) {
      expect(extractCtxPct(tail)).toBeNull();
    }
  });
});

describe('context threshold cooldown logic', () => {
  it('injection fires when pct >= threshold and not in cooldown', () => {
    const threshold = 70;
    const pct = 75;
    const triggeredAt = 0; // never triggered
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;

    const shouldInject = pct >= threshold &&
      (triggeredAt === 0 || now - triggeredAt > COOLDOWN_MS);
    expect(shouldInject).toBe(true);
  });

  it('no re-injection within cooldown window', () => {
    const threshold = 70;
    const pct = 75;
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;
    const triggeredAt = now - (5 * 60 * 1000); // triggered 5 min ago (within cooldown)

    const shouldInject = pct >= threshold &&
      (triggeredAt === 0 || now - triggeredAt > COOLDOWN_MS);
    expect(shouldInject).toBe(false);
  });

  it('fallback hard restart fires after 15 min of no agent response', () => {
    const threshold = 70;
    const pct = 75;
    const now = Date.now();
    const COOLDOWN_MS = 10 * 60 * 1000;
    const FALLBACK_MS = 15 * 60 * 1000;
    const triggeredAt = now - (16 * 60 * 1000); // triggered 16 min ago

    const inCooldown = now - triggeredAt <= COOLDOWN_MS;
    const shouldFallback = !inCooldown && now - triggeredAt > FALLBACK_MS;
    expect(inCooldown).toBe(false);
    expect(shouldFallback).toBe(true);
  });
});
