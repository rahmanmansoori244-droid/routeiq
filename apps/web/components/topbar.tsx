import type { Role } from '@prisma/client';
import { MobileSidebar } from './mobile-sidebar';
import { UserMenu } from './user-menu';

interface TopBarProps {
  slug: string;
  tenantName: string;
  role: Role;
  userName: string;
  userEmail: string;
}

export function TopBar({ slug, tenantName, role, userName, userEmail }: TopBarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <MobileSidebar slug={slug} tenantName={tenantName} role={role} />
      <div className="flex flex-1 items-center gap-2">
        <span className="text-sm font-medium md:hidden">{tenantName}</span>
      </div>
      <UserMenu name={userName} email={userEmail} role={role} />
    </header>
  );
}
