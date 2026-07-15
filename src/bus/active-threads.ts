import * as childProcess from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { redactSSN } from '../utils/ssn-redaction.js';
import type { BusPaths } from '../types/index.js';

export interface ActiveThread {
  meld_id: string;
  internal_id: string;
  subject: string;
  owner: string;
  status: string;
  last_action: string;
  last_action_at: string;
  next_trigger_at?: string;
  notes: string;
}

export interface ActiveThreadsStateFile {
  version: 1;
  updated_at: string;
  threads: ActiveThread[];
}

export interface AddActiveThreadInput {
  meldId: string;
  subject: string;
  owner: string;
  status: string;
  lastAction: string;
  nextTriggerAt?: string;
  notes?: string;
}

export interface UpdateActiveThreadInput {
  status?: string;
  lastAction?: string;
  nextTriggerAt?: string;
  notes?: string;
}

interface ResolvedMeldIds {
  meldId: string;
  internalId: string;
}

function looksLikeRefId(value: string): boolean {
  return /^[A-Z0-9]{6,12}$/.test(value);
}

function activeThreadsPath(paths: BusPaths): string {
  return join(paths.stateDir, 'active-threads.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): ActiveThreadsStateFile {
  return {
    version: 1,
    updated_at: nowIso(),
    threads: [],
  };
}

function normalizeIso(value: string, field: string): string {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid ${field}: "${value}". Use ISO 8601 format.`);
  }
  return new Date(ts).toISOString();
}

function assertThreadShape(thread: unknown): ActiveThread {
  if (!thread || typeof thread !== 'object') {
    throw new Error('active-threads.json contains a non-object thread entry');
  }
  const row = thread as Record<string, unknown>;
  const required = [
    'meld_id',
    'internal_id',
    'subject',
    'owner',
    'status',
    'last_action',
    'last_action_at',
    'notes',
  ] as const;

  for (const field of required) {
    if (typeof row[field] !== 'string') {
      throw new Error(`active-threads.json thread is missing string field "${field}"`);
    }
  }

  if (row.next_trigger_at !== undefined && typeof row.next_trigger_at !== 'string') {
    throw new Error('active-threads.json thread field "next_trigger_at" must be a string when present');
  }

  return {
    meld_id: row.meld_id as string,
    internal_id: row.internal_id as string,
    subject: row.subject as string,
    owner: row.owner as string,
    status: row.status as string,
    last_action: row.last_action as string,
    last_action_at: normalizeIso(row.last_action_at as string, 'last_action_at'),
    ...(row.next_trigger_at ? { next_trigger_at: normalizeIso(row.next_trigger_at as string, 'next_trigger_at') } : {}),
    notes: row.notes as string,
  };
}

function readState(paths: BusPaths): ActiveThreadsStateFile {
  const filePath = activeThreadsPath(paths);
  if (!existsSync(filePath)) return defaultState();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${filePath} must contain a JSON object`);
  }

  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) {
    throw new Error(`${filePath} has unsupported version "${String(row.version)}"`);
  }
  if (!Array.isArray(row.threads)) {
    throw new Error(`${filePath} is missing a threads array`);
  }

  return {
    version: 1,
    updated_at: typeof row.updated_at === 'string' ? normalizeIso(row.updated_at, 'updated_at') : nowIso(),
    threads: row.threads.map(assertThreadShape),
  };
}

function writeState(paths: BusPaths, state: ActiveThreadsStateFile): void {
  ensureDir(paths.stateDir);
  atomicWriteSync(activeThreadsPath(paths), JSON.stringify(state, null, 2));
}

function mutateState<T>(paths: BusPaths, fn: (state: ActiveThreadsStateFile) => T): T {
  ensureDir(paths.stateDir);
  return withFileLockSync(paths.stateDir, () => {
    const state = readState(paths);
    const result = fn(state);
    state.updated_at = nowIso();
    writeState(paths, state);
    return result;
  });
}

function extractMeldRows(raw: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      return obj.results.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    }
    if (Array.isArray(obj.items)) {
      return obj.items.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
    }
  }
  return [];
}

