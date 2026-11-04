import type { JournalReversalWorkspace, ReportSource } from "@abos/contracts";

type ReadSources = (journalIds: readonly string[]) => Promise<Readonly<Record<string, ReportSource>>>;

/**
 * Adds what each listed journal was. The database masks it per reader (0055): without the source module's permission the
 * detail is withheld, and a journal outside the reader's scope is RESTRICTED. Someone who may reverse but cannot read Finance
 * reports gets no source at all and keeps the plain transaction type. Any other failure is a failure.
 */
export async function withJournalSources(workspace: JournalReversalWorkspace, read: ReadSources): Promise<JournalReversalWorkspace> {
  if (workspace.journals.length === 0) return workspace;
  let sources: Readonly<Record<string, ReportSource>> = {};
  try {
    sources = await read(workspace.journals.map((journal) => journal.id));
  } catch (error) {
    if (!(error instanceof Error && /current authority is missing finance\.report\.operational\.read/.test(error.message))) throw error;
  }
  return { ...workspace, journals: workspace.journals.map((journal) => ({ ...journal, source: sources[journal.id] ?? null })) };
}
