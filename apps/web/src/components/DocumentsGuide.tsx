"use client";

import Link from "next/link";

import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

/**
 * Where documents live. The Document Vault has no list of its own: every document belongs to a record and is opened from it, and the record's
 * own permission decides who may see it. This page only points the way; it reads and opens nothing.
 */

const PLACES = [
  { href: "/admin/company", en: "Company", fa: "شرکت", whatEn: "Registration papers, licences and other company records.", whatFa: "اسناد ثبت، جوازها و سایر اسناد شرکت.",
    whoEn: "People who manage company details.", whoFa: "کسانی که مشخصات شرکت را مدیریت می‌کنند." },
  { href: "/shareholders", en: "Shareholders", fa: "سهامداران", whatEn: "Each shareholder's documents, including the documents of their capital agreements.",
    whatFa: "اسناد هر سهامدار، با اسناد قراردادهای سرمایهٔ او.", whoEn: "People who may see or set up shareholders.", whoFa: "کسانی که می‌توانند سهامداران را ببینند یا تنظیم کنند." },
  { href: "/shareholders/legacy", en: "Capital agreements", fa: "قراردادهای سرمایه", whatEn: "Signed agreement files. A cleared file becomes the agreement's evidence.",
    whatFa: "فایل‌های امضاشدهٔ قرارداد. فایلی که از بررسی بگذرد، مدرک قرارداد می‌شود.", whoEn: "People who may see or set up shareholders.", whoFa: "کسانی که می‌توانند سهامداران را ببینند یا تنظیم کنند." },
  { href: "/finance/loans", en: "Loans", fa: "قرض‌ها", whatEn: "Loan notes and repayment papers, on each loan.", whatFa: "سند قرض و اسناد بازپرداخت، روی هر قرض.",
    whoEn: "People who may read or record loans.", whoFa: "کسانی که می‌توانند قرض‌ها را ببینند یا ثبت کنند." },
  { href: "/finance/transactions", en: "Expenses", fa: "مصارف", whatEn: "Bills and receipts, on each expense.", whatFa: "بل‌ها و رسیدها، روی هر مصرف.",
    whoEn: "People who may read expenses, within their own scope.", whoFa: "کسانی که می‌توانند مصارف را ببینند، در حدود خود." },
  { href: "/finance/safe-statement", en: "Receipts and payments", fa: "دریافت‌ها و پرداخت‌ها", whatEn: "On the journal of each receipt or payment, opened from a Safe statement.",
    whatFa: "روی ژورنال هر دریافت یا پرداخت، که از صورت‌حساب صندوق باز می‌شود.", whoEn: "People who may read Safes.", whoFa: "کسانی که می‌توانند صندوق‌ها را ببینند." }
] as const;

export function DocumentsGuide() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  return (
    <div className="module-workspace">
      <StageZeroPageHeader icon="documents" eyebrow={{ en: "Company", fa: "شرکت" }} title={{ en: "Documents", fa: "اسناد" }}
        description={{ en: "Every document belongs to a record and is opened from it. You see only the records your permissions open.",
          fa: "هر سند به یک رکورد تعلق دارد و از همان‌جا باز می‌شود. شما فقط رکوردهایی را می‌بینید که صلاحیت‌تان باز می‌کند." }} />
      <section className="module-content-card" aria-label={fa ? "جای اسناد" : "Where documents are kept"}>
        <h2>{fa ? "جای اسناد" : "Where documents are kept"}</h2>
        <ul className="period-pending">
          {PLACES.map((place) => <li key={place.href}>
            <Link href={place.href}><strong>{fa ? place.fa : place.en}</strong></Link>
            <p>{fa ? place.whatFa : place.whatEn}</p>
            <p className="admin-hint">{fa ? place.whoFa : place.whoEn}</p>
          </li>)}
        </ul>
      </section>
      <section className="module-content-card" aria-label={fa ? "بررسی امنیتی" : "Security check"}>
        <h2>{fa ? "بررسی امنیتی" : "Security check"}</h2>
        <p>{fa ? "هر فایل تازه پیش از باز شدن از نظر بدافزار بررسی می‌شود. تا وقتی بررسی تمام نشده، فایل قفل است."
          : "Every new file is checked for malware before anyone can open it. Until the check passes, the file stays locked."}</p>
        <ul>
          <li>{fa ? "قفل: بررسی هنوز تمام نشده است." : "Locked: the check has not finished."}</li>
          <li>{fa ? "بررسی کامل نشد: فایل قفل می‌ماند و می‌توان دوباره بررسی کرد." : "Check could not finish: the file stays locked and can be checked again."}</li>
          <li>{fa ? "مسدود: در بررسی رد شد. نگهداری می‌شود و هرگز باز نمی‌شود." : "Blocked: it failed the check. It is kept, and it never opens."}</li>
        </ul>
        <p className="admin-hint">{fa ? "سند پیوست‌شده هرگز جایگزین یا حذف نمی‌شود. برای اصلاح، سند تازه‌ای کنار آن پیوست کنید."
          : "An attached document is never replaced or removed. To correct one, attach a new document beside it."}</p>
      </section>
    </div>
  );
}
