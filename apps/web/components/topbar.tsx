import type { Role } from '@prisma/client';
import { MobileSidebar } from './mobile-sidebar';
import { UserMenu } from './user-menu';
import { AlertBell } from './alert-bell';

interface TopBarProps {
  slug: string;
  tenantName: string;
  role: Role;
  userName: string;
  userEmail: string;
  /**
   * Operations alerts (owner request 16 Oct 2026): the bell, only while the company has them switched on
   * and only in the user's own company (the alert API reads the session's company). Absent: no bell.
   */
  alerts?: { enabled: boolean; canAck: boolean; timezone: string };
}

export function TopBar({ slug, tenantName, role, userName, userEmail, alerts }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <MobileSidebar slug={slug} tenantName={tenantName} role={role} alertsOn={!!alerts?.enabled} />
      <div className="flex flex-1 items-center gap-2">
        <span className="text-sm font-medium md:hidden">{tenantName}</span>
      </div>
      {alerts?.enabled ? <AlertBell slug={slug} enabled={alerts.enabled} canAck={alerts.canAck} timezone={alerts.timezone} /> : null}
      <UserMenu name={userName} email={userEmail} role={role} />
    </header>
  );
}
