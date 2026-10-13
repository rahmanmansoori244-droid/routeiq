'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorMessage } from '@/lib/error-message';
import { usualHelperChangedMessage } from '@/lib/dispatch/load-helpers';

/** An active truck and its usual (default) helper. */
export interface UsualHelperTruck {
  id: string;
  code: string;
  description: string | null;
  depotCode: string;
  hired: boolean;
  defaultHelperId: string | null;
}

/**
 * "Usual helper of each truck" (owner request 13 Oct 2026), as the usual driver: the dispatcher (PLANNER
 * and up) sets or clears it (PATCH /api/trucks/[id] with defaultHelperId alone, audited
 * TRUCK_USUAL_HELPER_SET). New plans put the usual helper on the truck's loads.
 */
export function UsualHelpers({ trucks, helpers, canEdit }: { trucks: UsualHelperTruck[]; helpers: { id: string; code: string; name: string; active: boolean }[]; canEdit: boolean }) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const nameOf = new Map(helpers.map((h) => [h.id, h.name]));

  function save(t: UsualHelperTruck, helperId: string | null) {
    setBusy(t.id);
    startSave(async () => {
      const res = await fetch(`/api/trucks/${t.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultHelperId: helperId }) });
      const body = await res.json().catch(() => ({}));
      setBusy(null);
      if (!res.ok) {
        toast.error(errorMessage(body, 'Could not change the usual helper.'));
        return;
      }
      toast.success(usualHelperChangedMessage(t.code, helperId ? (nameOf.get(helperId) ?? 'set') : null));
      router.refresh();
    });
  }

  return (
    <Card data-testid="usual-helpers">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-4 w-4 text-primary" />
          Usual helper of each truck
        </CardTitle>
        <CardDescription>New plans put the usual helper on the truck&apos;s loads. Helpers you pick on a load stay.</CardDescription>
      </CardHeader>
      <CardContent>
        {trucks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active trucks.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Truck</TableHead>
                <TableHead>Depot</TableHead>
                <TableHead>Usual helper</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trucks.map((t) => {
                // Active helpers, plus the current one if he was deactivated since.
                const options = helpers.filter((h) => h.active || h.id === t.defaultHelperId);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">
                      {t.code}
                      {t.hired ? (
                        <Badge variant="outline" className="ml-1 text-[10px]">
                          hired
                        </Badge>
                      ) : null}
                      {t.description ? <span className="ml-2 font-sans text-muted-foreground">{t.description}</span> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.depotCode}</TableCell>
                    <TableCell>
                      <select
                        className="h-8 w-48 rounded-md border bg-background px-1 text-sm disabled:opacity-70"
                        value={t.defaultHelperId ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => save(t, e.target.value || null)}
                        aria-label={`Usual helper of ${t.code}`}
                        data-testid={`usual-helper-${t.code}`}
                      >
                        <option value="">No usual helper</option>
                        {options.map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.name}
                            {h.active ? '' : ' (inactive)'}
                          </option>
                        ))}
                      </select>
                      {busy === t.id ? <span className="ml-2 text-xs text-muted-foreground">Saving…</span> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
