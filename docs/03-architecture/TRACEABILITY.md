# Traceability
Every material transaction must answer: company/legal entity/project; department/cost center; creator; approver(s); related party; source request/contract/PO/GRN/invoice/IPC/receipt/document; payment/bank transaction; journal and ledger accounts; budget/commitment/cost impact; audit history and workflow/accounting status. Traceability works forward (operation→ledger/report) and reverse (dashboard→origin).

## AI / Telegram Traceability
AI interactions must also answer:
- initiating user or machine identity
- channel (web/mobile/Telegram/background)
- conversation/run ID
- active company/project context
- permission/security scope evaluated
- model provider/model/version
- retrieved source IDs and source versions
- tools invoked and arguments/result references
- workflow/approval initiated
- resulting domain transaction
- document evidence
- financial posting where applicable
- final response/delivery status

Canonical trace:

**Telegram/Web Question → Identity → Permission Context → AI Run → Knowledge Sources / Typed Tool → Domain Service → Workflow → Transaction → Document/Posting → Response**

Reverse trace must support:

**AI answer/action → source records → user/machine identity → model/tool run → resulting transaction/audit.**

