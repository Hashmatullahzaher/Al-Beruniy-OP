import { useI18n } from '@/i18n/I18nProvider'
import { PageHeader, SectionCard } from '@/components/ui'
import { Clock, ShieldAlert, Users } from 'lucide-react'

export function HumanResources() {
  const { lang } = useI18n()
  const isDari = lang === 'fa'

  return (
    <div className="space-y-4">
      <PageHeader
        title={isDari ? 'منابع بشری و مدیریت پرسونل' : 'Human Resources & Workforce'}
        subtitle={isDari ? 'دروازه مرحله ۱: مستلزم تایید پالیسی حقوق و دستمزد (BP-19)' : 'Stage 1 Client Gate: Workforce & Payroll Control (BP-19)'}
      />

      {/* Stage 1 Gate Governance Notice */}
      <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 p-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-200/80 p-2 text-amber-900 dark:bg-amber-800 dark:text-amber-100">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h3 className="font-display text-sm font-extrabold uppercase tracking-wide">
              {isDari ? 'دروازه تایید مرحله ۱ — سیستم حقوق و پرسونل در انتظار تایید' : 'Stage 1 Client Gate — Operational HR & Payroll Staged'}
            </h3>
            <p className="text-xs leading-relaxed opacity-90">
              {isDari
                ? 'طبق قرارداد مرحله ۰، اسامی ساختگی کارمندان یا ارقام معاشات بدون تایید رسمی سازمان ثبت نمی‌شود. تخصیص هزینه پرسونل به پروژه‌ها پس از تصویب چارت حسابات فعال خواهد شد.'
                : 'In compliance with Stage 0 guidelines, unverified staff rosters, synthetic salaries, and payroll posting are prevented. Personnel project cost allocation activates following client ledger sign-off.'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <SectionCard title={isDari ? 'تیم مقیم پروژه' : 'Site Engineers & Staff'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <Users className="h-4 w-4 text-[#C5A880]" />
                <span className="text-xs font-semibold">{isDari ? 'پرسونل ثبت‌شده' : 'Verified Staff'}</span>
              </div>
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold">Project Manager Active</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'احمد رشیدی (مدیر پروژه مزار مال) دارای دسترسی مجاز است.' : 'Ahmad Rashidi (Project Manager) authorized on Mazar Mall Command Center.'}
            </p>
          </div>
        </SectionCard>

        <SectionCard title={isDari ? 'حاضری و کارکرد' : 'Timesheets & Attendance'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <Clock className="h-4 w-4 text-[#0EA5E9]" />
                <span className="text-xs font-semibold">{isDari ? 'گزارش حاضری ماهانه' : 'Monthly Attendance'}</span>
              </div>
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold">Pending Approval</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'سیستم بیومتریک و تطبیق کارکرد در محل در مرحله ۱ وصل می‌شود.' : 'Biometric site check-in integrates with payroll ledger in Stage 1.'}
            </p>
          </div>
        </SectionCard>

        <SectionCard title={isDari ? 'صلاحیت‌ها و تفکیک وظایف (SoD)' : 'Role Segregation (SoD)'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="h-4 w-4 text-[#10B981]" />
                <span className="text-xs font-semibold">{isDari ? 'محدودیت تایید مالی' : 'Approval Matrix'}</span>
              </div>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">Enforced</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'هیچ کاربری نمی‌تواند هم درخواست‌کننده و هم تاییدکننده پرداخت باشد.' : 'Strict four-eyes principle prevents self-approval of contracts and vouchers.'}
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  )
}
