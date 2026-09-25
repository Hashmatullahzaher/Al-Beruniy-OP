# E1 owner demonstration — Treasury to General Ledger

Branch `agent/claude/stage-1-e1-owner-demo`, based on Codex integration commit `6243f0d`.
Synthetic data only. Development sandbox only. Production posting remains blocked.

The demonstration uses the real Shareholder, Treasury, Finance and General Ledger services and the
restricted PostgreSQL functions from migrations 0008 and 0009 (corrected checksum
`424cdc47…`). No result, balance or journal on screen is mocked: each is read back from PostgreSQL
after the step that produced it.

- `screenshots/` — one capture per step, taken by the automated run (`01`–`12`).
- `e1-owner-demo-recording.webm` — the full run as a video (about 50 s, 1440×900).
- `apps/web/tests/e1-owner-demo.spec.ts` — the same demonstration as a repeatable browser test.

> **Sign-in is a development stand-in.** The "sandbox token" each person pastes is a synthetic
> test credential for this sandbox. It is not the intended employee login system and must not be
> presented as one.

## 1. Local access

Prerequisites: Docker Desktop running, Node 24, pnpm, a checkout of this branch.

1. Start the disposable PostgreSQL container:

   ```bash
   docker start abos-e1-pg
   ```

2. Create the two restricted demo logins once. They inherit only the restricted Treasury and
   Finance roles, as `packages/persistence/TREASURY_RUNTIME_DATABASE_ROLE.md` requires:

   ```sql
   -- psql -h 127.0.0.1 -p 55432 -U abos -d abos_e1_dev
   CREATE ROLE abos_e1_treasury_demo_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<choose-a-local-treasury-password>';
   CREATE ROLE abos_e1_finance_demo_login  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<choose-a-local-finance-password>';
   GRANT abos_e1_treasury_runtime TO abos_e1_treasury_demo_login;
   GRANT abos_e1_runtime          TO abos_e1_finance_demo_login;
   ```

3. `apps/web/.env.local` (git-ignored, never commit):

   Every `<…>` value must be generated locally for this sandbox and never reused on any server.

   ```
   ABOS_DATABASE_URL=postgres://abos:<local-admin-password>@127.0.0.1:55432/abos_e1_dev
   ABOS_TREASURY_DATABASE_URL=postgres://abos_e1_treasury_demo_login:<local-treasury-password>@127.0.0.1:55432/abos_e1_dev
   ABOS_FINANCE_DATABASE_URL=postgres://abos_e1_finance_demo_login:<local-finance-password>@127.0.0.1:55432/abos_e1_dev
   ABOS_ENVIRONMENT=development
   ABOS_SANDBOX_RUNTIME_MARKER=<generate-a-local-marker>
   ABOS_SANDBOX_SIGNING_SECRET=<generate-32+-random-chars>
   ABOS_SANDBOX_MAX_SESSION_SECONDS=3600
   ```

4. Reset and seed the disposable dev database. This erases `abos_e1_dev`, and the script refuses
   any database whose name lacks `dev` or `sandbox`. It prints one token per synthetic person;
   tokens expire after one hour and stop working once that person signs out.

   ```bash
   pnpm --filter @abos/e1-integration sandbox:seed
   ```

5. Start the web app and open <http://localhost:3200/finance/treasury>:

   ```bash
   pnpm --filter @abos/web exec next dev --port 3200
   ```

To replay the whole demonstration automatically (it reseeds the dev database itself, and the dev
server on port 3200 must be stopped first):

```bash
cd apps/web && ABOS_OWNER_DEMO=1 pnpm exec playwright test e1-owner-demo --workers=1
```

## 2. Presenter walkthrough (English)

