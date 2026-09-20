'use client'

import { useSyncExternalStore } from 'react'
import type { Block, Contract, Customer, DemoState, Floor, Installment, Payment, PaymentMethod, Project, Unit } from '@/data/types'
import { buildSeed, SCHEMA_VERSION } from '@/data/seed'
import { contractSummary } from '@/lib/selectors'

const STORAGE_KEY = 'mazar-demo-state-v5'

function load(): DemoState {
  if (typeof window === 'undefined') {
    return buildSeed()
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && raw.trim().length > 0) {
      const parsed = JSON.parse(raw) as DemoState
      if (parsed && parsed.version === SCHEMA_VERSION) return parsed
    }
  } catch {
    /* ignore storage errors */
  }
  return buildSeed()
}

function persist(state: DemoState) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore storage errors */
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

let currentState: Store

const listeners = new Set<() => void>()

function emitChange() {
  for (const listener of listeners) {
    listener()
  }
}

function getState(): Store {
  if (!currentState) {
    const initial = load()
    currentState = {
      ...initial,
      setActiveProject: (id: string) => {
        currentState = { ...currentState, activeProjectId: id }
        persist(currentState)
        emitChange()
      },
      addProject: (p) => {
        const id = rid('prj-user')
        const project: Project = { ...p, id, orgId: currentState.org.id, createdByUser: true }
        const projects = [...currentState.projects, project]
        currentState = { ...currentState, projects, activeProjectId: id }
        persist(currentState)
        emitChange()
        return id
      },
      updateProject: (id, patch) => {
        const projects = currentState.projects.map((p) => (p.id === id ? { ...p, ...patch } : p))
        currentState = { ...currentState, projects }
        persist(currentState)
        emitChange()
      },
      addBlock: (b) => {
        const projectId = currentState.activeProjectId
        const id = rid(`${projectId}-blk`)
        const block: Block = { ...b, id, projectId, createdByUser: true }
        const blocks = [...currentState.blocks, block]
        currentState = { ...currentState, blocks }
        persist(currentState)
        emitChange()
        return id
      },
      updateBlock: (id, patch) => {
        const blocks = currentState.blocks.map((bl) => (bl.id === id ? { ...bl, ...patch } : bl))
        currentState = { ...currentState, blocks }
        persist(currentState)
        emitChange()
      },
      addFloor: (blockId, f) => {
        const block = currentState.blocks.find((b) => b.id === blockId)
        const projectId = block?.projectId ?? currentState.activeProjectId
        const id = rid(`${blockId}-floor`)
        const floor: Floor = { ...f, id, blockId, projectId, createdByUser: true }
        const floors = [...currentState.floors, floor]
        currentState = { ...currentState, floors }
        persist(currentState)
        emitChange()
        return id
      },
      updateFloor: (id, patch) => {
        const floors = currentState.floors.map((fl) => (fl.id === id ? { ...fl, ...patch } : fl))
        currentState = { ...currentState, floors }
        persist(currentState)
        emitChange()
      },
      addUnit: (u) => {
        const id = rid('unit-user')
        const unit: Unit = { ...u, id, createdByUser: true }
        const units = [...currentState.units, unit]
        currentState = { ...currentState, units }
        persist(currentState)
        emitChange()
        return id
      },
      updateUnit: (id, patch) => {
        const units = currentState.units.map((un) => (un.id === id ? { ...un, ...patch } : un))
        currentState = { ...currentState, units }
        persist(currentState)
        emitChange()
      },
      addCustomer: (c) => {
        const id = rid('cust-user')
        const customer: Customer = { ...c, id, createdByUser: true }
        const customers = [...currentState.customers, customer]
        currentState = { ...currentState, customers }
        persist(currentState)
        emitChange()
        return id
      },
      updateCustomer: (id, patch) => {
        const customers = currentState.customers.map((cu) => (cu.id === id ? { ...cu, ...patch } : cu))
        currentState = { ...currentState, customers }
        persist(currentState)
        emitChange()
      },
      setCustomerPhoto: (id, dataUrl) => {
        const customers = currentState.customers.map((cu) => (cu.id === id ? { ...cu, photo: dataUrl } : cu))
        currentState = { ...currentState, customers }
        persist(currentState)
        emitChange()
      },
      recordDemoPayment: (contractId, installmentNo) => {
        const contracts = currentState.contracts.map((c) => {
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
        currentState = { ...currentState, contracts }
        persist(currentState)
        emitChange()
      },
      recordPayment: ({ contractId, customerId, amount, date, method, reference, notes }) => {
        const contract = currentState.contracts.find((c) => c.id === contractId)
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

        const contracts = currentState.contracts.map((c) => (c.id === contractId ? updatedContract : c))
        const payments = [newPayment, ...currentState.payments]

        currentState = { ...currentState, contracts, payments }
        persist(currentState)
        emitChange()

        return { payment: newPayment, receiptId }
      },
      resetDemo: () => {
        if (typeof window !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY)
        }
        const seed = buildSeed()
        currentState = { ...currentState, ...seed }
        persist(currentState)
        emitChange()
      },
    }
  }
  return currentState
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function useStore<U>(selector: (state: Store) => U): U {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(getState())
  )
}

useStore.getState = getState
