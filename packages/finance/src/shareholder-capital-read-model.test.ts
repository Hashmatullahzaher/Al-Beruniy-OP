import assert from "node:assert/strict";
import test from "node:test";

import type { JournalId, ShareholderCapitalReceiptTrace } from "@abos/contracts";

import { UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY } from "./shareholder-capital-application.ts";
import { buildShareholderCapitalTraceReadModel } from "./shareholder-capital-read-model.ts";

function receipt(contributionId: string, id: string, amount: string, stage: "RECEIVED" | "VERIFIED" | "APPROVED" | "POSTED"): ShareholderCapitalReceiptTrace {
  return {
    receiptId: id,
    contributionId,
    amount: { amount: amount as never, currency: "USD" },
    receiptDate: "2026-10-10",
    treasuryDestinationId: "safe-usd",
    treasuryDestinationName: "USD safe",
    custodyState: stage === "RECEIVED" ? "PENDING_VERIFICATION" : "VERIFIED",
    approvalState: stage === "APPROVED" || stage === "POSTED" ? "APPROVED" : "PENDING",
    postingState: stage === "POSTED" ? "POSTED" : "NOT_POSTED",
    postingIntentId: stage === "APPROVED" || stage === "POSTED" ? `intent-${id}` : null,
    journalId: stage === "POSTED" ? `journal-${id}` as JournalId : null
  };
}

test("read model keeps declared received verified approved posted and outstanding separate", () => {
  const model = buildShareholderCapitalTraceReadModel({
    capability: UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY,
    declaration: {
      contributionId: "zemar-2026-10-06",
      shareholderProfileId: "zemar-profile",
      shareholderBusinessPartyId: "zemar-party",
      shareholderDisplayName: "Zemar",
      declarationDate: "2026-10-06",
      declaredAmount: { amount: "50000" as never, currency: "USD" }
    },
    receipts: [
      receipt("zemar-2026-10-06", "r1", "10000", "POSTED"),
      receipt("zemar-2026-10-06", "r2", "5000", "VERIFIED"),
      receipt("zemar-2026-10-06", "r3", "2500", "RECEIVED")
    ]
  });
  assert.deepEqual({
    declared: model.contribution.declaredAmount.amount,
    received: model.contribution.receivedAmount.amount,
    verified: model.contribution.custodyVerifiedAmount.amount,
    approved: model.contribution.approvedAmount.amount,
    posted: model.contribution.postedAmount.amount,
    outstanding: model.contribution.outstandingAmount.amount,
    status: model.contribution.status
  }, { declared: "50000", received: "17500", verified: "15000", approved: "10000", posted: "10000", outstanding: "32500", status: "POSTED" });
});

test("same-value Zemar declarations and Hashmatullah legacy agreement remain separate", () => {
  const declaration = (id: string) => buildShareholderCapitalTraceReadModel({
    capability: UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY,
    declaration: { contributionId: id, shareholderProfileId: "zemar-profile", shareholderBusinessPartyId: "zemar-party",
      shareholderDisplayName: "Zemar", declarationDate: id.endsWith("06") ? "2026-10-06" : "2026-10-07",
      declaredAmount: { amount: "50000" as never, currency: "USD" } },
    receipts: id.endsWith("06") ? [receipt(id, "only-first", "1000", "RECEIVED")] : [],
    legacyAgreements: [{ agreementId: "hashmatullah-legacy", shareholderProfileId: "hashmatullah-profile",
      shareholderDisplayName: "Hashmatullah", committedAmount: { amount: "20000" as never, currency: "USD" },
      sourceModel: "LEGACY_CAPITAL_AGREEMENT", includedInContributionTotals: false }]
  });
  const first = declaration("zemar-2026-10-06");
  const second = declaration("zemar-2026-10-07");
  assert.equal(first.contribution.receivedAmount.amount, "1000");
  assert.equal(second.contribution.receivedAmount.amount, "0");
  assert.equal(first.legacyAgreements[0]?.includedInContributionTotals, false);
  assert.equal(second.legacyAgreements[0]?.committedAmount.amount, "20000");
});
