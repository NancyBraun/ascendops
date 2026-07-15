import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the inbox-write sink so sendMessage is a spy and never touches disk.
vi.mock('../../../src/bus/message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bus/message.js')>();
  return { ...actual, sendMessage: vi.fn() };
});

// Mock SlackAPI so getUserInfo + getBotUserId are controllable per-test and no
// network happens.
const getUserInfoMock = vi.fn();
const getBotUserIdMock = vi.fn();
vi.mock('../../../src/slack/api.js', () => ({
  SlackAPI: vi.fn().mockImplementation(function () {
    return { getUserInfo: getUserInfoMock, getBotUserId: getBotUserIdMock };
  }),
}));

import { SlackSocketListener } from '../../../src/daemon/slack-socket-listener.js';
import { sendMessage } from '../../../src/bus/message.js';
import type { SlackMessageEvent } from '../../../src/slack/slack-socket.js';
import type { BusPaths, TeamMember } from '../../../src/types/index.js';

const sendMessageMock = vi.mocked(sendMessage);

// Minimal BusPaths stub — handleMessage never reads disk because sendMessage is mocked.
const paths = { ctxRoot: '/tmp/fake' } as unknown as BusPaths;

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    channel: 'C123',
    user: 'U999',
    text: 'hello team',
    ts: '1700000000.000100',
    ...overrides,
  };
}

function makeListener(
  log: (msg: string) => void = () => {},
  extra: { trustedSlackUsers?: string[]; teamMembers?: TeamMember[] } = {},
): SlackSocketListener {
  return new SlackSocketListener({
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    channel: 'C123',
    agentName: 'collie',
    paths,
    log,
    trustedSlackUsers: extra.trustedSlackUsers,
    teamMembers: extra.teamMembers,
  });
}

