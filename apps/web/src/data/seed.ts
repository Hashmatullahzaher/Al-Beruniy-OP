import type { Block, ConstructionUpdate, Contract, Customer, DemoState, Floor, Installment, Organization, Payment, ProgressMilestone, Project, RoleConcept, Unit, UnitStatus } from './types'
import { planImageFor } from '@/lib/plans'

export const DEMO_TODAY = new Date('2026-09-13T00:00:00Z')
export const DEMO_TODAY_STR = '2026-09-13'
export const DEMO_YM = '2026-09'
export const DEMO_CURRENCY = 'AFN'
export const SCHEMA_VERSION = 9

const org: Organization = {
  id: 'al-biruni-demo', name: 'Al-Biruni Development',
  tagline: 'Configurable property platform · Demo organization',
}

const projects: Project[] = [
  { id: 'mazar-mall-demo', orgId: org.id, name: 'Mazar Mall — Demo', city: 'Mazar-i-Sharif', status: 'selling', currency: DEMO_CURRENCY, accent: '#c99a45', description: 'Client-confirmed presentation structure: 2 basements, 18 above-ground floors, commercial podium, amenities and a repeated residential typical floor.' },
  { id: 'future-residence-demo', orgId: org.id, name: 'Future Residence — Demo', city: 'Kabul', status: 'planning', currency: DEMO_CURRENCY, accent: '#56b4a8', description: 'Second synthetic project proving the platform is reusable and multi-project.' },
]

// ── Mazar Mall building ───────────────────────────────────────────────────────
const MAZAR_BLOCK = 'mazar-main'

const blocks: Block[] = [
  { id: MAZAR_BLOCK, projectId: 'mazar-mall-demo', name: 'Mazar Mall — Main Building', floors: 20, footprintM2: 1850, unitCount: 260, mix: 'Commercial podium · amenities · residential', heightM: 68 },
  { id: 'future-tower-1', projectId: 'future-residence-demo', name: 'Tower 1', floors: 10, footprintM2: 980, unitCount: 20, mix: 'Residential concept', heightM: 38 },
]

