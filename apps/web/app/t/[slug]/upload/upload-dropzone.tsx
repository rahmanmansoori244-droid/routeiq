'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/error-message';

interface Props {
  slug: string;
  canEdit: boolean;
  onUploaded: () => void;
}

export function UploadDropzone({ slug, canEdit, onUploaded }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, startUpload] = useTransition();

  function submit() {
    if (!file) {
      toast.error('Pick a file first.');
      return;
    }
    startUpload(async () => {
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch('/api/orders/upload', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Upload failed.'));
        return;
      }
      toast.success(`Uploaded ${file.name}. Review validation.`);
      onUploaded();
      router.push(`/t/${slug}/upload/${body.data.batchId}`);
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="md:col-span-2">
        <Card>
          <CardContent className="p-0">
            <label
              htmlFor="orderfile"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed py-12 text-center transition-colors ${
                dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:bg-muted/30'
              }`}
            >
              <Upload className="mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                {file ? file.name : 'Drop Excel/CSV order file, or click to browse'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Max 10 MB · 50 000 rows · CSV / XLSX</p>
              <input
                id="orderfile"
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="sr-only"
                disabled={!canEdit}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </CardContent>
        </Card>
        <div className="mt-3 flex gap-2">
          <Button disabled={!file || pending || !canEdit} onClick={submit}>
            <FileSpreadsheet className="me-2 h-4 w-4" />
            {pending ? 'Uploading & validating…' : 'Upload & validate'}
          </Button>
          <Button variant="outline" disabled={!file} onClick={() => setFile(null)}>
            Clear
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Don't have a file?</CardTitle>
          <CardDescription>Generate a sample CSV matching the seeded NMWC tenant.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <SampleLink href="/api/orders/sample?mode=small">Small (20 rows)</SampleLink>
          <SampleLink href="/api/orders/sample?mode=clean">Clean (150 rows)</SampleLink>
          <SampleLink href="/api/orders/sample?mode=errors">With 3 errors (acceptance test)</SampleLink>
          <SampleLink href="/api/orders/sample?mode=stress">Stress (500 rows)</SampleLink>
        </CardContent>
      </Card>
    </div>
  );
}

function SampleLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className="w-full justify-start">
      <a href={href} download>
        <Download className="me-2 h-4 w-4" />
        {children}
      </a>
    </Button>
  );
}
