import { useState } from 'react'
import {
  Check, Globe, Plus, RotateCcw, Shield,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, DataTable, PageHeader, SectionCard } from '@/components/ui'
import { useToast } from '@/components/toast'

export function SettingsPage() {
  const { t, lang, toggleLang } = useI18n()
  const state = useStore()
  const push = useToast((s) => s.push)
  const resetDemo = useStore((s) => s.resetDemo)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const activeProjectId = state.activeProjectId
  const project = state.projects.find((p) => p.id === activeProjectId) ?? state.projects[0]

  const [unitTypes, setUnitTypes] = useState([
    { label: 'Studio Apartment', kind: 'Residential', saleable: true },
    { label: '1-Bed Executive', kind: 'Residential', saleable: true },
    { label: '2-Bed Standard (Plan B-1 / D-1)', kind: 'Residential', saleable: true },
    { label: '3-Bed Family (Plan C-3 / B-3)', kind: 'Residential', saleable: true },
    { label: 'Tower Penthouse', kind: 'Residential', saleable: true },
    { label: 'Retail Boutique (Floors 1–2)', kind: 'Commercial', saleable: true },
    { label: 'Commercial Office Suite', kind: 'Commercial', saleable: true },
    { label: 'Underground Parking Bay (B1/B2)', kind: 'Facility', saleable: false },
    { label: 'Wellness & Amenities (Floor 3)', kind: 'Facility', saleable: false },
  ])
  const [newType, setNewType] = useState('')
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)

  const addType = () => {
    const trimmed = newType.trim()
    if (!trimmed) return
    setUnitTypes((prev) => [...prev, { label: trimmed, kind: 'Residential', saleable: true }])
    push(lang === 'fa' ? `نوع واحد «${trimmed}» افزوده شد` : `Unit classification “${trimmed}” added`)
    setNewType('')
  }

  const handleReset = () => {
    resetDemo()
    setConfirmResetOpen(false)
    push(t('demo.reset.done'))
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={lang === 'fa' ? 'تنظیمات سیستم و سازمان' : 'Platform & Organization Settings'}
        subtitle={
          lang === 'fa'
            ? 'مشخصات سازمان، تنظیمات پروژه فعال، زبان و جهت نمایش، و مدیریت داده‌های نمایشی'
            : 'Organization identity, active project parameters, language localization, and presentation demo controls'
        }
        actions={
          <ActionButton
            variant="outline"
            onClick={() => setConfirmResetOpen(true)}
            className="text-[#af8132] hover:border-[#af8132]"
          >
            <RotateCcw className="h-4 w-4" />
            {lang === 'fa' ? 'بازنشانی داده‌های دمو' : 'Reset Demo Data'}
          </ActionButton>
        }
      />

      {/* Confirmation banner for Reset if triggered */}
      {confirmResetOpen && (
        <div className="flex flex-col gap-3 rounded-xl border border-[#d4a34b] bg-[#fbf5e7] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#af8132] text-white">
              <RotateCcw className="h-4 w-4" />
            </span>
            <div>
              <h4 className="text-xs font-bold text-[#14233b]">
                {lang === 'fa' ? 'آیا از بازنشانی داده‌های دمو اطمینان دارید؟' : 'Reset demo ledger to initial presentation state?'}
              </h4>
              <p className="text-[11px] text-[#71541e]">
                {lang === 'fa'
                  ? 'تمامی تغییرات و تراکنش‌های آزمایشی ثبت‌شده به حالت پیش‌فرض تاییدشده بازگردانده می‌شوند.'
                  : 'All recorded test payments, added units, and customer modifications will reset to seed defaults.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ActionButton variant="gold" onClick={handleReset}>
              {lang === 'fa' ? 'تایید و بازنشانی' : 'Confirm Reset'}
            </ActionButton>
            <ActionButton variant="outline" onClick={() => setConfirmResetOpen(false)}>
              {lang === 'fa' ? 'انصراف' : 'Cancel'}
            </ActionButton>
          </div>
        </div>
      )}

      {/* Grid: Org + Active Project */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Organization Card */}
        <SectionCard
          title={lang === 'fa' ? 'هویت سازمان و توسعه‌دهنده' : 'Developer Organization Identity'}
          eyebrow={lang === 'fa' ? 'پروفایل شرکتی' : 'Corporate Profile'}
        >
          <div className="space-y-3 p-5 text-xs">
            <div className="flex items-center justify-between rounded-lg border border-[#e4e7ec] bg-[#f9fafc] p-3">
              <div>
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'نام سازمان' : 'Organization Name'}</span>
                <span className="text-sm font-bold text-[#14233b]">{state.org.name}</span>
              </div>
              <span className="rounded bg-[#0b192b] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[#e4c274]">
                ENTERPRISE
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-[#e4e7ec] bg-[#f9fafc] p-3">
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'ارز عملیاتی' : 'Ledger Currency'}</span>
                <span className="font-bold text-[#14233b]">{project.currency} (Fixed Precision)</span>
              </div>
              <div className="rounded-lg border border-[#e4e7ec] bg-[#f9fafc] p-3">
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'مقر مرکزی' : 'Headquarters'}</span>
                <span className="font-bold text-[#14233b]">Mazar-i-Sharif / Kabul</span>
              </div>
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-[#e4e7ec] bg-[#fafbfd] p-3 text-slate-600">
              <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[#af8132]" />
              <p className="text-[11px] leading-relaxed">
                {lang === 'fa'
                  ? 'پلتفرم به صورت چندسازمانی طراحی شده است. مزار مال پروژه پیکربندی‌شده فعلی تحت سازمان توسعه‌دهنده است.'
                  : 'Generic multi-tenant real estate operations engine. Mazar Mall is a configured project under this developer organization.'}
              </p>
            </div>
          </div>
        </SectionCard>

        {/* Active Project Card */}
        <SectionCard
          title={lang === 'fa' ? 'پیکربندی پروژه فعال' : 'Active Project Parameterization'}
          eyebrow={lang === 'fa' ? 'پروژه انتخاب‌شده' : 'Current Selection'}
        >
          <div className="space-y-3 p-5 text-xs">
            <div className="flex items-center justify-between rounded-lg border border-[#e4e7ec] bg-[#f9fafc] p-3">
              <div>
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'پروژه جاری' : 'Project'}</span>
                <span className="text-sm font-bold text-[#14233b]">{project.name} · {project.city}</span>
              </div>
              <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-bold text-emerald-700">
                {project.status}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-base font-extrabold text-[#14233b]">{state.blocks.filter((b) => b.projectId === project.id).length}</div>
                <div className="text-[10px] font-semibold text-slate-500">{lang === 'fa' ? 'بلوک‌ها' : 'Blocks'}</div>
              </div>
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-base font-extrabold text-[#14233b]">{state.floors.filter((f) => f.projectId === project.id).length}</div>
                <div className="text-[10px] font-semibold text-slate-500">{lang === 'fa' ? 'طبقات' : 'Floors'}</div>
              </div>
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-base font-extrabold text-[#14233b]">{state.units.filter((u) => u.projectId === project.id).length}</div>
                <div className="text-[10px] font-semibold text-slate-500">{lang === 'fa' ? 'واحدها' : 'Units'}</div>
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'تعویض پروژه فعال' : 'Switch Project'}</span>
              <div className="flex flex-wrap gap-2">
                {state.projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveProject(p.id)}
                    className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold transition ${
                      p.id === activeProjectId
                        ? 'border-[#c8a35b] bg-[#fbf6e9] text-[#8e6722]'
                        : 'border-[#dfe4eb] bg-white text-[#203854] hover:bg-[#f6f8fb]'
                    }`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: p.accent }} />
                    {p.name}
                    {p.id === activeProjectId && <Check className="h-3 w-3 text-[#8e6722]" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Language & Regional Settings */}
        <SectionCard
          title={lang === 'fa' ? 'زبان و جهت نمایش' : 'Language & Regional Localization'}
          eyebrow={lang === 'fa' ? 'بین‌المللی‌سازی' : 'Localization'}
        >
          <div className="space-y-3 p-5 text-xs">
            <div className="flex items-center justify-between rounded-lg border border-[#e4e7ec] bg-[#f9fafc] p-3">
              <div>
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'زبان فعال' : 'Active Language'}</span>
                <span className="text-sm font-bold text-[#14233b]">{lang === 'fa' ? 'فارسی دری (RTL)' : 'English (LTR)'}</span>
              </div>
              <ActionButton variant="outline" onClick={toggleLang}>
                <Globe className="h-3.5 w-3.5 text-[#af8132]" />
                {lang === 'en' ? 'Switch to دری (RTL)' : 'تغییر به English (LTR)'}
              </ActionButton>
            </div>

            <p className="text-[11px] leading-relaxed text-slate-500">
              {lang === 'fa'
                ? 'پشتیبانی کامل از جهت راست‌به‌چپ، فونت‌های فارسی و نمایش تاریخ‌ها به تقویم میلادی و هجری شمسی.'
                : 'Complete bidirectional support for English and Dari Persian with RTL layout inversion and date formatting.'}
            </p>
          </div>
        </SectionCard>

        {/* Unit Classification Catalog */}
        <SectionCard
          title={lang === 'fa' ? 'کاتالوگ انواع واحدها' : 'Unit Classification Catalog'}
          eyebrow={lang === 'fa' ? 'مدیریت املاک' : 'Inventory Types'}
        >
          <div className="space-y-3 p-5 text-xs">
            <div className="max-h-48 space-y-1.5 overflow-y-auto pe-1">
              {unitTypes.map((u) => (
                <div key={u.label} className="flex items-center justify-between rounded-lg border border-[#e4e7ec] bg-white px-3 py-2">
                  <span className="font-semibold text-[#14233b]">{u.label}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-[#f0f3f7] px-2 py-0.5 text-[10px] font-bold text-slate-600">{u.kind}</span>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.saleable ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {u.saleable ? (lang === 'fa' ? 'قابل فروش' : 'Saleable') : (lang === 'fa' ? 'مشاعات' : 'Facility')}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 pt-2">
              <input
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addType()}
                placeholder={lang === 'fa' ? 'نوع واحد جدید…' : 'Define new unit type…'}
                className="input text-xs"
              />
              <ActionButton variant="gold" onClick={addType}>
                <Plus className="h-4 w-4" />
                {lang === 'fa' ? 'افزودن' : 'Add'}
              </ActionButton>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Staff Roles and Permissions Concept */}
      <SectionCard
        title={lang === 'fa' ? 'نقش‌ها و دسترسی‌های پرسنل (مفهوم نمایشی)' : 'Staff Roles & Authorization Matrix'}
        eyebrow={lang === 'fa' ? 'امنیت و دسترسی' : 'Access Control'}
        action={
          <span className="text-xs font-semibold text-slate-500">
            {state.roles.length} {lang === 'fa' ? 'نقش سازمانی' : 'configured roles'}
          </span>
        }
      >
        <DataTable headers={[lang === 'fa' ? 'نقش' : 'Role', lang === 'fa' ? 'دامنه دسترسی' : 'Scope', lang === 'fa' ? 'مجوزهای کلیدی' : 'Key Permissions', lang === 'fa' ? 'اعضا' : 'Members']}>
          {state.roles.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="font-bold text-[#14233b]">{r.name}</span>
              </td>
              <td>
                <span className="rounded bg-[#edf2f8] px-2 py-0.5 text-[11px] font-semibold text-[#294a6b]">{r.scope}</span>
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  {r.permissions.map((perm) => (
                    <span key={perm} className="rounded bg-[#f5efe2] px-2 py-0.5 text-[10px] font-bold text-[#8d6722]">
                      {perm}
                    </span>
                  ))}
                </div>
              </td>
              <td className="font-bold text-[#14233b]">{r.members}</td>
            </tr>
          ))}
        </DataTable>
        <div className="border-t border-[#edf0f4] p-3 text-[11px] text-slate-500">
          {lang === 'fa'
            ? 'در محیط عملیاتی، مجوزهای دسترسی بر روی سرور اعمال شده و بر اساس سازمان و پروژه مجزا هستند.'
            : 'In production, authorization is server-enforced and tenant-isolated. Displayed here for demonstration of configuration capabilities.'}
        </div>
      </SectionCard>
    </div>
  )
}
