/**
 * Operations alerts (owner request 16 Oct 2026): the rules (lib/alerts/rules.ts) on synthetic facts, with
 * the adversarial review's fixes. Each rule fires at T + 1 and not at T, its tiers start at WARN, it
 * answers for every subject it checks (Candidate or Ended with its own words), and the review's cases:
 * the 21:00 Loading press (H1: loading off by default), one missing driver page raising one WARN instead
 * of a pile (H3), the projected window check only for the next stop with a window plus 10 min hysteresis
 * (H5), bad pins (M1), the Dispatch button (M2), a late Dispatch press (M3), bad arrival taps (M9), long
 * legs and the planned break (M10), office results (L8), the window rule of old loads (L2). Every text
 * starts with the truck as shown and has no run of 6 digits. Asia/Muscat (UTC+4); invented names.
 */
import { describe, expect, it } from 'vitest';
import { ALERT_RULES, subjectKeyOf, thresholdsOf, type AlertConfig, type AlertRule } from '@/lib/alerts/catalog';
import { evaluate, openKey, type AlertFacts, type FactLoad, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo } from '@/lib/alerts/rules';
import { addDaysIso, parseHhmm, zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-10-20';
const YESTERDAY = addDaysIso(D, -1);
const TOMORROW = addDaysIso(D, 1);
/** A local time of the delivery day `date` ("HH:MM", or minutes). */
const at = (t: string | number, date = D) => new Date(zonedDayStart(date, TZ).getTime() + (typeof t === 'number' ? t : parseHhmm(t)!) * 60_000);

const ON: Partial<AlertConfig> = {
  alertsEnabled: true,
  alertUnloadOverMin: 30,
  alertLoadingOverMin: 40,
  alertEtaLateMin: 30,
  alertDepartLateMin: 30,
  alertSilentMin: 120,
  alertPageNotOpenedMin: 30,
  alertAfterClosingMin: 15,
  alertPriorityMax: 2,
  alertDeliveredNote: true,
  alertProofFarM: 500,
  alertNotClosedMin: 120,
};
const ALL = thresholdsOf(ON);
/** The catalog's defaults: loading (R2) off. */
const DEFAULTS = thresholdsOf({ ...ON, alertLoadingOverMin: null });

function visit(over: Partial<FactVisit> = {}): FactVisit {
  return {
    arrivedAt: null,
    arrivalSource: 'PHONE_MANUAL',
    arrivalObserved: true,
    arrivalDistanceM: 20,
    arrivalAccuracyM: 10,
    timingSuspect: false,
    departedAt: null,
    departedAtOutcome: false,
    autoMinutes: null,
    autoServiceMinutes: null,
    outcome: null,
    reason: null,
    reasonNote: null,
    outcomeAt: null,
    outcomeSource: null,
    outcomeDistanceM: null,
    outcomeAccuracyM: null,
    casesPlanned: 10,
    casesDelivered: null,
    plannedServiceMin: null,
    windowStartMin: null,
    windowEndMin: null,
    photos: [],
    ...over,
  };
}

const NAMES = ['Hyper Example A', 'Shop Example B', 'Shop Example C', 'Shop Example D'];
function stop(sequence: number, eta: number, over: Partial<FactStop> = {}): FactStop {
  return {
    sequence,
    customerId: `cust-${sequence}`,
    customerCode: `C${sequence}00`,
    branchCode: null,
    customerName: NAMES[(sequence - 1) % NAMES.length]!,
    etaMin: eta,
    serviceStartMin: eta,
    departureMin: eta + 20,
    plannedServiceMin: 20,
    windowStartMin: null,
    windowEndMin: null,
    priority: 3,
    pinVerified: true,
    visit: null,
    ...over,
  };
}

/** T05 L1 of depot D1 today: depart 07:30, stops at 08:00, 09:00, 10:00, back 12:00; dispatched 07:30. */
function load(over: Partial<FactLoad> = {}): FactLoad {
  const stops = over.stops ?? [stop(1, 480), stop(2, 540), stop(3, 600)];
  return {
    id: 'load-1',
    depotId: 'D1',
    date: D,
    truckId: 'TR1',
    truckCode: 'T05',
    loadNo: 1,
    status: 'DISPATCHED',
    departMin: 450,
    returnMin: 720,
    statusChangedAt: at('07:30', over.date ?? D),
    loadedAt: null,
    windowRule: 'FINISH',
    breakMin: null,
    backAt: null,
    stopCount: stops.length,
    ...over,
    stops,
  };
}

interface FactsOpts {
  truckDays?: FactTruckDay[];
  /** [rule, subjectKey, kind?] rows open now. */
  open?: [AlertRule, string, ('CONDITION' | 'EVENT')?][];
  today?: string;
}

function facts(loads: FactLoad[], o: FactsOpts = {}): AlertFacts {
  const today = o.today ?? D;
  const truckDays =
    o.truckDays ??
    [...new Set(loads.map((l) => `${l.date}|${l.truckId}`))].map((k) => {
      const [date, truckId] = k.split('|') as [string, string];
      return { date, truckId, linkSeenAt: at('07:35', date), pageOpened: true, lastSignal: null };
    });
  const open = new Map<string, OpenRowInfo>();
  for (const [rule, key, kind] of o.open ?? []) {
    const [depotId, date] = key.split('|') as [string, string];
    open.set(openKey(rule, key), { kind: kind ?? 'CONDITION', tier: 1, depotId, deliveryDate: date });
  }
  return { tz: TZ, today, dates: [addDaysIso(today, -1), today, addDaysIso(today, 1)], loads, truckDays, open };
}

const loadKey = (l: Pick<FactLoad, 'depotId' | 'date' | 'truckId' | 'loadNo'> = { depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1 }) => subjectKeyOf({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo });
const stopKey = (seq: number, l: Pick<FactLoad, 'depotId' | 'date' | 'truckId' | 'loadNo'> = { depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1 }) => subjectKeyOf({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: seq });

function run(f: AlertFacts, now: Date, thresholds = ALL) {
  const ev = evaluate(f, now, thresholds);
  return {
    ev,
    active: (rule: AlertRule) => ev.active.filter((c) => c.rule === rule),
    one: (rule: AlertRule, key?: string) => {
      const list = ev.active.filter((c) => c.rule === rule && (!key || c.subjectKey === key));
      expect(list, `${rule} raised once`).toHaveLength(1);
      return list[0]!;
    },
    none: (rule: AlertRule, key?: string) => expect(ev.active.filter((c) => c.rule === rule && (!key || c.subjectKey === key))).toEqual([]),
    ended: (rule: AlertRule, key: string) => ev.ended.find((e) => e.rule === rule && e.subjectKey === key) ?? null,
  };
}

/** A truck-day whose driver page was never opened. */
const noPage = (date = D, truckId = 'TR1'): FactTruckDay => ({ date, truckId, linkSeenAt: null, pageOpened: false, lastSignal: null });

describe('every rule off while the master switch is off', () => {
  it('no candidate, nothing ended, scopes without rules', () => {
    const f = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00') }) })] })]);
    const ev = evaluate(f, at('12:00'), thresholdsOf({ ...ON, alertsEnabled: false }));
    expect(ev.active).toEqual([]);
    expect(ev.ended).toEqual([]);
    expect(ev.scopes).toEqual([{ depotId: 'D1', deliveryDate: D, rulesOn: [] }]);
  });
});

describe('R1 UNLOAD_OVER (owner rule 1: unloading more than planned by 30 min)', () => {
  const arrived = (over: Partial<FactVisit> = {}, stopOver: Partial<FactStop> = {}) => facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), ...over }), ...stopOver }), stop(2, 540), stop(3, 600)] })]);

  it('fires at planned + 31 min, not at + 30; tier 1 WARN, tier 2 HIGH beyond 2T, tier 3 beyond 3T', () => {
    run(arrived(), at('08:50')).none('UNLOAD_OVER');
    const c = run(arrived(), at('08:51')).one('UNLOAD_OVER', stopKey(1));
    expect(c).toMatchObject({ kind: 'CONDITION', tier: 1, value: 31, threshold: 30, sequence: 1, customerId: 'cust-1' });
    expect(c.text).toBe('T05 L1 stop 1 Hyper Example A (C100): no result or departure tapped since arrival 08:00 - 51 min at the stop, planned 20 min (31 min over).');
    expect(run(arrived(), at('09:21')).one('UNLOAD_OVER').tier).toBe(2);
    expect(run(arrived(), at('09:51')).one('UNLOAD_OVER').tier).toBe(3);
    // No backlog: the condition began when the limit was crossed.
    expect(c.occurredAt).toEqual(at('08:50'));
  });

  it('an early arrival is counted from the window start', () => {
    const f = arrived({}, { windowStartMin: 510 });
    run(f, at('09:20')).none('UNLOAD_OVER');
    expect(run(f, at('09:21')).one('UNLOAD_OVER').text).toContain('counted from the window start 08:30');
  });

  it('an arrival whose time is not certain still counts (the time is an upper bound) and says so', () => {
    expect(run(arrived({ arrivalSource: 'PHONE_AUTO', arrivalObserved: false }), at('09:00')).one('UNLOAD_OVER').text).toContain('(arrival time not certain)');
  });

  it('M9: an arrival tapped 1.5 km from the pin with good accuracy is not unloading; with poor accuracy it counts', () => {
    const r = run(arrived({ arrivalDistanceM: 1500, arrivalAccuracyM: 20 }), at('10:00'));
    r.none('UNLOAD_OVER');
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toContain('1.5 km from the customer');
    run(arrived({ arrivalDistanceM: 1500, arrivalAccuracyM: 300 }), at('10:00')).one('UNLOAD_OVER');
  });

  it('H3: not followed on a truck-day whose driver page was not opened', () => {
    const f = arrived();
    f.truckDays = [noPage()];
    const r = run(f, at('10:00'));
    r.none('UNLOAD_OVER');
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toContain('driver page was not opened');
  });

  it('ends without a departure tap when the truck moved on to the next stop', () => {
    const f = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00') }) }), stop(2, 540, { visit: visit({ arrivedAt: at('09:30') }) }), stop(3, 600)] })]);
    const r = run(f, at('10:00'));
    r.none('UNLOAD_OVER', stopKey(1));
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toBe('T05 L1 stop 1 Hyper Example A (C100): no departure or result was tapped; the truck moved on to stop 2 at 09:30.');
  });

  it('a stop that ended: the final words; over the limit with no row yet, a history row (no toast, no e-mail)', () => {
    const f = arrived({ departedAt: at('09:10') });
    const r = run(f, at('09:12'));
    const h = r.one('UNLOAD_OVER');
    expect(h).toMatchObject({ history: true, tier: 1, value: 50 });
    expect(h.text).toBe('T05 L1 stop 1 Hyper Example A (C100): unloading took 1 h 10 min, planned 20 min (50 min over).');
    // With the row open (seen live), the row closes with the same words.
    const open = arrived({ departedAt: at('09:10') });
    const r2 = run(facts(open.loads, { open: [['UNLOAD_OVER', stopKey(1)]] }), at('09:12'));
    r2.none('UNLOAD_OVER');
    expect(r2.ended('UNLOAD_OVER', stopKey(1))).toMatchObject({ reason: 'ENDED', text: h.text });
  });

  it('a result the office recorded later is not the end of the unloading: the row closes saying so', () => {
    const r = run(arrived({ outcome: 'DELIVERED', outcomeSource: 'DISPATCHER', outcomeAt: at('11:00') }), at('11:05'));
    r.none('UNLOAD_OVER');
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toContain('recorded by the office');
  });

  // The 15 Oct 2026 replay (integration of the operations alerts): two kinds of false alarm of R1.
  it('a load the office completed is not being unloaded: no row, the open one closes', () => {
    const done = facts([load({ status: 'COMPLETED', stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00') }) }), stop(2, 540), stop(3, 600)] })]);
    const r = run(done, at('10:00'));
    r.none('UNLOAD_OVER');
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toBe('T05 L1 stop 1 Hyper Example A (C100): no result or departure tapped; the load was completed.');
  });

  it('a result tapped hours later is not the end of the unloading when the truck reached a later stop before it', () => {
    // Arrived 08:00, planned 20 min; the next stop's arrival 08:45; this stop's result only at 10:40.
    const f = facts([
      load({
        stops: [
          stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), departedAt: at('10:40'), departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: at('10:40'), outcomeSource: 'PHONE_MANUAL' }) }),
          stop(2, 540, { visit: visit({ arrivedAt: at('08:45') }) }),
          stop(3, 600),
        ],
      }),
    ]);
    const r = run(f, at('10:45'));
    r.none('UNLOAD_OVER', stopKey(1));
    expect(r.ended('UNLOAD_OVER', stopKey(1))?.text).toBe('T05 L1 stop 1 Hyper Example A (C100): unloading took 45 min (until the truck reached a later stop at 08:45), planned 20 min (25 min over).');
    // Reached the later stop only at 09:10: 70 min, 50 over - a history row with the capped time.
    const late = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), departedAt: at('10:40'), departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: at('10:40'), outcomeSource: 'PHONE_MANUAL' }) }), stop(2, 540, { visit: visit({ arrivedAt: at('09:10') }) }), stop(3, 600)] })]);
    expect(run(late, at('10:45')).one('UNLOAD_OVER', stopKey(1))).toMatchObject({ history: true, value: 50 });
    // A later stop's tap before this arrival (stops done out of order) does not shorten it.
    const order = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), departedAt: at('09:10') }) }), stop(2, 540, { visit: visit({ arrivedAt: at('07:40'), departedAt: at('07:55') }) }), stop(3, 600)] })]);
    expect(run(order, at('09:15')).one('UNLOAD_OVER', stopKey(1))).toMatchObject({ history: true, value: 50 });
  });
});

