import { UserPlus } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { HELPER_PUBLIC_SELECT } from '@/lib/dispatch/load-helpers';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { HelpersTable } from './helpers-table';
import { AddHelperButton } from './add-helper-button';
import { UsualHelpers, type UsualHelperTruck } from './usual-helpers';

export const metadata = { title: 'Helpers — RouteIQ' };
export const dynamic = 'force-dynamic';

/**
 * The Helpers page (owner request 13 Oct 2026: "management asked to track helpers in each truck, so add
 * that like drivers too"). The same roles as the Drivers page: the dispatcher (PLANNER and up) adds
 * helpers, edits names and mobiles, deactivates and reactivates them and sets each truck's usual helper;
 * VIEWER reads it; a helper's code is the company admin's.
 */
export default async function HelpersPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canEdit = canPlan(user.role);
  const canAdmin = canManageMasterData(user.role);
  const [helpers, trucks] = await Promise.all([
    db.helper.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }], select: HELPER_PUBLIC_SELECT }),
    db.truck.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, description: true, hired: true, defaultHelperId: true, depot: { select: { code: true } } },
    }),
  ]);
  const usual: UsualHelperTruck[] = trucks.map((t) => ({ id: t.id, code: t.code, description: t.description, depotCode: t.depot.code, hired: t.hired, defaultHelperId: t.defaultHelperId }));
  const options = helpers.map((h) => ({ id: h.id, code: h.code, name: h.name, active: h.active }));

  return (
    <PageShell
      title="Helpers"
      description="Who goes out with the drivers: contacts, active status and each truck's usual helper. The dispatcher keeps it up to date."
      actions={helpers.length > 0 && canEdit ? <AddHelperButton /> : null}
    >
      {helpers.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No helpers yet"
          description="Add the helpers, then give each truck its usual helper: new plans put him on its loads."
          action={canEdit ? <AddHelperButton label="Add your first helper" /> : null}
        />
      ) : (
        <div className="space-y-6">
          <HelpersTable initial={helpers} canEdit={canEdit} canAdmin={canAdmin} />
          <UsualHelpers trucks={usual} helpers={options} canEdit={canEdit} />
        </div>
      )}
    </PageShell>
  );
}
