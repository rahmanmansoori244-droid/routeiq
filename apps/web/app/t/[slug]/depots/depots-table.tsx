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
        toast.error(typeof body.error === 'string' ? body.error : 'Delete failed.');
        return;
      }
      if (body.data?.softDeleted) {
        toast.success(`Depot ${d.code} deactivated (still referenced).`);
      } else {
        toast.success(`Depot ${d.code} deleted.`);
      }
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
                  {d.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                </TableCell>
                {canManage ? (
                  <TableCell className="flex gap-1">
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(d)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirming(d)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
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
            <AlertDialogTitle>Delete depot {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?._count && (confirming._count.trucks > 0 || (confirming._count.regions ?? 0) > 0)
                ? `This depot has ${confirming._count.trucks} trucks and ${confirming._count.regions} regions. It will be deactivated rather than hard-deleted to preserve history.`
                : 'This action cannot be undone.'}
            </AlertDialogDescription>
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
              {deleting ? 'Working…' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
