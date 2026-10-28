import { periodPreviewGet } from "@/server/periods-reversals";

export const dynamic = "force-dynamic";

/** What closing this month means, shown before the close is confirmed. Reads only. */
export async function GET(_request: Request, { params }: { readonly params: Promise<{ readonly periodId: string }> }) {
  return periodPreviewGet((await params).periodId);
}
