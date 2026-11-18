/**
 * The Stage 0 demo screens (Projects, Sales & CRM, the Finance preview, Construction, Procurement, Human Resources, Reports & Analytics,
 * AI Insights, Settings) are development and review material (owner decision, 2026-11-11). A production build serves none of them: their
 * addresses answer Not Found and the shell lists none of them. `next dev` keeps them reachable for review.
 */
export const stageZeroAvailable = process.env.NODE_ENV !== "production";
