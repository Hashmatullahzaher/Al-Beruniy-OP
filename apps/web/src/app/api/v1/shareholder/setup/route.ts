import { assertMutation, readBody } from "@/server/identity";
import {
  runShareholderSetupCommand, shareholderSetupCommand, shareholderSetupErrorResponse, shareholderSetupWorkspace
} from "@/server/shareholder-setup";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Shareholders, DRAFT capital agreements, installments and agreement documents of the signed-in company. */
export async function GET() {
  try {
    return json({ ok: true, data: await shareholderSetupWorkspace() });
  } catch (error) {
    return shareholderSetupErrorResponse(error);
  }
}

/** One setup command ({ action, ...fields }). Repeating the same request key returns the first result. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const command = shareholderSetupCommand(await readBody(request));
    const result = await runShareholderSetupCommand(command);
    return json({ ok: true, data: result }, result.replayed === false ? 201 : 200);
  } catch (error) {
    return shareholderSetupErrorResponse(error);
  }
}
