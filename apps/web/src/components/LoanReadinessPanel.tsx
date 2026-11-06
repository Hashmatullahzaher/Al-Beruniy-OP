"use client";

import { loanReadinessGaps, type LoanAccountControl, type LoanAccountStatus, type LoanReadiness, type LoanReadinessRole } from "@abos/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";
import { permissionLabel } from "@/lib/access-copy";

/**
 * What loans still need, said plainly, with a way to fix each item. It sets nothing up itself: an account is saved through the Chart of
 * Accounts and a permission through Roles & permissions, by a person who can see what they are doing.
 */

const ACCOUNT_COPY: Readonly<Record<LoanAccountControl, { name: [string, string]; needed: [string, string] }>> = {
  SHAREHOLDER_LOAN: { name: ["Shareholder Loan Payable", "قرض پرداختنی سهامدار"], needed: ["Needed to record a shareholder loan.", "برای ثبت قرض سهامدار لازم است."] },
  LOAN_PAYABLE: { name: ["Other Loan Payable", "قرض پرداختنی دیگر"], needed: ["Needed to record a loan from anyone else.", "برای ثبت قرض از دیگران لازم است."] },
  REALIZED_FX_GAIN: { name: ["Realized FX Gain", "مفاد تحقق‌یافتهٔ تبادله اسعار"], needed: ["Needed only when a foreign-currency loan is repaid at a better rate.", "تنها وقتی لازم است که قرض ارزی به نرخ بهتر بازپرداخت شود."] },
  REALIZED_FX_LOSS: { name: ["Realized FX Loss", "ضرر تحقق‌یافتهٔ تبادله اسعار"], needed: ["Needed only when a foreign-currency loan is repaid at a worse rate.", "تنها وقتی لازم است که قرض ارزی به نرخ بدتر بازپرداخت شود."] }
};
const STATUS_COPY: Readonly<Record<Exclude<LoanAccountStatus, "READY">, [string, string]>> = {
  MISSING: ["Not created yet.", "هنوز ساخته نشده است."],
  AMBIGUOUS: ["Several active accounts have this role. Keep one.", "چند حساب فعال این نقش را دارند. یکی را نگه دارید."],
  INVALID: ["This account must take postings in the accounting currency, without dimensions.", "این حساب باید به واحد پول حسابداری و بدون ابعاد ثبت بپذیرد."]
};

export function LoanReadinessPanel({ fa }: Readonly<{ fa: boolean }>) {
  const [readiness, setReadiness] = useState<LoanReadiness | null>(null);
  const [roles, setRoles] = useState<readonly LoanReadinessRole[] | null>(null);
  useEffect(() => {
    let current = true;
    void api<LoanReadiness>("/api/v1/finance/loans/readiness").then(async (result) => {
      if (!current || !result.ok) return;
      if (result.data.canManageRoles) {
        const listed = await api<readonly LoanReadinessRole[]>("/api/v1/admin/roles");
        if (current && listed.ok) setRoles(listed.data);
      }
      if (current) setReadiness(result.data);
    });
    return () => { current = false; };
  }, []);
  if (readiness === null) return null;
  const gaps = loanReadinessGaps(readiness, roles);
  if (gaps.accounts.length === 0 && gaps.permissions.length === 0) return null;
  const pick = (copy: readonly [string, string]) => copy[fa ? 1 : 0];
  return (
    <section className="module-content-card" aria-label={fa ? "آنچه قرض‌ها هنوز لازم دارند" : "What loans still need"}>
      <h2>{fa ? "آنچه قرض‌ها هنوز لازم دارند" : "What loans still need"}</h2>
      <ul className="period-pending">
        {gaps.accounts.map((account) => {
          const copy = ACCOUNT_COPY[account.control];
          return <li key={account.control}><strong>{pick(copy.name)}</strong> {pick(STATUS_COPY[account.status as Exclude<LoanAccountStatus, "READY">])} <span className="admin-hint">{pick(copy.needed)}</span>{" "}
            {readiness.canManageAccounts
              ? <Link href={account.status === "MISSING" ? `/finance/accounts?new=${account.control}` : "/finance/accounts"}>{account.status === "MISSING" ? (fa ? "ساختن حساب" : "Create the account") : (fa ? "جدول حساب‌ها" : "Chart of Accounts")}</Link>
              : <span className="admin-hint">{fa ? "از مسئول جدول حساب‌ها بخواهید." : "Ask whoever manages the Chart of Accounts."}</span>}</li>;
        })}
        {gaps.permissions.length > 0 ? <li>
          <strong>{roles !== null ? (fa ? "هیچ کس این صلاحیت‌ها را ندارد:" : "Nobody holds these permissions:") : (fa ? "شما این صلاحیت‌ها را ندارید:" : "You do not hold these permissions:")}</strong>{" "}
          {gaps.permissions.map((code) => permissionLabel(code, fa ? "fa" : "en")).join(fa ? "، " : ", ")}.{" "}
          {readiness.canManageRoles ? <Link href="/admin/roles">{fa ? "نقش‌ها و صلاحیت‌ها" : "Roles & permissions"}</Link> : <span className="admin-hint">{fa ? "از مدیر سیستم بخواهید." : "Ask an administrator."}</span>}</li> : null}
      </ul>
    </section>
  );
}
