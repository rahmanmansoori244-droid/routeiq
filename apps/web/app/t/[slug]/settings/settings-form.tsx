'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { CapacityUnit, DistanceProvider, TenantConfig } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/error-message';

interface Initial {
  tenant: { name: string; country: string; currency: string; primaryUnit: CapacityUnit };
  config: TenantConfig;
}

export function SettingsForm({ initial }: { initial: Initial }) {
  const router = useRouter();
  const [pending, startSave] = useTransition();
  const [t, setT] = useState(initial.tenant);
  const [c, setC] = useState<TenantConfig>(initial.config);

  function save() {
    startSave(async () => {
      const res = await fetch('/api/tenant/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant: t,
          config: {
            avgSpeedKmh: c.avgSpeedKmh,
            distanceProvider: c.distanceProvider,
            distanceMultiplier: c.distanceMultiplier,
            labelEstimatedDistances: c.labelEstimatedDistances,
            driverShiftMaxMinutes: c.driverShiftMaxMinutes,
            returnToDepot: c.returnToDepot,
            defaultServiceTimeMin: c.defaultServiceTimeMin,
            costPerKmDefault: c.costPerKmDefault,
            fixedTruckCostPerDayDefault: c.fixedTruckCostPerDayDefault,
            latePenaltyPerMin: c.latePenaltyPerMin,
            underutilizationPenalty: c.underutilizationPenalty,
            solverTimeLimitSeconds: c.solverTimeLimitSeconds,
            weightObjectiveTrucks: c.weightObjectiveTrucks,
            weightObjectiveDistance: c.weightObjectiveDistance,
            weightObjectiveCost: c.weightObjectiveCost,
            weightObjectiveBalance: c.weightObjectiveBalance,
            weightObjectiveUtilization: c.weightObjectiveUtilization,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Save failed.'));
        return;
      }
      toast.success('Settings saved');
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Company</CardTitle>
          <CardDescription>Tenant identity and default units.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="tname">Company name</Label>
            <Input id="tname" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tcountry">Country</Label>
            <Input id="tcountry" value={t.country} onChange={(e) => setT({ ...t, country: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tcurrency">Currency</Label>
            <Input
              id="tcurrency"
              value={t.currency}
              onChange={(e) => setT({ ...t, currency: e.target.value.toUpperCase() })}
              maxLength={5}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tunit">Primary unit</Label>
            <Select
              value={t.primaryUnit}
              onValueChange={(v) => setT({ ...t, primaryUnit: v as CapacityUnit })}
            >
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
            <p className="text-xs text-muted-foreground">
              Changes capacity column headers across the app. Existing data is not converted.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operations</CardTitle>
          <CardDescription>Driver shift, depot policy, and default service time.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumField label="Average speed (km/h)" value={c.avgSpeedKmh} onChange={(v) => setC({ ...c, avgSpeedKmh: v })} step={1} />
          <NumField
            label="Driver shift max (minutes)"
            value={c.driverShiftMaxMinutes}
            onChange={(v) => setC({ ...c, driverShiftMaxMinutes: Math.round(v) })}
            step={15}
          />
          <NumField
            label="Default service time (min)"
            value={c.defaultServiceTimeMin}
            onChange={(v) => setC({ ...c, defaultServiceTimeMin: Math.round(v) })}
            step={1}
          />
          <ToggleField
            label="Return to depot at end of day"
            value={c.returnToDepot}
            onChange={(v) => setC({ ...c, returnToDepot: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Distance estimation</CardTitle>
          <CardDescription>
            OSRM plans on real road distances from the self-hosted routing server (Oman + UAE map). With
            Haversine, outside that map, or when the routing server is unreachable, distances are straight-line × multiplier and every km display reads{' '}
            <strong>Estimated km</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dprov">Distance provider</Label>
            <Select
              value={c.distanceProvider}
              onValueChange={(v) => setC({ ...c, distanceProvider: v as DistanceProvider })}
            >
              <SelectTrigger id="dprov">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OSRM">OSRM (real road distance, self-hosted)</SelectItem>
                <SelectItem value="HAVERSINE">Haversine (straight-line estimate)</SelectItem>
                <SelectItem value="MAPBOX_MATRIX">
                  Mapbox Matrix (old planner only — the dispatch planner uses OSRM instead)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <NumField
            label="Distance multiplier"
            value={c.distanceMultiplier}
            onChange={(v) => setC({ ...c, distanceMultiplier: v })}
            step={0.05}
            hint="1.3 is a sensible default for mixed urban/highway. City centers want 1.4-1.5."
          />
          <ToggleField
            label='Label kilometers as "Estimated km"'
            value={c.labelEstimatedDistances}
            onChange={(v) => setC({ ...c, labelEstimatedDistances: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Costs and penalties</CardTitle>
          <CardDescription>Defaults applied to trucks that don't override these.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumField
            label={`Default per-km cost (${t.currency})`}
            value={c.costPerKmDefault}
            onChange={(v) => setC({ ...c, costPerKmDefault: v })}
            step={0.01}
          />
          <NumField
            label={`Default fixed truck cost/day (${t.currency})`}
            value={c.fixedTruckCostPerDayDefault}
            onChange={(v) => setC({ ...c, fixedTruckCostPerDayDefault: v })}
            step={1}
          />
          <NumField
            label="Late penalty per minute"
            value={c.latePenaltyPerMin}
            onChange={(v) => setC({ ...c, latePenaltyPerMin: v })}
            step={0.1}
            hint="v1 stores time windows as metadata only; this kicks in for v2 hard windows."
          />
          <NumField
            label="Under-utilization penalty"
            value={c.underutilizationPenalty}
            onChange={(v) => setC({ ...c, underutilizationPenalty: v })}
            step={1}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solver</CardTitle>
          <CardDescription>
            Time limit auto-scales with stop count up to 120s. This is the floor.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumField
            label="Solver time limit (seconds)"
            value={c.solverTimeLimitSeconds}
            onChange={(v) => setC({ ...c, solverTimeLimitSeconds: Math.round(v) })}
            step={5}
          />
          <NumField
            label="Weight: minimize trucks"
            value={c.weightObjectiveTrucks}
            onChange={(v) => setC({ ...c, weightObjectiveTrucks: v })}
            step={10}
          />
          <NumField
            label="Weight: minimize distance"
            value={c.weightObjectiveDistance}
            onChange={(v) => setC({ ...c, weightObjectiveDistance: v })}
            step={1}
          />
          <NumField
            label="Weight: minimize cost"
            value={c.weightObjectiveCost}
            onChange={(v) => setC({ ...c, weightObjectiveCost: v })}
            step={1}
          />
          <NumField
            label="Weight: balance loads"
            value={c.weightObjectiveBalance}
            onChange={(v) => setC({ ...c, weightObjectiveBalance: v })}
            step={1}
          />
          <NumField
            label="Weight: maximize utilization"
            value={c.weightObjectiveUtilization}
            onChange={(v) => setC({ ...c, weightObjectiveUtilization: v })}
            step={1}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        step={step ?? 'any'}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-sm">{label}</span>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}
