'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { RegionFormDialog, type RegionRow } from './region-form';

interface DepotOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  initial: RegionRow[];
  depots: DepotOption[];
  canManage: boolean;
}

export function RegionsTable({ initial, depots, canManage }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<RegionRow | null>(null);
  const [confirming, setConfirming] = useState<RegionRow | null>(null);
  const [deleting, startDelete] = useTransition();

  function onDelete(r: RegionRow) {
    startDelete(async () => {
      const res = await fetch(`/api/regions/${r.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Delete failed.');
        return;
      }
      const detached = body.data?.detachedCustomers ?? 0;
      toast.success(
        detached > 0
          ? `Region ${r.code} deleted; ${detached} customers detached from it.`
          : `Region ${r.code} deleted.`,
      );
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
              <TableHead>Default depot</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              {canManage ? <TableHead className="w-[1%]"></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground">{r.depot ? `${r.depot.code} — ${r.depot.name}` : '—'}</TableCell>
                <TableCell className="text-right">{r._count?.customers ?? 0}</TableCell>
                {canManage ? (
                  <TableCell className="flex gap-1">
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(r)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirming(r)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RegionFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        region={editing ?? undefined}
        depots={depots}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete region {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              {(confirming?._count?.customers ?? 0) > 0
                ? `${confirming?._count?.customers} customers will be detached (kept, but no region).`
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
