'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Copy, Check, KeyRound } from 'lucide-react';
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
import { errorMessage } from '@/lib/error-message';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

const ASSIGNABLE_ROLES: Role[] = ['TENANT_ADMIN', 'SUPERVISOR', 'PLANNER', 'VIEWER'];

interface TempPasswordInfo {
  email: string;
  password: string;
  /** true after "Reset password" (an existing user), false after an invite. */
  reset: boolean;
}

const ROLE_VARIANT: Record<Role, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  SUPER_ADMIN: 'destructive',
  TENANT_ADMIN: 'default',
  SUPERVISOR: 'warning',
  PLANNER: 'secondary',
  VIEWER: 'outline',
};

export function UsersClient({
  initial,
  currentUserId,
  currentUserRole,
}: {
  initial: UserRow[];
  currentUserId: string;
  currentUserRole: Role;
}) {
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [tempPwd, setTempPwd] = useState<TempPasswordInfo | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);

  function setRole(u: UserRow, role: Role) {
    startTransition(async () => {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Update failed.'));
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
        toast.error(errorMessage(body, 'Update failed.'));
        return;
      }
      toast.success(active ? `${u.email} reactivated.` : `${u.email} deactivated.`);
      router.refresh();
    });
  }

  function resetPassword(u: UserRow) {
    startTransition(async () => {
      const res = await fetch(`/api/users/${u.id}/reset-password`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Password reset failed.'));
        return;
      }
      setResetTarget(null);
      setTempPwd({ email: body.data.user.email, password: body.data.tempPassword, reset: true });
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
              <TableHead className="text-right">Password</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((u) => {
              const isMe = u.id === currentUserId;
              // A platform admin's account is changed by the owner-run script only (the API refuses).
              const lockedPlatformAdmin = u.role === 'SUPER_ADMIN' && currentUserRole !== 'SUPER_ADMIN';
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
                    <Switch
                      checked={u.active}
                      onCheckedChange={(v) => setActive(u, v)}
                      disabled={pending || isMe || lockedPlatformAdmin}
                      title={lockedPlatformAdmin ? 'Platform admin: managed by the RouteIQ owner' : undefined}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => setResetTarget(u)}
                      disabled={pending || isMe || lockedPlatformAdmin}
                      title={
                        isMe
                          ? 'Ask another admin to reset your password, or use "Forgot your password?" on the sign-in page'
                          : lockedPlatformAdmin
                            ? 'Platform admin: managed by the RouteIQ owner'
                            : 'Give this user a new temporary password'
                      }
                    >
                      <KeyRound className="me-1 h-3.5 w-3.5" />
                      Reset password
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <InviteDialog
        open={inviting}
        onOpenChange={(o) => !o && setInviting(false)}
        onCreated={(info) => {
          setInviting(false);
          setTempPwd({ ...info, reset: false });
          router.refresh();
        }}
      />

      <Dialog open={!!resetTarget} onOpenChange={(o) => !o && !pending && setResetTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Give {resetTarget?.email} a new temporary password? Their current password stops working now and they are
              signed out on every device. You will see the new password once, to give to them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetTarget(null)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => resetTarget && resetPassword(resetTarget)} disabled={pending}>
              {pending ? 'Resetting…' : 'Reset password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        toast.error(errorMessage(body, 'Invite failed.'));
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
  info: TempPasswordInfo | null;
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
          <DialogTitle>{info?.reset ? 'New temporary password' : 'Temporary password'}</DialogTitle>
          <DialogDescription>
            {info?.reset ? 'Their old password no longer works. ' : ''}
            Give this password to {info?.email} over a secure channel (in person or by phone). It is not stored anywhere
            readable: once you close this dialog, use &quot;Reset password&quot; to issue another.
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