| # | Who signs in | Where | What to do | What the screen proves |
|---|---|---|---|---|
| 1 | Synthetic Cashier | Treasury → *Shareholder intents* | Show the synthetic capital agreement and its installments | The source is a real shareholder agreement row |
| 2 | 〃 | 〃 | Pick the eligible **USD** installment | Only eligible installments can receive cash |
| 3 | 〃 | 〃 | Type a receipt reference, **Record cash received** | Cash lands in the active safe's USD account — stage **Recorded** |
| 4 | 〃 | Receipt detail | Enter the counted amount, **Record physical count**, then **Submit for independent verification** | The count and its evidence are stored; the cashier is told they cannot verify their own cash |
| 5 | Synthetic Count Confirmer | Treasury → receipt | **Confirm count and verify receipt** | A different person verified — stage **Verified** |
| 6 | 〃 | 〃 | **Hand verified receipt to Finance** | Stage **Handed to Finance**; Treasury never posts |
| 7 | Synthetic Intent Creator | Finance → *Treasury handoffs* (`/finance/handoffs`) | Open the receipt | Five-step progress bar, source, safe, count, evidence "On file ✓", reconciliation "Not posted yet" |
| 8 | 〃 | 〃 | **Prepare journal for approval** | The approve button does not appear for the preparer |
| 9 | Synthetic Finance Approver | 〃 | **Approve (independent review)** | Stage **Approved**; the preparer shows as another person, the approver as "You" |
| 10 | 〃 | 〃 | **Post to General Ledger** | Stage **Posted** through the restricted Finance gateway; the button disappears |
| 11 | 〃 | 〃 | Scroll to *Journal* and *Reconciliation*. Switch to **دری** to show RTL | Debit = credit = verified cash; installment, receipt and ledger all reconcile |

Sign out between people with **Sign out**. Signing out revokes that token, so seed again (step 4
of *Local access*) to repeat the demonstration.

## 3. راهنمای گام‌به‌گام به دری

> توجه: «توکن آزمایشی» فقط برای این محیط توسعه است و روش ورود کارمندان به سیستم واقعی نیست. همه داده‌ها مصنوعی هستند.

۱. **صندوقدار آزمایشی** با توکن خود در صفحه «خزانه» وارد شود و زبانه «درخواست‌های سهامداران» را باز کند. قرارداد سرمایه مصنوعی و اقساط آن دیده می‌شود.
۲. قسط **دالری (USD)** که آماده دریافت است را انتخاب کنید.
۳. شماره رسید را بنویسید و «ثبت دریافت نقد» را بزنید. پول در حساب دالری صندوق فعال ثبت می‌شود — مرحله **ثبت شد**.
۴. مبلغ شمرده‌شده را وارد کرده «ثبت شمارش فزیکی» و سپس «ارسال برای تایید مستقل» را بزنید. سیستم نشان می‌دهد که صندوقدار نمی‌تواند پول خودش را تایید کند. سپس «خروج».
۵. **تاییدکننده شمارش** (شخص دیگر) وارد شود، رسید را باز کند و «تایید شمارش و رسید» را بزند — مرحله **تایید شد**.
۶. «تحویل رسید تاییدشده به مالی» را بزنید — مرحله **به مالی تحویل شد**. خزانه هیچ‌گاه در دفتر ثبت نمی‌کند. سپس «خروج».
۷. **آماده‌کننده مالی** به صفحه «تحویل‌های خزانه به مالی» برود، وارد شود و رسید را باز کند. نوار پنج‌مرحله‌ای، منبع پول، صندوق، شمارش، اسناد («موجود است ✓») و تطبیق («هنوز ثبت نشده») دیده می‌شود.
۸. «آماده‌سازی ژورنال برای تصویب» را بزنید. دکمه تصویب برای همین شخص ظاهر نمی‌شود. سپس «خروج».
۹. **تصویب‌کننده مالی** (شخص دیگر) وارد شود و «تصویب (بررسی مستقل)» را بزند — مرحله **تصویب شد**.
۱۰. «ثبت در دفتر کل» را بزنید. ثبت از طریق دروازه محدود مالی انجام می‌شود — مرحله **در دفتر ثبت شد** — و دکمه ناپدید می‌شود.
۱۱. بخش «ژورنال» و «تطبیق» را نشان دهید: بدهکار برابر بستانکار و برابر نقد تاییدشده است؛ قسط سهامدار، رسید خزانه و دفتر کل همه ثبت‌شده و متوازن هستند.

