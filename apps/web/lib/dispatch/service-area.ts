/**
 * The delivery area of a company, as every location check uses it (Read, save, customer create and
 * import): `TenantConfig.serviceAreaJson` when set, else Oman + UAE for companies based there, else
 * no area check (`parseServiceArea`). Server only.
 */
import { prisma } from '../db';
import { parseServiceArea } from './customer-attrs';
import type { ServiceArea } from './location-input';

export async function tenantServiceArea(tenantId: string): Promise<ServiceArea> {
  const [cfg, tenant] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { serviceAreaJson: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { country: true } }),
  ]);
  return parseServiceArea(cfg?.serviceAreaJson, tenant?.country);
}
