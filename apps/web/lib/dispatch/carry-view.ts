/**
 * PR9 "Bring forward": the words every screen and paper uses for an order carried from one day to
 * another. Pure and browser-safe (the day screen, the plan screen, the driver sheets and the Excel
 * workbook all read these), so the marks never drift apart.
 */
import type { CarryWhyKind } from './carry-over';
import { fmtDayMonth } from './time';

/** Badge of an order brought forward from an earlier day: "Carried over from 26 Sep" (the date it was first due). */
export function carriedFromBadge(firstDateIso: string): string {
  return `Carried over from ${fmtDayMonth(firstDateIso)}`;
}

/** Mark of an order of an earlier day brought forward since: "Carried over to 28 Sep". */
export function carriedToBadge(toDateIso: string): string {
  return `Carried over to ${fmtDayMonth(toDateIso)}`;
}

/** A listed order as the selection needs it; `ofToday`: an order of the company's today (the "Today" group). */
type Listed = { orderId: string; blocked: unknown; ofToday?: boolean };

/**
 * Ticked unless the dispatcher changed it: an order of an earlier day (that day is over) yes, an
 * order of today no - today's loads that have not left yet may still go out today (owner decision).
 */
export function carryTickedByDefault(c: Listed): boolean {
  return !c.blocked && !c.ofToday;
}

/** What the day screen offers by default: every order of an earlier day that can be brought forward, none of today. */
export function defaultCarrySelection(candidates: readonly Listed[]): Set<string> {
  return carrySelected(candidates, new Map());
}

/**
 * What the dispatcher ticked or unticked by hand on the day screen: order id -> ticked. Kept across
 * reloads of the list; reset only for another day or depot.
 */
export type CarryChoices = ReadonlyMap<string, boolean>;

/**
 * The orders ticked on the day screen: what the dispatcher chose by hand, else the default - every
 * order of an earlier day that can be brought forward, none of today (carryTickedByDefault). The
 * screen keeps the choices (not the ticked set), so a reload of the list - after a 409, a partial
 * bring forward, an OPTIMIZE or RE-PLAN of the day, a new file - never ticks again an order the
 * dispatcher unticked (for example one the customer cancelled), never unticks an order of today
 * the dispatcher ticked, and never ticks an order of today by itself; an order new to the list
 * gets its default. A blocked order is never selected.
 */
export function carrySelected(candidates: readonly Listed[], choices: CarryChoices): Set<string> {
  return new Set(candidates.filter((c) => !c.blocked && (choices.get(c.orderId) ?? carryTickedByDefault(c))).map((c) => c.orderId));
}

/** The dispatcher ticks or unticks one order: the new choices. */
export function toggleCarry(choices: CarryChoices, c: Listed): Map<string, boolean> {
  const n = new Map(choices);
  n.set(c.orderId, !(choices.get(c.orderId) ?? carryTickedByDefault(c)));
  return n;
}

/**
 * The POST body's selection: each selected order with the open cases the list showed (the expected
 * state). An order of today carries `today: true` - it was ticked in the "Today" group, on its own:
 * the server refuses an order of today sent without it (409 TODAY_NOT_SELECTED).
 */
export function carrySelectionPayload(candidates: readonly (Listed & { cases: number })[], selected: ReadonlySet<string>): { orderId: string; cases: number; today?: true }[] {
  return candidates
    .filter((c) => selected.has(c.orderId) && !c.blocked)
    .map((c) => (c.ofToday ? { orderId: c.orderId, cases: c.cases, today: true as const } : { orderId: c.orderId, cases: c.cases }));
}

/** The heading of the day screen's group of today's orders: "Today (27 Sep) - may still leave today". */
export function carryTodayTitle(todayIso: string): string {
  return `Today (${fmtDayMonth(todayIso)}) - may still leave today`;
}

/** The warning above today's orders (owner decision: unticked by default). */
export const CARRY_TODAY_WARNING = "Today's loads that have not left yet may still go out today; tick only orders you know will not be delivered today.";

