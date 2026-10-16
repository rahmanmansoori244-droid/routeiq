'use client';

import Link from 'next/link';
import type { Role } from '@prisma/client';
import { visibleNavItems } from '@/lib/nav';
import { NavLink } from './nav-link';

interface SidebarProps {
  slug: string;
  tenantName: string;
  role: Role;
  /** The company has operations alerts on (the Alerts item shows only then). */
  alertsOn?: boolean;
}

export function Sidebar({ slug, tenantName, role, alertsOn = false }: SidebarProps) {
  const items = visibleNavItems(role, { alerts: alertsOn });
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
      <Link href={`/t/${slug}`} className="flex h-14 items-center border-b px-4">
        <span className="text-lg font-semibold tracking-tight">RouteIQ</span>
      </Link>
      <div className="px-4 pt-4 pb-2 text-xs uppercase tracking-wide text-muted-foreground">
        {tenantName}
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {items.map((item) => (
          <NavLink
            key={item.label}
            href={item.href(slug)}
            label={item.label}
            icon={item.icon}
            exact={item.exact}
          />
        ))}
      </nav>
      <div className="border-t p-3 text-xs text-muted-foreground">v0.1 · Phase 0</div>
    </aside>
  );
}
