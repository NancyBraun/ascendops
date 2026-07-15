import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const expectedHookOutputs = [
  'dist/hooks/hook-session-restore.js',
  'dist/hooks/hook-skill-autopr.js',
];

describe('build outputs', () => {
  it('emits required hook bundles from tsup entries', { timeout: 60_000 }, () => {
    execFileSync('npx', ['tsup', '--silent'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    for (const outputPath of expectedHookOutputs) {
      expect(existsSync(join(process.cwd(), outputPath)), outputPath).toBe(true);
    }
  });
});
