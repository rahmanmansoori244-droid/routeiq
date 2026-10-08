/**
 * Review L8 / account enumeration: POST /api/auth/forgot answers at once with the same body for a
 * known and an unknown email. Issuing the link, the audit row and the email delivery all run after
 * the response, so neither a slow (or hanging) mail provider nor the link's own transaction can
 * reveal that the account exists (review s5-security-2, 9 Oct 2026: the link used to be issued
 * before the answer, so a known address answered measurably later).
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

/** The answer, or 'timeout' when the route has not answered within `ms`. */
const answerWithin = (p: Promise<Response>, ms = 1000) =>
  Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

/** Lets the work the route started after its answer run to its end (mocks resolve at once). */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  createResetTokenForEmail.mockReset();
  deliverResetEmail.mockClear();
  audit.mockClear();
});

describe('POST /api/auth/forgot', () => {
  it('returns 200 at once even when delivery never finishes', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'created', rawToken: 'raw-token-value-1234567890', userId: 'u1', tenantId: 't1' });
    const res = await answerWithin(forgot('Known@NMWC.example'));
    expect(res).not.toBe('timeout');
    const r = res as Response;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { sent: true }, error: null });
    await vi.waitFor(() => expect(audit).toHaveBeenCalled());
  });

  it('answers before the reset link is issued: a known address is not slower than an unknown one', async () => {
    // A known, active account's link takes a locked transaction; here it never finishes at all.
    createResetTokenForEmail.mockImplementation(() => new Promise(() => {}));
    const res = await answerWithin(forgot('Known@NMWC.example'));
    expect(res, 'the answer waited for the reset link').not.toBe('timeout');
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ data: { sent: true }, error: null });
    // The link is still issued, for the trimmed, lower-case address.
    expect(createResetTokenForEmail).toHaveBeenCalledWith('known@nmwc.example');
  });

  it('a failure while issuing the link never changes the answer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    createResetTokenForEmail.mockRejectedValue(new Error('database is down'));
    const r = await forgot('known@nmwc.example');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { sent: true }, error: null });
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('[forgot] reset link not issued or not delivered', 'database is down'));
    expect(deliverResetEmail).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('answers an unknown email with the same body and sends nothing', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'unknown_email', rawToken: null });
    const r = await forgot('ghost@example.test');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { sent: true }, error: null });
    await vi.waitFor(() => expect(createResetTokenForEmail).toHaveBeenCalledWith('ghost@example.test'));
    await settle();
    expect(deliverResetEmail).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('hands delivery the raw token and user id, never a pre-built URL', async () => {
    createResetTokenForEmail.mockResolvedValue({ status: 'created', rawToken: 'raw-token-value-1234567890', userId: 'u1', tenantId: null });
    await forgot('known@nmwc.example');
    await vi.waitFor(() => expect(deliverResetEmail).toHaveBeenCalledWith('known@nmwc.example', 'raw-token-value-1234567890', 'u1'));
  });
});
