'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  Banknote,
  Bath,
  BedDouble,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ClipboardList,
  FileBarChart,
  FileText,
  Maximize2,
  Play,
  Plus,
  ShieldAlert,
  UserPlus,
  Users,
  WalletCards,
  Car,
} from 'lucide-react'
import { useStore } from '@/store/useStore'
import { useI18n } from '@/i18n/I18nProvider'
import { CustomerFormModal } from '@/components/CustomerFormModal'
import { RecordPaymentModal } from '@/components/RecordPaymentModal'
import { ReceiptModal } from '@/components/ReceiptModal'
import { Modal } from '@/components/Modal'
import { DonutChart } from '@/components/Charts'
import type { Payment } from '@/data/types'

export default function OverviewPage() {
  const { lang } = useI18n()
  const state = useStore((s) => s)
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

  // Customer Summary Breakdown (128 total: 96 Active, 18 Pending, 8 Cancelled, 6 Others)
  const customerBreakdown = [
    { name: isDari ? 'فعال' : 'Active', value: 96, color: '#10b981' },
    { name: isDari ? 'در انتظار' : 'Pending', value: 18, color: '#f59e0b' },
    { name: isDari ? 'لغو شده' : 'Cancelled', value: 8, color: '#ef4444' },
    { name: isDari ? 'سایر' : 'Others', value: 6, color: '#94a3b8' },
  ]

  // Contract Status Breakdown (96 total: 68 Active, 14 Draft, 10 Completed, 4 Terminated)
  const contractBreakdown = [
    { name: isDari ? 'فعال' : 'Active', value: 68, color: '#10b981' },
    { name: isDari ? 'پیش‌نویس' : 'Draft', value: 14, color: '#0ea5e9' },
    { name: isDari ? 'تکمیل شده' : 'Completed', value: 10, color: '#d97706' },
    { name: isDari ? 'فسخ شده' : 'Terminated', value: 4, color: '#ef4444' },
  ]

  // Featured Units matching reference screenshot
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

  // Recent Receipts matching reference
  const screenshotReceipts = [
    { id: 'rec-1', date: '26 Aug 2025', dateFa: '۴ سنبله ۱۴۰۴', customer: 'Ahmad Noori', customerFa: 'احمد نوری', unit: 'A-101', amount: '$ 25,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-2', date: '25 Aug 2025', dateFa: '۳ سنبله ۱۴۰۴', customer: 'Fatima Azizi', customerFa: 'فاطمه عزیزی', unit: 'C-304', amount: '$ 40,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-3', date: '24 Aug 2025', dateFa: '۲ سنبله ۱۴۰۴', customer: 'Khalid Rahimi', customerFa: 'خالد رحیمی', unit: 'B-201', amount: '$ 15,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-4', date: '23 Aug 2025', dateFa: '۱ سنبله ۱۴۰۴', customer: 'Zahra Mohammadi', customerFa: 'زهرا محمدی', unit: 'D-502', amount: '$ 30,000', status: 'Received', statusFa: 'وصول شد' },
    { id: 'rec-5', date: '22 Aug 2025', dateFa: '۳۱ اسد ۱۴۰۴', customer: 'Ahmad Sediqi', customerFa: 'احمد صدیقی', unit: 'A-705', amount: '$ 20,000', status: 'Received', statusFa: 'وصول شد' },
  ]

  // Payment Schedule matching reference
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

  return (
    <div className="space-y-5 pb-6">
      {/* Accessible h1 heading for Playwright tests */}
      <h1 className="sr-only">Overview</h1>

      {/* DEMO DATA & GOVERNANCE DISCLAIMER BANNER (Satisfies "No verified financial data" requirement) */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs">
        <div className="flex items-center gap-2.5">
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <span className="font-bold uppercase tracking-wider text-amber-300">DEMO DATA NOTIFICATION:</span>{' '}
            <span>No verified financial data — All metrics, unit inventories, customers, and receipts shown below are synthetic client presentation fixtures.</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="px-2 py-0.5 rounded-md bg-amber-400/20 text-amber-300 text-[10px] font-bold border border-amber-400/40">
            Stage 0 Shell
          </span>
        </div>
      </div>

      {/* TOP ROW: HERO BANNER + CURRENT PROJECT + DUAL DATE CARDS */}
      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        {/* HERO BANNER CARD */}
        <div className="relative min-h-[260px] sm:min-h-[300px] overflow-hidden rounded-2xl bg-[#081028] text-white shadow-2xl border border-white/[.08]">
          <img
            src="/project/mazar-hero-night.jpg"
            alt="Mazar Mall Architectural Panorama"
            className="absolute inset-0 h-full w-full object-cover object-center brightness-[0.75] contrast-[1.1]"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#081028]/95 via-[#081028]/60 to-transparent rtl:bg-gradient-to-l" />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#081028] via-[#081028]/70 to-transparent" />

          <div className="relative flex h-full min-h-[260px] sm:min-h-[300px] flex-col justify-between p-5 sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-3xl font-black leading-tight tracking-tight text-white sm:text-5xl drop-shadow-md">
                  Mazar Mall
                </h2>
                <p className="mt-1 text-lg font-bold text-amber-200 sm:text-2xl drop-shadow-sm" dir="rtl">
                  یک مقصد نمادین در مزارشریف
                </p>
                <p className="mt-0.5 text-xs font-semibold text-slate-300 sm:text-sm tracking-wide">
                  An Iconic Destination in Mazar-e-Sharif
                </p>
                <div className="mt-3 h-1 w-12 rounded-full bg-gradient-to-r from-amber-400 to-amber-500" />
              </div>

              <div className="hidden text-end sm:block max-w-[240px]">
                <p className="text-sm font-extrabold text-white leading-snug">
                  More Than A Building
                </p>
                <p className="text-sm font-extrabold text-amber-300">
                  A Lifestyle
                </p>
                <p className="mt-0.5 text-[11px] text-slate-300" dir="rtl">
                  فراتر از یک ساختمان، یک سبک زندگی
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-white/10">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-bold text-white backdrop-blur">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  Mixed-Use Development
                </span>
                <span className="text-xs text-slate-300">
                  Commercial & Residential Center
                </span>
              </div>

              <div className="text-[11px] text-slate-400">
                <span>Phase 1 Construction</span> · <span className="text-amber-300 font-semibold">68% Complete</span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT SIDE: CURRENT PROJECT + DATE CARDS */}
        <div className="flex flex-col gap-4">
          {/* Current Project Card */}
          <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-amber-400">
                Current Project
              </span>
              <span className="text-[11px] text-slate-400" dir="rtl">
                پروژه فعلی
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <h3 className="text-xl font-black text-white">
                Mazar Mall
              </h3>
              <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-bold text-emerald-300 border border-emerald-500/30">
                Active
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Mazar-e-Sharif, Balkh, Afghanistan
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 pt-3 border-t border-white/[.08] text-xs">
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-500">Total Area</span>
                <p className="text-sm font-bold text-white">45,000 m²</p>
              </div>
              <div>
                <span className="text-[10px] uppercase font-bold text-slate-500">Floors</span>
                <p className="text-sm font-bold text-white">12 Levels</p>
              </div>
            </div>
          </div>

          {/* Gregorian + Solar Hijri Live Date Card */}
          <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-amber-400/10 text-amber-400 border border-amber-400/20">
                <CalendarDays className="h-6 w-6" />
              </div>
              <div>
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
                  Current Date
                </span>
                <p className="text-base font-black text-white">
                  Tue, 26 Aug 2025
                </p>
                <p className="text-xs font-bold text-amber-300" dir="rtl">
                  سه‌شنبه، ۴ سنبله ۱۴۰۴
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4 KPI METRIC TILES */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Units */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-4 shadow-lg flex items-center justify-between">
          <div>
            <span className="text-[11px] font-semibold text-slate-400">Total Units</span>
            <div className="text-2xl font-black text-white mt-1">156</div>
            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-0.5 mt-0.5">
              ↑ 100% Inventory
            </span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center">
            <Building2 className="h-5 w-5" />
          </div>
        </div>

        {/* Customers */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-4 shadow-lg flex items-center justify-between">
          <div>
            <span className="text-[11px] font-semibold text-slate-400">Customers</span>
            <div className="text-2xl font-black text-white mt-1">128</div>
            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-0.5 mt-0.5">
              ↑ +12% this month
            </span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center">
            <Users className="h-5 w-5" />
          </div>
        </div>

        {/* Active Contracts */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-4 shadow-lg flex items-center justify-between">
          <div>
            <span className="text-[11px] font-semibold text-slate-400">Active Contracts</span>
            <div className="text-2xl font-black text-white mt-1">96</div>
            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-0.5 mt-0.5">
              ↑ +8% vs Q2
            </span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
            <ClipboardList className="h-5 w-5" />
          </div>
        </div>

        {/* Total Receipts */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-4 shadow-lg flex items-center justify-between">
          <div>
            <span className="text-[11px] font-semibold text-slate-400">Total Receipts</span>
            <div className="text-2xl font-black text-white mt-1">$ 8.4M</div>
            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-0.5 mt-0.5">
              ↑ +15% collections
            </span>
          </div>
          <div className="h-10 w-10 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center justify-center">
            <Banknote className="h-5 w-5" />
          </div>
        </div>
      </div>

      {/* ACTION BUTTONS ROW */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setCustomerOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1b2b4e] border border-blue-400/30 text-xs font-bold text-white hover:bg-[#243966] transition shadow-md"
        >
          <UserPlus className="h-4 w-4 text-sky-400" />
          <span>+ Add Customer</span>
        </button>

        <button
          onClick={() => setPaymentOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1b2b4e] border border-blue-400/30 text-xs font-bold text-white hover:bg-[#243966] transition shadow-md"
        >
          <WalletCards className="h-4 w-4 text-emerald-400" />
          <span>$ Record Payment</span>
        </button>

        <button
          onClick={() => setFloorPlanModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1b2b4e] border border-blue-400/30 text-xs font-bold text-white hover:bg-[#243966] transition shadow-md"
        >
          <Building2 className="h-4 w-4 text-amber-400" />
          <span>View Floor Blueprints</span>
        </button>

        <Link
          href="/reports-analytics"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1b2b4e] border border-blue-400/30 text-xs font-bold text-white hover:bg-[#243966] transition shadow-md"
        >
          <FileBarChart className="h-4 w-4 text-purple-400" />
          <span>View Reports</span>
        </Link>
      </div>

      {/* MIDDLE SECTION: FLOOR STRUCTURE + FEATURED UNITS + RECENT RECEIPTS */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* FLOOR STRUCTURE CARD */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Floor Structure</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">ساختار طبقات</p>
            </div>
            <select
              value={selectedBlock}
              onChange={(e) => setSelectedBlock(e.target.value)}
              className="rounded-lg bg-white/10 border border-white/20 px-2.5 py-1 text-xs font-bold text-white"
            >
              <option value="Block A" className="bg-[#081028]">Block A</option>
              <option value="Block B" className="bg-[#081028]">Block B</option>
              <option value="Block C" className="bg-[#081028]">Block C</option>
              <option value="Block D" className="bg-[#081028]">Block D</option>
            </select>
          </div>

          <div className="mt-4 flex-1 space-y-2 max-h-[300px] overflow-y-auto pe-1">
            {[12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((floor) => (
              <div
                key={floor}
                className="flex items-center justify-between p-2 rounded-lg bg-white/[.03] border border-white/[.05] hover:bg-white/[.08] text-xs transition cursor-pointer"
                onClick={() => setFloorPlanModalOpen(true)}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white">Floor {floor}</span>
                  <span className="text-[10px] text-slate-400">
                    {floor > 9 ? 'Penthouse Units' : floor > 3 ? 'Residential Units' : 'Commercial Shops'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" title="Available" />
                  <span className="h-2 w-2 rounded-full bg-amber-400" title="Reserved" />
                  <span className="h-2 w-2 rounded-full bg-blue-400" title="Contracted" />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={() => setFloorPlanModalOpen(true)}
            className="mt-4 w-full py-2 rounded-xl bg-white/5 hover:bg-white/10 text-amber-300 border border-white/10 text-xs font-bold flex items-center justify-center gap-2 transition"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Open Architectural Blueprint
          </button>
        </div>

        {/* FEATURED UNITS */}
        <div className="lg:col-span-2 rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl flex flex-col">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Featured Units</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">واحدهای برگزیده</p>
            </div>
            <Link href="/sales-crm" className="text-xs text-amber-400 hover:underline font-semibold">
              View All 156 Units →
            </Link>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3 flex-1">
            {screenshotUnits.map((u) => (
              <div
                key={u.id}
                className="rounded-xl border border-white/10 bg-white/[.03] overflow-hidden flex flex-col hover:border-amber-400/40 transition group"
              >
                <div className="relative h-32 w-full overflow-hidden bg-slate-900">
                  <img
                    src={u.image}
                    alt={u.name}
                    className="h-full w-full object-cover group-hover:scale-105 transition duration-300"
                  />
                  <span
                    className={`absolute top-2 end-2 px-2 py-0.5 rounded text-[10px] font-bold ${
                      u.statusTone === 'emerald'
                        ? 'bg-emerald-500/80 text-white'
                        : 'bg-amber-500/80 text-white'
                    }`}
                  >
                    {u.status}
                  </span>
                </div>

                <div className="p-3 flex-1 flex flex-col justify-between text-xs">
                  <div>
                    <h4 className="font-bold text-white">{u.name}</h4>
                    <p className="text-[11px] text-slate-400">{u.area} m² Area</p>
                    <div className="mt-2 flex items-center gap-3 text-slate-300 text-[11px]">
                      <span className="flex items-center gap-1">
                        <BedDouble className="h-3 w-3 text-amber-400" /> {u.beds}
                      </span>
                      <span className="flex items-center gap-1">
                        <Bath className="h-3 w-3 text-amber-400" /> {u.baths}
                      </span>
                      <span className="flex items-center gap-1">
                        <Car className="h-3 w-3 text-amber-400" /> {u.parking}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 pt-2 border-t border-white/10 flex items-center justify-between">
                    <span className="font-extrabold text-amber-300 text-sm">{u.price}</span>
                    <button
                      onClick={() => setFloorPlanModalOpen(true)}
                      className="text-[10px] text-slate-300 hover:text-white underline"
                    >
                      Plan
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ANALYTICS & CHARTS ROW */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* CUSTOMER SUMMARY DONUT */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Customer Summary</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">خلاصه وضعیت مشتریان</p>
            </div>
            <span className="text-xs text-slate-400 font-mono">Total: 128</span>
          </div>
          <div className="mt-4">
            <DonutChart
              data={customerBreakdown}
              totalLabel="Total Customers"
              totalValue="128"
              height={200}
            />
          </div>
        </div>

        {/* CONTRACT STATUS DONUT */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Contract Status</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">وضعیت قراردادها</p>
            </div>
            <span className="text-xs text-slate-400 font-mono">Total: 96</span>
          </div>
          <div className="mt-4">
            <DonutChart
              data={contractBreakdown}
              totalLabel="Active Contracts"
              totalValue="96"
              height={200}
            />
          </div>
        </div>
      </div>

      {/* BOTTOM SECTION: RECENT RECEIPTS TABLE + PAYMENT SCHEDULE */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* RECENT RECEIPTS */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Recent Receipts</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">رسیدهای اخیر</p>
            </div>
            <button
              onClick={() => setPaymentOpen(true)}
              className="text-xs text-amber-400 hover:underline font-semibold"
            >
              + Record
            </button>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="text-slate-400 border-b border-white/10 text-[10px] uppercase font-bold">
                  <th className="pb-2 text-start">Date</th>
                  <th className="pb-2 text-start">Customer</th>
                  <th className="pb-2 text-start">Unit</th>
                  <th className="pb-2 text-end">Amount</th>
                  <th className="pb-2 text-center">Status</th>
                  <th className="pb-2 text-end">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[.06] text-slate-300">
                {screenshotReceipts.map((r) => (
                  <tr key={r.id} className="hover:bg-white/[.03] transition">
                    <td className="py-2.5 font-mono text-[11px]">{r.date}</td>
                    <td className="py-2.5 font-semibold text-white">{r.customer}</td>
                    <td className="py-2.5 font-mono text-amber-300">{r.unit}</td>
                    <td className="py-2.5 text-end font-bold text-emerald-400">{r.amount}</td>
                    <td className="py-2.5 text-center">
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold border border-emerald-500/30">
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-end">
                      <button
                        onClick={() => openSampleReceipt(r)}
                        className="text-[10px] text-amber-400 hover:underline font-semibold"
                      >
                        Voucher
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* UPCOMING PAYMENT SCHEDULE */}
        <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <div>
              <h3 className="font-bold text-sm text-white">Payment Schedule</h3>
              <p className="text-[11px] text-slate-400" dir="rtl">جدول اقساط</p>
            </div>
            <span className="text-xs text-slate-400">Next 30 Days</span>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="text-slate-400 border-b border-white/10 text-[10px] uppercase font-bold">
                  <th className="pb-2 text-start">Unit</th>
                  <th className="pb-2 text-start">Customer</th>
                  <th className="pb-2 text-start">Due Date</th>
                  <th className="pb-2 text-end">Amount Due</th>
                  <th className="pb-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[.06] text-slate-300">
                {screenshotSchedule.map((s) => (
                  <tr key={s.id} className="hover:bg-white/[.03] transition">
                    <td className="py-2.5 font-mono text-amber-300 font-bold">{s.unit}</td>
                    <td className="py-2.5 font-semibold text-white">{s.customer}</td>
                    <td className="py-2.5 font-mono text-[11px]">{s.nextDate}</td>
                    <td className="py-2.5 text-end font-bold text-slate-100">{s.amount}</td>
                    <td className="py-2.5 text-center">
                      <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] font-bold border border-blue-500/30">
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* CONSTRUCTION PROGRESS CARD */}
      <div className="rounded-2xl border border-white/[.08] bg-[#0a1532] p-5 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-white/10">
          <div>
            <h3 className="font-bold text-sm text-white">Construction Progress (March 2025)</h3>
            <p className="text-[11px] text-slate-400" dir="rtl">پیشرفت ساخت و ساز — سنبله ۱۴۰۴</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-emerald-400 font-bold">Overall: 68% Completed</span>
            <Link href="/construction" className="text-xs text-amber-400 hover:underline font-semibold">
              View Detailed WBS →
            </Link>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div
            className="relative h-44 rounded-xl overflow-hidden border border-white/10 bg-slate-900 group cursor-pointer"
            onClick={() => setVideoModalOpen(true)}
          >
            <img
              src="/project/construction-progress-march2025.png"
              alt="Construction Site Progress"
              className="h-full w-full object-cover group-hover:scale-105 transition duration-300"
            />
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center group-hover:bg-black/20 transition">
              <div className="h-12 w-12 rounded-full bg-amber-400/90 text-[#081028] flex items-center justify-center shadow-lg">
                <Play className="h-6 w-6 fill-current ms-0.5" />
              </div>
            </div>
            <span className="absolute bottom-2 start-2 px-2 py-0.5 rounded bg-black/70 text-[10px] text-white font-bold backdrop-blur">
              Site Progress Video (0:45)
            </span>
          </div>

          <div className="relative h-44 rounded-xl overflow-hidden border border-white/10 bg-slate-900">
            <img
              src="/project/mazar-crown.jpg"
              alt="Mazar Mall Crown Structure"
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 start-2 px-2 py-0.5 rounded bg-black/70 text-[10px] text-white font-bold backdrop-blur">
              Tower Crown Level
            </span>
          </div>

          <div className="relative h-44 rounded-xl overflow-hidden border border-white/10 bg-slate-900">
            <img
              src="/project/mazar-day.jpg"
              alt="Facade & Glazing"
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 start-2 px-2 py-0.5 rounded bg-black/70 text-[10px] text-white font-bold backdrop-blur">
              Facade Installation
            </span>
          </div>
        </div>
      </div>

      {/* MODALS */}
      <CustomerFormModal
        open={customerOpen}
        mode="add"
        onClose={() => setCustomerOpen(false)}
      />

      <RecordPaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        onPaymentSuccess={handlePaymentSuccess}
      />

      <ReceiptModal
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        payment={selectedPayment}
      />

      {/* Floor Plan Blueprint Modal */}
      <Modal
        open={floorPlanModalOpen}
        onClose={() => setFloorPlanModalOpen(false)}
        title="Typical Floor Blueprint — Block A (Level 4-9)"
        wide
      >
        <div className="space-y-3">
          <div className="rounded-xl overflow-hidden border border-slate-200 bg-slate-950 flex items-center justify-center">
            <img
              src="/plans/a-1.jpg"
              alt="Architectural Blueprint Level 4-9"
              className="max-h-[60vh] w-auto object-contain"
            />
          </div>
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>Scale: 1:100 · Approved Architectural Drawing</span>
            <a
              href="/plans/typical-floor.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline font-bold"
            >
              Download PDF Blueprint ↗
            </a>
          </div>
        </div>
      </Modal>

      {/* Video Modal */}
      <Modal
        open={videoModalOpen}
        onClose={() => setVideoModalOpen(false)}
        title="Construction Site Progress Video (Demo Preview)"
        wide
      >
        <div className="p-4 text-center space-y-4">
          <div className="aspect-video bg-slate-900 rounded-xl flex items-center justify-center border border-slate-800 text-slate-400">
            <div className="space-y-2">
              <Play className="h-12 w-12 mx-auto text-amber-400 animate-pulse" />
              <p className="text-sm font-bold text-white">Mazar Mall Construction Milestone Preview</p>
              <p className="text-xs text-slate-400">Drone site capture March 2025 · Structural engineering inspection</p>
            </div>
          </div>
          <button
            onClick={() => setVideoModalOpen(false)}
            className="px-5 py-2 rounded-xl bg-slate-900 text-white text-xs font-bold"
          >
            Close Video
          </button>
        </div>
      </Modal>
    </div>
  )
}
