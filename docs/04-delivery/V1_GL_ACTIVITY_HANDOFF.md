# V1 #19 (part) — General Ledger account activity and paging: handoff

Agent C, Phase 2. Base: `v1/integration` at `f0bb7183`. Migration `0024_v1_general_ledger_activity.sql`.
This extends #19 with the two parts that need no owner or Finance Manager policy. It is still not a
balance, trial balance or financial statement.

## What exists

| Part | Implementation |
|---|---|
| Account activity for a range | `abos.finance_general_ledger_activity(token, from, to, account?)`: one row per ledger account **and base currency**, with debit total, credit total, net (debit − credit) and line count as exact decimal text. Original-currency amounts of the same lines are grouped per original currency inside each row. Per-base-currency totals (`currencyTotals`) are also returned. The response states `basis = POSTED_ACTIVITY_IN_RANGE`, `isBalance = false`, `openingBalancesIncluded = false`. |
| Paging beyond 100 lines | `abos.finance_general_ledger_page(token, from, to, account?, cursor?, pageSize = 100)`: deterministic keyset paging in exactly the 0020 order (accounting date DESC, posted at DESC, journal id DESC, line number ASC). `nextCursor` is an opaque URL-safe position of the last returned row, or null at the end; `pageSize` is 1–100. The first page (no cursor) also returns the per-currency totals of the whole range; later pages return `totals: null`. |
| Visibility | Both use one internal helper, `abos.finance_gl_visible_lines`, which holds the 0020 predicates unchanged: legal entity from the token, POSTED only, date range, optional account, and the conjunctive, live project / department / cost-center scope filter. The helper is SECURITY INVOKER, owned by `abos_e1_finance_owner`, pinned `search_path`, and executable by no runtime and not by PUBLIC. |
| Ownership | Both entry points: SECURITY DEFINER, owned by `abos_e1_finance_owner`, `search_path = pg_catalog, pg_temp`, `REVOKE ALL FROM PUBLIC`, EXECUTE only to `abos_e1_runtime`, authorized by `finance.report.operational.read`. No new permission, table, grant or role. 0020 is unchanged (same signature and behaviour); the new pager is a separate function, not an overload, so existing 4-argument calls stay unambiguous. |
| Cursor safety | The cursor is only a position. Every page is re-filtered by the entity and scope predicates, so a tampered, foreign or another user's cursor can only move the start point within the caller's own visible lines. A cursor that does not decode to exactly `{v:1, d, p, j, l}` with valid types is refused with SQLSTATE 22023 and one generic message. |
| API | `GET /api/v1/finance/general-ledger?from&to[&accountId][&cursor][&pageSize]` now pages through the new function (response keeps the 0020 fields plus `order` and `nextCursor`). `GET /api/v1/finance/general-ledger/activity?from&to[&accountId]` returns the summary. Strict validation (ISO dates, from ≤ to, UUID account, cursor `[A-Za-z0-9_-]{1,400}`, pageSize 1–100; paging parameters are refused on the summary); 42501 → 401/403 as before; 22023 → 422 `VALIDATION_FAILED`. |
| UI | `/finance/general-ledger`: new "Account activity in the selected range" section, grouped by base currency, labelled "Posted activity in the selected range — not a balance; opening balances are not yet imported." (Dari: «فعالیت ثبت‌شده در بازهٔ انتخاب‌شده — مانده نیست؛ مانده‌های افتتاحیه هنوز وارد نشده‌اند.»). "Load more lines" follows `nextCursor` for the filters on screen and replaces the old "narrow the range" dead end; a status line shows "Showing n of N lines" / "All n lines shown". English and Dari, RTL, phone width; dates via `formatDual`; amounts are formatted from strings only. Switching language no longer re-fetches (and so no longer drops loaded pages). CSS: one block "WP #19 GL activity" in `globals.css`. |

## Tests

- `packages/e1-integration/src/general-ledger-activity.test.ts` (6 tests): catalogue/ownership of the two entry points and the helper; exact decimals beyond float precision (for example `12345678901234567890.123456789000000001`); USD and AFN never combined, even on one account; DRAFT and out-of-range journals excluded; range and account filters; project/department/cost-center scope hidden until all live grants exist and hidden again on revocation (summary, totals and every page); second-entity isolation both ways; account filter outside the entity refused (42501); invalid, forged and empty tokens; a user without the report permission; revoked permission; Treasury and identity runtimes denied; no runtime can call the helper; 154 lines with tied dates and posted-at instants returned exactly once in the documented order for page sizes 1, 7 and 100, first page identical to 0020, a newer posting between pages does not shift or repeat lines; page-size bounds; tampered, foreign, other-user and out-of-range cursors, and 14 malformed cursors.
- `security-ownership.test.ts`: definer count 34 → 36 and the function→owner map.
- `apps/web/tests/v1-gl-reporting.spec.ts` (mocked API, 5 tests): summary wording, grouping by currency and exact formatting; Load more with the cursor and the applied filters, 100 → 103 lines; a refused cursor keeps the lines shown; Dari/RTL; phone width without horizontal overflow; denied access shows neither lines nor the summary.

Test fixtures insert synthetic POSTED journals through the migration-owner connection with `session_replication_role = replica` (read-model data only, as the existing ownership suite does). The posting path is not changed.

## Still blocked (unchanged policy boundary)

| Item | Why | Decision needed |
|---|---|---|
| Trial balance, account balances, opening/closing positions | No opening balances (#18 waits for the owner's Excel layout) | Owner: the opening-balance Excel layout |
| Official figures by period (period-end, closed periods) | No period can be opened or closed in the app | Finance Manager: accounting-period authority (open, soft-close, close, reopen, second approver) |
| Any combined or converted figure across USD and AFN | Conversion, rounding and gain/loss policy are open | Finance Manager: FX posting and rounding policy |
| Statutory/financial statements | Depend on all of the above plus statutory rules | Owner / Finance Manager |

## Proposed wording for the lead (not applied here)

**V1_DELIVERY_BACKLOG.md, #19 row:** "**Partial** (0020, 0024) — Done: read-only posted-activity view (date range, account filter, both calendars, exact decimals, legal-entity and project/department/cost-center scope), per-account posted activity by base currency for a range (explicitly not a balance), and keyset paging through every line (Load more). Open: trial balance and account balances by period (need opening balances #18 and period authority for official figures)."

**OPEN_ITEMS.md:** no new item. Optionally add under the period-authority decision: "Until decided, General Ledger reports show posted activity in a range only; no balance, trial balance or statement is produced (0024)."
