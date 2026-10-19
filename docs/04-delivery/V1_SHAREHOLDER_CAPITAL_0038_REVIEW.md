# Shareholder Capital activation — 0038 review checkpoint

Date: 2026-10-19. Status: **IMPLEMENTED AND TESTED — FINAL REVIEW REQUIRED; NOT DEPLOYED**.

Repository: `Hashmatullahzaher/Al-Beruniy-OP`.
Branch: `codex/v1-capital-activation-0038`.
Accepted base: `a3fa673b08ea8c2a81f992cc6e0c08269969bd90`.
Accepted preparation `f2e82b2d92ff4cfd0b5db12a4182d3405c24b371` was reapplied as
`f80945f127ff334a1b6170ab67fbeffaaa5e668a` on that base.
The final pushed commit containing this report is identified in the delivery response.
This report supersedes the preparation report's implementation blockers; production configuration
and deployment remain separate owner-authorized steps.

## 1. Migration and scope

Exactly one new migration: `0038_v1_shareholder_capital_activation.sql`.

Canonical SHA-256 (the migration runner normalizes CRLF to LF):

`7b86dd4aa0ded7450d7c8d34f78bc569903c3b2079e9a61edc88462f0bfb995d`

Migrations 0001–0037 are unchanged. Required preserved checksums:

- 0036: `669c8afb6938d135800d6c96c74110038c21dded2312f2055517f2a736493a3d`
- 0037: `b6b9de5be6807cb1c7952da13a58cf7a158d457c379eb1b61eaf8460cf49f285`

No Income implementation or reversal expansion. No business configuration is seeded.
The separate holographic application and original architectural image are unchanged.

## 2. Evidence design

`shareholder_capital_evidence_registrations` is an append-only Capital-specific metadata table.
Allowed kinds are exactly CAPITAL_ACCOUNT_MAPPING, CASH_RECEIPT, PHYSICAL_CASH_COUNT,
BANK_CONFIRMATION, SARAF_CONFIRMATION, CONTROLLED_EVIDENCE and FINANCE_APPROVAL.

`register_shareholder_capital_evidence(text,text,text,jsonb)` derives actor, legal entity and time
from the live PASSWORD_OPERATIONAL context. It generates evidence/document UUIDs. The caller supplies
only a permitted kind, the appropriate subject, document reference, SHA-256 and command identifiers.
Unknown actor/entity/ID/completion-time fields are refused. No file bytes are sent or stored by this
facility: the browser hashes the selected local file automatically, with a 20 MB local hashing limit.
The existing private agreement-upload facility remains separate and unchanged.

| Purpose | Required permission | Runtime | Immutable subject |
| --- | --- | --- | --- |
| Mapping | finance.capital-receipt.configure | Finance | Mapping authorization; no caller subject ID |
| Optional receipt | shareholder.capital-receipt.record | Treasury | Exact contribution |
| Custody kinds | treasury.capital-receipt.verify | Treasury | Exact receipt; recorder excluded |
| Finance decision | finance.capital-receipt.approve | Finance | Exact capital intent; recorder/verifier/preparer excluded |

The new `abos_v1_capital_evidence_owner` is NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS,
NOCREATEROLE, NOCREATEDB and NOREPLICATION, without role memberships. It has only the precise
evidence inserts, registration reads/inserts, source-column reads and existing identity/idempotency/audit
helper executions needed. It gains no financial-table writes. Runtimes receive EXECUTE only;
PUBLIC EXECUTE and runtime registration-table access are revoked.

Entity-qualified foreign keys and insertion guards require exact purpose, subject and registering actor.
Unique indexes prevent evidence reuse across mapping versions, receipts, custody records and capital
approval bindings. Idempotency is actor/entity/operation scoped; replay rechecks live authority.
All evidence, audit/outbox and idempotency facts are atomic. Client registration retry keys persist
across a parent-command retry so an interrupted response cannot silently replace its evidence ID.
A matching fingerprint never establishes physical custody, signatures, registration or legal validity.

## 3. Receipt dates and protected flow

- `receipt_date >= contribution.business_date`; earlier dates fail in both command and insert guard.
- The contribution remains DECLARED with its original date, version and source fingerprint.
- Accounting effective date must equal actual receipt date; the open period must cover that date.
- Existing unreceived-amount limits and same/base-currency restrictions remain enforced.
- Receipt, custody and preparation create no GL. Independent approval precedes explicit posting.
- Recorder cannot verify custody. Finance approver cannot be recorder, verifier or preparer.
  The same independent approver must explicitly post.
