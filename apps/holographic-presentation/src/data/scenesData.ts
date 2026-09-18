import type {
  PresentationScene,
  JourneyStep,
  TelegramMessage,
  TraceabilityHop
} from '../types/presentation';

export const PRESENTATION_SCENES: PresentationScene[] = [
  // ==========================================
  // SCENE 01 — REVEAL
  // ==========================================
  {
    id: 1,
    title: 'Scene 01 · The Awakening',
    subtitle: 'From Architectural Void to Living Digital Twin',
    narrationPrompt:
      'What you see is not a collection of software modules. This is the operating model of the entire company.',
    keyPoints: [
      'Black void transitions into an architectural holographic coordinate grid',
      'Central AI Core orb awakens in response to presenter gesture',
      'Surrounding 26 enterprise domains materialize radially',
      'Data conduits pulse to establish the unified nervous system'
    ],
    cameraPosition: [0, 1.5, 14],
    cameraTarget: [0, 0, 0],
    focusedNodes: ['ai_core'],
    dimSurrounding: false,
    activeEdgeTypes: ['process', 'financial', 'ai_knowledge'],
    overlayType: 'reveal'
  },

  // ==========================================
  // SCENE 02 — THE WHOLE COMPANY
  // ==========================================
  {
    id: 2,
    title: 'Scene 02 · The Whole Company',
    subtitle: 'One Unified Operating System Across All 26 Domains',
    narrationPrompt:
      'One connected system: Governance above, Revenue left, Supply right, People lower-left, Finance at the base, and AI Core in the center.',
    keyPoints: [
      'Top: Governance, Access, Multi-Project, Security, and Master Data',
      'Left: Revenue Cycle — Sales, CRM, Units, and Installment Collections',
      'Right: Delivery & Supply — Construction, BOQ, Procurement, Warehouse, Contractors',
      'Bottom-Left: People — HR, Biometrics, Payroll, and Project Labor Costing',
      'Bottom/Center: Financial Engine — General Ledger, AR, AP, Cash, and Budgeting',
      'Outside Perimeter: Governed Telegram Channel and External LLM Providers'
    ],
    cameraPosition: [0, 1.0, 15.5],
    cameraTarget: [0, 0, 0],
    focusedNodes: [
      'ai_core',
      'financial_engine',
      'sales_crm',
      'construction',
      'payroll',
      'telegram_channel'
    ],
    dimSurrounding: false,
    activeEdgeTypes: ['financial', 'process', 'approval', 'document', 'ai_knowledge', 'ai_tool', 'telegram'],
    overlayType: 'whole_company'
  },

  // ==========================================
  // SCENE 03 — FINANCE AS FINANCIAL ENGINE
  // ==========================================
  {
    id: 3,
    title: 'Scene 03 · Finance as the Engine',
    subtitle: 'Every Operational Action has an Immutable Financial Consequence',
    narrationPrompt:
      'Every operational action across Sales, Procurement, Construction, Warehouse, and Payroll posts an immutable Dr/Cr transaction to the Financial Engine.',
    keyPoints: [
      'Financial Engine steps into holographic foreground; others dim',
      'Sales & Collections → Immediate credit to Accounts Receivable and debit to Bank',
      'Procurement & GRN → Immediate Inventory accrual (Dr Inv, Cr GRNI)',
      'Contractor Work → Certified IPC posts liability and auto-deducts retention',
      'Payroll → Gross-to-net calculation with direct 60/40 project WIP allocation',
      'Zero manual reconciliation, zero untracked costs, full IFRS compliance'
    ],
    cameraPosition: [0, -1.2, 9.5],
    cameraTarget: [0, -2.2, 0.4],
    focusedNodes: ['financial_engine'],
    dimSurrounding: true,
    activeEdgeTypes: ['financial'],
    highlightEdgeIds: [
      'edge_sale_ar',
      'edge_coll_bank',
      'edge_proc_ap',
      'edge_wh_cost',
      'edge_con_payable',
      'edge_pay_cost',
      'edge_exp_fin',
      'edge_fin_bi'
    ],
    overlayType: 'finance_engine'
  },

  // ==========================================
  // SCENE 04 — SALE TO CASH (JOURNEY 1)
  // ==========================================
  {
    id: 4,
    title: 'Scene 04 · Journey 1: Sale to Cash',
    subtitle: 'From Lead Inception to Bank Deposit and GL Balance',
    narrationPrompt:
      'Watch the transaction pulse: Lead → KYC → Unit → Discount Gate → Contract → Installment Schedule → Bank Receipt → Ledger Posting.',
    keyPoints: [
      'Lead captures prospective buyer; KYC verification uploads identity documents',
      'Unit 402 selected; 8% discount request triggers Executive Workflow Gate',
      'Contract signed via e-sign; locked installment payment plan generated',
      'Customer down payment cleared by bank feed; auto-reconciles AR',
      'Double-entry journal auto-posts: Dr Bank, Cr Accounts Receivable',
      'Customer statement updated; Handover Clearance certificate generated'
    ],
    cameraPosition: [-3.8, -0.6, 9.0],
    cameraTarget: [-3.5, -0.8, 0.6],
    focusedNodes: ['sales_crm', 'installments_collections', 'financial_engine', 'document_management', 'workflow_approvals'],
    dimSurrounding: true,
    activeEdgeTypes: ['process', 'financial', 'document', 'approval'],
    highlightEdgeIds: ['edge_sale_coll', 'edge_sale_ar', 'edge_coll_bank'],
    overlayType: 'journey_sale_to_cash'
  },

  // ==========================================
  // SCENE 05 — PROCURE TO PAY (JOURNEY 2)
  // ==========================================
  {
    id: 5,
    title: 'Scene 05 · Journey 2: Procure to Pay',
    subtitle: 'Connecting Physical Site Delivery with Financial Commitments',
    narrationPrompt:
      'Dual-track flow: Physical material movement synchronized with budgetary commitments, 3-way matching, and Accounts Payable.',
    keyPoints: [
      'Material Requirement for 50 tons steel checked against BOQ budget cap',
      'PR created and approved; RFQ issued to vetted suppliers; bids tabulated',
      'Purchase Order commits project budget in Financial Engine',
      'Delivery arrives at site gate; QA passes inspection; GRN signed (Dr Inv, Cr GRNI)',
      'Material issued to contractor: transfers cost from Inventory to Project WIP',
      'Supplier invoice matched 3-way against PO and GRN; releases to AP for payment'
    ],
    cameraPosition: [4.5, 0.4, 10.0],
    cameraTarget: [4.2, 0.0, 0.2],
    focusedNodes: ['procurement', 'supplier_mgmt', 'inventory_warehouse', 'boq_cost_control', 'financial_engine'],
    dimSurrounding: true,
    activeEdgeTypes: ['process', 'financial'],
    highlightEdgeIds: ['edge_boq_proc', 'edge_proc_supp', 'edge_proc_wh', 'edge_wh_cost', 'edge_proc_ap'],
    overlayType: 'journey_procure_to_pay'
  },

  // ==========================================
  // SCENE 06 — CONSTRUCTION & CONTRACTOR (JOURNEY 3)
  // ==========================================
  {
    id: 6,
    title: 'Scene 06 · Journey 3: Site & Contractors',
    subtitle: 'Milestone Progress, Interim Payment Certificates, and Cost Control',
    narrationPrompt:
      'Contractor progress measured on site, verified by Resident Engineer, certified into IPC, with automated retention and advance recovery.',
    keyPoints: [
      'Contractor performs structural works against approved WBS milestone package',
      'Site Quantity Surveyor measures progress; Resident Engineer verifies IR',
      'Project Manager certifies Interim Payment Certificate (IPC)',
      'System auto-deducts 10% warranty retention and mobilization advance recovery',
      'Certified net amount posts to Contractor Payables (Cr Payable, Dr WIP)',
      'Project Estimate-at-Completion (EAC) dynamically recalculates in real time'
    ],
    cameraPosition: [4.2, -1.8, 9.5],
    cameraTarget: [4.0, -1.5, 0.4],
    focusedNodes: ['construction', 'boq_cost_control', 'contractor_mgmt', 'financial_engine'],
    dimSurrounding: true,
    activeEdgeTypes: ['process', 'financial'],
    highlightEdgeIds: ['edge_const_boq', 'edge_const_con', 'edge_con_payable'],
    overlayType: 'journey_construction'
  },

  // ==========================================
  // SCENE 07 — HR & PAYROLL (JOURNEY 4)
  // ==========================================
  {
    id: 7,
    title: 'Scene 07 · Journey 4: Workforce & Costing',
    subtitle: 'Biometric Attendance to Multi-Project Labor Cost Allocation',
    narrationPrompt:
      'Labor costs are not generic overheads: Biometric attendance drives gross-to-net payroll, split 60% Mazar Mall and 40% Tower B.',
    keyPoints: [
      'Biometric fingerprint/face turnstiles at sites log daily staff attendance',
      'Payroll engine computes base wages, overtime, and statutory withholdings',
      'Dual approval: HR Director certifies roster, Finance Director approves payout',
      'Bank disbursement file dispatched via secure host-to-host channel',
      'Direct Job Costing: Labor expense auto-allocated by project (60% Mall, 40% Tower)',
      'Immutable payroll register locked with digital audit signatures'
    ],
    cameraPosition: [-2.5, -3.2, 9.5],
    cameraTarget: [-2.2, -3.0, 0.4],
    focusedNodes: ['human_resources', 'payroll', 'financial_engine'],
    dimSurrounding: true,
    activeEdgeTypes: ['process', 'financial'],
    highlightEdgeIds: ['edge_hr_pay', 'edge_pay_cost'],
    overlayType: 'journey_payroll'
  },

  // ==========================================
  // SCENE 08 — CONTROL NERVOUS SYSTEM
  // ==========================================
  {
    id: 8,
    title: 'Scene 08 · Enterprise Control System',
    subtitle: 'Cross-Cutting Governance, Documents, Approvals, and Immutable Audit',
    narrationPrompt:
      'No transaction executes without Creator identity, Permission check, Workflow approval, Document proof, and Audit record.',
    keyPoints: [
      'Workflow Ring gates every financial posting and material operational transition',
      'Document Vault provides tamper-evident cryptographic hashes (SHA-256) for evidence',
      'Segregation of Duties (SoD) prevents requesters from approving their own entries',
      'Audit Ledger records every terminal, timestamp, user ID, and state change',
      'Zero-Trust Security Architecture monitors token validity and role scopes'
    ],
    cameraPosition: [0, 2.2, 11.0],
    cameraTarget: [0, 1.5, 0.4],
    focusedNodes: ['workflow_approvals', 'document_management', 'security_arch', 'org_access', 'financial_engine'],
    dimSurrounding: false,
    activeEdgeTypes: ['approval', 'document', 'financial', 'process'],
    highlightEdgeIds: ['edge_wf_all', 'edge_doc_fin'],
    overlayType: 'control_system'
  },

  // ==========================================
  // SCENE 09 — AI CORE REVEAL
  // ==========================================
  {
    id: 9,
    title: 'Scene 09 · AI Core / Intelligence Plane',
    subtitle: 'Model Gateway, Enterprise Knowledge Plane, and Governed Typed Tools',
    narrationPrompt:
      'The AI Core knows the entire enterprise, but never writes raw SQL. It interacts exclusively through permission-trimmed Typed Tools.',
    keyPoints: [
      'Model Gateway connects to multiple external LLMs without vendor lock-in',
      'Enterprise Knowledge Plane indexes security-tagged read models and documents',
      'CRITICAL ARCHITECTURE: AI never generates arbitrary SQL queries against database',
      'AI executes strictly via Typed Tools: `get_project_financial_summary()`, `get_overdue_installments()`',
      'Every query is permission-trimmed: users only see information authorized for their role',
      'Audit & Observability records every prompt hash, retrieved source, and tool run'
    ],
    cameraPosition: [0, 0, 7.5],
    cameraTarget: [0, 0, 0],
    focusedNodes: ['ai_core', 'llm_providers', 'financial_engine'],
    dimSurrounding: true,
    activeEdgeTypes: ['ai_knowledge', 'ai_tool'],
    highlightEdgeIds: ['edge_ai_knowledge_in', 'edge_ai_tool_out', 'edge_ai_llm'],
    overlayType: 'ai_core_exploded'
  },

  // ==========================================
  // SCENE 10 — TELEGRAM INTEGRATION
  // ==========================================
  {
    id: 10,
    title: 'Scene 10 · Governed Telegram Channel',
    subtitle: 'Identity Binding, Conversational Intelligence, and Step-Up Security',
    narrationPrompt:
      'Telegram is a secure conversational window into the exact same AI Core. A Telegram username is never trusted without cryptographic ABOS binding.',
    keyPoints: [
      'Telegram Bot API connects outside enterprise boundary via secure Webhook',
      'One-time token binding links Telegram chat to authorized Type A User account',
      'Simulated Executive Query: "Show me overdue installments in Mazar Mall over 30 days"',
      'AI Core responds in 1.2s: 42 overdue units, AFN 18.4M; highlights top 3 in 3D!',
      'Outbound notifications alert directors of pending IPC approvals and low stock',
      'High-risk actions (payment release, journal post) enforce Step-Up Auth deep links'
    ],
    cameraPosition: [4.2, -2.5, 9.0],
    cameraTarget: [4.8, -2.8, -0.4],
    focusedNodes: ['telegram_channel', 'ai_core', 'installments_collections'],
    dimSurrounding: true,
    activeEdgeTypes: ['telegram', 'ai_tool'],
    highlightEdgeIds: ['edge_tg_ai', 'edge_ai_tool_out'],
    overlayType: 'telegram_channel'
  },

  // ==========================================
  // SCENE 11 — END-TO-END TRACEABILITY
  // ==========================================
  {
    id: 11,
    title: 'Scene 11 · End-to-End Traceability',
    subtitle: 'Reverse Drilldown: From $250,000 Project Expense to Physical GRN',
    narrationPrompt:
      'One click on an executive number reveals its complete lineage: Project → Cost Center → PO → Supplier → Invoice → Site GRN → Approver → GL.',
    keyPoints: [
      'CEO inspects $250,000 Project Expense spike in Executive Command Center',
      'Reverse trace drills down 12 hops into project sub-records',
      'Reveals Project Mazar Mall, Structural Cost Center CC-401, PO #2026-0482',
      'Identifies Supplier Kabul Star Cement Ltd, Invoice INV-8921, Gate 2 GRN-1049',
      'Shows Site Engineer Requester, Director Approver, and Bank Journal Entry #8821',
      'Demonstrates zero black-box data: complete forward and reverse auditability'
    ],
    cameraPosition: [1.2, -2.8, 9.0],
    cameraTarget: [1.0, -2.5, 0.4],
    focusedNodes: ['executive_center', 'business_intelligence', 'financial_engine', 'document_management', 'procurement'],
    dimSurrounding: true,
    activeEdgeTypes: ['financial', 'document', 'process'],
    highlightEdgeIds: ['edge_bi_exec', 'edge_fin_bi', 'edge_doc_fin'],
    overlayType: 'traceability'
  },

  // ==========================================
  // SCENE 12 — FINAL REVEAL & APPROVAL
  // ==========================================
  {
    id: 12,
    title: 'Scene 12 · Final System Architecture',
    subtitle: 'AL-BERUNIY Operating System: Client Blueprint Approval Gate',
    narrationPrompt:
      'One Company. One Operating Model. One Intelligent System. Ready for Blueprint Approval and Phase 1 Deployment.',
    keyPoints: [
      'Complete 3D enterprise digital twin illuminated in full holographic splendour',
      'Central AI Core, authoritative Financial Engine, and 26 integrated domains',
      'All operational, financial, and governance relationships proven end-to-end',
      'Full documentation, A3 blueprints, and implementation specs verified',
      'Presenter holds final frame for formal Client Blueprint Approval sign-off'
    ],
    cameraPosition: [0, 1.2, 16.0],
    cameraTarget: [0, 0, 0],
    focusedNodes: ['ai_core', 'financial_engine', 'master_map', 'telegram_channel'],
    dimSurrounding: false,
    activeEdgeTypes: ['financial', 'process', 'approval', 'document', 'ai_knowledge', 'ai_tool', 'telegram'],
    overlayType: 'final_reveal'
  }
];

