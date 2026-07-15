---
name: communications
description: "Handle user and agent messages through the configured bus."
---

# Communications

`OPERATING_MODEL.md` is the active gate for authority, approvals, external comms, and system-of-record boundaries. If this skill conflicts with `OPERATING_MODEL.md`, follow `OPERATING_MODEL.md` unless {{OWNER_NAME}} gives a newer direct instruction.

Use the reply path shown by the member runtime. Human-facing replies should be plain and useful.

## Minimum Steps
1. Confirm the request and desired output.
2. Check the configured system of record.
3. Apply the approval gate from `OPERATING_MODEL.md`.
4. Execute only the authorized scope.
5. Report result, verification, and remaining blockers.
