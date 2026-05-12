'use client';

import { Check, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtMoney, fmtKm } from '@/lib/format';

export interface ScenarioCardData {
  id: string;
  name: string;
  trucksUsed: number;
  totalDistanceKm: number;
  totalTimeMin: number;
  totalCost: number;
  avgUtilizationPct: number;
  unservedCount: number;
  unservedOrders: Array<{
    reasonCode: string;
    reasonMessage: string | null;
    order: { id: string; customerCode: string; customerName: string; cases: number };
  }>;
}

interface Props {
  scenarios: ScenarioCardData[];
  chosenScenarioId: string | null;
  canPick: boolean;
  onPick: (scenarioId: string) => void;
  currency: string;
}

const NAME_LABEL: Record<string, string> = {
  MIN_TRUCKS: 'Min trucks',
  MIN_DISTANCE: 'Min distance',
  BALANCED: 'Balanced',
};

export function ScenarioCards({ scenarios, chosenScenarioId, canPick, onPick, currency }: Props) {
  // Decide which scenario is "best" for each KPI to highlight the winners.
  const bestTrucks = Math.min(...scenarios.map((s) => s.trucksUsed));
  const bestDistance = Math.min(...scenarios.map((s) => s.totalDistanceKm));
  const bestCost = Math.min(...scenarios.map((s) => s.totalCost));
  const bestUtil = Math.max(...scenarios.map((s) => s.avgUtilizationPct));

  // Detect when all returned scenarios converged to the same plan — usually
  // means capacity is the binding constraint and the objective tradeoffs
  // don't matter. Without this hint, three identical cards look like a bug.
  const converged =
    scenarios.length > 1 &&
    scenarios.every(
      (s) =>
        s.trucksUsed === scenarios[0].trucksUsed &&
        Math.abs(s.totalDistanceKm - scenarios[0].totalDistanceKm) < 0.01 &&
        s.unservedCount === scenarios[0].unservedCount,
    );

  return (
    <div className="space-y-3">
    {converged && (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>All three scenarios converged to the same plan.</strong> This usually means demand is at or above
        your effective fleet capacity — the solver has no slack to trade trucks-used against distance. Free up
        capacity (more trucks, larger trucks, or fewer/smaller orders) to see the objectives diverge.
      </div>
    )}
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {scenarios.map((s) => {
        const isChosen = s.id === chosenScenarioId;
        const reasonBreakdown = aggregateReasons(s.unservedOrders);
        return (
          <Card key={s.id} className={isChosen ? 'border-primary' : undefined}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{NAME_LABEL[s.name] ?? s.name}</CardTitle>
                {isChosen ? <Badge variant="success"><Check className="me-1 h-3 w-3" />Chosen</Badge> : null}
              </div>
              <CardDescription>
                {s.trucksUsed} truck{s.trucksUsed === 1 ? '' : 's'} · {s.unservedCount} unserved
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Kpi label="Trucks" value={s.trucksUsed.toString()} winner={s.trucksUsed === bestTrucks} />
              <Kpi label="Distance" value={fmtKm(s.totalDistanceKm, true)} winner={s.totalDistanceKm === bestDistance} />
              <Kpi label="Time" value={`${(s.totalTimeMin / 60).toFixed(1)} h`} />
              <Kpi label="Cost" value={fmtMoney(s.totalCost, currency)} winner={s.totalCost === bestCost} />
              <Kpi label="Avg utilization" value={`${s.avgUtilizationPct.toFixed(1)}%`} winner={s.avgUtilizationPct === bestUtil} />
              {s.unservedCount > 0 ? (
                <div className="mt-3 rounded-md bg-muted/50 p-2 text-xs">
                  <p className="mb-1 font-medium">Unserved breakdown:</p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {Object.entries(reasonBreakdown).map(([reason, count]) => (
                      <li key={reason}>
                        <span className="font-mono">{count}×</span> {reason.toLowerCase().replace(/_/g, ' ')}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
            <CardFooter className="pt-0">
              {canPick ? (
                <Button className="w-full" onClick={() => onPick(s.id)} disabled={isChosen}>
                  {isChosen ? 'Selected' : 'Pick this scenario'}
                </Button>
              ) : null}
            </CardFooter>
          </Card>
        );
      })}
    </div>
    </div>
  );
}

function Kpi({ label, value, winner }: { label: string; value: string; winner?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 font-medium tabular-nums">
        {value}
        {winner ? <Trophy className="h-3.5 w-3.5 text-amber-500" /> : null}
      </span>
    </div>
  );
}

function aggregateReasons(unserved: ScenarioCardData['unservedOrders']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of unserved) counts[u.reasonCode] = (counts[u.reasonCode] ?? 0) + 1;
  return counts;
}