/**
 * The "Why not delivered" label of a listed order on the day screen. Today's day is not over, so
 * its orders' loads have not left YET: "Load not left yet" / "Not planned", never "Load never left"
 * / "Never planned", which would contradict "may still leave today". An unserved order is labelled
 * with its reason on the screen (REASON_TEXT) when the plan gave one.
 */
export function carryWhyLabel(kind: CarryWhyKind, ofToday: boolean): string {
  switch (kind) {
    case 'NOT_LEFT':
      return ofToday ? 'Load not left yet' : 'Load never left';
    case 'NEVER_PLANNED':
      return ofToday ? 'Not planned' : 'Never planned';
    case 'UNSERVED':
      return 'Unserved';
  }
}

/**
 * The count after "Bring forward to 28 Sep" on the button: shown whenever the selection is not
 * "every order of the earlier days" - fewer, or any order of today ticked, which it names
 * (" (5 order(s), 320 cases, 2 of today)"); empty when exactly the earlier days' orders are ticked.
 * `preview.orders`: the orders of the earlier days that can be brought forward.
 */
export function carryButtonSuffix(chosen: readonly { cases: number; ofToday: boolean }[], preview: { orders: number }): string {
  const ofToday = chosen.filter((c) => c.ofToday).length;
  if (chosen.length === preview.orders && !ofToday) return '';
  const cases = chosen.reduce((a, c) => a + c.cases, 0);
  return ` (${chosen.length} order(s), ${cases.toLocaleString()} cases${ofToday ? `, ${ofToday} of today` : ''})`;
}

/**
 * The question before "Bring forward": how many orders and cases, and - when orders of today are
 * ticked - that they are closed on today (today's plan stays as it is, for the record: the load
 * keeps them) and that a load of today still holding one cannot go out today. `chosen` are the
 * listed orders (CarryCandidate, which says `ofToday`), never the POST body (which says `today`).
 */
export function carryConfirmText(chosen: readonly { cases: number; ofToday: boolean }[], dateIso: string, todayIso: string): string {
  const day = fmtDayMonth(dateIso);
  const cases = chosen.reduce((a, c) => a + c.cases, 0);
  const ofToday = chosen.filter((c) => c.ofToday);
  const todayCases = ofToday.reduce((a, c) => a + c.cases, 0);
  const todayNote = ofToday.length
    ? `\n\n${ofToday.length} of them (${todayCases.toLocaleString()} cases) are orders of TODAY (${fmtDayMonth(todayIso)}): they are closed on today (today's plan stays as it is, for the record), and a load of today that still holds one cannot be locked, loaded or dispatched today. Only continue if you know they will not be delivered today.`
    : '';
  return `Bring ${chosen.length} order(s) (${cases.toLocaleString()} cases) forward to ${day}?${todayNote}\n\nThey become orders of ${day} and are no longer open on their own days. The plans of those days stay as they are.`;
}

/**
 * The toast after "Bring forward": what was carried and what the dispatcher does next. While the
 * day's plan is being optimized (`optimizing`), that optimization was started without them: they
 * wait for it, and RE-PLAN adds them once it finished.
 */
export function carryDoneText(
  res: { orders: number; cases: number; skipped: unknown[]; replanNeeded: boolean; optimizing?: boolean; carried?: readonly { fromDate: string }[] },
  dateIso: string,
  todayIso?: string,
): string {
  const day = fmtDayMonth(dateIso);
  if (!res.orders) return res.skipped.length ? `Nothing new to bring forward: ${res.skipped.length} order(s) were already brought forward.` : 'Nothing was brought forward.';
  const next = res.optimizing
    ? 'They are not in the optimization running now: when it finishes, RE-PLAN to add them (locked, loading and dispatched loads stay exactly as they are).'
    : res.replanNeeded
      ? 'RE-PLAN to add them to the plan: locked, loading and dispatched loads stay exactly as they are.'
      : `OPTIMIZE plans them with the other orders of ${day}.`;
  const skipped = res.skipped.length ? ` ${res.skipped.length} order(s) were already brought forward.` : '';
  // Orders of today brought forward (in the evening): their loads of today no longer go out with them.
  const ofToday = todayIso ? (res.carried ?? []).filter((c) => c.fromDate === todayIso).length : 0;
  const today = ofToday
    ? ` ${ofToday} of them were orders of today (${fmtDayMonth(todayIso!)}): a load of today that still holds one cannot be locked, loaded or dispatched - re-plan today for its other orders, or unlock it (a loading one goes Back to locked first; unload a loaded one).`
    : '';
  return `${res.orders} order(s) (${res.cases.toLocaleString()} cases) brought forward to ${day}. ${next}${skipped}${today}`;
}