## 4. Results on this branch

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm build` | pass (9/9) |
| `pnpm test:unit` | 108 pass, 0 fail |
| `pnpm test:integration` (serial PostgreSQL, `abos_e1_sandbox`) | 72 pass, 0 fail |
| `pnpm test:smoke` | 5 pass |
| Playwright, `--workers=1`, Treasury + Finance real-DB gates on | 32 pass, 1 skipped (the owner demo, which is gated separately) |
| `ABOS_OWNER_DEMO=1` owner demonstration | 1 pass — all 11 steps, Dari/RTL and 390 px mobile |

Dev database check before reset: `abos_e1_dev` contained only synthetic records (one "Synthetic
Legal Entity", users all `@synthetic.invalid`) and had migrations only up to 0007. It had no 0009
record, so no stale checksum was present. It was reset and reseeded by `sandbox:seed` and now
records 0008 `b5082ff4…` and 0009 `424cdc47…`.

## 5. Defects found

| ID | Where | Defect | Status |
|---|---|---|---|
| D-1 | Finance handoffs page | No sign-out. The preparer could not hand over to the approver without going back to the Treasury page | Fixed on this branch (same revoking `DELETE /api/v1/treasury/session`) |
| D-2 | Finance handoffs page | **Post approved journal** stayed visible after posting, because the posting intent keeps status `APPROVED` | Fixed in the UI (`!trace.journal`). The database posting guard was not changed |
| D-3 | `finance_handoff_trace` (0009) | Rows are serialised with `to_jsonb`, so `source.amount` and `physicalCount.counted_amount` arrive as JSON numbers, not exact decimal text (`25000.00` → `25000`). The typed mapping treated them as strings and the new formatter crashed | Worked around in `server/finance-handoff.ts` (`decimalText`). **SQL fix is Codex's**: cast to `::text` |
| D-4 | `finance_handoff_trace` / `finance_handoff_workspace` (0009) | No person names are returned: actor, counter, confirmer, verifier, handoff, preparer and approver arrive as user ids. The shareholder name is also missing from the inbox list. The previous UI printed raw UUIDs | UI now shows "You" / "Person A, B, C…" per receipt and explains why. **SQL fix is Codex's**: return display names |
| D-5 | Finance handoffs page | English-only labels, raw codes (`TREASURY_VERIFIED`, `NOT_POSTED`, permission keys), internal ids and a generic success message | Fixed: Dari translations, plain-language stages, evidence shown as "On file ✓" |
| D-6 | Treasury trace | Raw source status code and full document id/SHA-256 shown as evidence | Fixed: status in words; the evidence detail is folded under "On file ✓" and still available |
| D-7 | Finance trace | The restricted trace returns journal totals only, not journal lines or accounts | Open for Codex. The demo shows totals, the balance check and the reconciliation |
| D-8 | Finance handoffs page | The success message stayed in its original language after switching language | Fixed |

## 6. Known limitations

- Sign-in uses synthetic development tokens. There is no production identity provider.
- A Finance prepare/approve/post still uses the first open accounting period and the handoff id
  as idempotency key, exactly as Codex's workspace did. Period choice is a Finance policy decision
  and was not invented here.
- Chart-of-accounts mapping, reversal, voiding, AFN/FX, count coverage and who may hand off
  remain Finance Manager policy decisions and are not demonstrated.
- The SECURITY DEFINER functions are still owned by the migration identity (Codex's open
  blocker), so production posting stays blocked.
