/**
 * Loading instruction per customer (owner request 16 Oct 2026: some customers need their order loaded on
 * the truck in a specific way, so the dispatcher and the warehouse must see it at the top of the load
 * sheet). Customer.loadingInstruction, one short text per
 * customer row (a branch is its own row), set in the Details dialog; NULL = none. The text itself is data,
 * entered by the company: no customer or chain is named in the code.
 *
 * Where it shows (read live, like the access notes: a change reaches every sheet printed after it, and a
 * re-plan is never needed; it is never sent to the optimizer and never kept in a plan snapshot):
 *  - the warehouse load sheet: a "SPECIAL LOADING" box under the title, one line per customer with its
 *    stop numbers, and a tag on the customer's invoice rows (warehouse-sheets.ts / -html.ts);
 *  - the driver sheet (PDF) and the Excel per-load sheet: the same lines at the top, and the text on the
 *    customer's stop (driver-pack.tsx, workbook.ts);
 *  - the plan screen: a badge on the load and on the stop (plan-view.tsx);
 *  - every per-load list of products (owner request 20 Oct 2026: such a customer's products have their
 *    own barcodes and are loaded apart): the load's products split into the normal lines and one block
 *    per instruction text with its own total (loading-split.ts).
 * A stop nothing of which is loaded - every order cancelled, or brought forward to a later day - is not
 * listed: those orders must not be loaded from the paper anyway.
 *
 * Pure, no imports: shared by the dialog (browser), the API schema, the plan detail and every sheet.
 */

/** The plan screen's badge on a load and on a stop with such a customer. */
export const LOADING_INSTRUCTION_BADGE = 'LOADING INSTRUCTION';

/** The heading of the box at the top of the printed sheets (load sheet, driver sheet, Excel load sheet). */
export const SPECIAL_LOADING_HEADING = 'SPECIAL LOADING';

/** The line under the heading: "Load this truck as this customer requires:" (or "these customers require"). */
export function specialLoadingLead(customers: number): string {
  return `Load this truck as ${customers === 1 ? 'this customer requires' : 'these customers require'}:`;
}

/** The driver sheet's one-line box title: "SPECIAL LOADING - load as this customer requires:". */
export function specialLoadingTitle(customers: number): string {
  return `${SPECIAL_LOADING_HEADING} - load as ${customers === 1 ? 'this customer requires' : 'these customers require'}:`;
}

/** The tag on the customer's invoice rows of the warehouse load sheet. */
export const SPECIAL_LOADING_ROW_TAG = 'SPECIAL LOADING - see the box at the top';

/** The customer field's label (Details dialog, customer page). */
export const LOADING_INSTRUCTION_FIELD_LABEL = 'Loading instruction (warehouse)';

/** At most this many characters (the box must stay short enough to read at a glance). */
export const LOADING_INSTRUCTION_MAX = 200;

export type LoadingInstructionRead = { ok: true; text: string | null } | { ok: false; error: string };

// Control characters (C0 except the whitespace ones, DEL, C1) are dropped; every run of whitespace
// (line breaks and tabs included) becomes one space, so the instruction is always one line.
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;
// Invisible format characters are dropped too (review of 16 Oct): the zero-width space, the direction marks
// and the direction embeddings, overrides and isolates (U+061C, U+200E-200F, U+202A-202E, U+2066-2069),
// the word joiner and the invisible operators (U+2060-2064) and the byte-order mark. A right-to-left
// override hidden in one customer's text would reverse what follows it where the lines are joined (the
// Excel box cell, the plan screen's badge title); the load sheet isolates each text (<bdi>), so Arabic
// prints the same without them. The zero-width joiners (U+200C, U+200D) are kept: they shape letters.
const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// A text made only of joiners and spaces prints nothing visible: none.
const JOINERS_ONLY = /^[\s\u200C\u200D]*$/;

