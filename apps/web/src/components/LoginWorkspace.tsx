"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { ERROR_COPY, type Copy } from "@/lib/access-copy";

interface ApiError { readonly code: string; readonly message: string; readonly details?: { readonly problems?: readonly string[] } }

const PROBLEM_COPY: Readonly<Record<string, Copy>> = {
  TOO_SHORT: { en: "Use at least 12 characters.", fa: "حداقل ۱۲ حرف استفاده کنید." },
  TOO_LONG: { en: "Use at most 128 characters.", fa: "حداکثر ۱۲۸ حرف استفاده کنید." },
  CONTAINS_LOGIN: { en: "Do not include your username.", fa: "نام کاربری خود را در رمز نگذارید." },
  TOO_SIMPLE: { en: "Use more varied characters.", fa: "از حروف متنوع‌تر استفاده کنید." },
  SAME_AS_CURRENT: { en: "Choose a password different from the current one.", fa: "رمزی متفاوت از رمز فعلی انتخاب کنید." }
};

async function post(url: string, body: unknown): Promise<{ ok: true } | { ok: false; error: ApiError }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const parsed = await response.json() as { ok: boolean; error?: ApiError };
    return parsed.ok ? { ok: true } : { ok: false, error: parsed.error ?? { code: "INTERNAL_ERROR", message: "Unexpected response" } };
  } catch {
    return { ok: false, error: { code: "NETWORK", message: "The server could not be reached." } };
  }
}

/**
 * Only a same-origin path is accepted. Backslashes and control characters are refused because the
 * URL parser can turn "/\evil" or "/<tab>/evil" into another host.
 */
function safeNext(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return "/dashboard";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("/login")) return "/dashboard";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/dashboard";
  }
}

