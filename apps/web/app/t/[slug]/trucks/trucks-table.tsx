'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CapacityUnit } from '@prisma/client';
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
import { TruckFormDialog, type TruckRow, type DepotOption } from './truck-form';
import { unitShort, fmtMoney } from '@/lib/format';

interface Props {
  initial: TruckRow[];
  depots: DepotOption[];
  canManage: boolean;
  primaryUnit: CapacityUnit;
  currency: string;
}

export function TrucksTable({ initial, depots, canManage, primaryUnit, currency }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<TruckRow | null>(null);
  const [confirming, setConfirming] = useState<TruckRow | null>(null);
  const [deleting, startDelete] = useTransition();

  function onDelete(t: TruckRow) {
    startDelete(async () => {
      const res = await fetch(`/api/trucks/${t.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Delete failed.');
        return;
      }
      if (body.data?.softDeleted) {
        toast.success(`Truck ${t.code} deactivated (referenced by past routes).`);
      } else {
        toast.success(`Truck ${t.code} deleted.`);
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
              <TableHead>Description</TableHead>
              <TableHead>Depot</TableHead>
              <TableHead className="text-right">Capacity ({unitShort(primaryUnit)})</TableHead>
              <TableHead className="text-right">Weight (kg)</TableHead>
              <TableHead className="text-right">Fixed/day</TableHead>
              <TableHead className="text-right">Per km</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="w-[1%]"></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-mono text-xs">{t.code}</TableCell>
                <TableCell className="text-muted-foreground">{t.description ?? '—'}</TableCell>
                <TableCell className="font-mono text-xs">{t.depot?.code ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{t.capacityCases.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{t.capacityWeightKg.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(t.fixedCostPerDay, currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtMoney(t.costPerKm, currency)}</TableCell>
                <TableCell>
                  {t.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                </TableCell>
                {canManage ? (
                  <TableCell className="flex gap-1">
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(t)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirming(t)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <TruckFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        truck={editing ?? undefined}
        depots={depots}
        primaryUnit={primaryUnit}
        currency={currency}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete truck {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              If the truck has been used in past route assignments, it will be deactivated instead of hard-deleted.
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
