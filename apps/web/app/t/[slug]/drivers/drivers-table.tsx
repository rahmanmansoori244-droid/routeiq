'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
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
import { errorMessage } from '@/lib/error-message';

export function DriversTable({ initial, canManage }: { initial: DriverRow[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<DriverRow | null>(null);
  const [confirming, setConfirming] = useState<DriverRow | null>(null);
  const [deleting, startDelete] = useTransition();
  const [pinResult, setPinResult] = useState<{ driverCode: string; pin: string } | null>(null);
  const [settingPin, startSetPin] = useTransition();

  function rotatePin(d: DriverRow) {
    startSetPin(async () => {
      const res = await fetch(`/api/drivers/${d.id}/pin`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.data) {
        toast.error(errorMessage(body, 'Could not set PIN.'));
        return;
      }
      setPinResult({ driverCode: body.data.driverCode, pin: body.data.pin });
    });
  }

  function onDelete(d: DriverRow) {
    startDelete(async () => {
      const res = await fetch(`/api/drivers/${d.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Delete failed.'));
        return;
      }
      toast.success(`Driver ${d.code} deleted.`);
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
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="w-[1%]"></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.code}</TableCell>
                <TableCell className="font-medium">{d.name}</TableCell>
                <TableCell className="text-muted-foreground">{d.phone ?? '—'}</TableCell>
                <TableCell>
                  {d.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                </TableCell>
                {canManage ? (
                  <TableCell className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Set driver PIN"
                      title="Generate a new PIN for the driver PWA"
                      disabled={settingPin}
                      onClick={() => rotatePin(d)}
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
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

      <DriverFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        driver={editing ?? undefined}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />

      <AlertDialog open={!!pinResult} onOpenChange={(o) => !o && setPinResult(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New PIN for driver {pinResult?.driverCode}</AlertDialogTitle>
            <AlertDialogDescription>
              Share this with the driver. They'll enter <em>{pinResult?.driverCode}</em> + this PIN on the
              driver login page (<code>/driver</code>). This PIN is shown <strong>only once</strong> —
              copy it now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="my-4 rounded-md bg-slate-100 px-4 py-3 text-center font-mono text-2xl tracking-widest">
            {pinResult?.pin}
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setPinResult(null)}>Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete driver {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
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
