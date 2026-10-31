import { journalDetailGet } from "@/server/reporting";

export const dynamic = "force-dynamic";

/** One posted journal: lines, business source and reversal links (masked outside the reader's scope). Reads only. */
export async function GET(_request: Request, { params }: { readonly params: Promise<{ readonly journalId: string }> }) {
  return journalDetailGet((await params).journalId);
}
