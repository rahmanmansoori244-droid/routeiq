'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fmtHhmm, parseHhmm } from '@/lib/dispatch/time';
import { alertQuietSaveProblem, ALERT_SETTING_BOUNDS, type EditableConfig } from '@/lib/settings-fields';
import { ALERT_EMAIL_DEFAULTS, ALERT_EMAILS_MAX, ALERT_RULE_LIST, readAlertEmails, type AlertRuleSpec } from '@/lib/alerts/catalog';
import { api } from '@/app/t/[slug]/dispatch/client-api';

type AlertFields = Pick<
  EditableConfig,
  | 'alertsEnabled'
  | 'alertUnloadOverMin'
  | 'alertLoadingOverMin'
  | 'alertEtaLateMin'
  | 'alertDepartLateMin'
  | 'alertSilentMin'
  | 'alertPageNotOpenedMin'
  | 'alertAfterClosingMin'
  | 'alertPriorityMax'
  | 'alertDeliveredNote'
  | 'alertProofFarM'
  | 'alertNotClosedMin'
  | 'alertEmails'
  | 'alertEmailEveryMin'
  | 'alertEmailMinSeverity'
  | 'alertQuietFromMin'
  | 'alertQuietToMin'
>;

const UNIT_TEXT: Record<NonNullable<AlertRuleSpec['unit']>, string> = { min: 'min', m: 'm', priority: 'P' };

/** The rule's one-line meaning with its threshold in place of N. */
export function ruleMeaning(spec: AlertRuleSpec, value: number | null): string {
  const n = value != null && Number.isFinite(value) ? value : spec.threshold;
  return n == null ? spec.meaning : spec.meaning.replace(/\bN\b/g, String(n));
}

/**
 * What stops a save of the alert settings (the same rules as the API: lib/schemas.ts tenantConfigSchema
 * and alertQuietSaveProblem), only for the fields this save changes; null = fine.
 */
export function alertSettingsProblem(changes: Record<string, unknown>, c: AlertFields): string | null {
  for (const spec of ALERT_RULE_LIST) {
    if (!spec.bounds || !(spec.setting in changes)) continue;
    const v = c[spec.setting as keyof AlertFields] as number | null;
    if (v === null) continue;
    if (!(Number.isInteger(v) && v >= spec.bounds.min && v <= spec.bounds.max)) {
      return `R${spec.no} ${spec.label}: a whole number from ${spec.bounds.min} to ${spec.bounds.max}${spec.unit && spec.unit !== 'priority' ? ` ${UNIT_TEXT[spec.unit]}` : ''}.`;
    }
  }
  if ('alertEmails' in changes) {
    const r = readAlertEmails(c.alertEmails);
    if (!r.ok) return `Alert e-mail recipients: ${r.error}`;
  }
  if ('alertEmailEveryMin' in changes) {
    const b = ALERT_SETTING_BOUNDS.alertEmailEveryMin;
    if (!(Number.isInteger(c.alertEmailEveryMin) && c.alertEmailEveryMin >= b.min && c.alertEmailEveryMin <= b.max)) return `E-mail at most every: a whole number of minutes from ${b.min} to ${b.max} (0 = no e-mail).`;
  }
  return alertQuietSaveProblem(changes, c);
}

/**
 * Settings > Operations alerts (owner request 16 Oct 2026; company admin only, like the API): the master
 * switch, then, while it is on, one row per rule (on/off and its threshold), the e-mail recipients and
 * how often, which alerts are e-mailed, the quiet hours and a test e-mail. Saved with the page's Save
 * changes (one audit row, like every setting).
 */
