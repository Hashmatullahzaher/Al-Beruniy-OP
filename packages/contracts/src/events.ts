import type { CorrelationId, LegalEntityId, UserAccountId } from "./ids.ts";

export interface DomainEventEnvelope<TType extends string, TPayload> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly legalEntityId: LegalEntityId;
  readonly actorUserAccountId: UserAccountId;
  readonly payload: TPayload;
}
