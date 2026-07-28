---
name: gmail
effort: low
description: "Read and draft emails via you@example.com Gmail. Use for checking PM notifications, drafting vendor emails, and monitoring inbox for property-related messages. All outbound emails require David's approval before sending."
triggers: ["email", "gmail", "inbox", "send email", "draft email", "check email", "vendor email", "tenant email", "PM email", "property meld email"]
---

# Gmail Skill

Access you@example.com via the `gws` CLI. Already authenticated with OAuth2 refresh token.

## Read inbox

```bash
# Unread summary (sender, subject, date)
gws gmail +triage

# Search for specific emails
gws gmail users messages list --user-id me --q "from:propertymeld.com" --format json
gws gmail users messages list --user-id me --q "subject:emergency" --format json

# Read a specific message
gws gmail users messages get --user-id me --id <message_id> --format json
```

## Send email

**APPROVAL REQUIRED** — never send without David's explicit approval.

```bash
# Draft and send (only after approval)
gws gmail +send --to "vendor@example.com" --subject "Subject" --body "Body text"

# With CC
gws gmail +send --to "vendor@example.com" --cc "you@example.com" --subject "Subject" --body "Body"
```

## Workflow

1. **Reading:** Free to read inbox at any time for PM notifications, vendor responses, tenant messages
2. **Drafting:** Write the draft, send to an agent for routing to David for approval
3. **Sending:** Only after David approves via Telegram. Always CC you@example.com on vendor comms.
4. **Night mode:** Read only. Queue drafts for morning review. No sending.

## Configure processed-message deduplication

Gmail watch persistence is controlled by the agent's `config.json`, not environment variables. During onboarding, create or select a processed label, look up its Gmail API label ID, and configure both the label ID and the query exclusion:

```json
{
  "gmail_watch": {
    "query": "is:unread -label:<processed-label-name>",
    "interval_ms": 900000,
    "processed_label_id": "<processed-label-id>"
  }
}
```

`gmail_watch.processed_label_id` is the label ID the daemon applies after it writes the inbox event. The `-label:<processed-label-name>` term uses the label's Gmail query name and keeps already-labeled messages out of later searches. Configure both values and do not guess either one. Without `processed_label_id`, deduplication is only in memory and a message can be delivered again after a restart.

Manual `gws gmail users messages modify` calls can apply labels during cleanup, but they are not the daemon's restart-redelivery control. The authoritative control is `config.json` `gmail_watch`.

## Useful searches

- Property Meld notifications: `from:propertymeld.com`
- Emergency melds: `from:propertymeld.com subject:emergency`
- Vendor responses: `from:<vendor_email>`
- Unread only: `is:unread`
- Last 24h: `newer_than:1d`
