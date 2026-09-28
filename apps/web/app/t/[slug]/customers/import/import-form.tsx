'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { errorMessage } from '@/lib/error-message';

interface ImportError { row: number; message: string }
/** A row whose location is not exact: not saved (owner's location rule, audit PR A5). */
interface LocationNotSaved {
  row: number;
  code: string;
  branchCode: string | null;
  reason: string;
  kept: 'SAVED_LOCATION' | 'SAVED_LOCATION_NEEDS_PIN' | 'SAVED_LOCATION_NOT_USABLE' | null;
}
interface ImportResult {
  fileName: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  upserted?: number;
  errors?: ImportError[];
  warnings?: string[];
  dryRun?: boolean;
  creates?: number;
  updates?: number;
  confirmedServiceChanges?: { code: string; branchCode: string | null; from: number; to: number }[];
  /** Rows whose location is not exact: not saved (owner's location rule, audit PR A5). */
  locationsNotSaved?: LocationNotSaved[];
}

/**
 * One listed row: why its location is not saved, then what the customer has now (or will have after
 * the import). "Not planned or sent out" is what the system enforces (planning and LOCK / LOADING /
 * DISPATCH refuse a customer without a usable location, A5 second review).
 */
export function locationNotSavedLine(l: LocationNotSaved, dryRun: boolean): string {
  const untilPin = 'its orders are not planned or sent out until someone drops the pin on the map.';
  const after =
    l.kept === 'SAVED_LOCATION'
      ? 'The location it already has is kept.'
      : l.kept === 'SAVED_LOCATION_NEEDS_PIN'
        ? `Its saved location ${dryRun ? 'will no longer be' : 'is no longer'} used: ${untilPin}`
        : l.kept === 'SAVED_LOCATION_NOT_USABLE'
          ? `Its saved location is not exact or is outside the delivery area, so it is not used either: ${untilPin}`
          : 'It has no location until you set one.';
  return `${l.reason} ${after}`;
}

export function CustomerImportForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
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
      const res = await fetch('/api/customers/import', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Import failed.'));
        return;
      }
      setResult(body.data as ImportResult);
      if (commit && body.data?.upserted) {
        toast.success(`Imported ${body.data.upserted} customers.`);
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
        <Card className={result.errorRows > 0 ? 'border-destructive/30' : ''}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center gap-2">
              {result.errorRows === 0 ? (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              ) : (
                <AlertCircle className="h-5 w-5 text-destructive" />
              )}
              <h3 className="font-medium">
                {result.fileName} — {result.dryRun ? 'validation only' : `${result.upserted ?? 0} imported`}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{result.totalRows} rows</Badge>
              <Badge variant="success">{result.validRows} valid</Badge>
              {result.errorRows > 0 ? <Badge variant="destructive">{result.errorRows} errors</Badge> : null}
              {result.warningRows > 0 ? <Badge variant="warning">{result.warningRows} warnings</Badge> : null}
              {result.creates !== undefined ? <Badge variant="outline">{result.creates} new</Badge> : null}
              {result.updates !== undefined ? <Badge variant="outline">{result.updates} updated</Badge> : null}
              {result.confirmedServiceChanges?.length ? <Badge variant="warning">{result.confirmedServiceChanges.length} confirmed service time(s) change</Badge> : null}
              {result.locationsNotSaved?.length ? <Badge variant="warning">{result.locationsNotSaved.length} location(s) not exact</Badge> : null}
            </div>
            {result.locationsNotSaved && result.locationsNotSaved.length > 0 ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs" data-testid="locations-not-saved">
                <p className="mb-1 font-medium text-amber-900">
                  {result.locationsNotSaved.length} location(s) are not exact, so they are {result.dryRun ? 'not going to be' : 'not'} saved. No item is delivered without a correct location.
                </p>
                <p className="mb-2 text-amber-900">
                  Set each one on the map (ADD LOCATION on Daily dispatch, or Set location on the customer page), or fix the file and import it again: use at least 4 decimals, and in Excel format the lat and lng cells as text.
                </p>
                <ul className="space-y-1">
                  {result.locationsNotSaved.slice(0, 50).map((l) => (
                    <li key={l.row}>
                      <span className="font-mono">Row {l.row}</span> {l.code}
                      {l.branchCode ? ` / ${l.branchCode}` : ''}: {locationNotSavedLine(l, !!result.dryRun || result.errorRows > 0)}
                    </li>
                  ))}
                </ul>
                {result.locationsNotSaved.length > 50 ? <p className="mt-2 text-muted-foreground">…and {result.locationsNotSaved.length - 50} more.</p> : null}
              </div>
            ) : null}
            {result.errors && result.errors.length > 0 ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
                <p className="mb-2 font-medium text-destructive">Errors (must fix before import):</p>
                <ul className="space-y-1">
                  {result.errors.slice(0, 50).map((e) => (
                    <li key={`${e.row}:${e.message}`}>
                      <span className="font-mono">Row {e.row}:</span> {e.message}
                    </li>
                  ))}
                </ul>
                {result.errors.length > 50 ? (
                  <p className="mt-2 text-muted-foreground">…and {result.errors.length - 50} more.</p>
                ) : null}
              </div>
            ) : null}
            {result.warnings && result.warnings.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                <p className="mb-2 font-medium text-amber-900">Warnings (import will still proceed):</p>
                <ul className="space-y-1">
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
