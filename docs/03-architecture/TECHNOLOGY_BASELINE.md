# AL-BERUNIY Operating System — Technology Baseline

**Document ID:** ABOS-TECH-001  
**Status:** Binding Release-1 implementation baseline unless changed by an explicit ADR before dependent work is merged.

## 1. Architectural Style

Release 1 starts as a **modular monolith with strict domain boundaries**, API-first contracts, transactional outbox, background workers and integration adapters. Modules are independently testable and can be extracted into services later without changing business contracts.

Do not begin with distributed microservices merely for architectural appearance. Financial integrity, traceability and delivery speed take priority. Service boundaries must still be respected in code.

## 2. Primary Stack

### Language / workspace
- TypeScript, strict mode
- Node.js LTS
- pnpm workspace
- Turborepo or equivalent task graph for monorepo orchestration

### Web application
- Next.js + React + TypeScript
- server/client boundaries explicit
- TanStack Query or equivalent for server-state
- accessible enterprise component system
- responsive desktop/tablet/mobile layouts
- Playwright for browser E2E

### Backend / API
- NestJS with Fastify adapter, or equivalent structured TypeScript server framework if an ADR proves a better fit
- REST/JSON as primary public application API
- OpenAPI generated from source
- versioned APIs
- typed validation at all trust boundaries
- explicit domain/application/infrastructure layers

### Database
- PostgreSQL as authoritative OLTP relational database
- PostgreSQL extensions only when justified and migration-safe
- pgvector for Release-1 vector storage unless scale proves a dedicated vector database is required
- deterministic NUMERIC/DECIMAL for money and accounting quantities

### Data access
- Prisma or equivalent strongly typed ORM/data mapper
- migrations committed to repository
- raw SQL allowed only inside reviewed repository code/migrations, never generated arbitrarily by AI at runtime

### Cache / jobs / coordination
- Redis
- BullMQ or equivalent durable job abstraction for Release 1
- transactional outbox in PostgreSQL for reliable domain-event publication
- external message-bus adapter boundary retained for future NATS/RabbitMQ/Kafka if scaling requires it

### Documents / object storage
- S3-compatible object storage abstraction
- MinIO permitted for local/dev
- cloud object provider selectable by configuration

### Identity
- OIDC/OAuth2 provider-neutral integration
- Keycloak may be used as local/dev reference IdP
- application remains compatible with enterprise IdPs
- MFA/SSO concerns remain outside domain account semantics

### AI Core
- provider-neutral Model Gateway owned by ABOS
- official provider APIs/adapters behind one internal interface
- provider credentials via managed secret references
- pgvector + structured/keyword search for initial Enterprise Knowledge Plane
- own typed tool registry/domain-service integration; no direct LLM→database execution
- model provider may be OpenAI, Anthropic, compatible private endpoint, or another approved provider without changing domain code

### Telegram
- Telegram Bot API through HTTPS webhook in production
- bot token/webhook secret from managed secrets
- no business logic in the bot adapter

### Analytics
- operational reporting from PostgreSQL read models where safe
- analytics/DWH abstraction defined from the beginning
- heavy BI pipeline may use a separate analytical store after volume evidence justifies it
- no dashboard may bypass authoritative source/reconciliation contracts

### Observability
- OpenTelemetry traces/metrics/log correlation
- structured JSON logging
- health/readiness endpoints
- error tracking provider through adapter/configuration

### Infrastructure
- Docker for local reproducibility
- Docker Compose for local dependencies
- production delivered as container images
- cloud-neutral deployment design
- Kubernetes-ready, but Kubernetes is not mandatory for first deploy unless chosen by operations ADR

## 3. Repository Target Structure

```text
apps/
  web/
  api/
  worker/
  portal-customer/
  portal-supplier/
  portal-contractor/
packages/
  domain/
  auth/
  workflow/
  documents/
  finance/
  ai-core/
  integrations/
  ui/
  config/
  observability/
  testing/
infra/
  docker/
  deployment/
  scripts/
prisma-or-db/
  migrations/
  seed/
docs/
```

Builders may refine names, but domain boundaries and responsibilities must remain explicit.

## 4. Engineering Rules

- strict TypeScript; avoid `any` except documented adapter boundaries
- money uses decimal types, never binary floating point
- UTC storage; explicit business/user timezone display
- IDs are stable opaque identifiers; human-readable document numbers are separate
- migrations are forward-tested
- APIs return structured error codes
- all write endpoints support idempotency where retry/financial duplication is possible
- authorization is server-side
- audit and correlation metadata propagate across API/job/event boundaries
- public integrations are versioned
- secrets never enter source control
- test data contains no real confidential data

## 5. ADR Rule

If a builder believes a baseline technology must change:
1. create an ADR under `docs/03-architecture/adr/`
2. state problem, options, impact, migration cost and recommendation
3. do not silently replace the baseline
4. high-impact changes to database, language, framework, identity, finance architecture, AI gateway or deployment require Lead Orchestrator review before implementation

This baseline exists so Claude, Codex and Antigravity build one system rather than three incompatible systems.
