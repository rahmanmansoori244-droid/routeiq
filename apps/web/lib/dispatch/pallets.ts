/**
 * Truck capacity in pallets (owner decision 4 Oct 2026). Pure: shared by the request builder, the
 * dispatch gate, the screens and the tests.
 *
 * "All cases stay in cases, but when it comes to loading they are transformed to pallets, and in
 * total they should be less than the truck capacity." A truck with bays (pallet positions) is planned
 * by pallets: mixed pallets are allowed, so a load's pallet need is the sum over its products of
 * cases / cases per pallet (fractions add up), and it fits when that need is at most bays x the
 * company's Pallet fill (TenantConfig.palletFillPct, the safety margin, default 95%) AND its kg is at
 * most the payload. A truck without bays keeps the case rule.
 *
 * Units: whole 1/1000 pallets (PALLET_UNIT), each order line rounded UP once (never under-counted),
 * then added up as integers - the web, the optimizer, the stored rows and every check add the same
 * integers (the pattern of the kg tenths, audit F08). 84 cases of an 84-per-pallet product = 1,000
 * units = 1.0 pallet exactly. apps/solver/dispatch_models.py has the optimizer's copy of the rule.
 */

/** One pallet unit = 1/1000 pallet. */
export const PALLET_UNIT = 0.001;
/** Units per pallet. */
export const UNITS_PER_PALLET = 1000;
/** A cases-per-pallet factor must be a whole number in this range (anything else counts as missing). */
export const PALLET_FACTOR_MAX = 10_000;

/** A product's cases per pallet when it is usable: a whole number 1-10,000; anything else (null, 0, 84.5) = null. */
export function validPalletFactor(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= PALLET_FACTOR_MAX ? v : null;
}

/**
 * The pallet need of `cases` of a product with `cpp` cases per pallet, in units, rounded UP:
 * ceil(cases x 1000 / cpp), in integers. 84 cases at 84 = 1,000; 100 at 96 = 1,042; 0 cases = 0.
 * A missing factor (null) counts 0: such a day is refused before it reaches the optimizer.
 */
export function palletUnits(cases: number, cpp: number | null | undefined): number {
  const f = validPalletFactor(cpp);
  if (f === null || !(cases > 0)) return 0;
  return Math.floor((Math.round(cases) * UNITS_PER_PALLET + f - 1) / f);
}

/** A bay truck's room in units: bays x fill % x 10 (12 bays at 95% = 11,400 = 11.4 pallets). */
export function palletRoomUnits(bays: number, fillPct: number): number {
  return Math.round(bays) * Math.round(fillPct) * 10;
}

/** A truck's bays when usable (a whole number 1-40), else null (planned by cases). */
export function validBays(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 40 ? v : null;
}

/** Pallets to one decimal, halves up: 11,400 -> "11.4", 2,513 -> "2.5", 160,250 -> "160.3". */
export function palletText(units: number): string {
  const neg = units < 0;
  const tenths = Math.floor((Math.abs(Math.round(units)) + 50) / 100);
  const whole = Math.floor(tenths / 10).toLocaleString('en-US');
  const text = `${whole}.${tenths % 10}`;
  return neg && tenths ? `-${text}` : text;
}

/**
 * Full pallets and loose cases of one product on a manifest: 300 cases at 96 per pallet = 3 pallets
 * + 12 cases. Without a factor: everything loose.
 */
export function fullAndLoose(cases: number, cpp: number | null | undefined): { full: number; loose: number } {
  const f = validPalletFactor(cpp);
  if (f === null || !(cases > 0)) return { full: 0, loose: Math.max(0, cases) };
  const full = Math.floor(cases / f);
  return { full, loose: cases - full * f };
}

/** "3 pallets + 12 cases", "1 pallet", "40 cases" (the loading manifest's words). */
export function fullAndLooseText(cases: number, cpp: number | null | undefined): string {
  const { full, loose } = fullAndLoose(cases, cpp);
  const p = full ? `${full} pallet${full === 1 ? '' : 's'}` : '';
  const c = loose || !full ? `${loose} case${loose === 1 ? '' : 's'}` : '';
  return p && c ? `${p} + ${c}` : p || c;
}

/** A product of the day without a usable cases per pallet (the PALLET_FACTOR_REQUIRED answer). */
export interface MissingPalletFactor {
  productId: string;
  productCode: string;
  productName: string;
  lines: number;
  cases: number;
}

/** Group the open lines whose product has no usable factor per product, biggest first. */
export function groupMissingPalletFactors(lines: { productId: string; productCode: string; productName: string; cases: number }[]): MissingPalletFactor[] {
  const m = new Map<string, MissingPalletFactor>();
  for (const l of lines) {
    const g = m.get(l.productId) ?? { productId: l.productId, productCode: l.productCode, productName: l.productName, lines: 0, cases: 0 };
    g.lines++;
    g.cases += l.cases;
    m.set(l.productId, g);
  }
  return [...m.values()].sort((a, b) => b.cases - a.cases || a.productCode.localeCompare(b.productCode));
}

/** "TN1.5L (120 cases), SS6L (40 cases)" - at most `max` named, then "and N more". */
export function describeMissingPalletFactors(list: MissingPalletFactor[], max = 6): string {
  const shown = list.slice(0, max).map((u) => `${u.productCode} (${u.cases} cases)`);
  return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : shown.join(', ');
}

/**
 * The PALLET_FACTOR_REQUIRED refusal (no override): "Cannot plan by pallets: 3 product(s) on this
 * day's orders have no cases per pallet: TN1.5L (120 cases), ... Enter the cases per pallet under
 * Products (company admins can edit products), then optimize again."
 */
export function palletFactorRefusal(list: MissingPalletFactor[], verb: 'optimize' | 're-plan' = 'optimize'): string {
  return (
    `Cannot plan by pallets: ${list.length} product(s) on this day's orders have no cases per pallet: ${describeMissingPalletFactors(list)}. ` +
    `Enter the cases per pallet under Products (company admins can edit products), then ${verb} again.`
  );
}

/**
 * The PALLET_FACTOR_REQUIRED answer of OPTIMIZE / RE-PLAN (start-optimize gate): 409 with the products
 * to fix, no override (the pallet need cannot be guessed); null when every factor is there or the day
 * has no truck with bays. The screen links to its own Products page.
 */
export function palletFactorGate(
  built: { missingPalletFactors?: MissingPalletFactor[] },
  verb: 'optimize' | 're-plan' = 'optimize',
): { status: number; body: Record<string, unknown> } | null {
  const missing = built.missingPalletFactors ?? [];
  if (!missing.length) return null;
  return { status: 409, body: { error: palletFactorRefusal(missing, verb), code: 'PALLET_FACTOR_REQUIRED', missingPalletFactors: missing } };
}
