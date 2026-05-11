'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface TrendRow {
  date: string;
  runCount: number;
  trucksUsed: number;
  distanceKm: number;
  cost: number;
  ordersServed: number;
}

const SERIES = [
  { key: 'trucksUsed', label: 'Trucks used', color: '#2563EB' },
  { key: 'distanceKm', label: 'Distance', color: '#16A34A' },
  { key: 'ordersServed', label: 'Orders served', color: '#D97706' },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

export function TrendChart({ data, kmLabel }: { data: TrendRow[]; kmLabel: string }) {
  const [active, setActive] = useState<SeriesKey>('trucksUsed');
  const totalRuns = data.reduce((a, r) => a + r.runCount, 0);

  if (totalRuns === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No completed runs in the last 30 days. Run an optimization to start the trend.
      </div>
    );
  }

  // Format X-axis label compactly: MM-DD
  const formatted = data.map((d) => ({ ...d, dateShort: d.date.slice(5) }));
  const activeSpec = SERIES.find((s) => s.key === active)!;
  const yLabel = active === 'distanceKm' ? kmLabel : activeSpec.label;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {SERIES.map((s) => (
          <Button
            key={s.key}
            variant={active === s.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActive(s.key)}
          >
            <span className="me-1.5 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.key === 'distanceKm' ? kmLabel : s.label}
          </Button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        {active === 'trucksUsed' ? (
          <BarChart data={formatted} margin={{ top: 10, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="dateShort" tick={{ fontSize: 11 }} interval={2} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }} />
            <Tooltip
              cursor={{ fill: '#F1F5F9' }}
              labelFormatter={(label, payload) => (payload?.[0]?.payload as TrendRow | undefined)?.date ?? label}
              formatter={(v: number) => v.toLocaleString()}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="trucksUsed" name="Trucks used" fill={activeSpec.color} radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={formatted} margin={{ top: 10, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis dataKey="dateShort" tick={{ fontSize: 11 }} interval={2} />
            <YAxis tick={{ fontSize: 11 }} label={{ value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }} />
            <Tooltip
              labelFormatter={(label, payload) => (payload?.[0]?.payload as TrendRow | undefined)?.date ?? label}
              formatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey={active} name={active === 'distanceKm' ? kmLabel : activeSpec.label} stroke={activeSpec.color} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
