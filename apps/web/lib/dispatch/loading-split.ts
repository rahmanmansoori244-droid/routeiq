/**
 * Special-loading lines (owner request 20 Oct 2026). A customer with a loading instruction (for example
 * a chain whose products carry their own barcodes and are unloaded in their own way) is loaded apart. A
 * box at the top of the sheet was not enough: the warehouse still had to take those customers' cases off
 * each product's total itself, and made mistakes. So every per-load list of products is split:
 *  - the normal lines: each product's cases for every other customer;
 *  - one block per instruction text, with its own lines and its own total: exactly the cases to load the
 *    special way, never anything to subtract;
 *  - the load's grand total unchanged (normal + every block = the products' total, per product too).
 *
 * The rule, per order line of the load: a line belongs to the block of its stop's instruction (folded as
 * the box folds it, loadingInstructionText; letter case ignored, so "SPECIAL" and "Special" typed on two
 * branches are one block) when its order is neither cancelled nor brought forward to a later day and it
 * has cases. Every other line stays in the normal lines - the cancelled and brought-forward orders of any
 * customer too, as the sheets' banners already say. So a block's stops are exactly the box's stops
 * (stopIsLoaded). A split order's part counts only the cases on this load (its order lines carry them).
 *
 * The block is named by the instruction text itself (data): no customer or chain is named in the code.
 * Each of its rows carries a short tag (the text, shortened past LOADING_TAG_MAX characters).
 *
 * Pure, browser-safe (the plan screen uses it): shared by the load sheet, the Excel workbook, the driver
 * sheet and the plan screen, so every paper splits a load the same way.
 */
import { loadingInstructionText } from './loading-instruction';
import { fullAndLoose, palletUnits as linePalletUnits } from './pallets';

/** A block's tag on each of its rows: the instruction text, shortened past this many characters. */
export const LOADING_TAG_MAX = 24;

/** What the split reads of one order line of a stop (DetailOrderLine has it all). */
export interface SplitLine {
  orderId: string;
  productCode: string;
  cases: number;
  /** The line's kg as planned; absent: the product row's kg shared by cases. */
  weightKg?: number;
  /** The line's pallet units (a load planned by pallets); absent: worked out with the row's cases per pallet. */
  palletUnits?: number;
}

/** What the split reads of a stop (DetailStop has it all). */
export interface SplitStop {
  sequence: number;
  loadingInstruction?: string | null;
  cancelledOrderIds?: readonly string[];
  carriedOrderIds?: readonly string[];
  orderLines: readonly SplitLine[];
}

/** What the split reads of one product row (a manifest row, or the load sheet's products). */
export interface SplitInputRow {
  productCode: string;
  productName: string;
  cases: number;
  weightKg?: number;
  casesPerPallet?: number | null;
  palletUnits?: number;
}

/** One product line of the split: its cases, and its kg and pallets when the input rows have them. */
export interface SplitRow {
  productCode: string;
  productName: string;
  cases: number;
  weightKg?: number;
  casesPerPallet?: number | null;
  fullPallets?: number;
  looseCases?: number;
  palletUnits?: number;
}

/** One special-loading block: the customers of one instruction text on the load. */
export interface LoadingGroup {
  /** The text folded and upper-cased: what joins two stops into one block. */
  key: string;
  /** The text of the block's first stop (as the box prints it). */
  text: string;
  /** The short label on each row ("SPECIAL"; a long text shortened with "…"). */
  tag: string;
  /** Its stops on the load, ascending. */
  stops: number[];
  /** Its products, in the order of the input rows. */
  rows: SplitRow[];
  cases: number;
  weightKg?: number;
  palletUnits?: number;
}

export interface ManifestSplit {
  /** Every product's cases for the other customers; a product with none left is not listed. */
  normal: SplitRow[];
  normalCases: number;
  normalWeightKg?: number;
  normalPalletUnits?: number;
  /** One block per instruction text, in the order of their first stop. */
  groups: LoadingGroup[];
}

export interface SplitResult {
  /** null: nothing to split (no loaded line of a customer with an instruction), or the mismatch below. */
  split: ManifestSplit | null;
  /**
   * The stops' order lines hold more cases of a product than the rows (or a product the rows do not have):
   * never expected (both come from the same plan rows). Nothing is split; the sheets say so.
   */
  mismatch: boolean;
}

const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);
// To 0.1 kg like the manifest (never -0).
const round1 = (x: number) => Math.round(x * 10) / 10 || 0;

/**
 * The tag of one text: as it is up to LOADING_TAG_MAX characters, else cut (at a word when one ends in the
 * second half of the cut, never half of a two-unit character, without the spaces and commas before the
 * cut) with "…": "Water at the bottom, max 5 layers" -> "Water at the bottom…".
 */
export function loadingTag(text: string): string {
  if (text.length <= LOADING_TAG_MAX) return text;
  let cut = text.slice(0, LOADING_TAG_MAX - 1).replace(/[\uD800-\uDBFF]$/, '');
  const space = cut.lastIndexOf(' ');
  if (text[cut.length] !== ' ' && space >= LOADING_TAG_MAX / 2) cut = cut.slice(0, space);
  const trimmed = cut.replace(/[\s,;:.\-]+$/, '');
  return `${trimmed || cut}…`;
}