// Floor structure for Mazar Mall (client-confirmed)
const mazarFloors: Floor[] = [
  { id: 'mazar-fb2', blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: -2, label: 'B2', use: 'basement', name: 'Basement 2 · use to be confirmed' },
  { id: 'mazar-fb1', blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: -1, label: 'B1', use: 'basement', name: 'Basement 1 · use to be confirmed' },
  { id: 'mazar-f1', blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: 1, label: 'Floor 1', use: 'commercial', name: 'Commercial / shops' },
  { id: 'mazar-f2', blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: 2, label: 'Floor 2', use: 'commercial', name: 'Commercial / shops' },
  { id: 'mazar-f3', blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: 3, label: 'Floor 3', use: 'amenity', name: 'Amenities & hospitality' },
]
for (let f = 4; f <= 18; f += 1) {
  mazarFloors.push({ id: `mazar-f${f}`, blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', level: f, label: `Floor ${f}`, use: 'residential', name: 'Residential typical floor' })
}

const futureFloors: Floor[] = Array.from({ length: 10 }, (_, i) => ({
  id: `future-f${i + 1}`, blockId: 'future-tower-1', projectId: 'future-residence-demo', level: i + 1, label: `Floor ${i + 1}`, use: 'residential' as const, name: 'Residential',
}))

const floors: Floor[] = [...mazarFloors, ...futureFloors]

// Typical residential floor: 16 apartment zones (client-confirmed visible areas).
interface Slot { area: number; plan?: string }
const RES_SLOTS: Slot[] = [
  { area: 206, plan: 'C-3' }, { area: 180, plan: 'B-3' }, { area: 175 }, { area: 165 },
  { area: 165 }, { area: 155 }, { area: 147, plan: 'E-1' }, { area: 146, plan: 'D-2' },
  { area: 140, plan: 'C-2' }, { area: 138, plan: 'D-1' }, { area: 138, plan: 'D-1' }, { area: 137, plan: 'A-1' },
  { area: 135 }, { area: 124, plan: 'C-1' }, { area: 122 }, { area: 121, plan: 'B-1' },
]

const bedroomsForArea = (a: number) => (a >= 180 ? 4 : a >= 140 ? 3 : a >= 120 ? 2 : 1)

// Customer-linked units (by generated id)
const HZ_UNIT = 'mazar-res-14-01'
const AHMAD_UNIT = 'mazar-res-08-10'
const FATIMA_UNIT = 'mazar-res-07-16'
const SAHAR_UNIT = 'mazar-shop-02-03'

function makeMazarUnits(): Unit[] {
  const units: Unit[] = []

  // Commercial shops on Floors 1-2 (illustrative demo count; official count unconfirmed)
  for (const f of [1, 2]) {
    for (let i = 1; i <= 8; i += 1) {
      const id = `mazar-shop-${String(f).padStart(2, '0')}-${String(i).padStart(2, '0')}`
      const area = 42 + ((f * 7 + i * 11) % 9) * 9
      const roll = (f * 5 + i * 13) % 100
      const status: UnitStatus = roll < 60 ? 'available' : roll < 78 ? 'reserved' : roll < 92 ? 'under_contract' : 'sold'
      units.push({
        id, blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', floorId: `mazar-f${f}`,
        code: `S-${f}-${String(i).padStart(2, '0')}`, floor: f, kind: 'commercial',
        typeLabel: 'Retail Shop — Demo', areaM2: area, price: 6_000_000 + area * 40_000,
        status, saleable: true, view: 'Podium frontage',
      })
    }
  }

  // Amenities on Floor 3 (client-confirmed concepts, non-saleable)
  const amenities = ['Restaurant', 'Gym & Fitness', 'Recreation & Play Area', 'Sauna & Spa']
  amenities.forEach((name, i) => {
    units.push({
      id: `mazar-amenity-${i + 1}`, blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', floorId: 'mazar-f3',
      code: `A-3-${String(i + 1).padStart(2, '0')}`, floor: 3, kind: 'amenity',
      typeLabel: name, areaM2: 180 + i * 40, price: 0, status: 'on_hold', saleable: false, view: 'Amenity deck',
    })
  })

  // Residential typical floor repeated on Floors 4-18 → 16 × 15 = 240 units
  for (let f = 4; f <= 18; f += 1) {
    RES_SLOTS.forEach((slot, idx) => {
      const i = idx + 1
      const id = `mazar-res-${String(f).padStart(2, '0')}-${String(i).padStart(2, '0')}`
      const beds = bedroomsForArea(slot.area)
      const price = Math.round((slot.area * 58_000 * (1 + (f - 4) / 42)) / 1000) * 1000
      const roll = (f * 7 + i * 13) % 100
      let status: UnitStatus = roll < 55 ? 'available' : roll < 70 ? 'reserved' : roll < 85 ? 'under_contract' : roll < 95 ? 'sold' : 'on_hold'
      if ([HZ_UNIT, AHMAD_UNIT, FATIMA_UNIT].includes(id)) status = 'under_contract'
      units.push({
        id, blockId: MAZAR_BLOCK, projectId: 'mazar-mall-demo', floorId: `mazar-f${f}`,
        code: `${String(f).padStart(2, '0')}${String(i).padStart(2, '0')}`, floor: f, kind: 'residential',
        typeLabel: `${beds}-Bed Apartment`, areaM2: slot.area, bedrooms: beds, price,
        status, saleable: true, view: idx % 2 === 0 ? 'City view' : 'Courtyard view',
        planLabel: slot.plan, planImage: planImageFor(slot.plan),
      })
    })
  }

  return units
}

function makeFutureUnits(): Unit[] {
  return Array.from({ length: 20 }, (_, index) => {
    const floor = Math.floor(index / 2) + 1
    const suffix = (index % 2) + 1
    return {
      id: `future-tower-1-f${String(floor).padStart(2, '0')}-u${suffix}`,
      blockId: 'future-tower-1', projectId: 'future-residence-demo', floorId: `future-f${floor}`,
      code: `T1-${String(floor).padStart(2, '0')}-${suffix}`,
      floor, kind: 'residential', typeLabel: `${suffix === 1 ? 2 : 3}-Bed Apartment`, bedrooms: suffix === 1 ? 2 : 3,
      areaM2: 98 + suffix * 14, price: 5_000_000 + floor * 90_000, status: index < 4 ? 'reserved' : 'available', saleable: true, view: 'Garden view',
    } satisfies Unit
  })
}

const units = [...makeMazarUnits(), ...makeFutureUnits()]

// ── Customers (hero = Hashmatullah Zaher; contact details are safe placeholders) ─
const customers: Customer[] = [
  { id: 'hashmatullah-demo', projectId: 'mazar-mall-demo', name: 'Hashmatullah Zaher', kind: 'individual', code: 'MM-2026-0142', phone: '+93 7•• ••• ••• (demo)', whatsapp: '+93 7•• ••• ••• (demo)', email: 'owner@demo.mazarmall', address: 'To be provided — placeholder', occupation: 'Product Owner (demo)', since: '2025-12-15', agent: 'Sara Noori', avatarSeed: 'HZ', notes: 'Presentation hero customer · current-month installment paid. Contact details are placeholders until entered by the product owner.' },
  { id: 'ahmad-demo', projectId: 'mazar-mall-demo', name: 'Ahmad Wali', kind: 'individual', code: 'MM-2026-0088', phone: '+93 7•• ••• 903', whatsapp: '+93 7•• ••• 903', email: 'ahmad@example.demo', address: 'Demo address, Mazar-i-Sharif', occupation: 'Engineer (demo)', since: '2026-03-01', agent: 'Nadia Karimi', avatarSeed: 'AW', notes: 'Synthetic overdue example.' },
  { id: 'fatima-demo', projectId: 'mazar-mall-demo', name: 'Fatima Ahmadi', kind: 'individual', code: 'MM-2026-0061', phone: '+93 7•• ••• 587', whatsapp: '+93 7•• ••• 587', email: 'fatima@example.demo', address: 'Demo address, Mazar-i-Sharif', occupation: 'Physician (demo)', since: '2026-01-08', agent: 'Sara Noori', avatarSeed: 'FA', notes: 'Synthetic paid-ahead example.' },
  { id: 'sahar-demo', projectId: 'mazar-mall-demo', name: 'Sahar Trading Co.', kind: 'company', code: 'MM-2026-0033', phone: '+93 7•• ••• 220', whatsapp: '+93 7•• ••• 220', email: 'accounts@example.demo', address: 'Demo commercial address', occupation: 'Retail company (demo)', since: '2025-11-10', agent: 'Nadia Karimi', avatarSeed: 'ST', notes: 'Synthetic commercial buyer (retail shop).' },
]

type ScheduleConfig = { count: number; regularAmount: number; lastAmount?: number; firstDue: string; paidCount: number; overdueIndexes?: number[]; dueIndexes?: number[]; receiptPrefix: string; heroReceipt?: boolean }

function addMonth(isoDate: string, offset: number) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + offset)
  return date.toISOString().slice(0, 10)
}

