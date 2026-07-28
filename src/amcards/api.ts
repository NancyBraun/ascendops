/**
 * Minimal, READ-ONLY AMcards API v1 client using built-in fetch (Node 20+).
 *
 * AMcards is a greeting-card / direct-mail platform. Its send endpoints mail
 * *paid* physical cards, so this connector is read-only BY CONSTRUCTION: it only
 * ever issues HTTP GET against the `/.api/v1/` read resources and exposes no
 * create/send methods. The card-send endpoints (POST /cards/... and
 * /campaigns/...) are deliberately absent — sending must go through a separate,
 * human-approval-gated path, never this client.
 *
 * Auth:   HTTP Bearer — `Authorization: Bearer <apiKey>` (the account API key).
 * Base:   https://amcards.com/.api/v1   <-- note the leading DOT before "api".
 *         Hitting `/api/v1` (no dot) returns the marketing WEBSITE as HTML, which
 *         is the classic "HTML instead of JSON" symptom. We also force JSON with
 *         `?format=json` + an Accept header because the API (Tastypie/Django) can
 *         otherwise return its browsable HTML view.
 * Call:   GET https://amcards.com/.api/v1/{resource}/?format=json
 * Reply:  Tastypie shape — { meta: { total_count, next, limit, offset }, objects: [...] }
 *         (single-object resources like `user` may return the object directly.)
 * Paging: follow `meta.next` (a relative path) until it is null or the cap hits.
 */

const BASE_URL = 'https://amcards.com/.api/v1';
const API_TIMEOUT_MS = 30_000;

/** Safety cap so a large account can't spin forever. Tastypie defaults to ~20
 *  rows/page; 20 pages ≈ 400 rows. Override via opts.maxPages. */
const DEFAULT_MAX_PAGES = 20;

/** Read-only resources exposed by AMcards' /.api/v1/ (GET). Sending is NOT here
 *  by design — see the file header. */
export const AMCARDS_READ_RESOURCES = [
  'user',
  'template',
  'quicksendtemplate',
  'campaign',
  'card',
] as const;

interface TastypieMeta {
  total_count?: number;
  next?: string | null;
  limit?: number;
  offset?: number;
}

export interface AmcardsListResponse {
  meta?: TastypieMeta;
  objects?: unknown[];
}

export interface FetchResourceOptions {
  /** Extra query params merged into the first request (e.g. { limit: 50 }). */
  query?: Record<string, string | number>;
  maxPages?: number;
  maxRows?: number;
}

export interface FetchResourceResult {
  resource: string;
  rows: unknown[];
  /** Server-reported total across all pages (null if the resource omits it). */
  totalCount: number | null;
  pagesFetched: number;
  /** True when a page cap / row cap stopped us before the data ran out. */
  truncated: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AmcardsAPI {
  private readonly authHeader: string;

  /**
   * @param apiKey AMcards account API key (AMcards → Settings → API). Sent as
   *               `Authorization: Bearer <apiKey>`.
   */
  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('AmcardsAPI requires an apiKey');
    }
    this.authHeader = `Bearer ${apiKey}`;
  }

  /**
   * Fetch a read-only AMcards list resource (e.g. "card", "template",
   * "campaign", "user"), following Tastypie's meta.next cursor up to the caps.
   *
   * Only GET is ever issued — there is no send counterpart on this client.
   */
  async fetchResource(resource: string, opts: FetchResourceOptions = {}): Promise<FetchResourceResult> {
    const safe = resource.replace(/^\/+|\/+$/g, '').trim();
    if (!/^[a-z0-9/_-]+$/i.test(safe)) {
      throw new Error(`Invalid AMcards resource "${resource}" (expected like "card" or "template")`);
    }

    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: unknown[] = [];
    let totalCount: number | null = null;
    let pagesFetched = 0;
    let truncated = false;

    // First page: force JSON, plus any extra query params. Trailing slash is
    // required by the API (Django APPEND_SLASH).
    const firstParams = new URLSearchParams({ format: 'json' });
    for (const [k, v] of Object.entries(opts.query ?? {})) firstParams.set(k, String(v));
    let url = `${BASE_URL}/${safe}/?${firstParams}`;

    while (true) {
      const data = await this.requestGet(url, safe);
      pagesFetched += 1;

      if (typeof data.meta?.total_count === 'number') totalCount = data.meta.total_count;

      // List resources return { objects: [...] }. A single-object resource
      // (e.g. user) may return the bare object — treat it as one row.
      const pageRows = Array.isArray(data.objects)
        ? data.objects
        : (data as { objects?: unknown[] }).objects === undefined && Object.keys(data).length
          ? [data]
          : [];

      for (const row of pageRows) {
        rows.push(row);
        if (opts.maxRows != null && rows.length >= opts.maxRows) {
          return { resource: safe, rows, totalCount, pagesFetched, truncated: true };
        }
      }

      // meta.next is a relative path (or null at the last page).
      const next = data.meta?.next;
      if (!next) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }
      url = next.startsWith('http') ? next : `https://amcards.com${next}`;
      await sleep(200); // gentle throttle between pages
    }

    return { resource: safe, rows, totalCount, pagesFetched, truncated };
  }

  /**
   * Shared GET wrapper: bounded timeout, HTTP-status checks, and actionable
   * error mapping. Never puts the API key into the message. Detects the
   * "HTML instead of JSON" case and explains the fix.
   */
  private async requestGet(url: string, resource: string): Promise<AmcardsListResponse & Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore — body already consumed or unreadable */
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `AMcards auth failed (HTTP ${response.status}). Check AMCARDS_API_KEY ` +
            `in secrets.env (AMcards → Settings → API).${detail ? ` — ${detail}` : ''}`,
        );
      }
      if (response.status === 404) {
        throw new Error(
          `AMcards resource "${resource}" not found (HTTP 404). ` +
            `Valid read resources: ${AMCARDS_READ_RESOURCES.join(', ')}.${detail ? ` — ${detail}` : ''}`,
        );
      }
      throw new Error(`AMcards resource "${resource}" failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    // A 200 that is HTML means we hit the website, not the API — almost always a
    // missing leading dot in "/.api/v1" or a missing format=json.
    if (contentType.includes('text/html')) {
      throw new Error(
        `AMcards returned HTML instead of JSON for "${resource}". This means the ` +
          `website was hit, not the API — confirm the base path is "/.api/v1" ` +
          `(with the leading dot) and that "?format=json" is present.`,
      );
    }

    return (await response.json()) as AmcardsListResponse & Record<string, unknown>;
  }
}
