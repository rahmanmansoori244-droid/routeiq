'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, ArrowDown, ArrowUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtKm } from '@/lib/format';
import type { ScenarioCardData } from './scenario-cards';
import { errorMessage } from '@/lib/error-message';

export interface BaselineRow {
  id: string;
  fileName: string | null;
  createdAt: string;
  totalTrucks: number;
  totalDistanceKm: number | null;
  totalTimeMin: number | null;
  assignmentCount: number;
}

interface Props {
  slug: string;
  runId: string;
  baselines: BaselineRow[];
  canUpload: boolean;
  chosenScenario: ScenarioCardData | null;
}

export function BaselineTab({ slug, runId, baselines, canUpload, chosenScenario }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [pending, startUpload] = useTransition();
  void slug;

  function submit() {
    if (!file) {
      toast.error('Pick a file first.');
      return;
    }
    startUpload(async () => {
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch(`/api/runs/${runId}/baseline`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Upload failed.'));
        return;
      }
      toast.success(`Baseline uploaded — ${body.data.totalTrucks} trucks, ${body.data.assignments} stops.`);
      setFile(null);
      router.refresh();
    });
  }

  const latest = baselines[0] ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload manual baseline</CardTitle>
          <CardDescription>
            Columns: <code className="text-xs">truck_code, customer_code, branch_code?, sequence?, cases?, manual_distance_km?, manual_time_min?</code>.
            One row per (truck, customer) stop in the planner's manual allocation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            disabled={!canUpload}
            className="block text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file ? <p className="text-xs text-muted-foreground">Selected: {file.name}</p> : null}
          <div>
            <Button disabled={!file || pending || !canUpload} onClick={submit}>
              <Upload className="me-2 h-4 w-4" />
              {pending ? 'Uploading…' : 'Upload baseline'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {latest && chosenScenario ? <ComparisonCard baseline={latest} scenario={chosenScenario} /> : null}

      {baselines.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Past uploads</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Trucks</TableHead>
                  <TableHead className="text-right">Distance</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="text-right">Stops</TableHead>
                  <TableHead>Uploaded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {baselines.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.fileName ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.totalTrucks}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.totalDistanceKm !== null ? fmtKm(b.totalDistanceKm, true) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {b.totalTimeMin !== null ? `${(b.totalTimeMin / 60).toFixed(1)}h` : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.assignmentCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(b.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ComparisonCard({ baseline, scenario }: { baseline: BaselineRow; scenario: ScenarioCardData }) {
  const truckDelta = scenario.trucksUsed - baseline.totalTrucks;
  const distanceDelta =
    baseline.totalDistanceKm !== null ? scenario.totalDistanceKm - baseline.totalDistanceKm : null;
  const truckPct = baseline.totalTrucks > 0 ? (truckDelta / baseline.totalTrucks) * 100 : 0;
  const distancePct =
    baseline.totalDistanceKm && baseline.totalDistanceKm > 0
      ? ((scenario.totalDistanceKm - baseline.totalDistanceKm) / baseline.totalDistanceKm) * 100
      : null;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="text-base">Optimized vs Manual</CardTitle>
        <CardDescription>
          Comparing the chosen scenario ({scenario.name}) against the most recent baseline.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Compare label="Trucks" before={baseline.totalTrucks.toString()} after={scenario.trucksUsed.toString()} delta={truckDelta} deltaPct={truckPct} smallerIsBetter />
        <Compare
          label="Distance"
          before={baseline.totalDistanceKm !== null ? fmtKm(baseline.totalDistanceKm, true) : '—'}
          after={fmtKm(scenario.totalDistanceKm, true)}
          delta={distanceDelta}
          deltaPct={distancePct}
          smallerIsBetter
          isKm
        />
        <Compare
          label="Utilization"
          before="—"
          after={`${scenario.avgUtilizationPct.toFixed(1)}%`}
          delta={null}
          deltaPct={null}
          smallerIsBetter={false}
        />
      </CardContent>
    </Card>
  );
}

function Compare({
  label,
  before,
  after,
  delta,
  deltaPct,
  smallerIsBetter,
  isKm,
}: {
  label: string;
  before: string;
  after: string;
  delta: number | null;
  deltaPct: number | null;
  smallerIsBetter: boolean;
  isKm?: boolean;
}) {
  const sign = delta === null ? null : delta === 0 ? null : delta > 0 ? '+' : '';
  const isImprovement = delta === null ? null : smallerIsBetter ? delta < 0 : delta > 0;
  const arrow = isImprovement === null ? null : isImprovement ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />;
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{after}</div>
      <div className="text-xs text-muted-foreground">Manual: {before}</div>
      {delta !== null ? (
        <Badge variant={isImprovement ? 'success' : 'destructive'} className="text-xs">
          {arrow}
          {sign}{isKm ? fmtKm(Math.abs(delta), true) : Math.abs(delta).toFixed(isImprovement ? 1 : 0)}
          {deltaPct !== null ? ` (${sign}${deltaPct.toFixed(1)}%)` : ''}
        </Badge>
      ) : null}
    </div>
  );
}
