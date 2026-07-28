# Contributing to AscendOps

Thank you for contributing to AscendOps. This guide covers framework fixes and features, documentation, skills, and agent or organization templates.

## Public Repository Boundary

Contributions go only to the public `noogalabs/ascendops` repository. A public contribution never updates a maintainer's private or production deployment. Maintainers may later reimplement or port an accepted idea into their own systems through a separate review.

Do not include private deployment files, live organization state, customer data, personal-assistant data, credentials, production configuration, or references to a maintainer's private repository.

## How Contributions Are Evaluated

Reviews answer two questions in order. They are not the same gate.

### Gate 1: Is it safe and correct?

Maintainers do not begin substantive product review until these required automated checks are green:

- **Leak Guard** scans newly added lines in the complete pull-request diff for its configured secret, PII, operator-path, and private-runtime patterns. Its committed adversarial tests prove representative secret and PII findings fail the check.
- **Scope Reconcile** proves that GitHub's complete, paginated pull-request file list exactly matches Git's authoritative `base...head` file list. Its committed test proves an omitted file fails the check.
- **Build & Type Check** runs skill-mirror drift, the TypeScript type check, the CLI build, and a CLI startup check.
- **Unit Tests** runs the repository test suites and the cross-language PII parity checks configured in CI.
- **Dashboard Build** type-checks and builds the dashboard.

Those checks are bounded. Leak Guard detects configured patterns; it does not prove that every form of contextual personal data is absent. Scope Reconcile proves that the file list is complete; it does not prove that every changed file is necessary. After automation passes, maintainers review broader human-data context, compare the contributor's declared manifest with the actual files, assess whether the tests cover the changed behavior, and reject unrelated or unnecessary scope.

The pull request must contain only the files needed for the stated contribution. A clean latest commit is not enough: maintainers review the complete change from the current public base to the proposed head. Unrelated inherited commits, stale-fork catch-up changes, generated private state, or files omitted from the declared manifest block maintainer review.

Before opening a pull request, sync your fork and inspect the same full scope:

```bash
git fetch upstream main
git diff --name-status upstream/main...HEAD
git diff --stat upstream/main...HEAD
git diff --check upstream/main...HEAD
```

If that file list contains unrelated work, rebase or create a clean branch before submitting. Do not ask maintainers to review only the latest commit.

### Gate 2: Do we want to own it?

A mechanically green contribution has three possible outcomes:

- **ACCEPT**: generalizable code that the project would likely build anyway and can reasonably own long term.
- **REPORT-ONLY**: the finding is useful, but the submitted implementation is organization-shaped, overlaps current work, or is too costly to inherit. Maintainers record the finding, close the pull request, and may implement it independently.
- **DECLINE**: organization-specific, duplicate, out of scope, or not useful to the broader project.

The pull request template requires substantive answers to four questions:

1. Would this problem affect any AscendOps member, or only your organization?
2. Would the public project likely need to build this within the next 90 days?
3. What existing or in-flight feature does this overlap or collide with?
4. What ongoing maintenance, security, support, migration, or compatibility cost would the project own?

A contribution can pass every automated check and still be report-only or declined. That is not a judgment on the quality of the finding.

## Human Data Is a Hard Gate

Leak review protects people's lives, not only credentials. Personal data in an agent or persona is a release blocker by maintainer policy even when no API key is present.

Enforcement has two layers. Leak Guard mechanically blocks its configured patterns, including email addresses, street addresses, names assigned to contact fields, supported US phone formats outside the reserved fixture range, known private identities, operator paths, and tracked private-runtime paths. Maintainers separately inspect the required persona privacy inventory for contextual data that pattern matching cannot reliably identify, such as calendar events, inbox content, family relationships, financial context, and organization-specific workflows. A green Leak Guard check is not proof that a persona is safe to publish.

Before submitting, remove or replace all real-person and organization-specific data, including:

- Names, personal or work email addresses, phone numbers, home or property addresses
- Calendar events, attendees, meeting notes, inbox subjects or snippets, contacts, family details
- Financial, banking, lending, owner, resident, applicant, vendor, or customer data
- Organization names, domains, internal paths, agent rosters, chat IDs, label IDs, account IDs, tenant IDs, and production URLs
- Private memories, transcripts, operational incidents, generated reports, runtime state, and local absolute paths
- Service-account subjects, delegated mailbox identities, credential filenames, and environment defaults tied to a real person or organization

