# Telegram Bot Integration Architecture

**Document ID:** ABOS-TG-001  
**Purpose:** Make Telegram a governed conversational channel into the AL-BERUNIY AI Core and notification system.

## 1. Position

Telegram is not a parallel ERP and must not contain independent business logic.

Required path:

**Telegram → Telegram Gateway → ABOS Identity / Permission Context → AI Core → Typed Tools / Domain Services → Workflow / Finance / Documents / Audit**

Outbound path:

**ABOS Event / Workflow / Alert → Notification Service → Telegram Gateway → Authorized Chat**

## 2. Telegram Bot API Connection

Production integration should use:
- HTTPS webhook
- webhook secret verification
- allowlisted callback endpoint
- replay protection
- rate limiting
- retry/idempotency
- delivery logging

Long polling may be used for local development only.

Credentials:
- bot token stored in managed secrets
- no token in repository, logs or client code
- token rotation procedure
- separate bot/config per environment where required

## 3. Identity Binding

A Telegram identity must never be trusted by username alone.

Binding flow:
1. User signs in to ABOS.
2. User requests a one-time Telegram link code or QR/deep link.
3. User opens the official bot and submits/accepts the link.
4. Backend validates the one-time token.
5. `TelegramIdentityBinding` is created between Telegram user ID/chat and a Type A UserAccount.
6. Normal ABOS roles, project scope, department scope and field security apply.

Binding can be revoked from ABOS.

## 4. Step-Up Authentication

Sensitive actions require stronger confirmation.

Examples:
- approving high-value transactions
- payment-related actions
- payroll access
- sensitive HR data
- journal posting
- bank details
- changing master data

Default Release-1 behavior:
- Telegram may query and draft within authorization.
- High-risk approvals/execution should use a secure ABOS deep link or explicit step-up authentication.
- Direct high-risk execution from Telegram remains disabled unless an approved policy enables it.

## 5. Conversation Modes

Supported modes:
- private user chat
- approved notification channel
- approved executive alert channel

Group chats:
- disabled for sensitive data by default
- read-only alerts only when explicitly allowlisted
- no payroll, bank, customer-private or confidential document content in groups
- group membership is not considered ABOS authorization

## 6. AI Commands / Intents

The bot may support commands such as:
- `/start`
- `/link`
- `/help`
- `/projects`
- `/approvals`
- `/alerts`
- `/ask <question>`
- `/status <reference>`

Natural-language examples:
- "Show me overdue installments in Mazar Mall over 30 days."
- "What are today's pending approvals for me?"
- "Summarize project cost overruns."
- "Find PO 2026-0143."
- "Draft an expense request for Project A."

The AI Core determines intent and uses only authorized typed tools.

## 7. Notifications

Telegram can deliver:
- approval assigned
- approval returned/rejected
- installment overdue alerts
- collection reminders
- low stock
- document expiry
- procurement delay
- contractor IPC status
- project delay/cost alerts
- executive daily briefing
- integration/system alerts to admins

Each notification must contain a safe deep link to the relevant ABOS record where appropriate.

## 8. Attachments

Telegram documents/photos may be accepted only through the Document Service.

Flow:
**Telegram File → size/type validation → malware/security scan → permission check → object storage → Document record/version → source transaction link → audit**

No file is written directly into domain storage.

## 9. Telegram Actions

Telegram callback buttons or commands may:
- acknowledge an alert
- open a record
- request detail
- submit a low-risk draft action
- initiate an approval flow

They must not bypass:
- SoD
- approval authority
- workflow
- Finance posting rules
- project/party/field security

## 10. Data Model

Core entities:
- TelegramBotConfig
- TelegramIdentityBinding
- TelegramConversation
- TelegramMessageRef
- TelegramDelivery
- TelegramActionRequest
- TelegramWebhookEvent

Every record includes environment, timestamps and audit linkage.

## 11. Audit & Traceability

Every Telegram interaction records:
- Telegram user/chat ID
- linked ABOS UserAccount
- channel/private/group
- normalized intent
- permission scope
- AI run ID
- tool calls
- source records
- action requested
- workflow/approval result
- response/delivery status
- correlation ID

Trace:

**Telegram Message → AI Run → Tool → Domain Transaction → Workflow → Posting/Document → Response**

## 12. Failure Behavior

If:
- user is unlinked → request linking
- user is disabled → deny
- permission is missing → deny
- bot cannot verify webhook → reject
- AI provider unavailable → return controlled service-unavailable response
- domain service fails → no fabricated success
- duplicate webhook → idempotently ignore/reuse result
- action needs approval → create workflow and report pending status

## 13. Release-1 Acceptance

Telegram integration is complete when:
- official bot is configured with managed secret
- webhook verification works
- ABOS↔Telegram identity linking works
- revocation works
- authorized read query works
- unauthorized query fails
- AI answer uses ABOS AI Core and source-grounded tools
- notification delivery works
- attachment path uses Document Service
- audit chain exists
- high-risk action cannot bypass step-up/workflow
