/**
 * Tests for skill-autopr audit-PR helpers — parseOriginSlug, buildAuditPrBody
 */

import { describe, it, expect } from 'vitest';
import { parseOriginSlug, buildAuditPrBody } from '../../../src/bus/skill-autopr.js';

describe('parseOriginSlug', () => {
  it('parses https remote URLs with .git suffix', () => {
    expect(parseOriginSlug('https://github.com/noogalabs/ascendops-live.git')).toBe('noogalabs/ascendops-live');
  });

  it('parses https remote URLs without .git suffix', () => {
    expect(parseOriginSlug('https://github.com/noogalabs/ascendops-live')).toBe('noogalabs/ascendops-live');
  });

  it('parses ssh remote URLs', () => {
    expect(parseOriginSlug('git@github.com:noogalabs/ascendops-live.git')).toBe('noogalabs/ascendops-live');
  });

  it('throws on non-GitHub URLs', () => {
    expect(() => parseOriginSlug('/tmp/some-local-remote')).toThrow(/Cannot parse/);
  });
});

describe('buildAuditPrBody', () => {
  it('lists staged paths and the skill name, omits conflict block when none', () => {
    const body = buildAuditPrBody(
      'heartbeat',
      ['your org internal docs', 'templates/agent/.claude/skills/heartbeat/SKILL.md'],
      [],
    );
    expect(body).toContain('`heartbeat`');
    expect(body).toContain('your org internal docs');
    expect(body).toContain('templates/agent/.claude/skills/heartbeat/SKILL.md');
    expect(body).not.toContain('Cascade Conflicts');
  });

  it('includes conflict block when conflicts are present', () => {
    const body = buildAuditPrBody(
      'approvals',
      ['templates/agent/.claude/skills/approvals/SKILL.md'],
      ['your org internal docs'],
    );
    expect(body).toContain('Cascade Conflicts');
    expect(body).toContain('your org internal docs');
  });
});