// Transaction Journey Steps for Scene 04: Sale to Cash
export const SALE_TO_CASH_STEPS: JourneyStep[] = [
  {
    stepNumber: 1,
    name: 'Lead Registration',
    nodeId: 'sales_crm',
    detail: 'Prospect registered via sales agent; interest tagged for 2-bedroom retail unit.',
    actor: 'Sales Agent (Mustafa K.)',
    status: 'completed'
  },
  {
    stepNumber: 2,
    name: 'KYC & AML Verification',
    nodeId: 'sales_crm',
    detail: 'Passport and proof of address verified against compliance database; Type B Party established.',
    actor: 'Compliance Officer (Farhad A.)',
    documentEvidence: 'DOC-KYC-2026-081',
    status: 'completed'
  },
  {
    stepNumber: 3,
    name: 'Unit Selection',
    nodeId: 'sales_crm',
    detail: 'Unit 402, Tower A, 142 m² selected; temporary 48-hour reservation hold applied.',
    actor: 'Client / Agent',
    status: 'completed'
  },
  {
    stepNumber: 4,
    name: 'Quotation & Discount Gate',
    nodeId: 'workflow_approvals',
    detail: 'Quotation created with 8% discount. Automatically routes to Executive Workflow for approval.',
    actor: 'Sales Director (Approved)',
    approvalGate: 'WF-DISC-402 (Approved)',
    status: 'completed'
  },
  {
    stepNumber: 5,
    name: 'Contract Generation & E-Sign',
    nodeId: 'sales_crm',
    detail: 'Binding sales contract generated from template; cryptographic e-signatures affixed.',
    actor: 'Buyer & Legal Counsel',
    documentEvidence: 'DOC-CNT-402-FINAL.pdf (SHA-256)',
    status: 'completed'
  },
  {
    stepNumber: 6,
    name: 'Installment Schedule Lock',
    nodeId: 'installments_collections',
    detail: 'Contract locks 36-month construction-linked installment payment schedule.',
    actor: 'Automated Engine',
    financialImpact: 'Establishes AR Commitment: AFN 8,400,000',
    status: 'completed'
  },
  {
    stepNumber: 7,
    name: 'Down Payment & Bank Feed',
    nodeId: 'installments_collections',
    detail: 'Customer remits 20% down payment via bank transfer; bank API reconciles receipt.',
    actor: 'Bank Integration Gateway',
    financialImpact: 'Receipt #RCT-9912: AFN 1,680,000',
    status: 'completed'
  },
  {
    stepNumber: 8,
    name: 'Double-Entry General Ledger',
    nodeId: 'financial_engine',
    detail: 'Automated journal entry posted: Debit Bank Account 1010, Credit AR Subledger 1210.',
    actor: 'Financial Engine',
    financialImpact: 'Journal JV-2026-4412 posted & locked',
    status: 'completed'
  },
  {
    stepNumber: 9,
    name: 'Customer Statement & Clearance',
    nodeId: 'sales_crm',
    detail: 'Customer ledger balance updated; Handover Eligibility status updated to "On Track".',
    actor: 'Executive Dashboard Alert',
    status: 'completed'
  }
];

