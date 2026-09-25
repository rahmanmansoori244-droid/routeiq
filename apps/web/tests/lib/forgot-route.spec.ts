/**
 * Review L8 / account enumeration: POST /api/auth/forgot answers at once with the same body for a
 * known and an unknown email. The audit row and the email delivery run after the response, so a
 * slow (or hanging) mail provider cannot reveal that the account exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createResetTokenForEmail = vi.fn();
const deliverResetEmail = vi.fn(() => new Promise<void>(() => {})); // never resolves
const audit = vi.fn(() => new Promise(() => {})); // never resolves either

vi.mock('@/lib/password-reset', () => ({ createResetTokenForEmail, deliverResetEmail }));
vi.mock('@/lib/audit', () => ({ audit }));

const { POST } = await import('@/app/api/auth/forgot/route');

const forgot = (email: string) =>
  POST(new Request('http://localhost/api/auth/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }));

beforeEach(() => {
  createResetTokenForEmail.mockReset();
  deliverResetEmail.mockClear();
  audit.mockClear();
});

describe('POST /api/auth/forgot', () => {
  it('returns 200 at once even when delivery never finishes', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'created', rawToken: 'raw-token-value-1234567890', userId: 'u1', tenantId: 't1' });
    const res = await Promise.race([
      forgot('Known@NMWC.example'),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1000)),
    ]);
    expect(res).not.toBe('timeout');
    const r = res as Response;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { sent: true }, error: null });
    await vi.waitFor(() => expect(audit).toHaveBeenCalled());
  });

  it('answers an unknown email with the same body and sends nothing', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'unknown_email', rawToken: null });
    const r = await forgot('ghost@example.test');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { sent: true }, error: null });
    expect(deliverResetEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('hands delivery the raw token and user id, never a pre-built URL', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'created', rawToken: 'raw-token-value-1234567890', userId: 'u1', tenantId: null });
    await forgot('known@nmwc.example');
    await vi.waitFor(() => expect(deliverResetEmail).toHaveBeenCalledWith('known@nmwc.example', 'raw-token-value-1234567890', 'u1'));
  });
});
