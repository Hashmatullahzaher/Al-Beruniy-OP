# Stage 1 E1 — Treasury Domain Handoff (Claude)

**Branch:** `agent/claude/stage-1-e1-treasury`
**Base:** `ce4da1eaa717a92fd935fc6a4717aad3a0fc8c22` (head of `agent/codex/stage-1-e1-integrated-sandbox`)
**Scope:** isolated synthetic sandbox only. Not merged to `main`, not deployed, no real posting,
no real records imported, no bank or Saraf transactions.

I own Shareholder and Treasury. Codex owns Finance, the shared database architecture and the secure
posting interface. This branch builds on Codex's head and does not rewrite any Finance logic; the
places where Treasury touches a Finance table are listed in section 5 for Codex's review.

---

## 1. What replaced the stand-in

`recordSyntheticTreasuryReceipt` in `packages/e1-integration` no longer writes rows. It now calls the
real `TreasuryService` as two separate synthetic people (cashier, verifier), and the synthetic safe
itself is opened through the real service by four more (manager, counter, reconciler, approver).
All of Codex's suites run through real Treasury.

There is no competing cash model. Migration `0006_e1_treasury.sql` adds the control layer to the
Treasury tables migration 0001 already owned: `cash_locations`, `cash_location_currency_accounts`,
`physical_cash_counts`, `cash_receipts`.

## 2. Treasury services and PostgreSQL persistence

`packages/treasury` — `TreasuryService`, pure `policy.ts`, a repository port. One dependency,
`@abos/contracts`; a test asserts it cannot import Finance or name a ledger-writing function.

