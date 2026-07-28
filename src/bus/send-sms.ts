import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, BusPaths } from '../types/index.js';
import { redactSSN } from '../utils/ssn-redaction.js';

const TELNYX_CREDS = join(homedir(), '.claude', 'credentials', 'telnyx.json');

export interface SendSmsResult {
  ok: boolean;
  mode: 'dry-run' | 'sent';
  approvalId: string | null;
  from: string;
  to: string;
  text: string;
  payload: Record<string, string>;
  response?: unknown;
}

interface TelnyxCreds {
  apiKey: string;
  fromNumber: string;
}

function loadTelnyxCreds(): TelnyxCreds {
  if (!existsSync(TELNYX_CREDS)) {
    throw new Error(`cannot read ${TELNYX_CREDS}`);
  }

  const raw = JSON.parse(readFileSync(TELNYX_CREDS, 'utf-8')) as {
    api_key?: string;
    from_number?: string;
  };
  const apiKey = raw.api_key?.trim();
  if (!apiKey) {
    throw new Error(`.api_key missing in ${TELNYX_CREDS}`);
  }
  const fromNumber = raw.from_number?.trim();
  if (!fromNumber) {
    throw new Error(
      `.from_number missing in ${TELNYX_CREDS} — add your Telnyx-provisioned E.164 number (e.g. "from_number": "+12025550143") to the same file that holds api_key`,
    );
  }
  return { apiKey, fromNumber };
}

function loadApproval(paths: BusPaths, approvalId: string): Approval {
  const candidates = [
    join(paths.approvalDir, 'resolved', `${approvalId}.json`),
    join(paths.approvalDir, 'pending', `${approvalId}.json`),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    return JSON.parse(readFileSync(file, 'utf-8')) as Approval;
  }

  throw new Error(`approval ${approvalId} not found`);
}

export function validateSmsApproval(paths: BusPaths, approvalId: string): Approval {
  const approval = loadApproval(paths, approvalId);
  if (approval.status !== 'approved') {
    throw new Error(`approval ${approvalId} is ${approval.status}, not approved`);
  }
  if (approval.category !== 'external-comms') {
    throw new Error(`approval ${approvalId} category is ${approval.category}, expected external-comms`);
  }
  return approval;
}

export async function sendSms(
  paths: BusPaths,
  to: string,
  text: string,
  opts: { sendReal?: boolean; approvedBy?: string } = {},
): Promise<SendSmsResult> {
  // Scrub at the egress primitive: never SHARE an SSN over SMS, and never
  // surface it in the dry-run preview either. Covers every caller of sendSms.
  text = redactSSN(text);
  const { apiKey, fromNumber } = loadTelnyxCreds();
  const payload = { from: fromNumber, to, text };

  if (!opts.sendReal) {
    return {
      ok: true,
      mode: 'dry-run',
      approvalId: opts.approvedBy ?? null,
      from: fromNumber,
      to,
      text,
      payload,
    };
  }

  if (!opts.approvedBy) {
    throw new Error('live SMS send requires --approved-by <approval_id>');
  }

  validateSmsApproval(paths, opts.approvedBy);

  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text();
  }

  if (!response.ok) {
    throw new Error(`Telnyx returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }

  return {
    ok: true,
    mode: 'sent',
    approvalId: opts.approvedBy,
    from: fromNumber,
    to,
    text,
    payload,
    response: body,
  };
}
