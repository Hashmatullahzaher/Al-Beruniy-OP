# V1 backlog #17 — controlled reversals: handoff

Author: Claude Code (Agent A). Date: 2026-09-28. Base: `v1/integration` at `f0bb7183`.
Implementation commit: `3df23d4` on branch `worktree-agent-a7139d145f1075b2e`. Not pushed or merged; the lead integrates.

Owner decision implemented (2026-09-25): *a Finance user requests a reversal and the Finance Manager approves it;
posted history stays immutable; nobody approves their own transaction.* Everything the owner has not decided is
fail-closed and listed in section 4.

## 1. What exists

| Layer | What |
|---|---|
| Migration | `0023_v1_reversal_requests.sql`, sha256 `b56e026ee8612c921cf2a4815a75bcdfda43a72932e824e4da363ad1bd570242`, registered in `packages/database/src/migrations.ts` after 0022 |
| Permissions | `finance.reversal.request` (270) and `finance.reversal.approve` (271): catalogue version 4, FINANCE, ACTIVE, `independence_enforced = true` (both rules are enforced by the database). `finance.journal.reverse` is unchanged and still `UNAVAILABLE_IN_PREVIEW` |
| Table | `abos.journal_reversal_requests`: legal entity, posted journal, reason (10–1000 characters, trimmed), requester and time, status `REQUESTED → APPROVED \| REJECTED \| WITHDRAWN`, decision actor/time/note, version. Rows cannot be deleted or truncated; what was requested, by whom and when never changes; a decision is recorded once |
| Rules (database) | Journal must be POSTED, in the same legal entity, not already reversed (`journal_reversal_links`) and not itself a reversal. At most one open (REQUESTED or APPROVED) request per journal (partial unique index). The decider is never the requester; only the requester withdraws, and only while REQUESTED; a rejection needs a note. Conservative participant rule: see section 3 |
| Entry points | `finance_reversal_requests_view`, `finance_reversal_request_create`, `finance_reversal_request_decide`, `finance_reversal_request_withdraw`: SECURITY DEFINER, owned by `abos_e1_finance_owner`, `search_path = pg_catalog, pg_temp`, PUBLIC revoked, EXECUTE only to `abos_e1_runtime`. Actor and entity come only from the token via `finance_runtime_authorize` |
| Scope | Same conjunctive rule as `finance_general_ledger` (0020): a person may request, decide, withdraw or even see a reversal only when every line of the journal is within their live project, department and cost-center scopes. Anything else is reported as "not found" |
| Privileges | Runtimes have no table privilege. The Finance owner has SELECT, column-level INSERT (`id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id, requested_at, version`) and column-level UPDATE (`status, decided_by_user_account_id, decided_at, decision_note, version`) on the request table only. It still has no INSERT on `journal_reversal_links`. Journals are locked `FOR SHARE` with the column privileges it already held (0011); no new lock-only table was needed. Helpers are executable by the Finance owner only |
| Idempotency | Replaying the same request (same person, same reason) returns the existing request (`created: false`); replaying the same decision or withdrawal by the same person returns `changed: false`. Concurrent double decisions or requests settle to exactly one outcome (row lock / unique index) |
| Audit | `audit_records` rows `JOURNAL_REVERSAL_REQUESTED / _APPROVED / _REJECTED / _WITHDRAWN`, entity type `JOURNAL_REVERSAL_REQUEST`, true actor, `metadata.postingPerformed = false` |
| Read projection | The view returns the requests and (for requesters) the eligible posted journals (newest 100, with `eligibleHasMore`), each with its lines and per-currency totals as exact decimal text, and only the display names of actors recorded on the rows (requester, decider, the journal's poster) |
| API | `GET/POST /api/v1/finance/reversals`, `POST /api/v1/finance/reversals/{id}/decision`, `POST /api/v1/finance/reversals/{id}/withdraw`, and `POST /api/v1/finance/reversals/{id}/post`, which always answers `409 POSTING_POLICY_PENDING` and writes nothing |
| UI | `/finance/reversals` (`ReversalRequestsWorkspace.tsx`): banner "reversal posting is not enabled", request tab with journal picker and reason, requests list with approve / reject (note required) / withdraw, explicit "Approved · awaits posting policy" state. English and Dari, RTL, phone width. Nav entry "Journal reversals" for holders of either new permission or the Finance read permission |

## 2. What is fail-closed

**Posting an approved reversal is not implemented.** APPROVED is terminal. No reversal journal, journal line, posting
intent, posting approval, subledger entry, outbox event, idempotency record or `journal_reversal_links` row is created,
and no source record changes. A test compares the full footprint (journals, lines, links, intents, approvals, subledger
entries, outbox, idempotency records, capital receipt intents, installments, commitment usage, cash receipts, safe
accounts) byte for byte before and after the whole request/approve workflow. The API and UI say, in plain language,
that the approved reversal awaits the Finance Manager's posting policy.

The existing 0001/0002 reversal controls (exact-inverse lines and subledger entries, `REVERSAL_REASON` evidence,
immutable link, posted reversal requires a link, poster of the reversal ≠ poster of the original) are untouched and will
apply to the future posting step.

## 3. Conservative defaults (pending the Finance Manager)

- Whoever **prepared** the posting intent, **approved** it (any recorded approval), **created** or **posted** the
  journal may neither **request** nor **decide** its reversal. This is stricter than the owner decision, which only
  says nobody approves their own transaction. It lives in one helper (`abos.reversal_journal_participants`) and the
  request-table trigger, so relaxing it is a one-function change in a later migration. Treasury custody participants
  (cashier, counter, verifier) are not included.
- A journal that is itself a reversal cannot be requested for reversal.
- After a rejection or withdrawal, a new request for the same journal is allowed.

Technical bounds chosen (not policy): reason 10–1000 characters; rejection note at least 3 characters; notes at most
1000 characters; the eligible-journal list shows the newest 100.

## 4. Decisions still needed

Finance Manager (policy), before any reversal can be posted:
1. **Reversal date and accounting period.** The original date, the date of approval, or a chosen date; what happens
   when the original period is closed; who may choose.
2. **Evidence.** Whether a written reason is enough or a `REVERSAL_REASON` document (and of what kind) is required;
   who attaches it. The 0001 link already requires `REVERSAL_REASON` evidence, so posting cannot proceed without this
   decision.
3. **Effect on source records** when a capital journal is reversed: the capital receipt intent, the installment and
   its status, the agreement's commitment usage, and the safe's custody (is the cash returned, re-classified or left in
   the safe?). Also the Treasury side: whether a reversal needs a Treasury action.
4. **Participants.** Whether the original preparer, approver or poster may request, and whether they may approve, its
   reversal (today: neither, see section 3).
5. **Who posts** the approved reversal, and whether posting needs another independent person (the 0002 trigger already
   requires the reversal's poster to differ from the original poster).
6. Minor: whether a rejected or withdrawn request may be raised again for the same journal (today: yes), and whether a
   reversal may itself be reversed (today: no). Reversal versus adjustment authority and reporting presentation remain
   open as already recorded in `OPEN_ITEMS.md`.

Owner / lead:
7. `packages/identity/src/identity-service.ts` keeps a hard-coded `INDEPENDENCE_PERMISSIONS` set (only a Super
   Administrator may give or take away approval access). `finance.reversal.approve` (and arguably
   `finance.reversal.request`) are not in it, so a user administrator who is not a Super Administrator could give
   reversal approval to someone. That file is outside this package's ownership; recommend adding both codes.

## 5. Proposed wording for the lead

`V1_DELIVERY_BACKLOG.md`, row #17:

> | 17 | Reversal: Finance requests, Finance Manager approves | **Done (preview) — posting fail-closed** (0023) | #10; Finance Manager posting policy | Request with written reason, independent Finance Manager approval or rejection, withdrawal by the requester, one open request per posted journal, scope and entity isolation, audit. Conservative default: the journal's preparer, approver and poster can neither request nor decide its reversal. **Posting the approved reversal is not implemented**: the reversal date/period, evidence and effect on source records await the Finance Manager. Tests: `reversal-requests.test.ts`, `v1-reversals.spec.ts` |

`OPEN_ITEMS.md`, replace the reversal line under "Stage 1 E0 Finance Manager Approval Gates" with:

> - reversal versus adjustment authority, reason/evidence requirements, period treatment and reporting presentation — **[Partly resolved 2026-09-25]** a Finance user requests a reversal and the Finance Manager approves; posted history stays immutable. **Built (0023):** request, approval/rejection, withdrawal, audit; posting fail-closed. Still open: (a) date and accounting period of the reversal journal; (b) evidence beyond the written reason (`REVERSAL_REASON` document?); (c) effect on source records of a reversed capital journal (receipt intent, installment, commitment, safe custody) and any Treasury action; (d) whether the original preparer/approver/poster may request or approve its reversal (conservative default: no); (e) who posts the approved reversal; (f) re-requesting after rejection and reversing a reversal; presentation in reports.

## 6. Tests and validation (PostgreSQL 17, Node 22)

| Suite | Result |
|---|---|
| Lint | pass (local Playwright wrapper excluded; it is never committed) |
| Typecheck | 12/12 |
| Unit | 133/133 (migration 6/6) |
| PostgreSQL integration, full suite on `abos_e1_sandbox_rev` | 131/131 (124 before + 7 new in `reversal-requests.test.ts`; ownership map now 38 definers) |
| Build | 11/11 |
| Browser `v1-reversals.spec.ts` (gated by `ABOS_V1_PREVIEW_E2E=1`, reseeds `abos_e1_dev_rev`) | 1/1 |

The browser journey runs `preview:seed`, then `packages/e1-integration/src/reversal-preview-fixture.ts`, which posts one
synthetic USD capital journal through the real Treasury workflow and the restricted posting function, prepared and
posted by two extra synthetic people without sign-in (so the demo Finance people are not participants). The Super
Administrator creates "Reversal Requester" and "Reversal Approver" roles; the Finance preparer requests; the API refuses
the requester's own decision (403); the Finance approver approves; the `/post` route answers 409; the General Ledger
lines are unchanged; Dari and phone width without horizontal overflow.

Shared files touched (append-only, marked "WP #17"): `packages/database/src/migrations.ts`,
`packages/e1-integration/src/security-ownership.test.ts`, `apps/web/src/components/AppShell.tsx` (one `previewRoutes`
entry), `apps/web/src/app/globals.css` (one block), `apps/web/src/lib/access-copy.ts`.
