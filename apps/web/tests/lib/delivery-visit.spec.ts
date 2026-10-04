/**
 * The visit rebuilt from its events (owner request 4 Oct 2026, spec section 8.4): the result, the
 * cycle, the arrival and departure, the automatic timing (observed events only), the window start and
 * the planned break, late results, "camera not working" and the plausibility flags. Synthetic stop:
 * ACME, lines A:30 and B:10.
 */
import { describe, expect, it } from 'vitest';
import { cyclesOf, deriveVisit, plausibility, readVisitLines, type VisitContext, type VisitEvent } from '@/lib/delivery/visit';

const DAY = new Date('2026-10-05T00:00:00+04:00'); // zonedDayStart(5 Oct, Asia/Muscat)
/** Local HH:MM on the delivery day as an instant. */
const L = (hhmm: string) => new Date(DAY.getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000);
const PIN = { lat: 23.6, lng: 58.4 };
const LINES = [
  { orderId: 'O1', lineId: 'A', productCode: 'A', plannedCases: 30, deliveredCases: null },
  { orderId: 'O1', lineId: 'B', productCode: 'B', plannedCases: 10, deliveredCases: null },
];
const CTX: VisitContext = { dayStart: DAY, windowStartMin: null, breakMin: null, lines: LINES, pin: PIN, radiusM: 100 };

let n = 0;
function ev(kind: VisitEvent['kind'], source: VisitEvent['source'], at: string, payload: Record<string, unknown> = {}, over: Partial<VisitEvent> = {}): VisitEvent {
  n++;
  return { id: `e${n}`, kind, source, at: L(at), receivedAt: over.receivedAt ?? L(at), lat: null, lng: null, accuracyM: null, distanceM: null, payload, ...over };
}
const arrive = (at: string, payload: Record<string, unknown> = {}, source: VisitEvent['source'] = 'PHONE_AUTO', over: Partial<VisitEvent> = {}) => ev('ARRIVED', source, at, payload, over);
const depart = (at: string, payload: Record<string, unknown> = {}, source: VisitEvent['source'] = 'PHONE_AUTO', over: Partial<VisitEvent> = {}) => ev('DEPARTED', source, at, payload, over);
const result = (at: string, outcome: string | null, payload: Record<string, unknown> = {}, source: VisitEvent['source'] = 'PHONE_MANUAL', over: Partial<VisitEvent> = {}) =>
  ev('OUTCOME', source, at, { outcome, ...payload }, over);

