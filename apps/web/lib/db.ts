import { PrismaClient } from '@prisma/client';

/**
 * Columns no read returns unless it asks for them by name (Prisma `omit`, preview "omitApi" in Prisma 5;
 * GA in 6.2). IVMS live link (16 Oct 2026): the tracker IMEI of a truck and the Ayun zone of a depot are
 * company-admin data of the IVMS link. Hidden here, every existing truck and depot read - the Trucks and
 * Depots APIs (any role, whole rows), the plan screens, sheets, exports and the before/after rows of the
 * audit log - stays exactly as it was, and no lower role can see an IMEI by accident. The IVMS code reads
 * them with `select: { ivmsImei: true }` (or `omit: { ivmsImei: false }`), only behind a company-admin
 * check or in the server's own background work (lib/ivms/*).
 *
 * Every IVMS column added to an existing model must be listed here: tests/lib/ivms-contract.spec.ts
 * checks it against prisma/schema.prisma.
 */
export const PRISMA_GLOBAL_OMIT = {
  truck: { ivmsImei: true },
  depot: { ivmsZoneName: true },
} as const;

function createClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    omit: PRISMA_GLOBAL_OMIT,
  });
}

export type AppPrismaClient = ReturnType<typeof createClient>;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: AppPrismaClient | undefined;
}

export const prisma = global.__prisma ?? createClient();

// Always shared: dev hot reload, and in production the instrumentation bundle (in-process
// janitor) gets its own copy of this module - one connection pool, not two.
global.__prisma = prisma;