describe('R2 LOADING_OVER (owner rule 2: loading more than 40 min; H1: off by default)', () => {
  // Tomorrow's load: Loading pressed at 21:10 today.
  const loading = (over: Partial<FactLoad> = {}) =>
    facts([load({ date: TOMORROW, status: 'LOADING', statusChangedAt: at('21:10'), stops: [], stopCount: 4, ...over })]);
  const key = loadKey({ depotId: 'D1', date: TOMORROW, truckId: 'TR1', loadNo: 1 });

  it('off by default: the 21:00 Loading press of every load raises nothing at all', () => {
    const r = run(loading(), at('23:30'), DEFAULTS);
    r.none('LOADING_OVER');
    expect(r.ended('LOADING_OVER', key)).toBeNull();
    expect(r.ev.scopes[0]!.rulesOn).not.toContain('LOADING_OVER');
  });

  it('on: fires 41 min after Loading, not at 40; tiers at 2T and 3T', () => {
    run(loading(), at('21:50')).none('LOADING_OVER');
    const c = run(loading(), at('21:51')).one('LOADING_OVER', key);
    expect(c).toMatchObject({ tier: 1, value: 41, threshold: 40, loadNo: 1, sequence: null });
    expect(c.text).toBe('T05 L1: loading for 41 min (since 21:10), limit 40 min. Planned departure 21 Oct 07:30.');
    expect(run(loading(), at('22:31')).one('LOADING_OVER').tier).toBe(2);
    expect(run(loading(), at('23:11')).one('LOADING_OVER').tier).toBe(3);
  });

  it('the Loaded press ends it with the loading time; Dispatch ends it; back to Locked ends it', () => {
    expect(run(loading({ loadedAt: at('21:45') }), at('22:00')).ended('LOADING_OVER', key)?.text).toBe('T05 L1: loaded in 35 min (21:10-21:45).');
    expect(run(loading({ status: 'DISPATCHED', statusChangedAt: at('22:02') }), at('22:05')).ended('LOADING_OVER', key)?.text).toBe('T05 L1: loading ended with Dispatch at 22:02.');
    expect(run(loading({ status: 'LOCKED' }), at('22:05')).ended('LOADING_OVER', key)?.text).toBe('T05 L1: loading stopped, the load is Locked.');
  });

  it('a Loading press more than 12 h ago is no longer followed', () => {
    const r = run(loading(), at('09:11', TOMORROW));
    r.none('LOADING_OVER');
    expect(r.ended('LOADING_OVER', key)?.text).toContain('no longer followed');
  });
});