/** The carried-over line of a stop on the driver sheet and the Excel load sheet, or null. */
export function carriedStopText(s: { carriedFrom: string | null; carriedTo: string | null }): string | null {
  if (s.carriedTo) return `CARRIED OVER to ${fmtDayMonth(s.carriedTo)} - not delivered on this day`;
  if (s.carriedFrom) return `CARRIED OVER from ${fmtDayMonth(s.carriedFrom)} (not delivered that day)`;
  return null;
}

/**
 * A load that never left the depot (PLANNED, LOCKED or LOADING): the only kind of load that can
 * hold carried cases. What left (DISPATCHED, COMPLETED) was delivered - also the part of a split
 * order whose rest was carried - so such a load shows no "carried over" mark.
 */
export function carriedLoadShows(status: string): boolean {
  return status === 'PLANNED' || status === 'LOCKED' || status === 'LOADING';
}

/** "28 Sep" / "28 Sep, 29 Sep" / "the later day": the days orders were brought forward to. */
export function carriedToDays(toDates: readonly string[] | undefined): string {
  const days = [...new Set((toDates ?? []).filter(Boolean))].sort();
  return days.length ? days.map(fmtDayMonth).join(', ') : 'the later day';
}

/**
 * What to do with a load of an earlier day that still holds orders brought forward to a later day
 * (the end of the 409 ORDERS_CARRIED answer and the plan screen's badge). `onlyCarried`: the load
 * holds nothing else; `toDates`: the days they were brought forward to.
 * - A PLANNED load was never loaded: it needs nothing (it stays in the plan for the record), and a
 *   re-plan of its day has nothing to plan when nothing else is open, so the answer never sends
 *   the dispatcher to one.
 * - A LOCKED or LOADING load was loaded (in NMWC's flow the trucks are loaded the night before): its
 *   cases are on the truck, but they are planned on the later day now, where the warehouse would
 *   pick them again. So: unload them back to stock, or tell the warehouse, before the later day's
 *   load is picked, then put this load back to Planned. Never "never loaded" or "needs nothing".
 * - A load of TODAY (`ofDay.isToday`: orders of today brought forward to tomorrow in the evening,
 *   owner decision): the words say today - re-plan today (its other orders are planned without
 *   the brought-forward ones), or unlock the load (back to Planned) when it was loaded - so the
 *   dispatcher knows the load does not go out today with them. The way back to Planned is named
 *   with the plan screen's own buttons (load-state.ts, checkTransition): a LOCKED load has
 *   "Unlock"; a LOADING load has none - it goes "Back to locked" first, then "Unlock" - and Unlock
 *   is refused while a later load of the same truck is still locked or loading, so those go first.
 */
