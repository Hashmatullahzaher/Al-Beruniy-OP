import { useMemo, useState } from 'react'
import {
  CheckCircle2, Circle, Clock, Eye, EyeOff, HardHat,
  Maximize2, Play, ShieldCheck, Video,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { ActionButton, PageHeader, ProgressBar, SectionCard } from '@/components/ui'
import { Modal } from '@/components/Modal'
import { formatDate } from '@/lib/format'
import { useToast } from '@/components/toast'
import type { ConstructionUpdate, ProgressMilestone } from '@/data/types'

export function Construction() {
  const { lang } = useI18n()
  const state = useStore()
  const push = useToast((s) => s.push)
  const projectId = state.activeProjectId
  const project = state.projects.find((p) => p.id === projectId) ?? state.projects[0]

  const [selectedUpdate, setSelectedUpdate] = useState<ConstructionUpdate | null>(null)
  const [lightboxImage, setLightboxImage] = useState<{ src: string; title: string; desc: string } | null>(null)
  const [filterMilestone, setFilterMilestone] = useState<'all' | 'published' | 'draft'>('all')

  const milestones = useMemo(
    () => state.progress.filter((p) => p.projectId === projectId),
    [state.progress, projectId],
  )

  const updates = useMemo(
    () => state.constructionUpdates.filter((u) => u.projectId === projectId),
    [state.constructionUpdates, projectId],
  )

  const overall = milestones.length
    ? Math.round(milestones.reduce((s, m) => s + m.percent, 0) / milestones.length)
    : 0

  const filteredMilestones = useMemo(() => {
    if (filterMilestone === 'published') return milestones.filter((m) => m.published)
    if (filterMilestone === 'draft') return milestones.filter((m) => !m.published)
    return milestones
  }, [milestones, filterMilestone])

  const latestUpdate = updates[0]

  const gallery = [
    {
      src: '/project/mazar-hero-night.jpg',
      title: lang === 'fa' ? 'نمای شب و نورپردازی پروژه' : 'Exterior Night Architectural Panorama',
      desc: lang === 'fa' ? 'رندرهای تاییدشده مزار مال با نورپردازی برج و پایه تجاری' : 'Approved client-supplied exterior render showing 18-storey tower elevation and retail podium.',
    },
    {
      src: '/project/mazar-day.jpg',
      title: lang === 'fa' ? 'نمای روز و چشم‌انداز شهری' : 'Daylight North Elevation',
      desc: lang === 'fa' ? 'دید روزانه از موقعیت پروژه در مزار شریف' : 'Daytime architectural view showing podium integration, glazing, and residential floors 4–18.',
    },
    {
      src: '/project/mazar-crown.jpg',
      title: lang === 'fa' ? 'تاج برج و طبقات فوقانی' : 'Tower Crown & Upper Residential Facade',
      desc: lang === 'fa' ? 'جزئیات معماری پنت‌هاوس و طبقات فوقانی' : 'Detailed facade treatment of upper residential levels and signature architectural crown.',
    },
    {
      src: '/plans/typical-floor.jpg',
      title: lang === 'fa' ? 'پلان معماری تیپ طبقات ۴ الی ۱۸' : 'Typical Residential Floor Core Layout',
      desc: lang === 'fa' ? 'توزیع تاییدشده ۱۶ واحد مسکونی در هر طبقه' : 'Official supplied layout plan confirming 16 residential units per floor around the central core.',
    },
  ]

  const toggleMilestone = (milestone: ProgressMilestone) => {
    const nextPublished = !milestone.published
    useStore.setState((prev) => ({
      progress: prev.progress.map((m) => (m.id === milestone.id ? { ...m, published: nextPublished } : m)),
    }))
    push(
      lang === 'fa'
        ? `وضعیت انتشار نقطه عطف «${milestone.title}» تغییر یافت`
        : `Toggled visibility for “${milestone.title}” (${nextPublished ? 'Published to Customer Portal' : 'Draft only'})`,
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={lang === 'fa' ? `پیشرفت ساخت‌وساز · ${project.name}` : `Construction Progress · ${project.name}`}
        subtitle={
          lang === 'fa'
            ? 'نقاط عطف مهندسی، ویدیوهای پیشرفت، تصاویر تاییدشده پروژه و مستندات کارگاه'
            : 'Engineering milestones, verified site imagery, video progress updates and contractor logs'
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-lg border border-[#e4c274]/40 bg-[#fbf6e9] px-3 py-1.5 text-xs font-bold text-[#8d6722] sm:flex">
              <ShieldCheck className="h-4 w-4 text-[#8d6722]" />
              {lang === 'fa' ? 'گزارش پیشرفت کارگاه مزار مال' : 'Verified Mazar Mall Site Telemetry'}
            </span>
          </div>
        }
      />

      {/* Top summary & featured video update */}
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1.9fr]">
        {/* Overall progress KPI */}
        <SectionCard title={lang === 'fa' ? 'وضعیت پیشرفت کل پروژه' : 'Overall Construction Completion'} eyebrow={lang === 'fa' ? 'مهندسی و اجرا' : 'Execution & Structural'}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="grid h-12 w-12 place-items-center rounded-xl bg-[#0b192b] text-[#e4c274]">
                  <HardHat className="h-6 w-6" />
                </span>
                <div>
                  <div className="font-display text-4xl font-black text-[#14233b]">{overall}%</div>
                  <div className="text-xs font-semibold text-slate-500">
                    {lang === 'fa' ? 'پیشرفت تجمعی پروژه' : 'Cumulative structural & civil progress'}
                  </div>
                </div>
              </div>
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                {lang === 'fa' ? 'برنامه زمان‌بندی: فعال' : 'Active On-Site'}
              </span>
            </div>

            <div className="mt-5">
              <ProgressBar pct={overall} className="h-3" />
            </div>

            <div className="mt-6 grid grid-cols-3 gap-2 border-t border-[#edf0f4] pt-4 text-center">
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-xl font-black text-emerald-700">{milestones.filter((m) => m.status === 'complete').length}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{lang === 'fa' ? 'تکمیل‌شده' : 'Complete'}</div>
              </div>
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-xl font-black text-[#af8132]">{milestones.filter((m) => m.status === 'in_progress').length}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{lang === 'fa' ? 'در حال اجرا' : 'In Progress'}</div>
              </div>
              <div className="rounded-lg bg-[#f6f8fb] p-2.5">
                <div className="text-xl font-black text-slate-600">{milestones.filter((m) => m.status === 'planned').length}</div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{lang === 'fa' ? 'برنامه‌ریزی‌شده' : 'Planned'}</div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Latest video update card */}
        {latestUpdate && (
          <SectionCard
            title={lang === 'fa' ? 'آخرین گزارش ویدیویی منتشرشده' : 'Latest Monthly Site Video Broadcast'}
            eyebrow={lang === 'fa' ? 'محتوای خریداران' : 'Customer & Executive Portal'}
            action={
              <button
                type="button"
                onClick={() => setSelectedUpdate(latestUpdate)}
                className="text-xs font-bold text-[#af8132] hover:underline"
              >
                {lang === 'fa' ? 'مشاهده پیش‌نمایش' : 'View preview'}
              </button>
            }
          >
            <div className="group relative overflow-hidden bg-[#071322] text-white">
              <div className="relative h-64 w-full overflow-hidden sm:h-60">
                <img
                  src={latestUpdate.thumbnailUrl}
                  alt={latestUpdate.title}
                  className="h-full w-full object-cover opacity-60 transition duration-700 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#071424] via-[#071424]/40 to-transparent" />

                <div className="absolute end-3 top-3 flex items-center gap-2">
                  <span className="flex items-center gap-1 rounded-full border border-white/20 bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white backdrop-blur-md">
                    <Video className="h-3.5 w-3.5 text-[#e4c274]" />
                    {lang === 'fa' ? '۰۲:۴۵' : '02:45'}
                  </span>
                  <span className="rounded-full border border-[#e4c274]/50 bg-[#e4c274]/20 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-[#fae19c] backdrop-blur-md">
                    DEMO UPDATE
                  </span>
                </div>

                <div className="absolute inset-0 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => setSelectedUpdate(latestUpdate)}
                    className="grid h-16 w-16 place-items-center rounded-full border-2 border-[#e4c274] bg-[#0b192b]/90 text-[#e4c274] shadow-[0_0_30px_rgba(228,194,116,0.3)] transition duration-300 hover:scale-110 hover:bg-[#0b192b]"
                    aria-label="Play construction update preview"
                  >
                    <Play className="ms-1 h-7 w-7 fill-current" />
                  </button>
                </div>

                <div className="absolute inset-x-4 bottom-4">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[#e4c274]">
                    <span>{latestUpdate.milestone}</span>
                    <span>•</span>
                    <span className="text-slate-300">{formatDate(latestUpdate.date, lang)}</span>
                    <span>•</span>
                    <span className="text-emerald-400">{latestUpdate.projectProgress}% {lang === 'fa' ? 'پیشرفت' : 'Progress'}</span>
                  </div>
                  <h3 className="mt-1 text-base font-extrabold text-white sm:text-lg">
                    {latestUpdate.title}
                  </h3>
                  <p className="mt-1 line-clamp-1 text-xs text-slate-300">
                    {latestUpdate.description}
                  </p>
                </div>
              </div>
            </div>
          </SectionCard>
        )}
      </div>

      {/* Published site updates archive */}
      <SectionCard
        title={lang === 'fa' ? 'گزارش‌ها و بروزرسانی‌های ویدیویی سایت' : 'Published Site Logs & Drone Updates'}
        eyebrow={lang === 'fa' ? 'آرشیو ماهانه' : 'Monthly Media Archive'}
        action={
          <span className="text-xs font-semibold text-slate-500">
            {updates.length} {lang === 'fa' ? 'گزارش ثبت‌شده' : 'broadcasts'}
          </span>
        }
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {updates.map((update) => (
            <div
              key={update.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-[#e4e7ec] bg-white transition duration-200 hover:border-[#c8a35b] hover:shadow-card"
            >
              <div className="relative h-40 w-full overflow-hidden bg-[#071322]">
                <img
                  src={update.thumbnailUrl}
                  alt={update.title}
                  className="h-full w-full object-cover opacity-75 transition duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#081525]/85 via-transparent to-transparent" />
                <span className="absolute bottom-2.5 start-2.5 rounded bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                  {lang === 'fa' ? '۰۲:۴۵' : '02:45'}
                </span>
                <span className="absolute end-2.5 top-2.5 rounded-full border border-emerald-300/40 bg-emerald-950/80 px-2 py-0.5 text-[10px] font-bold text-emerald-300 backdrop-blur-sm">
                  {update.projectProgress}% {lang === 'fa' ? 'پیشرفت' : 'Progress'}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedUpdate(update)}
                  className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  aria-label={`Play ${update.title}`}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-full bg-[#0b192b]/90 text-[#e4c274] shadow-lg">
                    <Play className="ms-0.5 h-5 w-5 fill-current" />
                  </span>
                </button>
              </div>

              <div className="flex flex-1 flex-col p-3.5">
                <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500">
                  <span className="rounded bg-[#f5efe0] px-2 py-0.5 font-bold text-[#8f6824]">{update.milestone}</span>
                  <span>{formatDate(update.date, lang)}</span>
                </div>
                <h4 className="mt-2 line-clamp-1 text-xs font-bold text-[#14233b]">{update.title}</h4>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{update.description}</p>
                <div className="mt-auto pt-3">
                  <button
                    type="button"
                    onClick={() => setSelectedUpdate(update)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#dfe4eb] py-1.5 text-xs font-bold text-[#203854] transition hover:border-[#c8a35b] hover:bg-[#faf7f0]"
                  >
                    <Play className="h-3.5 w-3.5 text-[#c8a35b]" />
                    {lang === 'fa' ? 'مشاهده و بررسی ویدیو' : 'Watch Broadcast Update'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Engineering milestone timeline */}
      <SectionCard
        title={lang === 'fa' ? 'جدول زمان‌بندی و نقاط عطف پروژه' : 'Engineering Milestones Timeline'}
        eyebrow={lang === 'fa' ? 'مدیریت اجرا' : 'Project Master Schedule'}
        action={
          <div className="flex items-center gap-1 rounded-lg border border-[#e4e7ec] bg-[#f7f8fa] p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setFilterMilestone('all')}
              className={`rounded px-2 py-1 font-bold ${filterMilestone === 'all' ? 'bg-white text-[#14233b] shadow-xs' : 'text-slate-500'}`}
            >
              {lang === 'fa' ? 'همه' : 'All'}
            </button>
            <button
              type="button"
              onClick={() => setFilterMilestone('published')}
              className={`rounded px-2 py-1 font-bold ${filterMilestone === 'published' ? 'bg-white text-[#14233b] shadow-xs' : 'text-slate-500'}`}
            >
              {lang === 'fa' ? 'منتشرشده' : 'Published'}
            </button>
            <button
              type="button"
              onClick={() => setFilterMilestone('draft')}
              className={`rounded px-2 py-1 font-bold ${filterMilestone === 'draft' ? 'bg-white text-[#14233b] shadow-xs' : 'text-slate-500'}`}
            >
              {lang === 'fa' ? 'پیش‌نویس' : 'Draft'}
            </button>
          </div>
        }
      >
        <div className="divide-y divide-[#edf0f4] p-2 sm:p-4">
          {filteredMilestones.map((m) => {
            const isComplete = m.status === 'complete'
            const isInProgress = m.status === 'in_progress'
            const Icon = isComplete ? CheckCircle2 : isInProgress ? Clock : Circle
            const iconColor = isComplete ? 'text-emerald-600 bg-emerald-50' : isInProgress ? 'text-amber-600 bg-amber-50' : 'text-slate-400 bg-slate-100'

            return (
              <div key={m.id} className="flex flex-col gap-3 py-3.5 transition sm:flex-row sm:items-center sm:justify-between sm:px-2 hover:bg-[#fafbfd]">
                <div className="flex items-start gap-3">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${iconColor}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-[#14233b]">{m.title}</span>
                      <span className="text-[10px] text-slate-400">• {formatDate(m.date, lang)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">{m.note}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 ps-11 sm:ps-0">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-[#edf0f4]">
                      <div
                        className={`h-full rounded-full ${isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-[#af8132] to-[#e4c274]'}`}
                        style={{ width: `${m.percent}%` }}
                      />
                    </div>
                    <span className="w-9 text-end font-mono text-xs font-bold text-[#14233b]">{m.percent}%</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => toggleMilestone(m)}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold transition ${
                      m.published
                        ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                    title={lang === 'fa' ? 'برای تغییر وضعیت انتشار کلیک کنید' : 'Click to toggle portal visibility'}
                  >
                    {m.published ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    {m.published ? (lang === 'fa' ? 'منتشرشده' : 'Published') : (lang === 'fa' ? 'پیش‌نویس' : 'Draft')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* Verified architectural imagery gallery */}
      <SectionCard
        title={lang === 'fa' ? 'گالری تصاویر معماری تاییدشده پروژه' : 'Verified Project Architectural Catalog'}
        eyebrow={lang === 'fa' ? 'مستندات تصویری مزار مال' : 'Official Supplied Renders'}
        action={
          <span className="text-xs font-semibold text-slate-500">
            {lang === 'fa' ? 'تصاویر با کیفیت بالا' : 'Supplied high-resolution client renders'}
          </span>
        }
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {gallery.map((item, index) => (
            <div
              key={index}
              className="group relative flex flex-col overflow-hidden rounded-xl border border-[#e4e7ec] bg-white transition hover:border-[#c8a35b]"
            >
              <div className="relative h-44 w-full overflow-hidden bg-[#071322]">
                <img
                  src={item.src}
                  alt={item.title}
                  className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#081525]/85 via-transparent to-transparent" />
                <button
                  type="button"
                  onClick={() => setLightboxImage(item)}
                  className="absolute bottom-2.5 end-2.5 grid h-8 w-8 place-items-center rounded-lg bg-black/60 text-white backdrop-blur-md transition hover:bg-[#c8a35b]"
                  aria-label={`Enlarge ${item.title}`}
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              </div>
              <div className="p-3">
                <h4 className="text-xs font-bold text-[#14233b]">{item.title}</h4>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Truthful demo update modal */}
      <Modal
        open={Boolean(selectedUpdate)}
        onClose={() => setSelectedUpdate(null)}
        title={selectedUpdate?.title}
        wide
      >
        {selectedUpdate && (
          <div className="space-y-4">
            <div className="relative overflow-hidden rounded-xl bg-[#081525]">
              <img
                src={selectedUpdate.thumbnailUrl}
                alt={selectedUpdate.title}
                className="max-h-72 w-full object-contain"
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="rounded-2xl border border-white/20 bg-[#0b192b]/90 p-4 text-center text-white backdrop-blur-md">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#e4c274] text-[#0b192b]">
                    <Play className="ms-0.5 h-6 w-6 fill-current" />
                  </div>
                  <p className="mt-2 text-xs font-bold uppercase tracking-wider text-[#e4c274]">
                    {lang === 'fa' ? 'پیش‌نمایش ویدیویی دمو' : 'Demonstration Video Player'}
                  </p>
                  <p className="mt-1 max-w-sm text-[11px] text-slate-300">
                    {lang === 'fa'
                      ? 'در نسخه عملیاتی، مدیریت هر ماه ویدیوی واقعی ساخت‌وساز را مستقیماً از کارگاه آپلود می‌کند.'
                      : 'In production, management uploads monthly high-definition site drone flights and walkthroughs for customer transparency.'}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[#e4e7ec] bg-[#f9fafc] p-4 text-xs text-[#203854]">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'نقطه عطف' : 'Milestone'}</span>
                  <span className="font-bold text-[#14233b]">{selectedUpdate.milestone}</span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'تاریخ ثبت' : 'Broadcast Date'}</span>
                  <span className="font-bold text-[#14233b]">{formatDate(selectedUpdate.date, lang)}</span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'پیشرفت ثبت‌شده' : 'Reported Progress'}</span>
                  <span className="font-bold text-emerald-700">{selectedUpdate.projectProgress}%</span>
                </div>
                <div>
                  <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'مدت زمان ویدیو' : 'Video Duration'}</span>
                  <span className="font-bold text-[#af8132]">{lang === 'fa' ? '۰۲:۴۵ (نمایشی)' : '02:45 (Demo)'}</span>
                </div>
              </div>

              <div className="mt-4 border-t border-[#e4e7ec] pt-3">
                <span className="block text-[10px] font-bold uppercase text-slate-400">{lang === 'fa' ? 'شرح و گزارش اجرایی' : 'Executive Description'}</span>
                <p className="mt-1 text-xs leading-relaxed text-slate-700">{selectedUpdate.description}</p>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <ActionButton variant="outline" onClick={() => setSelectedUpdate(null)}>
                {lang === 'fa' ? 'بستن' : 'Close'}
              </ActionButton>
            </div>
          </div>
        )}
      </Modal>

      {/* High-res image lightbox */}
      <Modal
        open={Boolean(lightboxImage)}
        onClose={() => setLightboxImage(null)}
        title={lightboxImage?.title}
        wide
      >
        {lightboxImage && (
          <div>
            <img
              src={lightboxImage.src}
              alt={lightboxImage.title}
              className="max-h-[75vh] w-full rounded-xl bg-[#081525] object-contain"
            />
            <p className="mt-3 text-xs text-slate-600">{lightboxImage.desc}</p>
            <div className="mt-4 flex justify-end">
              <ActionButton variant="outline" onClick={() => setLightboxImage(null)}>
                {lang === 'fa' ? 'بستن' : 'Close'}
              </ActionButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