describe('R3 ETA_LATE (owner rule 3: the ETA more than 30 min late)', () => {
  const late = (o: FactsOpts = {}, over: Partial<FactLoad> = {}) => facts([load(over)], o);

  it('fires when the next stop is 31 min late, not 30; the text names the next stop and the return', () => {
    run(late(), at('08:30')).none('ETA_LATE');
    const c = run(late(), at('08:31')).one('ETA_LATE', loadKey());
    expect(c).toMatchObject({ tier: 1, value: 31, threshold: 30 });
    expect(c.text).toBe('T05 L1 is running about 31 min late: next stop 1 Hyper Example A (C100) not reached yet (planned 08:00); 3 stops left, back about 12:31 (planned 12:00).');
    // The delay crossed T at the stop's ETA + T.
    expect(c.occurredAt).toEqual(at('08:30'));
    expect(run(late(), at('09:01')).one('ETA_LATE').tier).toBe(2);
  });

  it('a stop that ended late moves the next stop: "expected about"', () => {
    const f = late({}, { stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), departedAt: at('08:55') }) }), stop(2, 540), stop(3, 600)] });
    const c = run(f, at('09:00')).one('ETA_LATE');
    expect(c.value).toBe(35);
    expect(c.text).toContain('next stop 2 Shop Example B (C200) expected about 09:35 (planned 09:00)');
  });

  it('hysteresis: an open row stays (tier 1) until the delay is back under T - 10 min', () => {
    const open: FactsOpts = { open: [['ETA_LATE', loadKey()]] };
    expect(run(late(open), at('08:25')).one('ETA_LATE')).toMatchObject({ tier: 1, value: 25 });
    const r = run(late(open), at('08:19'));
    r.none('ETA_LATE');
    expect(r.ended('ETA_LATE', loadKey())?.text).toContain('back on time');
    // Without a row, 25 min late raises nothing.
    run(late(), at('08:25')).none('ETA_LATE');
  });

  it('M3: a Dispatch press 50 min late before any tap projects from the planned departure', () => {
    // Pressed 08:20; stop 1 at 08:00 not reached at 08:25: 25 min late, not 50 + 25.
    const c = run(late({}, { statusChangedAt: at('08:20') }), at('08:31')).one('ETA_LATE');
    expect(c.value).toBe(31);
  });

  it('H3: held while the driver is silent, not followed without the driver page, over after the planned return + 60', () => {
    // Silent: nothing from the phone since the 07:30 Dispatch; at 10:00 stop 1 (08:00) is 2 h late.
    const silent = run(late({ open: [['ETA_LATE', loadKey()]] }), at('10:00'));
    silent.one('DRIVER_SILENT');
    silent.none('ETA_LATE');
    expect(silent.ev.held).toContainEqual({ rule: 'ETA_LATE', subjectKey: loadKey() });
    expect(run(late(), at('10:00')).ended('ETA_LATE', loadKey())?.text).toContain('driver is silent');

    const page = run(late({ truckDays: [noPage()] }), at('09:00'));
    page.none('ETA_LATE');
    page.one('PAGE_NOT_OPENED');

    const signal: FactTruckDay = { date: D, truckId: 'TR1', linkSeenAt: at('13:00'), pageOpened: true, lastSignal: { at: at('12:59'), kind: 'ARRIVED', depotId: 'D1', loadNo: 1, sequence: 3 } };
    const past = run(late({ truckDays: [signal] }), at('13:01'));
    past.none('ETA_LATE');
    expect(past.ended('ETA_LATE', loadKey())?.text).toContain('past the planned return');
  });

  it('H5: the stops left that may miss their window are named in it (the one AFTER_CLOSING follows excluded)', () => {
    const f = late({}, { stops: [stop(1, 480), stop(2, 540, { windowEndMin: 570 }), stop(3, 600, { windowEndMin: 610 })] });
    const c = run(f, at('09:00')).one('ETA_LATE');
    expect(c.text).toContain('Stop 3 may miss its delivery window.');
    const withoutR6 = run(f, at('09:00'), thresholdsOf({ ...ON, alertAfterClosingMin: null })).one('ETA_LATE');
    expect(withoutR6.text).toContain('Stops 2 and 3 may miss their delivery window.');
  });

  it('back at the depot, completed, or every stop reached: the row closes', () => {
    expect(run(late({}, { backAt: at('11:50') }), at('12:00')).ended('ETA_LATE', loadKey())?.text).toBe('T05 L1: back at the depot at 11:50.');
    expect(run(late({}, { status: 'COMPLETED' }), at('12:00')).ended('ETA_LATE', loadKey())?.text).toBe('T05 L1: Completed.');
  });
});