- Legacy E1 sandbox boundaries, Operational Expense and 0037 Temporary Funding dispatch remain intact.

## 4. Mapping preflight and operator UI

The accepted mapping-preflight correction is retained: installed schema is sufficient to reach
configuration even while capability is NOT_OPERATIONAL. Configuration reads and mapping evidence
use that gate. Receipt/custody/prepare/decision/post, and their operational evidence registration,
retain the full operational route gate. Database authority remains independently enforced.

The real `/shareholders` page now supports:

- Capital mapping setup with an approved account picker, document reference and local fingerprint.
- Contribution-specific actual receipt amount/date, Treasury destination and optional receipt evidence.
- Custody VERIFY/REJECT, required evidence and rejection reason, with explicit terminal states.
- Finance prepare, approve/reject with evidence/reason, and explicit post by the approver.
- Trace with receipt date, recorder/verifier/preparer/approver, timestamps/reasons, evidence references
  and hashes, policy/mapping versions, Dr/Cr accounts, journal ID and posting state.
- English/Dari, RTL, keyboard-labelled controls and desktop/tablet layouts.

Capital navigation recognizes the new permissions. The minimum Capital read permission now reads the
setup/contribution projection without shareholder master-data mutation permission. Private agreement
file access is still separately restricted: the server does not fetch protected file descriptors for
a Capital-only reader. Declaration receipt wording no longer asserts that its stale master-data flag
is the operational receipt/posting status.

## 5. Accounting proof

The disposable PostgreSQL scenario uses a later actual receipt date and the exact current schema:

1. DECLARED CASH contribution; no financial posting from declaration.
2. Actual receipt into the selected ACTIVE Safe; no GL.
3. Independent custody verification; no GL.
4. Finance preparation, independent approval, explicit posting.
5. Exactly one capital posting intent, one capital journal, two balanced lines and two subledgers:
   **Dr Safe ASSET/CASH / Cr paid-in SHAREHOLDER_CAPITAL EQUITY**.
6. Exact shareholder capital linkage and exact operational Safe increase.
7. Normal Operational Expense from the **same** Safe/ledger:
   **Dr Expense / Cr Safe**, with no shareholder-capital subledger effect.
8. No duplicate posting or change to the declaration. Audit/outbox and trace remain source-bound.

PostgreSQL proof: USD 25,000 receipt minus USD 125.50 expense = USD 24,874.50 Safe movement.
Authenticated browser proof: USD 50,000 receipt minus USD 125.50 expense = USD 49,874.50.
All these amounts and people are disposable synthetic fixtures, never company records.

## 6. Validation

| Check | Result |
| --- | --- |
| Lint | Passed, zero warnings |
| Strict typecheck | 12/12 packages passed |
| Unit, including Finance | 163 passed; 0 failed; 0 skipped |
| Full real PostgreSQL/integration suite | 218 passed; 0 failed; 0 skipped; 27 suites |
| Final focused Capital upgrade/security suite | 19 passed; 0 failed; 0 skipped |
| Fresh 0001 → 0038 | Current complete migration runner exercised throughout PostgreSQL suites |
| Exact 0037 → 0038 upgrade | Normal current runner applies only 0038; repeated run is a no-op |
| SECURITY DEFINER inventory | All 100 entry points accounted for; no privileged/login owner or PUBLIC EXECUTE |
| 0037 Temporary Funding | PostgreSQL regression and authenticated browser record/approve/partial-settlement passed |
| Operational Expense / legacy E1 / identity / Treasury / GL | Full PostgreSQL regressions passed |
| Production build | 11/11 tasks passed |
| General serial browser suite | 42 passed; 0 failed; 20 existing environment-gated skips |
| Dedicated authenticated Capital + Temporary Funding browser suite | 2 passed; 0 failed; 0 skipped |
| Smoke | All 9 general smoke tests plus authenticated Capital smoke passed |
| Responsive/RTL | Authenticated Capital desktop and 1024px Dari tablet passed; no horizontal page overflow |
| Independent SQL security review | No verified defects; review against the exact 0038 checksum above |

The general suite uses its existing memory-review server for its appropriate fixtures. The separate
authenticated suite explicitly disables review mode, never reuses an arbitrary server and exercises
real password logins, restricted credentials and database functions. **No 0038 Capital browser test
is skipped.** The general suite's 20 older conditional cases are disclosed, not reported as passes;
its Temporary Funding case is additionally executed successfully in the dedicated suite.

