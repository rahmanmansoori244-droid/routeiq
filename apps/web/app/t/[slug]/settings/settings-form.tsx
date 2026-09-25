'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { CapacityUnit } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/error-message';
import { fmtHhmm, parseHhmm } from '@/lib/dispatch/time';
import { boundText, CONFIG_BOUNDS, inBound, type Bound, type ConfigBoundKey } from '@/lib/planner-bounds';
import { SETTING_LABELS, type EffectiveRow } from '@/lib/dispatch/planner-config';
import { changedFields, type EditableConfig } from '@/lib/settings-fields';
import { COUNTRY_NAMES, countryRoutingNote, isListedCountry } from '@/lib/countries';

interface TenantFields {
  name: string;
  country: string;
  currency: string;
  primaryUnit: CapacityUnit;
}

interface Initial {
  tenant: TenantFields;
  config: EditableConfig;
}

interface TypeProfileRow {
  customerType: string;
  defaultPriority: number | null;
  serviceTimeMin: number | null;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
}

const SOURCE_TEXT: Record<EffectiveRow['source'], string> = {
  SETTING: 'Setting',
  PLANNER: 'Planner rule',
  OPERATIONS: 'Operations',
};

/**
 * Settings of the daily dispatch planner (review F21): only what the planner uses, within the
 * bounds the optimizer accepts, saved field by field. The page sends the fields it changed and
 * the values it showed; a save that would overwrite another admin's newer change is refused (409).
 */
