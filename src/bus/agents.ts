import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentInfo, AgentConfig, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { sendMessage } from './message.js';
import { redactSSN } from '../utils/ssn-redaction.js';

/**
 * List all agents in the system.
 *
 * Merges two sources of truth:
 *   1. The framework directory scan (`${CTX_FRAMEWORK_ROOT}/orgs/<org>/agents/`)
 *      — this is what the daemon discovers and runs.
 *   2. `enabled-agents.json` — explicit user-set enable/disable state from
 *      `cortextos enable`/`disable` and the dashboard.
 *
 * BUG-028: previously this function treated `enabled-agents.json` as
 * authoritative — if the file existed, the directory scan was skipped, causing
 * `cortextos list-agents` to miss agents that the daemon was actually running.
 * Now both sources are always merged, with the file providing the explicit
 * enabled flag and the directory scan providing the canonical existence check.
 */
export function listAgents(ctxRoot: string, org?: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const seen = new Set<string>();

  // 1. Read enabled-agents.json for explicit enable/disable state.
  // This is treated as metadata, not as the list of agents to display.
  const enabledFile = join(ctxRoot, 'config', 'enabled-agents.json');
  let enabledAgents: Record<string, { org?: string; enabled?: boolean }> = {};
  if (existsSync(enabledFile)) {
    try {
      enabledAgents = JSON.parse(readFileSync(enabledFile, 'utf-8'));
    } catch {
      // Skip corrupt file — fall through to directory scan only.
    }
  }

  // 2. ALWAYS scan org agent directories (BUG-028 fix).
  // The directory scan is now the primary source for "what agents exist".
  // The enabled-agents.json entries are merged in as metadata.
  // Honor CORTEXTOS_DIR with the SAME precedence resolveEnv() uses for the
  // framework root (CORTEXTOS_DIR || CTX_FRAMEWORK_ROOT, see utils/env.ts). A
  // CORTEXTOS_DIR-configured install (no CTX_FRAMEWORK_ROOT) must resolve the
  // same agent universe resolveEnv() sees — otherwise the recipient-existence
  // gate (agentExists) would treat a real universe as unresolvable and silently
  // degrade to warn+proceed, or reject valid recipients by scanning the wrong cwd.
  const cliProjectRoot = process.env.CORTEXTOS_DIR || process.env.CTX_FRAMEWORK_ROOT;
  const scanRoots: string[] = [];
  if (cliProjectRoot && existsSync(join(cliProjectRoot, 'orgs'))) {
    scanRoots.push(cliProjectRoot);
  }
  // Fallback: cwd, but ONLY when neither CORTEXTOS_DIR nor CTX_FRAMEWORK_ROOT is
  // set. If a root is configured (even to a path without orgs/), respect it and
  // do not scan cwd — the caller explicitly configured a root that has no agents.
  // This prevents test contamination when cwd happens to be the framework repo.
  if (scanRoots.length === 0 && !cliProjectRoot) {
    const cwd = process.cwd();
    if (existsSync(join(cwd, 'orgs'))) {
      scanRoots.push(cwd);
    }
  }

  for (const root of scanRoots) {
    const orgsDir = join(root, 'orgs');
    if (!existsSync(orgsDir)) continue;

    let orgDirs: string[];
    try {
      orgDirs = readdirSync(orgsDir);
    } catch {
      continue;
    }

    for (const orgName of orgDirs) {
      if (org && orgName !== org) continue;

      const agentsDir = join(orgsDir, orgName, 'agents');
      if (!existsSync(agentsDir)) continue;

      let agentDirs: string[];
      try {
        agentDirs = readdirSync(agentsDir);
      } catch {
        continue;
      }

      for (const agentName of agentDirs) {
        if (!/^[a-z0-9_-]+$/.test(agentName)) continue;
        if (seen.has(agentName)) continue;

        seen.add(agentName);

        // Determine enabled state: explicit from enabled-agents.json if present,
        // otherwise default to enabled (matches the daemon's discoverAndStart
        // default-on behavior).
        const explicitEntry = enabledAgents[agentName];
        const isEnabled = explicitEntry ? explicitEntry.enabled !== false : true;

        agents.push(buildAgentInfo(agentName, orgName, isEnabled, ctxRoot));
      }
    }
  }

  // 3. Append any entries from enabled-agents.json that don't have a corresponding
  // directory on disk (stale registrations — file has them but the dir was deleted
  // or never existed). These are surfaced so users can clean them up.
  for (const [name, cfg] of Object.entries(enabledAgents)) {
    if (!/^[a-z0-9_-]+$/.test(name)) continue;
    if (seen.has(name)) continue;
    const agentOrg = cfg.org || '';
    if (org && agentOrg !== org) continue;
    seen.add(name);
    agents.push(buildAgentInfo(name, agentOrg, cfg.enabled !== false, ctxRoot));
  }

  return agents;
}

