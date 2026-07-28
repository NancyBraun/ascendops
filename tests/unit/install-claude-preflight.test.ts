import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import {
  applyUnattendedConsent,
  readUnattendedConsent,
} from '../../src/utils/claude-preflight.js';

describe('installer Claude unattended-mode consent', () => {
  it.each([false, true])('executes and persists the %s consent decision', (answerYes) => {
    const installDir = mkdtempSync(join(tmpdir(), 'installer-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'installer-home-'));

    expect(applyUnattendedConsent(answerYes, installDir, { homeDir, source: 'interactive-installer' }))
      .toMatchObject({ ok: true, recorded: true });
    expect(readUnattendedConsent(installDir)).toBe(answerYes);

    if (answerYes) {
      expect(JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')))
        .toMatchObject({ skipDangerousModePermissionPrompt: true });
    } else {
      expect(() => readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')).toThrow();
    }
  });
});
