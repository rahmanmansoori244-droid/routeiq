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

/** Pallets as a number to one decimal, halves up like palletText (11,450 -> 11.5): for spreadsheet cells. */
export function palletValue(units: number): number {
  const sign = units < 0 ? -1 : 1;
  return (sign * Math.floor((Math.abs(Math.round(units)) + 50) / 100)) / 10;
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

// ---------------------------------------------------------------------------------------
// Outputs (part B): the plan screen, the Excel workbook, the driver sheet and WhatsApp show pallets
// IN ADDITION to cases, and only for a load planned by pallets (a truck with bays, the optimizer
// echoed the rule). Orders, invoices, the driver page and the stops stay in cases.
// ---------------------------------------------------------------------------------------

/** A load planned by pallets: its stored pallets, its truck's bays, the fill and the room (bays x fill x 10) as planned. */
export interface LoadPallets {
  units: number;
  room: number;
  bays: number;
  fillPct: number | null;
}

/**
 * The pallets of a load when it was planned by pallets (PlanLoad.palletUnits and the truck snapshot's
 * bays and room, both kept only from the optimizer's echo); null = planned by cases (a truck without
 * bays, an older plan, or an older optimizer).
 */
export function loadPallets(l: { palletUnits?: number | null; palletRoomUnits?: number | null; bays?: number | null; palletFillPct?: number | null }): LoadPallets | null {
  if (typeof l.palletUnits !== 'number' || typeof l.palletRoomUnits !== 'number' || typeof l.bays !== 'number' || l.bays <= 0) return null;
  return { units: l.palletUnits, room: l.palletRoomUnits, bays: l.bays, fillPct: typeof l.palletFillPct === 'number' ? l.palletFillPct : null };
}

/** "11.1 / 12" - the load's pallets over its truck's bays. */
export function palletsOverBays(p: LoadPallets): string {
  return `${palletText(p.units)} / ${p.bays}`;
}

/** "limit 11.4 at 95% fill" - the most the planner could put on the truck. */
export function palletLimitText(p: LoadPallets): string {
  return `limit ${palletText(p.room)}${p.fillPct !== null ? ` at ${p.fillPct}% fill` : ''}`;
}

/** The share of the bays a load fills, in % to one decimal (11,400 units on 12 bays = 95.0). Against the physical bays, never the fill. */
export function bayFillPct(units: number, bays: number): number {
  if (!(bays > 0)) return 0;
  return Math.round(units / bays) / 10;
}

/** One product of a manifest with its pallets (a load planned by pallets). */
export interface ManifestPallets {
  casesPerPallet: number | null;
  fullPallets: number;
  looseCases: number;
  /** The product's pallet need on this load, in units (each order line rounded up, added up). */
  palletUnits: number;
}

/**
 * A load's manifest rows with their pallets (a load planned by pallets): each product's cases per
 * pallet as planned, full pallets + loose cases, and its pallet need (`unitsByCode`, its order lines'
 * units added up, so the products add up to the load's stored pallets). `pallets` null: the rows as
 * they are (a load planned by cases).
 */
export function withManifestPallets<R extends { productCode: string; cases: number }>(
  rows: R[],
  pallets: { unitsByCode: ReadonlyMap<string, number>; factorByCode: ReadonlyMap<string, number> } | null,
): (R & Partial<ManifestPallets>)[] {
  if (!pallets) return rows;
  return rows.map((r) => {
    const cpp = pallets.factorByCode.get(r.productCode) ?? null;
    const { full, loose } = fullAndLoose(r.cases, cpp);
    return { ...r, casesPerPallet: cpp, fullPallets: full, looseCases: loose, palletUnits: pallets.unitsByCode.get(r.productCode) ?? palletUnits(r.cases, cpp) };
  });
}

/** Full pallets and loose cases of a manifest, added up over its products. */
export function manifestPalletTotals(rows: { fullPallets?: number; looseCases?: number; cases: number }[]): { full: number; loose: number } {
  let full = 0;
  let loose = 0;
  for (const r of rows) {
    full += r.fullPallets ?? 0;
    loose += typeof r.looseCases === 'number' ? r.looseCases : r.cases;
  }
  return { full, loose };
}

/** "1,045 cases = 11.1 pallets (8 full pallets + 293 loose cases on mixed pallets)" - a manifest's TOTAL. */
export function manifestTotalText(cases: number, units: number, totals: { full: number; loose: number }): string {
  const parts = [
    totals.full ? `${totals.full} full pallet${totals.full === 1 ? '' : 's'}` : '',
    totals.loose ? `${totals.loose.toLocaleString('en-US')} loose case${totals.loose === 1 ? '' : 's'} on mixed pallets` : '',
  ].filter(Boolean);
  return `${cases.toLocaleString('en-US')} cases = ${palletText(units)} pallets${parts.length ? ` (${parts.join(' + ')})` : ''}`;
}

/**
 * The note of a product save whose cases per pallet changed (PATCH /api/products/[id]); null when it
 * did not change. Plans keep the pallets they were made with (stored per row and load).
 */
export function palletFactorChangedNote(before: number | null | undefined, after: number | null | undefined): string | null {
  const b = validPalletFactor(before);
  const a = validPalletFactor(after);
  if (a === b) return null;
  if (a === null) return 'Cases per pallet removed: a day with trucks that have bays cannot be optimized while this product is on its orders.';
  return 'Cases per pallet saved. Loads planned before keep the pallets they were planned with; re-plan to use it.';
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