// Transaction Journey Steps for Scene 05: Procure to Pay
export const PROCURE_TO_PAY_STEPS: JourneyStep[] = [
  {
    stepNumber: 1,
    name: 'Site Material Requisition',
    nodeId: 'construction',
    detail: 'Site Engineer requests 50 metric tons of deformed steel rebar for Level 4 slab.',
    actor: 'Site Eng. (Eng. Ahmadzai)',
    status: 'completed'
  },
  {
    stepNumber: 2,
    name: 'BOQ & Budget Verification',
    nodeId: 'boq_cost_control',
    detail: 'System verifies steel volume against BOQ Item 03.12 and available project budget.',
    actor: 'Cost Control Engine',
    financialImpact: 'Budget available: AFN 4.2M (Sufficient)',
    status: 'completed'
  },
  {
    stepNumber: 3,
    name: 'Purchase Requisition (PR)',
    nodeId: 'procurement',
    detail: 'PR-2026-0312 generated; approved by Project Director via mobile workflow.',
    actor: 'Project Director (Signed)',
    approvalGate: 'WF-PR-0312',
    status: 'completed'
  },
  {
    stepNumber: 4,
    name: 'RFQ & Supplier Bidding',
    nodeId: 'supplier_mgmt',
    detail: 'RFQ dispatched to 3 vetted steel suppliers; commercial quotes tabulated side-by-side.',
    actor: 'Procurement Officer',
    documentEvidence: 'DOC-BID-COMP-0312.pdf',
    status: 'completed'
  },
  {
    stepNumber: 5,
    name: 'Purchase Order Commitment',
    nodeId: 'procurement',
    detail: 'PO-2026-0482 issued to Kabul Star Steel Ltd. Registers commitment against project cost center.',
    actor: 'Head of Procurement',
    financialImpact: 'Accounting Commitment: AFN 3,450,000',
    status: 'completed'
  },
  {
    stepNumber: 6,
    name: 'Delivery & QA Inspection',
    nodeId: 'inventory_warehouse',
    detail: 'Trucks arrive at site gate; lab mill test certificate inspected; QA approves quality.',
    actor: 'Storekeeper & QA Tech',
    documentEvidence: 'DOC-MILL-TEST-881.pdf',
    status: 'completed'
  },
  {
    stepNumber: 7,
    name: 'Goods Receipt Note (GRN)',
    nodeId: 'inventory_warehouse',
    detail: 'GRN-2026-1049 generated. Accounting entry: Debit Inventory (1310), Credit GRNI (2120).',
    actor: 'Warehouse Storekeeper',
    financialImpact: 'Dr Inventory / Cr GRNI: AFN 3,450,000',
    status: 'completed'
  },
  {
    stepNumber: 8,
    name: 'Material Issue to Project WIP',
    nodeId: 'inventory_warehouse',
    detail: 'Steel issued to Contractor; transfers cost: Debit Project WIP (5101), Credit Inventory (1310).',
    actor: 'Site Foreman',
    financialImpact: 'Dr Project WIP Cost: AFN 3,450,000',
    status: 'completed'
  },
  {
    stepNumber: 9,
    name: '3-Way Match & AP Settlement',
    nodeId: 'financial_engine',
    detail: 'Supplier Invoice matched against PO and GRN. Clears GRNI, posts AP, schedules EFT payment.',
    actor: 'Accounts Payable Specialist',
    financialImpact: 'Dr GRNI (2120), Cr Accounts Payable (2110)',
    status: 'completed'
  }
];

