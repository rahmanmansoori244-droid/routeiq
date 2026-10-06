import { CalendarOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtDayMonth } from '@/lib/dispatch/time';

/** One period of the "Drivers on leave" list (today and the coming days). */
export interface UpcomingLeave {
  id: string;
  driverId: string;
  driverName: string;
  from: string;
  until: string;
  /** On leave today. */
  now: boolean;
  note: string | null;
  coverName: string | null;
}

/** "Drivers on leave": who is away today and in the coming `days` days, the soonest first. */
export function LeaveList({ items, days }: { items: UpcomingLeave[]; days: number }) {
  return (
    <Card data-testid="drivers-on-leave">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarOff className="h-4 w-4 text-primary" />
          Drivers on leave (today and the coming {days} days)
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {items.length === 0 ? (
          <p className="text-muted-foreground">Nobody is on leave today or in the coming {days} days. Add leave with the Leave button of a driver.</p>
        ) : (
          <ul className="divide-y">
            {items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="font-medium">{p.driverName}</span>
                {p.now ? <Badge variant="warning">On leave now</Badge> : <Badge variant="outline">From {fmtDayMonth(p.from)}</Badge>}
                <span className="text-muted-foreground">
                  {fmtDayMonth(p.from)} – {fmtDayMonth(p.until)}
                </span>
                <span>{p.coverName ? `Cover: ${p.coverName}` : 'No cover named'}</span>
                {p.note ? <span className="text-muted-foreground">· {p.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
