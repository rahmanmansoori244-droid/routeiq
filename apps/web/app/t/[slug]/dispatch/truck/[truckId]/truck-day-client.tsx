'use client';

/**
 * One truck's day on screen (owner request 18 Oct 2026): the header (truck, date picker of the dates with
 * a load, its loads and drivers, the live status), the map (depot, stops by result, the GPS trail, the
 * live position), and the timeline - the core: what the truck did, in order, with who recorded each
 * time. "Open Ayun" opens the provider's own site in a new tab (no link to one vehicle exists there, and
 * nothing is passed to it); "Back to the plan" opens the day screen of the date. Everything comes from
 * GET /api/ivms/trucks/[id]/day (lib/ivms/truck-day.ts builds it); this file only lays it out.
 */
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, MapPin, RefreshCw, Truck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { zonedDayStart } from '@/lib/dispatch/time';
import { dateLabel, datePicker, loadStatusWord, RESULT_COLOR, timeOnDay, truckDayHref, truckDayScreen, type TimelineItem, type TimelineTone, type TruckDayModel } from '@/lib/ivms/truck-day';
import { useTruckDay } from './use-truck-day';

const TruckDayMap = dynamic(() => import('@/components/truck-day-map').then((m) => m.TruckDayMap), { ssr: false });

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'warning' | 'success' | 'default'> = {
  PLANNED: 'outline',
  LOCKED: 'secondary',
  LOADING: 'warning',
  DISPATCHED: 'success',
  COMPLETED: 'default',
};

const TONE: Record<TimelineTone, string> = {
  ok: 'border-l-green-600',
  warn: 'border-l-amber-500',
  bad: 'border-l-red-600',
  info: 'border-l-blue-500',
  muted: 'border-l-slate-300 opacity-80',
};

export function TruckDayClient({ slug, truckId, initialDate }: { slug: string; truckId: string; initialDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const { data, error, loading, reload } = useTruckDay(truckId, date);
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);

  const pick = (d: string) => {
    if (d === date) return;
    setDate(d);
    setFocus(null);
    // The address follows the date: the page can be bookmarked and reloaded on it.
    router.replace(truckDayHref(slug, truckId, d), { scroll: false });
  };

  // What to show for the date picked (lib/ivms/truck-day.ts truckDayScreen; review of 18 Oct 2026): another
  // date's day still held is never shown as this one, a failed read stops "Loading..." and offers "Try again".
  const screen = truckDayScreen({ data, error, loading }, date);
  const failure = screen.message ? (
    <div className="flex flex-wrap items-center gap-2" data-testid="truck-day-error">
      <p className={`text-sm ${screen.show === 'DAY' ? 'text-amber-700' : 'text-red-700'}`} role="alert">
        {screen.message}
      </p>
      {screen.retry ? (
        <Button size="sm" variant="outline" onClick={reload} data-testid="truck-day-retry">
          <RefreshCw className="mr-1 h-4 w-4" /> Try again
        </Button>
      ) : null}
    </div>
  ) : null;

  if (!data) return failure ?? <p className="text-sm text-muted-foreground">Loading the truck's day...</p>;

  const shownIsDate = screen.show === 'DAY';
  return (
    <div className="space-y-4" data-testid="truck-day">
      <Header model={data} slug={slug} date={date} onPick={pick} loading={screen.loading} dayShown={shownIsDate} />
      {failure}
      {shownIsDate ? (
        <>
          <Card>
            <CardContent className="space-y-2 p-3">
              <TruckDayMap model={data} focus={focus} />
              <MapLegend model={data} />
            </CardContent>
          </Card>
          <Timeline model={data} onFocus={setFocus} />
        </>
      ) : null}
    </div>
  );
}

/**
 * The truck, the buttons, the date picker; and, only when `dayShown` (the model is the date picked's day),
 * the loads, the summary, the live status and the notes: another date's day still held while the date
 * picked is read (or after its read failed) gives the truck and the date picker only.
 */