/** The tags of several blocks, in order: two that would read the same get " (2)", " (3)"... */
export function loadingTags(texts: readonly string[]): string[] {
  const used = new Set<string>();
  return texts.map((t) => {
    const base = loadingTag(t);
    let tag = base;
    for (let n = 2; used.has(tag.toUpperCase()); n++) tag = `${base} (${n})`;
    used.add(tag.toUpperCase());
    return tag;
  });
}

/** The key two stops share a block by: the folded text, upper-cased. */
export function loadingGroupKey(text: string): string {
  return text.toUpperCase();
}

/**
 * A load's products split into the normal lines and one block per instruction text (see the top of this
 * file). `rows` are the load's products (one row per product code), in the order the caller prints them;
 * the split keeps it. Kg and pallets are split only when every row has them: a line's kg is its own
 * (else the row's kg shared by cases), its pallet units its own (else its cases over the row's cases per
 * pallet); the normal line takes the rest, so normal + every block = the row, exactly. Full pallets and
 * loose cases are worked out per line shown (each block is built as its own pallets).
 */
export function splitByLoadingInstruction<R extends SplitInputRow>(rows: readonly R[], stops: readonly SplitStop[]): SplitResult {
  type Acc = { key: string; text: string; stops: number[]; lines: Map<string, SplitLine[]> };
  const acc = new Map<string, Acc>();
  for (const s of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    const text = loadingInstructionText(s.loadingInstruction);
    if (!text) continue;
    const gone = new Set([...(s.cancelledOrderIds ?? []), ...(s.carriedOrderIds ?? [])]);
    const loaded = s.orderLines.filter((ln) => !gone.has(ln.orderId) && ln.cases > 0);
    if (!loaded.length) continue;
    const key = loadingGroupKey(text);
    const g = acc.get(key) ?? { key, text, stops: [], lines: new Map<string, SplitLine[]>() };
    if (!g.stops.includes(s.sequence)) g.stops.push(s.sequence);
    for (const ln of loaded) g.lines.set(ln.productCode, [...(g.lines.get(ln.productCode) ?? []), ln]);
    acc.set(key, g);
  }
  if (!acc.size) return { split: null, mismatch: false };

  const byCode = new Map(rows.map((r) => [r.productCode, r]));
  const taken = new Map<string, number>();
  for (const g of acc.values()) for (const [code, lns] of g.lines) taken.set(code, (taken.get(code) ?? 0) + sum(lns.map((l) => l.cases)));
  for (const [code, cases] of taken) {
    const r = byCode.get(code);
    if (!r || cases > r.cases) return { split: null, mismatch: true };
  }

  const kgOn = rows.length > 0 && rows.every((r) => typeof r.weightKg === 'number');
  const palletsOn = rows.length > 0 && rows.every((r) => typeof r.palletUnits === 'number');
  const lineKg = (ln: SplitLine, r: R) => (typeof ln.weightKg === 'number' ? ln.weightKg : r.cases > 0 ? ((r.weightKg ?? 0) * ln.cases) / r.cases : 0);
  const lineUnits = (ln: SplitLine, r: R) => (typeof ln.palletUnits === 'number' ? ln.palletUnits : linePalletUnits(ln.cases, r.casesPerPallet));
  const rowOf = (r: R, cases: number, kg: number, units: number): SplitRow => {
    const out: SplitRow = { productCode: r.productCode, productName: r.productName, cases };
    if (kgOn) out.weightKg = kg;
    if (palletsOn) {
      const { full, loose } = fullAndLoose(cases, r.casesPerPallet);
      Object.assign(out, { casesPerPallet: r.casesPerPallet ?? null, fullPallets: full, looseCases: loose, palletUnits: units });
    }
    return out;
  };
  const totals = (xs: readonly SplitRow[]) => ({
    ...(kgOn ? { weightKg: round1(sum(xs.map((x) => x.weightKg ?? 0))) } : {}),
    ...(palletsOn ? { palletUnits: sum(xs.map((x) => x.palletUnits ?? 0)) } : {}),
  });

  const list = [...acc.values()];
  const tags = loadingTags(list.map((g) => g.text));
  const groups: LoadingGroup[] = list.map((g, i) => {
    const out: SplitRow[] = [];
    for (const r of rows) {
      const lns = g.lines.get(r.productCode);
      if (!lns || out.some((x) => x.productCode === r.productCode)) continue;
      out.push(rowOf(r, sum(lns.map((l) => l.cases)), round1(sum(lns.map((l) => lineKg(l, r)))), sum(lns.map((l) => lineUnits(l, r)))));
    }
    return { key: g.key, text: g.text, tag: tags[i]!, stops: g.stops, rows: out, cases: sum(out.map((x) => x.cases)), ...totals(out) };
  });

  const normal: SplitRow[] = [];
  for (const r of rows) {
    const mine = groups.flatMap((g) => g.rows.filter((x) => x.productCode === r.productCode));
    const cases = r.cases - sum(mine.map((x) => x.cases));
    if (cases <= 0) continue;
    normal.push(rowOf(r, cases, round1((r.weightKg ?? 0) - sum(mine.map((x) => x.weightKg ?? 0))), (r.palletUnits ?? 0) - sum(mine.map((x) => x.palletUnits ?? 0))));
  }
  const t = totals(normal);
  return {
    split: {
      normal,
      normalCases: sum(normal.map((x) => x.cases)),
      ...(t.weightKg !== undefined ? { normalWeightKg: t.weightKg } : {}),
      ...(t.palletUnits !== undefined ? { normalPalletUnits: t.palletUnits } : {}),
      groups,
    },
    mismatch: false,
  };
}
