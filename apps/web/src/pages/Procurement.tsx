import { useI18n } from '@/i18n/I18nProvider'
import { PageHeader, SectionCard } from '@/components/ui'
import { Layers, ShieldAlert, ShoppingBag, Truck } from 'lucide-react'

export function Procurement() {
  const { lang } = useI18n()
  const isDari = lang === 'fa'

  return (
    <div className="space-y-4">
      <PageHeader
        title={isDari ? 'تدارکات و مدیریت تمویل‌کنندگان' : 'Procurement & Subcontracting'}
        subtitle={isDari ? 'دروازه مرحله ۱: مستلزم تایید پالیسی کارفرما (BP-18)' : 'Stage 1 Client Gate: Vendor & Purchase Order Control (BP-18)'}
      />

      {/* Stage 1 Gate Governance Notice */}
      <div className="rounded-2xl border border-amber-300/60 bg-amber-50/80 p-5 text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-200/80 p-2 text-amber-900 dark:bg-amber-800 dark:text-amber-100">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h3 className="font-display text-sm font-extrabold uppercase tracking-wide">
              {isDari ? 'دروازه تایید مرحله ۱ — سیستم تدارکات غیرفعال' : 'Stage 1 Client Gate — Operational Procurement Pending'}
            </h3>
            <p className="text-xs leading-relaxed opacity-90">
              {isDari
                ? 'طبق دستورالعمل مرحله ۰ (PHASE_00_UI_KICKOFF.md)، این ماژول دارای ساختار ظاهری کامل سازمانی است اما ثبت سفارشات واقعی و تعهدات مالی تا زمان تصویب پالیسی تدارکات و تفکیک وظایف (SoD) متوقف می‌باشد.'
                : 'In accordance with Stage 0 governance, this route displays the verified enterprise layout and architecture contract. Real purchase orders, vendor liabilities, and material intake posting are held until client approval of BP-18 and threshold rules.'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <SectionCard title={isDari ? 'سفارشات خرید (PO)' : 'Purchase Orders'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <ShoppingBag className="h-4 w-4 text-[#C5A880]" />
                <span className="text-xs font-semibold">{isDari ? 'سفارشات فعال' : 'Active POs'}</span>
              </div>
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold">0 Pending</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'هیچ سفارش خریدی برای پروژه فعلی صادر نشده است.' : 'No active purchase commitments issued in baseline repository.'}
            </p>
          </div>
        </SectionCard>

        <SectionCard title={isDari ? 'فهرست تمویل‌کنندگان' : 'Vendor Registry'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <Truck className="h-4 w-4 text-[#0EA5E9]" />
                <span className="text-xs font-semibold">{isDari ? 'تمویل‌کنندگان تاییدشده' : 'Approved Vendors'}</span>
              </div>
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold">0 Registered</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'احراز هویت و اسناد ثبتی تمویل‌کنندگان در مرحله ۱ ثبت خواهد شد.' : 'Vendor KYC and contractual compliance will be onboarded in Stage 1.'}
            </p>
          </div>
        </SectionCard>

        <SectionCard title={isDari ? 'انبار و مواد ساختمانی' : 'Material Intake'}>
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
              <div className="flex items-center gap-2.5">
                <Layers className="h-4 w-4 text-[#10B981]" />
                <span className="text-xs font-semibold">{isDari ? 'رسید انبار (GRN)' : 'Goods Receipts'}</span>
              </div>
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold">0 Verified</span>
            </div>
            <p className="text-[11px] text-slate-500">
              {isDari ? 'انتقال مواد بر اساس مبادله ملک پس از تایید حقوقی فعال می‌گردد.' : 'Material-in-exchange-for-property is staged pending client legal approval.'}
            </p>
          </div>
        </SectionCard>
      </div>
    </div>
  )
}
