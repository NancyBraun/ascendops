import type { GmailCreds } from './auth.js';
import { getValidAccessToken } from './auth.js';

const API_TIMEOUT_MS = 15_000;
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export interface SendEmailOpts {
  to: string;
  subject: string;
  body: string;
  /** Optional CC recipients (comma-separated). */
  cc?: string;
  /** Display name and address for the From header, e.g. "Nancy Braun <nancy@example.com>" */
  from?: string;
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
  labelIds: string[];
}

/**
 * Encode a string to base64url (URL-safe base64, no padding).
 * Used for the Gmail API `raw` field (RFC 4648 §5).
 */
function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a minimal RFC 2822 email message string.
 */
function buildRfc2822(opts: SendEmailOpts & { from: string }): string {
  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    opts.body,
  ];
  return lines.join('\r\n');
}

/**
 * Send an email via the Gmail API using an OAuth2 access token.
 *
 * @param creds   Gmail OAuth2 credentials (for token refresh).
 * @param agent   Agent name — used to locate the token file.
 * @param opts    Email fields.
 */
export async function sendEmail(
  creds: GmailCreds,
  agent: string,
  opts: SendEmailOpts,
): Promise<SendEmailResult> {
  const token = await getValidAccessToken(creds, agent);

  // Determine the sender address. If `from` is not provided, we let Gmail
  // use the account's default identity (the `from` header is then omitted and
  // Gmail fills it in). We still need a From line for the RFC 2822 message
  // because omitting it produces an unparseable raw message.
  // Fallback: use 'me' — Gmail replaces it with the real address at send time.
  const fromHeader = opts.from ?? 'me';
  const rawMessage = buildRfc2822({ ...opts, from: fromHeader });

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(rawMessage) }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      detail = errBody.error?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(
      `Gmail send failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const data = (await res.json()) as {
    id?: string;
    threadId?: string;
    labelIds?: string[];
  };

  return {
    messageId: data.id ?? '',
    threadId: data.threadId ?? '',
    labelIds: data.labelIds ?? [],
  };
}
