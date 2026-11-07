import { documentsGet, documentsPost } from "@/server/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What is attached to one record, and attaching a new file to it. */
export const GET = documentsGet;
export const POST = documentsPost;