/**
 * Result of an agent-existence probe.
 *
 *   - `exists: true`                 → the name resolves to an on-disk / registered agent.
 *   - `exists: false, resolvable:true`→ a non-empty agent list was resolved and the
 *                                       name is NOT in it (genuine "unknown recipient").
 *   - `exists: false, resolvable:false`→ the agent list could not be resolved at all
 *                                       (fresh install, no orgs dir, empty registry).
 *                                       Callers MUST degrade safely here and NOT block
 *                                       a send to a real agent (fleet-brick guard).
 */
export interface AgentExistsResult {
  exists: boolean;
  /** Whether a non-empty agent universe was resolvable for this probe. */
  resolvable: boolean;
  /** Names that WERE resolvable, for an actionable error message. */
  available: string[];
}

/**
 * Check whether an agent EXISTS (on disk / in the registry) — NOT whether it is
 * enabled. A disabled-but-present agent is a valid message/assign target (its
 * inbox queues for re-enable), so existence is the only gate here.
 *
 * Implemented on top of `listAgents()` so it shares the single authoritative
 * existence source (merged enabled-agents.json + orgs/<org>/agents dir scan).
 *
 * Returns a tri-state (see AgentExistsResult): the `resolvable` flag lets CLI
 * callers distinguish "this name is genuinely unknown" (resolvable list, name
 * absent → fail loud) from "I can't see ANY agents from here" (fresh install /
 * no orgs dir → degrade safely, do NOT block). This is the fleet-brick guard:
 * a brand-new install with no resolvable agent universe must still be able to
 * `send-message` to a real agent.
 */
export function agentExists(agentName: string, ctxRoot: string, org?: string): AgentExistsResult {
  let all: AgentInfo[];
  try {
    all = listAgents(ctxRoot, org);
  } catch {
    // listAgents is defensive and shouldn't throw, but if it does we cannot
    // verify — degrade safely rather than block.
    return { exists: false, resolvable: false, available: [] };
  }
  const available = all.map((a) => a.name);
  if (available.length === 0) {
    // No agent universe resolvable from here (fresh install, no orgs dir, empty
    // registry). Cannot verify — caller degrades safely.
    return { exists: false, resolvable: false, available: [] };
  }
  return { exists: available.includes(agentName), resolvable: true, available };
}

/**
 * Build an AgentInfo object by reading heartbeat, IDENTITY.md, and config.
 */
