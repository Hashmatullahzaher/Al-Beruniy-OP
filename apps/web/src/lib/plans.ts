// Client-supplied furnished 3D plan renders → image path + area.
// Only 7 of the 9 known marketing plan labels have a supplied render; the
// other labels intentionally resolve to no image (Assign / Upload state).

export interface PlanDef {
  label: string
  areaM2: number
  image?: string // served from /public/plans
}

export const PLAN_CATALOG: PlanDef[] = [
  { label: 'A-1', areaM2: 137, image: '/plans/a-1.jpg' },
  { label: 'B-1', areaM2: 121, image: '/plans/b-1.jpg' },
  { label: 'B-3', areaM2: 180, image: '/plans/b-3.jpg' },
  { label: 'C-1', areaM2: 124, image: '/plans/c-1.jpg' },
  { label: 'C-2', areaM2: 140, image: '/plans/c-2.jpg' },
  { label: 'C-3', areaM2: 206, image: '/plans/c-3.jpg' },
  { label: 'D-1', areaM2: 138, image: '/plans/d-1.jpg' },
  { label: 'D-2', areaM2: 146, image: '/plans/d-2.jpg' },
  { label: 'E-1', areaM2: 147, image: '/plans/e-1.jpg' },
]

export function planByLabel(label?: string): PlanDef | undefined {
  if (!label) return undefined
  return PLAN_CATALOG.find((p) => p.label === label)
}

export function planImageFor(label?: string, override?: string): string | undefined {
  if (override) return override
  return planByLabel(label)?.image
}

// Plan options that actually have an image (for the "assign plan image" picker).
export const PLANS_WITH_IMAGE = PLAN_CATALOG.filter((p) => p.image)
