# Conceptual Data Model
Core dimensions: Company, LegalEntity, Project, Phase, Zone, Building/Block/Tower, Floor, Unit, Department, CostCenter, Currency, Period. Identity: UserAccount, Role, Permission, UserRole, ProjectAssignment, ApprovalAuthority. Parties: BusinessParty + Customer/Supplier/Contractor/Employee profiles. Sales: Lead, Opportunity, KYC, PriceList, Quote, Reservation, SalesContract, Installment, Receipt, Handover. Finance: LedgerAccount, Journal/Line, AR/AP entries, Bank/Cash, Budget/Commitment, Asset, Period. Construction: WBS, Activity, BOQ/Item, Baseline, Progress, RFI, Submittal, Inspection, Variation, Claim, Forecast. Procurement/Inventory: PR, RFQ, Quote, BidEvaluation, PO, Delivery, GRN, SupplierInvoice, Match, Warehouse, Material, StockMovement/Count. HR: Position, Contract, Attendance, Leave, OT, PayComponent, PayrollRun, Payslip, Loan/Advance, ProjectAllocation. Cross-cutting: Document/Version, WorkflowInstance/Step, ApprovalAction, Notification, AuditRecord.

## AI Core Data Model
Add the following conceptual entities:

### Model / Provider
- AIProviderConnection
- AIModel
- AIModelRoutingPolicy
- AIProviderCredentialRef
- AIUsageRecord

### Agent / Conversation
- AIConversation
- AIMessage
- AIRun
- AITask
- AIToolDefinition
- AIToolInvocation
- AIActionProposal
- AISourceCitation
- AIPolicyDecision

### Enterprise Knowledge Plane
- KnowledgeSource
- KnowledgeObject
- KnowledgeChunk
- KnowledgeIndexRef
- KnowledgeSyncRun
- KnowledgeSecurityTag
- EntityKnowledgeLink

Each knowledge object/chunk carries source ID/version, company/legal entity, project, department, party scope where applicable, sensitivity/classification, effective dates and ACL/security tags.

### Machine Identity
- MachineIdentity
- MachinePermission
- ServiceCredentialRef

### Telegram
- TelegramBotConfig
- TelegramIdentityBinding
- TelegramConversation
- TelegramMessageRef
- TelegramWebhookEvent
- TelegramDelivery
- TelegramActionRequest

Relationships:
- UserAccount 1:N AIConversation
- AIRun 1:N AIToolInvocation
- AIRun N:N KnowledgeObject through AISourceCitation
- UserAccount 1:N TelegramIdentityBinding
- TelegramConversation N:1 UserAccount after binding
- Telegram message 1:1/N AIRun depending on orchestration
- Domain entity/event/document N:N KnowledgeObject through source references