export function LoginWorkspace() {
  const { locale, toggleLocale } = useLocale();
  const fa = locale === "fa";
  const t = (copy: Copy) => copy[locale];
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  const nextParameter = params.get("next");
  const voluntaryChange = params.get("change") === "1";

  const [mode, setMode] = useState<"sign-in" | "change">(voluntaryChange ? "change" : "sign-in");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const loginValue = voluntaryChange && session.user ? session.user.loginIdentifier : login;

  const explain = (failure: ApiError): string[] => {
    if (failure.code === "VALIDATION_FAILED" && failure.details?.problems?.length) {
      return failure.details.problems.map((problem) => PROBLEM_COPY[problem] ? t(PROBLEM_COPY[problem]) : problem);
    }
    const copy = ERROR_COPY[failure.code];
    return [copy ? t(copy) : failure.message];
  };

  const finish = async () => {
    await session.refresh();
    router.replace(safeNext(nextParameter));
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError([]);
    const result = await post("/api/v1/auth/login", { loginIdentifier: loginValue, password });
    setBusy(false);
    if (result.ok) { await finish(); return; }
    if (result.error.code === "PASSWORD_CHANGE_REQUIRED") { setMode("change"); return; }
    setError(explain(result.error));
  };

  const change = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) { setError([fa ? "دو رمز جدید یکسان نیستند." : "The two new passwords do not match."]); return; }
    setBusy(true); setError([]);
    const result = await post("/api/v1/auth/password", { loginIdentifier: loginValue, currentPassword: password, newPassword });
    setBusy(false);
    if (result.ok) { await finish(); return; }
    setError(explain(result.error));
  };

  return (
    <div className="login-page">
      <Image src="/assets/al-beruniy-background.jpg" alt="" fill priority sizes="100vw" className="login-backdrop" />
      <div className="login-shade" aria-hidden="true" />
      <section className="login-card" aria-labelledby="login-title">
        <header>
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 58" fill="none"><path d="M24 3v49M18 11v41M30 11v41M12 23v29M36 23v29M7 52h34M13 39l11-9 11 9M18 25l6-8 6 8"/><path d="M5 55h38"/></svg>
          </span>
          <div><strong>AL-BERUNIY</strong><small>{fa ? "سیستم عامل سازمانی" : "Operating System"}</small></div>
          <button type="button" className="language-toggle" onClick={toggleLocale} aria-label={locale === "en" ? "Switch to Dari" : "Switch to English"}>
            <span className={locale === "en" ? "active" : ""}>EN</span><i aria-hidden="true" /><span className={locale === "fa" ? "active" : ""}>دری</span>
          </button>
        </header>

        {mode === "sign-in" ? (
          <form onSubmit={(event) => void signIn(event)} noValidate>
            <h1 id="login-title">{fa ? "ورود کارمندان" : "Employee sign-in"}</h1>
            <p className="login-lead">{fa ? "با نام کاربری و رمزی که مدیر به شما داده وارد شوید." : "Sign in with the username and password your administrator gave you."}</p>
            <label><span>{fa ? "نام کاربری" : "Username"}</span>
              <input name="username" autoComplete="username" dir="ltr" value={login} onChange={(event) => setLogin(event.target.value)} required autoFocus /></label>
            <label><span>{fa ? "رمز" : "Password"}</span>
              <input name="password" type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error.length ? <div className="login-error" role="alert">{error.map((line) => <p key={line}>{line}</p>)}</div> : null}
            <button className="login-submit" type="submit" disabled={busy || !login || !password}>{busy ? (fa ? "در حال بررسی…" : "Checking…") : (fa ? "ورود" : "Sign in")}</button>
          </form>
        ) : (
          <form onSubmit={(event) => void change(event)} noValidate>
            <h1 id="login-title">{voluntaryChange ? (fa ? "تغییر رمز من" : "Change my password") : (fa ? "رمز جدید انتخاب کنید" : "Choose a new password")}</h1>
            <p className="login-lead">{voluntaryChange
              ? (fa ? "پس از تغییر، همه نشست‌های دیگر شما پایان می‌یابد." : "After the change, all your other sessions end.")
              : (fa ? "این رمز موقت بود. پیش از ادامه، رمز شخصی خود را انتخاب کنید." : "That was a temporary password. Choose your own password before you continue.")}</p>
            {voluntaryChange && session.user ? <p className="login-identity"><small>{fa ? "نام کاربری" : "Username"}</small><strong dir="ltr">{session.user.loginIdentifier}</strong></p> : null}
            {voluntaryChange && !session.user ? <label><span>{fa ? "نام کاربری" : "Username"}</span>
              <input autoComplete="username" dir="ltr" value={login} onChange={(event) => setLogin(event.target.value)} required /></label> : null}
            {voluntaryChange ? <label><span>{fa ? "رمز فعلی" : "Current password"}</span>
              <input type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} required /></label> : null}
            <label><span>{fa ? "رمز جدید" : "New password"}</span>
              <input type="password" autoComplete="new-password" dir="ltr" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} /></label>
            <label><span>{fa ? "تکرار رمز جدید" : "Repeat the new password"}</span>
              <input type="password" autoComplete="new-password" dir="ltr" value={confirm} onChange={(event) => setConfirm(event.target.value)} required minLength={12} /></label>
            <ul className="login-rules">
              <li>{fa ? "حداقل ۱۲ حرف؛ یک جمله کوتاه خوب است." : "At least 12 characters; a short sentence works well."}</li>
              <li>{fa ? "نام کاربری خود را در رمز نگذارید." : "Do not include your username."}</li>
            </ul>
            {error.length ? <div className="login-error" role="alert">{error.map((line) => <p key={line}>{line}</p>)}</div> : null}
            <button className="login-submit" type="submit" disabled={busy || !newPassword || !confirm || !password}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ذخیره رمز و ادامه" : "Save password and continue")}</button>
            {!voluntaryChange ? <button type="button" className="login-back" onClick={() => { setMode("sign-in"); setPassword(""); setNewPassword(""); setConfirm(""); setError([]); }}>{fa ? "بازگشت" : "Back"}</button> : null}
          </form>
        )}

        <footer className="login-footer">
          <AppIcon name="shield" size={16} />
          <p>{fa
            ? "محیط پیش‌نمایش با داده‌های مصنوعی. هیچ پول یا سوابق واقعی شرکت وجود ندارد و ثبت واقعی مالی غیرفعال است."
            : "Preview environment with synthetic data. No real money or company records; real financial posting is disabled."}</p>
        </footer>
      </section>
    </div>
  );
}