`packages/persistence/src/treasury-repository.ts` — `PostgresTreasuryRepository`. Every write is one
transaction that names the acting user (`abos.actor_user_account_id`), rechecks the bearer session,
sandbox gate and the specific Treasury grant with `FOR SHARE` locks
(`SandboxAuthenticator.revalidateTreasuryAuthority`, mirroring Codex's Finance recheck), then lets
0006's triggers enforce the rules on the stored rows.

| Capability | Where it is enforced |
|---|---|
| Office safes | service + `cash_locations_treasury_guard` |
| Independent USD and AFN accounts per safe | one account per currency; each has its own lifecycle `DRAFT → RECONCILED → APPROVED → ACTIVE` (or `BLOCKED`); skipping a step is refused |
| Opening reconciliation | a confirmed `OPENING` physical count, reconciled by one person, approved by another; the counter cannot approve; the reconciler cannot activate |
| Authorized cashier assignment | per safe; no self-assignment; revoke-only history; only a holder of `treasury.cash-receipt.record` can be assigned |
| Physical cash receipt | only by an assigned cashier, only into an `ACTIVE` account of an `ACTIVE` safe, only against an `ELIGIBLE` shareholder intent; amount, currency, installment and destination are taken from the intent and cannot differ |
| Cash-count evidence | a count requires `PHYSICAL_CASH_COUNT` evidence; a counted receipt requires `CASH_RECEIPT` evidence |
| Independent verification | the verifier is neither the cashier nor the counter, personally confirms the count, and the count must cover the receipt |
| Persistent Treasury receipts | one live receipt per intent; `VERIFIED` and `VOIDED` are final; identity cannot be rewritten; a void needs a stated reason |
| Handoff to Finance | `abos.treasury_finance_handoffs`; only a `VERIFIED` receipt; performs the shareholder `TREASURY_VERIFIED` transition through the shareholder domain's own service, in the same transaction |
| Complete audit history | `abos.treasury_events`, written by trigger for every Treasury insert and update, attributed to the acting user, append-only |

**An unverified receipt never reaches posting**, proved four ways: the service refuses a handoff; the
handoff table refuses a non-`VERIFIED` receipt; a shareholder intent can only claim
`TREASURY_VERIFIED` against its own verified receipt; and a capital posting intent requires a handoff.

**Treasury creates no General Ledger journal.** Nothing in 0006 or `@abos/treasury` writes
`journals`, `journal_lines`, `subledger_entries` or `ledger_accounts`. Opening a currency account
reads the cash ledger account Finance configured and refuses if there is not exactly one.

## 3. Application pages and API endpoints

Page: **`/finance/treasury`**, linked from the Finance workspace's Treasury tab. Existing Mazar Mall
shell, English/Dari, RTL via logical CSS properties, responsive to 375 px with no horizontal overflow.

| Endpoint | Purpose |
|---|---|
| `GET/POST/DELETE /api/v1/treasury/session` | who is signed in; exchange a sandbox token for an httpOnly SameSite=Strict cookie; sign out (revokes the server session) |
| `GET /api/v1/treasury/overview` | safes, USD/AFN account statuses, cashiers, shareholder intents, receipts with derived stage, evidence options |
| `POST /api/v1/treasury/receipts` | record cash received against an eligible intent |
| `GET /api/v1/treasury/receipts/{id}` | full trace to the shareholder installment, evidence, audit history |
| `POST /api/v1/treasury/receipts/{id}/{count\|submit\|verify\|void\|handoff}` | the receipt transitions |

There is **no default user and no persona picker**. Tokens come from
`pnpm --filter @abos/e1-integration sandbox:sessions`; the server rebuilds the actor from persisted
grants on every request. Unconfigured, every endpoint answers 503 and the page says so — it never
falls back to demo figures. **No balance is displayed anywhere**: Treasury keeps counts and receipts,
and a balance would be an invented figure. A handed-off receipt is labelled *Handed to Finance · not
posted* until Finance actually posts.

Local run:

```
docker run -d --name abos-e1-pg -e POSTGRES_PASSWORD=abos_sandbox -e POSTGRES_USER=abos -e POSTGRES_DB=abos_e1_sandbox -p 55432:5432 postgres:17-alpine
docker exec abos-e1-pg psql -U abos -d postgres -c "CREATE DATABASE abos_e1_dev"
cp apps/web/.env.development.example apps/web/.env.local   # fill in the ABOS_* values
pnpm --filter @abos/e1-integration sandbox:seed             # prints one token per synthetic persona
pnpm dev
```

## 4. Test results

```
pnpm test:unit                  108 pass / 0 fail   (Treasury policy 9 new)
pnpm test:integration (PG 17)    53 pass / 0 fail   (Codex's 40, all on real Treasury, + 13 Treasury)
playwright, 1 worker             29 pass / 0 fail   (incl. 7 Treasury, with ABOS_TREASURY_BROWSER_E2E=1)
pnpm test:smoke                   5 pass / 0 fail
pnpm build                        9/9
pnpm typecheck                   10/10
pnpm lint                        clean
```

PostgreSQL Treasury rejections, each at the service and — for custody rules — again as raw SQL with
the service bypassed: unassigned or unpermitted cashier; revoked assignment; blocked account; lifecycle
skip; missing or wrong-kind count evidence; duplicate live receipt (voiding releases it);
self-verification by cashier or counter; verifying before submission; count below receipt; receipt
not matching the source's installment, amount or destination; a `REJECTED` source; unverified
receipt reaching handoff, shareholder transition or posting intent; verified-but-not-handed-off
receipt reaching posting; double handoff; unattributed write; revoked session; opening
counter/reconciler/approver separation. Plus a happy path asserting every preserved identifier and
the exact seven-event audit trail.

Browser: the full cashier → independent verifier → Finance handoff in a real Chromium against the
real API and PostgreSQL, including the refused short count, the refused self-verification through the
API, session revocation on sign-out, a Finance-only user seeing no Treasury records, and Dari RTL at
phone width.

**Flakiness worth knowing about:** with Playwright's default parallel workers, several *pre-existing*
Stage 0 specs intermittently time out while `next dev` compiles routes. All 29 pass on one worker, and
the three I isolated pass alone. It predates Treasury, but it will bite CI.

## 5. Shared changes — for Codex's review

Contract `stage1-e1-treasury-v1`, additive (`packages/contracts`): `TreasuryPermission`,
`TREASURY_PERMISSIONS`, `TreasuryReceiptRecord`, `TreasuryFinanceHandoff`, `CashLocationSummary`;
`ServerActorContext.treasuryPermissions`, deliberately separate from Finance `permissions`.

Database, touching tables Codex owns — please review:

1. **`posting_intents_require_treasury_handoff`** — a `SHAREHOLDER_CAPITAL_RECEIPT` posting intent now
   requires a `treasury_finance_handoffs` row for its receipt and source. This is how "Finance consumes
   only what Treasury released" is enforced.
2. **`capital_receipt_intents_treasury_link_guard`** — `TREASURY_VERIFIED`/`POSTED` require the
   intent's own `VERIFIED` receipt. This refuses the compromised-writer case in your foreign-receipt
   test earlier than 0005 does; I kept your test and changed only where it expects the refusal.
3. **`user_permission_grants_permission_code_check`** was dropped and re-added with the Treasury codes.
4. **`sandbox-auth`**: `issueSession` now counts Treasury grants, so a Treasury-only person can sign in
   (previously refused); `authenticate` loads `treasuryPermissions`; new
   `revalidateTreasuryAuthority`. Your `revalidatePostingAuthority` is untouched.
5. **`e1-integration` seed**: accounts are now opened through the real Treasury lifecycle, so the
   seeded USD account is `ACTIVE` because it was reconciled and approved, not because a row said so.
   Seed accepts an `authConfiguration`, so the dev sandbox can run as `development`.

Not changed: the Finance kernel, `PostgresFinancePostingRepository`, migrations 0001–0005, the
runtime role from 0004.

## 6. Remaining dependencies for final Finance integration

1. **The controlled database write API (0004's open item) now blocks Treasury too.** Treasury's
   actor and runtime-marker settings are caller-settable, exactly like Finance's. The triggers are
   integrity rules, not a privilege boundary. Treasury writes, like Finance posting, currently need an
   owner connection. Treasury is a natural first user of the `SECURITY DEFINER`, `EXECUTE`-only API
   0004 describes; I have not built it because it is shared database architecture.
2. **Finance consumption of handoffs.** Nothing yet reads `treasury_finance_handoffs` as a queue in
   the application; the E2E test creates the posting intent directly. A Finance screen or endpoint
   that lists `READY_FOR_FINANCE` handoffs and creates the posting intent and approval is Codex's.
3. **Handoff status after posting.** Handoffs stay `READY_FOR_FINANCE`; "posted" is derived by
   joining to the posted source. If Finance wants a consumed state, it is a small addition to 0005's
   posting trigger — Codex's call.
4. **Evidence upload.** E1 selects from pre-registered synthetic evidence references. Real document
   capture and hashing belong to the Documents module.
5. **Durable reversal**, unchanged from the earlier handoff.

**For the Finance Manager, not engineering:** whether a physical count counts the cash received or
the whole safe (enforced as `count ≥ receipt`, true under either reading); whether one person may
both confirm a count and hand the receipt to Finance (currently allowed — the verifier does both); and
who may void a receipt (currently the receiving cashier or any Treasury verifier).

No figure in this branch represents a real AL-BERUNIY safe, cashier, shareholder or amount. The
synthetic safe's opening count is 0.00 because it is a new, empty synthetic safe.