Agent templates must contain placeholders and synthetic fixtures only. A personal-assistant template must be scrubbed as if its source agent had access to a real person's entire inbox, calendar, family, contacts, and finances. If you cannot prove the template is clean, do not open the pull request.

Synthetic US phone fixtures must use the NANP-reserved `555-0100` through `555-0199` range. Maintainers presume any other submitted phone number is real until proven otherwise. Leak Guard mechanically enforces the range for its supported 10- and 11-digit US formats, with committed tests for both allowed endpoints and an out-of-range failure.

In the pull request, declare what organization-specific material existed before scrubbing, which files were derived from it, and how each data class was replaced. "No secrets" is not a sufficient privacy declaration.

## Review Cadence

Member contributions are reviewed in a weekly batch, not continuously. Please keep one coherent contribution per pull request and do not repeatedly ping maintainers between review cycles.

### Brand string convention (fork-only)

The AscendOps fork swaps first-impression user-facing brand strings (CLI welcome banner, install/uninstall descriptions, doctor header, init/dashboard descriptions) to say "AscendOps" instead of "cortextOS". Daemon-level strings (`start.ts`), CLI binary invocation strings (`cortextos <command>`), and runtime infrastructure paths (`~/.cortextos/`) keep cortextOS branding — that's the framework underneath AscendOps. When syncing upstream changes from grandamenium/cortextos, expect occasional merge conflicts on the rebranded lines; re-apply the AscendOps brand and move on.

## What Can Be Contributed

| Type | Description |
|------|-------------|
| `bug fix` | A general framework defect with a focused regression test |
| `feature` | A reusable framework capability with documented ownership and migration impact |
| `documentation` | Public guidance that is accurate for a clean member installation |
| `skill` | A reusable capability for any agent (`.claude/skills/<name>/SKILL.md`) |
| `agent` | A full agent template with identity, config, and skills |
| `org` | An org-level template for a specific use case or industry |

---

## Skill Structure

Every skill lives in its own directory and must include a `SKILL.md` file. Supporting files may be included when the skill needs them; they must appear in the declared pull-request scope and pass the same review.

```
community/skills/<skill-name>/
└── SKILL.md
```

### SKILL.md Format

```markdown
---
name: <skill-name>
description: "<one sentence — used by the agent to decide when to load this skill>"
triggers: ["keyword", "another phrase", "what user might say to invoke this"]
external_calls: []  # List any external APIs, services, or URLs this skill contacts. Empty array = none.
---

# Skill Title

Short description of what this skill does.

## When to Use

...

## Workflow

### Step 1: ...

```bash
# example commands
```

### Step 2: ...

## Notes / Edge Cases

...
```

### Required Fields

Maintainers review these submission requirements. They are not all independently enforced by the required CI checks.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase, hyphenated. Must match directory name. |
| `description` | Yes | One sentence. This is what the agent sees when deciding whether to load the skill. Make it precise. |
| `triggers` | Yes | Array of strings. Natural-language phrases that should cause the skill to activate. Include synonyms. |
| `external_calls` | Yes | Array of strings listing every external API, service, or URL the skill contacts. Use `[]` if the skill makes no external calls. Examples: `["api.github.com", "openweathermap.org"]`. This field is used by the community reviewer to assess the skill's network footprint — omitting it is grounds to reject the PR. |

### SKILL.md Guidelines

- Write for the agent, not a human developer. The agent reads this at runtime.
- Use concrete bash commands with real `cortextos bus` CLI usage, not pseudocode.
- Keep each step actionable. Avoid vague instructions like "handle errors appropriately."
- Do not include secrets, API keys, hardcoded usernames, or personal data.
- Do not use `rm -rf`, `curl | sh`, or other destructive/untrusted patterns.

---

## Agent Template Structure

```
community/agents/<agent-name>/
├── IDENTITY.md      # Required: Name, Role, Personality
├── SOUL.md          # Required: Values, decision-making principles
├── GUARDRAILS.md    # Required: What the agent must never do
├── GOALS.md         # Recommended: Default goals
├── HEARTBEAT.md     # Recommended: Heartbeat loop instructions
├── TOOLS.md         # Recommended: Available commands reference
├── config.json      # Required: model, crons, startup config
└── .claude/
    └── skills/      # Any skills bundled with this agent
```

---

## Review Checklist

Before opening a PR, verify the following. These are contributor attestations reviewed by maintainers; only the checks listed under Gate 1 are mechanically enforced by required CI.