describe('SlackSocketListener.handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserInfoMock.mockReset();
    getBotUserIdMock.mockReset();
    // Default: identity resolves to a handle + display name, no network.
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    // Default: own bot id unknown (auth.test "fails") -> own-id check skipped,
    // so existing cases behave exactly as before the self-echo guard.
    getBotUserIdMock.mockResolvedValue(null);
  });

  it('happy path: resolves display name + handle and writes one inbox message', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    const listener = makeListener();

    await listener.handleMessage(makeEvent());

    const expectedText =
      '=== SLACK from Carlos Calel (@carlos.calel) (channel:C123 ts:1700000000.000100) ===\n' +
      'hello team\n' +
      'Reply using: cortextos bus send-slack C123 "<reply>"';

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      paths,
      'fast-checker',
      'collie',
      'normal',
      expectedText,
    );
    // Spot-check the load-bearing substrings.
    const actualText = sendMessageMock.mock.calls[0][4];
    expect(actualText).toContain('from Carlos Calel (@carlos.calel)');
    expect(actualText).toContain('ts:1700000000.000100');
    expect(actualText).toContain('channel:C123');
  });

  it('enriched "from {name} (@handle, trust)" when team_members has the handle', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'brittany.hunter', displayName: 'Brittany Hunter' });
    const teamMembers: TeamMember[] = [
      { name: 'Brittany Hunter', role: 'Ops', slack_handle: 'brittany.hunter', trust_level: 'owner' },
    ];
    const listener = makeListener(() => {}, { teamMembers });

    await listener.handleMessage(makeEvent({ user: 'UBRIT' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const text = sendMessageMock.mock.calls[0][4] as string;
    expect(text.split('\n')[0]).toBe(
      '=== SLACK from Brittany Hunter (@brittany.hunter, owner) (channel:C123 ts:1700000000.000100) ===',
    );
  });

  it('untrusted user dropped when allowlist configured + sender not listed', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'random.person', displayName: 'Random Person' });
    const logSpy = vi.fn();
    const listener = makeListener(logSpy, { trustedSlackUsers: ['brittany.hunter'] });

    await listener.handleMessage(makeEvent({ user: 'URAND' }));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('dropped (not in allowlist)'))).toBe(true);
  });

  it('loud-open warning logged once when trustedSlackUsers unset', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    const logSpy = vi.fn();
    const listener = makeListener(logSpy); // no trustedSlackUsers

    await listener.handleMessage(makeEvent());
    await listener.handleMessage(makeEvent());

    const warnCalls = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes('allowlist not configured'),
    );
    expect(warnCalls).toHaveLength(1);
    // Both messages still delivered (open == allowed).
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('exact formatted string shape: header, body line, reply line', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    const listener = makeListener();

    await listener.handleMessage(makeEvent());

    const text = sendMessageMock.mock.calls[0][4] as string;
    const lines = text.split('\n');
    expect(lines[0]).toBe('=== SLACK from Carlos Calel (@carlos.calel) (channel:C123 ts:1700000000.000100) ===');
    expect(lines[1]).toBe('hello team');
    expect(lines[2]).toBe('Reply using: cortextos bus send-slack C123 "<reply>"');
  });

  // A captionless file/photo share has no text field — the body must be empty,
  // NOT the literal string "undefined".
  it('captionless share (no text) renders an empty body, never "undefined"', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    const listener = makeListener();

    await listener.handleMessage(makeEvent({ text: undefined as unknown as string }));

    const text = sendMessageMock.mock.calls[0][4] as string;
    expect(text).not.toContain('undefined');
    const lines = text.split('\n');
    expect(lines[0]).toBe('=== SLACK from Carlos Calel (@carlos.calel) (channel:C123 ts:1700000000.000100) ===');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Reply using: cortextos bus send-slack C123 "<reply>"');
  });

  it('getUserInfo failing (null) falls back to the raw user id as display name', async () => {
    getUserInfoMock.mockResolvedValue(null);
    const listener = makeListener();

    await listener.handleMessage(makeEvent({ user: 'U777' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const text = sendMessageMock.mock.calls[0][4] as string;
    // No handle resolved -> bare display name (the user id), no "(@...)" token.
    expect(text).toContain('from U777');
    expect(text.startsWith('=== SLACK from U777 (channel:C123 ts:1700000000.000100) ===')).toBe(true);
  });

  // Self-echo guard: the agent's own outbound posts arrive back as inbound with
  // user = our own bot user id. They must be dropped (no inbox write), or any
  // future auto-reply would loop infinitely.
  it('drops a message authored by our own bot user id (self-echo)', async () => {
    getBotUserIdMock.mockResolvedValue('UBOTSELF');
    const logSpy = vi.fn();
    const listener = makeListener(logSpy, { trustedSlackUsers: ['carlos.calel'] });

    await listener.handleMessage(makeEvent({ user: 'UBOTSELF', text: 'my own reply' }));

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('self-echo guard'))).toBe(true);
  });

  it('resolves own bot id once and caches it across messages (single auth.test)', async () => {
    getBotUserIdMock.mockResolvedValue('UBOTSELF');
    const listener = makeListener(() => {}, { trustedSlackUsers: ['carlos.calel'] });

    await listener.handleMessage(makeEvent({ user: 'U999' }));
    await listener.handleMessage(makeEvent({ user: 'U999' }));

    // Own-id lookup happens once, not per-message.
    expect(getBotUserIdMock).toHaveBeenCalledTimes(1);
    // A normal sender is still delivered (guard does not over-block).
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('auth.test unavailable (null own id) does not block a real user (graceful skip)', async () => {
    getBotUserIdMock.mockResolvedValue(null);
    const listener = makeListener(() => {}, { trustedSlackUsers: ['carlos.calel'] });

    await listener.handleMessage(makeEvent({ user: 'U999' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  // Single-flight: a burst of messages arriving before the first auth.test
  // resolves must share ONE lookup, not fan out into N parallel API calls.
  it('a concurrent message burst shares one in-flight auth.test lookup', async () => {
    let resolveAuth!: (v: string | null) => void;
    getBotUserIdMock.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveAuth = resolve;
      }),
    );
    const listener = makeListener(() => {}, { trustedSlackUsers: ['carlos.calel'] });

    const p1 = listener.handleMessage(makeEvent({ ts: '1700000000.000100' }));
    const p2 = listener.handleMessage(makeEvent({ ts: '1700000000.000200' }));
    resolveAuth('UBOTSELF');
    await Promise.all([p1, p2]);

    expect(getBotUserIdMock).toHaveBeenCalledTimes(1);
    // Both real-user messages still delivered.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  // A transient auth.test failure must not permanently disable the self-echo
  // guard — but the retry is cooldown-gated so a hard outage doesn't add an
  // auth.test call to every single message.
  it('failed own-id lookup retries after the cooldown, not on every message', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
      getBotUserIdMock.mockResolvedValue(null);
      const listener = makeListener(() => {}, { trustedSlackUsers: ['carlos.calel'] });

      await listener.handleMessage(makeEvent({ user: 'U999' }));
      await listener.handleMessage(makeEvent({ user: 'U999' }));
      // Within the cooldown: the failure is not re-probed per message.
      expect(getBotUserIdMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(2);

      // Past the cooldown the lookup is retried — and now succeeds, so a
      // subsequent self-echo is dropped.
      vi.setSystemTime(new Date('2026-06-10T12:01:01Z'));
      getBotUserIdMock.mockResolvedValue('UBOTSELF');
      await listener.handleMessage(makeEvent({ user: 'UBOTSELF', text: 'my own reply' }));

      expect(getBotUserIdMock).toHaveBeenCalledTimes(2);
      // Still only the two earlier deliveries — the self-echo was dropped.
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Collie medium fold-in: a PERMANENT Slack auth failure (token dead, socket
  // client stopped reconnecting) must be surfaced loudly and visibly — never
  // just a log line that scrolls past.
  describe('handleFatalAuthError (permanent auth failure surfacing)', () => {
    it('writes an URGENT inbox message, latches the queryable state, and fires the daemon alert', () => {
      const logSpy = vi.fn();
      const onFatal = vi.fn();
      const listener = new SlackSocketListener({
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        channel: 'C123',
        agentName: 'collie',
        paths,
        log: logSpy,
        onFatalAuthError: onFatal,
      });

      listener.handleFatalAuthError('invalid_auth');

      // 1. Persistent, heartbeat-surfaceable error state.
      expect(listener.getLastFatalAuthError()).toBe('invalid_auth');

      // 2. URGENT agent-inbox message (NOT 'normal' like ordinary traffic) —
      //    the agent sees it and relays to the operator.
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        paths,
        'fast-checker',
        'collie',
        'urgent',
        expect.stringContaining('SLACK CONNECTION DEAD'),
      );
      const inboxText = sendMessageMock.mock.calls[0][4] as string;
      expect(inboxText).toContain('invalid_auth');
      expect(inboxText).toContain('NOT self-heal');
      expect(inboxText).toContain('ACTION REQUIRED');

      // 3. Daemon-level operator alert callback (agent-manager → Telegram).
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledWith('invalid_auth');
    });

    it('never throws even when both the inbox write and the alert callback fail', () => {
      sendMessageMock.mockImplementation(() => {
        throw new Error('disk full');
      });
      const logSpy = vi.fn();
      const listener = new SlackSocketListener({
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        channel: 'C123',
        agentName: 'collie',
        paths,
        log: logSpy,
        onFatalAuthError: () => {
          throw new Error('telegram down');
        },
      });

      expect(() => listener.handleFatalAuthError('token_revoked')).not.toThrow();
      // State still latched despite both surfaces failing.
      expect(listener.getLastFatalAuthError()).toBe('token_revoked');
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('fatal-auth inbox write failed'))).toBe(true);
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('fatal-auth operator alert failed'))).toBe(true);
    });

    it('works without the optional daemon callback (inbox surface alone)', () => {
      const listener = makeListener();
      listener.handleFatalAuthError('account_inactive');
      expect(listener.getLastFatalAuthError()).toBe('account_inactive');
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][3]).toBe('urgent');
    });
  });

  it('sendMessage throwing does not throw out of handleMessage and is logged', async () => {
    getUserInfoMock.mockResolvedValue({ handle: 'carlos.calel', displayName: 'Carlos Calel' });
    sendMessageMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const logSpy = vi.fn();
    // Configure the allowlist (with this sender) so the loud-open warning does
    // not also fire — isolating the write-failure log.
    const listener = makeListener(logSpy, { trustedSlackUsers: ['carlos.calel'] });

    await expect(listener.handleMessage(makeEvent())).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('Slack socket inbox write failed');
  });
});