/** The text as it is stored and printed: no control or invisible characters, one line, trimmed ('' = none). */
function clean(raw: string): string {
  const text = raw.replace(CONTROL, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return JOINERS_ONLY.test(text) ? '' : text;
}

/**
 * The text as it would be stored, without the length rule ('' = none): what the Details dialog compares, to
 * tell a change from the same text typed differently, and counts for its N/200 counter.
 */
export function foldLoadingInstruction(raw: string): string {
  return clean(raw);
}

/**
 * An instruction as typed (Details, the API): the text to store, null for none ('' or only spaces), or why
 * it is refused (more than LOADING_INSTRUCTION_MAX characters once folded to one line, or not text).
 */
export function readLoadingInstruction(raw: unknown): LoadingInstructionRead {
  if (raw === null || raw === undefined) return { ok: true, text: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Loading instruction: text only.' };
  const text = clean(raw);
  if (!text) return { ok: true, text: null };
  if (text.length > LOADING_INSTRUCTION_MAX) {
    return { ok: false, error: `Loading instruction: at most ${LOADING_INSTRUCTION_MAX} characters (${text.length} typed).` };
  }
  return { ok: true, text };
}

/**
 * The stored instruction as the sheets and the plan screen show it: folded to one line and, if longer than
 * LOADING_INSTRUCTION_MAX (a value written to the database by hand), cut there with "…" - never dropped,
 * so a box is always printed for a customer that has one. Null = none.
 */
export function loadingInstructionText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = clean(raw);
  if (!text) return null;
  if (text.length <= LOADING_INSTRUCTION_MAX) return text;
  // Never half a character (an emoji is two UTF-16 units).
  const cut = text.slice(0, LOADING_INSTRUCTION_MAX - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.trimEnd()}…`;
}

/** What loadInstructions reads of a stop (DetailStop has it all). */
export interface InstructionStop {
  sequence: number;
  customerId: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  /** The customer's instruction as it is now (DetailStop.loadingInstruction); absent / null = none. */
  loadingInstruction?: string | null;
  orderIds: readonly string[];
  /** Orders of the stop cancelled since planning (only on a load that has not left). */
  cancelledOrderIds?: readonly string[];
  /** Orders of the stop brought forward to a later day (only on a load that has not left). */
  carriedOrderIds?: readonly string[];
}

/** One customer's instruction on a load, with its stops there (ascending). */
export interface LoadInstruction {
  stops: number[];
  customerId: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  text: string;
}

/**
 * Something of the stop is loaded: not every one of its orders was cancelled or brought forward to a later
 * day (a stop with one order brought forward and another still due is loaded, review L1).
 */
export function stopIsLoaded(s: Pick<InstructionStop, 'orderIds' | 'cancelledOrderIds' | 'carriedOrderIds'>): boolean {
  const gone = new Set([...(s.cancelledOrderIds ?? []), ...(s.carriedOrderIds ?? [])]);
  return !s.orderIds.length || s.orderIds.some((id) => !gone.has(id));
}

/**
 * The instructions of one load, one entry per customer in stop order, each with its stop numbers
 * ascending; stops nothing of which is loaded are left out. Empty = nothing to print (and the sheets
 * print exactly what they printed before the feature).
 */
export function loadInstructions(stops: readonly InstructionStop[]): LoadInstruction[] {
  const out = new Map<string, LoadInstruction>();
  for (const s of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    const text = loadingInstructionText(s.loadingInstruction);
    if (!text || !stopIsLoaded(s)) continue;
    const seen = out.get(s.customerId);
    if (seen) {
      if (!seen.stops.includes(s.sequence)) seen.stops.push(s.sequence);
      continue;
    }
    out.set(s.customerId, { stops: [s.sequence], customerId: s.customerId, customerName: s.customerName, customerCode: s.customerCode, branchCode: s.branchCode, text });
  }
  return [...out.values()];
}

/** "Stop 3" / "Stops 3, 5". */
export function stopsText(stops: readonly number[]): string {
  return `${stops.length === 1 ? 'Stop' : 'Stops'} ${stops.join(', ')}`;
}

/** "C100 / B2" (code and branch). */
export function customerRef(i: Pick<LoadInstruction, 'customerCode' | 'branchCode'>): string {
  return `${i.customerCode}${i.branchCode ? ` / ${i.branchCode}` : ''}`;
}

/** One line: "Stop 3 Hyper Example A (C100 / B2): Water at the bottom, max 5 layers". */
export function instructionLine(i: LoadInstruction): string {
  return `${stopsText(i.stops)} ${i.customerName} (${customerRef(i)}): ${i.text}`;
}

// ---------------------------------------------------------------------------------------
// The special-loading lines (owner request 20 Oct 2026, loading-split.ts): a load's products split into
// the normal lines and one block per instruction text, so the warehouse never subtracts those customers'
// cases from a product's total itself. The words of every sheet and of the plan screen.
// ---------------------------------------------------------------------------------------

/** The heading of the normal lines when a load has special-loading lines. */
export const NORMAL_LOADING_HEADING = 'NORMAL LOADING - every other customer';

/** The subtotal of the normal lines. */
export const NORMAL_LOADING_TOTAL = 'Normal loading total';

/** What a special-loading block says after its tag. */
export const SPECIAL_LINES_LEAD = 'load separately, as the SPECIAL LOADING box says';

/**
 * A block's heading: "SPECIAL: load separately, as the SPECIAL LOADING box says · Stops 1, 3", and the whole
 * text after it when the tag is shortened. Without stops (the day's SKU summary), no stop numbers.
 */
export function specialLinesHeading(tag: string, text: string, stops?: readonly number[]): string {
  return `${tag}: ${SPECIAL_LINES_LEAD}${stops?.length ? ` · ${stopsText(stops)}` : ''}${tag !== text ? ` - ${text}` : ''}`;
}

/** A block's subtotal: "SPECIAL total". */
export function specialLinesTotal(tag: string): string {
  return `${tag} total`;
}

/** The load's grand total under the blocks: the whole truck, as before the split. */
export const SPLIT_GRAND_TOTAL = 'Total on this truck (normal + special loading)';

/** The printed load sheet's line under "Products to load" when the load has special-loading lines. */
export const SPLIT_LEAD =
  "Load the normal lines as usual. Load each block below separately, as the SPECIAL LOADING box says: its lines are exactly those customers' cases - nothing to take off.";

/** Added to the cancelled and brought-forward banners of a load with special-loading lines. */
export const SPECIAL_LINES_NOTE = 'Their cases are in the normal lines, never in the special-loading lines.';

/**
 * A load whose stops' order lines do not add up to its products (never expected: both come from the same
 * plan rows): no special-loading lines are printed, and the sheet says so.
 */
export const SPLIT_MISMATCH_TEXT =
  'The special-loading lines could not be worked out (the invoices and the products differ): load those customers from their invoices and ask the dispatcher.';
