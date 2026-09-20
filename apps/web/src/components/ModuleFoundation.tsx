import type { WorkspaceRoute } from "@abos/contracts";
import { PageHeader, StatePanel, StatusBadge, Surface } from "@abos/ui";

interface ModuleFoundationProps {
  readonly route: WorkspaceRoute;
}

export function ModuleFoundation({ route }: ModuleFoundationProps) {
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Stage 0 · Application foundation" title={route.label} description={route.description} />
      <div className="foundation-grid">
        <Surface title="Workspace status" eyebrow="Implementation boundary">
          <div className="surface-row"><span>Route and shell</span><StatusBadge tone="success">Available</StatusBadge></div>
          <div className="surface-row"><span>Verified operational data</span><StatusBadge>Not connected</StatusBadge></div>
          <div className="surface-row"><span>Authorization and services</span><StatusBadge tone="warning">Future approved stage</StatusBadge></div>
        </Surface>
        <Surface title="Current context" eyebrow="Company and project">
          <StatePanel kind="empty" title="No company or project selected" description="The context contract is typed, but no real organizations, projects or permissions are created in Stage 0." />
        </Surface>
      </div>
      <Surface title={`${route.label} operational area`} eyebrow="Explicit empty state">
        <StatePanel kind="empty" title="This module is not operational yet" description="This screen establishes navigation, layout and state handling only. Domain records and workflows will appear after their governing work package is approved and implemented." />
      </Surface>
    </div>
  );
}
