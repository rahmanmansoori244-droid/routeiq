'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { errorMessage } from '@/lib/error-message';
import { productImportHeadline, type ProductImportResult } from '@/lib/dispatch/product-import';

export function ProductImportForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ProductImportResult | null>(null);
  // Third review: a case weight already in RouteIQ is replaced by the file's only when this is ticked.
  const [updateWeights, setUpdateWeights] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleFile(f: File | null) {
    setResult(null);
    setFile(f);
  }

  function submit(commit: boolean) {
    if (!file) {
      toast.error('Pick a file first.');
      return;
    }
    startTransition(async () => {
      const fd = new FormData();
      fd.set('file', file);
      if (!commit) fd.set('dryRun', '1');
      if (updateWeights) fd.set('updateWeights', '1');
      const res = await fetch('/api/products/import', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Import failed.'));
        return;
      }
      const data = body.data as ProductImportResult;
      setResult(data);
      if (commit && !data.errorRows) {
        toast.success(data.imported ? `Imported: ${data.creates} new, ${data.updates} changed.` : 'Nothing to change: the products already match the file.');
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          <label
            htmlFor="file"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed py-12 text-center transition-colors ${
              dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:bg-muted/30'
            }`}
          >
            <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">{file ? file.name : 'Drop CSV or XLSX here, or click to browse'}</p>
            <p className="mt-1 text-xs text-muted-foreground">Max 10 MB · 50,000 rows</p>
            <input
              id="file"
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </CardContent>
      </Card>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={updateWeights}
          onChange={(e) => {
            setUpdateWeights(e.target.checked);
            setResult(null);
          }}
          data-testid="product-import-update-weights"
        />
        <span>
          Update case weights
          <span className="block text-xs text-muted-foreground">
            Off: a product that already has a case weight keeps it (a 0 or blank cell never changes a weight). On: the file&apos;s weights replace them. Validate only lists every weight that changes.
          </span>
        </span>
      </label>

      <div className="flex gap-2">
        <Button disabled={!file || pending} onClick={() => submit(false)} variant="outline">
          <FileSpreadsheet className="me-2 h-4 w-4" />
          {pending ? 'Validating…' : 'Validate only'}
        </Button>
        <Button disabled={!file || pending || (result ? result.errorRows > 0 : false)} onClick={() => submit(true)}>
          {pending ? 'Importing…' : 'Validate & import'}
        </Button>
      </div>

      {result ? (
        <Card className={result.errorRows > 0 ? 'border-destructive/30' : ''} data-testid="product-import-result">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2">
              {result.errorRows === 0 ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <AlertCircle className="h-5 w-5 text-destructive" />}
              <h3 className="font-medium">{productImportHeadline(result)}</h3>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{result.totalRows} rows</Badge>
              {result.errorRows > 0 ? <Badge variant="destructive">{result.errorRows} errors</Badge> : null}
              {result.warningRows > 0 ? <Badge variant="warning">{result.warningRows} warnings</Badge> : null}
              {result.productsWithoutFactor.length ? <Badge variant="warning">{result.productsWithoutFactor.length} without cases per pallet</Badge> : null}
            </div>
            {result.errors.length > 0 ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
                <p className="mb-2 font-medium text-destructive">Errors (fix the file, then import it again):</p>
                <ul className="space-y-1">
                  {result.errors.slice(0, 50).map((e) => (
                    <li key={`${e.row}:${e.message}`}>
                      <span className="font-mono">Row {e.row}:</span> {e.message}
                    </li>
                  ))}
                </ul>
                {result.errors.length > 50 ? <p className="mt-2 text-muted-foreground">…and {result.errors.length - 50} more.</p> : null}
              </div>
            ) : null}
            {result.weightChanges?.length ? (
              <div className="rounded-md border p-3 text-xs" data-testid="product-import-weight-changes">
                <p className="mb-2 font-medium">
                  Case weights {result.dryRun || result.errorRows ? 'that would change' : 'changed'} ({result.weightChanges.length}):
                </p>
                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {result.weightChanges.slice(0, 100).map((w) => (
                    <li key={w.code}>
                      <span className="font-mono">{w.code}</span>: {w.before ? `${w.before} kg` : 'no weight'} → {w.after} kg
                    </li>
                  ))}
                </ul>
                {result.weightChanges.length > 100 ? <p className="mt-2 text-muted-foreground">…and {result.weightChanges.length - 100} more.</p> : null}
              </div>
            ) : null}
            {result.warnings.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                <ul className="space-y-1 text-amber-900">
                  {result.warnings.slice(0, 30).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
