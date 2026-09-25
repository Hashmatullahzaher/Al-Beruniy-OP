/**
 * Plain-language names and explanations for the controlled permission catalogue (version 1).
 * The server decides what each permission means; this file only explains it to people.
 */
export type Copy = { readonly en: string; readonly fa: string };

export interface PermissionCopy {
  readonly label: Copy;
  readonly allows: Copy;
  /** When the database applies an independence rule to this action. */
  readonly independence?: Copy;
}

export const CATEGORY_COPY: Readonly<Record<string, Copy>> = {
  ADMINISTRATION: { en: "Administration", fa: "مدیریت دسترسی" },
  SHAREHOLDER: { en: "Shareholder records", fa: "سوابق سهامداران" },
  TREASURY: { en: "Treasury (cash and safes)", fa: "خزانه (نقد و صندوق‌ها)" },
  FINANCE: { en: "Finance and General Ledger", fa: "مالی و دفتر کل" }
};

export const PERMISSION_COPY: Readonly<Record<string, PermissionCopy>> = {
  "admin.users.manage": {
    label: { en: "Manage employee accounts", fa: "مدیریت حساب‌های کارمندان" },
    allows: { en: "Create employees, edit their details, suspend or reactivate them, assign roles, reset passwords and end their sessions.", fa: "ایجاد کارمند، ویرایش مشخصات، تعلیق یا فعال‌سازی، تعیین نقش، بازنشانی رمز و پایان نشست‌ها." }
  },
  "admin.roles.manage": {
    label: { en: "Manage roles and permissions", fa: "مدیریت نقش‌ها و صلاحیت‌ها" },
    allows: { en: "Create and change custom roles and choose which permissions each role gives.", fa: "ایجاد و تغییر نقش‌های سفارشی و انتخاب صلاحیت‌های هر نقش." }
  },
  "shareholder.capital-intent.create": {
    label: { en: "Create shareholder capital requests", fa: "ایجاد درخواست سرمایه سهامدار" },
    allows: { en: "Open a shareholder capital receipt request from an agreement installment.", fa: "باز کردن درخواست دریافت سرمایه از قسط قرارداد." }
  },
  "treasury.read": {
    label: { en: "View Treasury", fa: "مشاهده خزانه" },
    allows: { en: "See safes, cash accounts, shareholder requests and cash receipts in Treasury.", fa: "مشاهده صندوق‌ها، حساب‌های نقد، درخواست‌های سهامداران و رسیدهای نقد در خزانه." }
  },
  "treasury.cash-location.manage": {
    label: { en: "Manage safes and cashiers", fa: "مدیریت صندوق‌ها و صندوقداران" },
    allows: { en: "Create safes, open their USD and AFN accounts and assign cashiers to a safe.", fa: "ایجاد صندوق، باز کردن حساب‌های دالر و افغانی و تعیین صندوقدار برای صندوق." }
  },
  "treasury.cash-account.reconcile": {
    label: { en: "Reconcile safe openings", fa: "تطبیق افتتاح صندوق" },
    allows: { en: "Reconcile the opening count of a safe account.", fa: "تطبیق شمارش افتتاحیه حساب صندوق." },
    independence: { en: "Must be a different person from the one who counted.", fa: "باید شخصی غیر از شمارنده باشد." }
  },
  "treasury.cash-account.approve": {
    label: { en: "Approve and activate safe accounts", fa: "تصویب و فعال‌سازی حساب صندوق" },
    allows: { en: "Approve a reconciled opening and activate or block a safe account.", fa: "تصویب افتتاحیه تطبیق‌شده و فعال یا مسدود کردن حساب صندوق." },
    independence: { en: "Must be independent of the counting and reconciliation.", fa: "باید مستقل از شمارش و تطبیق باشد." }
  },
  "treasury.cash-receipt.record": {
    label: { en: "Record cash received", fa: "ثبت نقد دریافتی" },
    allows: { en: "Record cash received into a safe the person is assigned to, and submit it for verification.", fa: "ثبت نقد دریافتی در صندوقی که شخص به آن تعیین شده و ارسال برای تایید." }
  },
  "treasury.cash-count.record": {
    label: { en: "Count cash", fa: "شمارش نقد" },
    allows: { en: "Record the physical count of cash, with its evidence.", fa: "ثبت شمارش فزیکی نقد همراه با سند." }
  },
  "treasury.cash-receipt.verify": {
    label: { en: "Verify cash receipts", fa: "تایید رسیدهای نقد" },
    allows: { en: "Confirm the count and verify a cash receipt.", fa: "تایید شمارش و تایید رسید نقد." },
    independence: { en: "Refused for anyone who received or counted that cash.", fa: "برای کسی که آن نقد را دریافت یا شمرده رد می‌شود." }
  },
  "treasury.handoff.create": {
    label: { en: "Hand verified cash to Finance", fa: "تحویل نقد تاییدشده به مالی" },
    allows: { en: "Send a verified receipt to the Finance inbox.", fa: "ارسال رسید تاییدشده به صندوق مالی." }
  },
  "finance.report.operational.read": {
    label: { en: "View Finance inbox and journals", fa: "مشاهده صندوق مالی و ژورنال‌ها" },
    allows: { en: "See verified handoffs, their evidence, the posted journal and its reconciliation.", fa: "مشاهده تحویل‌های تاییدشده، اسناد، ژورنال ثبت‌شده و تطبیق آن." }
  },
  "finance.calendar.manage": {
    label: { en: "Manage financial calendar", fa: "مدیریت تقویم مالی" },
    allows: { en: "Choose the company's financial year (Solar Hijri, Gregorian or custom) and generate its monthly accounting periods as pending.", fa: "انتخاب سال مالی شرکت (هجری شمسی، میلادی یا سفارشی) و ایجاد دوره‌های ماهانه حسابداری در حالت انتظار." }
  },
  "finance.posting-intent.create": {
    label: { en: "Prepare journals", fa: "آماده‌سازی ژورنال" },
    allows: { en: "Prepare the journal for a verified handoff so it can be approved.", fa: "آماده‌سازی ژورنال برای تحویل تاییدشده تا تصویب شود." }
  },
  "finance.posting-intent.approve": {
    label: { en: "Approve journals", fa: "تصویب ژورنال" },
    allows: { en: "Approve a prepared journal.", fa: "تصویب ژورنال آماده‌شده." },
    independence: { en: "Refused for whoever prepared it or received, counted, verified or handed off the cash.", fa: "برای آماده‌کننده یا کسی که نقد را دریافت، شمارش، تایید یا تحویل کرده رد می‌شود." }
  },
  "finance.journal.post": {
    label: { en: "Post journals to the General Ledger", fa: "ثبت ژورنال در دفتر کل" },
    allows: { en: "Post an approved journal. Posting is final.", fa: "ثبت ژورنال تصویب‌شده. ثبت نهایی است." },
    independence: { en: "Only by an independent approver of that journal; never by a Treasury custody participant.", fa: "فقط توسط تصویب‌کننده مستقل همان ژورنال؛ هرگز توسط شرکت‌کننده در نگهداری نقد." }
  },
  "finance.journal.reverse": {
    label: { en: "Reverse posted journals", fa: "برگشت ژورنال‌های ثبت‌شده" },
    allows: { en: "Request a reversal of a posted journal (planned for full V1).", fa: "درخواست برگشت ژورنال ثبت‌شده (برای نسخه کامل V1 برنامه‌ریزی شده)." }
  }
};

