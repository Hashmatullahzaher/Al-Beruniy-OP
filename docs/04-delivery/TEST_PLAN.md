# Test Plan

Static: formatting/lint/type/schema/secret scan.

Unit:
- calculations/state/permissions/approval/posting/payroll/cost
- AI tool schemas, model routing policy and permission decisions
- Telegram identity/link token lifecycle, webhook verification and idempotency

Integration:
- database/subledger-GL/document/workflow/events/adapters
- Model Gateway provider connection/authentication
- Enterprise Knowledge Plane ingestion, source/version/security tags and refresh
- AI typed-tool authorization/domain-service routing
- Telegram webhook → identity → AI Core → domain service → audit
- outbound notification → Telegram delivery status

API/E2E:
- sales, collection, procurement, inventory, contractor IPC, expense, payroll
- cross-module AI question with source grounding
- AI draft/action that enters normal workflow
- Telegram authorized query
- Telegram unauthorized/unlinked query denial
- Telegram attachment through Document Service

Browser UAT:
- login→create→attach→submit→approve→post/pay→reopen→drilldown/audit
- persistent in-app Copilot
- AI source links and current-project context
- provider/admin model configuration

Security:
- negative authorization
- project isolation
- field masking
- SoD
- portal own-party
- AI retrieval trimming
- AI tool re-authorization
- prompt-injection / untrusted-document policy
- provider data-classification policy
- Telegram identity spoofing prevention
- Telegram group restrictions
- high-risk Telegram step-up/workflow enforcement
- bot/provider secret leakage checks

Finance:
- balanced journals
- idempotency
- reversal
- period locks
- reconciliation
- decimal precision
- AI/Telegram cannot bypass Finance posting services

AI Core acceptance:
- approved LLM provider connects through Model Gateway
- provider failure is controlled and does not fabricate success
- knowledge source freshness/rebuild works
- unauthorized indexed content cannot be retrieved
- model/provider/version/source/tool audit is present
- every major domain passes AI exposure contract check

Telegram acceptance:
- official bot config uses managed secrets
- HTTPS webhook secret verification passes
- ABOS↔Telegram binding/revocation passes
- duplicate update is idempotent
- authorized query succeeds
- unauthorized query fails closed
- notification delivery is traceable
- sensitive/high-risk action cannot bypass step-up/workflow
