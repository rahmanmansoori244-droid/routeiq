'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Search, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { errorMessage } from '@/lib/error-message';
import { HelperFormDialog, type HelperRow } from './helper-form';

/** The rows a search shows: code, name or phone contains the text (any case); empty shows all. */
export function filterHelpers<T extends { code: string; name: string; phone: string | null }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((h) => h.code.toLowerCase().includes(q) || h.name.toLowerCase().includes(q) || (h.phone ?? '').toLowerCase().includes(q));
}

/**
 * The helpers (owner request 13 Oct 2026), as the drivers table: the dispatcher (PLANNER and up) edits,
 * deactivates and reactivates (the Active switch, PATCH /api/helpers/[id]); VIEWER reads. A search box
 * filters by code, name or phone.
 */
export function HelpersTable({ initial, canEdit, canAdmin }: { initial: HelperRow[]; canEdit: boolean; canAdmin: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<HelperRow | null>(null);
  const [confirming, setConfirming] = useState<HelperRow | null>(null);
  const [query, setQuery] = useState('');
  const [saving, startSave] = useTransition();
  const rows = filterHelpers(initial, query);

  function setActive(h: HelperRow, active: boolean) {
    startSave(async () => {
      // Helpers are never deleted: switched off, they stay on their loads.
      const res = await fetch(`/api/helpers/${h.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, active ? 'Could not reactivate the helper.' : 'Could not deactivate the helper.'));
        return;
      }
      toast.success(active ? `Helper ${h.code} active again.` : `Helper ${h.code} deactivated.`);
      if (typeof body?.data?.warning === 'string') toast.warning(body.data.warning, { duration: 10_000 });
      setConfirming(null);
      router.refresh();
    });
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search code, name or phone" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search helpers" data-testid="helper-search" />
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} of {initial.length}
        </span>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[1%]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  No helper matches “{query}”.
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((h) => (
              <TableRow key={h.id}>
                <TableCell className="font-mono text-xs">{h.code}</TableCell>
                <TableCell className="font-medium">{h.name}</TableCell>
                <TableCell className="text-muted-foreground">{h.phone ?? '—'}</TableCell>
                <TableCell>{h.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</TableCell>
                <TableCell className="flex gap-1">
                  {canEdit ? (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(h)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {h.active ? (
                        <Button size="icon" variant="ghost" aria-label="Deactivate" title="Deactivate" onClick={() => setConfirming(h)}>
                          <UserX className="h-4 w-4 text-destructive" />
                        </Button>
                      ) : (
                        <Button size="icon" variant="ghost" aria-label="Reactivate" title="Reactivate" disabled={saving} onClick={() => setActive(h, true)}>
                          <UserCheck className="h-4 w-4" />
                        </Button>
                      )}
                    </>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <HelperFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        mode="edit"
        helper={editing ?? undefined}
        canAdmin={canAdmin}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate helper {confirming?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Helpers are never deleted, so every load keeps who went on it. Deactivated, the helper stays on their loads and stays the usual
              helper of their trucks, but new plans do not use them. Reactivate them any time with the Reactivate button.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) setActive(confirming, false);
              }}
            >
              {saving ? 'Working…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
