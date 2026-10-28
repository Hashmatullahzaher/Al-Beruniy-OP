# V1 maximum delivery session — 2026-10-27

Running record of the extended delivery session (owner mandate of 2026-10-27). One entry per
completed slice; updated as work lands. Production (localhost:3200, database `abos_v1_local_review`)
stays at trunk `0aa6512` / migration 0040 throughout unless an entry says otherwise.

## Slice 1 D3 — retire the synthetic lane (migration 0041)

- Branch: `claude/d3-retire-e1` (base `0aa651250b2fdec98811195ec103c43f2d5020a1`).
- Trunk SHA after merge: `769941c512cd732969e3e1d66152c2052f0238f2` (pushed).
- Migration: `0041_v1_retire_synthetic_lane` — checksum
  `e49aa6bd788f7253c29b0a1c6abd3ac10744895ee343d5732a042f6f171dbaa6`.
- Source changes, tests, review findings and fixes: see
  `docs/04-delivery/V1_RETIRE_SYNTHETIC_LANE_0041.md`.
- Deployment status: authorized and DEPLOYED 2026-10-27 (see the next entry).
- Validation: integration 260/260 (fresh DB) + explicit 104/104; unit 169/169; typecheck 12/12; lint clean;
  build 11/11; browser 65 passed / 2 skipped / 0 failed; smoke 8/8; upgraded production-shaped copy proven.
- Review findings fixed on the way: empty 0038 live-workflow row; stale specs since 0039/0040; dead
  developer-token flag. Finding D3-F1 (UTC day in shareholder setup) deferred to migration 0042.
- Blockers: none.
- Next: migration 0042 (business day), then Slice 2 (posting kernel + source registry) on top of trunk, independent of the 0041
  deployment.

## Slice 1 D3 — 0041 production deployment (Authorization A)

- Deployed SHA `769941c512cd732969e3e1d66152c2052f0238f2`; migration `0041_v1_retire_synthetic_lane`,
  checksum `e49aa6bd788f7253c29b0a1c6abd3ac10744895ee343d5732a042f6f171dbaa6`, applied through the
  guarded helper after a dry run on production and a full rehearsal on a restored copy.
- Private package `AlBeruniyOS/backups/deployment-0041-20261027-132016` (ACL STC + SYSTEM; 61 files
  in SHA256SUMS, verified). Pre-0041 dump sha256
  `d510ba6fd079e7f6519b15a23bff886128677f57c9a0366e116d39cecc61ad4a`; test restore 88/88 tables
  identical; rehearsal 87/88 unchanged (+ registry 39→40, + register 12 rows); production identical
  to the rehearsal except the two apply timestamps.
- Zero business-data change: 87/88 pre-existing tables identical; business counts, the 48-row
  catalogue, all 81 grants (22 on retired codes) and all role permissions identical before and after.
- Frozen lane: 14/14 entry points refused for each of the three production runtime logins with
  SQLSTATE 42501 (42 probes, read-only rolled-back transactions); holder role has no members.
- Runtime and startup guard repinned to 769941c; health reports 769941c.
- Route retirement on production: `/finance/treasury`, `/finance/handoffs` and the eight retired
  API routes resolve to the not-found page exactly like an unknown path and never answer as an API;
  the operational pages render; operational APIs answer 401 without a session; the kept custody
  route answers as an API; sign-in methods report `developerTokens: false`.
- Browser on production: first runs right after restart failed on first-compile timeouts
  (reproduced: `/api/v1/company/dashboard` 32.9 s first, then 0.09 s); warm serial reruns
  @smoke 6/6 and mocked direct capital + shell + foundation 22/22.
- Signed-in flows verified on a byte-identical copy of post-deployment production (89/89 tables)
  at the same commit, never with the owner's account: sign-in, current user, role and user
  administration, dashboard, navigation (no retired entry), `/shareholders/legacy` (all 3 real
  shareholders and the agreement shown; controls only Add shareholder / Edit / Cancel contribution /
  Add contribution / Correct / New capital agreement / Upload another version / Edit draft / Add
  installment; no empty row; no retired API called), direct capital, expense, daily report, GL,
  calendar, rates, temporary funding, Finance setup.
