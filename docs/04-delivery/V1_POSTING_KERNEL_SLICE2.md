# Slice 2 — posting kernel and source registry (migrations 0043 and 0044)

Status: IMPLEMENTED and validated on disposable databases only. 0043 merged to `v1/main` at
`d335846`; 0044 on branch `claude/slice2-kernel-writer`. **Neither is deployed**; production
deployment needs separate owner authorization. Design: `docs/03-architecture/POSTING_KERNEL.md`.

## 1. What changed

| Migration | Change | Data |
|---|---|---|
| 0043 `v1_posting_kernel` | Lock-only registry `abos.posting_sources` (4 ACTIVE, the 0036 bridge FROZEN, 6 PLANNED). One kernel trigger enforces draft-before-post, posted immutability and the shared invariants once, then dispatches by static `CASE` to four small source validators. Three validators that each re-implemented the shared rules are dropped. | adds the 11 registry rows; no existing row changes |
| 0044 `v1_posting_kernel_writer` | `posting_kernel_draft` / `posting_kernel_commit` write and post the intent, draft journal, lines and subledger movements from a typed description. The expense writer and the direct capital writer are restated verbatim except for their posting block. | none |

Binding rules kept: one kernel, one registry, small per-source validators, static dispatch, no
dynamic SQL, no copied giant validator, no E1 or 0036-bridge repointing. The kernel functions run
with their caller's rights, refuse every caller except the operational Finance owner, and are
executable by nobody else. Idempotency, row locks, period rules, entity isolation, immutable posted
journals and exact decimals stay exactly where they were.

## 2. Byte-equivalent accounting output

`posting-kernel-equivalence.test.ts` runs one scenario twice: on a database built through 0043 (each
writer's own posting block) and on the full catalogue (kernel writer). It compares every row of the
13 tables either writer touches and every call outcome, after replacing generated ids, hashes and
clock timestamps by their order of appearance.

The scenario covers:

- direct-posting and approval-route expenses, with a replay, a payee, and amounts of 0.01 and
  1000.000001;
- an expense on an unopened month, which is refused;
- a new shareholder with an agreed total;
- cash capital allocated to that declaration, with a replay;
- hawala capital beyond the declaration;
- asset capital that moves no Safe, and a bill a shareholder paid;
- capital that opens a PENDING month exactly once;
- capital outside the calendar and capital in a foreign currency, both refused.

Result: 8 postings, 16 lines, 11 subledger movements, 15 audit records and 8 outbox events,
identical in both databases. A deliberate mutation of the kernel (not advancing the intent version)
made the test fail, so the comparison has teeth.

## 3. Validation (disposable databases only)

| Check | Result |
|---|---|
| Posting kernel suite (registry, privileges, static arms, fault injection for every shared invariant and for source-only rules, draft-before-post, posted immutability, PLANNED and unregistered sources) | 5/5 |
| Equivalence suite, plus the kernel-only privilege and no-dynamic-SQL checks | 2/2 |
| Full integration, fresh database, through 0043 | 268/268 |
| Full integration, fresh database, through 0044 | 270/270 |
| Unit / typecheck / lint / build | 169/169; 12/12; clean; 11/11 tasks |
| Upgrade of the restored production copy at 0042 → 0043 | only 0043 applied; rerun a no-op; 88/89 tables byte-identical (registry +1) plus the new 11-row source table; 0 journals |
| Upgrade 0043 → 0044 of the same copy | only 0044 applied; rerun a no-op; 89/90 tables byte-identical (registry +1); both writers keep owner, security, `search_path` and grants |

Browser: Slice 2 changes no page and no API contract. The equivalence suite compares the API call
results themselves. The real-database browser spec for direct capital was not rerun because its
setup script writes disposable credentials under the Desktop worktree, which the standing security
constraint forbids. The mocked browser specs do not reach the database.

## 4. Not in Slice 2

- Temporary funding and settlement keep their own writers (validated by the kernel since 0043). They
  can move to the kernel with the same equivalence proof.
- Subledger sign conventions still differ between sources. They are recorded for the Slice 3
  balance read models, which must normalise by side.
- D3-F2 (six lanes still reading `current_date`) remains open in `OPEN_ITEMS.md`.