describe('R4 DEPART_LATE (M2: today only, the first load of a truck not yet out, expires after 4 h)', () => {
  it('a Locked load not dispatched 31 min after its planned departure, not 30', () => {
    const f = facts([load({ status: 'LOCKED', statusChangedAt: at('05:00') })]);
    run(f, at('08:00')).none('DEPART_LATE');
    const c = run(f, at('08:01')).one('DEPART_LATE', loadKey());
    expect(c).toMatchObject({ tier: 1, value: 31 });
    expect(c.text).toBe('T05 L1 not dispatched: planned departure 07:30, now 08:01 (31 min late), load is Locked. Driver page last open 07:35. Dispatch it if it has left.');
    expect(c.occurredAt).toEqual(at('08:00'));
  });

  it('a Planned load counts only as a later trip of a truck whose earlier load is locked or further', () => {
    const trip1Back = load({ id: 'l1', status: 'DISPATCHED', backAt: at('10:00'), departMin: 450, returnMin: 600 });
    const trip2 = load({ id: 'l2', loadNo: 2, status: 'PLANNED', departMin: 630, returnMin: 800, statusChangedAt: null });
    const key2 = loadKey({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 2 });
    run(facts([trip1Back, trip2]), at('11:01')).one('DEPART_LATE', key2);
    // A spare planned trip 1 never fires.
    const spare = run(facts([load({ status: 'PLANNED', statusChangedAt: null })]), at('09:00'));
    spare.none('DEPART_LATE');
    expect(spare.ended('DEPART_LATE', loadKey())?.text).toContain('Planned (not locked)');
  });

  it('trip 2 is not late while trip 1 is still out (R3 on trip 1 explains it), nor while trip 1 is not out', () => {
    const key2 = loadKey({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 2 });
    const trip2 = load({ id: 'l2', loadNo: 2, status: 'LOCKED', departMin: 630, returnMin: 800 });
    const out = run(facts([load({ id: 'l1' }), trip2]), at('11:01'));
    out.none('DEPART_LATE', key2);
    expect(out.ended('DEPART_LATE', key2)?.text).toContain('Load 1 of this truck is still out');
    const notOut = run(facts([load({ id: 'l1', status: 'LOCKED' }), trip2]), at('11:01'));
    expect(notOut.ended('DEPART_LATE', key2)?.text).toContain('Load 1 of this truck is not dispatched yet');
  });

  it('expires 4 h after the planned departure; a load of yesterday never fires', () => {
    const f = facts([load({ status: 'LOADING' })]);
    expect(run(f, at('11:30')).one('DEPART_LATE').tier).toBe(3);
    const r = run(f, at('11:31'));
    r.none('DEPART_LATE');
    expect(r.ended('DEPART_LATE', loadKey())?.text).toContain('no longer followed');
    const y = load({ date: YESTERDAY, status: 'LOCKED' });
    run(facts([y]), at('08:01')).none('DEPART_LATE');
  });

  it('found only after the Dispatch press: one history row; with a row open, the row closes with the press time', () => {
    const f = facts([load({ statusChangedAt: at('08:12') })]);
    const h = run(f, at('08:14')).one('DEPART_LATE');
    expect(h).toMatchObject({ history: true, value: 42 });
    expect(h.text).toBe('T05 L1 dispatched 08:12, 42 min after the planned 07:30.');
    const open = run(facts(f.loads, { open: [['DEPART_LATE', loadKey()]] }), at('08:14'));
    open.none('DEPART_LATE');
    expect(open.ended('DEPART_LATE', loadKey())?.text).toBe(h.text);
  });
});