- No real financial transaction was created: production after all checks is byte-identical to the
  moment after the migration; 0 journals; 12 periods PENDING; vault reconciliation CLEAN.
- Rollback: pre-0041 dump + vault snapshot + prior startup script; procedure in
  `ROLLBACK_READINESS.txt` (not executed).

## Migration 0042 — shareholder setup on the Kabul business day

- Branch `claude/0042-shareholder-business-day` (base 769941c). Checksum: see the registry.
- Eight functions restated (the approved seven plus the profile role trigger, which blocks the same
  flow); one grant. Details: `docs/04-delivery/V1_SHAREHOLDER_BUSINESS_DAY_0042.md`.
- Follow-up finding D3-F2 (six other lanes) recorded in `OPEN_ITEMS.md`.

## Slice 2 part 1 — migration 0043, posting kernel validation and source registry

- Branch `claude/slice2-posting-kernel` (base `a6a2c51`). Design: `docs/03-architecture/POSTING_KERNEL.md`.
- `abos.posting_sources`: 11 lock-only rows (4 ACTIVE, the 0036 bridge FROZEN, 6 PLANNED); read only by
  the operational Finance owner.
- One kernel trigger replaces three validators that each re-implemented the shared invariants; four
  small source validators reached by a static `CASE`; no dynamic SQL; the bridge trigger and E1 untouched.
  Writers unchanged, so posted output is unchanged by construction.
- Tests: new `posting-kernel.test.ts` (registry, privileges, static arms, fault injection into real
  postings for every shared invariant and for source-only rules, draft-before-post, posted immutability,
  PLANNED and unregistered sources) 5/5; full integration on a fresh database 268/268; unit, typecheck,
  lint clean.
- Upgrade of the restored production copy at 0042: exactly 0043 applied, rerun a no-op, 88/89 tables
  byte-identical (only the migration registry +1) plus the new 11-row registry. Not deployed.
- Merged to `v1/main` at `d335846`.

## Slice 2 part 2 — migration 0044, posting kernel writer

