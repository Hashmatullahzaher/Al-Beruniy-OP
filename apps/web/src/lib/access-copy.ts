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
  FINANCE: { en: "Finance and General Ledger", fa: "مالی و دفتر کل" },
  COMPANY: { en: "Company", fa: "شرکت" }
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
  "admin.company.manage": {
    label: { en: "Manage company details", fa: "مدیریت مشخصات شرکت" },
    allows: { en: "Enter or correct the company's legal name, registration number and go-live date.", fa: "وارد کردن یا اصلاح نام حقوقی، شماره ثبت و تاریخ آغاز کار شرکت." }
  },
  "admin.finance-workflow.manage": {
    label: { en: "Manage Finance workflow approvals", fa: "مدیریت تأیید جریان‌های مالی" },
    allows: { en: "Choose which transaction types require an independent approval for this company. This does not give permission to enter or post financial transactions.", fa: "انتخاب نوع معامله‌هایی که برای این شرکت به تأیید مستقل نیاز دارند. این صلاحیت اجازهٔ وارد کردن یا ثبت معامله مالی را نمی‌دهد." }
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
    label: { en: "View Finance reports and journals", fa: "مشاهده گزارش‌های مالی و ژورنال‌ها" },
    allows: { en: "See the General Ledger, the Chart of Accounts, the financial calendar and the exchange rates.", fa: "مشاهده تحویل‌های تاییدشده، اسناد، ژورنال ثبت‌شده و تطبیق آن." }
  },
  "finance.calendar.manage": {
    label: { en: "Manage financial calendar", fa: "مدیریت تقویم مالی" },
    allows: { en: "Choose the company's financial year (Solar Hijri, Gregorian or custom) and generate its monthly accounting periods as pending.", fa: "انتخاب سال مالی شرکت (هجری شمسی، میلادی یا سفارشی) و ایجاد دوره‌های ماهانه حسابداری در حالت انتظار." }
  },
  // WP-A: Chart of Accounts (0014).
  "finance.ledger-account.manage": {
    label: { en: "Manage the Chart of Accounts", fa: "مدیریت جدول حساب‌ها" },
    allows: { en: "Add accounts (usable at once), edit them, and deactivate or reactivate them. Safe and Saraf accounts are added the same way. Accounts in use keep their code, type, currency and control type.", fa: "افزودن حساب (فوراً قابل استفاده)، ویرایش، و غیرفعال یا فعال کردن دوباره آن‌ها. حساب‌های صندوق و صراف نیز به همین شکل افزوده می‌شوند. حساب‌های در حال استفاده کد، نوع، واحد پول و نوع کنترل خود را حفظ می‌کنند." }
  },
  "finance.ledger-account.review": {
    label: { en: "Review new accounts", fa: "بازبینی حساب‌های جدید" },
    allows: { en: "Work through the Finance Manager's review list: mark new or changed accounts as reviewed, or flag them for correction.", fa: "رسیدگی به فهرست بازبینی مدیر مالی: علامت‌گذاری حساب‌های جدید یا تغییر یافته به عنوان بازبینی‌شده یا نیازمند اصلاح." },
    independence: { en: "Refused for whoever created or last changed that account.", fa: "برای کسی که آن حساب را ایجاد یا آخرین بار تغییر داده رد می‌شود." }
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
  },
  // WP-B (catalogue version 3): Saraf accounts.
  "treasury.saraf-account.manage": {
    label: { en: "Manage Saraf accounts", fa: "مدیریت حساب‌های صراف" },
    allows: { en: "Create a Saraf account by linking a Saraf to a Saraf control account from the Chart of Accounts in USD or AFN, and activate or deactivate Saraf accounts. Account set-up only: no Saraf transactions or transfers.", fa: "ایجاد حساب صراف با وصل کردن یک صراف به حساب کنترل صراف از جدول حساب‌ها به دالر یا افغانی، و فعال یا غیرفعال کردن حساب‌های صراف. فقط ایجاد حساب: بدون معامله یا انتقال صراف." },
    independence: { en: "Whoever created a Saraf account cannot activate it.", fa: "کسی که حساب صراف را ایجاد کرده نمی‌تواند آن را فعال کند." }
  },
  // WP-C (catalogue version 3).
  "finance.exchange-rate.record": {
    label: { en: "Record daily exchange rates", fa: "ثبت نرخ روزانه اسعار" },
    allows: { en: "Record the day's USD–AFN market or Saraf rate exactly as quoted, and correct a rate with a reason. Corrections never change rates already used by a transaction.", fa: "ثبت نرخ روز دالر–افغانی بازار یا صراف دقیقاً همان‌طور که اعلام شده، و اصلاح نرخ با ذکر دلیل. اصلاح هرگز نرخی را که در معامله‌ای استفاده شده تغییر نمی‌دهد." }
  },
  "shareholder.capital-request.create": {
    label: { en: "Open capital requests from installments", fa: "باز کردن درخواست سرمایه از اقساط" },
    allows: { en: "Open a capital request from an eligible agreement installment, in its own currency (USD or AFN), for Treasury to receive.", fa: "باز کردن درخواست سرمایه از قسط واجد شرایط قرارداد، به واحد پول خود آن (دالر یا افغانی)، تا خزانه دریافت کند." }
  },
  "shareholder.setup.manage": {
    label: { en: "Set up shareholders and capital agreements", fa: "تنظیم سهامداران و قراردادهای سرمایه" },
    allows: { en: "Add shareholders, draft capital agreements and installment plans without uploading documents. Corrections are possible only while things are still draft. Does not receive or record any money.", fa: "افزودن سهامداران، پیش‌نویس قراردادهای سرمایه و برنامهٔ اقساط بدون بارگذاری سند. اصلاح فقط تا زمانی ممکن است که موارد هنوز پیش‌نویس باشند. هیچ پولی دریافت یا ثبت نمی‌کند." }
  },
  "shareholder.read": {
    label: { en: "View shareholder agreements", fa: "مشاهده قراردادهای سهامداران" },
    allows: { en: "See capital agreements, installments and capital requests, with totals kept per currency.", fa: "مشاهده قراردادهای سرمایه، اقساط و درخواست‌های سرمایه، با جمع‌ها به تفکیک واحد پول." }
  },
  // WP #17 (catalogue version 4): journal reversals. Posting an approved reversal awaits policy.
  "finance.reversal.request": {
    label: { en: "Request journal reversals", fa: "درخواست برگشت ژورنال" },
    allows: { en: "Ask for a posted journal to be reversed, with a written reason, and withdraw your own request while it waits. The posted journal itself never changes.", fa: "درخواست برگشت یک ژورنال ثبت‌شده با ذکر دلیل نوشته‌شده، و پس گرفتن درخواست خود تا زمانی که منتظر است. خود ژورنال ثبت‌شده هرگز تغییر نمی‌کند." },
    independence: { en: "Refused for whoever prepared, approved or posted that journal (a cautious rule until the Finance Manager decides).", fa: "برای کسی که آن ژورنال را آماده، تایید یا ثبت کرده رد می‌شود (قاعدهٔ محتاطانه تا تصمیم مدیر مالی)." }
  },
  "finance.reversal.approve": {
    label: { en: "Approve journal reversals", fa: "تایید برگشت ژورنال" },
    allows: { en: "Approve or reject (with a note) a requested reversal. Approval records the decision only: posting the reversal waits for the Finance Manager's posting policy.", fa: "تایید یا رد (با یادداشت) برگشت درخواست‌شده. تایید فقط تصمیم را ثبت می‌کند: ثبت برگشت منتظر پالیسی ثبت مدیر مالی است." },
    independence: { en: "Never by the person who requested it, nor by whoever prepared, approved or posted the journal.", fa: "هرگز توسط درخواست‌کننده، و نه توسط کسی که ژورنال را آماده، تایید یا ثبت کرده است." }
  },
  // Operational Finance (0027-0029): daily expenses and their set-up.
  "treasury.operational-account.manage": {
    label: { en: "Set up Treasury accounts for daily Finance", fa: "تنظیم حساب‌های خزانه برای مالی روزانه" },
    allows: { en: "Add and edit the safes, cash boxes, bank and Saraf accounts that daily expenses are paid from, each linked to a Chart of Accounts account in its own currency. Does not record any transaction.", fa: "افزودن و ویرایش صندوق‌ها، صندوقچه‌ها، حساب‌های بانکی و صراف که مصارف روزانه از آن‌ها پرداخت می‌شود؛ هر کدام به یک حساب جدول حساب‌ها با واحد پول خودش وصل است. هیچ معامله‌ای ثبت نمی‌کند." }
  },
  // Safes (0045/0046).
  "treasury.safe.read": {
    label: { en: "See Safes and their balances", fa: "دیدن صندوق‌ها و موجودی آن‌ها" },
    allows: { en: "See every Safe of the company with its real book balance, opening balance and recent movements. The balance always counts every recorded movement; details outside the person's projects, departments or cost centers stay hidden.", fa: "دیدن هر صندوق شرکت با موجودی واقعی دفتری، موجودی افتتاحیه و حرکات اخیر آن. موجودی همیشه هر حرکت ثبت‌شده را حساب می‌کند؛ جزئیات خارج از پروژه‌ها، بخش‌ها یا مراکز هزینهٔ شخص پنهان می‌ماند." }
  },
  "treasury.opening-balance.record": {
    label: { en: "Set Safe opening balances", fa: "ثبت موجودی افتتاحیهٔ صندوق" },
    allows: { en: "Record the opening balance of a Safe once, at the business start. It is recorded in the books at once and is never edited; a mistake is corrected by reversal.", fa: "ثبت موجودی افتتاحیهٔ یک صندوق برای یک بار، در آغاز کار. فوراً در دفاتر ثبت می‌شود و هرگز ویرایش نمی‌شود؛ اشتباه با برگشت اصلاح می‌شود." }
  },
  // Money movements (0047).
  "treasury.receipt.record": {
    label: { en: "Receive cash into a Safe", fa: "دریافت پول در صندوق" },
    allows: { en: "Record money received into a Safe or Saraf account as other income, in one save. It is recorded in the books at once; a mistake is corrected by reversal, never edited.", fa: "ثبت پول دریافت‌شده در صندوق یا حساب صراف به‌عنوان عاید دیگر، با یک ذخیره. فوراً در دفاتر ثبت می‌شود؛ اشتباه با برگشت اصلاح می‌شود، هرگز ویرایش نمی‌شود." }
  },
  "treasury.transfer.record": {
    label: { en: "Transfer between Safes and Saraf accounts", fa: "انتقال میان صندوق‌ها و حساب‌های صراف" },
    allows: { en: "Move money from one Safe or Saraf account to another in the same currency, in one save. Both accounts show the movement at once.", fa: "انتقال پول از یک صندوق یا حساب صراف به دیگری با همان واحد پول، با یک ذخیره. هر دو حساب حرکت را فوراً نشان می‌دهند." }
  },
  "treasury.payment.record": {
    label: { en: "Pay what the company owes", fa: "پرداخت آنچه شرکت بدهکار است" },
    allows: { en: "Pay a supplier, contractor, salary or other amount the company owes from a Safe or Saraf account, against a payable account, in one save. Paying an expense still needs the permission to record expenses.", fa: "پرداخت به تأمین‌کننده، قراردادی، معاش یا مبلغ دیگری که شرکت بدهکار است از صندوق یا حساب صراف، در مقابل یک حساب قابل پرداخت، با یک ذخیره. پرداخت مصرف همچنان به صلاحیت ثبت مصارف نیاز دارد." }
  },
  "finance.expense-category.manage": {
    label: { en: "Set up expense types", fa: "تنظیم انواع مصرف" },
    allows: { en: "Add and edit the expense types people choose when recording an expense, each linked to an expense account in the Chart of Accounts. Does not record any transaction.", fa: "افزودن و ویرایش انواع مصرف که هنگام ثبت مصرف انتخاب می‌شوند؛ هر کدام به یک حساب مصرف در جدول حساب‌ها وصل است. هیچ معامله‌ای ثبت نمی‌کند." }
  },
  "finance.expense.create": {
    label: { en: "Record expenses", fa: "ثبت مصارف" },
    allows: { en: "Record money paid out from a Treasury account. When the company does not require approval, the expense is recorded in the books at once.", fa: "ثبت پولی که از یک حساب خزانه پرداخت شده است. وقتی شرکت به تأیید نیاز ندارد، مصرف فوراً در دفاتر ثبت می‌شود." }
  },
  "finance.expense.read": {
    label: { en: "View expenses and the daily report", fa: "مشاهده مصارف و گزارش روزانه" },
    allows: { en: "See recorded expenses, daily transactions and the daily financial report, within the projects, departments and cost centers the person works with.", fa: "دیدن مصارف ثبت‌شده، معاملات روزانه و گزارش مالی روزانه، در محدوده پروژه‌ها، بخش‌ها و مراکز هزینه‌ای که شخص با آن‌ها کار می‌کند." }
  },
  // Temporary Funding (migration 0037).
  "finance.temporary-funding.read": {
    label: { en: "View temporary funding", fa: "مشاهده تمویل موقت" },
    allows: { en: "See who temporarily funded the company, how much is still owed to each provider, and Safe movements kept separate from it.", fa: "دیدن این‌که چه کسی شرکت را به‌طور موقت تمویل کرده، چه مقدار هنوز به هر تمویل‌کننده بدهکار است، و حرکات صندوق که جدا از آن نگه داشته می‌شود." }
  },
  "finance.temporary-funding.record": {
    label: { en: "Record temporary funding", fa: "ثبت تمویل موقت" },
    allows: { en: "Record that a person or organization paid an expense directly or put cash into the Safe for the company. It is sent for approval and becomes an amount the company owes them.", fa: "ثبت این‌که یک شخص یا سازمان مصرفی را مستقیماً پرداخت کرده یا برای شرکت نقد در صندوق گذاشته است. برای تأیید فرستاده می‌شود و به مبلغی تبدیل می‌شود که شرکت به آن‌ها بدهکار است." }
  },
  "finance.temporary-funding.approve": {
    label: { en: "Approve temporary funding", fa: "تأیید تمویل موقت" },
    allows: { en: "Approve a recorded temporary funding, which records it in the books as an amount owed to the provider.", fa: "تأیید تمویل موقت ثبت‌شده، که آن را در دفاتر به‌عنوان مبلغ بدهکار به تمویل‌کننده ثبت می‌کند." },
    independence: { en: "Never by the person who recorded it or by the provider.", fa: "هرگز توسط کسی که آن را ثبت کرده یا توسط خود تمویل‌کننده." }
  },
  "finance.temporary-funding.settle": {
    label: { en: "Request repayment of temporary funding", fa: "درخواست بازپرداخت تمویل موقت" },
    allows: { en: "Request a full or partial repayment to a provider from a Safe or bank account. It is never more than the amount still owed.", fa: "درخواست بازپرداخت کامل یا قسمی به تمویل‌کننده از صندوق یا حساب بانکی. هرگز بیشتر از مبلغ باقی‌مانده نیست." }
  },
  "finance.temporary-funding.settle-approve": {
    label: { en: "Approve repayments of temporary funding", fa: "تأیید بازپرداخت تمویل موقت" },
    allows: { en: "Approve a repayment, which pays the provider and reduces the amount owed. The original expense is never recorded again.", fa: "تأیید بازپرداخت، که به تمویل‌کننده پرداخت می‌کند و مبلغ بدهی را کم می‌کند. مصرف اصلی هرگز دوباره ثبت نمی‌شود." },
    independence: { en: "Never by the person who requested the repayment or by the provider.", fa: "هرگز توسط کسی که بازپرداخت را درخواست کرده یا توسط خود تمویل‌کننده." }
  },
  "finance.temporary-funding.configure": {
    label: { en: "Set up temporary funding", fa: "تنظیم تمویل موقت" },
    allows: { en: "Choose the Temporary Funding Payable liability account, with its authorization document, where amounts owed to providers are recorded.", fa: "انتخاب حساب بدهی تمویل موقت، همراه با سند صلاحیت آن، که مبالغ بدهکار به تمویل‌کنندگان در آن ثبت می‌شود." }
  },
  "finance.expense.approve": {
    label: { en: "Approve expenses", fa: "تأیید مصارف" },
    allows: { en: "Only used when the company requires expense approval: approve an expense waiting for approval, which records it in the books.", fa: "فقط وقتی شرکت تأیید مصارف را لازم بداند استفاده می‌شود: تأیید مصرف منتظر تأیید، که آن را در دفاتر ثبت می‌کند." },
    independence: { en: "Never by the person who recorded the expense.", fa: "هرگز توسط کسی که مصرف را ثبت کرده است." }
  },
  "company.dashboard.read": {
    label: { en: "View company dashboard", fa: "مشاهده داشبورد عمومی شرکت" },
    allows: { en: "See the company-wide dashboard with its approved summary figures. It does not open Finance, Treasury, shareholder or administration records, which keep their own permissions.", fa: "دیدن داشبورد عمومی شرکت با ارقام خلاصهٔ تأییدشده. سوابق مالی، خزانه، سهامداران یا مدیریت را باز نمی‌کند؛ آن‌ها صلاحیت‌های خود را دارند." }
  },
  "finance.period.manage": {
    label: { en: "Open accounting periods", fa: "باز کردن دوره‌های حسابداری" },
    allows: { en: "Open a pending accounting period, with a reason, so transactions dated in it can be recorded. Closing periods is not available yet.", fa: "باز کردن یک دوره حسابداری در انتظار، با ذکر دلیل، تا معاملات با تاریخ آن دوره ثبت شوند. بستن دوره‌ها هنوز در دسترس نیست." }
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
  COMPANY_PROFILE_UPDATED: { en: "Company details changed", fa: "مشخصات شرکت تغییر کرد" },
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