describe('R5 DRIVER_SILENT (M10: WARN first, the next stop overdue, the planned break not counted)', () => {
  it('nothing from the phone for 121 min while stop 1 is overdue: tier 1 WARN; 120: nothing; tier 2 beyond 2T', () => {
    const f = facts([load()]);
    run(f, at('09:30')).none('DRIVER_SILENT');
    const c = run(f, at('09:31')).one('DRIVER_SILENT', loadKey());
    expect(c).toMatchObject({ tier: 1, value: 121, threshold: 120 });
    expect(c.text).toBe("T05 L1: nothing from the driver's phone for 2 h 01 min (nothing since Dispatch at 07:30). Driver page last open 07:35. 3 stops left; stop 1 Hyper Example A (C100) was expected about 08:00.");
    expect(run(f, at('11:31')).one('DRIVER_SILENT').tier).toBe(2);
  });

  it('counts from the last thing the phone sent, and names it', () => {
    const td: FactTruckDay = { date: D, truckId: 'TR1', linkSeenAt: at('09:45'), pageOpened: true, lastSignal: { at: at('08:40'), kind: 'DEPARTED', depotId: 'D1', loadNo: 1, sequence: 1 } };
    const f = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), departedAt: at('08:40') }) }), stop(2, 540), stop(3, 600)] })], { truckDays: [td] });
    run(f, at('10:40')).none('DRIVER_SILENT');
    expect(run(f, at('10:41')).one('DRIVER_SILENT').text).toContain('(last: left stop 1 Hyper Example A (C100) at 08:40). Driver page last open 09:45.');
  });

  it('a planned break inside the silent gap is not counted', () => {
    const f = facts([load({ breakMin: { startMin: 510, endMin: 570 } })]);
    run(f, at('09:31')).none('DRIVER_SILENT');
    const c = run(f, at('10:31')).one('DRIVER_SILENT');
    expect(c.value).toBe(121);
    expect(c.text).toContain('the planned break of 1 h not counted');
  });

  it('a long planned leg is not silence: nothing until the next stop is 30 min overdue', () => {
    const f = facts([load({ stops: [stop(1, 600), stop(2, 660)] })]);
    run(f, at('10:30')).none('DRIVER_SILENT');
    run(f, at('10:31')).one('DRIVER_SILENT');
  });

  it('a stop being unloaded is the unloading rule\'s case, not silence', () => {
    const f = facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00') }) }), stop(2, 540)] })]);
    const r = run(f, at('11:00'));
    r.none('DRIVER_SILENT');
    expect(r.ended('DRIVER_SILENT', loadKey())?.text).toContain('unloading at stop 1');
    r.one('UNLOAD_OVER');
  });
});

