'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Menu } from 'lucide-react';
import type { Role } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { NavLink } from './nav-link';
import { visibleNavItems } from '@/lib/nav';

interface MobileSidebarProps {
  slug: string;
  tenantName: string;
  role: Role;
}

export function MobileSidebar({ slug, tenantName, role }: MobileSidebarProps) {
  const [open, setOpen] = useState(false);
  const items = visibleNavItems(role);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="icon" variant="ghost" className="md:hidden" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <Link
          href={`/t/${slug}`}
          className="flex h-14 items-center border-b px-4"
          onClick={() => setOpen(false)}
        >
          <span className="text-lg font-semibold tracking-tight">RouteIQ</span>
        </Link>
        <div className="px-4 pt-4 pb-2 text-xs uppercase tracking-wide text-muted-foreground">
          {tenantName}
        </div>
        <nav className="space-y-0.5 p-2">
          {items.map((item) => (
            <NavLink
              key={item.label}
              href={item.href(slug)}
              label={item.label}
              icon={item.icon}
              exact={item.exact}
              onNavigate={() => setOpen(false)}
            />
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
