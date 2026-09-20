import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import {
  ArrowUpRight, Banknote, Bath, BedDouble, Building2, CalendarDays, Check,
  ChevronDown, ClipboardList,
  FileBarChart, Maximize2, Play, Plus, UserPlus, Users,
  WalletCards, Car,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { SectionCard } from '@/components/ui'
import { CustomerFormModal } from '@/components/CustomerFormModal'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import { Modal } from '@/components/Modal'
import type { Payment } from '@/data/types'

const SUMMARY_COLORS_CUSTOMERS = ['#10b981', '#0ea5e9', '#f59e0b', '#94a3b8']
const SUMMARY_COLORS_CONTRACTS = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444']

export function Dashboard() {
  const { lang } = useI18n()
  const state = useStore()
  const navigate = useNavigate()
  const isDari = lang === 'fa'
  const projectId = state.activeProjectId
  const project = state.projects.find((item) => item.id === projectId) ?? state.projects[0]

  const [customerOpen, setCustomerOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [floorPlanModalOpen, setFloorPlanModalOpen] = useState(false)
  const [videoModalOpen, setVideoModalOpen] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState<Payment | null>(null)
  const [selectedBlock, setSelectedBlock] = useState('Block A')

  // Customer Summary Breakdown matching screenshot (128 total: 96 Active, 18 Pending, 8 Cancelled, 6 Others)
  const customerBreakdown = [
    { name: isDari ? 'فعال (96)' : 'Active (96)', fa: 'فعال', value: 96 },
    { name: isDari ? 'در انتظار (18)' : 'Pending (18)', fa: 'در انتظار', value: 18 },
    { name: isDari ? 'لغو شده (8)' : 'Cancelled (8)', fa: 'لغو شده', value: 8 },
    { name: isDari ? 'سایر (6)' : 'Others (6)', fa: 'سایر', value: 6 },
  ]

  // Contract Status Breakdown matching screenshot (96 total: 68 Active, 14 Draft, 10 Completed, 4 Terminated)
  const contractBreakdown = [
    { name: isDari ? 'فعال (68)' : 'Active (68)', fa: 'فعال', value: 68 },
    { name: isDari ? 'پیش‌نویس (14)' : 'Draft (14)', fa: 'پیش نویس', value: 14 },
    { name: isDari ? 'تکمیل شده (10)' : 'Completed (10)', fa: 'تکمیل شده', value: 10 },
    { name: isDari ? 'فسخ شده (4)' : 'Terminated (4)', fa: 'فسخ شده', value: 4 },
  ]

  // Exact Featured Units from screenshot
  const screenshotUnits = [
    {
      id: 'unit-c3',
      name: 'Block C - Unit 3',
      area: 206,
      beds: 4,
      baths: 3,
      parking: 1,
      price: '$ 310,000',
      status: 'Available',
      statusFa: 'موجود',
      statusTone: 'emerald',
      image: '/plans/c-1.jpg',
    },
    {
      id: 'unit-a1',
      name: 'Block A - Unit 1',
      area: 137,
      beds: 3,
      baths: 2,
      parking: 1,
      price: '$ 205,000',
      status: 'Reserved',
      statusFa: 'رزرو شده',
      statusTone: 'amber',
      image: '/plans/a-1.jpg',
    },
    {
      id: 'unit-d2',
      name: 'Block D - Unit 2',
      area: 146,
      beds: 3,
      baths: 2,
      parking: 1,
      price: '$ 218,000',
      status: 'Available',
      statusFa: 'موجود',
      statusTone: 'emerald',
      image: '/plans/d-1.jpg',
    },
  ]

  // Exact Recent Receipts matching screenshot
  const screenshotReceipts = [
    { id: 'rec-1', date: '26 Aug 2025', dateFa: '۴ سنبله ۱۴۰۴', customer: 'Ahmad Noori', customerFa: 'احمد نوری', unit: 'A-101', amount: '$ 25,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-2', date: '25 Aug 2025', dateFa: '۳ سنبله ۱۴۰۴', customer: 'Fatima Azizi', customerFa: 'فاطمه عزیزی', unit: 'C-304', amount: '$ 40,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-3', date: '24 Aug 2025', dateFa: '۲ سنبله ۱۴۰۴', customer: 'Khalid Rahimi', customerFa: 'خالد رحیمی', unit: 'B-201', amount: '$ 15,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-4', date: '23 Aug 2025', dateFa: '۱ سنبله ۱۴۰۴', customer: 'Zahra Mohammadi', customerFa: 'زهرا محمدی', unit: 'D-502', amount: '$ 30,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-5', date: '22 Aug 2025', dateFa: '۳۱ اسد ۱۴۰۴', customer: 'Ahmad Sediqi', customerFa: 'احمد صدیقی', unit: 'A-705', amount: '$ 20,000', status: 'Received', statusFa: 'وصول شد' },
  ]

  // Exact Payment Schedule matching screenshot
  const screenshotSchedule = [
    { id: 'sch-1', unit: 'A-101', customer: 'Ahmad Noori', customerFa: 'احمد نوری', nextDate: '01 Sep 2025', nextDateFa: '۱۰ سنبله ۱۴۰۴', amount: '$ 25,000', status: 'Upcoming', statusFa: 'آینده' },
    { id: 'sch-2', unit: 'C-304', customer: 'Fatima Azizi', customerFa: 'فاطمه عزیزی', nextDate: '05 Sep 2025', nextDateFa: '۱۴ سنبله ۱۴۰۴', amount: '$ 40,000', status: 'Upcoming', statusFa: 'آینده' },
    { id: 'sch-3', unit: 'B-201', customer: 'Khalid Rahimi', customerFa: 'خالد رحیمی', nextDate: '10 Sep 2025', nextDateFa: '۱۹ سنبله ۱۴۰۴', amount: '$ 15,000', status: 'Upcoming', statusFa: 'آینده' },
    { id: 'sch-4', unit: 'D-502', customer: 'Zahra Mohammadi', customerFa: 'زهرا محمدی', nextDate: '15 Sep 2025', nextDateFa: '۲۴ سنبله ۱۴۰۴', amount: '$ 30,000', status: 'Upcoming', statusFa: 'آینده' },
    { id: 'sch-5', unit: 'A-705', customer: 'Ahmad Sediqi', customerFa: 'احمد صدیقی', nextDate: '20 Sep 2025', nextDateFa: '۲۹ سنبله ۱۴۰۴', amount: '$ 20,000', status: 'Upcoming', statusFa: 'آینده' },
  ]

  const handlePaymentSuccess = (payment: Payment) => {
    setSelectedPayment(payment)
    setReceiptOpen(true)
  }

  const openSampleReceipt = (receipt: typeof screenshotReceipts[0]) => {
    const mockPayment: Payment = {
      id: receipt.id,
      contractId: 'contract-demo',
      customerId: 'cust-demo',
      amount: parseInt(receipt.amount.replace(/[^0-9]/g, ''), 10),
      date: '2025-08-26',
      method: 'bank_transfer',
      receiptId: `RCP-${receipt.unit}-2025`,
      installmentNo: 1,
      reference: `RCP-${receipt.unit}-2025`,
      notes: `Voucher for Unit ${receipt.unit}`,
    }
    setSelectedPayment(mockPayment)
    setReceiptOpen(true)
  }

  if (!project) return null

  return (
    <div className="space-y-4 pb-6">
      {/* TOP ROW: HERO + CURRENT PROJECT + DATE */}
      <div className="grid gap-3 xl:grid-cols-[1.65fr_1fr]">
        {/* HERO CARD */}
        <motion.section
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative min-h-[260px] overflow-hidden rounded-2xl bg-[#081028] text-white shadow-[0_12px_34px_rgba(8,16,40,.24)] sm:min-h-[300px]"
        >
          <img
            src="/assets/al-beruniy-background.jpg"
            alt="Mazar Mall Architectural Panorama"
            className="absolute inset-0 h-full w-full object-cover object-center brightness-[0.82] contrast-[1.08]"
          />
          {/* Subtle Dark Vignette Gradients */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#081028]/95 via-[#081028]/60 to-transparent rtl:bg-gradient-to-l" />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#081028] via-[#081028]/70 to-transparent" />

          <div className="relative flex h-full min-h-[260px] flex-col justify-between p-5 sm:min-h-[300px] sm:p-7">
            {/* Top Row of Hero */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="font-display text-3xl font-black leading-tight tracking-tight text-white sm:text-5xl drop-shadow-md">
                  Mazar Mall
                </h1>
                <p className="mt-1 font-dari text-lg font-bold text-[#EBD9B4] sm:text-2xl drop-shadow-sm">
                  یک مقصد نمادین در مزارشریف
                </p>
                <p className="mt-0.5 text-xs font-semibold text-slate-200 sm:text-sm tracking-wide">
                  An Iconic Destination in Mazar-e-Sharif
                </p>
                <div className="mt-3 h-1 w-12 rounded-full bg-gradient-to-r from-[#C5A880] to-[#DFCA95]" />
              </div>

              {/* Tagline on Top Right */}
              <div className="hidden text-end sm:block max-w-[240px]">
                <p className="font-display text-sm font-extrabold text-white leading-snug">
                  More Than A Building
                </p>
                <p className="font-display text-sm font-extrabold text-[#DFCA95]">
                  A Better Tomorrow
                </p>
                <p className="mt-1 text-[11px] font-medium text-slate-300" dir="rtl">
                  فراتر از یک ساختمان، آینده‌ای بهتر
                </p>
              </div>
            </div>

            {/* Bottom Row of Hero: Mixed Use Pill */}
            <div className="flex flex-wrap items-end justify-between gap-3 pt-4">
              <div className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-white/20 bg-[#081028]/70 px-3.5 py-1.5 backdrop-blur-md">
                <span className="text-xs font-extrabold text-[#DFCA95]">
                  {isDari ? 'پروژه چند منظوره' : 'Mixed-Use Development'}
                </span>
                <span className="text-white/40">|</span>
                <span className="text-xs text-slate-200">
                  {isDari ? 'مسکونی | تجاری | زندگی مدرن' : 'Residential · Commercial · Modern Living'}
                </span>
              </div>

              <Link
                to="/app/projects"
                className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-3.5 py-2 text-xs font-bold text-white backdrop-blur-md transition hover:bg-white/20"
              >
                <span>{isDari ? 'مشاهده جزئیات پروژه' : 'Project Details'}</span>
                <ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100 text-[#DFCA95]" />
              </Link>
            </div>
          </div>
        </motion.section>

        {/* RIGHT COLUMN: CURRENT PROJECT + DATE CARDS */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          {/* Current Project Card */}
          <SectionCard
            title={
              <span className="flex items-center justify-between text-xs font-extrabold text-[#14233b]">
                <span>Current Project</span>
                <span className="font-normal text-slate-400">| پروژه فعلی</span>
              </span>
            }
            className="min-h-[125px]"
          >
            <div className="flex items-center gap-3.5 p-3.5">
              <img
                src="/project/mazar-crown.jpg"
                alt="Mazar Mall"
                className="h-16 w-24 shrink-0 rounded-xl object-cover shadow-sm border border-slate-200"
              />
              <div className="min-w-0 flex-1">
                <div className="relative">
                  <select
                    value={projectId}
                    onChange={(e) => state.setActiveProject(e.target.value)}
                    aria-label="Current Project"
                    className="w-full cursor-pointer appearance-none bg-transparent pr-6 text-base font-extrabold text-[#14233b] outline-none"
                  >
                    {state.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute end-0 top-1.5 h-4 w-4 text-slate-400" />
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">Mazar-e-Sharif · مزار شریف</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wide">
                    Active Development
                  </span>
                </div>
              </div>
            </div>
          </SectionCard>

          {/* Date Card */}
          <SectionCard className="min-h-[125px]">
            <div className="flex h-full min-h-[110px] items-center gap-3.5 p-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#f5ecd8] to-[#eedcb0] text-[#967232] shadow-sm">
                <CalendarDays className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-extrabold text-[#14233b]">
                  Tue, 26 Aug 2025
                </p>
                <p className="mt-0.5 font-dari text-xs font-bold text-[#967232]">
                  سه‌شنبه، ۴ سنبله ۱۴۰۴
                </p>
                <p className="mt-1 text-[10px] text-slate-400">
                  Solar Hijri & Gregorian Synchronized
                </p>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>

      {/* KPI METRICS ROW: 4 STAT TILES */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Total Units */}
        <StatTile
          icon={<Building2 />}
          titleEn="Total Units"
          titleFa="مجموع واحدها"
          value="156"
          badge="↑ 100%"
          iconTone="blue"
        />

        {/* Customers */}
        <StatTile
          icon={<Users />}
          titleEn="Customers"
          titleFa="مشتریان"
          value="128"
          badge="↑ +12%"
          iconTone="sky"
        />

        {/* Active Contracts */}
        <StatTile
          icon={<ClipboardList />}
          titleEn="Active Contracts"
          titleFa="قرارداد های فعال"
          value="96"
          badge="↑ +8%"
          iconTone="gold"
        />

        {/* Total Receipts */}
        <StatTile
          icon={<WalletCards />}
          titleEn="Total Receipts"
          titleFa="مجموع وصولی ها"
          value="$ 8.4M"
          badge="↑ +15%"
          iconTone="green"
        />
      </div>

      {/* 4 ACTION BUTTONS ROW */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => setCustomerOpen(true)}
          className="flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-[#c89c4d] px-3.5 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:bg-[#b68738] active:scale-[0.99]"
        >
          <UserPlus className="h-4 w-4" />
          <span>+ Add Customer <span className="font-normal opacity-90">| ثبت مشتری</span></span>
        </button>

        <button
          type="button"
          onClick={() => navigate('/app/inventory')}
          className="flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-[#14233b] px-3.5 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:bg-[#0c1728] active:scale-[0.99]"
        >
          <Plus className="h-4 w-4" />
          <span>+ Add Unit <span className="font-normal opacity-90">| ثبت واحد</span></span>
        </button>

        <button
          type="button"
          onClick={() => setPaymentOpen(true)}
          className="flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-[#10b981] px-3.5 py-2.5 text-xs font-extrabold text-white shadow-sm transition hover:bg-[#059669] active:scale-[0.99]"
        >
          <Banknote className="h-4 w-4" />
          <span>$ Record Payment <span className="font-normal opacity-90">| ثبت پرداخت</span></span>
        </button>

        <button
          type="button"
          onClick={() => navigate('/app/reports')}
          className="flex min-h-[46px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-extrabold text-[#14233b] shadow-sm transition hover:bg-slate-50 hover:border-slate-400 active:scale-[0.99]"
        >
          <FileBarChart className="h-4 w-4 text-slate-500" />
          <span>View Reports <span className="font-normal text-slate-500">| مشاهده گزارش ها</span></span>
        </button>
      </div>

      {/* MIDDLE ROW: FLOOR STRUCTURE + FEATURED UNITS + RECENT RECEIPTS */}
      <div className="grid gap-3.5 xl:grid-cols-[1fr_1.3fr_1.1fr]">
        {/* Floor Structure */}
        <SectionCard
          title={
            <div className="flex items-center justify-between gap-2">
              <span className="font-extrabold text-[#14233b]">
                Floor Structure <span className="text-slate-400 font-normal">| ساختار طبقات</span>
              </span>
            </div>
          }
          action={
            <select
              value={selectedBlock}
              onChange={(e) => setSelectedBlock(e.target.value)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-[#14233b] outline-none"
            >
              <option value="Block A">Block A</option>
              <option value="Block B">Block B</option>
              <option value="Block C">Block C</option>
              <option value="Block D">Block D</option>
            </select>
          }
        >
          <div className="grid gap-3 p-3 sm:grid-cols-[1fr_140px]">
            {/* Blueprint preview */}
            <div className="relative min-h-[210px] overflow-hidden rounded-xl border border-slate-200 bg-[#f4f4f2]">
              <img
                src="/plans/a-1.jpg"
                alt="Floor Plan Structure"
                className="h-full min-h-[210px] w-full object-contain p-2 hover:scale-105 transition duration-300"
              />
              <span className="absolute start-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-[10px] font-bold text-[#14233b] shadow-sm">
                12 Floors · طبقه ۱۲
              </span>
            </div>

            {/* Legend */}
            <div className="flex flex-col justify-between">
              <div>
                <p className="text-base font-black text-[#14233b]">12 Floors</p>
                <p className="text-[10px] text-slate-400 font-medium">طبقه 12</p>

                <div className="mt-2.5 space-y-1.5 text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="flex-1 text-slate-600">4 Bedroom</span>
                    <span className="text-[10px] text-slate-400 font-dari">چهار خواب</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-sky-500 shrink-0" />
                    <span className="flex-1 text-slate-600">3 Bedroom</span>
                    <span className="text-[10px] text-slate-400 font-dari">سه خواب</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500 shrink-0" />
                    <span className="flex-1 text-slate-600">2 Bedroom</span>
                    <span className="text-[10px] text-slate-400 font-dari">دو خواب</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-purple-500 shrink-0" />
                    <span className="flex-1 text-slate-600">1 Bedroom</span>
                    <span className="text-[10px] text-slate-400 font-dari">یک خواب</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-500 shrink-0" />
                    <span className="flex-1 text-slate-600">Commercial</span>
                    <span className="text-[10px] text-slate-400 font-dari">تجاری</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-slate-400 shrink-0" />
                    <span className="flex-1 text-slate-600">Services</span>
                    <span className="text-[10px] text-slate-400 font-dari">خدمات</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setFloorPlanModalOpen(true)}
                className="mt-3 flex items-center justify-between rounded-xl bg-[#c89c4d] px-3 py-2 text-[10px] font-extrabold text-white transition hover:bg-[#b68738]"
              >
                <span>View Full Floor Plan <span className="font-normal opacity-90">| پلان کامل</span></span>
                <Maximize2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        </SectionCard>

        {/* Featured Units */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Featured Units <span className="text-slate-400 font-normal">| واحد های ویژه</span>
            </span>
          }
          action={
            <Link to="/app/inventory" className="text-[11px] font-bold text-[#2f69aa] hover:underline">
              View All Units <span className="font-normal">| مشاهده همه</span>
            </Link>
          }
        >
          <div className="grid gap-2.5 p-3 sm:grid-cols-3">
            {screenshotUnits.map((u) => (
              <article
                key={u.id}
                onClick={() => navigate('/app/inventory')}
                className="group cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-white transition hover:shadow-md hover:border-[#c89c4d]/50"
              >
                <div className="h-28 bg-[#f6f6f4] p-2 overflow-hidden">
                  <img
                    src={u.image}
                    alt={u.name}
                    className="h-full w-full object-contain transition duration-300 group-hover:scale-105"
                  />
                </div>
                <div className="p-2.5">
                  <p className="truncate text-xs font-black text-[#14233b]">{u.name}</p>
                  <p className="text-[10px] font-semibold text-slate-500">{u.area} m²</p>

                  <div className="mt-1.5 flex items-center gap-2 text-slate-600">
                    <span className="inline-flex items-center gap-0.5 text-[9px]">
                      <BedDouble className="h-3 w-3 text-slate-400" /> {u.beds}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[9px]">
                      <Bath className="h-3 w-3 text-slate-400" /> {u.baths}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[9px]">
                      <Car className="h-3 w-3 text-slate-400" /> {u.parking}
                    </span>
                  </div>

                  <p className="mt-2 text-xs font-black text-[#14233b]">{u.price}</p>
                  <p className="mt-1 flex items-center gap-1 text-[9px] font-bold">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        u.statusTone === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500'
                      }`}
                    />
                    <span className={u.statusTone === 'emerald' ? 'text-emerald-700' : 'text-amber-700'}>
                      {u.status} <span className="font-normal opacity-80">({u.statusFa})</span>
                    </span>
                  </p>
                </div>
              </article>
            ))}
          </div>
        </SectionCard>

        {/* Recent Receipts */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Recent Receipts <span className="text-slate-400 font-normal">| آخرین وصولی ها</span>
            </span>
          }
          action={
            <Link to="/app/finance" className="text-[11px] font-bold text-[#2f69aa] hover:underline">
              View All <span className="font-normal">| مشاهده همه</span>
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[10px] font-extrabold uppercase text-slate-500">
                  <th className="p-2.5 text-start">Date <span className="font-normal opacity-75">تاریخ</span></th>
                  <th className="p-2.5 text-start">Customer <span className="font-normal opacity-75">مشتری</span></th>
                  <th className="p-2.5 text-start">Unit <span className="font-normal opacity-75">واحد</span></th>
                  <th className="p-2.5 text-start">Amount <span className="font-normal opacity-75">مبلغ</span></th>
                  <th className="p-2.5 text-start">Status <span className="font-normal opacity-75">وضعیت</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {screenshotReceipts.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => openSampleReceipt(r)}
                    className="cursor-pointer transition hover:bg-slate-50/80"
                  >
                    <td className="p-2.5 text-slate-600 font-medium whitespace-nowrap">{r.date}</td>
                    <td className="p-2.5 font-bold text-[#14233b] whitespace-nowrap">{r.customer}</td>
                    <td className="p-2.5 text-slate-600 font-semibold">{r.unit}</td>
                    <td className="p-2.5 font-black text-[#14233b] whitespace-nowrap">{r.amount}</td>
                    <td className="p-2.5">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-extrabold text-emerald-700">
                        <Check className="h-2.5 w-2.5" />
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      {/* BOTTOM ROW: CUSTOMER SUMMARY + CONTRACT STATUS + PAYMENT SCHEDULE + CONSTRUCTION PROGRESS */}
      <div className="grid gap-3.5 lg:grid-cols-2 xl:grid-cols-[0.9fr_0.9fr_1.35fr_1.1fr]">
        {/* Customer Summary Donut */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Customer Summary <span className="text-slate-400 font-normal">| خلاصه مشتریان</span>
            </span>
          }
        >
          <div className="grid min-h-[190px] grid-cols-[125px_1fr] items-center p-3">
            <div className="relative h-[126px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={customerBreakdown}
                    dataKey="value"
                    innerRadius={42}
                    outerRadius={58}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {customerBreakdown.map((item, index) => (
                      <Cell key={item.name} fill={SUMMARY_COLORS_CUSTOMERS[index % SUMMARY_COLORS_CUSTOMERS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e1e5eb', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
                <strong className="font-display text-xl font-black text-[#14233b]">128</strong>
                <span className="text-[9px] font-bold text-slate-400">Customers</span>
                <span className="text-[8px] font-medium text-slate-400">مشتری</span>
              </div>
            </div>
            <div className="space-y-1.5 ps-2">
              {customerBreakdown.map((item, index) => (
                <div key={item.name} className="flex items-center gap-2 text-[11px]">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: SUMMARY_COLORS_CUSTOMERS[index % SUMMARY_COLORS_CUSTOMERS.length] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-600">{item.name}</span>
                  <span className="text-[10px] text-slate-400 font-dari">{item.fa}</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>

        {/* Contract Status Donut */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Contract Status <span className="text-slate-400 font-normal">| وضعیت قرارداد ها</span>
            </span>
          }
        >
          <div className="grid min-h-[190px] grid-cols-[125px_1fr] items-center p-3">
            <div className="relative h-[126px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={contractBreakdown}
                    dataKey="value"
                    innerRadius={42}
                    outerRadius={58}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {contractBreakdown.map((item, index) => (
                      <Cell key={item.name} fill={SUMMARY_COLORS_CONTRACTS[index % SUMMARY_COLORS_CONTRACTS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e1e5eb', fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
                <strong className="font-display text-xl font-black text-[#14233b]">96</strong>
                <span className="text-[9px] font-bold text-slate-400">Contracts</span>
                <span className="text-[8px] font-medium text-slate-400">قرارداد</span>
              </div>
            </div>
            <div className="space-y-1.5 ps-2">
              {contractBreakdown.map((item, index) => (
                <div key={item.name} className="flex items-center gap-2 text-[11px]">
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: SUMMARY_COLORS_CONTRACTS[index % SUMMARY_COLORS_CONTRACTS.length] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-600">{item.name}</span>
                  <span className="text-[10px] text-slate-400 font-dari">{item.fa}</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>

        {/* Payment Schedule Table */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Payment Schedule <span className="text-slate-400 font-normal">| جدول پرداخت ها</span>
            </span>
          }
          action={
            <Link to="/app/finance" className="text-[11px] font-bold text-[#2f69aa] hover:underline">
              View All <span className="font-normal">| مشاهده همه</span>
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70 text-[10px] font-extrabold uppercase text-slate-500">
                  <th className="p-2.5 text-start">Unit <span className="font-normal opacity-75">واحد</span></th>
                  <th className="p-2.5 text-start">Customer <span className="font-normal opacity-75">مشتری</span></th>
                  <th className="p-2.5 text-start">Next Payment <span className="font-normal opacity-75">پرداخت بعدی</span></th>
                  <th className="p-2.5 text-start">Amount <span className="font-normal opacity-75">مبلغ</span></th>
                  <th className="p-2.5 text-start">Status <span className="font-normal opacity-75">وضعیت</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {screenshotSchedule.map((s) => (
                  <tr key={s.id} className="transition hover:bg-slate-50/80">
                    <td className="p-2.5 font-bold text-[#14233b]">{s.unit}</td>
                    <td className="p-2.5 text-slate-700 font-semibold whitespace-nowrap">{s.customer}</td>
                    <td className="p-2.5 text-slate-600 whitespace-nowrap">{s.nextDate}</td>
                    <td className="p-2.5 font-black text-[#14233b] whitespace-nowrap">{s.amount}</td>
                    <td className="p-2.5">
                      <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[9px] font-extrabold text-sky-700">
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* Construction Progress Card */}
        <SectionCard
          title={
            <span className="font-extrabold text-[#14233b]">
              Construction Progress <span className="text-slate-400 font-normal">| پیشرفت پروژه</span>
            </span>
          }
          action={
            <Link to="/app/construction" className="text-[11px] font-bold text-[#2f69aa] hover:underline">
              View All <span className="font-normal">| مشاهده همه</span>
            </Link>
          }
        >
          <div className="p-3 space-y-2.5">
            {/* Video preview banner */}
            <div
              onClick={() => setVideoModalOpen(true)}
              className="group relative h-[142px] cursor-pointer overflow-hidden rounded-xl border border-slate-200 bg-[#081028] shadow-sm"
            >
              <img
                src="/project/mazar-hero-night.jpg"
                alt="Construction progress preview"
                className="h-full w-full object-cover opacity-75 transition duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#081028]/90 via-[#081028]/30 to-transparent" />

              {/* Play Button Overlay */}
              <div className="absolute inset-0 grid place-content-center">
                <span className="grid h-12 w-12 place-items-center rounded-full border-2 border-white bg-white/30 text-white shadow-md backdrop-blur-sm transition group-hover:scale-110 group-hover:bg-white/40">
                  <Play className="h-5 w-5 fill-white text-white ms-0.5" />
                </span>
              </div>

              {/* Title Overlay */}
              <div className="absolute inset-x-3 bottom-2.5 flex items-end justify-between">
                <div>
                  <p className="text-xs font-extrabold text-white">Latest Progress - August 2025</p>
                  <p className="text-[10px] font-medium text-slate-300" dir="rtl">آخرین پیشرفت - اسد ۱۴۰۴</p>
                </div>
                <span className="rounded-md bg-[#C5A880] px-2 py-0.5 text-[10px] font-black text-[#081028]">
                  48%
                </span>
              </div>
            </div>

            {/* Thumbnail carousel */}
            <div className="grid grid-cols-4 gap-1.5">
              <img
                src="/project/construction-progress-march2025.png"
                alt="Site progress 1"
                className="h-10 w-full rounded-lg object-cover border border-slate-200"
              />
              <img
                src="/project/mazar-day.jpg"
                alt="Site progress 2"
                className="h-10 w-full rounded-lg object-cover border border-slate-200"
              />
              <img
                src="/project/mazar-crown.jpg"
                alt="Site progress 3"
                className="h-10 w-full rounded-lg object-cover border border-slate-200"
              />
              <img
                src="/project/mazar-hero-night.jpg"
                alt="Site progress 4"
                className="h-10 w-full rounded-lg object-cover border border-slate-200"
              />
            </div>
          </div>
        </SectionCard>
      </div>

      {/* FULL FLOOR PLAN MODAL */}
      <Modal
        open={floorPlanModalOpen}
        onClose={() => setFloorPlanModalOpen(false)}
        title={isDari ? 'پلان معماری و تفصیلی طبقات — مزار مال' : 'Architectural Floor Plan Blueprint — Mazar Mall'}
        wide
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 text-xs">
            <span className="font-bold text-[#14233b]">Selected: {selectedBlock} · Typical Residential Floor</span>
            <span className="text-slate-500">Scale 1:100 · High-Resolution Architectural Vector</span>
          </div>
          <div className="max-h-[68vh] overflow-auto rounded-xl border border-slate-200 bg-[#fbfbfa] p-4 text-center">
            <img
              src="/plans/a-1.jpg"
              alt="Architectural Blueprint High Res"
              className="mx-auto max-h-[60vh] object-contain shadow-sm"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setFloorPlanModalOpen(false)}
              className="rounded-xl bg-[#14233b] px-4 py-2 text-xs font-bold text-white hover:bg-[#0c1728]"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {/* VIDEO PREVIEW MODAL */}
      <Modal
        open={videoModalOpen}
        onClose={() => setVideoModalOpen(false)}
        title={isDari ? 'ویدیوی پیشرفت فیزیکی ساخت — اسد ۱۴۰۴' : 'Physical Construction Progress Video — August 2025'}
        wide
      >
        <div className="space-y-4">
          <div className="relative aspect-video overflow-hidden rounded-2xl bg-[#081028]">
            <img
              src="/project/mazar-hero-night.jpg"
              alt="Video Poster"
              className="h-full w-full object-cover opacity-80"
            />
            <div className="absolute inset-0 grid place-content-center text-center p-6 bg-[#081028]/60 backdrop-blur-sm text-white">
              <Play className="mx-auto h-16 w-16 text-[#DFCA95] mb-3" />
              <h3 className="text-lg font-extrabold">Site Engineering Drone Inspection Reel</h3>
              <p className="mt-1 text-xs text-slate-300 max-w-md">
                Recorded on site at Mazar-e-Sharif project perimeter. Tower A & C structural core completed to Floor 12.
              </p>
            </div>
          </div>
          <div className="flex justify-between items-center text-xs text-slate-500">
            <span>Overall Progress: 48% Verified</span>
            <button
              type="button"
              onClick={() => setVideoModalOpen(false)}
              className="rounded-xl bg-[#14233b] px-4 py-2 text-xs font-bold text-white hover:bg-[#0c1728]"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>

      {/* INTERACTIVE MODALS */}
      <CustomerFormModal
        open={customerOpen}
        mode="add"
        onClose={() => setCustomerOpen(false)}
        onSaved={(id) => navigate(`/app/customers/${id}`)}
      />
      <RecordPaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        initialCustomerId="hashmatullah-demo"
        onPaymentSuccess={handlePaymentSuccess}
      />
      <ReceiptModal
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        payment={selectedPayment}
      />
    </div>
  )
}

function StatTile({
  icon,
  titleEn,
  titleFa,
  value,
  badge,
  iconTone,
}: {
  icon: ReactNode
  titleEn: string
  titleFa: string
  value: string
  badge: string
  iconTone: 'blue' | 'sky' | 'gold' | 'green'
}) {
  const iconTones = {
    blue: 'bg-[#dceafd] text-[#2869aa]',
    sky: 'bg-[#e2efff] text-[#285ea6]',
    gold: 'bg-[#fbefca] text-[#9d711e]',
    green: 'bg-[#d8f0e3] text-[#198754]',
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card flex min-h-[108px] items-center justify-between p-4 bg-white rounded-2xl border border-slate-200/80 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl [&>svg]:h-6 [&>svg]:w-6 ${iconTones[iconTone]}`}>
          {icon}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-bold text-slate-700">{titleEn}</p>
          <p className="truncate font-dari text-[10px] text-slate-400">{titleFa}</p>
          <p className="mt-1 truncate font-display text-2xl font-black text-[#14233b]">{value}</p>
        </div>
      </div>

      <span className="self-start rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700">
        {badge}
      </span>
    </motion.div>
  )
}