// Simulated Telegram Messages for Scene 10
export const SIMULATED_TELEGRAM_DIALOG: TelegramMessage[] = [
  {
    id: 'msg-1',
    sender: 'user',
    timestamp: '10:41 AM',
    text: 'Show me overdue installments in Mazar Mall over 30 days.'
  },
  {
    id: 'msg-2',
    sender: 'bot',
    timestamp: '10:41 AM',
    text: '📊 **Mazar Mall — Overdue Installments Analysis**\n\n• **Total Overdue Units:** 42\n• **Total Outstanding:** AFN 18,420,000\n• **Aging > 60 Days:** 8 accounts (AFN 7.8M)\n• **Critical Attention Required:** 3 accounts\n\nWould you like me to highlight the top three delinquent units?',
    metadata: {
      toolName: 'get_overdue_installments(projectId="MAZAR-MALL", minDays=30)',
      authLevel: 'normal',
      sources: ['BP-06 Installments Ledger', 'BP-04 Accounts Receivable Subledger']
    }
  },
  {
    id: 'msg-3',
    sender: 'user',
    timestamp: '10:42 AM',
    text: 'Show me the top three.'
  },
  {
    id: 'msg-4',
    sender: 'bot',
    timestamp: '10:42 AM',
    text: '🎯 **Top 3 Critical Accounts (Highlighted in 3D Model):**\n\n1. **Unit 304 (Tower A)** — Haroon Rasooli\n   Overdue: AFN 2,450,000 (78 days) · Notice 2 Issued\n2. **Unit 512 (Commercial)** — Balkh Trading Co.\n   Overdue: AFN 1,850,000 (65 days) · Notice 1 Issued\n3. **Unit 210 (Tower B)** — Zabiullah Qasim\n   Overdue: AFN 1,200,000 (48 days) · Call Logged Yesterday\n\n⚡ *Highlighted in 3D holographic model now.*',
    metadata: {
      toolName: 'get_customer_aging_summary(unitIds=["304", "512", "210"])',
      syntheticHighlightNodes: ['installments_collections', 'sales_crm', 'financial_engine']
    }
  },
  {
    id: 'msg-5',
    sender: 'user',
    timestamp: '10:43 AM',
    text: 'Which project has the highest collection risk this quarter?'
  },
  {
    id: 'msg-6',
    sender: 'bot',
    timestamp: '10:43 AM',
    text: '📈 **Quarterly Risk Assessment:**\n\n**Mazar Mall** presents the highest collection concentration (AFN 18.4M across 42 units), followed by Commercial Tower B (AFN 6.2M across 11 units).\n\nRecommendation: Trigger Stage-2 automated collection escalation via SMS/WhatsApp portal for accounts exceeding 60 days.',
    metadata: {
      toolName: 'get_project_risk_forecast(metric="collection_risk", period="Q3-2026")',
      authLevel: 'normal'
    }
  }
];

