import type { Contract, DemoState, Installment, Unit, UnitStatus } from '@/data/types'
import { DEMO_TODAY } from '@/data/seed'

export interface ContractSummary {
  total: number
  paid: number
  remaining: number
  nextDue?: Installment
  overdueCount: number
  overdueAmount: number
  progressPct: number
}

export function contractSummary(c: Contract): ContractSummary {
  const paidInstallments = c.installments.reduce((s, i) => s + i.paid, 0)
  const paid = paidInstallments + c.downPayment
  const remaining = Math.max(0, c.totalPrice - paid)
  const overdue = c.installments.filter((i) => i.status === 'overdue')
  const nextDue = c.installments.find((i) => i.status === 'due')
    ?? c.installments.find((i) => i.status === 'overdue')
    ?? c.installments.find((i) => i.status === 'upcoming')
  return {
    total: c.totalPrice, paid, remaining, nextDue,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((s, i) => s + (i.amount - i.paid), 0),
    progressPct: c.totalPrice ? Math.round((paid / c.totalPrice) * 100) : 0,
  }
}

export function contractForCustomer(s: DemoState, customerId: string): Contract | undefined {
  return s.contracts.find((c) => c.customerId === customerId)
}

export interface InventoryStats {
  total: number
  byStatus: Record<UnitStatus, number>
  saleable: number
  totalValue: number
  soldValue: number
}

export function inventoryStats(units: Unit[]): InventoryStats {
  const byStatus: Record<UnitStatus, number> = {
    available: 0, reserved: 0, under_contract: 0, sold: 0, on_hold: 0,
  }
  let totalValue = 0
  let soldValue = 0
  units.forEach((u) => {
    byStatus[u.status]++
    totalValue += u.price
    if (u.status === 'sold' || u.status === 'under_contract') soldValue += u.price
  })
  return {
    total: units.length, byStatus,
    saleable: units.filter((u) => u.kind !== 'parking' && u.kind !== 'amenity').length,
    totalValue, soldValue,
  }
}

export interface FinanceStats {
  collected: number
  outstanding: number
  dueThisMonth: number
  overdue: number
  overdueCustomers: { customerId: string; name: string; amount: number; count: number; daysLate: number }[]
}

export function financeStats(s: DemoState, projectId: string): FinanceStats {
  const contracts = s.contracts.filter((c) => c.projectId === projectId)
  let collected = 0
  let outstanding = 0
  let dueThisMonth = 0
  let overdue = 0
  const overdueCustomers: FinanceStats['overdueCustomers'] = []
  contracts.forEach((c) => {
    const sum = contractSummary(c)
    collected += sum.paid
    outstanding += sum.remaining
    c.installments.forEach((i) => {
      if (i.status === 'due') dueThisMonth += i.amount - i.paid
      if (i.status === 'overdue') overdue += i.amount - i.paid
    })
    if (sum.overdueCount > 0) {
      const cust = s.customers.find((cu) => cu.id === c.customerId)
      const firstOverdue = c.installments.find((i) => i.status === 'overdue')!
      const daysLate = Math.round((DEMO_TODAY.getTime() - new Date(firstOverdue.dueDate).getTime()) / 86400000)
      overdueCustomers.push({
        customerId: c.customerId, name: cust?.name ?? '—',
        amount: sum.overdueAmount, count: sum.overdueCount, daysLate,
      })
    }
  })
  overdueCustomers.sort((a, b) => b.amount - a.amount)
  return { collected, outstanding, dueThisMonth, overdue, overdueCustomers }
}

export interface MonthlyCollection { month: string; collected: number; target: number }

export function collectionTrend(s: DemoState, projectId: string): MonthlyCollection[] {
  const projectContractIds = new Set(s.contracts.filter((contract) => contract.projectId === projectId).map((contract) => contract.id))
  const totals = new Map<string, number>()
  s.payments.filter((payment) => projectContractIds.has(payment.contractId)).forEach((payment) => {
    const month = payment.date.slice(0, 7)
    totals.set(month, (totals.get(month) ?? 0) + payment.amount)
  })
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-8).map(([month, collected]) => ({
    month: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short' }),
    collected,
    target: collected,
  }))
}
