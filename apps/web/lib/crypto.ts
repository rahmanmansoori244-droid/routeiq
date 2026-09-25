/**
 * Small crypto helpers shared by server code (Node runtime only).
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare for secrets (service tokens). A length mismatch returns false
 * straight away: the length of a random token is not a secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
