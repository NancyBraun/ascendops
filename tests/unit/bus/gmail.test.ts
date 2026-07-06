import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock fetch globally — no real network calls in unit tests.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Intercept resolveCanonicalCtxRoot so token paths go into our temp dir.
let testCtxRoot: string;
vi.mock('../../../src/utils/paths.js', () => ({
  resolveCanonicalCtxRoot: () => testCtxRoot,
  resolvePaths: (agentName: string) => ({
    stateDir: join(testCtxRoot, 'state', agentName),
  }),
}));

// Intercept parseEnvFile so we can inject credentials without touching disk.
const mockEnvVars: Record<string, string> = {};
vi.mock('../../../src/utils/env.js', () => ({
  parseEnvFile: () => mockEnvVars,
  resolveEnv: () => ({
    agentName: 'test-agent',
    org: 'test-org',
    frameworkRoot: '/fake/root',
    ctxRoot: testCtxRoot,
    instanceId: 'default',
    projectRoot: '/fake/root',
    agentDir: '/fake/root/orgs/test-org/agents/test-agent',
    timezone: '',
    orchestrator: '',
    agentWorktree: '',
  }),
}));

// Import after mocks are registered.
import { loadGmailCreds, loadToken, saveToken } from '../../../src/gmail/auth';
import { gmailSend, gmailAuth, gmailTokenStatus } from '../../../src/bus/gmail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expiry_time: number;
  email: string;
}> = {}) {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expiry_time: Date.now() + 3600_000, // valid for 1h
    email: 'nancy@example.com',
    ...overrides,
  };
}

function mockJsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

describe('loadGmailCreds', () => {
  beforeEach(() => {
    Object.keys(mockEnvVars).forEach(k => delete mockEnvVars[k]);
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
  });

  it('reads credentials from the injected env file', () => {
    mockEnvVars.GMAIL_CLIENT_ID = 'id-from-file';
    mockEnvVars.GMAIL_CLIENT_SECRET = 'secret-from-file';
    const creds = loadGmailCreds('/fake/root', 'test-org');
    expect(creds.clientId).toBe('id-from-file');
    expect(creds.clientSecret).toBe('secret-from-file');
  });

  it('prefers process.env over the file', () => {
    process.env.GMAIL_CLIENT_ID = 'id-from-env';
    process.env.GMAIL_CLIENT_SECRET = 'secret-from-env';
    mockEnvVars.GMAIL_CLIENT_ID = 'id-from-file';
    mockEnvVars.GMAIL_CLIENT_SECRET = 'secret-from-file';
    const creds = loadGmailCreds('/fake/root', 'test-org');
    expect(creds.clientId).toBe('id-from-env');
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
  });

  it('throws when GMAIL_CLIENT_ID is missing', () => {
    mockEnvVars.GMAIL_CLIENT_SECRET = 'secret';
    expect(() => loadGmailCreds('/fake/root', 'test-org')).toThrow('GMAIL_CLIENT_ID');
  });

  it('throws when GMAIL_CLIENT_SECRET is missing', () => {
    mockEnvVars.GMAIL_CLIENT_ID = 'id';
    expect(() => loadGmailCreds('/fake/root', 'test-org')).toThrow('GMAIL_CLIENT_SECRET');
  });
});

// ---------------------------------------------------------------------------
// Token file (saveToken / loadToken)
// ---------------------------------------------------------------------------

