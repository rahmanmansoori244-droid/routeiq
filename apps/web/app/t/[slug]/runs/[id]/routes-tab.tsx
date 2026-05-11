'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtKm } from '@/lib/format';

export interface RouteRow {
  id: string;
  truckId: string;
  truckCode: string;
  sequence: number;
  plannedArrivalMin: number;
  plannedDistanceFromPrevKm: number;
  plannedLoadCases: number;
  customerCode: string;
  customerName: string;
  orderCases: number;
}

export function RoutesTab({ routes }: { routes: RouteRow[] }) {
  // Group by truckId so each truck gets its own table.
  const byTruck = useMemo(() => {
    const grouped = new Map<string, { truckCode: string; rows: RouteRow[] }>();
    for (const r of routes) {
      const list = grouped.get(r.truckId);
      if (list) list.rows.push(r);
      else grouped.set(r.truckId, { truckCode: r.truckCode, rows: [r] });
    }
    return Array.from(grouped.entries()).map(([truckId, v]) => ({ truckId, ...v }));
  }, [routes]);

  if (routes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No routes yet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Pick a scenario from the Scenarios tab to populate per-truck route assignments.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {byTruck.map((t) => {
        const totalCases = t.rows.reduce((a, r) => a + r.orderCases, 0);
        const totalKm = t.rows.reduce((a, r) => a + r.plannedDistanceFromPrevKm, 0);
        const finalArrival = t.rows[t.rows.length - 1]?.plannedArrivalMin ?? 0;
        return (
          <Card key={t.truckId}>
            <CardHeader>
              <CardTitle className="text-base">
                Truck {t.truckCode} —{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  {t.rows.length} stops · {totalCases} cases · {fmtKm(totalKm, true)} · last arrival {Math.round(finalArrival / 60 * 10) / 10}h
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">Seq</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Cases</TableHead>
                    <TableHead className="text-right">Load on truck</TableHead>
                    <TableHead className="text-right">From previous</TableHead>
                    <TableHead className="text-right">Arrival</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.sequence}</TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{r.customerCode}</span>
                        <span className="ms-2 text-sm">{r.customerName}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.orderCases}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.plannedLoadCases}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtKm(r.plannedDistanceFromPrevKm, true)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Math.floor(r.plannedArrivalMin / 60)}h{String(r.plannedArrivalMin % 60).padStart(2, '0')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
