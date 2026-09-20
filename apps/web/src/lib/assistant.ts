import type { DemoState } from '@/data/types'
import { contractForCustomer, contractSummary, financeStats } from './selectors'
import { formatDate, formatMoney, monthLabel } from './format'

export interface AssistantAnswer {
  tool: string
  text: string
  customerId?: string
  bullets?: string[]
  highlight?: { label: string; value: string }[]
  actionLabel?: string
  actionUrl?: string
}

const norm = (s: string) => s.toLowerCase().trim()

export function askAssistant(query: string, state: DemoState): AssistantAnswer {
  const q = norm(query)
  const projectId = state.activeProjectId
  const project = state.projects.find((p) => p.id === projectId)!
  const money = (n: number) => formatMoney(n, project.currency, 'en')

  // Find customer mentioned in query, defaulting to Hashmatullah if mentioned or if asking general hero question
  const mentionedCustomer = state.customers.find((c) => {
    const first = c.name.split(' ')[0]
    return first ? q.includes(first.toLowerCase()) : false
  })
    ?? (q.includes('hashmatullah') ? state.customers.find((c) => c.id === 'hashmatullah-demo') : undefined)

  // 1. Has Hashmatullah paid this month's installment? / installment status
  if ((q.includes('paid this month') || q.includes('this month') || q.includes("month's installment") || q.includes('paid')) && !q.includes('how much') && !q.includes('total')) {
    const customer = mentionedCustomer ?? state.customers.find((c) => c.id === 'hashmatullah-demo')!
    const contract = contractForCustomer(state, customer.id)
    if (contract) {
      const sum = contractSummary(contract)
      const thisMonth = contract.installments.find((i) => i.status === 'due')
      const lastPaid = [...contract.installments].reverse().find((i) => i.status === 'paid')

      if (!thisMonth || thisMonth.paid >= thisMonth.amount) {
        return {
          tool: 'get_customer_installment_status',
          text: `Yes — ${customer.name}'s current month (September 2026) installment is paid in full. Latest payment receipt is ${lastPaid?.receiptId ?? 'RCP-DEMO-2026-0901'} (Installment #${lastPaid?.no ?? 9}).`,
          customerId: customer.id,
          actionLabel: `View ${customer.name}'s Profile`,
          actionUrl: `/app/customers/${customer.id}`,
          highlight: [
            { label: 'Status', value: 'Paid in Full ✓' },
            { label: 'Remaining balance', value: money(sum.remaining) },
            { label: 'Next due', value: sum.nextDue ? monthLabel(sum.nextDue.dueDate) : 'Schedule complete' },
          ],
        }
      }
      return {
        tool: 'get_customer_installment_status',
        text: `Not yet — ${customer.name} has an installment of ${money(thisMonth.amount - thisMonth.paid)} due ${monthLabel(thisMonth.dueDate)} that is still outstanding.`,
        customerId: customer.id,
        actionLabel: `Collect from ${customer.name}`,
        actionUrl: `/app/customers/${customer.id}`,
        highlight: [
          { label: 'Due amount', value: money(thisMonth.amount - thisMonth.paid) },
          { label: 'Due date', value: formatDate(thisMonth.dueDate, 'en') },
          { label: 'Status', value: thisMonth.status === 'overdue' ? 'Overdue' : 'Due' },
        ],
      }
    }
  }

  // 2. How much has Hashmatullah paid in total?
  if (q.includes('paid in total') || (q.includes('how much') && q.includes('paid') && (q.includes('total') || q.includes('hashmatullah')))) {
    const customer = mentionedCustomer ?? state.customers.find((c) => c.id === 'hashmatullah-demo')!
    const contract = contractForCustomer(state, customer.id)
    if (contract) {
      const sum = contractSummary(contract)
      const paidInstallmentsCount = contract.installments.filter((i) => i.status === 'paid').length
      return {
        tool: 'get_customer_paid_total',
        text: `${customer.name} has paid a total of ${money(sum.paid)} toward contract ${contract.id} (${money(contract.downPayment)} down payment + ${paidInstallmentsCount} installments).`,
        customerId: customer.id,
        actionLabel: `View ${customer.name}'s Ledger`,
        actionUrl: `/app/customers/${customer.id}`,
        highlight: [
          { label: 'Total Paid', value: money(sum.paid) },
          { label: 'Contract Value', value: money(sum.total) },
          { label: 'Fulfillment', value: `${sum.progressPct}%` },
        ],
      }
    }
  }

  // 3. How much does Hashmatullah still owe? / remaining balance
  if (q.includes('owe') || (q.includes('how much') && (q.includes('due') || q.includes('remaining') || q.includes('balance')) && q.includes('hashmatullah'))) {
    const customer = mentionedCustomer ?? state.customers.find((c) => c.id === 'hashmatullah-demo')!
    const contract = contractForCustomer(state, customer.id)
    if (contract) {
      const sum = contractSummary(contract)
      const oweUnit = state.units.find((u) => u.id === contract.unitId)
      return {
        tool: 'get_contract_balance',
        text: `${customer.name} currently owes an outstanding balance of ${money(sum.remaining)} on Unit ${oweUnit?.code ?? contract.unitId} (contract ${contract.id}).`,
        customerId: customer.id,
        actionLabel: `Record Payment for ${customer.name}`,
        actionUrl: `/app/customers/${customer.id}`,
        highlight: [
          { label: 'Remaining Balance', value: money(sum.remaining) },
          { label: 'Next Payment', value: sum.nextDue ? money(sum.nextDue.amount) : '0 AFN' },
          { label: 'Next Due Date', value: sum.nextDue ? formatDate(sum.nextDue.dueDate, 'en') : 'None' },
        ],
      }
    }
  }

  // 4. Show overdue customers
  if (q.includes('overdue') || (q.includes('show') && q.includes('late')) || q.includes('delinquent')) {
    const fin = financeStats(state, projectId)
    if (fin.overdueCustomers.length === 0) {
      return {
        tool: 'list_overdue_customers',
        text: `Good news — there are no overdue customers in ${project.name} right now. All scheduled installment accounts are current.`,
      }
    }
    return {
      tool: 'list_overdue_customers',
      text: `${fin.overdueCustomers.length} customer(s) in ${project.name} currently have overdue installments totaling ${money(fin.overdue)}:`,
      bullets: fin.overdueCustomers.map((o) => `${o.name} — ${money(o.amount)} (${o.daysLate} days late, ${o.count} installment(s))`),
      actionLabel: 'Open Finance Overdue Ledger',
      actionUrl: '/app/finance',
      highlight: [
        { label: 'Overdue Total', value: money(fin.overdue) },
        { label: 'Overdue Accounts', value: String(fin.overdueCustomers.length) },
      ],
    }
  }

  // 5. How much has been collected for the project? / project collection summary
  if (q.includes('collected') || (q.includes('how much') && (q.includes('project') || q.includes('total collection')))) {
    const fin = financeStats(state, projectId)
    return {
      tool: 'get_project_collection_summary',
      text: `Across ${project.name}, total collected funds to date are ${money(fin.collected)}, with ${money(fin.outstanding)} remaining outstanding.`,
      actionLabel: 'View Executive Dashboard',
      actionUrl: '/app/dashboard',
      highlight: [
        { label: 'Collected to Date', value: money(fin.collected) },
        { label: 'Outstanding Balance', value: money(fin.outstanding) },
        { label: 'Due This Month', value: money(fin.dueThisMonth) },
      ],
    }
  }

  // 6. What unit did Hashmatullah buy?
  if (q.includes('what unit') || q.includes('which unit') || (q.includes('property') && q.includes('hashmatullah'))) {
    const customer = mentionedCustomer ?? state.customers.find((c) => c.id === 'hashmatullah-demo')!
    const contract = contractForCustomer(state, customer.id)
    const unit = contract ? state.units.find((u) => u.id === contract.unitId) : undefined
    const block = unit ? state.blocks.find((b) => b.id === unit.blockId) : undefined

    if (customer && unit && block) {
      return {
        tool: 'find_customer_property',
        text: `${customer.name} purchased Unit ${unit.code} (${unit.typeLabel}, ${unit.areaM2} m²) located on Floor ${unit.floor} of ${block.name} in ${project.name}.`,
        customerId: customer.id,
        actionLabel: `View Unit ${unit.code}`,
        actionUrl: `/app/customers/${customer.id}`,
        highlight: [
          { label: 'Unit Code', value: `${unit.code}` },
          { label: 'Floor & Block', value: `Floor ${unit.floor}, ${block.name}` },
          { label: 'Area', value: `${unit.areaM2} m²` },
        ],
      }
    }
  }

  // 7. What is Hashmatullah's next installment?
  if (q.includes('next installment') || q.includes('next due') || (q.includes('next') && q.includes('payment'))) {
    const customer = mentionedCustomer ?? state.customers.find((c) => c.id === 'hashmatullah-demo')!
    const contract = contractForCustomer(state, customer.id)
    if (contract) {
      const sum = contractSummary(contract)
      if (sum.nextDue) {
        return {
          tool: 'get_next_installment_detail',
          text: `${customer.name}'s next scheduled payment is Installment #${sum.nextDue.no} for ${money(sum.nextDue.amount)}, due on ${formatDate(sum.nextDue.dueDate, 'en')}.`,
          customerId: customer.id,
          actionLabel: `Record Next Payment (${money(sum.nextDue.amount)})`,
          actionUrl: `/app/customers/${customer.id}`,
          highlight: [
            { label: 'Next Installment', value: `#${sum.nextDue.no}` },
            { label: 'Amount Due', value: money(sum.nextDue.amount) },
            { label: 'Due Date', value: formatDate(sum.nextDue.dueDate, 'en') },
          ],
        }
      }
      return {
        tool: 'get_next_installment_detail',
        text: `${customer.name} has no upcoming installments — the contract schedule is 100% fulfilled.`,
      }
    }
  }

  // Inventory summary
  if (q.includes('available') || q.includes('inventory') || q.includes('units') || q.includes('sold')) {
    const units = state.units.filter((u) => u.projectId === projectId)
    const by: Record<string, number> = { available: 0, sold: 0, reserved: 0, under_contract: 0, on_hold: 0 }
    units.forEach((u) => {
      by[u.status] = (by[u.status] ?? 0) + 1
    })
    return {
      tool: 'get_inventory_summary',
      text: `${project.name} has ${units.length} total demo units configured across ${state.blocks.filter((b) => b.projectId === projectId).length} blocks.`,
      actionLabel: 'Open Inventory',
      actionUrl: '/app/inventory',
      highlight: [
        { label: 'Available', value: String(by['available'] ?? 0) },
        { label: 'Committed', value: String((by['under_contract'] ?? 0) + (by['sold'] ?? 0)) },
        { label: 'Reserved', value: String(by['reserved'] ?? 0) },
      ],
    }
  }

  // Construction
  if (q.includes('progress') || q.includes('construction') || q.includes('built')) {
    const ms = state.progress.filter((p) => p.projectId === projectId && p.published)
    const overall = ms.length ? Math.round(ms.reduce((s, m) => s + m.percent, 0) / ms.length) : 0
    return {
      tool: 'get_construction_progress',
      text: `${project.name} is at approximately ${overall}% overall completion across published milestones.`,
      actionLabel: 'View Construction',
      actionUrl: '/app/construction',
      bullets: ms.slice(0, 3).map((m) => `${m.title} — ${m.percent}%`),
    }
  }

  return {
    tool: 'help',
    text: `I can answer questions regarding sales contracts, customer balances, installment schedules, overdue accounts, inventory, and construction milestones. Select a suggestion below:`,
  }
}

export const SUGGESTED_QUESTIONS = [
  "Has Hashmatullah paid this month's installment?",
  'How much has Hashmatullah paid in total?',
  'How much does Hashmatullah still owe?',
  "What is Hashmatullah's next installment?",
  'What unit did Hashmatullah buy?',
  'Show overdue customers.',
  'How much has been collected for the project?',
  'How many units are available?',
]
