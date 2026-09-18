# Project Charter

Build the digital operating system for AL-BERUNIY, a real-estate development and construction company that acquires land, builds projects and sells units including installments.

The platform must unify project operations, finance, sales/collections, construction, BOQ/cost, procurement, suppliers, contractors, inventory, expenses, HR/payroll, documents, approvals, BI, executive management, portals and integrations. Projects remain operationally/financially separable while consolidating to corporate level.

## AI-first operating principle

ABOS includes a cross-cutting **AI Core / Enterprise Intelligence Control Plane** that sits logically above/across every module. It maintains a governed enterprise knowledge plane, connects to approved LLM/model providers through a provider-neutral Model Gateway, and uses typed tools/domain services to read, explain, draft and act within normal permissions/workflows.

The AI Core must become more knowledgeable as each domain is implemented; it is not deferred to the end of the project.

Telegram is an official governed conversational/notification channel into this same AI Core. Telegram must bind to ABOS identity and reuse ABOS authorization, workflow, Finance, Documents and audit controls.