export function permissionLabel(code: string, locale: "en" | "fa"): string {
  return PERMISSION_COPY[code]?.label[locale] ?? code;
}

export const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ACTIVE: { en: "Active", fa: "فعال" },
  DISABLED: { en: "Suspended", fa: "معلق" },
  INVITED: { en: "Invited", fa: "دعوت‌شده" },
  REVOKED: { en: "Closed", fa: "بسته‌شده" },
  INACTIVE: { en: "Inactive", fa: "غیرفعال" }
};

export const AUDIT_ACTION_COPY: Readonly<Record<string, Copy>> = {
  SUPER_ADMIN_BOOTSTRAPPED: { en: "First Super Administrator created", fa: "نخستین مدیر ارشد ایجاد شد" },
  USER_CREATED: { en: "Employee account created", fa: "حساب کارمند ایجاد شد" },
  USER_PROFILE_UPDATED: { en: "Details changed", fa: "مشخصات تغییر کرد" },
  USER_SUSPENDED: { en: "Account suspended", fa: "حساب معلق شد" },
  USER_ACTIVATED: { en: "Account reactivated", fa: "حساب دوباره فعال شد" },
  ROLE_ASSIGNED: { en: "Role assigned", fa: "نقش داده شد" },
  ROLE_REMOVED: { en: "Role removed", fa: "نقش گرفته شد" },
  PASSWORD_RESET: { en: "Temporary password issued", fa: "رمز موقت صادر شد" },
  PASSWORD_CHANGED: { en: "Password changed by the employee", fa: "رمز توسط کارمند تغییر کرد" },
  SESSIONS_REVOKED: { en: "Signed out everywhere", fa: "از همه جا خارج شد" },
  ROLE_CREATED: { en: "Role created", fa: "نقش ایجاد شد" },
  ROLE_UPDATED: { en: "Role changed", fa: "نقش تغییر کرد" },
  ROLE_DEACTIVATED: { en: "Role deactivated", fa: "نقش غیرفعال شد" },
  ROLE_REACTIVATED: { en: "Role reactivated", fa: "نقش دوباره فعال شد" },
  USER_PERMISSIONS_CHANGED: { en: "Access changed through a role", fa: "دسترسی از طریق نقش تغییر کرد" }
};

