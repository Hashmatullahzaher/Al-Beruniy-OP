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