function buildAgentInfo(
  name: string,
  org: string,
  enabled: boolean,
  ctxRoot: string,
): AgentInfo {
  // Read heartbeat from state dir (bash uses state/{agent}/heartbeat.json)
  let lastHeartbeat: string | null = null;
  let currentTask: string | null = null;
  let mode: string | null = null;
  let running = false;

  const stateHeartbeat = join(ctxRoot, 'state', name, 'heartbeat.json');
  if (existsSync(stateHeartbeat)) {
    try {
      const hb = JSON.parse(readFileSync(stateHeartbeat, 'utf-8'));
      lastHeartbeat = hb.last_heartbeat || hb.timestamp || null;
      currentTask = hb.current_task || null;
      mode = hb.mode || null;
      // Running = heartbeat written within last 10 minutes
      if (lastHeartbeat) {
        const age = Date.now() - new Date(lastHeartbeat).getTime();
        running = age < 10 * 60 * 1000;
      }
    } catch {
      // Skip corrupt
    }
  }

  // Get display name and role from IDENTITY.md
  let role = '';
  let displayName: string | undefined;
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (frameworkRoot) {
    const identityPaths = [
      join(frameworkRoot, 'orgs', org, 'agents', name, 'IDENTITY.md'),
      join(frameworkRoot, 'agents', name, 'IDENTITY.md'),
    ];
    for (const idPath of identityPaths) {
      if (existsSync(idPath)) {
        try {
          const content = readFileSync(idPath, 'utf-8');
          const lines = content.split('\n');

          // Parse "## Name" — user-configured display name (e.g. "Alpha", "Beta")
          const nameIdx = lines.findIndex(l => l.trim() === '## Name');
          if (nameIdx >= 0) {
            for (let i = nameIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line || line.startsWith('<!--')) continue;
              if (line.startsWith('##')) break;
              displayName = line;
              break;
            }
          }

          // Find "## Role" then take the first non-empty, non-comment line after it
          const roleIdx = lines.findIndex(l => l.startsWith('## Role'));
          if (roleIdx >= 0) {
            for (let i = roleIdx + 1; i < lines.length; i++) {
              const line = lines[i].trim();
              // Skip empty lines and HTML comment placeholders
              if (!line || line.startsWith('<!--') || line.startsWith('##')) break;
              role = line;
              break;
            }
          }
          // Fallback: first non-comment, non-heading line
          if (!role) {
            for (const line of lines) {
              const t = line.trim();
              if (t && !t.startsWith('#') && !t.startsWith('<!--')) {
                role = t;
                break;
              }
            }
          }
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  // Read config.json for model info
  const configFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.env.CTX_PROJECT_ROOT || '';
  if (configFrameworkRoot) {
    const configPaths = [
      join(configFrameworkRoot, 'orgs', org, 'agents', name, 'config.json'),
      join(configFrameworkRoot, 'agents', name, 'config.json'),
    ];
    for (const cfgPath of configPaths) {
      if (existsSync(cfgPath)) {
        try {
          const cfg: AgentConfig = JSON.parse(readFileSync(cfgPath, 'utf-8'));
          if (cfg.enabled !== undefined) enabled = cfg.enabled;
        } catch {
          // Skip
        }
        break;
      }
    }
  }

  return {
    name,
    org,
    display_name: displayName,
    role,
    enabled,
    running,
    last_heartbeat: lastHeartbeat,
    current_task: currentTask,
    mode,
  };
}

/**
 * Send an urgent notification to an agent.
 * Writes .urgent-signal file and sends a bus message.
 * Mirrors bash notify-agent.sh behavior.
 */
export function notifyAgent(
  paths: BusPaths,
  from: string,
  targetAgent: string,
  message: string,
  ctxRoot: string,
): void {
  // Scrub the SSN once up front: it flows to TWO sinks — the .urgent-signal
  // file written here AND the inbox message via sendMessage below. sendMessage
  // scrubs its own copy, but the signal-file write is a separate sink.
  message = redactSSN(message);

  // Write signal file to state dir
  const signalDir = join(ctxRoot, 'state', targetAgent);
  ensureDir(signalDir);

  const signal = {
    from,
    message,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  atomicWriteSync(join(signalDir, '.urgent-signal'), JSON.stringify(signal));

  // Also send via normal message bus for persistence
  try {
    sendMessage(paths, from, targetAgent, 'urgent', message);
  } catch {
    // Ignore bus send failures - signal file is the primary mechanism
  }
}
