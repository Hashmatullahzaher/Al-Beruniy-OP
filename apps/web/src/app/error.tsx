"use client";

import { StatePanel } from "@abos/ui";

import { useLocale } from "@/components/LocaleProvider";

export default function GlobalError({ reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  const fa = useLocale().locale === "fa";
  return (
    <StatePanel kind="error" title={fa ? "این صفحه نمایش داده نشد" : "The workspace could not be displayed"}
      description={fa ? "هیچ معامله‌ای ثبت نشد. صفحه را دوباره باز کنید، و اگر مشکل ادامه یافت با پشتیبانی تماس بگیرید." : "No transaction was submitted. Retry the screen or contact support if the problem persists."}>
      <button className="secondary-button" type="button" onClick={reset}>{fa ? "دوباره کوشش کنید" : "Try again"}</button>
    </StatePanel>
  );
}
