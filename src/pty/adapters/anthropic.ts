import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { resolveModel } from '../../utils/model-tiers.js';
import type { AdapterContext, VendorAdapter } from './base.js';

const BINARY = platform() === 'win32' ? 'claude.cmd' : 'claude';

export const anthropicAdapter: VendorAdapter = {
  name: 'anthropic',
  binary: BINARY,
  pasteEnterCount: 2,
  extractionRetries: 0,

  buildArgs(mode: 'fresh' | 'continue', prompt: string, ctx: AdapterContext): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    // Skip Claude Code's permission system by default (back-compat: agents have
    // historically run unattended). Set `dangerously_skip_permissions: false` in
    // the agent config to KEEP the gate on — then Claude Code's PermissionRequest
    // flow (and the hook-permission-telegram approval) actually engages. Without
    // this flag the CLI override would suppress any settings.json permission mode.
    // Only the literal boolean `false` disables the skip; warn on a non-boolean so
    // a typo (e.g. the string "false") can't silently leave an agent ungated when
    // the operator intended to engage the gate.
    // Only applies to the claude-code runtime (Hermes never passes the flag).
    const skipPermissions = ctx.config.dangerously_skip_permissions;
    if (skipPermissions !== undefined && typeof skipPermissions !== 'boolean') {
      console.warn(
        `[anthropic-adapter] ${ctx.env.agentName}: dangerously_skip_permissions must be true or false ` +
        `(got ${JSON.stringify(skipPermissions)}); defaulting to skip-on.`,
      );
    }
    if (skipPermissions !== false) {
      args.push('--dangerously-skip-permissions');
    }

    const model = resolveModel(ctx.config);
    if (model) {
      args.push('--model', model);
    }

    const agentDir = ctx.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    args.push(prompt);

    return args;
  },

  envFilter(env) {
    return env;
  },
};
