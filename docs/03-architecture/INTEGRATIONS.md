# Integrations
Use synchronous APIs where appropriate and events/webhooks/message queues for async work. Categories: banks/payment gateways, Email/SMS/WhatsApp, Primavera/MS Project, BIM/Revit, biometric attendance, barcode/QR, government/tax/title systems, external accounting/legacy systems, analytics/AI. Requirements: scoped credentials/mTLS as appropriate, idempotency for financial writes, signed webhooks/replay protection, retry/backoff/dead-letter, audit/reconciliation and external source IDs.

## LLM / AI Provider Integration
All LLM/model connectivity goes through the AI Model Gateway.

Supported connection patterns:
- API key
- service account / enterprise credential
- OAuth2/provider sign-in where supported
- private/self-hosted model endpoint

Requirements:
- provider/model registry
- encrypted secret references
- model routing/fallback
- provider/model health
- rate/cost controls
- timeout/retry
- data-classification/provider policy
- provider region/data-residency metadata
- request/response audit metadata

No domain module may call an external LLM directly.

## Telegram Bot Integration
Telegram Bot API is a first-class channel connector.

Production requirements:
- HTTPS webhook
- webhook secret verification
- idempotent update handling
- replay protection
- rate limiting
- outbound retry/delivery status
- environment-separated bot configuration
- Type A UserAccount identity binding
- Notification Service integration
- AI Core routing
- Document Service routing for attachments
- full audit/correlation IDs

See `TELEGRAM_INTEGRATION.md`.

