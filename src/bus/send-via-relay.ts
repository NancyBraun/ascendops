// Thin shim around the relay agent's POST /outbound endpoint. Agents call this
// to send a reply through the gateway path: text-only SMS or MMS-with-photo.
//
// Architecture: the relay (local Fastify on the Mac, exposed to Railway via
// cloudflared tunnel) maintains the msgId→fromPhone map. Agents use the
// bus message_id they received as the `to` field, the relay resolves it to
// the original sender's phone and fires Telnyx outbound. For unsolicited
// outbound (no prior inbound), pass a phone in E.164 form directly.
//
// Auth: RELAY_INTERNAL_TOKEN env var must match what the relay agent has set.
// The token is required on every outbound — the relay agent /outbound fails
// closed when the env is unset or the X-Relay-Token header doesn't match.

import { redactSSN } from '../utils/ssn-redaction.js';

export interface SendViaRelayInput {
  /** Either a bus message_id (relay resolves to the original sender phone) or an E.164 phone (with leading +) */
  to: string;
  text: string;
  /** Optional pre-signed photo URL — forwarded to Telnyx as MMS media */
  photoUrl?: string;
}

export interface SendViaRelayResult {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * POST {to, text, photo_url?} to ${RELAY_URL}/outbound with the
 * X-Relay-Token header. Returns the relay's response shape. Does NOT
 * wait for Telnyx ack — the relay is fire-and-forget on its own side
 * (202 queued response with the resolved target phone).
 */
export async function sendViaRelay(input: SendViaRelayInput): Promise<SendViaRelayResult> {
  const relayUrl = process.env.RELAY_URL;
  const token = process.env.RELAY_INTERNAL_TOKEN;
  if (!relayUrl) {
    return { ok: false, error: 'RELAY_URL env var not set' };
  }
  if (!token) {
    return { ok: false, error: 'RELAY_INTERNAL_TOKEN env var not set' };
  }
  if (!input.to || !input.text) {
    return { ok: false, error: 'missing to or text' };
  }

  // Scrub at the egress primitive: never SHARE an SSN over the relay (SMS/MMS).
  const body: Record<string, unknown> = { to: input.to, text: redactSSN(input.text) };
  if (input.photoUrl) body.photo_url = input.photoUrl;

  try {
    const res = await fetch(`${relayUrl}/outbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    let parsed: unknown = undefined;
    try { parsed = await res.json(); } catch { /* non-JSON body is ok */ }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
