// Types for AL-BERUNIY OS Holographic Presentation Experience

export type MacroZone =
  | 'center_ai'
  | 'governance'
  | 'revenue'
  | 'delivery_supply'
  | 'people'
  | 'finance'
  | 'intelligence_external';

export type NodeType =
  | 'ai_core'
  | 'module'
  | 'financial_engine'
  | 'transaction'
  | 'workflow_gate'
  | 'document_vault'
  | 'master_data'
  | 'external_channel'
  | 'security_control'
  | 'executive_kpi';

export type EdgeType =
  | 'financial'        // Amber/gold Dr/Cr posting
  | 'process'          // Solid cyan animated process line
  | 'master_data'      // Parallel / double line
  | 'approval'         // Dotted red-to-emerald gate line
  | 'document'         // Dashed bronze evidence link
  | 'ai_knowledge'     // Cyan flow into AI Core
  | 'ai_tool'          // Violet pulse outward to domain service
  | 'telegram'         // Boundary crossing channel
  | 'audit';           // Dotted silver pulse

export interface BlueprintDomain {
  id: string;
  code: string;
  name: string;
  blueprintNo: string;
  category: string;
  macroZone: MacroZone;
  nodeType: NodeType;
  position3D: [number, number, number]; // [x, y, z] in Three.js coordinates
  color: string;
  accentColor: string;
  shortPurpose: string;
  description: string;
  submodules: string[];
  incomingConnections: string[];
  outgoingConnections: string[];
  financialImpact: string;
  workflowImpact: string;
  documentEvidence: string;
  aiRelationship: string;
  telegramRelationship: string;
  auditTrail: string;
  stats: { label: string; value: string }[];
  isExternal?: boolean;
}

export interface RelationshipEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  label: string;
  description: string;
  isFlowing: boolean;
  flowDirection?: 'forward' | 'backward' | 'bidirectional';
  highlightScenes?: number[];
}

export interface JourneyStep {
  stepNumber: number;
  name: string;
  nodeId: string;
  detail: string;
  actor: string;
  documentEvidence?: string;
  financialImpact?: string;
  approvalGate?: string;
  status: 'pending' | 'active' | 'completed';
}

export interface PresentationScene {
  id: number;
  title: string;
  subtitle: string;
  narrationPrompt: string;
  keyPoints: string[];
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  focusedNodes: string[];
  dimSurrounding: boolean;
  activeEdgeTypes: EdgeType[];
  highlightEdgeIds?: string[];
  overlayType?:
    | 'reveal'
    | 'whole_company'
    | 'finance_engine'
    | 'journey_sale_to_cash'
    | 'journey_procure_to_pay'
    | 'journey_construction'
    | 'journey_payroll'
    | 'control_system'
    | 'ai_core_exploded'
    | 'telegram_channel'
    | 'traceability'
    | 'final_reveal';
}

export type GestureType =
  | 'none'
  | 'open_palm'
  | 'index_point'
  | 'pinch'
  | 'pinch_move'
  | 'two_hand_spread'
  | 'two_hand_close'
  | 'closed_fist'
  | 'both_palms_open';

export interface GestureState {
  activeGesture: GestureType;
  confidence: number;
  cursorScreenPos: { x: number; y: number }; // 0 to 1 normalized
  cursorWorldPos?: [number, number, number];
  isPinching: boolean;
  pinchDistance: number;
  isTwoHanded: boolean;
  handCount: number;
  lastGestureTime: number;
  hoveredNodeId: string | null;
  statusMessage: string;
  isTracking: boolean;
}

export interface PreflightDiagnostic {
  webgl: boolean;
  camera: boolean | null;
  handModel: boolean | null;
  assetsLoaded: boolean;
  syntheticDataLoaded: boolean;
  fps: number;
  resolution: string;
  allReady: boolean;
}

export interface TelegramMessage {
  id: string;
  sender: 'user' | 'bot';
  timestamp: string;
  text: string;
  metadata?: {
    toolName?: string;
    authLevel?: 'normal' | 'step_up_required';
    sources?: string[];
    syntheticHighlightNodes?: string[];
  };
}

export interface TraceabilityHop {
  hopNumber: number;
  title: string;
  nodeId: string;
  docReference: string;
  actor: string;
  glAccount?: string;
  amount?: string;
  direction: 'backward' | 'forward';
}
