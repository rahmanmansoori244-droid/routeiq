'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { UploadBatchStatus } from '@prisma/client';
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

export interface BatchRow {
  id: string;
  fileName: string;
  fileType: string;
  uploadedAt: Date;
  deliveryDate: Date | null;
  status: UploadBatchStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  uploadedBy: { id: string; name: string; email: string };
  _count: { orders: number };
}

interface Props {
  slug: string;
  initial: BatchRow[];
  canEdit: boolean;
}

const STATUS_VARIANT: Record<UploadBatchStatus, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  PARSED: 'warning',
  VALIDATED: 'outline',
  CONFIRMED: 'success',
  REJECTED: 'destructive',
  DELETED: 'secondary',
};

export function BatchesTable({ slug, initial, canEdit }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<BatchRow | null>(null);
  const [deleting, startDelete] = useTransition();

  function onDelete(b: BatchRow) {
    startDelete(async () => {
      const res = await fetch(`/api/orders/${b.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Delete failed.');
        return;
      }
      toast.success(
        body.data?.ordersDeleted
          ? `Deleted batch ${b.fileName} and ${body.data.ordersDeleted} orders.`
          : `Batch ${b.fileName} marked deleted.`,
      );
      setConfirming(null);
      router.refresh();
    });
  }

  if (initial.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No upload batches yet. Drop a file on the Upload tab to begin.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Rows</TableHead>
              <TableHead className="text-right">Valid / Errors / Warn</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead>Delivery date</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="w-[1%]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">
                  <Link className="hover:underline" href={`/t/${slug}/upload/${b.id}`}>
                    {b.fileName}
                  </Link>
                  <div className="text-xs text-muted-foreground">{b.fileType}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[b.status]}>{b.status.toLowerCase()}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{b.totalRows}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  <span className="text-green-700">{b.validRows}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className={b.errorRows > 0 ? 'text-destructive' : ''}>{b.errorRows}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className={b.warningRows > 0 ? 'text-amber-700' : ''}>{b.warningRows}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{b._count.orders}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {b.deliveryDate ? new Date(b.deliveryDate).toISOString().slice(0, 10) : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(b.uploadedAt).toLocaleString()}
                  <div>{b.uploadedBy.email}</div>
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button asChild size="icon" variant="ghost" aria-label="View">
                    <Link href={`/t/${slug}/upload/${b.id}`}>
                      <Eye className="h-4 w-4" />
                    </Link>
                  </Button>
                  {canEdit && b.status !== 'DELETED' ? (
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => setConfirming(b)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete batch {confirming?.fileName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?._count?.orders
                ? `${confirming._count.orders} orders linked to this batch will also be deleted. This cannot be undone.`
                : 'The batch will be marked as DELETED.'}
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
