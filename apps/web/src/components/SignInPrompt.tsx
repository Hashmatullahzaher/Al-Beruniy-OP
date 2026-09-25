"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";

/**
 * What a signed-out visitor sees on a protected workspace: the normal employee sign-in. The
 * developer token form (children) is shown only when the server reports that developer tokens are
 * enabled, which it never does in production.
 */
export function SignInPrompt({ area, children }: { readonly area: { readonly en: string; readonly fa: string }; readonly children?: ReactNode }) {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const pathname = usePathname();
  const [developerTokens, setDeveloperTokens] = useState(false);

  useEffect(() => {
    let current = true;
    void fetch("/api/v1/auth/methods", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ ok: boolean; data?: { developerTokens: boolean } }>)
      .then((body) => { if (current) setDeveloperTokens(body.ok && body.data?.developerTokens === true); })
      .catch(() => undefined);
    return () => { current = false; };
  }, []);

  return (
    <>
      <section className="treasury-card sign-in-prompt" aria-labelledby="sign-in-prompt-title">
        <span className="treasury-signin-icon" aria-hidden="true"><AppIcon name="key" size={26} /></span>
        <h2 id="sign-in-prompt-title">{fa ? `برای استفاده از ${area.fa} وارد شوید` : `Sign in to use ${area.en}`}</h2>
        <p>{fa ? "با نام کاربری و رمزی که مدیر به شما داده وارد شوید. آنچه می‌بینید و انجام می‌دهید به نقش‌های شما بستگی دارد." : "Sign in with the username and password your administrator gave you. What you can see and do depends on your roles."}</p>
        <Link className="treasury-button gold" href={`/login?next=${encodeURIComponent(pathname)}`}>{fa ? "ورود کارمندان" : "Employee sign-in"}</Link>
      </section>
      {developerTokens && children ? (
        <div className="developer-token-area">
          <p className="developer-token-label">{fa ? "ورود با توکن توسعه‌دهنده · فقط برای آزمون‌های خودکار و توسعه محلی" : "Developer token sign-in · automated tests and local development only"}</p>
          {children}
        </div>
      ) : null}
    </>
  );
}
