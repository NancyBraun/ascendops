import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('PTY construction census', () => {
  it('keeps every production PTY construction site on the reviewed allowlist', () => {
    const root = resolve('src');
    const sites = sourceFiles(root).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/new\s+(\w*PTY)\s*\(/gi)]
        .map((match) => `${relative(resolve('.'), file)}:${match[1]}`);
    }).sort();

    expect(sites).toEqual([
      'src/daemon/agent-process.ts:AgentPTY',
      'src/daemon/agent-process.ts:CodexAppServerPTY',
      'src/daemon/agent-process.ts:HermesPTY',
      'src/daemon/agent-process.ts:OpencodePTY',
      'src/daemon/worker-process.ts:AgentPTY',
    ]);
  });
});
