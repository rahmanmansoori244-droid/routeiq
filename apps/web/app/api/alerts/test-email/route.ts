import { withTenantApi, ok, fail } from '@/lib/api';
import { fmtHhmm } from '@/lib/dispatch/time';
import { plainEmailConfigured, sendPlainEmail } from '@/lib/email';
import { readAlertEmails } from '@/lib/alerts/catalog';

// POST /api/alerts/test-email - "Send test email" on Settings > Operations alerts (owner request 16 Oct
// 2026): one e-mail to the SAVED recipients (never to an address typed in the request), whether alerts
// are on or not and also in the quiet hours. Company admin only; 3 per 10 min. 409 EMAIL_NOT_CONFIGURED
// (no RESEND_API_KEY / RESEND_FROM on the server), 409 NO_RECIPIENTS, 502 EMAIL_FAILED (the provider
// refused it or did not answer: its status only). Logs counts only.
export const POST = withTenantApi(
  async (_req, { db, user }) => {
    if (!plainEmailConfigured()) {
      return fail({ code: 'EMAIL_NOT_CONFIGURED', message: 'E-mail is not set up on the server (RESEND_API_KEY and RESEND_FROM): alerts show in RouteIQ only.' }, 409);
    }
    const [tenant, cfg] = await Promise.all([
      db.tenant.findFirst({ where: { id: user.tenantId }, select: { name: true } }),
      db.tenantConfig.findFirst({
        select: { alertsEnabled: true, alertEmails: true, alertEmailEveryMin: true, alertEmailMinSeverity: true, alertQuietFromMin: true, alertQuietToMin: true },
      }),
    ]);
    const to = readAlertEmails(cfg?.alertEmails);
    if (!cfg || !to.ok || !to.emails.length) {
      return fail({ code: 'NO_RECIPIENTS', message: 'Save at least one recipient under Operations alerts first: the test goes to the saved addresses.' }, 409);
    }
    const quiet = cfg.alertQuietFromMin != null && cfg.alertQuietToMin != null ? `none from ${fmtHhmm(cfg.alertQuietFromMin)} to ${fmtHhmm(cfg.alertQuietToMin)}` : 'no quiet hours';
    const text = [
      `This is a test e-mail from RouteIQ for ${tenant?.name ?? 'your company'}, sent by ${user.name || 'a company admin'} from Settings > Operations alerts.`,
      '',
      `Operations alerts are ${cfg.alertsEnabled ? 'ON' : 'OFF'}.`,
      cfg.alertEmailEveryMin > 0
        ? `Alert e-mails: ${cfg.alertEmailMinSeverity === 'WARN' ? 'warnings and high alerts' : 'high alerts only'}, at most one every ${cfg.alertEmailEveryMin} min, ${quiet}.`
        : 'Alert e-mails are switched off ("e-mail at most every" is 0): alerts show in RouteIQ only.',
      '',
      'Nothing needs to be done.',
    ].join('\n');
    const result = await sendPlainEmail({ to: to.emails, subject: `RouteIQ alerts: test e-mail - ${(tenant?.name ?? '').replace(/\s+/g, ' ').trim()}`, text });
    if (!result.ok) {
      console.warn('[alerts] test e-mail not sent', { tenantId: user.tenantId, reason: result.reason, error: result.error });
      return fail({ code: 'EMAIL_FAILED', message: `The test e-mail was not sent: ${result.error}. Check RESEND_API_KEY, RESEND_FROM (a verified sender) and the addresses.` }, 502);
    }
    console.info('[alerts] test e-mail sent', { tenantId: user.tenantId, recipients: to.emails.length });
    return ok({ sent: true, recipients: to.emails.length });
  },
  { role: 'TENANT_ADMIN', rateLimitKey: 'alerts-test-email', rateLimitLimit: 3, rateLimitWindowMs: 10 * 60_000 },
);
