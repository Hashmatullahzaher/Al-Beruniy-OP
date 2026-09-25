import { calendarErrorResponse, calendarView, configureCalendar } from "@/server/finance-calendar";
import { assertMutation, readBody, stringList, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await calendarView() });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const number = (key: string) => (typeof body[key] === "number" ? body[key] as number : null);
    const version = await configureCalendar({
      calendarKind: text(body, "calendarKind"), customStartMonth: number("customStartMonth"), customStartDay: number("customStartDay"),
      reportingCalendars: stringList(body, "reportingCalendars"), expectedVersion: number("expectedVersion") ?? -1
    });
    return json({ ok: true, data: { version } });
  } catch (error) {
    return calendarErrorResponse(error);
  }
}
