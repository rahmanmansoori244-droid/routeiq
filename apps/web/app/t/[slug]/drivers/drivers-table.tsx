'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarOff, Pencil, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { DriverFormDialog, type DriverRow } from './driver-form';
import { LeaveDialog, type DriverOption } from './leave-dialog';
import { errorMessage } from '@/lib/error-message';
import { onLeaveLabel } from '@/lib/dispatch/driver-leave';

/**
 * The drivers. The dispatcher (PLANNER and up, owner request 6 Oct 2026) edits, deactivates and
 * reactivates them and enters their leave (canEdit); VIEWER reads. Deactivate and reactivate send
 * the Active switch (PATCH /api/drivers/[id]), which every editor may change.
 */
export function DriversTable({ initial, drivers, canEdit, canAdmin }: { initial: DriverRow[]; drivers: DriverOption[]; canEdit: boolean; canAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<DriverRow | null>(null);
  const [confirming, setConfirming] = useState<DriverRow | null>(null);
  const [leaveOf, setLeaveOf] = useState<DriverRow | null>(null);
  const [deleting, startDelete] = useTransition();
  // Daily (casual) drivers added from loads (owner request 4 Oct 2026): a badge and a filter.
  const [show, setShow] = useState<'ALL' | 'REGULAR' | 'DAILY'>('ALL');
  const rows = initial.filter((d) => (show === 'ALL' ? true : show === 'DAILY' ? !!d.casual : !d.casual));
  const dailyCount = initial.filter((d) => d.casual).length;

  function setActive(d: DriverRow, active: boolean) {
    startDelete(async () => {
      // Drivers are never deleted (audit F20): switched off, they stay on their loads.
      const res = await fetch(`/api/drivers/${d.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, active ? 'Could not reactivate the driver.' : 'Could not deactivate the driver.'));
        return;
      }
      if (active) toast.success(`Driver ${d.code} active again.`);
      else toast.success(`Driver ${d.code} deactivated.`);
      // The trucks that keep this driver as their default are named, never cleared silently.
      if (typeof body?.data?.warning === 'string') toast.warning(body.data.warning, { duration: 10_000 });
      setConfirming(null);
      router.refresh();
    });
  }

  return (
    <>
      {dailyCount ? (
        <div className="mb-2 flex gap-1 text-sm" data-testid="driver-filter">
          {(['ALL', 'REGULAR', 'DAILY'] as const).map((k) => (
            <Button key={k} size="sm" variant={show === k ? 'default' : 'outline'} onClick={() => setShow(k)}>
              {k === 'ALL' ? 'All' : k === 'REGULAR' ? 'Regular' : `Daily (${dailyCount})`}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[1%]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.code}</TableCell>
                <TableCell className="font-medium">
                  {d.name}
                  {d.casual ? (
                    <Badge variant="outline" className="ml-1 text-[10px]" title="Daily (casual) driver added from a load">
                      Daily
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{d.phone ?? '—'}</TableCell>
                <TableCell className="space-x-1">
                  {d.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                  {d.leaveUntil ? (
                    <Badge variant="warning" data-testid={`driver-on-leave-${d.code}`}>
                      {onLeaveLabel(d.leaveUntil)}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label="Leave" title={canEdit ? 'Leave: add, change or end it' : 'Leave'} onClick={() => setLeaveOf(d)}>
                    <CalendarOff className="h-4 w-4" />
                  </Button>
                  {canEdit ? (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(d)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {d.active ? (
                        <Button size="icon" variant="ghost" aria-label="Deactivate" title="Deactivate" onClick={() => setConfirming(d)}>
                          <UserX className="h-4 w-4 text-destructive" />
                        </Button>
                      ) : (
                        <Button size="icon" variant="ghost" aria-label="Reactivate" title="Reactivate" disabled={deleting} onClick={() => setActive(d, true)}>
                          <UserCheck className="h-4 w-4" />
                        </Button>
                      )}
                    </>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DriverFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        driver={editing ?? undefined}
        canAdmin={canAdmin}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />

      <LeaveDialog driver={leaveOf} drivers={drivers} canEdit={canEdit} onOpenChange={(o) => !o && setLeaveOf(null)} />

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate driver {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Drivers are never deleted, so every load keeps who drove it. Deactivated, the driver stays on their
              loads and stays the usual driver of their trucks, but new plans do not use them. Reactivate them any
              time with the Reactivate button. For a few days or weeks away, enter Leave instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) setActive(confirming, false);
              }}
            >
              {deleting ? 'Working…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