function Header({ model, slug, date, onPick, loading, dayShown }: { model: TruckDayModel; slug: string; date: string; onPick: (d: string) => void; loading: boolean; dayShown: boolean }) {
  const picker = datePicker(model.dates, date);
  const dayStart = zonedDayStart(model.date, model.tz);
  const firstDepot = dayShown ? (model.loads[0]?.depotId ?? null) : null;
  const planHref = `/t/${slug}/dispatch?date=${date}${firstDepot ? `&depot=${encodeURIComponent(firstDepot)}` : ''}`;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 py-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base" data-testid="truck-day-title">
            <Truck className="h-5 w-5" /> {model.truck.code}
            {model.truck.hired ? (
              <Badge variant="outline" className="text-[10px]">
                {model.truck.oneDay ? 'hired · 1 day' : 'hired'}
              </Badge>
            ) : null}
          </CardTitle>
          {model.truck.description ? <p className="text-sm text-muted-foreground">{model.truck.description}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={model.ayunUrl} target="_blank" rel="noopener noreferrer" title="Ayun's own site, in a new tab: sign in there and pick the truck (Ayun has no link to one vehicle)" data-testid="open-ayun">
              <ExternalLink className="mr-1 h-4 w-4" /> Open Ayun
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={planHref} data-testid="back-to-plan">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to the plan
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pb-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" className="h-8 px-2" disabled={!picker.older} onClick={() => picker.older && onPick(picker.older)} title="The day before with a load" aria-label="The day before with a load">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <label className="sr-only" htmlFor="truck-day-date">
            Day
          </label>
          <select
            id="truck-day-date"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={date}
            onChange={(e) => onPick(e.target.value)}
            data-testid="truck-day-date"
          >
            {picker.options.map((d) => (
              <option key={d} value={d}>
                {dateLabel(d, model.today)}
                {model.dates.includes(d) ? '' : ' - no load'}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" className="h-8 px-2" disabled={!picker.newer} onClick={() => picker.newer && onPick(picker.newer)} title="The next day with a load" aria-label="The next day with a load">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {loading ? <span className="text-xs text-muted-foreground">Loading...</span> : null}
        </div>
        {dayShown ? <DaySummary model={model} dayStart={dayStart} /> : null}
      </CardContent>
    </Card>
  );
}

/** The loads, the summary, the live status, the GPS facts and notes of the day shown. */
function DaySummary({ model, dayStart }: { model: TruckDayModel; dayStart: Date }) {
  const s = model.summary;
  return (
    <>
      {model.loads.length ? (
        <ul className="space-y-1" data-testid="truck-day-loads">
          {model.loads.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[l.status] ?? 'outline'}>
                L{l.loadNo} · {loadStatusWord(l.status)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {timeOnDay(l.departAt, dayStart, model.tz)}-{timeOnDay(l.returnAt, dayStart, model.tz)} · {l.done} of {l.stops} stops done · driver{' '}
                {l.driverName ? `${l.driverName}${l.driverCasual ? ' (daily)' : ''}` : 'none'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No load for this truck on {dateLabel(model.date, model.today)}.</p>
      )}

      {s.stops ? (
        <p className="text-xs" data-testid="truck-day-summary">
          {s.stops} stop{s.stops === 1 ? '' : 's'}: <span className="text-green-700">{s.delivered} delivered</span>
          {s.partly ? <span className="text-amber-700">, {s.partly} partly</span> : null}
          {s.notDelivered ? <span className="text-red-700">, {s.notDelivered} not delivered</span> : null}
          {s.pending ? <span className="text-muted-foreground">, {s.pending} without a result</span> : null}
        </p>
      ) : null}

      {model.live ? (
        <p className={`flex items-start gap-1 text-sm ${model.live.stale ? 'text-amber-700' : ''}`} data-testid="truck-day-live">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" /> {model.live.text}
        </p>
      ) : null}
      {model.gps.facts.map((f, k) => (
        <p key={`f${k}`} className="text-xs text-amber-700">
          {f}
        </p>
      ))}
      {model.gps.notes.map((n, k) => (
        <p key={`n${k}`} className="text-xs text-muted-foreground" data-testid="truck-day-note">
          {n}
        </p>
      ))}
    </>
  );
}

function MapLegend({ model }: { model: TruckDayModel }) {
  const dayStart = zonedDayStart(model.date, model.tz);
  const dot = (color: string) => <span className="inline-block h-3 w-3 rounded-full border border-white" style={{ background: color }} />;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1">{dot(RESULT_COLOR.DELIVERED)} delivered</span>
      <span className="flex items-center gap-1">{dot(RESULT_COLOR.PARTLY_DELIVERED)} partly</span>
      <span className="flex items-center gap-1">{dot(RESULT_COLOR.NOT_DELIVERED)} not delivered</span>
      <span className="flex items-center gap-1">{dot(RESULT_COLOR.PENDING)} no result yet</span>
      {model.gps.trail ? (
        <span className="flex items-center gap-1">
          <span className="inline-block h-1 w-5 rounded bg-blue-600" /> GPS trail ({model.trail.total} points
          {model.trail.from && model.trail.to
            ? `, ${timeOnDay(model.trail.from, dayStart, model.tz)}-${timeOnDay(model.trail.to, dayStart, model.tz)}`
            : ''}
          )
        </span>
      ) : null}
      {model.live ? <span>The dark label is the truck now.</span> : null}
    </div>
  );
}

function Timeline({ model, onFocus }: { model: TruckDayModel; onFocus: (p: { lat: number; lng: number } | null) => void }) {
  const dayStart = useMemo(() => zonedDayStart(model.date, model.tz), [model.date, model.tz]);
  const t = (x: string) => timeOnDay(x, dayStart, model.tz);
  const pinOf = (item: TimelineItem) => {
    if ((item.kind !== 'STOP' && item.kind !== 'GPS_VISIT') || item.loadNo === null) return null;
    const s = model.stops.find((x) => x.loadNo === item.loadNo && x.sequence === item.sequence);
    return s && s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : null;
  };
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">What the truck did ({model.timeline.length})</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {model.timeline.length ? (
          <ol className="space-y-2" data-testid="truck-day-timeline">
            {model.timeline.map((item) => {
              const pin = pinOf(item);
              return (
                <li key={item.key} className={`rounded-md border border-l-4 p-2 ${TONE[item.tone]}`} data-testid={`timeline-${item.kind}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="w-20 shrink-0 font-mono text-sm" title={item.at ? 'When it happened' : 'The planned time: it has not happened (yet)'}>
                      {item.at ? t(item.at) : <span className="text-muted-foreground">{item.plannedAt ? `(${t(item.plannedAt)})` : '--:--'}</span>}
                    </span>
                    {item.loadNo !== null ? (
                      <Badge variant="outline" className="text-[10px]">
                        L{item.loadNo}
                      </Badge>
                    ) : null}
                    {pin ? (
                      <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={() => onFocus(pin)} title="Show on the map">
                        {item.title}
                      </button>
                    ) : (
                      <span className="font-medium">{item.title}</span>
                    )}
                    {item.source ? <span className="text-xs text-muted-foreground">by {item.source}</span> : null}
                  </div>
                  {item.lines.length ? (
                    <ul className="mt-1 space-y-0.5 pl-[5.5rem] text-xs text-muted-foreground">
                      {item.lines.map((x, k) => (
                        <li key={k}>{x}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing planned or recorded for this truck on this day.</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Times in brackets are planned: that has not happened (yet).</p>
      </CardContent>
    </Card>
  );
}
