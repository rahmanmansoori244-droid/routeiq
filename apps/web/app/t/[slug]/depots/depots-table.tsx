'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
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
import { DepotFormDialog, type DepotRow } from './depot-form';
import { errorMessage } from '@/lib/error-message';
import { depotDeleteActionLabel, depotDeleteDialogText, depotDeletedToast } from '@/lib/master-data-delete';

/** A row without counts (null) never promises a delete: the dialog then states the rule. */
const refsOf = (d: DepotRow) => d._count ?? null;

interface Props {
  initial: DepotRow[];
  canManage: boolean;
  mapboxToken: string;
}

export function DepotsTable({ initial, canManage, mapboxToken }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<DepotRow | null>(null);
  const [confirming, setConfirming] = useState<DepotRow | null>(null);
  const [deleting, startDelete] = useTransition();

  function onSaved() {
    setEditing(null);
    router.refresh();
  }

  function onDelete(d: DepotRow) {
    startDelete(async () => {
      const res = await fetch(`/api/depots/${d.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Delete failed.'));
        return;
      }
      // The server decides on its own counts (audit F03); the toast says what it did.
      toast.success(depotDeletedToast(d.code, { softDeleted: !!body.data?.softDeleted, references: body.data?.references ?? null }));
      if (typeof body.data?.warning === 'string') toast.warning(body.data.warning, { duration: 10_000 });
      setConfirming(null);
      router.refresh();
    });
  }

  return (
    <>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Address</TableHead>
              <TableHead className="text-right">Lat</TableHead>
              <TableHead className="text-right">Lng</TableHead>
              <TableHead className="text-right">Trucks</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="w-[1%]"></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.code}</TableCell>
                <TableCell className="font-medium">{d.name}</TableCell>
                <TableCell className="hidden md:table-cell text-muted-foreground">{d.address ?? '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">{d.lat.toFixed(4)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{d.lng.toFixed(4)}</TableCell>
                <TableCell className="text-right">{d._count?.trucks ?? 0}</TableCell>
                <TableCell>
                  {/* Audit PR A5: the depot that keeps orders and files that had no depot. */}
                  {d.historyOnly ? (
                    <Badge variant="secondary">History only</Badge>
                  ) : d.active ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="secondary">Inactive</Badge>
                  )}
                </TableCell>
                {canManage ? (
                  <TableCell className="flex gap-1">
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(d)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {/* It always has orders, so Delete could only deactivate it again: not offered. */}
                    {d.historyOnly ? null : (
                      <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirming(d)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DepotFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        depot={editing ?? undefined}
        mapboxToken={mapboxToken}
        onSaved={onSaved}
      />

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming ? `${depotDeleteActionLabel(refsOf(confirming))} depot ${confirming.code}?` : ''}</AlertDialogTitle>
            {/* The same rule and words as the API (audit F03): deactivated once anything refers to it. */}
            <AlertDialogDescription>{confirming ? depotDeleteDialogText(confirming.code, refsOf(confirming)) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) onDelete(confirming);
              }}
            >
              {deleting ? 'Working…' : confirming ? depotDeleteActionLabel(refsOf(confirming)) : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
