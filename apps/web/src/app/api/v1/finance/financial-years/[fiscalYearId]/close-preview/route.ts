import { financialYearPreviewGet } from "@/server/periods-reversals";

export const dynamic = "force-dynamic";

/** What closing this financial year means, shown before the close is confirmed. Reads only. */
export async function GET(_request: Request, { params }: { readonly params: Promise<{ readonly fiscalYearId: string }> }) {
  return financialYearPreviewGet((await params).fiscalYearId);
}
