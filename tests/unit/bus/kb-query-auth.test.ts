import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

// Spy the mmrag spawn so we can (a) prove a refused query never spawns it and
// (b) inspect the --collection an ALLOWED query addresses. Real guard, real
// query path (queryKnowledgeBase), not a mocked collection-arg.
const execFileSyncSpy = vi.fn(() => '{"results":[]}');
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncSpy(...args),
}));

import { queryKnowledgeBase, assertQueryIdentity } from '../../../src/bus/knowledge-base.js';

const INST = `kbq-auth-${process.pid}`;
const ORG = 'ascendops';
const FW = join(tmpdir(), `kbq-fw-${Date.now()}`);
const KB_ROOT = join(homedir(), '.cortextos', INST, 'orgs', ORG, 'knowledge-base');
const PATHS = {} as never; // query path does not use BusPaths

type Scope = 'shared' | 'private' | 'all';
function q(opts: { scope?: Scope; agent?: string; requestedAgent?: string }) {
  return queryKnowledgeBase(PATHS, 'question', {
    org: ORG, frameworkRoot: FW, instanceId: INST, ...opts,
  });
}
function collectionsQueried(): string[] {
  return execFileSyncSpy.mock.calls
    .map((c) => c[1] as string[])
    .map((argv) => argv[argv.indexOf('--collection') + 1]);
}

describe('private KB query — caller-scoped identity (real guard)', () => {
  beforeEach(() => {
    execFileSyncSpy.mockReset();
    execFileSyncSpy.mockReturnValue('{"results":[]}');
    mkdirSync(KB_ROOT, { recursive: true }); // kbConfigured -> true for the ALLOW cases
    writeFileSync(join(KB_ROOT, 'config.json'), '{}');
  });
  afterEach(() => rmSync(join(homedir(), '.cortextos', INST), { recursive: true, force: true }));

  // ── REJECT ──
  it('REFUSES a mismatched --agent private query (agent-<other>) and never spawns mmrag', () => {
    expect(() => q({ scope: 'private', agent: 'dane', requestedAgent: 'aussie' })).toThrow(/BLOCKED/);
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });
  it('REFUSES a mismatched --agent under scope=all', () => {
    expect(() => q({ scope: 'all', agent: 'dane', requestedAgent: 'aussie' })).toThrow(/BLOCKED/);
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });
  it('REFUSES private scope with no runtime identity (not addressable)', () => {
    expect(() => q({ scope: 'private', agent: undefined })).toThrow(/BLOCKED/);
  });

  // ── ALLOW (must-preserve) ──
  it('ALLOWS own-private (explicit --agent == runtime identity) -> addresses agent-<self> ONLY', () => {
    q({ scope: 'private', agent: 'dane', requestedAgent: 'dane' });
    expect(collectionsQueried()).toEqual(['agent-dane']);
  });
  it('ALLOWS own-private with no explicit --agent (uses runtime identity) -> agent-<self>', () => {
    q({ scope: 'private', agent: 'dane' });
    expect(collectionsQueried()).toEqual(['agent-dane']);
  });
  it('shared scope with no agent is unaffected -> shared-<org>', () => {
    q({ scope: 'shared' });
    expect(collectionsQueried()).toEqual([`shared-${ORG}`]);
  });
  it('scope=all with a runtime identity -> shared + own private only', () => {
    q({ scope: 'all', agent: 'dane' });
    expect(collectionsQueried()).toEqual([`shared-${ORG}`, 'agent-dane']);
  });
  it('scope=all with no runtime identity -> shared-only (no agent-<X>)', () => {
    q({ scope: 'all' });
    expect(collectionsQueried()).toEqual([`shared-${ORG}`]);
  });

  // ── direct guard matrix (supplements the wired tests) ──
  it('assertQueryIdentity: own-private allowed, cross-agent refused, shared always fine', () => {
    expect(() => assertQueryIdentity('private', 'dane', 'dane')).not.toThrow();
    expect(() => assertQueryIdentity('private', 'dane', undefined)).not.toThrow();
    expect(() => assertQueryIdentity('all', 'dane', undefined)).not.toThrow();
    expect(() => assertQueryIdentity('private', 'dane', 'aussie')).toThrow(/BLOCKED/);
    expect(() => assertQueryIdentity('all', 'dane', 'aussie')).toThrow(/BLOCKED/);
    expect(() => assertQueryIdentity('private', undefined, undefined)).toThrow(/BLOCKED/);
    expect(() => assertQueryIdentity('shared', undefined, 'aussie')).not.toThrow();
  });
});