function schedule(config: ScheduleConfig): Installment[] {
  return Array.from({ length: config.count }, (_, index) => {
    const no = index + 1
    const amount = no === config.count && config.lastAmount ? config.lastAmount : config.regularAmount
    const isPaid = index < config.paidCount
    const dueDate = addMonth(config.firstDue, index)
    const receiptId = isPaid ? (config.heroReceipt && no === 9 ? 'RCP-DEMO-2026-0901' : `${config.receiptPrefix}-${String(no).padStart(2, '0')}`) : undefined
    return {
      id: `${config.receiptPrefix.toLowerCase()}-${no}`, no, dueDate, amount,
      paid: isPaid ? amount : 0,
      status: isPaid ? 'paid' : config.overdueIndexes?.includes(index) ? 'overdue' : config.dueIndexes?.includes(index) ? 'due' : 'upcoming',
      paidDate: isPaid ? (no === 9 && config.heroReceipt ? '2026-09-01' : dueDate) : undefined,
      receiptId,
    }
  })
}

const contracts: Contract[] = [
  { id: 'hashmatullah-contract', projectId: 'mazar-mall-demo', customerId: 'hashmatullah-demo', unitId: HZ_UNIT, signedDate: '2025-12-15', totalPrice: 12_000_000, downPayment: 2_400_000, cadence: 'monthly', termMonths: 48, installments: schedule({ count: 48, regularAmount: 200_000, firstDue: '2026-01-15', paidCount: 9, receiptPrefix: 'RCP-HZ', heroReceipt: true }) },
  { id: 'ahmad-contract', projectId: 'mazar-mall-demo', customerId: 'ahmad-demo', unitId: AHMAD_UNIT, signedDate: '2026-03-01', totalPrice: 9_600_000, downPayment: 2_200_000, cadence: 'monthly', termMonths: 19, installments: schedule({ count: 19, regularAmount: 400_000, lastAmount: 200_000, firstDue: '2026-06-15', paidCount: 2, overdueIndexes: [2], dueIndexes: [3], receiptPrefix: 'RCP-AHMAD' }) },
  { id: 'fatima-contract', projectId: 'mazar-mall-demo', customerId: 'fatima-demo', unitId: FATIMA_UNIT, signedDate: '2026-01-08', totalPrice: 8_400_000, downPayment: 1_500_000, cadence: 'monthly', termMonths: 23, installments: schedule({ count: 23, regularAmount: 300_000, firstDue: '2026-08-15', paidCount: 2, receiptPrefix: 'RCP-FATIMA' }) },
  { id: 'sahar-contract', projectId: 'mazar-mall-demo', customerId: 'sahar-demo', unitId: SAHAR_UNIT, signedDate: '2025-11-10', totalPrice: 15_000_000, downPayment: 4_200_000, cadence: 'quarterly', termMonths: 27, installments: schedule({ count: 27, regularAmount: 400_000, firstDue: '2026-06-15', paidCount: 3, dueIndexes: [3], receiptPrefix: 'RCP-SAHAR' }) },
]

