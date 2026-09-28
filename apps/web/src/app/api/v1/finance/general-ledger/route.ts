import { generalLedgerView } from "@/server/general-ledger";
import { errorResponse, json } from "@/server/treasury";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const accountId = params.get("accountId")?.trim() || null;
  if (!validDate(from) || !validDate(to) || from > to || (accountId !== null && !UUID.test(accountId))) {
    return json({ ok: false, error: { code: "VALIDATION_FAILED", message: "Choose a valid inclusive date range and account." } }, 422);
  }
  try {
    return json({ ok: true, data: await generalLedgerView(from, to, accountId) });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    const message = error instanceof Error ? error.message : "";
    if (code === "42501") {
      const expired = /session is invalid|authorization is not active|bearer credential/i.test(message);
      return json({ ok: false, error: { code: expired ? "AUTHENTICATION_REQUIRED" : "PERMISSION_DENIED", message: expired ? "Your session has ended. Sign in again." : "General Ledger access is not available for this identity or legal entity." } }, expired ? 401 : 403);
    }
    return errorResponse(error);
  }
}
