export type WorkspaceModuleId =
  | "overview"
  | "projects"
  | "sales-crm"
  | "finance"
  | "construction"
  | "procurement"
  | "human-resources"
  | "reports-analytics"
  | "ai-insights"
  | "documents"
  | "settings";

export type WorkspaceRoutePath = "/" | `/${string}`;

export interface WorkspaceRoute {
  readonly id: WorkspaceModuleId;
  readonly path: WorkspaceRoutePath;
  readonly label: string;
  readonly shortLabel: string;
  readonly group: "operate" | "manage" | "govern";
  readonly description: string;
  readonly implementationStatus: "foundation-only";
}

export const workspaceRoutes = [
  { id: "overview", path: "/", label: "Overview", shortLabel: "OV", group: "operate", description: "Enterprise command-center shell and verified operational summaries.", implementationStatus: "foundation-only" },
  { id: "projects", path: "/projects", label: "Projects", shortLabel: "PR", group: "operate", description: "Portfolio and project context workspace.", implementationStatus: "foundation-only" },
  { id: "sales-crm", path: "/sales-crm", label: "Sales & CRM", shortLabel: "SC", group: "operate", description: "Sales, customer, unit and contract workspace.", implementationStatus: "foundation-only" },
  { id: "finance", path: "/finance", label: "Finance", shortLabel: "FI", group: "operate", description: "Finance workbench shell. No posting logic is implemented in Stage 0.", implementationStatus: "foundation-only" },
  { id: "construction", path: "/construction", label: "Construction", shortLabel: "CO", group: "manage", description: "Construction, WBS, progress and cost-control workspace.", implementationStatus: "foundation-only" },
  { id: "procurement", path: "/procurement", label: "Procurement", shortLabel: "PO", group: "manage", description: "Procurement, supplier and warehouse workspace.", implementationStatus: "foundation-only" },
  { id: "human-resources", path: "/human-resources", label: "Human Resources", shortLabel: "HR", group: "manage", description: "Employee, attendance and payroll workspace shell.", implementationStatus: "foundation-only" },
  { id: "reports-analytics", path: "/reports-analytics", label: "Reports & Analytics", shortLabel: "RA", group: "govern", description: "Governed reporting and analytics workspace.", implementationStatus: "foundation-only" },
  { id: "ai-insights", path: "/ai-insights", label: "AI Insights", shortLabel: "AI", group: "govern", description: "Role-safe AI entry shell. No model or business tool is connected in Stage 0.", implementationStatus: "foundation-only" },
  { id: "documents", path: "/documents", label: "Documents", shortLabel: "DO", group: "govern", description: "Document-control workspace shell.", implementationStatus: "foundation-only" },
  { id: "settings", path: "/settings", label: "Settings", shortLabel: "SE", group: "govern", description: "Environment and application settings shell.", implementationStatus: "foundation-only" }
] as const satisfies readonly WorkspaceRoute[];

export function findWorkspaceRoute(pathname: string): WorkspaceRoute | undefined {
  return workspaceRoutes.find((route) => route.path === pathname);
}