export function SettingsForm({ initial, effective, profiles }: { initial: Initial; effective: EffectiveRow[]; profiles: TypeProfileRow[] }) {
  const router = useRouter();
  const [pending, startSave] = useTransition();
  const [baseline, setBaseline] = useState(initial);
  const [t, setT] = useState<TenantFields>(initial.tenant);
  const [c, setC] = useState<EditableConfig>(initial.config);
  const cur = t.currency || 'OMR';

  const tenantDiff = changedFields(baseline.tenant as unknown as Record<string, unknown>, t as unknown as Record<string, unknown>);
  const configDiff = changedFields(baseline.config as unknown as Record<string, unknown>, c as unknown as Record<string, unknown>);
  const dirty = Object.keys(tenantDiff.changes).length + Object.keys(configDiff.changes).length > 0;
  const invalid = (Object.keys(configDiff.changes) as string[]).filter(
    (k) => k in CONFIG_BOUNDS && !inBound(CONFIG_BOUNDS[k as ConfigBoundKey], configDiff.changes[k] as number),
  ) as ConfigBoundKey[];
  const overtimeAfterShift = c.overtimeAfterMin > c.driverShiftMaxMinutes;

  function save() {
    if (invalid.length) {
      toast.error(invalid.map((k) => `${SETTING_LABELS[k]} must be ${boundText(CONFIG_BOUNDS[k])}.`).join(' '));
      return;
    }
    if (overtimeAfterShift) {
      toast.error('Overtime after must be at most the driver shift maximum.');
      return;
    }
    startSave(async () => {
      const body: Record<string, unknown> = { expect: {} };
      if (Object.keys(tenantDiff.changes).length) {
        body.tenant = tenantDiff.changes;
        (body.expect as Record<string, unknown>).tenant = tenantDiff.expect;
      }
      if (Object.keys(configDiff.changes).length) {
        body.config = configDiff.changes;
        (body.expect as Record<string, unknown>).config = configDiff.expect;
      }
      let res: Response;
      try {
        res = await fetch('/api/tenant/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        toast.error('Could not reach the server. Nothing was saved.');
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(json, 'Save failed. Nothing was saved.'), { duration: 10_000 });
        return;
      }
      const saved = json?.data as (TenantFields & { config: Record<string, unknown> }) | undefined;
      if (saved?.config) {
        const next: Initial = {
          tenant: { name: saved.name, country: saved.country, currency: saved.currency, primaryUnit: saved.primaryUnit },
          config: Object.fromEntries(Object.keys(initial.config).map((k) => [k, saved.config[k]])) as unknown as EditableConfig,
        };
        setBaseline(next);
        setT(next.tenant);
        setC(next.config);
      }
      toast.success('Settings saved. The next optimization uses them.');
      router.refresh();
    });
  }

  const num = (k: ConfigBoundKey & keyof EditableConfig, label: string, opts: { step?: number; unit?: string; hint?: string } = {}) => (
    <NumField
      key={k}
      id={k}
      label={label}
      unit={opts.unit}
      value={c[k] as number}
      onChange={(v) => setC({ ...c, [k]: v })}
      step={opts.step}
      bound={CONFIG_BOUNDS[k]}
      hint={opts.hint}
      changed={k in configDiff.changes}
    />
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company</CardTitle>
          <CardDescription>Name, country and units.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tname">Company name</Label>
            <Input id="tname" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tcountry">Country</Label>
            <Select value={isListedCountry(t.country) ? t.country : undefined} onValueChange={(v) => setT({ ...t, country: v })}>
              <SelectTrigger id="tcountry" data-testid="country-select">
                <SelectValue placeholder={t.country ? `${t.country} (choose from the list)` : 'Choose a country'} />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_NAMES.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {!isListedCountry(t.country) && t.country ? `Saved as "${t.country}". ` : ''}
              {countryRoutingNote(t.country)}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tcurrency">Currency</Label>
            <Input id="tcurrency" value={t.currency} onChange={(e) => setT({ ...t, currency: e.target.value.toUpperCase() })} maxLength={5} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tunit">Primary unit</Label>
            <Select value={t.primaryUnit} onValueChange={(v) => setT({ ...t, primaryUnit: v as CapacityUnit })}>
              <SelectTrigger id="tunit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASES">Cases</SelectItem>
                <SelectItem value="CARTONS">Cartons</SelectItem>
                <SelectItem value="PALLETS">Pallets</SelectItem>
                <SelectItem value="KG">Kilograms</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Changes capacity column headers across the app. Existing data is not converted.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily dispatch: timing</CardTitle>
          <CardDescription>
            When trucks leave, how long a truck day may last, and how long loading, turnaround and unloading take. The planner times every load with
            these, so set them to what the depot and drivers really do.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <TimeField id="shiftStartMin" label="First departure" value={c.shiftStartMin} onChange={(v) => setC({ ...c, shiftStartMin: v })} hint="No truck leaves the depot before this time." changed={'shiftStartMin' in configDiff.changes} />
          {num('driverShiftMaxMinutes', 'Driver shift maximum', { step: 15, unit: 'min', hint: `First departure to last return of a truck (${hm(c.driverShiftMaxMinutes)} h).` })}
          {num('reloadMinutes', 'Turnaround between loads', { step: 5, unit: 'min', hint: 'Fixed time at the depot between two loads of a truck (paperwork, queue).' })}
          {num('loadingMinPerCase', 'Loading per case of the next load', { step: 0.01, unit: 'min', hint: 'Added to the turnaround: 0.04 = 44 min for 1,100 cases.' })}
          {num('serviceMinPerCase', 'Unloading per case', { step: 0.01, unit: 'min', hint: "Added to each customer's service time: 0.05 = 55 min for 1,100 cases." })}
          {num('defaultServiceTimeMin', 'Default service time', {
            step: 1,
            unit: 'min',
            hint: "For customers whose own time was never confirmed and whose customer type has none. A confirmed customer time always wins.",
          })}
          {num('maxTripsPerTruck', 'Max loads per truck per day', { step: 1, hint: "A truck's own limit (Trucks) wins when it has one." })}
          <ToggleField
            label="Split deliveries: a customer bigger than the largest truck is delivered in parts"
            value={c.splitDeliveries}
            onChange={(v) => setC({ ...c, splitDeliveries: v })}
          />
          <TimeField
            id="planningCutoffMin"
            label="Planning cutoff (the day before delivery)"
            value={c.planningCutoffMin}
            onChange={(v) => setC({ ...c, planningCutoffMin: v })}
            hint="Orders received after this time are LATE."
            changed={'planningCutoffMin' in configDiff.changes}
          />
          <div className="space-y-1.5">
            <Label htmlFor="dateOrder">Dates in order files</Label>
            <Select value={c.dateOrder} onValueChange={(v) => setC({ ...c, dateOrder: v })}>
              <SelectTrigger id="dateOrder">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DMY">Day/month/year (03/04/2026 = 3 April)</SelectItem>
                <SelectItem value="MDY">Month/day/year (03/04/2026 = 4 March)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily dispatch: costs</CardTitle>
          <CardDescription>
            What the planner minimizes and reports, in {cur}. The driver is paid for the whole truck day: first departure to last return, depot
            turnaround and waiting included. Truck costs (fixed per day, per load, per km, fuel economy) are set per truck under Trucks.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {num('driverCostPerHour', 'Driver cost per hour', { step: 0.1, unit: cur })}
          {num('overtimeAfterMin', 'Overtime after', { step: 15, unit: 'min', hint: `From the first departure (${hm(c.overtimeAfterMin)} h). At most the shift maximum.` })}
          {num('overtimeCostPerHour', 'Overtime cost per hour', { step: 0.1, unit: cur, hint: 'On top of the driver cost, for each hour after the overtime threshold.' })}
          {num('fuelPricePerLitre', 'Fuel price per litre', { step: 0.005, unit: cur, hint: '0 = fuel is not costed separately. Fuel use comes from each truck\'s km per litre.' })}
          {num('prefWindowPenaltyPerMin', 'Preferred-window penalty per minute', { step: 0.01, unit: cur, hint: 'Soft: the planner avoids arriving outside preferred hours. Hard windows are never broken.' })}
          {overtimeAfterShift ? (
            <p className="text-sm text-destructive md:col-span-2" role="alert">
              Overtime after ({hm(c.overtimeAfterMin)} h) is after the shift maximum ({hm(c.driverShiftMaxMinutes)} h): set it at most to the shift maximum.
            </p>
          ) : c.overtimeCostPerHour > 0 && c.overtimeAfterMin === c.driverShiftMaxMinutes ? (
            <p className="text-sm text-amber-700 md:col-span-2">Overtime starts at the shift maximum, so it is never reached.</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Distances</CardTitle>
          <CardDescription>
            Road distances come from the routing server (Oman + UAE map). Where a leg cannot be routed on roads, or with straight-line estimates, the
            km are labelled <strong>Estimated km</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dprov">Distances</Label>
            <Select value={c.distanceProvider} onValueChange={(v) => setC({ ...c, distanceProvider: v as EditableConfig['distanceProvider'] })}>
              <SelectTrigger id="dprov">
                <SelectValue placeholder={c.distanceProvider === 'MAPBOX_MATRIX' ? 'Mapbox (not used: planned on road distances) - choose' : undefined} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OSRM">Road distances (OSRM)</SelectItem>
                <SelectItem value="HAVERSINE">Straight-line estimates</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {num('roadTimeFactor', 'Road time factor (truck vs car)', { step: 0.05, unit: 'x', hint: 'Trucks are slower than the cars road routing times: 1.25 = 25% longer. Not applied to estimates.' })}
          {num('distanceMultiplier', 'Straight-line multiplier (estimates)', { step: 0.05, unit: 'x', hint: 'Straight line x this = estimated road km.' })}
          {num('avgSpeedKmh', 'Average speed (estimates)', { step: 1, unit: 'km/h' })}
        </CardContent>
      </Card>

      <div className="sticky bottom-2 z-10 flex items-center justify-end gap-3 rounded-md border bg-background/95 p-2 shadow-sm">
        <span className="text-xs text-muted-foreground" data-testid="settings-dirty">
          {dirty ? `${Object.keys(tenantDiff.changes).length + Object.keys(configDiff.changes).length} change(s) not saved` : 'No changes'}
        </span>
        <Button
          variant="outline"
          disabled={!dirty || pending}
          onClick={() => {
            setT(baseline.tenant);
            setC(baseline.config);
          }}
        >
          Undo changes
        </Button>
        <Button onClick={save} disabled={!dirty || pending || invalid.length > 0} data-testid="settings-save">
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Effective planner values</CardTitle>
          <CardDescription>
            What the next optimization uses, and where each value comes from: a setting above, a fixed planner rule, or an operations setting only
            the system maintainers change. Saved values show after saving.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="effective-values">
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th className="p-2">Planner input</th>
                <th className="p-2">Value</th>
                <th className="p-2">From</th>
              </tr>
            </thead>
            <tbody>
              {effective.map((r) => (
                <tr key={r.label} className="border-t align-top">
                  <td className="p-2 font-medium">{r.label}</td>
                  <td className="p-2">
                    {r.value}
                    {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                  </td>
                  <td className="p-2">
                    <Badge variant={r.source === 'SETTING' ? 'outline' : 'secondary'}>{SOURCE_TEXT[r.source]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer type defaults</CardTitle>
          <CardDescription>
            Used for customers whose own priority, unloading time or receiving hours were never confirmed. Read-only here; ask the system maintainers
            to change them.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {profiles.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No customer type defaults are set: the company defaults above apply.</p>
          ) : (
            <table className="w-full text-sm" data-testid="type-profiles">
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th className="p-2">Customer type</th>
                  <th className="p-2">Priority</th>
                  <th className="p-2">Unloading</th>
                  <th className="p-2">Receiving hours (hard)</th>
                  <th className="p-2">Preferred hours</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => (
                  <tr key={p.customerType} className="border-t">
                    <td className="p-2 font-medium">{p.customerType.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="p-2">{p.defaultPriority ? `P${p.defaultPriority}` : '—'}</td>
                    <td className="p-2">{p.serviceTimeMin !== null ? `${p.serviceTimeMin} min` : '—'}</td>
                    <td className="p-2">{hoursText(p.hardWindowStartMin, p.hardWindowEndMin)}</td>
                    <td className="p-2">{hoursText(p.prefWindowStartMin, p.prefWindowEndMin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function hm(min: number) {
  const m = Math.max(0, Math.round(min || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function hoursText(start: number | null, end: number | null) {
  return start === null && end === null ? '—' : `${start === null ? '…' : fmtHhmm(start)}–${end === null ? '…' : fmtHhmm(end)}`;
}

function NumField({
  id,
  label,
  value,
  onChange,
  step,
  hint,
  unit,
  bound,
  changed,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
  unit?: string;
  bound: Bound;
  changed?: boolean;
}) {
  const bad = !inBound(bound, value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {unit ? <span className="text-muted-foreground"> ({unit})</span> : null}
        {changed ? <span className="ml-1 text-xs text-blue-700">changed</span> : null}
      </Label>
      <Input
        id={id}
        type="number"
        step={step ?? 'any'}
        min={bound.min}
        max={bound.max}
        value={Number.isFinite(value) ? value : ''}
        aria-invalid={bad}
        className={bad ? 'border-destructive' : undefined}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
      <p className={`text-xs ${bad ? 'text-destructive' : 'text-muted-foreground'}`}>
        {hint ? `${hint} ` : ''}Allowed: {boundText(bound)}.
      </p>
    </div>
  );
}

function TimeField({ id, label, value, onChange, hint, changed }: { id: string; label: string; value: number; onChange: (v: number) => void; hint?: string; changed?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {changed ? <span className="ml-1 text-xs text-blue-700">changed</span> : null}
      </Label>
      <Input
        id={id}
        type="time"
        value={fmtHhmm(value)}
        onChange={(e) => {
          try {
            const v = parseHhmm(e.target.value);
            if (v !== null && v < 1440) onChange(v);
          } catch {
            // keep the last valid time while the field is being edited
          }
        }}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ToggleField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-sm">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}
