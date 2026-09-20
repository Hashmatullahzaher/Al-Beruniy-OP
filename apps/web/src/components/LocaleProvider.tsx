"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type AppLocale = "en" | "fa";

interface LocaleContextValue {
  readonly locale: AppLocale;
  readonly isRtl: boolean;
  readonly setLocale: (locale: AppLocale) => void;
  readonly toggleLocale: () => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [locale, setLocale] = useState<AppLocale>("en");
  const isRtl = locale === "fa";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtl ? "rtl" : "ltr";
  }, [isRtl, locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    isRtl,
    setLocale,
    toggleLocale: () => setLocale((current) => current === "en" ? "fa" : "en")
  }), [isRtl, locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used within LocaleProvider");
  return value;
}
