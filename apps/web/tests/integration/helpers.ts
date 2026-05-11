/**
 * Shared helpers for integration tests that hit the running dev server.
 * Each suite gets a unique throwaway tenant via `freshTenant()`; cleanup
 * happens in afterAll.
 */
import { PrismaClient } from '@prisma/client';

export const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

export const prisma = new PrismaClient();

export function uniqueSuffix(): string {
  return `int-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface TenantHandle {
  slug: string;
  adminEmail: string;
  adminPassword: string;
  tenantId: string;
  userId: string;
  cookieJar: CookieJar;
}

export class CookieJar {
  private cookies = new Map<string, string>();
  store(setCookie: string | null): void {
    if (!setCookie) return;
    for (const part of setCookie.split(/,(?=[^;]+?=)/)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1, part.indexOf(';') === -1 ? undefined : part.indexOf(';'));
      this.cookies.set(name, value);
    }
  }
  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  clear() {
    this.cookies.clear();
  }
}

export async function fetchWith(
  jar: CookieJar | undefined,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar) headers.set('cookie', jar.header());
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  if (jar) jar.store(res.headers.get('set-cookie'));
  return res;
}

export async function signupTenant(slug: string): Promise<TenantHandle> {
  const adminEmail = `admin@${slug}.test`;
  const adminPassword = 'IntegrationTest-Password-12345';
  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: `Integration ${slug}`,
      slug,
      country: 'Oman',
      currency: 'OMR',
      primaryUnit: 'CASES',
      email: adminEmail,
      password: adminPassword,
      name: 'Integration Admin',
    }),
  });
  if (!res.ok) {
    throw new Error(`signup ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { tenantSlug: string; userId: string } };
  const jar = new CookieJar();
  await login(jar, adminEmail, adminPassword);
  return {
    slug,
    adminEmail,
    adminPassword,
    tenantId: '', // filled below
    userId: body.data.userId,
    cookieJar: jar,
  };
}

export async function login(jar: CookieJar, email: string, password: string): Promise<void> {
  const csrfRes = await fetchWith(jar, `${BASE}/api/auth/csrf`);
  const csrf = (await csrfRes.json()) as { csrfToken: string };

  const body = new URLSearchParams({
    email,
    password,
    csrfToken: csrf.csrfToken,
    redirect: 'false',
    callbackUrl: BASE,
  });
  await fetchWith(jar, `${BASE}/api/auth/callback/credentials?json=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

export async function cleanupTenant(slug: string): Promise<void> {
  // Cascading delete via Tenant — onDelete:Cascade handles every business table.
  try {
    await prisma.tenant.deleteMany({ where: { slug } });
  } catch (err) {
    console.error('cleanup failed', err);
  }
}

export async function freshTenant(prefix: string): Promise<TenantHandle> {
  const slug = `${prefix}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  const handle = await signupTenant(slug);
  // Pull the tenantId from DB so tests can use it directly.
  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) throw new Error('tenant disappeared after signup');
  handle.tenantId = t.id;
  return handle;
}

export interface SeededIds {
  depotId: string;
  truckIds: string[];
  regionId: string;
  productId: string;
  customerIds: string[];
}

/**
 * Seed a minimal NMWC-shaped tenant so the test can immediately upload orders
 * and create runs. Uses tenantDb-equivalent direct Prisma writes for speed.
 */
export async function seedMinimal(tenantId: string): Promise<SeededIds> {
  const depot = await prisma.depot.create({
    data: { tenantId, code: 'D1', name: 'Test depot', lat: 23.5859, lng: 58.4059 },
  });
  const region = await prisma.region.create({
    data: { tenantId, code: 'R1', name: 'Muscat', depotId: depot.id },
  });
  const product = await prisma.product.create({
    data: { tenantId, code: 'P-WATER', name: 'Water 500ml', weightPerCaseKg: 12, volumePerCaseL: 12 },
  });
  const truckIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const t = await prisma.truck.create({
      data: {
        tenantId,
        depotId: depot.id,
        code: `T-${i.toString().padStart(2, '0')}`,
        capacityCases: 200,
        capacityWeightKg: 3000,
        capacityVolumeL: 8000,
        fixedCostPerDay: 20,
        costPerKm: 0.15,
      },
    });
    truckIds.push(t.id);
  }
  const customerIds: string[] = [];
  // 12 customers spread around the depot
  for (let i = 1; i <= 12; i++) {
    const c = await prisma.customer.create({
      data: {
        tenantId,
        code: `C-${i.toString().padStart(3, '0')}`,
        name: `Customer ${i}`,
        branchKey: '__MAIN__',
        regionId: region.id,
        lat: 23.5859 + (i - 6) * 0.005,
        lng: 58.4059 + (i % 4) * 0.005,
        geocodeConfidence: 'HIGH',
        priority: 1 + (i % 5),
        avgServiceTimeMin: 10,
        paymentType: 'CREDIT',
      },
    });
    customerIds.push(c.id);
  }
  return { depotId: depot.id, truckIds, regionId: region.id, productId: product.id, customerIds };
}

export function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
