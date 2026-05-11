'use client';

import { useState, useTransition } from 'react';
import { Search, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

interface Props {
  initial: AuditRow[];
  actions: string[];
  entities: string[];
  users: Array<{ id: string; name: string; email: string }>;
}

const ALL = '__all__';
const NO_USER = '__no_user__';

const ACTION_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  CREATE: 'success',
  UPDATE: 'outline',
  DELETE: 'destructive',
  OVERRIDE: 'warning',
  DISPATCH: 'success',
  LOGIN: 'secondary',
  SIGNUP: 'secondary',
  OPTIMIZE_STARTED: 'outline',
  OPTIMIZE_SUCCEEDED: 'success',
  OPTIMIZE_FAILED: 'destructive',
  SCENARIO_CHOSEN: 'outline',
  BASELINE_UPLOADED: 'outline',
  ROUTE_MANUALLY_CHANGED: 'warning',
};

export function AuditClient({ initial, actions, entities, users }: Props) {
  const [rows, setRows] = useState(initial);
  const [action, setAction] = useState(ALL);
  const [entity, setEntity] = useState(ALL);
  const [userFilter, setUserFilter] = useState(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [pending, startSearch] = useTransition();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function applyFilters() {
    startSearch(async () => {
      const params = new URLSearchParams();
      if (action !== ALL) params.set('action', action);
      if (entity !== ALL) params.set('entity', entity);
      if (userFilter !== ALL && userFilter !== NO_USER) params.set('userId', userFilter);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const r = await fetch(`/api/audit?${params}`, { cache: 'no-store' });
      const body = await r.json();
      const fetched: AuditRow[] = (body?.data ?? []).map((row: AuditRow & { createdAt: string }) => ({
        ...row,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(row.createdAt as unknown as string).toISOString(),
      }));
      setRows(fetched);
    });
  }

  function reset() {
    setAction(ALL);
    setEntity(ALL);
    setUserFilter(ALL);
    setFrom('');
    setTo('');
    setSearch('');
    setRows(initial);
  }

  const filtered = rows.filter((r) => {
    if (search.trim()) {
      const lower = search.toLowerCase();
      if (
        !r.action.toLowerCase().includes(lower) &&
        !r.entity.toLowerCase().includes(lower) &&
        !(r.entityId?.toLowerCase().includes(lower) ?? false) &&
        !(r.user?.email.toLowerCase().includes(lower) ?? false) &&
        !(r.user?.name.toLowerCase().includes(lower) ?? false)
      )
        return false;
    }
    return true;
  });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid grid-cols-1 gap-3 pt-6 md:grid-cols-6">
          <div className="md:col-span-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Quick search action, entity, ID, user…"
                className="ps-8"
              />
            </div>
          </div>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger>
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All actions</SelectItem>
              {actions.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger>
              <SelectValue placeholder="Entity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All entities</SelectItem>
              {entities.map((e) => (
                <SelectItem key={e} value={e}>{e}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={userFilter} onValueChange={setUserFilter}>
            <SelectTrigger>
              <SelectValue placeholder="User" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All users</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" />
          </div>
          <div className="flex gap-2 md:col-span-6">
            <Button size="sm" onClick={applyFilters} disabled={pending}>
              <RefreshCw className={`me-2 h-4 w-4 ${pending ? 'animate-spin' : ''}`} />
              Apply filters
            </Button>
            <Button size="sm" variant="outline" onClick={reset} disabled={pending}>
              Reset
            </Button>
            <span className="ms-auto self-center text-xs text-muted-foreground">
              Showing {filtered.length} of {rows.length} rows
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6"></TableHead>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="font-mono text-xs">Entity ID</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => {
              const isOpen = expanded.has(r.id);
              const hasDetail = (r.beforeJson && Object.keys(r.beforeJson as object).length > 0) || (r.afterJson && Object.keys(r.afterJson as object).length > 0);
              return (
                <>
                  <TableRow key={r.id}>
                    <TableCell>
                      {hasDetail ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(r.id)) next.delete(r.id);
                              else next.add(r.id);
                              return next;
                            })
                          }
                        >
                          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </Button>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ACTION_VARIANT[r.action] ?? 'outline'} className="font-mono text-[10px]">
                        {r.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{r.entity}</TableCell>
                    <TableCell className="text-xs">{r.user ? r.user.email : '—'}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {r.entityId?.slice(0, 16) ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">{r.ip ?? '—'}</TableCell>
                  </TableRow>
                  {isOpen && hasDetail ? (
                    <TableRow key={`${r.id}-detail`} className="bg-muted/30">
                      <TableCell colSpan={7}>
                        <div className="grid grid-cols-1 gap-3 px-2 py-2 md:grid-cols-2">
                          <DetailBlock label="Before" payload={r.beforeJson} />
                          <DetailBlock label="After" payload={r.afterJson} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </>
              );
            })}
          </TableBody>
        </Table>
        {filtered.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted-foreground">
            No matching rows.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DetailBlock({ label, payload }: { label: string; payload: unknown }) {
  if (!payload || (typeof payload === 'object' && Object.keys(payload as object).length === 0)) {
    return (
      <div>
        <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{label}</p>
        <p className="text-xs italic text-muted-foreground">—</p>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto rounded bg-background p-2 text-[10px] leading-tight">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}