export function carriedLoadRemedy(status: string, onlyCarried: boolean, toDates?: readonly string[], ofDay?: { date: string; isToday: boolean }): string {
  const days = carriedToDays(toDates);
  const loaded = status === 'LOCKED' || status === 'LOADING';
  if (ofDay?.isToday) {
    const today = `today (${fmtDayMonth(ofDay.date)})`;
    const loading = status === 'LOADING';
    const laterFirst = ' A later locked or loading load of the same truck must be unlocked first.';
    if (onlyCarried) {
      const unlock = loading ? 'Put it Back to locked, then Unlock it (put it back to Planned),' : 'Unlock it (put it back to Planned)';
      return loaded
        ? `This load holds nothing else, but it was loaded: its cases were brought forward to ${days} and are planned there, so it does not go out today. ${unlock} and unload those cases back to stock, or tell the warehouse, before the loads of ${days} are picked, so they are not loaded twice.${laterFirst} It stays in today's plan for the record; nothing needs to be re-planned.`
        : `This load holds nothing else: it does not go out today. Leave it as it is (it stays in today's plan for the record); re-plan ${today} only if other orders of today still need a truck.`;
    }
    const unlock = loading ? 'put the load Back to locked, then Unlock it (put it back to Planned),' : 'unlock the load (put it back to Planned)';
    return loaded
      ? `Their cases were loaded: unload them (they are planned on ${days} now). To deliver its other orders today, ${unlock} and re-plan ${today}: the re-plan leaves the brought-forward orders out.${laterFirst}`
      : `Re-plan ${today} to plan its other orders without them.`;
  }
  if (onlyCarried) {
    if (loaded) {
      return `This load holds nothing else, but it was loaded: its cases were brought forward to ${days} and are planned there. Unload them back to stock, or tell the warehouse, before the loads of ${days} are picked, so they are not loaded twice; then put this load back to Planned. It stays in this plan for the record; nothing needs to be re-planned.`;
    }
    return 'This load holds nothing else: leave it as it is. It stays in this plan for the record and is never loaded or dispatched; nothing needs to be re-planned.';
  }
  return status === 'PLANNED'
    ? 'Re-plan this day to plan its other orders without them.'
    : `Their cases were loaded: unload them (they are planned on ${days} now). To deliver its other orders, put the load back to Planned and re-plan this day: the re-plan leaves the brought-forward orders out.`;
}

/**
 * Step 3 of the day screen when nothing is left to plan, or null when there is (the server answers
 * 409 NOTHING_TO_PLAN in the same cases, with the same meaning: nothingToPlan / nothingLeftCarried
 * in start-optimize.ts). `loadsOfDay`: the plan's loads by status leaving out loads that never left
 * and hold only orders brought forward to a later day (day-overview.ts); `loadsByStatus`: every
 * load. When orders of the day were brought forward (`carriedOut`) it says so: never "unlock it
 * first" for a load holding only brought-forward orders, and never "every load has left the depot"
 * while such a load is still at the depot.
 */
export function dayNothingLeftText(day: {
  orders: number;
  openOrders: number | undefined;
  pending: number;
  chosen: boolean;
  carriedOut: { orders: number; toDates: readonly string[] } | null | undefined;
  loadsByStatus: Readonly<Record<string, number>>;
  loadsOfDay?: Readonly<Record<string, number>>;
}): string | null {
  const carried = day.carriedOut?.orders ?? 0;
  const nothingOpen = day.orders > 0 ? day.openOrders === 0 && day.pending === 0 : carried > 0;
  if (!nothingOpen) return null;
  const ofDay = day.loadsOfDay ?? day.loadsByStatus;
  const lockedOrLoading = (m: Readonly<Record<string, number>>) => (m.LOCKED ?? 0) + (m.LOADING ?? 0);
  // A LOCKED or LOADING load holding an order still of this day can be unlocked to change it.
  const canUnlock = lockedOrLoading(ofDay) > 0;
  if (carried > 0) {
    const days = carriedToDays(day.carriedOut?.toDates);
    const others = day.orders > 0 ? ', and every other order of this day is on a locked, loading or dispatched load' : '';
    // LOCKED / LOADING loads holding only brought-forward orders: they were loaded, their cases are on the truck.
    const loaded = Math.max(0, lockedOrLoading(day.loadsByStatus) - lockedOrLoading(ofDay));
    return (
      `Nothing left to plan: ${carried} order(s) of this day were brought forward to ${days} and are planned there${others}. ` +
      'Loads and unserved lines that still show them stay in this plan for the record; nothing needs to be re-planned.' +
      (loaded
        ? ` ${loaded} locked or loading load(s) hold only brought-forward orders and were loaded: unload those cases back to stock, or tell the warehouse, before the loads of ${days} are picked; then put the load back to Planned.`
        : '') +
      (canUnlock ? ' To change a locked or loading load, unlock it first.' : '')
    );
  }
  const what = 'Every order of this day is already on a locked, loading or dispatched load: nothing left to plan.';
  if (canUnlock) return `${what}${day.chosen ? ' To change a load, unlock it first.' : ' This version has no optimized plan yet: unlock one load below, then OPTIMIZE.'}`;
  return `${what} Every load has left the depot; a late order for this day can still be planned.`;
}