// Traceability 12 Hops for Scene 11 (Reverse drill from $250,000 KPI)
export const TRACEABILITY_HOPS: TraceabilityHop[] = [
  {
    hopNumber: 1,
    title: 'Executive KPI: Project Expense Spike',
    nodeId: 'executive_center',
    docReference: 'DASH-EXEC-KPI-COST',
    actor: 'Chief Executive Officer (View)',
    amount: '$250,000 USD (AFN 17.5M)',
    direction: 'backward'
  },
  {
    hopNumber: 2,
    title: 'Project Identification',
    nodeId: 'multi_project',
    docReference: 'PROJ-MAZAR-MALL-TOWER-A',
    actor: 'Project Governance Register',
    direction: 'backward'
  },
  {
    hopNumber: 3,
    title: 'Department & Cost Center',
    nodeId: 'master_data',
    docReference: 'CC-401 (Structural Works)',
    actor: 'Chart of Cost Centers',
    direction: 'backward'
  },
  {
    hopNumber: 4,
    title: 'Transaction Document Record',
    nodeId: 'expense_management',
    docReference: 'TXN-EXP-2026-0842',
    actor: 'Financial Posting Engine',
    amount: 'AFN 17,500,000',
    direction: 'backward'
  },
  {
    hopNumber: 5,
    title: 'Commercial Purchase Order',
    nodeId: 'procurement',
    docReference: 'PO-2026-0482 (Supply of Grade 60 Rebar)',
    actor: 'Head of Procurement',
    direction: 'backward'
  },
  {
    hopNumber: 6,
    title: 'Verified Supplier Party',
    nodeId: 'supplier_mgmt',
    docReference: 'SUPP-KABUL-STAR-STEEL (TIN: 90214810)',
    actor: 'Vendor Compliance Register',
    direction: 'backward'
  },
  {
    hopNumber: 7,
    title: 'Commercial Supplier Invoice',
    nodeId: 'procurement',
    docReference: 'INV-8921 (Matched 3-Way)',
    actor: 'Accounts Payable Clerk',
    amount: 'AFN 17,500,000',
    direction: 'backward'
  },
  {
    hopNumber: 8,
    title: 'Physical Goods Receipt Note (GRN)',
    nodeId: 'inventory_warehouse',
    docReference: 'GRN-2026-1049 (Gate 2 Storekeeper)',
    actor: 'Storekeeper (Karim N.)',
    direction: 'backward'
  },
  {
    hopNumber: 9,
    title: 'Original Site Material Requisition',
    nodeId: 'construction',
    docReference: 'SMR-2026-0312 (Level 4 Slab)',
    actor: 'Site Resident Engineer (Jawid H.)',
    direction: 'backward'
  },
  {
    hopNumber: 10,
    title: 'Executive Workflow Approval',
    nodeId: 'workflow_approvals',
    docReference: 'WF-APPR-DIR-0892 (Cryptographic Signature)',
    actor: 'Project Director (Dr. S. Qasimi)',
    direction: 'backward'
  },
  {
    hopNumber: 11,
    title: 'Treasury Bank Disbursement',
    nodeId: 'financial_engine',
    docReference: 'BANK-EFT-2026-9901 (Kabul Bank)',
    actor: 'Treasury Manager',
    amount: 'AFN 17,500,000',
    direction: 'backward'
  },
  {
    hopNumber: 12,
    title: 'General Ledger Double-Entry Posting',
    nodeId: 'financial_engine',
    docReference: 'GL-JV-2026-8821',
    actor: 'Authoritative General Ledger',
    glAccount: 'Dr 51010-WIP Cost / Cr 10100-Cash at Bank',
    direction: 'backward'
  }
];