describe('R6 AFTER_CLOSING (H5: an actual arrival is an event; only the next stop with a window is projected)', () => {
  it('an observed arrival 16 min after the window end: an EVENT, tier 2 HIGH; 15: nothing; not certain: nothing', () => {
    const f = (arrive: string, over: Partial<FactVisit> = {}) => facts([load({ stops: [stop(1, 480, { windowEndMin: 600, visit: visit({ arrivedAt: at(arrive), ...over }) })] })]);
    run(f('10:15'), at('10:20')).none('AFTER_CLOSING');
    const c = run(f('10:16'), at('10:20')).one('AFTER_CLOSING', stopKey(1));
    expect(c).toMatchObject({ kind: 'EVENT', tier: 2, value: 16 });
    expect(c.text).toBe('T05 L1 stop 1 Hyper Example A (C100): arrived 10:16, after its delivery window ended at 10:00 (16 min late).');
    expect(c.occurredAt).toEqual(at('10:16'));
    run(f('10:30', { arrivalSource: 'PHONE_AUTO', arrivalObserved: false }), at('10:40')).none('AFTER_CLOSING');
    run(f('10:30', { timingSuspect: true }), at('10:40')).none('AFTER_CLOSING');
  });

  it('projected: only the next pending stop with a window (START: the arrival; FINISH: the end of unloading)', () => {
    const stops = [stop(1, 480), stop(2, 540, { windowEndMin: 560 }), stop(3, 600, { windowEndMin: 600 })];
    // 08:40, nothing reached: stop 1 at 08:40 (clock), stop 2 expected 09:40 (arrival), unloading to 10:00.
    const start = run(facts([load({ windowRule: 'START', stops })]), at('08:40'));
    const c = start.one('AFTER_CLOSING', stopKey(2));
    expect(c).toMatchObject({ kind: 'CONDITION', tier: 1, value: 20 });
    expect(c.text).toBe('T05 L1 stop 2 Shop Example B (C200): expected about 09:40, after its delivery window ends at 09:20 (the latest arrival).');
    start.none('AFTER_CLOSING', stopKey(3));
    expect(start.ended('AFTER_CLOSING', stopKey(3))?.text).toContain('another stop comes first');
    const finish = run(facts([load({ windowRule: 'FINISH', stops })]), at('08:40')).one('AFTER_CLOSING', stopKey(2));
    expect(finish.value).toBe(40);
    expect(finish.text).toContain('unloading expected to finish about 10:00');
  });

  it('projected hysteresis: an open row stays until 10 min under the margin', () => {
    const stops = [stop(1, 480), stop(2, 540, { windowEndMin: 570 })];
    // 08:40: stop 2 expected 09:40 (START), 10 min after 09:30: under the 15 min margin, above 15 - 10.
    run(facts([load({ windowRule: 'START', stops })]), at('08:40')).none('AFTER_CLOSING');
    const open = facts([load({ windowRule: 'START', stops })], { open: [['AFTER_CLOSING', stopKey(2)]] });
    expect(run(open, at('08:40')).one('AFTER_CLOSING')).toMatchObject({ tier: 1, value: 10 });
    // 5 min after (stop 2 planned 5 min later): the open row closes.
    const closer = facts([load({ windowRule: 'START', stops: [stop(1, 480), stop(2, 540, { windowEndMin: 575 })] })], { open: [['AFTER_CLOSING', stopKey(2)]] });
    expect(run(closer, at('08:40')).ended('AFTER_CLOSING', stopKey(2))?.text).toContain('inside its delivery window');
  });

  it('L2: a load planned before the rule was echoed is judged by the arrival (START)', () => {
    // facts.ts gives such a load windowRule START; with START the 20 min of unloading do not count.
    const stops = [stop(1, 480), stop(2, 540, { windowEndMin: 570 })];
    run(facts([load({ windowRule: 'START', stops })]), at('08:30')).none('AFTER_CLOSING');
    run(facts([load({ windowRule: 'FINISH', stops })]), at('08:30')).one('AFTER_CLOSING');
  });
});