/** A load of the plan screen holds only orders brought forward to a later day. */
export function holdsOnlyCarried(l: { carriedAway: number; stops: readonly { orderIds: readonly string[] }[] }): boolean {
  return l.carriedAway > 0 && l.carriedAway === new Set(l.stops.flatMap((s) => s.orderIds)).size;
}

/**
 * The title of the plan screen's "N order(s) carried over" badge on a load: why it cannot be
 * locked, loaded or dispatched, and what to do (carriedLoadRemedy) - the words of the server's
 * 409 ORDERS_CARRIED for the same load. A load of the company's today says today: `today` is the
 * day screen's when it gives one, else the plan's own (PlanDetail.today), so the standalone plan
 * version page says the same as the day screen and as the 409 on that page.
 */
export function carriedLoadTitle(
  l: { status: string; carriedAway: number; stops: readonly { orderIds: readonly string[]; carriedTo: string | null }[] },
  plan: { run: { runDate: string }; today?: string },
  today?: string,
): string {
  const companyToday = today ?? plan.today;
  const remedy = carriedLoadRemedy(
    l.status,
    holdsOnlyCarried(l),
    l.stops.flatMap((st) => (st.carriedTo ? [st.carriedTo] : [])),
    { date: plan.run.runDate, isToday: !!companyToday && plan.run.runDate === companyToday },
  );
  return `Orders on this load were brought forward to a later day (planned there now): it cannot be locked, loaded or dispatched with them. ${remedy}`;
}

/**
 * What a re-plan of this plan would still plan (the input of nothingToReplan): a PLANNED load
 * holding only orders brought forward, and an unserved row brought forward, are not work - the
 * re-plan leaves those orders out (ordersInScopeWhere), and the server answers NOTHING_TO_PLAN.
 */
export function replanWork(
  loads: readonly { status: string; carriedAway: number; stops: readonly { orderIds: readonly string[] }[] }[],
  unserved: readonly { carriedTo: string | null }[],
): { loadStatuses: string[]; unservedOrders: number } {
  return {
    loadStatuses: loads.filter((l) => !(l.status === 'PLANNED' && holdsOnlyCarried(l))).map((l) => l.status),
    unservedOrders: unserved.filter((u) => !u.carriedTo).length,
  };
}

/** A carried original and its copy in an order list: "Carried over to 28 Sep" / "Carried over from 27 Sep". */
export function orderCarryMarks(o: { carriedTo?: { deliveryDate: Date | string } | null; carriedFromDate?: Date | string | null }): { to: string | null; from: string | null } {
  const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return { to: o.carriedTo ? iso(o.carriedTo.deliveryDate) : null, from: o.carriedFromDate ? iso(o.carriedFromDate) : null };
}

/**
 * Totals of an order list without the carried originals (their cases are counted on the day they
 * went to, by their copy): `carried` = how many were left out.
 */
export function orderListTotals(rows: readonly { totalCases: number; totalWeightKg: number; carriedTo?: unknown }[]): { cases: number; kg: number; carried: number } {
  let cases = 0;
  let kg = 0;
  let carried = 0;
  for (const r of rows) {
    if (r.carriedTo) {
      carried++;
      continue;
    }
    cases += r.totalCases;
    kg += r.totalWeightKg;
  }
  return { cases, kg, carried };
}
