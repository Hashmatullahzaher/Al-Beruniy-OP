/**
 * JSON produced by `abos.company_dashboard_summary` (migration 0030). Aggregate counts only, from
 * sources that exist in V1; anything without a source is absent here and shown as not connected.
 */
export interface CompanyDashboardSummary {
  readonly legalEntityName: string | null;
  readonly projects: {
    readonly active: number;
    readonly total: number;
  };
}
