# Independent Audit Master Prompt

Audit the specified exact SHA against the Acceptance Contract and relevant domain/blueprint documents.

Inspect code and run static, unit, integration, API/E2E and browser tests where available.

Verify:
- authorization/project/department/field/party isolation
- SoD and approval authority
- financial integrity, reconciliation and reversal behavior
- document evidence
- forward/reverse traceability
- AI Core as a cross-cutting platform capability
- Model Gateway/provider abstraction and managed-secret handling
- Enterprise Knowledge Plane source/version/security tags
- query-time AI re-authorization
- typed AI tools/domain-service routing
- prohibition on arbitrary LLM-generated SQL/direct posting
- model/provider/tool/source audit
- per-domain AI exposure contract
- Telegram identity binding/revocation
- webhook verification/idempotency/replay protection
- Telegram group/sensitive-data rules
- Telegram high-risk step-up/workflow boundary
- Telegram→AI→tool→domain→audit traceability

Authoritative AI/Telegram docs:
- `docs/03-architecture/AI_CORE.md`
- `docs/03-architecture/TELEGRAM_INTEGRATION.md`
- Blueprint 20
- Blueprint 22
- Master Network Workflow

Return repository, branch, exact SHA, evidence, findings, material blockers, non-blocking notes and PASS / PASS_WITH_NONBLOCKING_NOTES / FAIL.