export function AlertSettingsCard({
  c,
  set,
  changed,
  emailConfigured,
  savedEmails,
}: {
  c: AlertFields;
  set: (patch: Partial<AlertFields>) => void;
  /** Fields changed and not saved yet. */
  changed: ReadonlySet<string>;
  /** The server can send e-mail (RESEND_API_KEY and RESEND_FROM). */
  emailConfigured: boolean;
  /** The saved recipients (the test e-mail goes to them). */
  savedEmails: string | null;
}) {
  const [testing, setTesting] = useState(false);
  const mark = (k: string) => (changed.has(k) ? <span className="ml-1 text-xs text-blue-700">changed</span> : null);
  const quietOn = c.alertQuietFromMin != null || c.alertQuietToMin != null;
  const saved = readAlertEmails(savedEmails);
  const canTest = emailConfigured && saved.ok && saved.emails.length > 0 && !changed.has('alertEmails');

  async function sendTest() {
    setTesting(true);
    try {
      const r = await api<{ recipients: number }>('/api/alerts/test-email', { method: 'POST' });
      if (r.ok) toast.success(`Test e-mail sent to ${r.data?.recipients ?? 0} address${r.data?.recipients === 1 ? '' : 'es'}. Check the inbox (and the spam folder).`);
      else toast.error(r.error ?? 'The test e-mail was not sent.', { duration: 10_000 });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card data-testid="alert-settings">
      <CardHeader>
        <CardTitle className="text-base">Operations alerts</CardTitle>
        <CardDescription>
          When this is on, RouteIQ checks the plans of yesterday, today and tomorrow every 2 minutes and raises an alert when a rule below is broken: in
          the bell at the top, in the Alerts card of the day screen and on the Alerts page, and by e-mail if it is set up below. Nothing that started
          before you switch it on raises an alert. Off: nothing is checked; alerts already raised stay listed. Only a company admin changes these.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <Label htmlFor="alertsEnabled" className="text-sm font-normal">
            Operations alerts on
            {mark('alertsEnabled')}
          </Label>
          <Switch id="alertsEnabled" checked={c.alertsEnabled} onCheckedChange={(v) => set({ alertsEnabled: v })} />
        </div>
        {c.alertsEnabled ? (
          <>
            <div className="space-y-2" data-testid="alert-rules">
              {ALERT_RULE_LIST.map((spec) => {
                const k = spec.setting;
                if (!spec.bounds) {
                  const on = c.alertDeliveredNote;
                  return (
                    <div key={spec.rule} className="flex flex-wrap items-start gap-3 rounded-md border px-3 py-2" data-testid={`alert-rule-${spec.rule}`}>
                      <Switch id={k} checked={on} onCheckedChange={(v) => set({ alertDeliveredNote: v })} aria-label={`R${spec.no} ${spec.label}`} />
                      <div className="min-w-0 flex-1">
                        <Label htmlFor={k} className="text-sm">
                          R{spec.no} {spec.label}
                          {mark(k)}
                        </Label>
                        <p className="text-xs text-muted-foreground">{spec.meaning}</p>
                      </div>
                    </div>
                  );
                }
                const value = c[k as keyof AlertFields] as number | null;
                const on = value !== null;
                const b = spec.bounds;
                const bad = on && !(Number.isInteger(value) && value >= b.min && value <= b.max);
                return (
                  <div key={spec.rule} className="flex flex-wrap items-start gap-3 rounded-md border px-3 py-2" data-testid={`alert-rule-${spec.rule}`}>
                    <Switch
                      id={`${k}-on`}
                      checked={on}
                      onCheckedChange={(v) => set({ [k]: v ? (spec.threshold ?? b.min) : null } as Partial<AlertFields>)}
                      aria-label={`R${spec.no} ${spec.label} on`}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor={k} className="text-sm">
                        R{spec.no} {spec.label}
                        {spec.owner ? (
                          <Badge variant="outline" className="ml-2">
                            your rule
                          </Badge>
                        ) : null}
                        {mark(k)}
                      </Label>
                      <p className="text-xs text-muted-foreground">{ruleMeaning(spec, value)}</p>
                      {spec.rule === 'LOADING_OVER' && on ? (
                        <p className="text-xs text-amber-700" data-testid="loading-rule-note">
                          Needs the warehouse to press Loading when it starts each truck and Loaded when it is done (Daily dispatch). If all loads are put on
                          Loading together in the evening, every load will be reported.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      {spec.unit === 'priority' ? <span className="text-sm text-muted-foreground">P1 to P</span> : null}
                      <Input
                        id={k}
                        type="number"
                        className={`h-8 w-24 ${bad ? 'border-destructive' : ''}`}
                        min={b.min}
                        max={b.max}
                        step={1}
                        disabled={!on}
                        aria-invalid={bad}
                        value={on && Number.isFinite(value) ? value : ''}
                        onChange={(e) => set({ [k]: e.target.value === '' ? Number.NaN : Number(e.target.value) } as Partial<AlertFields>)}
                      />
                      {spec.unit && spec.unit !== 'priority' ? <span className="text-sm text-muted-foreground">{UNIT_TEXT[spec.unit]}</span> : null}
                    </div>
                    {bad ? (
                      <p className="w-full text-xs text-destructive">
                        A whole number from {b.min} to {b.max}.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="space-y-3 rounded-md border p-3" data-testid="alert-email-settings">
              <p className="text-sm font-medium">E-mail</p>
              {!emailConfigured ? (
                <p className="text-sm text-amber-700" data-testid="alert-email-not-configured">
                  Email is not set up on the server (RESEND_API_KEY and RESEND_FROM): alerts show in RouteIQ only.
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="alertEmails">
                    Send alerts to
                    {mark('alertEmails')}
                  </Label>
                  <Input
                    id="alertEmails"
                    value={c.alertEmails ?? ''}
                    placeholder="owner@company.example, dispatch@company.example"
                    onChange={(e) => set({ alertEmails: e.target.value.trim() === '' ? null : e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">At most {ALERT_EMAILS_MAX} addresses, separated by commas. Empty: no e-mail, alerts show in RouteIQ only.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alertEmailEveryMin">
                    E-mail at most every (min)
                    {mark('alertEmailEveryMin')}
                  </Label>
                  <Input
                    id="alertEmailEveryMin"
                    type="number"
                    min={ALERT_SETTING_BOUNDS.alertEmailEveryMin.min}
                    max={ALERT_SETTING_BOUNDS.alertEmailEveryMin.max}
                    step={5}
                    value={Number.isFinite(c.alertEmailEveryMin) ? c.alertEmailEveryMin : ''}
                    onChange={(e) => set({ alertEmailEveryMin: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  />
                  <p className="text-xs text-muted-foreground">One e-mail lists everything new since the last one. 0 = no e-mail. At most 40 a day.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="alertEmailMinSeverity">
                    E-mail
                    {mark('alertEmailMinSeverity')}
                  </Label>
                  <select
                    id="alertEmailMinSeverity"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={c.alertEmailMinSeverity}
                    onChange={(e) => set({ alertEmailMinSeverity: e.target.value })}
                  >
                    <option value="HIGH">High alerts only (warnings show in RouteIQ)</option>
                    <option value="WARN">Warnings and high alerts</option>
                  </select>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 md:col-span-2">
                  <Label htmlFor="alertQuietOn" className="text-sm font-normal">
                    Quiet hours: no e-mail (alerts still show in RouteIQ)
                  </Label>
                  <Switch
                    id="alertQuietOn"
                    checked={quietOn}
                    onCheckedChange={(v) =>
                      set(v ? { alertQuietFromMin: ALERT_EMAIL_DEFAULTS.quietFromMin, alertQuietToMin: ALERT_EMAIL_DEFAULTS.quietToMin } : { alertQuietFromMin: null, alertQuietToMin: null })
                    }
                  />
                </div>
                <QuietTime id="alertQuietFromMin" label="No e-mail from" value={c.alertQuietFromMin} disabled={!quietOn} onChange={(v) => set({ alertQuietFromMin: v })} mark={mark('alertQuietFromMin')} />
                <QuietTime id="alertQuietToMin" label="until" value={c.alertQuietToMin} disabled={!quietOn} onChange={(v) => set({ alertQuietToMin: v })} mark={mark('alertQuietToMin')} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" size="sm" variant="outline" disabled={!canTest || testing} onClick={() => void sendTest()} data-testid="alert-test-email">
                  {testing ? 'Sending…' : 'Send test email'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {!emailConfigured
                    ? 'Needs e-mail set up on the server.'
                    : changed.has('alertEmails')
                      ? 'Save the recipients first: the test goes to the saved addresses.'
                      : saved.ok && saved.emails.length
                        ? `Goes to the ${saved.emails.length} saved address${saved.emails.length === 1 ? '' : 'es'}.`
                        : 'Save at least one recipient first.'}
                </span>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function QuietTime({ id, label, value, disabled, onChange, mark }: { id: string; label: string; value: number | null; disabled: boolean; onChange: (v: number | null) => void; mark: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {mark}
      </Label>
      <Input
        id={id}
        type="time"
        disabled={disabled}
        value={value == null ? '' : fmtHhmm(value)}
        onChange={(e) => {
          try {
            const v = parseHhmm(e.target.value);
            onChange(v !== null && v < 1440 ? v : null);
          } catch {
            // keep the last valid time while the field is being edited
          }
        }}
      />
    </div>
  );
}
