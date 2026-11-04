import type { JournalReversalWorkspace, ReportSource } from "@abos/contracts";

type ReadSources = (journalIds: readonly string[]) => Promise<Readonly<Record<string, ReportSource>>>;

/**
 * What the reversal list may say about a journal: its label and, for a reader the database authorized, its detail. The report
 * source also carries the source id, a link and the counterparty, which any report reader receives (0053). This list needs none
 * of them, so they never leave the server here, whatever the reader holds.
 */
function listSource(source: ReportSource | undefined): ReportSource | null {
  if (source === undefined) return null;
  return { type: source.type, id: null, label: source.label, route: null, counterparty: null, detail: source.detail ?? null };
}

/**
 * Adds what each listed journal was. The database decides the detail per reader (0055): it needs the source module's
 * permission, and a journal outside the reader's scope is RESTRICTED. Someone who may reverse but cannot read Finance reports
 * gets no source at all and keeps the plain transaction type. Any other failure is a failure.
 */
export async function withJournalSources(workspace: JournalReversalWorkspace, read: ReadSources): Promise<JournalReversalWorkspace> {
  if (workspace.journals.length === 0) return workspace;
  let sources: Readonly<Record<string, ReportSource>> = {};
  try {
    sources = await read(workspace.journals.map((journal) => journal.id));
  } catch (error) {
    if (!(error instanceof Error && /current authority is missing finance\.report\.operational\.read/.test(error.message))) throw error;
  }
  return { ...workspace, journals: workspace.journals.map((journal) => ({ ...journal, source: listSource(sources[journal.id]) })) };
}
