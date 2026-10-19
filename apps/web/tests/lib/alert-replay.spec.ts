/**
 * Operations alerts (owner request 16 Oct 2026): the read-only replay (lib/alerts/replay.ts and
 * scripts/alerts-replay.ts) over a saved day built here by hand: the state "as of t" comes from the status
 * moves and the events the server had RECEIVED by t (critique L12), the same rules and store semantics
 * run in memory, and the report counts per rule. Nothing touches a database. Invented names and codes.
 */
import { describe, expect, it } from 'vitest';
import { factsAsOf, readAlertDayExport, replayDay, replayText, statusAsOf, type AlertDayExport, type ExportEvent, type ExportStop } from '@/lib/alerts/replay';
import { parseDayMinute, parseSetting } from '@/scripts/alerts-replay';
import { addDaysIso, parseHhmm, zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-10-15';
/** ISO time of a local "HH:MM" of D (dayOffset -1: the evening before). */
const iso = (hhmm: string, dayOffset = 0) => new Date(zonedDayStart(addDaysIso(D, dayOffset), TZ).getTime() + parseHhmm(hhmm)! * 60_000).toISOString();
const ev = (kind: string, hhmm: string, over: Partial<ExportEvent> = {}): ExportEvent => ({ kind, source: 'PHONE_MANUAL', at: iso(hhmm), receivedAt: iso(hhmm), distanceM: 15, accuracyM: 10, payload: null, ...over });

function stop(sequence: number, eta: number, name: string, over: Partial<ExportStop> = {}): ExportStop {
  return {
    sequence,
    customerId: `cust-${sequence}`,
    customerCode: `C${sequence}00`,
    branchCode: null,
    customerName: name,
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

const visitOf = (events: ExportEvent[]) => ({ plannedServiceMin: 20, windowStartMin: null, windowEndMin: null, casesPlanned: 10, events, photos: [] });

/**
 * T05 L1 (driver page opened 07:35): Locked 20:00 and Loading 21:00 the evening before, dispatched 07:32.
 * Stop 1 delivered 08:20; stop 2 (priority 1) reached 09:40, 40 min late, unloaded 70 min, Not delivered
 * 10:50; stop 3 never reached and no Back at depot. T07 L1 (a hired truck): dispatched 07:00, its
 * driver page never opened.
 */
function day(): AlertDayExport {
  return {
    v: 1,
    kind: 'routeiq-alerts-day',
    date: D,
    tz: TZ,
    exportedAt: iso('23:59'),
    config: {
      alertsEnabled: false,
      alertUnloadOverMin: 30,
      alertLoadingOverMin: null,
      alertEtaLateMin: 30,
      alertDepartLateMin: 30,
      alertSilentMin: 120,
      alertPageNotOpenedMin: 30,
      alertAfterClosingMin: 15,
      alertPriorityMax: 2,
      alertDeliveredNote: true,
      alertProofFarM: 500,
      alertNotClosedMin: 120,
    },
    loads: [
      {
        id: 'l-t05',
        depotId: 'D1',
        truckId: 'TR5',
        truckCode: 'T05',
        loadNo: 1,
        departMin: 450,
        returnMin: 720,
        windowRule: 'FINISH',
        breakMin: null,
        finalStatus: 'DISPATCHED',
        stopCount: 3,
        history: [
          { status: 'LOCKED', at: iso('20:00', -1) },
          { status: 'LOADING', at: iso('21:00', -1) },
          { status: 'DISPATCHED', at: iso('07:32') },
        ],
        backEvents: [],
        stops: [
          stop(1, 480, 'Hyper Example A', { visit: visitOf([ev('ARRIVED', '08:05'), ev('OUTCOME', '08:20', { payload: { outcome: 'DELIVERED' } })]) }),
          stop(2, 540, 'Shop Example B', {
            priority: 1,
            visit: visitOf([ev('ARRIVED', '09:40'), ev('OUTCOME', '10:50', { payload: { outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', note: 'closed, call 81234567' } })]),
          }),
          stop(3, 600, 'Shop Example C'),
        ],
      },
      {
        id: 'l-t07',
        depotId: 'D1',
        truckId: 'TR7',
        truckCode: 'T07',
        loadNo: 1,
        departMin: 420,
        returnMin: 660,
        windowRule: 'START',
        breakMin: null,
        finalStatus: 'DISPATCHED',
        stopCount: 1,
        history: [{ status: 'LOCKED', at: iso('20:00', -1) }, { status: 'DISPATCHED', at: iso('07:00') }],
        backEvents: [],
        stops: [stop(1, 480, 'Shop Example D')],
      },
    ],
    truckDays: [{ truckId: 'TR5', firstSeenAt: iso('07:35'), lastSeenAt: iso('11:00') }],
  };
}

describe('the state as of a time', () => {
  it('a load\'s status from its moves: Planned before the first, Loading in the night, Dispatched from 07:32', () => {
    const l = day().loads[0]!;
    expect(statusAsOf(l, Date.parse(iso('19:00', -1)))).toMatchObject({ status: 'PLANNED', statusChangedAt: null });
    expect(statusAsOf(l, Date.parse(iso('23:00', -1)))).toMatchObject({ status: 'LOADING', statusChangedAt: new Date(iso('21:00', -1)) });
    expect(statusAsOf(l, Date.parse(iso('08:00')))).toMatchObject({ status: 'DISPATCHED', statusChangedAt: new Date(iso('07:32')) });
    // No moves exported: the final status, no time.
    expect(statusAsOf({ finalStatus: 'COMPLETED', history: [] }, 0)).toEqual({ status: 'COMPLETED', statusChangedAt: null });
  });

  it('a visit is rebuilt from the events received by then (L12): later events are not known yet', () => {
    const at0930 = factsAsOf(day(), new Date(iso('09:30')), []);
    const t05 = at0930.loads.find((l) => l.truckCode === 'T05')!;
    expect(t05.stops[0]!.visit).toMatchObject({ outcome: 'DELIVERED', arrivedAt: new Date(iso('08:05')) });
    expect(t05.stops[1]!.visit).toBeNull();
    const at1000 = factsAsOf(day(), new Date(iso('10:00')), []).loads.find((l) => l.truckCode === 'T05')!;
    expect(at1000.stops[1]!.visit).toMatchObject({ arrivedAt: new Date(iso('09:40')), outcome: null });
    // An event received late (held by the phone) is unknown until it arrives.
    const held = day();
    held.loads[0]!.stops[0]!.visit!.events[0]!.receivedAt = iso('09:00');
    expect(factsAsOf(held, new Date(iso('08:30')), []).loads[0]!.stops[0]!.visit!.arrivedAt).toBeNull();
    // The driver pages: T05 opened from 07:35; T07 never.
    const pages = factsAsOf(day(), new Date(iso('07:40')), []).truckDays;
    expect(pages.find((t) => t.truckId === 'TR5')).toMatchObject({ pageOpened: true });
    expect(pages.find((t) => t.truckId === 'TR7')).toMatchObject({ pageOpened: false, linkSeenAt: null });
    expect(factsAsOf(day(), new Date(iso('07:30')), []).truckDays.find((t) => t.truckId === 'TR5')!.pageOpened).toBe(false);
  });

  it('merge review of 17 Oct 2026, finding 1: the GPS (AYUN) events of the IVMS live link are left out, as the live facts leave out their times', () => {
    const gps = (kind: string, hhmm: string) => ev(kind, hhmm, { source: 'AYUN', payload: { observed: true, detector: 'ivms-v1' } });
    const withGps = day();
    const [s1, s2, s3] = withGps.loads[0]!.stops;
    // Stop 1: a GPS departure after the result (it would replace the result standing in for the departure).
    s1!.visit!.events.push(gps('ARRIVED', '08:04'), gps('DEPARTED', '08:30'));
    // Stop 2: the tracker saw the truck leave at 10:10 (it would end the 70 min of unloading the driver left open).
    s2!.visit!.events.push(gps('ARRIVED', '09:35'), gps('DEPARTED', '10:10'));
    // Stop 3: only the tracker saw the truck there (a visit only GPS made).
    s3!.visit = visitOf([gps('ARRIVED', '10:30'), gps('DEPARTED', '10:50')]);
    const noon = factsAsOf(withGps, new Date(iso('12:00')), []).loads.find((l) => l.truckCode === 'T05')!;
    expect(noon.stops[0]!.visit).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departedAt: new Date(iso('08:20')), departedAtOutcome: true });
    expect(noon.stops[2]!.visit).toBeNull();
    const at1030 = factsAsOf(withGps, new Date(iso('10:30')), []).loads.find((l) => l.truckCode === 'T05')!;
    expect(at1030.stops[1]!.visit).toMatchObject({ arrivedAt: new Date(iso('09:40')), departedAt: null, outcome: null });
    // The whole day replays exactly as without them.
    expect(replayDay(withGps)).toEqual(replayDay(day()));
  });
});

describe('replayDay', () => {
  it('reports per rule what the day would have raised (in the app), with the first time and sample texts', () => {
    const r = replayDay(day());
    const by = Object.fromEntries(r.rules.map((s) => [s.rule, s]));
    expect(r).toMatchObject({ date: D, from: '05:00', to: '23:59' });
    expect(by.PAGE_NOT_OPENED).toMatchObject({ raised: 1, first: '07:35' });
    expect(by.PAGE_NOT_OPENED!.samples[0]).toMatch(/^T07: dispatched \(L1, planned departure 07:00\)/);
    expect(by.ETA_LATE!.raised).toBe(1);
    expect(by.ETA_LATE!.first).toBe('09:35');
    expect(by.UNLOAD_OVER!.raised).toBe(1);
    expect(by.PRIORITY_NOT_DELIVERED).toMatchObject({ raised: 1, first: '10:50' });
    expect(by.PRIORITY_NOT_DELIVERED!.samples[0]).toContain('Note: "closed, call [number]"');
    expect(by.DRIVER_SILENT!.raised).toBe(1);
    expect(by.LOAD_NOT_CLOSED!.raised).toBe(1);
    // Off in the saved settings: nothing.
    expect(by.LOADING_OVER).toMatchObject({ threshold: null, raised: 0 });
    // Nothing for the hired truck beyond its one WARN (H3).
    expect(r.timeline.filter((e) => e.text.startsWith('T07') && e.kind === 'RAISED').map((e) => e.rule)).toEqual(['PAGE_NOT_OPENED']);
    expect(replayText(r)).toContain('R3 Running late (threshold 30): 1 raised');
  });

  it('is deterministic, and the same day replayed with other thresholds gives other counts', () => {
    expect(replayDay(day()).timeline).toEqual(replayDay(day()).timeline);
    const base = Object.fromEntries(replayDay(day()).rules.map((s) => [s.rule, s]));
    const lenient = replayDay(day(), { overrides: { alertEtaLateMin: 120, alertSilentMin: 600, alertPriorityMax: null } });
    const by = Object.fromEntries(lenient.rules.map((s) => [s.rule, s]));
    expect(by.ETA_LATE!.first! > base.ETA_LATE!.first!).toBe(true);
    expect(base.DRIVER_SILENT!.raised).toBe(1);
    // 600 min of silence is never reached before the planned return + 60 min (12:00 + 60): "Load not closed" follows then (review M1).
    expect(by.DRIVER_SILENT).toMatchObject({ raised: 0 });
    expect(by.PRIORITY_NOT_DELIVERED).toMatchObject({ threshold: null, raised: 0 });
  });

  it("owner request 19 Oct 2026: replayed past midnight, the day's rows still open close at the first step after it (Day ended), as the live sweep does; nothing reopens or is raised open after", () => {
    const r = replayDay(day(), { fromMin: parseDayMinute('23:00'), toMin: parseDayMinute('00:30+1'), stepMin: 5 });
    const raised = r.timeline.filter((e) => e.kind === 'RAISED');
    expect(raised.length).toBeGreaterThanOrEqual(2);
    expect(raised.every((e) => !e.at.endsWith('+1'))).toBe(true);
    // 23:55 is still the day: everything raised is open until the 00:00 step closes it.
    const closed = r.timeline.filter((e) => e.kind === 'CLOSED');
    expect(closed.length).toBe(raised.length);
    expect(new Set(closed.map((e) => e.at))).toEqual(new Set(['00:00 +1']));
    expect(closed.every((e) => e.text.endsWith('(day ended)'))).toBe(true);
    // Every row is closed: the history row (the unloading over before any step saw it) as ENDED, the rest at the day's end.
    expect(r.rows.map((x) => [x.rule, x.resolvedReason])).toEqual([
      ['UNLOAD_OVER', 'ENDED'],
      ['LOAD_NOT_CLOSED', 'DAY_ENDED'],
      ['PRIORITY_NOT_DELIVERED', 'DAY_ENDED'],
      ['PAGE_NOT_OPENED', 'DAY_ENDED'],
    ]);
    expect(r.timeline.filter((e) => e.kind === 'REOPENED' || e.kind === 'ESCALATED').filter((e) => e.at.endsWith('+1'))).toEqual([]);
  });

  it("review of the branch (finding 2): a load planned back at 22:30 and still not closed raises Load not closed after midnight, open, and escalates; it is not closed as Day ended", () => {
    const exp = day();
    // T05 L1 planned back at 22:30: stop 3 still has no result and there is no Back at depot.
    exp.loads[0]!.returnMin = parseDayMinute('22:30');
    const r = replayDay(exp, { fromMin: parseDayMinute('22:00'), toMin: parseDayMinute('03:00+1'), stepMin: 5 });
    // Threshold 120 min: over it from 00:31, so the 00:35 step raises it (WARN); over 2 x 120 from 02:31: HIGH at 02:35.
    const notClosed = r.timeline.filter((e) => e.rule === 'LOAD_NOT_CLOSED');
    expect(notClosed.map((e) => [e.at, e.kind, e.severity])).toEqual([
      ['00:35 +1', 'RAISED', 'WARN'],
      ['02:35 +1', 'ESCALATED', 'HIGH'],
    ]);
    // The HIGH may be e-mailed (a HIGH-only e-mail carries it), and the row is still open at 03:00.
    expect(notClosed[1]!.emailHigh).toBe(true);
    expect(r.rows.find((x) => x.rule === 'LOAD_NOT_CLOSED')).toMatchObject({ resolvedAt: null, resolvedReason: null, tier: 2, severity: 'HIGH', mayToast: true, mayEmail: true });
    // The rows open at midnight still closed then as Day ended, and nothing else was raised open after it.
    const atMidnight = r.timeline.filter((e) => e.kind === 'CLOSED' && e.at === '00:00 +1');
    expect(atMidnight.length).toBeGreaterThanOrEqual(1);
    expect(atMidnight.every((e) => e.text.endsWith('(day ended)'))).toBe(true);
    expect(r.timeline.filter((e) => e.kind === 'RAISED' && e.at.endsWith('+1')).map((e) => e.rule)).toEqual(['LOAD_NOT_CLOSED']);
  });

  it('switched on at noon: nothing that began before it raises (no backlog)', () => {
    const r = replayDay(day(), { switchOnMin: 12 * 60 });
    const by = Object.fromEntries(r.rules.map((s) => [s.rule, s]));
    expect(by.PAGE_NOT_OPENED!.raised).toBe(0);
    expect(by.PRIORITY_NOT_DELIVERED!.raised).toBe(0);
    expect(by.LOAD_NOT_CLOSED!.raised).toBe(1);
  });

  it('the loading rule (R2, from the driver taps) tried on the night before: the 21:00 Loading press of every first trip raises nothing', () => {
    const r = replayDay(day(), { fromMin: parseDayMinute('20:00-1'), toMin: parseDayMinute('07:00'), overrides: { alertLoadingOverMin: 40 } });
    const loading = r.rules.find((s) => s.rule === 'LOADING_OVER')!;
    expect(loading).toMatchObject({ threshold: 40, raised: 0 });
    expect(r.from).toBe('20:00 -1');
  });

  it('R2 between two trips: live from Back at depot (by its receipt), over once the Leaving tap is received; an export from before has no taps', () => {
    const d = day();
    const t05 = d.loads[0]!;
    t05.backEvents = [ev('BACK_AT_DEPOT', '11:20')];
    d.loads.push({
      ...t05,
      id: 'l-t05-2',
      loadNo: 2,
      departMin: 780,
      returnMin: 1000,
      finalStatus: 'DISPATCHED',
      history: [{ status: 'LOCKED', at: iso('20:00', -1) }, { status: 'DISPATCHED', at: iso('12:30') }],
      backEvents: [],
      // Tapped 12:10, received 12:12 (no signal at the gate).
      departEvents: [ev('DEPOT_DEPART', '12:10', { receivedAt: iso('12:12') })],
      stops: [stop(1, 800, 'Shop Example D')],
    });
    const r = replayDay(d, { fromMin: parseDayMinute('11:00'), toMin: parseDayMinute('13:00'), overrides: { alertLoadingOverMin: 40 } });
    const loading = r.rules.find((s) => s.rule === 'LOADING_OVER')!;
    expect(loading).toMatchObject({ threshold: 40, raised: 1, first: '12:05' });
    expect(loading.samples[0]).toBe('T05 L2: at the depot for 45 min since Back at depot of L1 at 11:20, not left with L2 yet (limit 40 min). Planned departure 13:00, load is Locked.');
    const closed = r.timeline.find((e) => e.rule === 'LOADING_OVER' && e.kind === 'CLOSED');
    expect(closed).toMatchObject({ at: '12:15' });
    expect(closed!.text).toBe('T05 L2: 50 min at the depot between L1 and L2 (back 11:20, left 12:10, by Leaving tapped), limit 40 min.');
    // As of 12:11 the tap is not received yet: still at the depot.
    const at1211 = factsAsOf(d, new Date(iso('12:11')), []);
    expect(at1211.loads.find((l) => l.loadNo === 2)!.leftTapAt).toBeNull();
    expect(factsAsOf(d, new Date(iso('12:12')), []).loads.find((l) => l.loadNo === 2)!.leftTapAt).toEqual(new Date(iso('12:10')));
    // An export from before 16 Oct 2026 (no departEvents): read as no tap.
    delete d.loads[2]!.departEvents;
    expect(factsAsOf(d, new Date(iso('12:20')), []).loads.find((l) => l.loadNo === 2)!.leftTapAt).toBeNull();
  });

  it('R2 as of a time (second review of 16 Oct 2026): the Dispatch press from the moves, kept once completed; the latest tap; when the trip was planned', () => {
    const d = day();
    const t05 = d.loads[0]!;
    t05.backEvents = [ev('BACK_AT_DEPOT', '11:20')];
    d.loads.push({
      ...t05,
      id: 'l-t05-2',
      loadNo: 2,
      departMin: 780,
      returnMin: 1000,
      finalStatus: 'COMPLETED',
      history: [{ status: 'LOCKED', at: iso('20:00', -1) }, { status: 'DISPATCHED', at: iso('11:50') }, { status: 'COMPLETED', at: iso('15:00') }],
      backEvents: [],
      departEvents: [ev('DEPOT_DEPART', '11:30'), ev('DEPOT_DEPART', '11:45')],
      plannedAt: iso('18:00', -1),
      stops: [stop(1, 800, 'Shop Example D')],
    });
    const l2 = (hhmm: string) => factsAsOf(d, new Date(iso(hhmm)), []).loads.find((l) => l.loadNo === 2)!;
    expect(l2('16:00')).toMatchObject({ status: 'COMPLETED', statusChangedAt: new Date(iso('15:00')), dispatchedAt: new Date(iso('11:50')), leftTapAt: new Date(iso('11:45')), existedAt: new Date(iso('18:00', -1)) });
    expect(l2('16:00').leftTaps).toEqual([new Date(iso('11:30')), new Date(iso('11:45'))]);
    expect(l2('11:40')).toMatchObject({ status: 'LOCKED', dispatchedAt: null, leftTapAt: new Date(iso('11:30')) });
    // An export from before (no plannedAt): not known.
    delete d.loads[2]!.plannedAt;
    expect(l2('16:00').existedAt).toBeNull();
  });
});

describe('the script\'s inputs', () => {
  it('times of the saved day, the evening before and the night after', () => {
    expect(parseDayMinute('05:00')).toBe(300);
    expect(parseDayMinute('21:00-1')).toBe(-180);
    expect(parseDayMinute('00:30+1')).toBe(1470);
    expect(() => parseDayMinute('25:00')).toThrow(/Not a time/);
  });

  it('settings to try: a threshold, off, the note switch; anything else is refused', () => {
    expect(parseSetting('alertEtaLateMin=40')).toEqual({ alertEtaLateMin: 40 });
    expect(parseSetting('alertLoadingOverMin=off')).toEqual({ alertLoadingOverMin: null });
    expect(parseSetting('alertDeliveredNote=false')).toEqual({ alertDeliveredNote: false });
    expect(() => parseSetting('alertEmails=a@b.example')).toThrow(/Unknown alert setting/);
    expect(() => parseSetting('alertEtaLateMin=soon')).toThrow(/whole number/);
  });

  it('a file that is not a saved day is refused', () => {
    expect(() => readAlertDayExport({ v: 2 })).toThrow(/Not a RouteIQ alerts day export/);
    expect(() => readAlertDayExport({ v: 1, kind: 'routeiq-alerts-day', date: 'x' })).toThrow(/incomplete/);
    expect(readAlertDayExport(JSON.parse(JSON.stringify(day()))).date).toBe(D);
  });
});
