/**
 * A master-data code that is already used (live bug of 12 Oct 2026: adding a driver with a code that
 * existed answered 500 - Prisma's P2002 from `driver.create` was not recognised as one - instead of a
 * message the dispatcher can act on). The Drivers and Helpers routes check the code first and answer
 * 409 CODE_TAKEN ("Driver code D01 is already used"); a P2002 that still happens (two saves at the
 * same instant) is answered the same way.
 *
 * Pure (no server imports): the check is by the error's code, never only by `instanceof`, which can
 * fail when the Prisma client class is loaded twice by the bundler.
 */
import { HttpError } from './http-error';

/** A unique-key violation from Prisma (P2002), recognised by its code. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

export type CodeKind = 'Driver' | 'Helper';

/** "Driver code D01 is already used. Use another code, or edit that driver." */
export function codeTakenMessage(kind: CodeKind, code: string): string {
  return `${kind} code ${code} is already used. Use another code, or edit that ${kind.toLowerCase()}.`;
}

/** 409 CODE_TAKEN with the code (the API error body: { error, code, field, value }). */
export function codeTaken(kind: CodeKind, code: string): HttpError {
  return new HttpError(codeTakenMessage(kind, code), 409, { code: 'CODE_TAKEN', field: 'code', value: code });
}

/**
 * Runs a create or update that may hit the (tenantId, code) unique key: a P2002 becomes 409 CODE_TAKEN
 * naming `code`; anything else is thrown as it was.
 */
export async function withCodeCheck<T>(kind: CodeKind, code: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (code !== undefined && isUniqueViolation(e)) throw codeTaken(kind, code);
    throw e;
  }
}