Only disposable container `abos-shareholder-finance-0036-pg` at 127.0.0.1:55442 was used for database
tests. The browser runner refuses other containers/ports and uses only
`abos_capital_browser_preview_0038`; application ports are isolated 3190 and 3189.
Generated reports, traces, credentials and screenshots are ignored test artifacts, not committed.

## 7. Zero-backfill and production boundary

The upgrade test reconstructs the accepted 0037 registry with populated synthetic master data,
fingerprints every pre-existing application table, then invokes the normal migration runner.
All pre-existing row counts/fingerprints and migration checksums match. Only 0038 migration metadata
and new schema/security objects appear. The new evidence-registration table is empty. Re-running
the migration runner creates nothing else.

0038 creates no receipt, custody decision, mapping, journal, intent, subledger, operational Treasury
account, Equity account, accounting period, policy version, user role assignment or permission grant.
No production database, vault, credential, runtime or startup configuration was changed or deployed.
No merge was performed. Income status remains **NOT IMPLEMENTED**.

## 8. Remaining production owner choices

After final review and separate deployment authorization:

1. Accounting owner selects the paid-in-capital ledger's real code/name. It must be ACTIVE,
   postable USD EQUITY/SHAREHOLDER_CAPITAL with no mandatory dimensions; migration supplies no code.
2. Owner confirms the actual Safe/custodian and operational account details, and confirms whether the
   existing approved `C-01` Cash ledger is the intended mapping. Do not invent an opening position or
   automatically activate the legacy DRAFT cash-location currency account.
3. Authorized owner appends SHAREHOLDER_CAPITAL_RECEIPT approval-required=true policy. Other policies,
   including normal expense approval OFF, remain separately configured.
4. Accounting owner chooses the correct calendar/open period and actual cash receipt date.
5. Security administrator assigns named independent scoped recorder, verifier, preparer and
   approver/poster users. Operators need shareholder.capital-receipt.read plus their action permission.
6. Owner provides genuine mapping/custody/approval references/files and selects exactly one real
   DECLARED contribution for the controlled first transaction. Validate actual cash facts first.

Existing controlled Chart of Accounts, operational Treasury setup, calendar/period-opening,
workflow-policy and Identity/Admin mechanisms remain the configuration paths. Their database
regressions pass through 0038. No owner choices above were executed in the real environment.

Before deployment: fresh private PostgreSQL/roles backup, separate vault backup and test restore,
current fingerprints, exact SHA/checksum verification and the existing guarded startup procedure
remain mandatory. Do not deploy the earlier preparation SHA. No real transaction is authorized here.

## 9. Full changed-file list relative to accepted 0037

- apps/web/package.json
- apps/web/playwright.config.ts
- apps/web/playwright.capital.config.ts
- apps/web/src/app/api/v1/finance/shareholder-capital-mapping/route.ts
- apps/web/src/app/api/v1/finance/shareholder-capital-configuration/route.ts
- apps/web/src/app/api/v1/shareholder/capital-evidence/route.ts
- apps/web/src/app/globals.css
- apps/web/src/components/AppShell.tsx
- apps/web/src/components/ShareholderCapitalBridge.tsx
- apps/web/src/components/ShareholderContributionsView.tsx
- apps/web/src/components/ShareholderSetupWorkspace.tsx
- apps/web/src/server/shareholder-finance-bridge.ts
- apps/web/src/server/shareholder-setup.ts
- apps/web/tests/v1-shareholder-capital-activation.spec.ts
- docs/04-delivery/V1_SHAREHOLDER_CAPITAL_ACTIVATION_PREPARATION.md (accepted preparation)
- docs/04-delivery/V1_SHAREHOLDER_CAPITAL_0038_REVIEW.md
- infrastructure/database/migrations/0038_v1_shareholder_capital_activation.sql
- packages/contracts/src/shareholder-finance-bridge.ts
- packages/contracts/src/shareholder-setup.ts
- packages/database/src/migrations.ts
- packages/e1-integration/package.json
- packages/e1-integration/scripts/capital-activation-preview.ts
- packages/e1-integration/scripts/capital-browser-bootstrap.ts
- packages/e1-integration/scripts/run-capital-browser.ps1
- packages/e1-integration/src/security-ownership.test.ts
- packages/e1-integration/src/shareholder-finance-bridge-schema-gated.test.ts
- packages/sandbox-auth/src/authenticator.ts
