import { workspaceRoutes } from "@abos/contracts";
import { PageHeader, StatePanel, StatusBadge, Surface } from "@abos/ui";

export default function OverviewPage() {
  const overview = workspaceRoutes[0];

  return (
    <div className="page-stack">
      <PageHeader eyebrow="Enterprise command center" title={overview.label} description="A governed shell for company and project operations. Stage 0 contains no live financial, sales or project records." />
      <div className="hero-foundation" aria-labelledby="hero-title">
        <div>
          <p className="eyebrow">AL-BERUNIY OPERATING SYSTEM</p>
          <h2 id="hero-title">One company.<br />One operating view.</h2>
          <p>The application foundation is ready for the approved enterprise UI layer and later authorized domain integrations.</p>
        </div>
        <StatusBadge tone="warning">Foundation only</StatusBadge>
      </div>
      <div className="overview-grid">
        <Surface title="Financial overview" eyebrow="Authoritative source required"><StatePanel kind="empty" title="No verified financial data" description="KPI values remain empty until approved finance services provide traceable data." /></Surface>
        <Surface title="Project progress" eyebrow="Project context required"><StatePanel kind="empty" title="No active project context" description="Progress metrics will be shown only after a real, authorized project is selected." /></Surface>
        <Surface title="Sales and collections" eyebrow="Operational services required"><StatePanel kind="empty" title="No connected sales data" description="Customer, unit, contract and receipt records are outside Stage 0." /></Surface>
        <Surface title="AI insight" eyebrow="Permission-aware future capability"><StatePanel kind="no-permission" title="AI Core is not connected" description="No model, retrieval source or typed business tool is active in this foundation." /></Surface>
      </div>
    </div>
  );
}
