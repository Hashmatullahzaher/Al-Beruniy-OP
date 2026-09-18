# Cross-Domain Business Rules
- Every applicable transaction carries Company/Legal Entity, Project, Department and Cost Center.
- Type A User, Type B Party and Type C Ledger accounts are never conflated.
- Every posted financial event is balanced double-entry.
- Posted records are immutable; corrections use linked reversals/adjustments.
- KPI/report ↔ transaction ↔ document ↔ actor/approval ↔ journal/ledger traceability is mandatory.
- SoD blocks conflicting duties such as creator/approver/payer.
- Material side effects execute only after required workflow approvals.
- Project isolation is enforced; authorized corporate roles may consolidate.
- Controlled transactions require supporting evidence where configured.
- External/batch financial writes are idempotent.
- Monetary/quantity calculations use deterministic decimal arithmetic.
- Unknown official policies remain explicit configuration/open items.
- AI Core is a cross-cutting platform capability and every domain must publish AI-safe typed tools, source IDs, permission metadata and domain events/read models.
- The enterprise knowledge plane may ingest cross-system content using an explicitly authorized machine identity, but end-user retrieval is always re-authorized against the requesting identity and security tags.
- No LLM provider is called directly by a domain module; all model traffic goes through the Model Gateway.
- AI-generated write actions are proposals/typed tool calls and remain subject to the same validation, workflow, SoD, approval and finance controls as human actions.
- Telegram is a channel, not a system of record. Every Telegram request must bind to an ABOS Type A identity before accessing protected data.
- Telegram username/group membership is never sufficient authorization; high-risk actions require approved step-up authentication/workflow.

