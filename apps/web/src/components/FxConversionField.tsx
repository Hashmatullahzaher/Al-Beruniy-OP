"use client";

import type { FxPreview } from "@abos/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";
import { money } from "@/components/OperationalFinanceShared";

const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export type FxChoice = { readonly exchangeRateId: string | null; readonly ready: boolean };

/**
 * For a movement in a currency other than the accounting currency (0051): the day's rates, the rate chosen when there
 * are several, and the accounting amount the database will post. The database converts; this only shows it first.
 */
export function FxConversionField({ currency, baseCurrency, date, amount, fa, onChange }: Readonly<{
  currency: string; baseCurrency: string | null; date: string; amount: string; fa: boolean; onChange: (choice: FxChoice) => void;
}>) {
  const foreign = baseCurrency !== null && currency !== baseCurrency;
  const [preview, setPreview] = useState<FxPreview | null>(null);
  const [rate, setRate] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!foreign || date === "") return;
    let current = true;
    const query = new URLSearchParams({ currencyCode: currency, businessDate: date });
    if (AMOUNT.test(amount.trim()) && /[1-9]/.test(amount)) query.set("amount", amount.trim());
    if (rate !== "") query.set("exchangeRateId", rate);
    const timer = setTimeout(() => {
      void api<FxPreview>(`/api/v1/finance/fx-preview?${query.toString()}`).then((result) => {
        if (!current) return;
        if (result.ok) { setPreview(result.data); setFailed(null); } else { setPreview(null); setFailed(result.error.message); }
      });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [foreign, currency, date, amount, rate]);

  const rates = preview?.rates ?? [];
  const chosen = rate !== "" && rates.some((item) => item.id === rate) ? rate : null;
  const result = preview?.preview && "base" in preview.preview ? preview.preview : null;
  const refusal = preview?.preview && "error" in preview.preview ? preview.preview.error : null;
  const ready = !foreign || (preview?.setup?.status === "READY" && rates.length > 0 && (rates.length === 1 || chosen !== null) && refusal === null);

  useEffect(() => { onChange({ exchangeRateId: foreign ? chosen : null, ready }); }, [foreign, chosen, ready, onChange]);

  if (!foreign) return null;
  const describe = (item: FxPreview["rates"][number]) => `${item.source === "SARAF" ? (item.sarafName ?? (fa ? "صراف" : "Saraf")) : (fa ? "بازار" : "Market")}`
    + ` · 1 ${item.unitCurrency} = ${item.rate} ${item.quoteCurrency}`;

  return (
    <div className="wide fx-conversion" role="group" aria-label={fa ? "نرخ و مبلغ در دفاتر" : "Rate and amount in the books"}>
      {failed ? <p className="treasury-message error" role="alert">{failed}</p> : null}
      {preview?.setup?.status === "SETUP_REQUIRED" ? (
        <p className="admin-hint expense-warning" role="note">{fa
          ? "ثبت به اسعار خارجی هنوز تنظیم نشده است: یک حساب عاید یا مصرف با کنترل «تفاوت تبادله اسعار» در "
          : "Foreign-currency posting is not set up yet: create an income or expense account with the control “FX difference” in the "}
          <Link href="/finance/accounts">{fa ? "جدول حساب‌ها" : "Chart of Accounts"}</Link>{fa ? " بسازید یا " : ", or name one in the "}
          <Link href="/finance/fx-policy">{fa ? "پالیسی اسعار" : "FX policy"}</Link>{fa ? " تعیین کنید." : "."}</p>
      ) : null}
      {preview && preview.setup?.status === "READY" && rates.length === 0 ? (
        <p className="admin-hint expense-warning" role="note">{fa ? `برای ${date} نرخ ${currency} ثبت نشده است. ابتدا آن را در ` : `No ${currency} rate is recorded for ${date}. Record it in `}
          <Link href="/finance/exchange-rates">{fa ? "نرخ اسعار" : "Exchange rates"}</Link>{fa ? " ثبت کنید." : " first."}</p>
      ) : null}
      {rates.length > 1 ? (
        <label><span>{fa ? "نرخ این روز *" : "Rate for this day *"}</span>
          <select value={rate} required onChange={(event) => setRate(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {rates.map((item) => <option key={item.id} value={item.id}>{describe(item)}</option>)}
          </select></label>
      ) : rates.length === 1 && rates[0] ? <p className="admin-hint" dir="auto">{fa ? "نرخ: " : "Rate: "}<span dir="ltr">{describe(rates[0])}</span></p> : null}
      {result && preview?.setup?.policy ? (
        <p className="admin-hint" role="status">{fa ? "در دفاتر ثبت می‌شود: " : "Recorded in the books as "}
          <strong dir="ltr">{money(result.base, preview.baseCurrency)}</strong>
          {fa ? ` (گرد ${preview.setup.policy.roundingMode === "HALF_UP" ? "نیم به بالا" : "فقط دقیق"}، ${preview.setup.policy.baseScale} رقم اعشار)`
            : ` (${preview.setup.policy.roundingMode === "HALF_UP" ? "rounded half up" : "exact only"}, ${preview.setup.policy.baseScale} decimal places)`}</p>
      ) : null}
      {refusal ? <p className="treasury-message error" role="alert">{refusal}</p> : null}
    </div>
  );
}
