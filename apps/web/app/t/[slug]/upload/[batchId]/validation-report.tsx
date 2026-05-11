'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { toast } from 'sonner';
import type { UploadBatchStatus } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface BatchSummary {
  id: string;
  fileName: string;
  status: UploadBatchStatus;
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  deliveryDate: string | null;
  orderCount: number;
  // Validation payload as written by the upload route. Loose typing because the
  // shape lives in lib/order-validate.ts and we just project a few fields here.
  validationJson: unknown;
}

interface ErrorRow { row: number; message: string }
interface WarningRow { row?: number; message: string }

function readValidation(json: unknown): { errors: ErrorRow[]; warnings: WarningRow[] } {
  if (!json || typeof json !== 'object') return { errors: [], warnings: [] };
  const j = json as { errors?: ErrorRow[]; warnings?: WarningRow[] };
  return {
    errors: Array.isArray(j.errors) ? j.errors : [],
    warnings: Array.isArray(j.warnings) ? j.warnings : [],
  };
}

const STATUS_VARIANT: Record<UploadBatchStatus, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  PARSED: 'warning',
  VALIDATED: 'outline',
  CONFIRMED: 'success',
  REJECTED: 'destructive',
  DELETED: 'secondary',
};

export function ValidationReport({
  slug,
  batch,
  canEdit,
}: {
  slug: string;
  batch: BatchSummary;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { errors, warnings } = readValidation(batch.validationJson);
  const [pending, startConfirm] = useTransition();

  const canConfirm = canEdit && batch.status === 'VALIDATED' && batch.errorRows === 0;

  function confirm() {
    startConfirm(async () => {
      const res = await fetch(`/api/orders/${batch.id}/confirm`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Confirm failed.');
        return;
      }
      toast.success(`Created ${body.data.ordersCreated} orders (${body.data.linesCreated} lines).`);
      router.push(`/t/${slug}/upload`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Validation summary</CardTitle>
          <CardDescription>
            Status: <Badge variant={STATUS_VARIANT[batch.status]}>{batch.status.toLowerCase()}</Badge>
            {batch.deliveryDate ? <span className="ms-3 text-xs">Delivery: {batch.deliveryDate}</span> : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">{batch.totalRows} rows</Badge>
            <Badge variant="success">{batch.validRows} valid</Badge>
            {batch.errorRows > 0 ? <Badge variant="destructive">{batch.errorRows} errors</Badge> : null}
            {batch.warningRows > 0 ? <Badge variant="warning">{batch.warningRows} warnings</Badge> : null}
            {batch.orderCount > 0 ? <Badge variant="success">{batch.orderCount} orders created</Badge> : null}
          </div>
        </CardContent>
      </Card>

      {errors.length > 0 ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive" />
              Errors ({errors.length})
            </CardTitle>
            <CardDescription>Fix these and re-upload. Commit is blocked while errors exist.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs">
              {errors.slice(0, 100).map((e, i) => (
                <li key={i}>
                  <span className="font-mono text-destructive">Row {e.row}:</span> {e.message}
                </li>
              ))}
            </ul>
            {errors.length > 100 ? (
              <p className="mt-2 text-xs text-muted-foreground">…and {errors.length - 100} more.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {warnings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-amber-600" />
              Warnings ({warnings.length})
            </CardTitle>
            <CardDescription>Confirm will proceed but you should review these.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs">
              {warnings.slice(0, 100).map((w, i) => (
                <li key={i}>
                  {w.row ? <span className="font-mono">Row {w.row}: </span> : null}
                  {w.message}
                </li>
              ))}
            </ul>
            {warnings.length > 100 ? (
              <p className="mt-2 text-xs text-muted-foreground">…and {warnings.length - 100} more.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {batch.status === 'CONFIRMED' ? (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            <span className="text-sm font-medium">
              Confirmed — {batch.orderCount} orders persisted. Find them in the Orders tab.
            </span>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex justify-end gap-2">
        {canConfirm ? (
          <Button onClick={confirm} disabled={pending}>
            {pending ? 'Persisting…' : `Confirm & create ${batch.validRows} orders`}
          </Button>
        ) : batch.status === 'VALIDATED' && batch.errorRows === 0 ? (
          <p className="text-xs text-muted-foreground">View-only role — ask a planner to confirm.</p>
        ) : null}
      </div>
    </div>
  );
}
