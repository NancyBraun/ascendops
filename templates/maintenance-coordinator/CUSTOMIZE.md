# Customize Maintenance Coordinator

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
- Define systems of record for: {{MAINTENANCE_PLATFORM}}, {{PMS}}, {{VENDOR_DIRECTORY}}, {{MESSAGING_SYSTEM}}.
- Define approval owners for: emergency dispatch, customer message, vendor assignment, spend approval, owner notification.
- Keep real secrets outside git.