// Link customer units + set their price to the contract value
const unitContractValue: Record<string, string> = { [HZ_UNIT]: 'hashmatullah-demo', [AHMAD_UNIT]: 'ahmad-demo', [FATIMA_UNIT]: 'fatima-demo', [SAHAR_UNIT]: 'sahar-demo' }
units.forEach((unit) => {
  const custId = unitContractValue[unit.id]
  if (custId) {
    unit.customerId = custId
    unit.status = 'under_contract'
    const c = contracts.find((ct) => ct.customerId === custId)
    if (c) unit.price = c.totalPrice
  }
  // Illustrative room breakdown for residential units (demo)
  if (unit.kind === 'residential') {
    unit.bathrooms = unit.areaM2 >= 180 ? 3 : unit.areaM2 >= 130 ? 2 : 1
    unit.livingRooms = 1
  }
})

const payments: Payment[] = contracts.flatMap((contract) => {
  const paid = contract.installments.filter((item) => item.status === 'paid').map((item) => ({
    id: `${contract.id}-payment-${item.no}`, contractId: contract.id, customerId: contract.customerId,
    date: item.paidDate ?? item.dueDate, amount: item.paid, method: 'bank_transfer' as const,
    receiptId: item.receiptId ?? 'RCP-DEMO', installmentNo: item.no,
  }))
  return [{ id: `${contract.id}-down-payment`, contractId: contract.id, customerId: contract.customerId, date: contract.signedDate, amount: contract.downPayment, method: 'bank_transfer' as const, receiptId: `RCP-DOWN-${contract.customerId.toUpperCase()}`, installmentNo: 0 }, ...paid]
})

