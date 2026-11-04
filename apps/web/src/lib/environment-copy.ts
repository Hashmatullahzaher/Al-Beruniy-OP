import type { EnvironmentName } from "@abos/contracts";

type Copy = { readonly en: string; readonly fa: string };

/** What the sign-in page says about where the person is. It follows the build's real environment, so production never carries preview or staging wording. */
export function signInNotice(environment: EnvironmentName): Copy {
  if (environment === "production") return { en: "Authorized users only. Activity is recorded.", fa: "فقط کاربران مجاز. فعالیت‌ها ثبت می‌شود." };
  if (environment === "staging") return { en: "Staging environment for testing. Records here are not company records.", fa: "محیط آزمایش. سوابق اینجا سوابق شرکت نیستند." };
  return {
    en: "Preview environment with synthetic data. No real money or company records; real financial posting is disabled.",
    fa: "محیط پیش‌نمایش با داده‌های مصنوعی. هیچ پول یا سوابق واقعی شرکت وجود ندارد و ثبت واقعی مالی غیرفعال است."
  };
}

/** The application footer for someone who has not signed in. */
export function signedOutFooter(environment: EnvironmentName): Copy {
  if (environment === "development") return { en: "No operational services connected", fa: "هیچ سرویس عملیاتی متصل نیست" };
  return { en: "Sign in to continue", fa: "برای ادامه وارد شوید" };
}
