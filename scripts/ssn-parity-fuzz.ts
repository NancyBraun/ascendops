/**
 * JS↔python SSN-redactor differential parity fuzz.
 *
 * The two redactors (src/utils/ssn-redaction.ts `redactSSN` and
 * knowledge-base/scripts/mmrag.py `scrub_ssn`) must produce byte-identical
 * output, or a connector SSN scrubbed by one path leaks through the other (the
 * KB vector store runs the python path; the JS Layer-2 sinks run the JS path).
 * JS and python `re` differ on \b, \d, \s, case-fold, $ — so the parity is held
 * by explicit/ASCII-pinned classes (SSN_SEP, INVIS, LABEL_SEP) and `re.ASCII`.
 *
 * This is the PROOF those hold: it feeds a Unicode codepoint into every
 * structural position of every pattern (label separator, label↔number gap,
 * inside each digit group, around each separator, leading/trailing adjacency,
 * case) and asserts redactSSN(x) === scrub_ssn(x) for every input. Exits
 * non-zero on the first divergence. Run: `npx tsx scripts/ssn-parity-fuzz.ts`.
 */
import { redactSSN } from '../src/utils/ssn-redaction.js';
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const cps: number[] = [];
for (let c = 0; c <= 0x3200; c++) cps.push(c); // ASCII + Latin + all \s / many Cf boundaries
for (const c of [0xfeff, 0xfe0f, 0x034f, 0x115f, 0x3164, 0xffa0, 0x1bca0, 0x1d173, 0xe0001,
  0x0085, 0x001c, 0x202e, 0x2066, 0x200d, 0x200c, 0x2060]) cps.push(c);

const templates = [
  'social{C}security 123456789', 'tax{C}id 123456789', 'ssn{C}123456789',
  'social security{C}987654321', '12{C}3-45-6789', '123{C}45{C}6789', '987{C}654321 ssn',
  '{C}123-45-6789', '123-45-6789{C}', 'ref 12345678{C}9', 'SSN {C}987654321',
  '{C}987654321 tax id', 'café{C}123-45-6789',
  // PII v2 m2 — EIN/routing/bank + collision-boundary templates. The single-cp
  // sweep injects a Unicode codepoint into every structural position of each new
  // pattern (label separator, label↔number gap, inside the formatted-EIN groups,
  // around the EIN separator, adjacency) so the new label/format classes are held
  // to the same JS↔python parity as SSN.
  'ein{C}123456789', 'employer id{C}123456789', 'fein{C}123456789',
  'employer{C}identification 123456789', 'federal tax id{C}123456789',
  '12{C}3456789', '12-34{C}56789', 'ein{C}12-3456789', '12-3456789{C}ein',
  'ssn{C}12-3456789', 'routing{C}021000021', 'aba{C}021000021',
  'routing number{C}021000021', 'routing transit{C}021000021',
  'bank account{C}123456789012', 'account number{C}123456789', 'bank acct{C}12345678',
  'bank account{C}123456789', 'ssn routing{C}123456789', 'ssn{C}123456789 ein',
  'routing{C}021000021 ssn', 'ref{C}123456789012 end', 'zip 12345{C}6789',
  // F5 — snake_case multi-word label forms (LABEL_SEP includes `_`). `\b` treats
  // `_` as a word char so bare `\brouting\b`/`\bein\b` miss `routing_number`/
  // `ein_number`; the added forms must change IDENTICALLY in TS+python. Inject a
  // codepoint into the LABEL_SEP slot of each snake_case compound + the FP guards.
  'routing{C}number 021000021', 'aba{C}routing 021000021',
  'ein{C}number 123456789', 'fein{C}number 123456789',
  'routing_table{C}021000021', 'routing_protocol{C}021000021',
  // Letter-class-boundary structural fix (supersedes F5 multi-word-only fix): the
  // new-entry in-text label matchers use `(?<![a-z])…(?![a-z])` (EIN/bank) and the
  // asymmetric `(?<![a-z])…(?![a-z0-9_])` (routing). Inject a codepoint into the
  // LABEL_SEP slot of the snake_case value-key compounds + the leading/trailing
  // boundary adjacency of the letter-glued FP guards, so the boundary classes are
  // held to JS↔python parity (a `\b`-vs-letter-class divergence would surface here).
  'ein{C}value 123456789', 'bank{C}account{C}number 123456789012',
  '{"routing{C}number":"021000021"}', '{"bank{C}account{C}number":"123456789012"}',
  'being{C}123456789', 'Einstein{C}123456789', 'embankment{C}123456789',
  'a{C}routing_table 021000021', 'rerouting{C}123456789',
];