export function resolveMeldIdsFromListOutput(rawMeldId: string, stdout: string): ResolvedMeldIds | null {
  try {
    const rows = extractMeldRows(stdout);
    for (const row of rows) {
      const ref = row.ref_id ?? row.refId ?? row.reference_id ?? row.referenceId;
      const internal = row.id ?? row.internal_id ?? row.internalId ?? row.meld_id ?? row.meldId;
      if (typeof internal !== 'string' && typeof internal !== 'number') continue;
      const internalId = String(internal);
      const refId = typeof ref === 'string' ? ref : internalId;
      if (rawMeldId === internalId || rawMeldId === refId) {
        return { meldId: refId, internalId };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function resolveFromPmList(rawMeldId: string): ResolvedMeldIds | null {
  // Single-meld lookup: `pm work-orders get <ref_id>` — pm CLI 0.1.0+ resolves
  // ref_id internally and returns one meld. Avoids ENOBUFS from listing 500
  // melds (each ~1.5kb of JSON × 500 blows past execFileSync default 1MB cap).
  let stdout: string;
  try {
    stdout = childProcess.execFileSync(
      'pm',
      ['work-orders', 'get', rawMeldId, '--json'],
      { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
    );
  } catch {
    return null;
  }

  try {
    const meld = JSON.parse(stdout) as Record<string, unknown>;
    const ref = meld.reference_id ?? meld.referenceId ?? meld.ref_id ?? meld.refId;
    const internal = meld.id ?? meld.internal_id ?? meld.internalId ?? meld.meld_id ?? meld.meldId;
    if (typeof internal !== 'string' && typeof internal !== 'number') return null;
    const internalId = String(internal);
    const refId = typeof ref === 'string' && ref.length > 0 ? ref : internalId;
    return { meldId: refId, internalId };
  } catch {
    return null;
  }
}

export function resolveMeldIds(rawMeldId: string): ResolvedMeldIds {
  const trimmed = rawMeldId.trim();
  if (!trimmed) {
    throw new Error('meld_id cannot be empty');
  }

  if (/^\d+$/.test(trimmed)) {
    return { meldId: trimmed, internalId: trimmed };
  }

  if (!looksLikeRefId(trimmed)) {
    throw new Error(
      `Could not resolve PropertyMeld ref_id "${trimmed}" to an internal numeric id. ` +
      'Retry with the numeric meld id or ensure `pm work-orders list --json` is available.',
    );
  }

  const resolved = resolveFromPmList(trimmed);
  if (resolved) return resolved;

  throw new Error(
    `Could not resolve PropertyMeld ref_id "${trimmed}" to an internal numeric id. ` +
    'Retry with the numeric meld id or ensure `pm work-orders list --json` is available.',
  );
}

function findThreadIndex(threads: ActiveThread[], meldId: string): number {
  const direct = threads.findIndex((thread) => thread.meld_id === meldId || thread.internal_id === meldId);
  if (direct >= 0) return direct;

  if (/^\d+$/.test(meldId) || !looksLikeRefId(meldId)) return -1;

  const resolved = resolveFromPmList(meldId);
  if (!resolved) return -1;
  return threads.findIndex((thread) =>
    thread.meld_id === resolved.meldId ||
    thread.internal_id === resolved.internalId ||
    thread.meld_id === resolved.internalId ||
    thread.internal_id === resolved.meldId,
  );
}

export function listActiveThreads(paths: BusPaths): ActiveThreadsStateFile {
  return readState(paths);
}

export function addActiveThread(paths: BusPaths, input: AddActiveThreadInput): ActiveThread {
  const resolved = resolveMeldIds(input.meldId);
  const nextTriggerAt = input.nextTriggerAt ? normalizeIso(input.nextTriggerAt, 'next_trigger_at') : undefined;

  return mutateState(paths, (state) => {
    const idx = findThreadIndex(state.threads, input.meldId);
    const thread: ActiveThread = {
      meld_id: resolved.meldId,
      internal_id: resolved.internalId,
      // Scrub connector-derived free text before it is persisted to
      // active-threads.json — subject / last_action / notes come from PM
      // work-order data and can carry an SSN. (state file = a connector sink
      // because the command accepts connector input.)
      subject: redactSSN(input.subject),
      owner: input.owner,
      status: input.status,
      last_action: redactSSN(input.lastAction),
      last_action_at: nowIso(),
      ...(nextTriggerAt ? { next_trigger_at: nextTriggerAt } : {}),
      notes: redactSSN(input.notes ?? ''),
    };

    if (idx >= 0) state.threads[idx] = thread;
    else state.threads.push(thread);

    return thread;
  });
}

export function updateActiveThread(paths: BusPaths, meldId: string, updates: UpdateActiveThreadInput): ActiveThread {
  const nextTriggerAt = updates.nextTriggerAt ? normalizeIso(updates.nextTriggerAt, 'next_trigger_at') : undefined;

  return mutateState(paths, (state) => {
    const idx = findThreadIndex(state.threads, meldId);
    if (idx === -1) {
      throw new Error(`Active thread ${meldId} not found`);
    }

    const current = state.threads[idx];
    const next: ActiveThread = {
      ...current,
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.lastAction !== undefined ? { last_action: redactSSN(updates.lastAction), last_action_at: nowIso() } : {}),
      ...(updates.notes !== undefined ? { notes: redactSSN(updates.notes) } : {}),
    };

    if (updates.nextTriggerAt !== undefined) {
      if (updates.nextTriggerAt === '') delete next.next_trigger_at;
      else next.next_trigger_at = nextTriggerAt!;
    }

    state.threads[idx] = next;
    return next;
  });
}

export function removeActiveThread(paths: BusPaths, meldId: string): ActiveThread {
  return mutateState(paths, (state) => {
    const idx = findThreadIndex(state.threads, meldId);
    if (idx === -1) {
      throw new Error(`Active thread ${meldId} not found`);
    }
    const [removed] = state.threads.splice(idx, 1);
    return removed;
  });
}

export function clearActiveThreads(paths: BusPaths): number {
  return mutateState(paths, (state) => {
    const removed = state.threads.length;
    state.threads = [];
    return removed;
  });
}
