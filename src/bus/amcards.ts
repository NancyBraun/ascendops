/**
 * Bus logic for the read-only AMcards data connector.
 *
 * Loads the AMcards account API key and fetches a list resource by name. Like
 * the AppFolio, Hostaway, and Tenant Turner connectors, the credential comes
 * from process.env when present (agent PTY context), falling back to reading
 * orgs/<org>/secrets.env directly so the same command works from a plain CLI.
 *
 * This path is READ-ONLY: it only calls AmcardsAPI.fetchResource, which only
 * issues HTTP GET. AMcards' send endpoints mail *paid* physical cards and are
 * intentionally NOT reachable from here — sending must go through a separate,
 * human-approval-gated path.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AmcardsAPI, type FetchResourceResult } from '../amcards/api.js';

export interface AmcardsCreds {
  apiKey: string;
}

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[trimmed.slice(0, idx).trim()] = val;
  }
  return vars;
}

/**
 * Resolve the AMcards API key: prefer process.env (agent context), then
 * orgs/<org>/secrets.env (CLI context). Throws an actionable error if missing,
 * and never echoes the secret value.
 */
export function loadAmcardsCreds(frameworkRoot: string, org: string): AmcardsCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key] && process.env[key]!.trim()) || fileVars[key] || '';

  const apiKey = pick('AMCARDS_API_KEY');
  if (!apiKey) {
    throw new Error(
      `AMcards not configured: missing AMCARDS_API_KEY. ` +
        `Add it to orgs/${org}/secrets.env (AMcards → Settings → API).`,
    );
  }
  return { apiKey };
}

export interface FetchAmcardsResourceResult extends FetchResourceResult {
  ok: true;
  rowCount: number;
}

/**
 * Fetch one read-only AMcards resource (e.g. card, template, campaign, user)
 * with optional extra query params. Read-only — see AmcardsAPI for why no send
 * path exists.
 */
export async function fetchAmcardsResource(
  frameworkRoot: string,
  org: string,
  resource: string,
  opts: {
    query?: Record<string, string | number>;
    maxPages?: number;
    maxRows?: number;
  } = {},
): Promise<FetchAmcardsResourceResult> {
  const { apiKey } = loadAmcardsCreds(frameworkRoot, org);
  const client = new AmcardsAPI(apiKey);
  const result = await client.fetchResource(resource, opts);
  return { ok: true, ...result, rowCount: result.rows.length };
}
