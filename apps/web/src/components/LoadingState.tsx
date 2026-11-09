"use client";

import { StatePanel } from "@abos/ui";

import { useLocale } from "@/components/LocaleProvider";

/** The page-loading message, in the reader's language. */
export function LoadingState() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  return <StatePanel kind="loading" title={fa ? "در حال بارگذاری" : "Loading workspace"}
    description={fa ? "صفحه آماده می‌شود." : "Preparing the application shell."} />;
}
