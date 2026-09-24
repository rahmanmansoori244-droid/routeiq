import {
  LayoutDashboard,
  Warehouse,
  Truck,
  Users as UsersIcon,
  Map as MapIcon,
  Building2,
  Package,
  Upload,
  ListChecks,
  Settings,
  History,
  UserCog,
  LifeBuoy,
  Route,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@prisma/client';

export interface NavItem {
  href: (slug: string) => string;
  label: string;
  icon: LucideIcon;
  rolesAllowed: Role[];
  exact?: boolean;
}

const ALL_ROLES: Role[] = ['SUPER_ADMIN', 'TENANT_ADMIN', 'PLANNER', 'SUPERVISOR', 'VIEWER'];
const ADMIN_ONLY: Role[] = ['SUPER_ADMIN', 'TENANT_ADMIN'];

export const NAV_ITEMS: NavItem[] = [
  { href: (s) => `/t/${s}/dispatch`, label: 'Daily dispatch', icon: Route, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}`, label: 'Dashboard', icon: LayoutDashboard, rolesAllowed: ALL_ROLES, exact: true },
  { href: (s) => `/t/${s}/depots`, label: 'Depots', icon: Warehouse, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/trucks`, label: 'Trucks', icon: Truck, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/drivers`, label: 'Drivers', icon: UsersIcon, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/regions`, label: 'Regions', icon: MapIcon, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/customers`, label: 'Customers', icon: Building2, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/products`, label: 'Products', icon: Package, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/upload`, label: 'Upload orders', icon: Upload, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/runs`, label: 'Plan history', icon: ListChecks, rolesAllowed: ALL_ROLES },
  { href: (s) => `/t/${s}/audit`, label: 'Audit log', icon: History, rolesAllowed: ADMIN_ONLY },
  { href: (s) => `/t/${s}/users`, label: 'Users', icon: UserCog, rolesAllowed: ADMIN_ONLY },
  { href: (s) => `/t/${s}/settings`, label: 'Settings', icon: Settings, rolesAllowed: ADMIN_ONLY },
  { href: (s) => `/t/${s}/help`, label: 'Help', icon: LifeBuoy, rolesAllowed: ALL_ROLES },
];

export function visibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.rolesAllowed.includes(role));
}
