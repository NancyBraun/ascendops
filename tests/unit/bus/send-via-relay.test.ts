import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendViaRelay } from '../../../src/bus/send-via-relay';

describe('sendViaRelay', () => {
  let originalFetch: typeof globalThis.fetch;
  const savedEnv: NodeJS.ProcessEnv = {};

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedEnv.RELAY_URL = process.env.RELAY_URL;
    savedEnv.RELAY_INTERNAL_TOKEN = process.env.RELAY_INTERNAL_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedEnv.RELAY_URL === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = savedEnv.RELAY_URL;
    if (savedEnv.RELAY_INTERNAL_TOKEN === undefined) delete process.env.RELAY_INTERNAL_TOKEN;
    else process.env.RELAY_INTERNAL_TOKEN = savedEnv.RELAY_INTERNAL_TOKEN;
  });

  it('fails fast when RELAY_URL is missing', async () => {
    delete process.env.RELAY_URL;
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    const r = await sendViaRelay({ to: '+12025550143', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('RELAY_URL');
  });

  it('fails fast when RELAY_INTERNAL_TOKEN is missing', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    delete process.env.RELAY_INTERNAL_TOKEN;
    const r = await sendViaRelay({ to: '+12025550143', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('RELAY_INTERNAL_TOKEN');
  });

  it('fails fast when to or text is missing', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    const r1 = await sendViaRelay({ to: '', text: 'x' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('missing to or text');
    const r2 = await sendViaRelay({ to: '+12025550143', text: '' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('missing to or text');
  });

  it('POSTs to RELAY_URL/outbound with token header, text body, no photo when none provided', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'super-secret-token';
    let capturedUrl: string | URL | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = url as any;
      capturedInit = init as any;
      return {
        ok: true,
        status: 202,
        json: async () => ({ queued: true, to: '+12025550143' }),
      } as unknown as Response;
    });
    const r = await sendViaRelay({ to: '+12025550143', text: 'hello world' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(202);
    expect(String(capturedUrl)).toBe('http://localhost:4242/outbound');
    expect((capturedInit?.headers as any)['X-Relay-Token']).toBe('super-secret-token');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.to).toBe('+12025550143');
    expect(body.text).toBe('hello world');
    expect(body.photo_url).toBeUndefined();
  });

  it('scrubs an SSN from the text before sending (egress-primitive scrub)', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init as any;
      return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
    });
    await sendViaRelay({ to: '+12025550143', text: 'your SSN is 123-45-6789, thanks' });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.text).toBe('your SSN is [REDACTED-SSN], thanks');
    expect(body.text).not.toContain('123-45-6789');
  });

  it('includes photo_url in body when provided (MMS path)', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init as any;
      return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
    });
    await sendViaRelay({
      to: '+12025550143',
      text: 'see attached',
      photoUrl: 'https://media.example.com/abc.jpg',
    });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.photo_url).toBe('https://media.example.com/abc.jpg');
  });

  it('accepts a bus message_id as the to field (no E.164 prefix required)', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init as any;
      return { ok: true, status: 202, json: async () => ({}) } as unknown as Response;
    });
    const msgId = '1779660000000-relay-abc';
    await sendViaRelay({ to: msgId, text: 'reply text' });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.to).toBe(msgId);
  });

  it('propagates non-2xx responses as ok=false with the status code', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'wrong-token';
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid or missing X-Relay-Token header' }),
    }) as unknown as Response);
    const r = await sendViaRelay({ to: '+12025550143', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect((r.body as any).error).toContain('X-Relay-Token');
  });

  it('propagates network/timeout errors as ok=false with error string', async () => {
    process.env.RELAY_URL = 'http://localhost:4242';
    process.env.RELAY_INTERNAL_TOKEN = 'tok';
    globalThis.fetch = vi.fn(async () => { throw new Error('timeout'); });
    const r = await sendViaRelay({ to: '+12025550143', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  });
});