- Branch `claude/slice2-kernel-writer` (base `d335846`). Report: `docs/04-delivery/V1_POSTING_KERNEL_SLICE2.md`.
- `posting_kernel_draft` / `posting_kernel_commit` (caller's rights, operational Finance owner only) write
  and post the intent, draft journal, lines and subledgers; expense and direct capital writers restated
  verbatim except for their posting block. Temporary funding, the 0036 bridge and E1 untouched.
- Byte-equivalent output proven by running one scenario (expenses on both routes, replays, exact
  decimals, all four capital methods, declaration allocation, pending-month opening, refusals) on a 0043
  database and on the full catalogue: every touched row and every call outcome identical; a deliberate
  kernel mutation is caught.
- Full integration on a fresh database 270/270; unit 169/169; typecheck 12/12; lint clean; build 11/11.
  Production-shaped copy 0043→0044: 89/90 tables byte-identical (registry +1); writers keep owner,
  security, `search_path` and grants. Not deployed.

## Production deployment 0042 → 0043 → 0044 (owner authorization of 2026-10-27)

- Deployed trunk SHA `7ae43630f2a84f04593b1e5806945b1f954e8c6e`; applied one migration at a time, each from
  the trunk commit whose catalog ends at it (a6a2c51, d335846, 7ae4363), through guarded helpers that pin
  the predecessor and checksums and refuse a missing, extra, future or altered migration (refusals proven
  on disposable copies). Checksums: 0042 `e9fbb93c…8a50`, 0043 `57da48ca…3155`, 0044 `d21e3445…dfbc2`.
- Private package `AlBeruniyOS/backups/deployment-0042-0044-20261027-165730` (ACL STC + SYSTEM; 108 files
  sealed). Pre-0042 dump sha256 `a2ea8a6752325531f98fe6ad2b4c558014e1ad3b06410c9d82341daaff82d5f6`; test
  restore 89/89 identical; full rehearsal on the restored copy ended identical to a fresh install of
  7ae4363 (510 catalog entries).
- Each step verified on production before the next and identical to the rehearsal: 0042 changed only the
  migration registry, eight function bodies (date expression only) and one grant; 0043 added the 11-row
  registry, kernel and four validators and replaced three validators (bridge untouched); 0044 changed two
  writer bodies and added the two kernel functions. Business counts, grants, roles, 0 journals and 12
  PENDING periods unchanged throughout; vault reconciliation CLEAN.
- Runtime and startup guard repinned to 7ae4363; health reports it; route checks, live-safe smoke 6/6 and
  mocked browser 22/22 green. No real transaction was created.
- On a restored copy of post-0044 production: signed-in direct capital and expense posted through the
  kernel with the reviewed shape; kernel, equivalence and posting suites 77/77 at the deployed SHA.
- Test-harness debt TH-1 recorded in `OPEN_ITEMS.md`.

## Slice 3 — one Safe model, opening balances and real balances (0045, 0046)

- Branch `claude/slice3-safes` (base `b5a8f2e`). Design `docs/03-architecture/SAFE_BALANCES.md`; report
  `docs/04-delivery/V1_SAFES_SLICE3.md`.
- 0045: one subledger sign convention (debit +, credit -) enforced by the kernel; temporary-funding payable
  re-signed (writers, validators, workspace); one internal balance read model used by the daily report and
  temporary funding, so a Safe balance never depends on the reader's scope.
- 0046: OPENING_BALANCE source through the kernel (Dr Safe, Cr opening balance equity resolved to exactly
  one account), one immutable opening balance per Safe, lifecycle ACTIVE/INACTIVE/CLOSED, optional
  responsible people, permissions `treasury.safe.read` and `treasury.opening-balance.record`, read-only
  legacy link view; Safes page in English and Dari.
- Validation: full integration 282/282 on a fresh database; unit 169/169; typecheck, lint, build; browser
  Safes 7/7 plus relevant suites 29 passed (6 fixture-gated skips); smoke 9/9; real-database browser check
  with credentials outside the source tree; restored post-0044 production copy upgraded with only the
  intended changes. Not deployed.
- Merged to `v1/main` at `bce4369`. Final adversarial review afterwards: no exploitable defect; the
  opening-balance validator now re-checks that the Safe is ACTIVE like every other source validator (0046
  amended before any preserved deployment, checksum `5176103a…`); new regression test for a close during an
  in-flight capital receipt; full integration 283/283; production-shaped upgrade still only the intended
  changes; no table-wide write grant added. Report section 4 of `V1_SAFES_SLICE3.md`. Not deployed.

## Production deployment 0045 → 0046 (owner authorization of 2026-10-27)

- Deployed trunk SHA `6380c16471d51dc451113acdbcd1209e225cd781`; 0045 applied from `787128c` (its catalog ends at
  0045; ancestor of trunk), 0046 from `6380c16`, each through a guarded helper pinning predecessor and checksums
  (refusals of wrong predecessor, missing, future, altered and mismatched states proven on copies). Checksums:
  0045 `3bbc150b…466e`, 0046 `5176103a…62e0`.
- Package `AlBeruniyOS/backups/deployment-0045-0046-20261027-211406` (114 files sealed). Pre-0045 dump sha256
  `31e9983896f558c2c2cedfeef6f2e9944b287fa15d2c625574187812a1492b35`; test restore 90/90 identical; rehearsal on
  the restored copy identical to production at each step and to a fresh install of 6380c16 except three older
  constraints (below).
- After 0045: only the migration registry changed among tables; business data, journals, periods, the Safe and
  the legacy tables unchanged; no runtime write; read model executable only by the operational Finance owner.
- After 0046: the two new tables exist and are empty; OPENING_BALANCE ACTIVE; OPENING_BALANCE_EQUITY control
  and CLOSED status present; exactly `treasury.safe.read` and `treasury.opening-balance.record` added; the Finance
  runtime gained EXECUTE on exactly the three entry points; nothing for PUBLIC; table-wide grant list unchanged;
  Safe کسه book balance 0 with no movements; opening equity MISSING; 0 journals; 12 periods PENDING.
- Runtime and startup guard repinned to 6380c16; health ok; route checks green (Safes page renders, its API
  refuses without a session); smoke 7/7 and browser 29/29 after warm rerun (cold-compile timeouts first);
  vault reconciliation CLEAN. No real financial transaction and no opening balance were created.

## Slice 4 — receive cash, transfer and pay (0047, 0048)

- Branch `claude/slice4-money` (base `4ee3e24`).
- Design: `docs/03-architecture/MONEY_MOVEMENTS.md`. Report: `docs/04-delivery/V1_MONEY_MOVEMENTS_SLICE4.md`.
- 0047 adds three kernel sources:
  - CASH_RECEIPT: Dr Safe/Saraf, Cr income;
  - TREASURY_TRANSFER: Dr destination, Cr source, with both Treasury movements;
  - PAYMENT: Dr payable, Cr Safe/Saraf; the kind is SUPPLIER, CONTRACTOR, SALARY or OTHER.
- 0047 also adds:
  - one immutable source table per source;
  - permissions `treasury.receipt.record`, `treasury.transfer.record` and `treasury.payment.record`;
  - refusal when an approval setting is unsaved or requires approval;
  - base currency only.
- 0048: paying an expense stays in the expense lane with a payment kind that chooses its approval setting (salary → SALARY_PAYMENT, supplier/contractor → SUPPLIER_PAYMENT, other → EXPENSE).
- The Safes page offers Receive cash, Transfer and Pay; each saves once.
- Owner questions recorded in `OPEN_ITEMS.md`: negative balances, an approval flow for these movements, and attachments.
- Validation is in report section 3. The adversarial review fixed four issues (report section 3a):
  - accounts payable now requires a supplier;
  - the expense JSON is unchanged without a kind;
  - two refusal mappings;
  - dimension-free expense types on Pay.
- The real-database check also found a late-save UI race, now fixed.
- Not deployed.

## Slice 4 corrections — 0049 (owner decisions of 2026-10-28)

- Branch `claude/slice4-corrections` (base `742028a`); report section 7 of `V1_MONEY_MOVEMENTS_SLICE4.md`.
- **Cash-like accounts.** SAFE, CASH_BOX and PETTY_CASH never go below zero.
  - Checked in the posting kernel's journal trigger, under `FOR NO KEY UPDATE` on the Treasury account, from posted movements.
  - Covers every lane and is backdate-proof.
  - SARAF may go negative.
- **Simple Mode.** A missing approval setting means OFF.
  - The record's policy reference is then NULL; nothing is seeded.
  - An explicit OFF posts and an explicit ON is never bypassed.
  - EXPENSE OR the payment kind's setting governs an expense.
- **Approval switches.** ON is unavailable for OTHER_INCOME, TREASURY_TRANSFER, SUPPLIER_PAYMENT, SALARY_PAYMENT and CUSTOMER_RECEIPT.
- **Not done here:** AFN inflows are a missing Slice 6 capability; attachments are deferred to the document vault.
- **Validation:**
  - targeted 94/94;
  - full integration 300/300 (test PostgreSQL raised to 1 GB after repeated OOM at 512 MB);
  - unit 169/169; typecheck, lint, build;
  - browser 67 passed; smoke 10/10;
  - real-database browser check, including a refused overdraft;
  - production-shaped upgrade (Step A from `742028a`: 0047+0048; Step B: 0049) with zero journals and no backfill.
- Not deployed.

