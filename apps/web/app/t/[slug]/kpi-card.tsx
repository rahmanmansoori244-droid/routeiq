import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  value: string;
  previousLabel: string;
  currentValue: number | null;
  previousValue: number | null;
  smallerIsBetter: boolean;
  decimals?: number;
  suffix?: string;
}

export function KpiCard({
  label,
  value,
  previousLabel,
  currentValue,
  previousValue,
  smallerIsBetter,
  decimals = 0,
  suffix = '',
}: Props) {
  const delta = currentValue !== null && previousValue !== null ? currentValue - previousValue : null;
  const pct =
    delta !== null && previousValue !== null && previousValue !== 0 ? (delta / previousValue) * 100 : null;
  const improvement = delta === null ? null : delta === 0 ? null : smallerIsBetter ? delta < 0 : delta > 0;

  const Arrow =
    improvement === null
      ? Minus
      : improvement
        ? smallerIsBetter
          ? ArrowDownRight
          : ArrowUpRight
        : smallerIsBetter
          ? ArrowUpRight
          : ArrowDownRight;

  const colorClass =
    improvement === null
      ? 'text-muted-foreground'
      : improvement
        ? 'text-green-700 bg-green-50'
        : 'text-destructive bg-destructive/5';

  return (
    <Card>
      <CardContent className="space-y-2 pt-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {delta !== null ? (
          <div className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs', colorClass)}>
            <Arrow className="h-3 w-3" />
            <span className="tabular-nums">
              {delta > 0 ? '+' : ''}
              {delta.toLocaleString('en-US', { maximumFractionDigits: decimals })}
              {suffix}
              {pct !== null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}
            </span>
            <span className="ms-1 text-muted-foreground">{previousLabel}</span>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">{previousLabel}</div>
        )}
      </CardContent>
    </Card>
  );
}
