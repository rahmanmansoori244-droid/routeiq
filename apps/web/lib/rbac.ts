import type { Role } from '@prisma/client';

const RANK: Record<Role, number> = {
  SUPER_ADMIN: 100,
  TENANT_ADMIN: 80,
  SUPERVISOR: 60,
  PLANNER: 50,
  VIEWER: 10,
};

export function canManageMasterData(role: Role): boolean {
  return RANK[role] >= RANK.TENANT_ADMIN;
}

export function canPlan(role: Role): boolean {
  return RANK[role] >= RANK.PLANNER;
}

export function canApproveOverride(role: Role): boolean {
  return RANK[role] >= RANK.SUPERVISOR;
}

export function canView(role: Role): boolean {
  return RANK[role] >= RANK.VIEWER;
}

export function requireRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
