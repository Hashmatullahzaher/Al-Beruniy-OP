# ABOS V1 client preview — Milestone A

**Status:** a working, locally runnable client preview on synthetic data. It is **not** an operational
accounting system and has **not** been deployed online. Real financial posting stays disabled.

| | |
|---|---|
| Branch | `feat/v1-identity-admin` (to be integrated into `v1/integration`) |
| Final commit | recorded in [§C](#c-branch-and-commit) |
| Base | `v1/integration` at `3eeac37` (Codex `6243f0d` + reviewed E1 owner demo) |
| Environment | local development server + disposable PostgreSQL 17 with synthetic data |

---

## A. What genuinely works in the preview

Every item below is a real operation against PostgreSQL, covered by automated tests (§H).

**Sign-in and sessions**
- Normal username and password sign-in at `/login`, in English and Dari.
- Passwords stored only as scrypt hashes (N=32768, r=8, p=1, random salt).
- The first sign-in with an administrator-issued temporary password forces a password change. Temporary passwords expire after 72 hours.
- Employees can change their own password; doing so ends all their other sessions.
- Lockout: 5 wrong passwords in 15 minutes lock the account for 15 minutes. A locked account and an unknown username get the same answer. Per-client throttling applies when a trusted proxy supplies the address.
- Sessions last at most 60 minutes. The token exists only in an httpOnly, SameSite=Strict cookie and is never sent to page scripts. Logout revokes the session on the server.
- A suspended account, a revoked role or a changed role takes effect immediately, including inside the Treasury and Finance database functions.

**Administration (Super Administrator)**
- Admin → Users:
  - create an employee (username, name, job title, email, phone, initial status Active or Suspended, roles);
  - edit details; suspend and reactivate; assign and remove roles;
  - reset a password (a one-time temporary password is shown once);
  - sign someone out everywhere;
  - see the employee's effective permissions and which role grants each one.
- Admin → Roles & permissions:
  - create, edit, deactivate and reactivate custom roles;
  - choose permissions from a controlled, versioned catalogue (v1);
  - see who holds each role.
  - The editor distinguishes **Allowed**, **Not allowed**, **Requires independent approval** (the independence rule the system enforces) and **Unavailable in this preview**.
- Access history: an append-only audit trail of every creation, role change, permission change, suspension, password reset and forced sign-out, with the real authenticated actor and the affected person or role.
- The first Super Administrator is created by an operator-only bootstrap. It has a random temporary password and refuses to run if a Super Administrator already exists. No default passwords ship.

**Safety rules enforced on the server and in the database, not by hiding buttons**
- Only employees with administration permissions can reach the admin APIs (403 otherwise).
- Nobody can assign themselves a role, grant themselves a permission, change their own status, or change a role they hold. These rules are enforced by database constraints as well as by the server.
- Only a Super Administrator can:
  - give or take away administration access, or access carrying an independence rule (verify, approve, post, safe-account approval);
  - reset the password of anyone who holds such access.
- The last usable Super Administrator of a company cannot be removed or suspended. This is checked by the database at commit time, per company, under a lock.
- Only permissions the application implements can be put into a role or granted by the identity service.
- An account can be administered only from its own company, and only if it has no access in another company.
- The identity service runs on its own restricted database login. It has no access to Treasury, Finance or ledger tables. It can open a session only after a recorded successful sign-in, and it can only read or write access-administration audit records.

**Connected Shareholder → Treasury → Finance → General Ledger workflow (existing E1 engine, unchanged)**
- Employees who sign in with a password use the same restricted Treasury and Finance database boundaries as before. No financial check was relaxed.
- Treasury manager: gives an employee custody of a safe (new screen control over the existing Treasury service).
- Cashier: records an eligible synthetic USD shareholder capital receipt, counts it and submits it. They cannot verify it; the database refuses a direct attempt.
- Treasury verifier: independently verifies and hands the receipt to Finance.
- Finance preparer: prepares the journal. They cannot approve their own preparation; the database refuses it.
- Finance approver: independently approves and posts through the restricted Finance gateway. The balanced journal and its reconciliation are read back.
- Segregation of duties is judged by each person's actual participation in the transaction, not by role names. Someone holding both Cashier and Finance Approver roles is still refused approval of cash they recorded (tested).

**Interface**
- Navy-and-gold identity with the Mazar Mall architectural imagery.
- A signed-in V1 navigation that lists only the workspaces the person's permissions allow; the Stage 0 design previews remain listed separately as "not in V1".
- "My dashboard" with the person's work and live counts read from Treasury and Finance.
- Meaningful permission-denied screens. English and Dari with right-to-left layout; the language choice is remembered. Works at desktop, tablet and phone widths.

## B. Approved full-V1 scope that is **not** implemented yet

These remain approved and are recorded in [`../V1_DELIVERY_BACKLOG.md`](../V1_DELIVERY_BACKLOG.md) with status and dependencies.

| Capability | Status |
|---|---|
| Online server deployment | Not deployed. Preconditions in §G. |
| USD base with full AFN transaction support | USD path only. The AFN account exists but is not activated; no AFN posting. |
| Daily market/Saraf exchange rate with immutable snapshots | Not implemented |
| Per-company financial calendar (solar Hijri, Gregorian, custom); reports in either calendar | Not implemented. The synthetic open period is Gregorian. |
| User-created Chart of Accounts with duplicate warning and Finance Manager review list | Not implemented. The synthetic ledger mapping is seeded. |
| Physical safes created in the app; Saraf accounts | Safes can be seen and cashiers assigned. Creating safes and Saraf accounts is not in the UI. |
| Shareholder capital **or** loan per transaction | Capital only |
| Cash count "whole safe" mode | Only "money received" count |
| Reversal requested by Finance, approved by Finance Manager | Not implemented (catalogued as unavailable) |
| Excel opening-balance import | Not implemented. Layout pending from the owner. |
| General Ledger and financial reports | Journal and reconciliation for the posted receipt only |
| Shareholder capital-request creation in the app | Domain service only; not in the UI |
| Company legal name, registration number, go-live date | Pending from the owner; placeholders only |

Out of V1 (unchanged): banks, Sales, Construction, Procurement, HR/Payroll, AI, Telegram.

## C. Branch and commit

- Feature branch: `feat/v1-identity-admin`.
- Integrated into `v1/integration` by fast-forward, or reported as not integrated, at the final step of this delivery. The exact SHA is in the delivery report and in `git log`.

## D. Demonstration guide

### English (about 10 minutes)

The operator prepares the database and prints one-time passwords (see §G). The client never sees a token.

1. Open `/login` and sign in as **super.admin**.
2. **Roles & permissions → New role:** "Cash Receipt Officer". Allow *View Treasury*, *Record cash received* and *Count cash*. Point out that *Verify*, *Approve* and *Post* stay *Not allowed*, and that reversal shows *Unavailable in this preview*.
3. **Users → New employee:** username `r.officer`, give the new role, then **Create account**. Show the temporary password, shown once. Point out "Awaiting first sign-in" and the access list.
4. Sign out. Sign in as **demo.treasury.manager**. Go to Treasury → **Safes & accounts**, give custody of the safe to *Synthetic Receipt Officer*, then sign out.
5. Sign in as **r.officer** with the temporary password; the system requires a new password. The menu shows only *My dashboard* and *Treasury*. Opening `/admin/users` shows "You do not have access".
6. Treasury → **Shareholder intents:** enter a receipt reference, choose **Record cash received**, count **25000.00**, then submit. The verify button is not offered, and a direct request is refused by the server.
7. Sign in as **demo.verifier**: **Confirm count and verify receipt**, then **Hand verified receipt to Finance**.
8. Sign in as **demo.finance.preparer**: Finance inbox → **Prepare journal for approval**. The same person cannot approve it.
9. Sign in as **demo.finance.approver**: **Approve (independent review)**, then **Post to General Ledger**. Show the balanced journal and the reconciliation.
10. Sign in as **super.admin**: Users → *Synthetic Receipt Officer* shows their access and history. Open **Access history**, then suspend the account; their access ends immediately.
11. Switch to **دری** and narrow the window to phone width.

### دری (حدود ۱۰ دقیقه)

متصدی پایگاه داده را آماده کرده و رمزهای یک‌بار مصرف را چاپ می‌کند (بخش G). مشتری هیچ توکنی نمی‌بیند.

۱. صفحه `/login` را باز کنید و با **super.admin** وارد شوید.
۲. **نقش‌ها و صلاحیت‌ها ← نقش جدید:** «Cash Receipt Officer». *مشاهده خزانه*، *ثبت نقد دریافتی* و *شمارش نقد* را مجاز کنید. نشان دهید که *تایید*، *تصویب* و *ثبت* «غیرمجاز» می‌مانند و برگشت ژورنال «در این پیش‌نمایش موجود نیست».
۳. **کاربران ← کارمند جدید:** نام کاربری `r.officer`، نقش جدید، سپس **ایجاد حساب**. رمز موقت فقط یک بار نمایش داده می‌شود.
۴. خارج شوید. با **demo.treasury.manager** وارد شوید. در خزانه، بخش **صندوق‌ها و حساب‌ها**، صندوق را به *Synthetic Receipt Officer* بسپارید و خارج شوید.
۵. با **r.officer** و رمز موقت وارد شوید. سیستم رمز جدید می‌خواهد. منو فقط *داشبورد من* و *خزانه* را نشان می‌دهد؛ صفحه `/admin/users` پیام «دسترسی ندارید» می‌دهد.
۶. خزانه ← **درخواست‌های سهامداران:** شماره رسید را وارد کنید، **ثبت دریافت نقد**، شمارش **25000.00** و ارسال. دکمه تایید نشان داده نمی‌شود و درخواست مستقیم توسط سرور رد می‌شود.
۷. با **demo.verifier** وارد شوید: **تایید شمارش و رسید** و سپس **تحویل رسید تاییدشده به مالی**.
۸. با **demo.finance.preparer** وارد شوید: صندوق مالی ← **آماده‌سازی ژورنال برای تصویب**. همین شخص نمی‌تواند آن را تصویب کند.
۹. با **demo.finance.approver** وارد شوید: **تصویب (بررسی مستقل)** و سپس **ثبت در دفتر کل**. ژورنال متوازن و تطبیق را نشان دهید.
۱۰. با **super.admin** وارد شوید: کاربران ← *Synthetic Receipt Officer* دسترسی و تاریخچه را نشان می‌دهد. **تاریخچه دسترسی** را باز کنید و سپس حساب را معلق کنید؛ دسترسی فوراً پایان می‌یابد.
۱۱. زبان را به **دری** تغییر دهید و پنجره را به عرض تلفن کوچک کنید.

## E. Screenshots

Captured by the automated journey (`apps/web/tests/v1-client-preview.spec.ts`). The temporary password is blurred.

| File | Shows |
|---|---|
| `screenshots/01-login.png` | Login screen |
| `screenshots/02-admin-dashboard.png` | Super Administrator dashboard |
| `screenshots/03-role-editor.png` | Role and permission editor |
| `screenshots/04-user-created.png` | Employee created, one-time temporary password |
| `screenshots/05-safe-custody-assigned.png` | Treasury manager assigns the safe |
| `screenshots/06-employee-dashboard.png` | Employee sees only their permitted workspace |
| `screenshots/07-denied-admin.png` | Refused administration access |
| `screenshots/08-employee-recorded-cannot-verify.png` | Receipt recorded; self-verification refused |
| `screenshots/09-verified-and-handed-off.png` | Independent verification and handoff |
| `screenshots/10-prepared.png` | Finance preparation |
| `screenshots/11-posted-journal-reconciled.png` | Posted, balanced journal and reconciliation |
| `screenshots/12-employee-access-and-history.png` | Effective permissions and history |
| `screenshots/13-access-history.png` | Company access history |
| `screenshots/14-roles-dari-rtl.png` | Dari, right to left |
| `screenshots/15-dashboard-dari-mobile.png` | Dari at phone width |

## F. Recording

`v1-client-preview-recording.webm`: the full journey (about 45 seconds at 1440×900), recorded by the same test.

## G. Environment and access

### Local preview (supported)

Prerequisites: Docker, Node 24, pnpm, and a PostgreSQL 17 container named `abos-e1-pg` (port 55432).

1. Create three restricted logins in the **disposable** database, one per runtime. Each inherits only its own role, and each password is generated locally:

   ```sql
   CREATE ROLE abos_e1_treasury_demo_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<generate-locally>';
   CREATE ROLE abos_e1_finance_demo_login  LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<generate-locally>';
   CREATE ROLE abos_v1_identity_demo_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<generate-locally>';
   -- after migrations have run once (preview:seed runs them):
   GRANT abos_e1_treasury_runtime TO abos_e1_treasury_demo_login;
   GRANT abos_e1_runtime          TO abos_e1_finance_demo_login;
   GRANT abos_v1_identity_runtime TO abos_v1_identity_demo_login;
   ```

2. Create `apps/web/.env.local` (git-ignored) from `apps/web/.env.development.example`:
   - `ABOS_DATABASE_URL`: operator credential;
   - `ABOS_TREASURY_DATABASE_URL`, `ABOS_FINANCE_DATABASE_URL`, `ABOS_IDENTITY_DATABASE_URL`: the three logins above;
   - `ABOS_ENVIRONMENT=development`, a locally generated `ABOS_SANDBOX_RUNTIME_MARKER`, a locally generated 32+ character `ABOS_SANDBOX_SIGNING_SECRET`, and `ABOS_SANDBOX_MAX_SESSION_SECONDS=3600`.
   - Leave `ABOS_ALLOW_DEV_TOKEN_SIGNIN` unset for a client showing. It is only for the automated browser tests.

3. Reset and seed the disposable database. The script refuses database names without `dev`, `sandbox` or `preview`. It prints each person's username and a one-time password; they are not stored anywhere.

   ```bash
   pnpm --filter @abos/e1-integration preview:seed
   ```

4. Start the app and open <http://localhost:3200/login>:

   ```bash
   pnpm --filter @abos/web exec next dev --port 3200
   ```

To replay the whole journey automatically (it reseeds the database and needs the dev server stopped):

```bash
cd apps/web && ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-client-preview --workers=1
```

### Online preview (not deployed)

No online preview exists. Before one is published, **all** of these must be true and the owner must approve the destination and audience:
1. A separate deployment security review has passed. This includes the SECURITY DEFINER function-ownership blocker being resolved or explicitly accepted for synthetic-only use.
2. HTTPS only, behind a reverse proxy that sets `X-Forwarded-For`, and `ABOS_TRUST_PROXY=1` so per-client throttling uses the real address. The proxy also rate-limits `/api/v1/auth/*`.
3. A production build (`next build`) is used, so developer token sign-in cannot be enabled, and `ABOS_ALLOW_DEV_TOKEN_SIGNIN` is unset.
4. Four distinct database logins exist (operator, Treasury, Finance, identity). The operator credential is never on the web server; the sandbox gate stays `SYNTHETIC_TEST_ONLY` with `real_posting_enabled = false`.
5. Only synthetic data is present: no real names, credentials, balances or opening positions.
6. Secrets are generated per environment and held in the host's secret store. Logs do not record request bodies. There is a retention period for `login_attempts` and audit data.
7. The Stage 0 design-preview pages, which are static demonstrations, are clearly labelled "not in V1" (already the case), or hidden.

## H. Automated test results

Run on the final commit of this delivery (§C), against local PostgreSQL 17 with synthetic data only.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm lint` | pass, 0 warnings |
| `pnpm typecheck` | 11/11 tasks |
| `pnpm test:unit` | 113 pass, 0 fail |
| `pnpm build` | 10/10 tasks |
| `pnpm test:integration` (PostgreSQL) | 85 pass, 0 fail, 0 skipped (72 existing E1 + 13 new identity) |
| `pnpm test:smoke` | 5 pass |
| Playwright, `--workers=1`, gates `ABOS_TREASURY_BROWSER_E2E`, `ABOS_FINANCE_BROWSER_E2E`, `ABOS_OWNER_DEMO`, `ABOS_V1_PREVIEW_E2E` | 34 pass, 0 fail, 0 skipped, 0 blocked |

New browser coverage in `v1-client-preview.spec.ts`:
- Super Admin creates a role and a user, and assigns access.
- The employee signs in and must change their password.
- The employee sees only authorised workspaces.
- Direct unauthorised API calls are denied.
- Self-verification and self-approval are refused.
- Journal and reconciliation are shown.
- Suspension works.
- Dari/RTL persists and works at mobile width.

## I. Security and accounting-policy limitations

Two independent read-only security reviews were run:
- **First review:** of the identity backend (15 findings). The four must-fix items and most others were fixed.
- **Second review:** of the web layer and those fixes (13 findings, none Critical). Its verdict is that this is **acceptable for a local, client-supervised synthetic preview** and **not yet acceptable for online deployment**. Fixed from the second review:
  - the login open redirect (D-04);
  - the lockout race (D-06);
  - database-stamped attempt times (D-01 hardening);
  - scrypt outside transactions for password resets (D-08);
  - security headers (D-09);
  - origin and JSON checks on every mutation (D-10);
  - generic configuration errors (D-11);
  - trusted-proxy-only client addresses (D-05);
  - a connection-pool deadlock found while testing (now covered by a regression test).

Still open:
- **D-01 / D-02.** The database guards stop application bugs, not a compromised identity credential. The database does not yet derive the administrator from the session for grants.
- **D-03.** One Super Administrator can create several accounts, receive their first passwords, and act as each. Segregation of duties is by account, so it cannot stop one person holding many accounts.
- **D-07.** Anyone who knows a username, for example `super.admin`, can keep that account locked. Online previews need proxy-level access restriction and a break-glass procedure.
- **D-12 / D-13.** Minor.

- **Release blocker (unchanged):** the Treasury and Finance SECURITY DEFINER functions (migrations 0007–0009) are owned by the migration identity. Production posting stays blocked until this is redesigned and independently approved. The new identity work adds no SECURITY DEFINER function.
- **Account takeover by a Super Administrator:** a Super Administrator receives temporary passwords and could therefore sign in as someone else. The preview limits this to Super Administrators. Production needs out-of-band credential delivery (a one-time link or in-person), dual control for sensitive resets, and notification of the affected person.
- **Single-factor sign-in:** there is no multi-factor authentication, identity provider or password-reset-by-email yet.
- **Session length:** sessions are capped at 60 minutes by the existing E1 design and there is no refresh; people sign in again.
- **Throttling:** per-client throttling depends on a trusted proxy (§G). Without one, only per-account lockout applies.
- **Synthetic sandbox gate:** sign-in issues sessions only while the database carries an unexpired synthetic-only authorization. This is by design for the preview.
- **Accounting:** the posted journal uses a seeded synthetic ledger mapping and period. Chart of Accounts, calendars, FX policy, reversal and opening balances need Finance Manager approval before any real use. The software is not IFRS-certified or legally approved.
- **Carried from the E1 review:** the Finance trace returns user ids rather than names (shown as "Person A/B/C"), and amounts in the trace arrive as JSON numbers. Both are SQL fixes for the Finance functions.

## J. Next development sequence (Milestone B)

1. Resolve the SECURITY DEFINER ownership blocker. Give each runtime a dedicated non-owner function owner with least privilege, and have it independently reviewed.
2. Production identity:
   - out-of-band credential delivery;
   - multi-factor authentication for administrators and approvers;
   - a password-reset flow;
   - session refresh;
   - retention for `login_attempts`.
3. Company configuration:
   - legal-entity settings (placeholders until the owner provides them);
   - financial calendar engine (solar Hijri, Gregorian, custom) and period close.
4. Chart of Accounts management: user-created accounts, duplicate warnings, a Finance Manager review list, and safes and Saraf accounts as accounts.
5. Currency: daily Saraf/market rate entry with immutable snapshots; AFN posting.
6. Shareholder: capital or loan per transaction; capital-request creation in the app.
7. Cash count "whole safe" mode.
8. Reversal: requested by Finance, approved by the Finance Manager; posted history stays immutable.
9. Excel opening-balance import, once the layout is received.
10. General Ledger views and the relevant financial reports in both calendars.
11. Deployment hardening and a restricted online preview (§G), after the security review.

## K. Client-preview acceptance matrix

| Feature | Implemented | Tested | Demonstrated | Blocked / limitation |
|---|---|---|---|---|
| Normal sign-in, hashed passwords | Yes | Yes (PG + browser) | Yes | No MFA |
| Forced first password change; temporary-password expiry | Yes | Yes | Yes | — |
| Lockout and throttling | Yes | Yes (PG) | No | Per-client needs a trusted proxy |
| Logout, expired, suspended and revoked sessions | Yes | Yes | Yes (suspension) | 60-minute sessions, no refresh |
| Super Admin creates employee | Yes | Yes | Yes | — |
| Custom roles from the controlled catalogue | Yes | Yes | Yes | Catalogue changes only by migration |
| Assign and revoke roles; effective permissions | Yes | Yes | Yes | — |
| Suspend and reactivate; sign out everywhere | Yes | Yes | Yes | — |
| Admin APIs denied to ordinary employees | Yes | Yes (PG + browser) | Yes | — |
| No self-escalation (DB + server) | Yes | Yes | Explained | — |
| Last Super Administrator protected | Yes | Yes (PG) | No | — |
| First-admin bootstrap | Yes | Yes (PG) | Via seed | Operator-only CLI |
| Immutable access audit trail | Yes | Yes | Yes | Admin actions only; E1 events keep their own trail |
| Cross-company isolation | Yes | Yes (PG) | No | The preview has one company |
| Cashier records; cannot verify own receipt | Yes (existing E1) | Yes | Yes | — |
| Independent Treasury verification and handoff | Yes (existing E1) | Yes | Yes | — |
| Finance preparation; no self-approval | Yes (existing E1) | Yes | Yes | — |
| Multi-role self-approval refused | Yes (existing E1 rule) | Yes (PG) | Explained | — |
| Independent approval and restricted posting | Yes (existing E1) | Yes | Yes | Synthetic only; production posting blocked (SECURITY DEFINER) |
| Journal and reconciliation read-back | Yes | Yes | Yes | Totals only (no journal lines) |
| Duplicate financial requests (idempotency) | Yes (existing E1) | Yes (PG) | No | — |
| Posted journals immutable | Yes (existing E1) | Yes (existing suites) | No | — |
| Role-based navigation, dashboard | Yes | Yes (browser) | Yes | — |
| English/Dari, RTL, remembered language | Yes | Yes (browser) | Yes | Data names are synthetic English |
| Desktop, tablet, mobile | Yes | Yes (browser) | Yes | — |
| Online preview | No | — | — | Not deployed; §G preconditions |
| Items in §B | No | — | — | Planned for Milestone B |
