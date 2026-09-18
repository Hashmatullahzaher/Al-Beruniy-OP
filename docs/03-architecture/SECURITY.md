# Security Architecture
Authentication → session/token → RBAC → project scope → department scope → field-level rules → approval authority → audit. Controls: MFA/SSO-ready identity, least privilege, server-side authorization, SoD, row/project and field security, session revoke/expiry, login/activity logs, immutable financial lineage, encryption at rest/in transit, managed secrets, backup/DR/HA, security monitoring and access recertification. Portal identities cannot access internal modules; AI receives security-trimmed context only.

## AI Core & Telegram Security

### AI Core
- Indexing may run under an explicit Machine Identity, never anonymous superuser access.
- Every indexed object carries security tags.
- Retrieval is re-authorized at query time; index presence does not grant access.
- Tool execution independently re-checks RBAC, project, department, field, party scope, authority and SoD.
- Prompt injection and untrusted-document instructions must not alter authorization/tool policy.
- Model providers receive only the minimum context required for the task.
- Provider/model/data-classification allowlists are enforced by the Model Gateway.
- Secrets/tokens are stored in managed secret storage and rotated.
- Sensitive prompts/outputs may require redaction/limited retention.
- AI cannot directly post journals or bypass workflow.

### Telegram
- Telegram username is not identity proof.
- User must bind Telegram user ID/chat to an authenticated ABOS Type A UserAccount using a one-time link flow.
- Binding is revocable.
- Webhooks require secret verification, replay protection, TLS, rate limiting and idempotency.
- Group chats are not authorization contexts; sensitive data is disabled in groups by default.
- High-risk actions require step-up authentication or a secure ABOS deep link.
- Bot tokens and webhook secrets are environment-specific managed secrets.
- Every Telegram interaction is correlated to AI/tool/domain/audit records.

