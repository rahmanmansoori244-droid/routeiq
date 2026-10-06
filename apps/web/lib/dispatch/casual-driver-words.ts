/**
 * What "+ Add daily driver..." says, before saving and after (casual-driver-dialog.tsx, plan-view.tsx).
 * Seventh review of the hire branch: on a truck rented for the day the quick add also puts the driver on
 * the truck's other loads still to plan and makes them its default driver (casual-driver.ts
 * wholeRentalDay), but the dialog said "put on this load" - the swap of the other loads' driver was told
 * only in a toast afterwards (never a silent swap) -, and the toast read "Load 2 and Load 1, Load 3".
 * Pure: the dialog runs in the browser.
 */

/** A load of the plan as the dialog reads it (PlanDetail's DetailLoad). */
export interface RentalDayLoad {
  id: string;
  truckId: string;
  loadNo: number;
  status: string;
  driverId: string | null;
  driverName: string | null;
  /** The dispatcher chose this driver by hand (DetailLoad.driverHandSet): the quick add keeps it. */
  driverHandSet: boolean;
}

export interface CasualDriverPlan {
  /** The load's truck is rented for this plan's day (a one-day hired truck of its date): the driver goes on its whole day. */
  wholeDay: boolean;
  /** Its other loads still to plan the driver also goes on (load numbers, ascending). */
  alsoOn: number[];
  /** Of those, the ones whose driver (RouteIQ's pick) the new one replaces. */
  replaces: { loadNo: number; driverName: string }[];
  /** Its other loads still to plan whose driver the dispatcher chose by hand: they keep it. */
  keeps: number[];
}

/**
 * What the quick add will do for `load` (the server's rule, casual-driver.ts wholeRentalDay): on a one-day
 * hired truck of the plan's date (`runDate`, YYYY-MM-DD), every other PLANNED load of that truck whose
 * driver the dispatcher did not choose by hand gets the driver too; on any other truck, this load only.
 */
export function casualDriverPlan(
  load: { id: string; truckId: string; hired?: boolean; oneDay?: string | null },
  loads: readonly RentalDayLoad[],
  runDate: string,
): CasualDriverPlan {
  const wholeDay = !!load.hired && !!load.oneDay && load.oneDay.slice(0, 10) === runDate.slice(0, 10);
  if (!wholeDay) return { wholeDay: false, alsoOn: [], replaces: [], keeps: [] };
  const others = loads.filter((o) => o.truckId === load.truckId && o.id !== load.id && o.status === 'PLANNED').sort((a, b) => a.loadNo - b.loadNo);
  const also = others.filter((o) => !o.driverHandSet);
  return {
    wholeDay,
    alsoOn: also.map((o) => o.loadNo),
    replaces: also.filter((o) => o.driverId !== null).map((o) => ({ loadNo: o.loadNo, driverName: o.driverName ?? 'another driver' })),
    keeps: others.filter((o) => o.driverHandSet).map((o) => o.loadNo),
  };
}

/** "Load 2", "Loads 1 and 2", "Loads 1, 2 and 3": in order, each once. */
export function loadsText(loadNos: readonly number[]): string {
  const nos = [...new Set(loadNos)].sort((a, b) => a - b);
  if (nos.length <= 1) return `Load ${nos[0] ?? ''}`.trim();
  return `Loads ${nos.slice(0, -1).join(', ')} and ${nos[nos.length - 1]}`;
}

/** The dialog's words before saving: its introduction and its button. */
export function casualDriverDialogText(load: { truckCode: string; loadNo: number }, plan: CasualDriverPlan): { intro: string; button: string } {
  const head = `${load.truckCode} L${load.loadNo}. A daily (casual) driver or the driver of a hired truck.`;
  if (!plan.wholeDay) {
    return {
      intro: `${head} Saved as a daily driver with no account, and put on this load. They open their trips with the driver link (QR).`,
      button: 'Add and put on this load',
    };
  }
  const also = plan.alsoOn.length ? `also goes on ${loadsText(plan.alsoOn)} (its other loads still to plan) and ` : '';
  const replaced = plan.replaces.length
    ? ` This replaces ${plan.replaces.map((r) => `${r.driverName} on Load ${r.loadNo}`).join(', ')}.`
    : '';
  const kept = plan.keeps.length ? ` ${loadsText(plan.keeps)} keep${plan.keeps.length === 1 ? 's' : ''} the driver you chose yourself.` : '';
  return {
    intro:
      `${head} Saved as a daily driver with no account; they open their trips with the driver link (QR). ` +
      `${load.truckCode} is rented for the whole day with one driver: the driver ${also}becomes its default driver.${replaced}${kept}`,
    button: plan.alsoOn.length ? `Add and put on ${loadsText([load.loadNo, ...plan.alsoOn])}` : 'Add and put on this load',
  };
}

/** The message after saving: "HIRE-10T-1110-1 Loads 1, 2 and 3: daily driver Salim". */
export function casualDriverToast(truckCode: string, loadNos: readonly number[], name: string, reused: boolean): string {
  return `${truckCode} ${loadsText(loadNos)}: daily driver ${name}${reused ? ' (already saved)' : ''}`;
}
