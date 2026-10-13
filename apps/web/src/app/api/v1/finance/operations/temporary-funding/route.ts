import { assertMutation, readBody } from "@/server/identity";
import {
  runTemporaryFundingCommand, temporaryFundingCommand, temporaryFundingErrorResponse, temporaryFundingWorkspace
} from "@/server/temporary-funding";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Temporary funding providers, physical Safe positions and fundings of the signed-in company. */
export async function GET() {
  try {
    return json({ ok: true, data: await temporaryFundingWorkspace() });
  } catch (error) {
    return temporaryFundingErrorResponse(error);
  }
}

/** One temporary funding command ({ action, ...fields }). Repeating the same request key returns the first result. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const command = temporaryFundingCommand(await readBody(request));
    const result = await runTemporaryFundingCommand(command);
    return json({ ok: true, data: result }, result.replayed === false ? 201 : 200);
  } catch (error) {
    return temporaryFundingErrorResponse(error);
  }
}
