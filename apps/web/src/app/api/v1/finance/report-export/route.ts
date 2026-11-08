import { reportExportGet } from "@/server/report-export";

export const dynamic = "force-dynamic";

/** A report as CSV (Excel-compatible): the screen's own payload, recorded as an audit event, never stored. */
export async function GET(request: Request) {
  return reportExportGet(request);
}
