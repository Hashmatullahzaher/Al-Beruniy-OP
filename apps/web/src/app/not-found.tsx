"use client";

import Link from "next/link";
import { StatePanel } from "@abos/ui";

import { useLocale } from "@/components/LocaleProvider";

export default function NotFound() {
  const fa = useLocale().locale === "fa";
  return (
    <StatePanel kind="empty" title={fa ? "این صفحه پیدا نشد" : "Workspace not found"} description={fa ? "این صفحه وجود ندارد یا برای شما در دسترس نیست." : "This page does not exist or is not available to you."}>
      <Link className="secondary-button" href="/">{fa ? "بازگشت به صفحهٔ اصلی" : "Return to overview"}</Link>
    </StatePanel>
  );
}
