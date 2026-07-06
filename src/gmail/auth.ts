/**
 * Gmail OAuth2 token management for the cortextOS send-email bus command.
 *
 * Auth model: Authorization Code + refresh token (offline access).
 *   - Credentials (client_id / client_secret) live in orgs/<org>/secrets.env
 *     or process.env — same two-context pattern used by the other connectors.
 *   - Tokens (access_token + refresh_token) are stored per-agent at
 *     ${CTX_ROOT}/state/${agent}/gmail-token.json and auto-refreshed when
 *     within 60 s of expiry.
 *   - The one-time auth flow (`cortextos bus gmail-auth`) starts a temporary
 *     loopback HTTP server on localhost:9004 to receive the OAuth callback,
 *     so no copy-paste of codes is required.
 *
 * Scopes: gmail.send only — read-only and admin scopes are never requested.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { resolveCanonicalCtxRoot } from '../utils/paths.js';
import { parseEnvFile } from '../utils/env.js';

const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const AUTH_CALLBACK_PORT = 9004;
const AUTH_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 15_000;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export interface GmailToken {
  access_token: string;
  refresh_token: string;
  expiry_time: number; // ms since epoch
  email: string;
}

export interface GmailCreds {
  clientId: string;
  clientSecret: string;
}

// ---------------------------------------------------------------------------
// Env / secrets loading
// ---------------------------------------------------------------------------

export function loadGmailCreds(frameworkRoot: string, org: string): GmailCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key]?.trim()) || fileVars[key] || '';

  const clientId = pick('GMAIL_CLIENT_ID');
  const clientSecret = pick('GMAIL_CLIENT_SECRET');

  const missing: string[] = [];
  if (!clientId) missing.push('GMAIL_CLIENT_ID');
  if (!clientSecret) missing.push('GMAIL_CLIENT_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `Gmail not configured: missing ${missing.join(', ')} in orgs/${org}/secrets.env. ` +
        `Run \`cortextos bus gmail-setup\` for setup instructions.`,
    );
  }
  return { clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

function tokenPath(agent: string): string {
  const ctxRoot = resolveCanonicalCtxRoot();
  return join(ctxRoot, 'state', agent, 'gmail-token.json');
}

export function loadToken(agent: string): GmailToken | null {
  const p = tokenPath(agent);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as GmailToken;
  } catch {
    return null;
  }
}

export function saveToken(agent: string, token: GmailToken): void {
  const p = tokenPath(agent);
  mkdirSync(join(p, '..'), { recursive: true });
  // 0600 equivalent: write then restrict (chmod not available on Windows, best-effort)
  writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshToken(creds: GmailCreds, refreshToken: string): Promise<{ access_token: string; expiry_time: number }> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Gmail token refresh failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}. ` +
        `Re-run \`cortextos bus gmail-auth\` to re-authorize.`,
    );
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Gmail token refresh: no access_token in response');

  return {
    access_token: data.access_token,
    expiry_time: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Return a valid access token for the agent, refreshing if needed.
 * Throws if no token is stored (user must run gmail-auth first).
 */
export async function getValidAccessToken(creds: GmailCreds, agent: string): Promise<string> {
  const token = loadToken(agent);
  if (!token) {
    throw new Error(
      `No Gmail token found for agent "${agent}". ` +
        `Run \`cortextos bus gmail-auth --agent ${agent}\` to authorize.`,
    );
  }

  if (Date.now() < token.expiry_time - TOKEN_EXPIRY_BUFFER_MS) {
    return token.access_token;
  }

  // Refresh
  const refreshed = await refreshToken(creds, token.refresh_token);
  const updated: GmailToken = { ...token, ...refreshed };
  saveToken(agent, updated);
  return updated.access_token;
}

// ---------------------------------------------------------------------------
// One-time OAuth2 authorization flow
// ---------------------------------------------------------------------------

function buildAuthUrl(creds: GmailCreds, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force refresh_token on every auth
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(
  creds: GmailCreds,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expiry_time: number }> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gmail code exchange failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || !data.refresh_token) {
    throw new Error('Gmail code exchange: missing access_token or refresh_token in response');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_time: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Run the full OAuth2 authorization flow:
 *  1. Start a loopback HTTP server on localhost:AUTH_CALLBACK_PORT
 *  2. Print the auth URL for the user to open in a browser
 *  3. Wait for the redirect (with timeout)
 *  4. Exchange the code for tokens
 *  5. Fetch the authorized email via tokeninfo
 *  6. Save the token
 */
export async function runAuthFlow(
  creds: GmailCreds,
  agent: string,
  account?: string,
): Promise<GmailToken> {
  const redirectUri = `http://localhost:${AUTH_CALLBACK_PORT}`;

  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      server.close();
      clearTimeout(timer);
      fn();
    };

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${AUTH_CALLBACK_PORT}`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(`Authorization denied: ${error}. You can close this tab.`);
          settle(() => reject(new Error(`OAuth denied: ${error}`)));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No authorization code received. Please try again.');
          settle(() => reject(new Error('No authorization code in callback')));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Authorization successful! You can close this tab and return to the terminal.');

        settle(() => {
          exchangeCode(creds, code, redirectUri)
            .then(async (tokens) => {
              // Determine the email address this token is for
              let email = account ?? '';
              if (!email) {
                try {
                  const infoRes = await fetch(
                    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(tokens.access_token)}`,
                    { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
                  );
                  if (infoRes.ok) {
                    const info = (await infoRes.json()) as { email?: string };
                    email = info.email ?? '';
                  }
                } catch {
                  // non-fatal — email is informational only
                }
              }

              const gmailToken: GmailToken = { ...tokens, email };
              saveToken(agent, gmailToken);
              resolve(gmailToken);
            })
            .catch(reject);
        });
      } catch (err) {
        settle(() => reject(err));
      }
    });

    server.on('error', (err) => settle(() => reject(err)));

    server.listen(AUTH_CALLBACK_PORT, 'localhost', () => {
      const authUrl = buildAuthUrl(creds, redirectUri);
      console.log('\nOpen this URL in your browser to authorize Gmail access:\n');
      console.log(authUrl);
      console.log(`\nWaiting for authorization (timeout: ${AUTH_TIMEOUT_MS / 1000}s)...\n`);
    });

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Gmail auth timed out after ${AUTH_TIMEOUT_MS / 1000}s`)));
    }, AUTH_TIMEOUT_MS);
  });
}
