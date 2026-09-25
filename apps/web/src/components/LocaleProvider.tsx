"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type AppLocale = "en" | "fa";

interface LocaleContextValue {
  readonly locale: AppLocale;
  readonly isRtl: boolean;
  readonly setLocale: (locale: AppLocale) => void;
  readonly toggleLocale: () => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const LOCALE_STORAGE_KEY = "abos.locale";
const LOCALE_EVENT = "abos-locale-change";
let memoryLocale: AppLocale = "en";

function readStoredLocale(): AppLocale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "fa" || stored === "en") return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall back to memory.
  }
  return memoryLocale;
}

function storeLocale(next: AppLocale): void {
  memoryLocale = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // The in-memory choice still applies for this page.
  }
  window.dispatchEvent(new Event(LOCALE_EVENT));
}

function subscribeLocale(onChange: () => void): () => void {
  window.addEventListener(LOCALE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(LOCALE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function LocaleProvider({ children }: Readonly<{ children: ReactNode }>) {
  // The server always renders English; the browser reads storage, so there is no hydration mismatch.
  const locale = useSyncExternalStore(subscribeLocale, readStoredLocale, () => "en" as AppLocale);
  const isRtl = locale === "fa";

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtl ? "rtl" : "ltr";
  }, [isRtl, locale]);

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    isRtl,
    setLocale: storeLocale,
    toggleLocale: () => storeLocale(locale === "en" ? "fa" : "en")
  }), [isRtl, locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used within LocaleProvider");
  return value;
}
