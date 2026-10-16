'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PlanView } from '../../plan-view';

export function PlanVersionClient({
  slug,
  runId,
  canPlan,
  canDispatch,
  canEditProducts,
  phoneCountryCode,
  dayHref,
  loadedAction = false,
}: {
  slug: string;
  runId: string;
  canPlan: boolean;
  canDispatch: boolean;
  canEditProducts: boolean;
  phoneCountryCode: string | null;
  dayHref: string;
  /** Operations alerts on with the loading rule (R2): offer Loaded next to Dispatch. */
  loadedAction?: boolean;
}) {
  const router = useRouter();
  return (
    <div className="space-y-3">
      <Link href={dayHref} className="text-sm underline-offset-2 hover:underline">
        ← Back to the daily dispatch screen
      </Link>
      <PlanView
        slug={slug}
        runId={runId}
        canPlan={canPlan}
        canDispatch={canDispatch}
        canResetStuck={canDispatch}
        canEditProducts={canEditProducts}
        phoneCountryCode={phoneCountryCode}
        loadedAction={loadedAction}
        onChanged={(newRunId) => {
          if (newRunId && newRunId !== runId) router.push(`/t/${slug}/dispatch/plan/${newRunId}`);
        }}
      />
    </div>
  );
}
