# Customize Accounting Coordinator

Complete this file before running the template against live systems.

## Required Placeholders
- {{AGENT_NAME}}: replace with your member-specific value or remove if unused.
- {{OWNER_NAME}}: replace with your member-specific value or remove if unused.
- {{COMPANY}}: replace with your member-specific value or remove if unused.
- {{TIMEZONE}}: replace with your member-specific value or remove if unused.
- {{PMS}}: replace with your member-specific value or remove if unused.
- {{CRM}}: replace with your member-specific value or remove if unused.
- {{TASK_SYSTEM}}: replace with your member-specific value or remove if unused.
- {{KNOWLEDGE_SOURCE}}: replace with your member-specific value or remove if unused.

## Role Setup Checklist
- Define systems of record for: {{ACCOUNTING_SOURCE}}, {{PMS}}, {{BANKING_SYSTEM}}, {{DOCUMENT_STORE}}.
- Define approval owners for: payment, owner draw, deposit disposition, banking change, statement publish, ledger write.
- Keep real secrets outside git.