const inputs: string[] = [];
for (const t of templates) for (const c of cps) inputs.push(t.replace('{C}', String.fromCodePoint(c)));

// REPEATED-RUN model — the single-codepoint model above cannot construct a
// multi-char run, so it missed the UTF-16-vs-codepoint gap-arithmetic divergence
// (an ASTRAL char counts as 2 UTF-16 units but 1 codepoint, so a run of 8+ astral
// invisibles in the label↔number gap shifted the JS offset past [\s\S]{0,16}
// while python's codepoint index stayed within). Inject runs of k copies of a
// representative codepoint (esp. ASTRAL) at EVERY structural position, straddling
// the 16-codepoint gap boundary.
const runChars = [
  0x1d173, 0xe0001, 0x1bca0, // astral invisibles (surrogate pairs)
  0x200b, 0xfeff, 0x0085, 0x00a0, 0x0041, 0x0301, // BMP invisibles + space + letter + combining
];
const runLens = [1, 2, 3, 7, 8, 9, 12, 15, 16, 17, 20, 30];
const runTemplates = [
  'ssn{R}987654321', 'ssn {R} 987654321', 'tax id{R}987654321',
  'social security{R}987654321', '987654321{R}ssn', '12{R}3-45-6789',
  '123-45{R}-6789', '{R}987654321 ssn', 'social{R}security 987654321',
  // PII v2 m2 — multi-char (esp. astral) runs straddling the 16-codepoint gap
  // boundary for the new label↔number gaps and inside the formatted-EIN groups,
  // so the UTF-16-vs-codepoint gap arithmetic stays in parity for EIN/routing/bank.
  'ein{R}123456789', 'employer id{R}123456789', 'fein{R}123456789',
  '12{R}3456789', 'routing{R}021000021', 'aba{R}021000021',
  'bank account{R}123456789012', 'account number{R}123456789',
  // F5 snake_case multi-word forms — multi-char (esp. astral) runs in the
  // LABEL_SEP slot of each compound, straddling the 16-codepoint gap boundary,
  // so the new routing_number/ein_number gap arithmetic stays in TS↔python parity.
  'routing{R}number 021000021', 'aba{R}routing 021000021',
  'ein{R}number 123456789', 'fein{R}number 123456789',
  // Letter-class-boundary fix — multi-char (esp. astral) runs in the LABEL_SEP slot
  // of the value-key compounds straddling the 16-codepoint gap boundary, so the
  // new boundary classes' gap arithmetic stays in TS↔python parity.
  'ein{R}value 123456789', 'bank account{R}number 123456789012',
];
for (const t of runTemplates) for (const cp of runChars) for (const k of runLens) {
  inputs.push(t.replace('{R}', String.fromCodePoint(cp).repeat(k)));
}

const jsOut = inputs.map((x) => redactSSN(x));

// Compute the python outputs in one subprocess over the same inputs.
const inFile = join(tmpdir(), `ssn-fuzz-in-${process.pid}.json`);
writeFileSync(inFile, JSON.stringify(inputs));
const pyScript = `
import json, sys
sys.path.insert(0, "knowledge-base/scripts")
import mmrag
inp = json.load(open(${JSON.stringify(inFile)}))
json.dump([mmrag.scrub_ssn(x) for x in inp], sys.stdout)
`;
const pyOut: string[] = JSON.parse(execFileSync('python3', ['-c', pyScript], { maxBuffer: 1 << 28 }).toString());

let divergences = 0;
for (let i = 0; i < inputs.length; i++) {
  if (jsOut[i] !== pyOut[i]) {
    divergences++;
    if (divergences <= 10) {
      console.error(`DIVERGENCE: in=${JSON.stringify(inputs[i])} JS=${JSON.stringify(jsOut[i])} PY=${JSON.stringify(pyOut[i])}`);
    }
  }
}

console.log(`ssn-parity-fuzz: ${inputs.length} inputs, ${divergences} divergences`);
if (divergences > 0) process.exit(1);
