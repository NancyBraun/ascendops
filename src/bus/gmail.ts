import { loadGmailCreds, runAuthFlow, loadToken } from '../gmail/auth.js';
import { sendEmail } from '../gmail/send.js';
import type { SendEmailOpts, SendEmailResult } from '../gmail/send.js';
import type { GmailToken } from '../gmail/auth.js';

export type { SendEmailOpts, SendEmailResult };

export interface GmailAuthResult {
  email: string;
  agent: string;
}

/**
 * Send an email via Gmail.
 *
 * Loads credentials from `orgs/<org>/secrets.env`, loads/refreshes the stored
 * OAuth2 token for `agent`, and calls the Gmail API.
 */
export async function gmailSend(
  frameworkRoot: string,
  org: string,
  agent: string,
  opts: SendEmailOpts,
): Promise<SendEmailResult> {
  const creds = loadGmailCreds(frameworkRoot, org);
  return sendEmail(creds, agent, opts);
}

/**
 * Run the one-time OAuth2 authorization flow for Gmail.
 *
 * Starts a loopback HTTP server on localhost:9004, prints a URL for the
 * user to open in a browser, waits for the redirect, exchanges the code,
 * and saves the token to the agent's state directory.
 */
export async function gmailAuth(
  frameworkRoot: string,
  org: string,
  agent: string,
  account?: string,
): Promise<GmailAuthResult> {
  const creds = loadGmailCreds(frameworkRoot, org);
  const token: GmailToken = await runAuthFlow(creds, agent, account);
  return { email: token.email, agent };
}

/**
 * Show the current token status for an agent (for `cortextos bus gmail-status`).
 */
export function gmailTokenStatus(agent: string): {
  stored: boolean;
  email: string;
  expired: boolean;
  expiry_time: number | null;
} {
  const token = loadToken(agent);
  if (!token) {
    return { stored: false, email: '', expired: false, expiry_time: null };
  }
  const expired = Date.now() >= token.expiry_time - 60_000;
  return {
    stored: true,
    email: token.email,
    expired,
    expiry_time: token.expiry_time,
  };
}