describe('the result (spec section 8.4 step 1)', () => {
  it('is the OUTCOME with the latest time; a null outcome clears it', () => {
    const v = deriveVisit([result('10:05', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' }), result('10:20', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 40, state: 'DONE' });
    expect(v.lines.map((l) => l.deliveredCases)).toEqual([30, 10]);
    const cleared = deriveVisit([result('10:05', 'DELIVERED'), result('10:20', null)], CTX);
    expect(cleared).toMatchObject({ outcome: null, casesDelivered: null, state: 'PENDING' });
    expect(cleared.lines.map((l) => l.deliveredCases)).toEqual([null, null]);
  });

  it('a tie on time goes to the latest received, then to the dispatcher', () => {
    const a = result('10:10', 'DELIVERED', {}, 'PHONE_MANUAL', { receivedAt: L('10:11') });
    const b = result('10:10', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' }, 'PHONE_MANUAL', { receivedAt: L('10:30') });
    expect(deriveVisit([a, b], CTX).outcome).toBe('NOT_DELIVERED');
    const c = result('10:10', 'PARTLY_DELIVERED', { reason: 'DAMAGED_GOODS', lines: [{ lineId: 'B', delivered: 4 }, { lineId: 'A', delivered: 30 }] }, 'DISPATCHER', { receivedAt: L('10:30'), userId: 'u1' });
    const v = deriveVisit([b, c], CTX);
    expect(v).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 34, outcomeSource: 'DISPATCHER', outcomeById: 'u1', reason: 'DAMAGED_GOODS' });
  });

  it('keeps late, the no-photo reason and the photo keys of the result', () => {
    const v = deriveVisit([result('10:10', 'DELIVERED', { late: true, noPhotoReason: 'CAMERA_FAILED', photoKeys: ['k1', 5] })], CTX);
    expect(v).toMatchObject({ outcomeLate: true, noPhotoReason: 'CAMERA_FAILED', photoKeys: ['k1'] });
  });
});

describe("the driver's own last Delivered / Partly (owner decision 2 of 5 Oct 2026: results saved without a photo stay monitored)", () => {
  const camera = (at: string, outcome = 'DELIVERED') => result(at, outcome, { photoKeys: [], noPhotoReason: 'CAMERA_FAILED' });
  const office = (at: string, outcome: string | null, payload: Record<string, unknown> = {}) => result(at, outcome, { photoKeys: [], via: 'office', ...payload }, 'DISPATCHER', { userId: 'u1' });

  it('an office Record after "Camera not working" replaces the result but never the driver facts (they come from the driver events only)', () => {
    for (const fix of [office('11:00', 'DELIVERED'), office('11:00', 'PARTLY_DELIVERED', { reason: 'DAMAGED_GOODS', lines: [{ lineId: 'A', delivered: 20 }] }), office('11:00', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' }), office('11:00', null)]) {
      const v = deriveVisit([camera('10:10'), fix], CTX);
      expect(v.outcomeSource).toBe(fix.payload!.outcome === null ? null : 'DISPATCHER');
      expect(v.noPhotoReason).toBeNull();
      expect(v).toMatchObject({ driverResultAt: L('10:10'), driverResultOutcome: 'DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED', driverPhotoKeys: 0 });
    }
  });

  it("the driver's later Not delivered or Undo keeps the mark; only his new Delivered / Partly with a photo replaces it", () => {
    expect(deriveVisit([camera('10:10', 'PARTLY_DELIVERED'), result('10:20', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' }), result('10:25', null)], CTX)).toMatchObject({
      outcome: null,
      driverResultOutcome: 'PARTLY_DELIVERED',
      driverNoPhotoReason: 'CAMERA_FAILED',
    });
    const withPhoto = deriveVisit([camera('10:10'), result('10:30', 'DELIVERED', { photoKeys: ['k1'] }), office('11:00', 'DELIVERED')], CTX);
    expect(withPhoto).toMatchObject({ driverResultAt: L('10:30'), driverResultOutcome: 'DELIVERED', driverNoPhotoReason: null, driverPhotoKeys: 1 });
  });

  it('counts the photo keys of every driver Delivered / Partly (not a Not delivered, not the office); nothing without a driver result', () => {
    const v = deriveVisit([result('10:00', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED', photoKeys: ['shutter'] }), result('10:10', 'DELIVERED', { photoKeys: ['k1', 'k2'] }), result('10:20', 'PARTLY_DELIVERED', { photoKeys: ['k2', 'k3'], lines: [] })], CTX);
    expect(v).toMatchObject({ driverResultAt: L('10:20'), driverResultOutcome: 'PARTLY_DELIVERED', driverPhotoKeys: 3 });
    expect(deriveVisit([office('11:00', 'DELIVERED', { noPhotoReason: 'CAMERA_FAILED' })], CTX)).toMatchObject({ driverResultAt: null, driverResultOutcome: null, driverNoPhotoReason: null, driverPhotoKeys: 0 });
  });
});

describe('cycles, arrival and departure (steps 2-5)', () => {
  it('chooses the cycle holding the result and its earliest arrival; a departure before any arrival is ignored', () => {
    const evs = [depart('09:00'), arrive('09:30'), depart('09:35'), arrive('10:00'), arrive('10:01'), depart('10:30'), result('10:20', 'DELIVERED')];
    expect(cyclesOf(evs)).toHaveLength(2);
    const v = deriveVisit(evs, CTX);
    expect(v.arrivedAt).toEqual(L('10:00'));
    expect(v.departedAt).toEqual(L('10:30'));
    expect(v).toMatchObject({ autoBasis: 'DEPARTURE', autoMinutes: 30, departedAtOutcome: false });
  });

  it('events out of order give the same visit', () => {
    const evs = [arrive('10:00'), depart('10:30'), result('10:20', 'DELIVERED')];
    expect(deriveVisit([...evs].reverse(), CTX)).toEqual(deriveVisit(evs, CTX));
  });

  it('a dispatcher arrival in the cycle overrides the phone', () => {
    const v = deriveVisit([arrive('10:00'), arrive('09:55', {}, 'DISPATCHER'), result('10:20', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ arrivalSource: 'DISPATCHER', autoArrivedAt: null, autoMinutes: null });
    expect(v.arrivedAt).toEqual(L('09:55'));
  });

  describe('office times (Record outcome): the newest correction wins', () => {
    const office = (kind: 'ARRIVED' | 'DEPARTED', at: string, received: string) => ev(kind, 'DISPATCHER', at, { mode: 'OFFICE' }, { receivedAt: L(received), userId: 'u1' });
    const officeResult = (at: string) => result(at, 'DELIVERED', { via: 'office' }, 'DISPATCHER', { userId: 'u1' });

    it('(a) Arrived corrected from 10:30 to 10:05: the newest entry wins, not the latest time', () => {
      const v = deriveVisit([office('ARRIVED', '10:30', '16:00'), office('DEPARTED', '10:50', '16:00'), officeResult('16:00'), office('ARRIVED', '10:05', '17:00'), officeResult('17:00')], CTX);
      expect(v.arrivedAt).toEqual(L('10:05'));
      expect(v.departedAt).toEqual(L('10:50'));
      expect(v).toMatchObject({ arrivalSource: 'DISPATCHER', departureSource: 'DISPATCHER', departedAtOutcome: false });
    });

    it('(b) Left corrected from 10:20 to 10:40 is used', () => {
      const v = deriveVisit([office('ARRIVED', '10:00', '16:00'), office('DEPARTED', '10:20', '16:00'), officeResult('16:00'), office('DEPARTED', '10:40', '17:00'), officeResult('17:00')], CTX);
      expect(v.departedAt).toEqual(L('10:40'));
    });

    it("(c) an office Left replaces the phone's gap departure", () => {
      const v = deriveVisit([arrive('10:00'), depart('10:10', { gap: true }), result('10:05', 'DELIVERED'), office('DEPARTED', '10:40', '16:00'), officeResult('16:00')], CTX);
      expect(v.departedAt).toEqual(L('10:40'));
      expect(v).toMatchObject({ departureSource: 'DISPATCHER', departureGap: false, departedAtOutcome: false });
    });

    it('(d) only Arrived typed and the result saved at 17:30: no "Left" from the result time', () => {
      const v = deriveVisit([office('ARRIVED', '10:05', '17:30'), officeResult('17:30')], CTX);
      expect(v.arrivedAt).toEqual(L('10:05'));
      expect(v).toMatchObject({ departedAt: null, departedAtOutcome: false, state: 'DONE' });
      // The same for a phone arrival whose stop the office closed later.
      expect(deriveVisit([arrive('10:00'), officeResult('17:30')], CTX)).toMatchObject({ departedAt: null, departedAtOutcome: false });
    });

    it("(e) an office Left after the phone's arrival is kept; one before the arrival is not this stay's", () => {
      expect(deriveVisit([arrive('10:00'), office('DEPARTED', '10:25', '16:00'), officeResult('16:00')], CTX).departedAt).toEqual(L('10:25'));
      expect(deriveVisit([arrive('10:00'), office('DEPARTED', '09:50', '16:00'), officeResult('16:00')], CTX).departedAt).toBeNull();
    });
  });

  it('no departure and a result: the result time ends the stop; a departure over 15 min after the result is capped', () => {
    const lost = deriveVisit([arrive('10:00'), result('10:20', 'DELIVERED')], CTX);
    expect(lost).toMatchObject({ departedAtOutcome: true, autoBasis: 'RESULT', autoMinutes: 20 });
    expect(lost.departedAt).toEqual(L('10:20'));
    const parked = deriveVisit([arrive('10:00'), depart('10:50'), result('10:20', 'DELIVERED')], CTX);
    expect(parked).toMatchObject({ departedAtOutcome: true, autoBasis: 'RESULT', autoMinutes: 20, autoDepartedAt: null });
  });

  it('a resumed arrival (not observed) gives no automatic timing', () => {
    const v = deriveVisit([arrive('10:00', { observed: false }), depart('10:30'), result('10:20', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ arrivalObserved: false, autoArrivedAt: null, autoMinutes: null, autoBasis: null });
    // A "when?" answer is an earlier manual arrival: it wins and is observed, but it is not automatic.
    const answered = deriveVisit([arrive('10:00', { observed: false }), arrive('09:50', { when: true }, 'PHONE_MANUAL'), result('10:20', 'DELIVERED')], CTX);
    expect(answered).toMatchObject({ arrivalObserved: true, arrivalSource: 'PHONE_MANUAL', autoMinutes: null });
    expect(answered.arrivedAt).toEqual(L('09:50'));
  });

  it('a gap departure gives the time but is not observed: automatic timing ends at the result', () => {
    const v = deriveVisit([arrive('10:00'), depart('10:25', { gap: true }), result('10:20', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ departureGap: true, autoDepartedAt: null, autoBasis: 'RESULT', autoMinutes: 20 });
    expect(v.departedAt).toEqual(L('10:25'));
  });

  it('a late or dispatcher result never ends automatic timing', () => {
    expect(deriveVisit([arrive('10:00'), result('10:20', 'DELIVERED', { late: true })], CTX)).toMatchObject({ autoBasis: null, autoMinutes: null });
    expect(deriveVisit([arrive('10:00'), result('10:20', 'DELIVERED', {}, 'DISPATCHER')], CTX)).toMatchObject({ autoBasis: null });
  });

  it('an arrival without a result or departure is in progress (ARRIVED)', () => {
    expect(deriveVisit([arrive('10:00')], CTX)).toMatchObject({ state: 'ARRIVED', departedAt: null });
    expect(deriveVisit([arrive('10:00'), depart('10:05')], CTX)).toMatchObject({ state: 'PENDING' });
  });

  it('CARRY_CONFLICT events are ignored', () => {
    const v = deriveVisit([result('10:20', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' }), ev('CARRY_CONFLICT', 'DISPATCHER', '11:00', { outcome: 'DELIVERED' })], CTX);
    expect(v.outcome).toBe('NOT_DELIVERED');
  });
});

describe('unloading from the service start (step 6)', () => {
  it('an early arrival waiting for the window counts only from the window start', () => {
    const v = deriveVisit([arrive('07:40'), depart('08:21'), result('08:20', 'DELIVERED')], { ...CTX, windowStartMin: 8 * 60 });
    expect(v).toMatchObject({ autoMinutes: 41, autoServiceMinutes: 21 });
  });

  it('is null when the stop overlaps the planned break, or when it ends before the window opens', () => {
    expect(deriveVisit([arrive('12:10'), depart('12:40'), result('12:30', 'DELIVERED')], { ...CTX, breakMin: { startMin: 12 * 60 + 30, endMin: 13 * 60 + 30 } })).toMatchObject({ autoMinutes: 30, autoServiceMinutes: null });
    expect(deriveVisit([arrive('07:00'), depart('07:30'), result('07:20', 'NOT_DELIVERED', { reason: 'SHOP_CLOSED' })], { ...CTX, windowStartMin: 8 * 60 })).toMatchObject({ autoServiceMinutes: null });
  });
});

describe('plausibility flags (spec section 8.3)', () => {
  const pos = (lat: number, lng: number, acc = 8) => ({ lat, lng, accuracyM: acc });
  it('flags a position equal to the pin, accuracy <= 1, identical arrive / depart coordinates and a far photo', () => {
    expect(plausibility([arrive('10:00', {}, 'PHONE_AUTO', pos(PIN.lat, PIN.lng))], PIN, 100)).toEqual(['POSITION_IS_PIN']);
    expect(plausibility([arrive('10:00', {}, 'PHONE_AUTO', pos(23.6001, 58.4001, 1))], PIN, 100)).toEqual(['ACCURACY_TOO_GOOD']);
    expect(plausibility([arrive('10:00', {}, 'PHONE_AUTO', pos(23.6001, 58.4001)), depart('10:20', {}, 'PHONE_AUTO', pos(23.6001, 58.4001))], PIN, 100)).toEqual(['SAME_ARRIVE_DEPART_POSITION']);
    expect(plausibility([arrive('10:00', {}, 'PHONE_AUTO', pos(23.6001, 58.4001)), ev('PHOTO', 'PHONE_MANUAL', '10:10', {}, pos(23.61, 58.4))], PIN, 100)).toEqual(['ARRIVAL_FAR_FROM_PROOF']);
  });

  it('flags the same non-integer accuracy on three automatic events, never round iOS values', () => {
    const same = [arrive('10:00', {}, 'PHONE_AUTO', pos(23.6001, 58.4001, 12.37)), depart('10:20', {}, 'PHONE_AUTO', pos(23.603, 58.4, 12.37)), arrive('10:40', {}, 'PHONE_AUTO', pos(23.6002, 58.4002, 12.37))];
    expect(plausibility(same, PIN, 100)).toEqual(['SAME_ACCURACY']);
    const ios = same.map((e) => ({ ...e, accuracyM: 65 }));
    expect(plausibility(ios, PIN, 100)).toEqual([]);
  });

  it('any flag marks the visit timingSuspect', () => {
    const v = deriveVisit([arrive('10:00', {}, 'PHONE_AUTO', pos(PIN.lat, PIN.lng)), result('10:20', 'DELIVERED')], CTX);
    expect(v).toMatchObject({ timingSuspect: true, suspect: ['POSITION_IS_PIN'] });
  });
});

describe('readVisitLines', () => {
  it('drops malformed entries and never throws', () => {
    expect(readVisitLines([{ orderId: 'O', lineId: 'L', productCode: 'P', plannedCases: 3, deliveredCases: 2 }, { lineId: 'x' }, null, 5])).toEqual([
      { orderId: 'O', lineId: 'L', productCode: 'P', plannedCases: 3, deliveredCases: 2 },
    ]);
    expect(readVisitLines('nope')).toEqual([]);
  });
});
