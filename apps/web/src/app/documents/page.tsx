import type { Metadata } from "next";

import { DocumentsGuide } from "@/components/DocumentsGuide";

export const metadata: Metadata = { title: "Documents", description: "Where each kind of document is kept in the Document Vault." };

// Replaces the Stage 0 document prototype at this address. The prototype component stays in the repository, unrouted.
export default function DocumentsPage() {
  return <DocumentsGuide />;
}