export const ERROR_COPY: Readonly<Record<string, Copy>> = {
  INVALID_CREDENTIALS: { en: "The username or password is not correct, or the account is locked for 15 minutes after repeated attempts.", fa: "نام کاربری یا رمز درست نیست، یا حساب پس از تلاش‌های مکرر برای ۱۵ دقیقه قفل شده است." },
  THROTTLED: { en: "Too many unsuccessful attempts. Wait 15 minutes and try again.", fa: "تلاش‌های ناموفق زیاد. ۱۵ دقیقه صبر کنید و دوباره تلاش کنید." },
  TEMPORARY_PASSWORD_EXPIRED: { en: "This temporary password has expired. Ask your administrator for a new one.", fa: "این رمز موقت منقضی شده است. از مدیر خود رمز جدید بخواهید." },
  ACCOUNT_INACTIVE: { en: "This account is suspended. Contact your administrator.", fa: "این حساب معلق است. با مدیر خود تماس بگیرید." },
  NO_ACCESS_ASSIGNED: { en: "Your account has no access assigned yet. Contact your administrator.", fa: "هنوز برای حساب شما دسترسی تعیین نشده است. با مدیر خود تماس بگیرید." },
  PERMISSION_DENIED: { en: "You do not have permission to do this.", fa: "شما صلاحیت این کار را ندارید." },
  SELF_CHANGE_FORBIDDEN: { en: "You cannot change your own access. Another administrator must do it.", fa: "شما نمی‌توانید دسترسی خود را تغییر دهید. مدیر دیگری باید این کار را انجام دهد." },
  SUPER_ADMIN_REQUIRED: { en: "Only a Super Administrator can give or take away administration or approval access, or reset the password of someone who holds it.", fa: "فقط مدیر ارشد می‌تواند دسترسی مدیریتی یا تصویب را بدهد یا بگیرد، یا رمز دارنده آن را بازنشانی کند." },
  LAST_SUPER_ADMIN: { en: "This would leave the company without an active Super Administrator.", fa: "این کار شرکت را بدون مدیر ارشد فعال می‌گذارد." },
  DUPLICATE: { en: "That name is already in use.", fa: "این نام قبلاً استفاده شده است." },
  STALE_VERSION: { en: "Someone else changed this. Reload and try again.", fa: "شخص دیگری این را تغییر داده است. دوباره بارگذاری کنید." },
  AUTHENTICATION_REQUIRED: { en: "Your session has ended. Sign in again.", fa: "نشست شما پایان یافت. دوباره وارد شوید." }
};
