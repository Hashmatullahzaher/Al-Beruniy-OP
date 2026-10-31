import { financialYearClosePost, financialYearsGet } from "@/server/periods-reversals";

export const dynamic = "force-dynamic";
/** The company's financial years, each ACTIVE or CLOSED. */
export const GET = financialYearsGet;
/** { fiscalYearId, correlationId? }: closes the financial year; returns the refreshed workspace. */
export const POST = financialYearClosePost;
