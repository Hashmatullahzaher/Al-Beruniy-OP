# Operations Readiness

Separate dev/staging/prod; reproducible config; forward-tested migrations and rollback/restore strategy; externalized secrets; TLS; health/logs/metrics/alerts; no hard-coded production credentials; exact-SHA releases.

Automated encrypted DB/document backups, defined RPO/RTO/retention after stakeholder approval, isolated restore tests.

Security review covers MFA/RBAC/project/field rules, SoD, portal/AI/Telegram isolation, secrets, encryption, dependency/secret scans, audit lineage, restore and admin action logging.

## AI Core Operations
- separate provider connections/config per environment
- provider API/OAuth/service credentials stored only in managed secrets
- model/provider health monitoring
- model routing/fallback visibility
- request latency/token/cost/error metrics
- provider/model/version audit
- knowledge-source freshness and failed-ingestion alerts
- vector/search index rebuild procedure
- AI run/tool failure monitoring
- machine-identity access review
- prompt/output retention/redaction policy
- provider outage runbook
- model/provider change approval and rollback

## Telegram Operations
- separate bot or environment-safe bot configuration
- bot token/webhook secret in managed secrets
- webhook TLS/secret/replay validation
- delivery/retry/error metrics
- duplicate-update/idempotency monitoring
- identity-binding review/revocation
- approved group/channel allowlist
- step-up/deep-link policy
- bot token rotation procedure
- Telegram outage/fallback notification runbook

UAT stories include sales→collection, procure→pay, IPC→payment, payroll→allocation, executive drilldown, AI cross-module source-grounded query, Telegram identity→AI query/action workflow, and denied unauthorized access.
