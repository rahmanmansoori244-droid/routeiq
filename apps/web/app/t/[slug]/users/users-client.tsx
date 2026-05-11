'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import type { Role } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

const ASSIGNABLE_ROLES: Role[] = ['TENANT_ADMIN', 'SUPERVISOR', 'PLANNER', 'VIEWER'];

const ROLE_VARIANT: Record<Role, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  SUPER_ADMIN: 'destructive',
  TENANT_ADMIN: 'default',
  SUPERVISOR: 'warning',
  PLANNER: 'secondary',
  VIEWER: 'outline',
};

export function UsersClient({ initial, currentUserId }: { initial: UserRow[]; currentUserId: string }) {
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [tempPwd, setTempPwd] = useState<{ email: string; password: string } | null>(null);

  function setRole(u: UserRow, role: Role) {
    startTransition(async () => {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Update failed.');
        return;
      }
      toast.success(`${u.email} is now ${role.replace('_', ' ')}.`);
      router.refresh();
    });
  }

  function setActive(u: UserRow, active: boolean) {
    startTransition(async () => {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Update failed.');
        return;
      }
      toast.success(active ? `${u.email} reactivated.` : `${u.email} deactivated.`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setInviting(true)}>
          <Plus className="me-2 h-4 w-4" />
          Invite user
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-center">Active</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((u) => {
              const isMe = u.id === currentUserId;
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs">
                    {u.email}
                    {isMe ? <Badge variant="outline" className="ms-2 text-[10px]">you</Badge> : null}
                  </TableCell>
                  <TableCell>{u.name}</TableCell>
                  <TableCell>
                    {u.role === 'SUPER_ADMIN' ? (
                      <Badge variant={ROLE_VARIANT[u.role]}>{u.role.replace('_', ' ')}</Badge>
                    ) : (
                      <Select value={u.role} onValueChange={(v) => setRole(u, v as Role)} disabled={pending || isMe}>
                        <SelectTrigger className="h-7 w-40 px-2 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNABLE_ROLES.map((r) => (
                            <SelectItem key={r} value={r}>
                              {r.replace('_', ' ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch checked={u.active} onCheckedChange={(v) => setActive(u, v)} disabled={pending || isMe} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <InviteDialog
        open={inviting}
        onOpenChange={(o) => !o && setInviting(false)}
        onCreated={(tempPwd) => {
          setInviting(false);
          setTempPwd(tempPwd);
          router.refresh();
        }}
      />

      <TempPasswordDialog
        open={!!tempPwd}
        onOpenChange={(o) => !o && setTempPwd(null)}
        info={tempPwd}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (info: { email: string; password: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('PLANNER');
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Invite failed.');
        return;
      }
      onCreated({ email: body.data.user.email, password: body.data.tempPassword });
      setEmail('');
      setName('');
      setRole('PLANNER');
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
          <DialogDescription>
            v1 doesn't send email yet. You'll get a temporary password to share with them manually.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="iemail">Email</Label>
            <Input id="iemail" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="iname">Name</Label>
            <Input id="iname" required value={name} onChange={(e) => setName(e.target.value)} disabled={pending} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="irole">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="irole">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !email.trim() || !name.trim()}>
              {pending ? 'Creating…' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TempPasswordDialog({
  open,
  onOpenChange,
  info,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: { email: string; password: string } | null;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!info) return;
    void navigator.clipboard.writeText(info.password);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Temporary password</DialogTitle>
          <DialogDescription>
            Share this password with {info?.email} now. It's not stored in plaintext anywhere — once you close this dialog, you'll need to reset their password to issue another.
          </DialogDescription>
        </DialogHeader>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <code className="font-mono text-sm">{info?.password}</code>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? <Check className="me-1 h-4 w-4" /> : <Copy className="me-1 h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </CardContent>
        </Card>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
