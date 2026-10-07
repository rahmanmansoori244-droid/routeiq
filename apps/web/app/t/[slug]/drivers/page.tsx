import { Users } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { DRIVER_PUBLIC_SELECT } from '@/lib/driver-fields';
import { addDaysIso, DEFAULT_TZ, todayIso } from '@/lib/dispatch/time';
import { coverAwayDuring, coverCaveat, LEAVE_LIST_DAYS, leavePhase } from '@/lib/dispatch/driver-leave';
import { upcomingLeaveRows } from '@/lib/dispatch/driver-leave-service';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { DriversTable } from './drivers-table';
import { AddDriverButton } from './add-driver-button';
import { LeaveList, type UpcomingLeave } from './leave-list';
import { UsualDrivers, type UsualTruck } from './usual-drivers';

export const metadata = { title: 'Drivers — RouteIQ' };
export const dynamic = 'force-dynamic';

/**
 * The Drivers page. Owner request 6 Oct 2026: the dispatcher (PLANNER and up) runs it - he adds
 * drivers, edits names and mobiles, activates and deactivates them, makes a daily driver a regular
 * one, enters leave (with a cover driver) and sets each truck's usual driver. VIEWER reads it. The
 * company admin keeps the driver code and the other truck fields (Trucks page).
 */
export default async function DriversPage({ params }: { params: { slug: string } }) {
  const { db, user, tenant } = await getCurrentTenant(params.slug);
  const canEdit = canPlan(user.role);
  const canAdmin = canManageMasterData(user.role);
  const cfg = await db.tenantConfig.findFirst({ select: { timezone: true } });
  const today = todayIso(cfg?.timezone || DEFAULT_TZ);
  // DRIVER_PUBLIC_SELECT: every prop of a client component is serialized into the page, so a
  // whole Driver row would hand the PIN hash to every role (review F13).
  const [drivers, trucks, leave] = await Promise.all([
    db.driver.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }], select: DRIVER_PUBLIC_SELECT }),
    db.truck.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, description: true, hired: true, defaultDriverId: true, depot: { select: { code: true } } },
    }),
    upcomingLeaveRows(tenant.id, today, addDaysIso(today, LEAVE_LIST_DAYS)),
  ]);
  const name = new Map(drivers.map((d) => [d.id, d.name]));
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const leaveNow = new Map(leave.filter((p) => leavePhase(p, today) === 'NOW').map((p) => [p.driverId, p]));
  const rows = drivers.map((d) => ({ ...d, leaveUntil: leaveNow.get(d.id)?.untilIso ?? null }));
  // The cover as planDrivers will see him (review of 6 Oct 2026): inactive, on leave himself on those
  // days, or the usual driver of other active trucks (given those first) - never "covers" when he will not.
  const ownTrucks = (driverId: string) => trucks.filter((t) => t.defaultDriverId === driverId).map((t) => t.code);
  const caveatOf = (coverId: string, days: { fromIso: string; untilIso: string }) => {
    const c = byId.get(coverId);
    return c ? coverCaveat(c, { away: coverAwayDuring(leave, { ...days, coverDriverId: coverId }), ownTrucks: ownTrucks(coverId) }) : 'not found: he cannot cover';
  };
  const upcoming: UpcomingLeave[] = leave.map((p) => ({
    id: p.id,
    driverId: p.driverId,
    driverName: name.get(p.driverId) ?? 'Unknown driver',
    from: p.fromIso,
    until: p.untilIso,
    now: leavePhase(p, today) === 'NOW',
    note: p.note,
    coverName: p.coverDriverId ? (name.get(p.coverDriverId) ?? 'Unknown driver') : null,
    coverCaveat: p.coverDriverId ? caveatOf(p.coverDriverId, p) : null,
  }));
  const usual: UsualTruck[] = trucks.map((t) => {
    const away = t.defaultDriverId ? leaveNow.get(t.defaultDriverId) : undefined;
    return {
      id: t.id,
      code: t.code,
      description: t.description,
      depotCode: t.depot.code,
      hired: t.hired,
      defaultDriverId: t.defaultDriverId,
      awayUntil: away?.untilIso ?? null,
      coverName: away?.coverDriverId ? (name.get(away.coverDriverId) ?? null) : null,
      // Today only: is the cover himself away today, inactive, or another truck's usual driver?
      coverCaveat: away?.coverDriverId ? caveatOf(away.coverDriverId, { fromIso: today, untilIso: today }) : null,
    };
  });
  const options = drivers.map((d) => ({ id: d.id, code: d.code, name: d.name, active: d.active, casual: d.casual }));

  return (
    <PageShell
      title="Drivers"
      description="Who drives: contacts, active status, leave and each truck's usual driver. The dispatcher keeps it up to date."
      actions={drivers.length > 0 && canEdit ? <AddDriverButton /> : null}
    >
      {drivers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No drivers yet"
          description="Add the drivers, then give each truck its usual driver: new plans put him on its loads."
          action={canEdit ? <AddDriverButton label="Add your first driver" /> : null}
        />
      ) : (
        <div className="space-y-6">
          <LeaveList items={upcoming} days={LEAVE_LIST_DAYS} />
          <DriversTable initial={rows} drivers={options} canEdit={canEdit} canAdmin={canAdmin} />
          <UsualDrivers trucks={usual} drivers={options} canEdit={canEdit} />
        </div>
      )}
    </PageShell>
  );
}
