// ── Domain types for the presentation demo (synthetic data only) ──────────────

export type UnitStatus = 'available' | 'reserved' | 'under_contract' | 'sold' | 'on_hold'
export type UnitKind = 'residential' | 'commercial' | 'parking' | 'amenity'
export type FloorUse = 'basement' | 'commercial' | 'amenity' | 'residential' | 'parking' | 'mixed'

export interface Organization {
  id: string
  name: string
  tagline: string
}

export interface Project {
  id: string
  orgId: string
  name: string
  city: string
  status: 'active' | 'planning' | 'selling'
  description: string
  currency: string
  accent: string // hex accent for theming cards
  createdByUser?: boolean // local demo-added project
}

export interface Block {
  id: string
  projectId: string
  name: string // "Block A"
  floors: number
  footprintM2: number
  unitCount: number
  mix: string // e.g. "Residential + Retail"
  heightM: number
  createdByUser?: boolean
}

// A physical level within a block/building (basement, commercial, amenity, residential…)
export interface Floor {
  id: string
  blockId: string
  projectId: string
  level: number // -2 = B2, -1 = B1, 1..18 above ground
  label: string // "B2", "Floor 1"
  use: FloorUse
  name?: string // optional descriptive name, e.g. "Amenities & Hospitality"
  createdByUser?: boolean
}

export interface Unit {
  id: string
  blockId: string
  projectId: string
  floorId: string
  code: string // "1401" (demo/synthetic code)
  floor: number
  kind: UnitKind
  typeLabel: string // "3-Bed Apartment", "Retail Shop", ...
  areaM2: number
  price: number
  status: UnitStatus
  customerId?: string
  view?: string
  planLabel?: string // marketing plan label, e.g. "C-3"
  planImage?: string // /plans/c-3.jpg or an uploaded data URL
  bedrooms?: number
  bathrooms?: number
  livingRooms?: number
  saleable?: boolean
  createdByUser?: boolean
}

// A published monthly construction update (photo/video + milestone + %)
export interface ConstructionUpdate {
  id: string
  projectId: string
  title: string
  date: string // ISO
  thumbnailUrl: string
  videoUrl?: string // when present, a real clip; otherwise a demo-video modal
  description: string
  projectProgress: number
  milestone: string
  published: boolean
}

export interface Customer {
  id: string
  projectId: string
  name: string
  kind: 'individual' | 'company'
  code?: string // human-facing customer ID, e.g. "MM-2026-0142"
  phone: string // masked demo phone
  whatsapp?: string
  email: string
  address?: string
  occupation?: string
  photo?: string // uploaded data URL (optional)
  since: string // ISO date
  agent: string
  avatarSeed: string
  notes?: string
  createdByUser?: boolean
}

export interface Installment {
  id: string
  no: number
  dueDate: string // ISO
  amount: number
  paid: number
  status: 'paid' | 'due' | 'upcoming' | 'overdue' | 'partial'
  paidDate?: string
  receiptId?: string
}

export interface Contract {
  id: string
  projectId: string
  customerId: string
  unitId: string
  signedDate: string
  totalPrice: number
  downPayment: number
  cadence: 'monthly' | 'quarterly'
  termMonths: number
  installments: Installment[]
}

export type PaymentMethod = 'bank_transfer' | 'cash' | 'card_pos' | 'cheque' | 'other'

export interface Payment {
  id: string
  contractId: string
  customerId: string
  date: string
  amount: number
  method: PaymentMethod
  receiptId: string
  installmentNo: number
  reference?: string
  notes?: string
  previousBalance?: number
  newBalance?: number
}

export interface ProgressMilestone {
  id: string
  projectId: string
  title: string
  date: string
  percent: number
  status: 'complete' | 'in_progress' | 'planned'
  note: string
  published: boolean
}

export interface RoleConcept {
  id: string
  name: string
  scope: string
  permissions: string[]
  members: number
}

export interface DemoState {
  version: number
  org: Organization
  projects: Project[]
  blocks: Block[]
  floors: Floor[]
  units: Unit[]
  customers: Customer[]
  contracts: Contract[]
  payments: Payment[]
  progress: ProgressMilestone[]
  constructionUpdates: ConstructionUpdate[]
  roles: RoleConcept[]
  activeProjectId: string
  portalCustomerId: string
}
