import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
const pullRequestTemplate = readFileSync(
  join(root, '.github/PULL_REQUEST_TEMPLATE.md'),
  'utf8',
);

describe('member contribution intake contract', () => {
  it('branches new work from the fetched public upstream main', () => {
    expect(contributing).toContain(
      'git checkout -b feat/skill-<your-skill-name> upstream/main',
    );
    expect(contributing).not.toMatch(
      /^git checkout -b feat\/skill-<your-skill-name>$/m,
    );
  });

  it('allows disclosed public integrations for every contribution type', () => {
    expect(contributing).toContain(
      'Array of strings listing every external API, service, or URL the skill contacts.',
    );
    const supportedTypesSection = contributing
      .split('## What Can Be Contributed')[1]
      ?.split('\n---\n')[0];
    const supportedTypes = Array.from(
      supportedTypesSection?.matchAll(/^\| `([^`]+)` \|/gm) ?? [],
      (match) => match[1],
    );
    const templateTypes = pullRequestTemplate
      .match(/^\*\*Type:\*\* <!-- ([^>]+) -->$/m)?.[1]
      .split('|')
      .map((type) => type.trim());

    expect(supportedTypes).not.toHaveLength(0);
    expect(templateTypes).toEqual(supportedTypes);
    expect(pullRequestTemplate).toContain(
      '**External services, APIs, scopes, environment variables, and permissions:**',
    );

    for (const document of [contributing, pullRequestTemplate]) {
      const exception = document
        .split('\n')
        .find((line) => /public integration domains/i.test(line));

      expect(exception).toMatch(
        /disclosed in the contribution's required integration declarations/i,
      );
      expect(exception).not.toContain('external_calls');
      expect(document).toMatch(/private or organization-specific names, domains/);
      expect(document).not.toMatch(/No organization names, domains/);
    }
  });
});