const progress: ProgressMilestone[] = [
  { id: 'progress-1', projectId: 'mazar-mall-demo', title: 'Foundation & basements — Demo', date: '2026-02-15', percent: 100, status: 'complete', note: 'Illustrative milestone for presentation only.', published: true },
  { id: 'progress-2', projectId: 'mazar-mall-demo', title: 'Structural frame to Floor 18 — Demo', date: '2026-07-30', percent: 72, status: 'in_progress', note: 'Synthetic progress value; not an engineering report.', published: true },
  { id: 'progress-3', projectId: 'mazar-mall-demo', title: 'Facade & podium fit-out — Demo', date: '2026-09-01', percent: 38, status: 'in_progress', note: 'Reference media placeholder for client validation.', published: true },
  { id: 'progress-4', projectId: 'future-residence-demo', title: 'Concept design — Demo', date: '2026-08-20', percent: 24, status: 'in_progress', note: 'Synthetic second-project milestone.', published: true },
]

// Published monthly construction updates (photo/video + milestone + %)
const constructionUpdates: ConstructionUpdate[] = [
  { id: 'cu-2026-05', projectId: 'mazar-mall-demo', title: 'May 2026 — Foundation & basements complete', date: '2026-05-20', thumbnailUrl: '/project/mazar-day.jpg', description: 'Raft foundation and both basement levels completed. Vertical structure started on the podium.', projectProgress: 30, milestone: 'Foundation', published: true },
  { id: 'cu-2026-06', projectId: 'mazar-mall-demo', title: 'June 2026 — Structure rising', date: '2026-06-25', thumbnailUrl: '/project/mazar-crown.jpg', description: 'Reinforced-concrete frame progressing steadily up the tower.', projectProgress: 45, milestone: 'Structure', published: true },
  { id: 'cu-2026-07', projectId: 'mazar-mall-demo', title: 'July 2026 — Structure topped out', date: '2026-07-28', thumbnailUrl: '/project/mazar-hero-night.jpg', description: 'Main structural frame reached Floor 18. Slab works finishing on upper levels.', projectProgress: 58, milestone: 'Structure', published: true },
  { id: 'cu-2026-08', projectId: 'mazar-mall-demo', title: 'August 2026 — Facade installation begins', date: '2026-08-24', thumbnailUrl: '/project/mazar-day.jpg', description: 'Curtain-wall and glazing installation started across the signature curved facade.', projectProgress: 64, milestone: 'Facade', published: true },
  { id: 'cu-2026-09', projectId: 'mazar-mall-demo', title: 'September 2026 — Facade & podium fit-out', date: '2026-09-10', thumbnailUrl: '/project/mazar-hero-night.jpg', description: 'Gold-accent facade nearing completion; commercial podium interior fit-out underway. Latest published update.', projectProgress: 70, milestone: 'Facade', published: true },
]

const roles: RoleConcept[] = [
  { id: 'role-manager', name: 'General Manager', scope: 'Organization', permissions: ['View portfolio', 'View finance', 'Use assistant'], members: 2 },
  { id: 'role-sales', name: 'Sales Officer', scope: 'Selected projects', permissions: ['View inventory', 'Manage customers'], members: 8 },
  { id: 'role-finance', name: 'Finance Officer', scope: 'Selected projects', permissions: ['View receivables', 'Issue receipts'], members: 4 },
]

export const PORTFOLIO_FIXTURE = { contractValue: 45_000_000, collected: 14_700_000, outstanding: 30_300_000, dueThisMonth: 800_000, overdue: 400_000 } as const

export function buildSeed(): DemoState {
  return { version: SCHEMA_VERSION, org, projects: structuredClone(projects), blocks: structuredClone(blocks), floors: structuredClone(floors), units: structuredClone(units), customers: structuredClone(customers), contracts: structuredClone(contracts), payments: structuredClone(payments), progress: structuredClone(progress), constructionUpdates: structuredClone(constructionUpdates), roles: structuredClone(roles), activeProjectId: 'mazar-mall-demo', portalCustomerId: 'hashmatullah-demo' }
}

export function statusCounts(list: Unit[]) {
  return list.reduce<Record<UnitStatus, number>>((counts, unit) => { counts[unit.status] += 1; return counts }, { available: 0, reserved: 0, under_contract: 0, sold: 0, on_hold: 0 })
}
