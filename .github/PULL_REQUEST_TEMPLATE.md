<!--
Member contributions are reviewed weekly. Maintainers do not begin product review
until the mechanical gate is green and every required section below is complete.
One coherent contribution per PR. Do not include private or production-repository data.
-->

## Contribution

**Type:** <!-- bug fix | feature | documentation | skill | agent | org -->

**Problem:**
<!-- Describe the observable problem. Separate the finding from your implementation. -->

**Proposed change:**
<!-- Explain the smallest general solution and who benefits. -->

## Intended Scope

**Public base commit:** `<!-- git rev-parse upstream/main -->`

**Head commit:** `<!-- git rev-parse HEAD -->`

Paste the complete output of:

```text
git diff --name-status upstream/main...HEAD
```

<!-- Every file in GitHub's Files changed view must appear above. -->

- [ ] I inspected the complete `upstream/main...HEAD` diff, not only `HEAD~1` or the latest commit.
- [ ] The declared file list matches the pull request's full Files changed list.
- [ ] This branch contains no unrelated inherited commits, fork catch-up bundle, generated runtime state, or private deployment files.
- [ ] Each changed file is necessary for the stated contribution.

## Organization-Specific And Human Data

<!--
These are contributor declarations reviewed by maintainers. Leak Guard blocks
configured patterns, but a green scan does not prove contextual persona data is absent.
-->

**What organization-specific source material did this work start from?**
<!-- Name data classes, not private values. Example: an internal agent, calendar workflow, vendor process, or production incident. Write "none" only after checking. -->

**What did you scrub or replace, and in which files?**
<!-- Explain placeholder/synthetic replacements for every source data class. -->

**Persona privacy inventory:**
<!-- Required for agent/persona contributions. List whether the source had access to inbox, calendar, contacts, family, finances, properties, owners, residents, applicants, vendors, or meeting notes, and how each class was removed. Use "not an agent/persona" when inapplicable. -->

- [ ] No secrets, tokens, keys, passwords, credential contents, or private credential paths are present.
- [ ] No real names, emails, phone numbers, addresses, calendar events, inbox content, contacts, family details, financial data, or customer/resident/owner/vendor/applicant data are present.
- [ ] Every synthetic US phone fixture uses the NANP-reserved `555-0100` through `555-0199` range; any phone-shaped value outside that range has been removed.
- [ ] No private or organization-specific names, domains, internal paths, agent rosters, chat IDs, label IDs, account/tenant IDs, production URLs, memories, transcripts, incident history, or runtime state are present. Public integration domains disclosed in the contribution's required integration declarations are permitted.
- [ ] Agent/persona fixtures are synthetic and cannot be traced back to a real person or organization.

## Do We Want To Own It?

Answer each question with evidence. Yes/no alone is incomplete.

### 1. Who can this bite?
<!-- Would this affect any AscendOps member, or only your organization? Give the triggering conditions. -->

### 2. Why in the next 90 days?
<!-- Why would the public project likely build this soon? What happens if it waits? -->

### 3. What does it collide with?
<!-- Name existing files, features, pull requests, issues, or recently merged work that overlap. "None known" requires explaining what you searched. -->

### 4. What does ownership cost forever?
<!-- Cover maintenance, security, external APIs, migrations, platform/runtime compatibility, support burden, and failure modes. -->

- [ ] I understand the maintainer outcome may be ACCEPT, REPORT-ONLY, or DECLINE.
- [ ] I understand REPORT-ONLY means the finding may be retained while this pull request is closed and independently reimplemented.
- [ ] I understand this contribution targets only public `noogalabs/ascendops`; it does not modify or request access to any private/production repository.

## Mechanical Verification

List exact commands and results. Do not write only "tests pass."

```text
# commands and concise results
```

- [ ] The required Leak Guard check passes its configured secret, PII, operator-path, and private-runtime patterns.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm test` passes.
- [ ] Relevant regression tests were added or updated.
- [ ] `node scripts/skill-drift-check.mjs --tier ci` passes.
- [ ] `git diff --check upstream/main...HEAD` passes.
- [ ] If this adds a command, endpoint, hook, or behavior, the relevant agent templates and usage examples are updated.
- [ ] If this changes agent-installed files, existing-agent migration behavior is covered, not only fresh initialization.

## External Surface And Rollback

**External services, APIs, scopes, environment variables, and permissions:**

**Failure behavior and rollback plan:**

**Security-sensitive or destructive paths touched:**
<!-- Auth, tokens, messaging, deploys, deletes, watchdog/restart logic, financial data, browser sessions, etc. -->