describe('token file', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-gmail-test-'));
    testCtxRoot = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('loadToken returns null when no file exists', () => {
    expect(loadToken('no-agent')).toBeNull();
  });

  it('saveToken writes then loadToken reads back the same data', () => {
    const token = makeToken();
    saveToken('my-agent', token);
    const loaded = loadToken('my-agent');
    expect(loaded).toEqual(token);
  });

  it('saveToken creates the state directory if it does not exist', () => {
    const statePath = join(testDir, 'state', 'new-agent');
    expect(existsSync(statePath)).toBe(false);
    saveToken('new-agent', makeToken());
    expect(existsSync(join(statePath, 'gmail-token.json'))).toBe(true);
  });

  it('loadToken returns null when file is corrupt JSON', () => {
    const dir = join(testDir, 'state', 'bad-agent');
    mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(join(dir, 'gmail-token.json'), 'not-json', 'utf-8');
    expect(loadToken('bad-agent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gmailTokenStatus
// ---------------------------------------------------------------------------

describe('gmailTokenStatus', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-gmail-status-'));
    testCtxRoot = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns stored:false when no token file', () => {
    const s = gmailTokenStatus('no-agent');
    expect(s.stored).toBe(false);
  });

  it('reports not expired for a fresh token', () => {
    saveToken('agent1', makeToken({ expiry_time: Date.now() + 3600_000 }));
    const s = gmailTokenStatus('agent1');
    expect(s.stored).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.email).toBe('nancy@example.com');
  });

  it('reports expired when token is past expiry minus buffer', () => {
    saveToken('agent2', makeToken({ expiry_time: Date.now() - 1 }));
    const s = gmailTokenStatus('agent2');
    expect(s.expired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gmailSend — happy path and error paths
// ---------------------------------------------------------------------------

describe('gmailSend', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'ctx-gmail-send-'));
    testCtxRoot = testDir;
    mockFetch.mockReset();
    mockEnvVars.GMAIL_CLIENT_ID = 'client-id';
    mockEnvVars.GMAIL_CLIENT_SECRET = 'client-secret';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sends email successfully and returns messageId/threadId', async () => {
    saveToken('sender-agent', makeToken());
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ id: 'msg-123', threadId: 'thr-456', labelIds: ['SENT'] }),
    );

    const result = await gmailSend('/fake/root', 'test-org', 'sender-agent', {
      to: 'vendor@example.com',
      subject: 'Test email',
      body: 'Hello from the agent.',
    });

    expect(result.messageId).toBe('msg-123');
    expect(result.threadId).toBe('thr-456');

    // Verify the Authorization header was set
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-access-token');
  });

  it('throws a descriptive error on non-2xx response', async () => {
    saveToken('sender-agent', makeToken());
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Insufficient Permission' } }),
      text: async () => '{"error":{"message":"Insufficient Permission"}}',
    } as unknown as Response);

    await expect(
      gmailSend('/fake/root', 'test-org', 'sender-agent', {
        to: 'x@y.com',
        subject: 'Sub',
        body: 'Body',
      }),
    ).rejects.toThrow(/Gmail send failed.*403.*Insufficient Permission/);
  });

  it('auto-refreshes an expired token before sending', async () => {
    const expired = makeToken({ expiry_time: Date.now() - 1000 });
    saveToken('refresh-agent', expired);

    // First fetch: refresh
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ access_token: 'new-token', expires_in: 3600 }),
    );
    // Second fetch: send
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ id: 'msg-refreshed', threadId: 'thr-refreshed', labelIds: ['SENT'] }),
    );

    const result = await gmailSend('/fake/root', 'test-org', 'refresh-agent', {
      to: 'x@y.com',
      subject: 'After refresh',
      body: 'Body',
    });

    expect(result.messageId).toBe('msg-refreshed');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Confirm the new token was persisted
    const saved = loadToken('refresh-agent');
    expect(saved?.access_token).toBe('new-token');
  });

  it('throws when no token is stored for the agent', async () => {
    await expect(
      gmailSend('/fake/root', 'test-org', 'no-token-agent', {
        to: 'x@y.com',
        subject: 'Sub',
        body: 'Body',
      }),
    ).rejects.toThrow(/No Gmail token found for agent "no-token-agent"/);
  });

  it('includes raw base64url body in the request payload', async () => {
    saveToken('raw-agent', makeToken());
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ id: 'm', threadId: 't', labelIds: [] }),
    );

    await gmailSend('/fake/root', 'test-org', 'raw-agent', {
      to: 'to@example.com',
      subject: 'Subject',
      body: 'Hello',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const bodyParsed = JSON.parse(init.body as string) as { raw: string };
    // Base64url must not contain +, /, or = padding
    expect(bodyParsed.raw).toMatch(/^[A-Za-z0-9\-_]+$/);
    // Decode and verify content
    const decoded = Buffer.from(bodyParsed.raw, 'base64url').toString('utf-8');
    expect(decoded).toContain('To: to@example.com');
    expect(decoded).toContain('Subject: Subject');
    expect(decoded).toContain('Hello');
  });
});
