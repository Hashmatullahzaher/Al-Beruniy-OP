import { create } from 'zustand'
import type { Block, Contract, Customer, DemoState, Floor, Installment, Payment, PaymentMethod, Project, Unit } from '@/data/types'
import { buildSeed, SCHEMA_VERSION } from '@/data/seed'
import { contractSummary } from '@/lib/selectors'

const STORAGE_KEY = 'mazar-demo-state-v5'

function load(): DemoState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState
      if (parsed.version === SCHEMA_VERSION) return parsed
    }
  } catch {
    /* ignore corrupt/unavailable storage */
  }
  return buildSeed()
}

function persist(state: DemoState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore (quota / unavailable) */
  }
}

const rid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export interface RecordPaymentParams {
  contractId: string
  customerId: string
  amount: number
  date: string
  method: PaymentMethod
  reference?: string
  notes?: string
}

interface StoreActions {
  setActiveProject: (id: string) => void
  addProject: (p: Omit<Project, 'id' | 'orgId'>) => string
  updateProject: (id: string, patch: Partial<Project>) => void
  addBlock: (b: Omit<Block, 'id' | 'projectId'>) => string
  updateBlock: (id: string, patch: Partial<Block>) => void
  addFloor: (blockId: string, f: Omit<Floor, 'id' | 'projectId' | 'blockId'>) => string
  updateFloor: (id: string, patch: Partial<Floor>) => void
  addUnit: (u: Omit<Unit, 'id'>) => string
  updateUnit: (id: string, patch: Partial<Unit>) => void
  addCustomer: (c: Omit<Customer, 'id'>) => string
  updateCustomer: (id: string, patch: Partial<Customer>) => void
  setCustomerPhoto: (id: string, dataUrl: string | undefined) => void
  recordDemoPayment: (contractId: string, installmentNo: number) => void
  recordPayment: (params: RecordPaymentParams) => { payment: Payment; receiptId: string }
  resetDemo: () => void
}

export type Store = DemoState & StoreActions

export const useStore = create<Store>((set, get) => ({
  ...load(),

  setActiveProject: (id) => set(() => {
    const next = { ...get(), activeProjectId: id }
    persist(next)
    return { activeProjectId: id }
  }),

  addProject: (p) => {
    const id = rid('prj-user')
    const project: Project = { ...p, id, orgId: get().org.id, createdByUser: true }
    const projects = [...get().projects, project]
    persist({ ...get(), projects, activeProjectId: id })
    set({ projects, activeProjectId: id })
    return id
  },

  updateProject: (id, patch) => {
    const projects = get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p))
    persist({ ...get(), projects }); set({ projects })
  },

  addBlock: (b) => {
    const projectId = get().activeProjectId
    const id = rid(`${projectId}-blk`)
    const block: Block = { ...b, id, projectId, createdByUser: true }
    const blocks = [...get().blocks, block]
    persist({ ...get(), blocks }); set({ blocks })
    return id
  },

  updateBlock: (id, patch) => {
    const blocks = get().blocks.map((bl) => (bl.id === id ? { ...bl, ...patch } : bl))
    persist({ ...get(), blocks }); set({ blocks })
  },

  addFloor: (blockId, f) => {
    const block = get().blocks.find((b) => b.id === blockId)
    const projectId = block?.projectId ?? get().activeProjectId
    const id = rid(`${blockId}-floor`)
    const floor: Floor = { ...f, id, blockId, projectId, createdByUser: true }
    const floors = [...get().floors, floor]
    persist({ ...get(), floors }); set({ floors })
    return id
  },

  updateFloor: (id, patch) => {
    const floors = get().floors.map((fl) => (fl.id === id ? { ...fl, ...patch } : fl))
    persist({ ...get(), floors }); set({ floors })
  },

  addUnit: (u) => {
    const id = rid('unit-user')
    const unit: Unit = { ...u, id, createdByUser: true }
    const units = [...get().units, unit]
    persist({ ...get(), units }); set({ units })
    return id
  },

  updateUnit: (id, patch) => {
    const units = get().units.map((un) => (un.id === id ? { ...un, ...patch } : un))
    persist({ ...get(), units }); set({ units })
  },

  addCustomer: (c) => {
    const id = rid('cust-user')
    const customer: Customer = { ...c, id, createdByUser: true }
    const customers = [...get().customers, customer]
    persist({ ...get(), customers }); set({ customers })
    return id
  },

  updateCustomer: (id, patch) => {
    const customers = get().customers.map((cu) => (cu.id === id ? { ...cu, ...patch } : cu))
    persist({ ...get(), customers }); set({ customers })
  },

  setCustomerPhoto: (id, dataUrl) => {
    const customers = get().customers.map((cu) => (cu.id === id ? { ...cu, photo: dataUrl } : cu))
    persist({ ...get(), customers }); set({ customers })
  },

  recordDemoPayment: (contractId, installmentNo) => {
    const contracts = get().contracts.map((c) => {
      if (c.id !== contractId) return c
      const installments = c.installments.map((inst) => {
        if (inst.no !== installmentNo) return inst
        return {
          ...inst, paid: inst.amount, status: 'paid' as const,
          paidDate: '2026-09-13', receiptId: `RCPT-DEMO-${Date.now().toString().slice(-4)}`,
        }
      })
      return { ...c, installments }
    })
    persist({ ...get(), contracts }); set({ contracts })
  },

  recordPayment: ({ contractId, customerId, amount, date, method, reference, notes }) => {
    const current = get()
    const contract = current.contracts.find((c) => c.id === contractId)
    if (!contract) throw new Error('Contract not found')

    const summaryBefore = contractSummary(contract)
    const previousBalance = summaryBefore.remaining
    const newBalance = Math.max(0, previousBalance - amount)

    const dateStamp = date.replace(/-/g, '')
    const randSeq = Math.floor(1000 + Math.random() * 9000)
    const receiptId = `RCP-DEMO-${dateStamp}-${randSeq}`

    let remainingToAllocate = amount
    let primaryInstallmentNo = 1

    const updatedInstallments = contract.installments.map((inst) => {
      const unpaidInInst = inst.amount - inst.paid
      if (unpaidInInst > 0 && remainingToAllocate > 0) {
        if (!primaryInstallmentNo || primaryInstallmentNo === 1) {
          primaryInstallmentNo = inst.no
        }
        const alloc = Math.min(unpaidInInst, remainingToAllocate)
        const newPaid = inst.paid + alloc
        remainingToAllocate -= alloc
        const isFullyPaid = newPaid >= inst.amount
        return {
          ...inst,
          paid: newPaid,
          status: (isFullyPaid ? 'paid' : 'partial') as Installment['status'],
          paidDate: isFullyPaid ? date : inst.paidDate,
          receiptId: isFullyPaid ? receiptId : inst.receiptId,
        }
      }
      return inst
    })

    const updatedContract: Contract = { ...contract, installments: updatedInstallments }

    const newPayment: Payment = {
      id: `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      contractId, customerId, date, amount, method, receiptId,
      installmentNo: primaryInstallmentNo,
      reference: reference?.trim() || undefined,
      notes: notes?.trim() || undefined,
      previousBalance, newBalance,
    }

    const contracts = current.contracts.map((c) => (c.id === contractId ? updatedContract : c))
    const payments = [newPayment, ...current.payments]

    persist({ ...current, contracts, payments })
    set({ contracts, payments })

    return { payment: newPayment, receiptId }
  },

  resetDemo: () => {
    localStorage.removeItem(STORAGE_KEY)
    const seed = buildSeed()
    persist(seed)
    set({ ...seed })
  },
}))