- [ ] Directory name matches `name` in frontmatter
- [ ] `description` is one sentence and specific (not "a useful skill")
- [ ] `triggers` array has at least 3 phrases
- [ ] `external_calls` field is present — `[]` if the skill makes no external network calls
- [ ] Every `curl`, `fetch`, or HTTP call in the skill body is listed in `external_calls`
- [ ] All bash commands use `cortextos bus` CLI (not direct file manipulation)
- [ ] No hardcoded file paths that only work on one machine
- [ ] No secrets, tokens, API keys, or personal data
- [ ] No real-person inbox, calendar, contact, family, financial, resident, owner, applicant, vendor, or customer data
- [ ] Every synthetic US phone fixture uses the reserved `555-0100` through `555-0199` range
- [ ] No private or organization-specific names, domains, paths, account identifiers, production URLs, runtime state, or incident history; public integration domains disclosed in the contribution's required integration declarations are permitted
- [ ] Full `upstream/main...HEAD` file list matches the intended-file manifest in the pull request
- [ ] No unrelated inherited commits or stale-fork catch-up changes are present
- [ ] No `rm -rf`, `curl | sh`, or shell injection patterns
- [ ] Skill tested on at least one real agent
- [ ] For agent templates: all required files present (IDENTITY.md, SOUL.md, GUARDRAILS.md, config.json)

---

## How to Submit

### 1. Fork and clone

```bash
git clone https://github.com/<your-github-username>/ascendops.git
cd ascendops
git remote add upstream https://github.com/noogalabs/ascendops.git
git fetch upstream main
git checkout -b feat/skill-<your-skill-name> upstream/main
```

### 2. Add your files

Place your skill or template in the correct community directory:

```bash
# For a skill:
mkdir -p community/skills/<skill-name>
# Add SKILL.md

# For an agent template:
mkdir -p community/agents/<agent-name>
# Add all required files
```

### 3. Register in the catalog

Add an entry to `community/catalog.json`:

```json
{
  "name": "<skill-name>",
  "type": "skill",
  "version": "1.0.0",
  "description": "One-line description shown in the catalog UI",
  "author": "your-github-username",
  "tags": ["tag1", "tag2"],
  "review_status": "pending",
  "install_path": "community/skills/<skill-name>"
}
```

Set `review_status` to `"pending"` — the maintainers will update it after review.

### 4. Open a pull request

```bash
git add community/
git commit -m "feat: add <skill-name> skill to community catalog"
git push origin feat/skill-<your-skill-name>
```

Open a PR against `main`. Use the title format:

```
feat: add <skill-name> [skill|agent|org] to community catalog
```

In the PR description, include:
- What the skill does and when it activates
- Which agent(s) you tested it on
- Any dependencies (external APIs, env vars required)
- The exact intended file list from `git diff --name-status upstream/main...HEAD`
- The required four ownership answers
- A complete organization-specific and human-data declaration, including what was scrubbed
- Known overlap with existing public features or open work

---

## After Submission

A maintainer or community reviewer will check your PR against the review checklist. You may be asked to:

- Clarify the `description` or `triggers`
- Remove or replace any flagged bash patterns
- Add missing required files (for agent templates)

After the weekly review, maintainers will record an ACCEPT, REPORT-ONLY, or DECLINE outcome. Accepted catalog items will have `review_status` set to `"approved"`. Report-only pull requests are closed after the useful finding is captured; the submitted code is not merged.

---

## Agent Awareness Standard

Agent bootstrap and tool-reference templates are important feature-discovery surfaces. When a change introduces behavior that agents must know to invoke, maintainers review whether the relevant `CLAUDE.md`, `AGENTS.md`, or tool documentation also needs an update.

This is a maintainer-reviewed standard, not a separate automated gate. **Before merging any feature PR**, verify:

- [ ] **Does this feature add a new bus command, CLI command, or API endpoint?** If yes, add it to `templates/agent/CLAUDE.md` (and `templates/orchestrator/CLAUDE.md`, `templates/analyst/CLAUDE.md`, `templates/security/CLAUDE.md` if applicable) with a usage example.
- [ ] **Does this feature change agent behavior or add a new hook?** If yes, update the relevant template's session-start or workflow section.
- [ ] **Does this feature add or modify a skill?** If yes, ensure the skill's `SKILL.md` has a current `description` and `triggers` list so agents know when to load it.

A feature that depends on agent discovery may be unusable until the relevant template is updated. When applicability is uncertain, flag it for maintainer review.

---

## Questions

Open a GitHub issue or message the AscendOps community channel.
