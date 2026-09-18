// AL-BERUNIY OS — 3D World graph model
// One continuous enterprise network: nodes (domains + subnodes) and typed, directed edges.

export type Zone =
  | 'core'          // AI Core
  | 'governance'    // control / cross-cutting
  | 'revenue'
  | 'delivery'
  | 'people'
  | 'finance'
  | 'intelligence'
  | 'external';

export type NodeKind =
  | 'ai_core'
  | 'finance_engine'
  | 'module'
  | 'control'        // workflow / security / documents / master data / audit
  | 'channel'        // telegram, portals
  | 'external'       // llm providers
  | 'sub';           // expanded child

export interface WorldNode {
  id: string;
  label: string;
  short?: string;            // compact label for distance
  code?: string;             // connector id e.g. FIN-01
  bp?: string;               // blueprint number '04'
  zone: Zone;
  kind: NodeKind;
  parent?: string;           // for subnodes
  pos?: [number, number, number]; // top-level nodes only; children are laid out on expand
  purpose?: string;          // tiny floating label text on focus
  demo?: boolean;            // synthetic figure marker
}

export type EdgeKind =
  | 'process'
  | 'financial'
  | 'approval'
  | 'master_data'
  | 'document'
  | 'event'
  | 'audit'
  | 'notification'
  | 'ai_knowledge'
  | 'ai_tool'
  | 'integration'
  | 'security';

export interface WorldEdge {
  id?: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string;
  dir?: 'forward' | 'both';
  ref?: string;              // blueprint / doc reference
}

export interface Journey {
  id: string;
  code: string;              // J1..J6
  title: string;
  steps: string[];           // node ids in order (may include subnodes)
  ref: string;
}

export const EDGE_KIND_META: Record<EdgeKind, { label: string; color: string; style: string }> = {
  process:      { label: 'Business process',         color: '#38d9ff', style: 'luminous tube · particles' },
  financial:    { label: 'Financial posting',        color: '#f5b400', style: 'thick gold conduit · strong pulse' },
  approval:     { label: 'Approval / workflow',      color: '#ff5f6d', style: 'segmented gate line' },
  master_data:  { label: 'Master data',              color: '#9aa8b8', style: 'stable double line' },
  document:     { label: 'Document / evidence',      color: '#d9a066', style: 'linked-document trail' },
  event:        { label: 'Domain event / data',      color: '#6ee7ff', style: 'dashed data stream' },
  audit:        { label: 'Audit / trace',            color: '#c7d2e0', style: 'thin persistent trace' },
  notification: { label: 'Notification',            color: '#59c1ff', style: 'short pulse bursts' },
  ai_knowledge: { label: 'AI knowledge ingestion',   color: '#22e3c8', style: 'particles INTO AI Core' },
  ai_tool:      { label: 'AI typed tool invocation', color: '#a78bfa', style: 'particles OUT of AI Core' },
  integration:  { label: 'External integration',     color: '#7dd3fc', style: 'boundary-crossing beam' },
  security:     { label: 'Security / authorization', color: '#ff9f43', style: 'shield-gated line' },
};
