import { notFound } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { shownTruckCode } from '@/lib/dispatch/hire';
import { DEFAULT_TZ, todayIso } from '@/lib/dispatch/time';
import { isIsoDate } from '@/lib/ivms/truck-day';
import { PageShell } from '@/components/page-shell';
import { TruckDayClient } from './truck-day-client';

export const metadata = { title: 'Truck day — RouteIQ' };
export const dynamic = 'force-dynamic';

/**
 * One truck's day (owner request 18 Oct 2026: "if i want to go through a history of a vehicle with one
 * button ... i click on [a truck] it takes me to where the truck is and what it was doing"): opened from the
 * truck code on the plan screen's "Truck · load" column, for the plan's date. A page, not a dialog, so it
 * can be bookmarked and opened in a new tab: /t/[slug]/dispatch/truck/[truckId]?date=YYYY-MM-DD (no date:
 * the company's today). The dispatcher (PLANNER) and up, like the live trucks on the day screen
 * (positions of people at work); another company's truck, or no such truck, is a 404 and nothing of it is
 * read. The data comes from GET /api/ivms/trucks/[id]/day, which answers for the session's company.
 */
export default async function TruckDayPage({ params, searchParams }: { params: { slug: string; truckId: string }; searchParams: { date?: string } }) {
  const { tenant, user, db } = await getCurrentTenant(params.slug);
  const truck = await db.truck.findFirst({ where: { id: params.truckId }, select: { id: true, code: true, onlyOnDate: true } });
  if (!truck) notFound();
  const cfg = await db.tenantConfig.findFirst({ select: { timezone: true } });
  const today = todayIso(cfg?.timezone || DEFAULT_TZ);
  const date = isIsoDate(searchParams.date) ? searchParams.date : today;
  const own = user.tenantId === tenant.id;
  return (
    <PageShell
      title={`Truck ${shownTruckCode(null, truck)}`}
      description="Where the truck is and what it did that day: its loads, each stop with the plan, the times and who recorded them, the results, the GPS trail and the alerts."
    >
      {!own ? (
        <p className="text-sm text-muted-foreground">A truck's day is shown for your own company only.</p>
      ) : !canPlan(user.role) ? (
        <p className="text-sm text-muted-foreground">A truck's day is for the dispatchers (Planner and up): it shows where the truck and its driver are.</p>
      ) : (
        <TruckDayClient slug={tenant.slug} truckId={truck.id} initialDate={date} />
      )}
    </PageShell>
  );
}
