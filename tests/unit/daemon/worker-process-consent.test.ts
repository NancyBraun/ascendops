import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preflightMocks = vi.hoisted(() => ({
  ensureFolderTrusted: vi.fn(() => true),
  ensureBypassPromptSuppressed: vi.fn(() => true),
}));

vi.mock('../../../src/utils/claude-preflight.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/claude-preflight.js')>(
    '../../../src/utils/claude-preflight.js',
  );
  return { ...actual, ...preflightMocks };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');
const { WorkerProcess } = await import('../../../src/daemon/worker-process.js');
const { recordUnattendedConsent, unattendedConsentPath } = await import('../../../src/utils/claude-preflight.js');

describe('WorkerProcess unattended consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])('inherits install-level consent %s through AgentPTY spawn', async (consent) => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'worker-consent-'));
    recordUnattendedConsent(frameworkRoot, consent, { source: 'worker-test' });
    const env = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'worker-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    let capturedArgs: string[] = [];
    const fakePty = {
      pid: 123,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
    };
    const factory = (ptyEnv: typeof env, config: { model?: string }, logPath: string) => {
      const pty = new AgentPTY(ptyEnv, config, logPath);
      (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn((_file: string, args: string[]) => {
        capturedArgs = args;
        return fakePty;
      });
      return pty;
    };

    const worker = new WorkerProcess('worker-test', frameworkRoot, 'parent');
    await worker.spawn(env, 'do work', { model: 'claude-sonnet-4-6' }, factory);

    expect(capturedArgs.includes('--dangerously-skip-permissions')).toBe(consent);
  });

  it('fails closed when the install-level consent record is corrupt', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'worker-consent-'));
    writeFileSync(unattendedConsentPath(frameworkRoot), '{broken');
    const env = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'worker-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    let capturedArgs: string[] = [];
    const fakePty = {
      pid: 123,
      write: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn(),
      resize: vi.fn(),
    };
    const factory = (ptyEnv: typeof env, config: { model?: string }, logPath: string) => {
      const pty = new AgentPTY(ptyEnv, config, logPath);
      (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn((_file: string, args: string[]) => {
        capturedArgs = args;
        return fakePty;
      });
      return pty;
    };

    const worker = new WorkerProcess('worker-test', frameworkRoot, 'parent');
    await worker.spawn(env, 'do work', { model: 'claude-sonnet-4-6' }, factory);

    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
  });
});
