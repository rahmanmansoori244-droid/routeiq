import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

// Always shared: dev hot reload, and in production the instrumentation bundle (in-process
// janitor) gets its own copy of this module - one connection pool, not two.
global.__prisma = prisma;
