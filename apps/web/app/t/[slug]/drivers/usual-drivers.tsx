'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/error-message';
import { onLeaveLabel } from '@/lib/dispatch/driver-leave';
import type { DriverOption } from './leave-dialog';

/** An active truck and its usual (default) driver. */
export interface UsualTruck {
  id: string;
  code: string;
  description: string | null;
  depotCode: string;
  hired: boolean;
  defaultDriverId: string | null;
  /** The usual driver is on leave today: until when, and his cover. */
  awayUntil: string | null;
  coverName: string | null;
  /** Why that cover will not drive today (inactive, away himself, another truck's usual driver: coverCaveat); null: he covers. */
  coverCaveat?: string | null;
}

/**
 * "Usual driver of each truck" (owner request 6 Oct 2026): the dispatcher (PLANNER and up) sets or
 * clears a truck's usual driver - the only truck field he may change (PATCH /api/trucks/[id] with
 * defaultDriverId alone). New plans put the usual driver on the truck's loads; while he is on leave,
 * his cover. The other truck fields stay on the Trucks page (company admin).
 */
export function UsualDrivers({ trucks, drivers, canEdit }: { trucks: UsualTruck[]; drivers: DriverOption[]; canEdit: boolean }) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const nameOf = new Map(drivers.map((d) => [d.id, d.name]));

  function save(t: UsualTruck, driverId: string | null) {
    setBusy(t.id);
    startSave(async () => {
      const res = await fetch(`/api/trucks/${t.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultDriverId: driverId }),
      });
      const body = await res.json().catch(() => ({}));
      setBusy(null);
      if (!res.ok) {
        toast.error(errorMessage(body, 'Could not change the usual driver.'));
        return;
      }
      // A re-plan keeps the driver RouteIQ already gave a trip (only a cover goes): plans already made
      // change only where the dispatcher picks the driver (planDrivers; review of 6 Oct 2026).
      toast.success(
        `${t.code}: usual driver ${driverId ? (nameOf.get(driverId) ?? 'set') : 'cleared'}. New plans use it. Plans already made keep their drivers, also when you re-plan: pick the driver on those loads.`,
        { duration: 10_000 },
      );
      router.refresh();
    });
  }

  return (
    <Card data-testid="usual-drivers">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-4 w-4 text-primary" />
          Usual driver of each truck
        </CardTitle>
        <CardDescription>
          New plans put the usual driver on the truck&apos;s loads; while he is on leave, the cover driver of his leave. A driver you pick on a load
          stays.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {trucks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active trucks.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Truck</TableHead>
                <TableHead>Depot</TableHead>
                <TableHead>Usual driver</TableHead>
                <TableHead>Today</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trucks.map((t) => {
                // Active drivers, plus the current one if he was deactivated since.
                const options = drivers.filter((d) => d.active || d.id === t.defaultDriverId);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">
                      {t.code}
                      {t.hired ? (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          hired
                        </Badge>
                      ) : null}
                      {t.description ? <span className="ml-2 font-sans text-muted-foreground">{t.description}</span> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.depotCode}</TableCell>
                    <TableCell>
                      <select
                        className="h-8 w-48 rounded-md border bg-background px-1 text-sm disabled:opacity-70"
                        value={t.defaultDriverId ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => save(t, e.target.value || null)}
                        aria-label={`Usual driver of ${t.code}`}
                        data-testid={`usual-driver-${t.code}`}
                      >
                        <option value="">No usual driver</option>
                        {options.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                            {d.casual ? ' (daily)' : ''}
                            {d.active ? '' : ' (inactive)'}
                          </option>
                        ))}
                      </select>
                      {busy === t.id ? <span className="ml-2 text-xs text-muted-foreground">Saving…</span> : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {t.awayUntil ? (
                        <span className="text-amber-700">
                          {nameOf.get(t.defaultDriverId ?? '') ?? 'The usual driver'} is {onLeaveLabel(t.awayUntil)}:{' '}
                          {!t.coverName
                            ? 'no cover - pick the driver on the plan'
                            : t.coverCaveat
                              ? `cover ${t.coverName} (${t.coverCaveat})`
                              : `${t.coverName} covers`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
