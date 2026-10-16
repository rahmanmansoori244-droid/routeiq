/**
 * Synthetic GPS trails for the IVMS live link specs: an invented depot in empty desert (never near a
 * real place of business) and points as metre offsets from it, every 30 s by default.
 */
import type { TrailPoint } from '@/lib/ivms/types';

export const ORIGIN = { lat: 20.1, lng: 55.1 };
/** A point `north` / `east` metres from the invented depot. */
export const at = (east: number, north = 0) => ({ lat: ORIGIN.lat + north / 111_320, lng: ORIGIN.lng + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });
export const DAY = Date.parse('2026-10-20T00:00:00+04:00');
/** Local HH:MM(:SS) of the delivery day. */
export const T = (hhmm: string) => new Date(DAY + (Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60 + (hhmm.length > 5 ? Number(hhmm.slice(6, 8)) : 0)) * 1000);

/** A trail builder: points every `stepSec` while parked or moving in a straight line at a speed. */
export class Trail {
  pts: TrailPoint[] = [];
  t: number;
  pos: { east: number; north: number };
  constructor(start: string, east = 0, north = 0, private stepSec = 30) {
    this.t = T(start).getTime();
    this.pos = { east, north };
  }
  park(minutes: number, opts: { stepSec?: number; jitterM?: number; ignition?: boolean | null } = {}): this {
    const step = (opts.stepSec ?? this.stepSec) * 1000;
    const end = this.t + minutes * 60_000;
    let i = 0;
    for (; this.t < end; this.t += step, i++) {
      const j = opts.jitterM ? (i % 2 ? opts.jitterM : -opts.jitterM) : 0;
      this.pts.push({ fixAt: new Date(this.t), ...at(this.pos.east + j, this.pos.north), speedKmh: 0, ignition: opts.ignition ?? true });
    }
    return this;
  }
  drive(toEast: number, toNorth = 0, kmh = 40, opts: { stepSec?: number } = {}): this {
    const step = (opts.stepSec ?? this.stepSec) * 1000;
    const dist = Math.hypot(toEast - this.pos.east, toNorth - this.pos.north);
    const durMs = (dist / (kmh / 3.6)) * 1000;
    const from = { ...this.pos };
    const t0 = this.t;
    for (let dt = step; dt < durMs; dt += step) {
      const f = dt / durMs;
      this.pts.push({ fixAt: new Date(t0 + dt), ...at(from.east + (toEast - from.east) * f, from.north + (toNorth - from.north) * f), speedKmh: kmh, ignition: true });
    }
    this.t = t0 + Math.max(step, Math.ceil(durMs / step) * step);
    this.pos = { east: toEast, north: toNorth };
    return this;
  }
  /** Move without a point (the truck drove during a silence). */
  jump(east: number, north = 0): this {
    this.pos = { east, north };
    return this;
  }
  /** Silence: no point for `minutes` (coverage gap, or a device that reports rarely). */
  silent(minutes: number): this {
    this.t += minutes * 60_000;
    return this;
  }
  /** One point somewhere (an outlier: the truck itself stays where it was). */
  point(east: number, north = 0, kmh = 0): this {
    this.pts.push({ fixAt: new Date(this.t), ...at(east, north), speedKmh: kmh, ignition: true });
    this.t += this.stepSec * 1000;
    return this;
  }
}


/** Local HH:MM of an instant (Muscat, UTC+4). */
export const hhmm = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(11, 16);
