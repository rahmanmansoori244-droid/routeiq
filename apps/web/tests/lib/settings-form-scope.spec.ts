/**
 * Review: the dispatcher's Settings page (scope DISPATCHER) shows an input for every field the
 * API lets a dispatcher save (DISPATCHER_SETTINGS_FIELDS) - "Overtime after" sat in the admin-only
 * costs card, so a dispatcher could be refused a save with no field to fix it - and no admin field.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

import { SettingsForm } from '@/app/t/[slug]/settings/settings-form';
import { DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS, withFirstDeparture, type EditableConfig } from '@/lib/settings-fields';

const config = {
  shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, driverBreakMinutes: 60, driverBreakFromMin: 720,
  driverBreakToMin: 840, reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, defaultServiceTimeMin: 10,
  maxTripsPerTruck: 3, splitDeliveries: true, planningCutoffMin: 1080, dateOrder: 'DMY', fuelPricePerLitre: 0,
  driverCostPerHour: 2, overtimeCostPerHour: 1, prefWindowPenaltyPerMin: 0.05, distanceProvider: 'HAVERSINE',
  roadTimeFactor: 1.25, distanceMultiplier: 1.3, avgSpeedKmh: 40,
} as unknown as EditableConfig;
const render = (scope: 'ADMIN' | 'DISPATCHER') =>
  renderToStaticMarkup(
    createElement(SettingsForm, {
      initial: { tenant: { name: 'T', country: 'Oman', currency: 'OMR', primaryUnit: 'CASES' }, config } as never,
      effective: [],
      profiles: [],
      scope,
    }),
  );
const TIME_ID: Record<string, string> = { driverShiftMaxMinutes: 'latestReturn' };

describe('Settings as the dispatcher', () => {
  it('shows an input for every field a dispatcher may save, and none of the admin fields', () => {
    const html = render('DISPATCHER');
    for (const k of DISPATCHER_SETTINGS_FIELDS) expect(html, k).toContain(`id="${k}"`);
    expect(html).toContain(`id="${TIME_ID.driverShiftMaxMinutes}"`);
    const adminOnly = SETTINGS_FIELDS.filter((k) => !(DISPATCHER_SETTINGS_FIELDS as readonly string[]).includes(k));
    for (const k of adminOnly) expect(html, k).not.toContain(`id="${k}"`);
  });

  it('Latest return 18:00 typed first, then First departure 06:00 -> 07:00: still back by 18:00 (the shift maximum follows)', () => {
    const typed = { shiftStartMin: 360, driverShiftMaxMinutes: 720 }; // 06:00 + 12 h = 18:00
    expect(withFirstDeparture(typed, 420)).toEqual({ shiftStartMin: 420, driverShiftMaxMinutes: 660 });
  });

  it('the admin page still shows Overtime after once', () => {
    expect(render('ADMIN').split('id="overtimeAfterMin"')).toHaveLength(2);
  });
});
