import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtxEnv } from '../../../src/types/index.js';
import {
  applyUnattendedConsent,
  recordUnattendedConsent,
  unattendedConsentPath,
} from '../../../src/utils/claude-preflight.js';

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

function makeRespawnHandle() {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number; signal: number }) => void) | undefined;
  const fake = {
    pid: 123,
    write: vi.fn(),
    onData: vi.fn((callback: (data: string) => void) => {
      onData = callback;
      return { dispose: () => undefined };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number; signal: number }) => void) => {
      onExit = callback;
      return { dispose: () => undefined };
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
  return {
    fake,
    emitData: (data: string) => onData?.(data),
    emitExit: () => onExit?.({ exitCode: 0, signal: 0 }),
  };
}

describe('AgentPTY corrupt unattended consent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails closed across args, preflight, and bypass matching', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    writeFileSync(unattendedConsentPath(frameworkRoot), '{broken');
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    let onData: ((data: string) => void) | undefined;
    let capturedArgs: string[] = [];
    const fakePty = {
      pid: 123,
      write: vi.fn(),
      onData: vi.fn((callback: (data: string) => void) => {
        onData = callback;
        return { dispose: () => undefined };
      }),
      onExit: vi.fn(() => ({ dispose: () => undefined })),
      kill: vi.fn(),
      resize: vi.fn(),
    };
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn((_file: string, args: string[]) => {
      capturedArgs = args;
      return fakePty;
    });

    await pty.spawn('fresh', 'hello');
    onData?.(
      'Claude Code is running in Bypass Permissions mode.\n' +
      '  1. No, exit\n' +
      '  2. Yes, I accept\n',
    );
    vi.advanceTimersByTime(32000);

    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
    expect(fakePty.write).not.toHaveBeenCalledWith('\x1b[B\r');
  });

  it.each([
    ['grant', true, true],
    ['opt-out', false, false],
  ])('preserves an existing %s through a defaulted rerun and next spawn', async (
    _label,
    consent,
    expectsFlag,
  ) => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    recordUnattendedConsent(frameworkRoot, consent, {
      source: consent ? 'consent-command' : 'scripted-installer-opt-out',
    });
    const before = readFileSync(unattendedConsentPath(frameworkRoot), 'utf8');

    expect(applyUnattendedConsent(false, frameworkRoot, {
      source: 'non-interactive-default',
    })).toMatchObject({ ok: true, recorded: false, preserved: true, existingValue: consent });
    expect(readFileSync(unattendedConsentPath(frameworkRoot), 'utf8')).toBe(before);

    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    const fakePty = makeRespawnHandle().fake;
    const spawnFn = vi.fn().mockReturnValue(fakePty);
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'hello');

    const args = spawnFn.mock.calls[0][1] as string[];
    expect(args.includes('--dangerously-skip-permissions')).toBe(expectsFlag);
  });

  it('keeps a prior decline effective when a later grant preflight fails', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'agent-consent-home-'));
    recordUnattendedConsent(frameworkRoot, false, { source: 'consent-command' });
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const write = (filePath: string, data: string) => {
      if (filePath === settingsPath) throw new Error('settings write failed');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, frameworkRoot, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: false, recorded: false, folderReady: true, bypassReady: false });

    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    const fakePty = makeRespawnHandle().fake;
    const spawnFn = vi.fn().mockReturnValue(fakePty);
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'hello');

    expect(spawnFn.mock.calls[0][1]).not.toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
  });

  it('fails closed when an accepted record becomes corrupt before same-instance respawn', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    recordUnattendedConsent(frameworkRoot, true, { source: 'test' });
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    const first = makeRespawnHandle();
    const second = makeRespawnHandle();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(first.fake)
      .mockReturnValueOnce(second.fake);
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'first');
    expect(spawnFn.mock.calls[0][1]).toContain('--dangerously-skip-permissions');
    first.emitExit();

    writeFileSync(unattendedConsentPath(frameworkRoot), '{broken');
    vi.clearAllMocks();
    await pty.spawn('fresh', 'second');
    second.emitData(
      'Claude Code is running in Bypass Permissions mode.\n' +
      '  1. No, exit\n' +
      '  2. Yes, I accept\n',
    );
    vi.advanceTimersByTime(32000);

    expect(spawnFn.mock.calls[0][1]).not.toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).not.toHaveBeenCalled();
    expect(second.fake.write).not.toHaveBeenCalledWith('\x1b[B\r');
  });

  it('enables accepted consent repaired before same-instance respawn', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    recordUnattendedConsent(frameworkRoot, false, { source: 'test' });
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    const first = makeRespawnHandle();
    const second = makeRespawnHandle();
    const spawnFn = vi.fn()
      .mockReturnValueOnce(first.fake)
      .mockReturnValueOnce(second.fake);
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = spawnFn;

    await pty.spawn('fresh', 'first');
    expect(spawnFn.mock.calls[0][1]).not.toContain('--dangerously-skip-permissions');
    first.emitExit();

    recordUnattendedConsent(frameworkRoot, true, { source: 'test' });
    await pty.spawn('fresh', 'second');

    expect(spawnFn.mock.calls[1][1]).toContain('--dangerously-skip-permissions');
  });

  it('keeps the legacy flag and logs the resolved path on every spawn when no record exists', async () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'agent-consent-'));
    const env: CtxEnv = {
      instanceId: 'test',
      ctxRoot: join(frameworkRoot, '.ctx'),
      frameworkRoot,
      agentName: 'agent-test',
      agentDir: frameworkRoot,
      org: 'testorg',
      projectRoot: frameworkRoot,
    };
    const capturedArgs: string[][] = [];
    const exitCallbacks: Array<(event: { exitCode: number; signal: number }) => void> = [];
    const fakePtys = [0, 1].map(() => ({
      pid: 123,
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: () => undefined })),
      onExit: vi.fn((callback: (event: { exitCode: number; signal: number }) => void) => {
        exitCallbacks.push(callback);
        return { dispose: () => undefined };
      }),
      kill: vi.fn(),
      resize: vi.fn(),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pty = new AgentPTY(env, { vendor: 'anthropic' });
    (pty as unknown as { spawnFn: unknown }).spawnFn = vi.fn((_file: string, args: string[]) => {
      capturedArgs.push(args);
      return fakePtys[capturedArgs.length - 1];
    });

    await pty.spawn('fresh', 'first');
    exitCallbacks[0]({ exitCode: 0, signal: 0 });
    await pty.spawn('fresh', 'second');

    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[0]).toContain('--dangerously-skip-permissions');
    expect(capturedArgs[1]).toContain('--dangerously-skip-permissions');
    expect(preflightMocks.ensureBypassPromptSuppressed).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining(unattendedConsentPath(frameworkRoot)));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining(unattendedConsentPath(frameworkRoot)));
    warn.mockRestore();
  });
});