describe('R7 PRIORITY_NOT_DELIVERED, R8 DELIVERED_WITH_NOTE (events)', () => {
  const result = (over: Partial<FactVisit>, stopOver: Partial<FactStop> = {}) =>
    facts([load({ stops: [stop(1, 480, { priority: 1, visit: visit({ arrivedAt: at('08:00'), outcomeAt: at('11:20'), outcomeSource: 'PHONE_MANUAL', ...over }), ...stopOver })] })]);

  it('the driver\'s Not delivered at a priority 1 stop: HIGH; Partly: WARN; priority 3: nothing; the office\'s own result: nothing (L8)', () => {
    const c = run(result({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', reasonNote: 'gate closed, call 8123 4567' }), at('11:25')).one('PRIORITY_NOT_DELIVERED');
    expect(c).toMatchObject({ kind: 'EVENT', tier: 2, value: 1, threshold: 2 });
    expect(c.text).toBe('T05 L1 stop 1 Hyper Example A (C100), priority 1: NOT DELIVERED - Shop closed (driver, 11:20). Note: "gate closed, call [number]"');
    const p = run(result({ outcome: 'PARTLY_DELIVERED', reason: 'NOT_ON_TRUCK', casesDelivered: 7 }), at('11:25')).one('PRIORITY_NOT_DELIVERED');
    expect(p.tier).toBe(1);
    expect(p.text).toContain('PARTLY DELIVERED (7 of 10 cases)');
    run(result({ outcome: 'NOT_DELIVERED' }, { priority: 3 }), at('11:25')).none('PRIORITY_NOT_DELIVERED');
    run(result({ outcome: 'NOT_DELIVERED', outcomeSource: 'DISPATCHER' }), at('11:25')).none('PRIORITY_NOT_DELIVERED');
  });

  it('corrected to Delivered: the open event row closes as CORRECTED', () => {
    const f = result({ outcome: 'DELIVERED' });
    const r = run(facts(f.loads, { open: [['PRIORITY_NOT_DELIVERED', stopKey(1), 'EVENT']] }), at('11:40'));
    r.none('PRIORITY_NOT_DELIVERED');
    expect(r.ended('PRIORITY_NOT_DELIVERED', stopKey(1))).toMatchObject({ reason: 'CORRECTED', text: 'T05 L1 stop 1 Hyper Example A (C100): now Delivered (driver 11:20).' });
  });

  it('Delivered by the driver with a note: WARN; by the office, or without a note: nothing', () => {
    const c = run(result({ outcome: 'DELIVERED', reasonNote: 'two cases missing' }), at('11:25')).one('DELIVERED_WITH_NOTE');
    expect(c).toMatchObject({ kind: 'EVENT', tier: 1 });
    expect(c.text).toBe('T05 L1 stop 1 Hyper Example A (C100) marked DELIVERED with a note: "two cases missing" (driver, 11:20). Check everything was delivered.');
    run(result({ outcome: 'DELIVERED', reasonNote: 'two cases missing', outcomeSource: 'DISPATCHER' }), at('11:25')).none('DELIVERED_WITH_NOTE');
    run(result({ outcome: 'DELIVERED', reasonNote: '   ' }), at('11:25')).none('DELIVERED_WITH_NOTE');
  });

  it('a note that only confirms the delivery is not news (the 15 Oct 2026 replay: 12 of 13); one that says anything else is', () => {
    for (const note of ['تم التسليم', 'تم التسليم بنجاح', 'تم الاستلام', 'التسليم الساعه 11:25', 'Delivered OK', 'all delivered at 9:40 am']) {
      const r = run(result({ outcome: 'DELIVERED', reasonNote: note }), at('11:25'));
      r.none('DELIVERED_WITH_NOTE');
      expect(r.ended('DELIVERED_WITH_NOTE', stopKey(1))?.text, note).toContain('the note only confirms the delivery');
    }
    for (const note of ['باقي 14 لم يتم التسليم', 'تم التسليم ناقص كرتون', 'not all delivered', 'delivered to the guard']) {
      expect(run(result({ outcome: 'DELIVERED', reasonNote: note }), at('11:25')).one('DELIVERED_WITH_NOTE').text, note).toContain('marked DELIVERED with a note');
    }
  });
});

describe('R9 PROOF_FAR (M1: verified pins only)', () => {
  const photo = (over: Partial<FactVisit['photos'][number]> = {}) => ({ positionStatus: 'OK', distanceM: 600, accuracyM: 12, exifDistanceM: null, receivedAt: at('10:02'), ...over });
  const proof = (photos: FactVisit['photos'], over: Partial<FactVisit> = {}, stopOver: Partial<FactStop> = {}) =>
    facts([load({ stops: [stop(1, 480, { visit: visit({ arrivedAt: at('08:00'), photos, ...over }), ...stopOver })] })]);

  it('a photo 600 m from a verified pin: WARN; beyond 4 x 500 m: HIGH', () => {
    const c = run(proof([photo()]), at('10:05')).one('PROOF_FAR');
    expect(c).toMatchObject({ kind: 'EVENT', tier: 1, value: 600 });
    expect(c.text).toBe("T05 L1 stop 1 Hyper Example A (C100): delivery photo taken 600 m from the customer's pin (phone location, accuracy 12 m, 10:02). The pin or the place of the photo is wrong.");
    expect(run(proof([photo({ distanceM: 2400 })]), at('10:05')).one('PROOF_FAR')).toMatchObject({ tier: 2, value: 2400 });
  });

  it('a poor position is not evidence; the photo\'s own location and an accurate result position are', () => {
    run(proof([photo({ positionStatus: 'POOR', distanceM: 5000 })]), at('10:05')).none('PROOF_FAR');
    expect(run(proof([photo({ positionStatus: 'DENIED', distanceM: null, exifDistanceM: 800 })]), at('10:05')).one('PROOF_FAR').value).toBe(800);
    const result = { outcome: 'DELIVERED', outcomeAt: at('10:10'), outcomeSource: 'PHONE_MANUAL', outcomeDistanceM: 900 };
    run(proof([], { ...result, outcomeAccuracyM: 150 }), at('10:15')).none('PROOF_FAR');
    expect(run(proof([], { ...result, outcomeAccuracyM: 40 }), at('10:15')).one('PROOF_FAR').text).toContain('result recorded 900 m from');
  });

  it('a pin not verified (or on the "Pin may be wrong" list) is not checked', () => {
    const r = run(proof([photo({ distanceM: 9000 })], {}, { pinVerified: false }), at('10:05'));
    r.none('PROOF_FAR');
    expect(r.ended('PROOF_FAR', stopKey(1))?.text).toContain('pin is not verified');
  });
});

describe('R10 LOAD_NOT_CLOSED and R11 PAGE_NOT_OPENED (H3: one WARN instead of a pile)', () => {
  it('a dispatched load 121 min after its planned return: WARN; beyond 2T: HIGH', () => {
    const f = facts([load()]);
    run(f, at('14:00')).none('LOAD_NOT_CLOSED');
    const c = run(f, at('14:01')).one('LOAD_NOT_CLOSED', loadKey());
    expect(c).toMatchObject({ tier: 1, value: 121 });
    expect(c.text).toBe('T05 L1 still not closed at 14:01: planned back 12:00, no Back at depot, 3 of 3 stops without a result. Record the results, then Completed.');
    expect(run(f, at('16:01')).one('LOAD_NOT_CLOSED').tier).toBe(2);
  });

  it('a load of yesterday across midnight counts in minutes past 1440', () => {
    const y = load({ date: YESTERDAY, statusChangedAt: at('07:30', YESTERDAY) });
    const c = run(facts([y]), at('00:30')).one('LOAD_NOT_CLOSED', loadKey({ depotId: 'D1', date: YESTERDAY, truckId: 'TR1', loadNo: 1 }));
    expect(c).toMatchObject({ tier: 2, value: 750 });
    expect(c.text).toContain('still not closed at 00:30 +1');
  });

  it('back at the depot with every result: closing, nothing raised', () => {
    const done = (seq: number, eta: number) => stop(seq, eta, { visit: visit({ arrivedAt: at(eta), outcome: 'DELIVERED', outcomeAt: at(eta + 15), outcomeSource: 'PHONE_MANUAL' }) });
    const f = facts([load({ backAt: at('12:10'), stops: [done(1, 480), done(2, 540)] })]);
    run(f, at('15:00')).none('LOAD_NOT_CLOSED');
  });

  it('H3: a dispatched truck whose driver page was not opened raises PAGE_NOT_OPENED alone (31 min after departure, not 30)', () => {
    const f = facts([load()], { truckDays: [noPage()] });
    run(f, at('08:00')).none('PAGE_NOT_OPENED');
    const c = run(f, at('08:01')).one('PAGE_NOT_OPENED', subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1' }));
    expect(c).toMatchObject({ tier: 1, loadNo: null, sequence: null });
    expect(c.text).toBe('T05: dispatched (L1, planned departure 07:30) but the driver page has not been opened. RouteIQ cannot follow this truck: give the driver the link or QR code, or record the results in the office.');
    // Hours later, still only this one (no running late, silent, window or not-closed pile).
    const later = run(f, at('15:00'));
    expect([...new Set(later.ev.active.map((a) => a.rule))]).toEqual(['PAGE_NOT_OPENED']);
    // Opened: it ends.
    const opened = run(facts([load()]), at('09:00'));
    opened.none('PAGE_NOT_OPENED');
    expect(opened.ended('PAGE_NOT_OPENED', subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1' }))?.text).toContain('driver page opened');
  });
});

describe('scopes and words', () => {
  it('the depot-days read in full: every depot with a load or an open row of the window', () => {
    const f = facts([load()], { open: [['ETA_LATE', subjectKeyOf({ depotId: 'D2', date: D, truckId: 'TR9', loadNo: 1 })]] });
    const ev = evaluate(f, at('09:00'), ALL);
    expect(ev.scopes.map((s) => `${s.depotId}|${s.deliveryDate}`).sort()).toEqual([`D1|${D}`, `D2|${D}`]);
    expect(ev.scopes[0]!.rulesOn).toEqual(ALERT_RULES.filter((r) => ALL[r] !== null));
  });

  it('fuzz: customer names and notes full of phone numbers never put 6 digits in a row into any text; every text starts with the truck', () => {
    const six = /\p{Nd}(?:[\s\-+/.()]*\p{Nd}){5,}/u;
    const nasty = ['Shop 968 8123 4567', 'Hyper +96881234567', 'متجر ٨١٢٣٤٥٦٧', 'Shop (968) 8876-5432'];
    for (const name of nasty) {
      const stops = [
        stop(1, 480, { customerName: name, priority: 1, windowEndMin: 500, visit: visit({ arrivedAt: at('08:30'), outcome: 'NOT_DELIVERED', reason: 'OTHER', reasonNote: `call ${name} on 0096881234567`, outcomeAt: at('09:00'), outcomeSource: 'PHONE_MANUAL', photos: [{ positionStatus: 'OK', distanceM: 900, accuracyM: 5, exifDistanceM: null, receivedAt: at('09:00') }] }) }),
        stop(2, 540, { customerName: name, visit: visit({ arrivedAt: at('09:30'), outcome: 'DELIVERED', reasonNote: `missing 2, ring 81234567 ${name}`, outcomeAt: at('10:00'), outcomeSource: 'PHONE_MANUAL' }) }),
        stop(3, 600, { customerName: name, windowEndMin: 610, visit: visit({ arrivedAt: at('10:00') }) }),
        stop(4, 700, { customerName: name, windowEndMin: 650 }),
      ];
      const ev = evaluate(facts([load({ stops })]), at('12:30'), ALL);
      expect(ev.active.length).toBeGreaterThan(3);
      for (const t of [...ev.active.map((a) => a.text), ...ev.ended.map((e) => e.text)]) {
        expect(t, t).not.toMatch(six);
        expect(t.startsWith('T05'), t).toBe(true);
      }
    }
  });
});
