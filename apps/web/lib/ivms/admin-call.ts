/**
 * IVMS live link (16 Oct 2026): the company admin's one-off provider call, the tracker picker's
 * USER_GET_OBJECTS (POST /api/ivms/objects, lib/ivms/tracker-admin.ts trackerSuggestions). Server only.
 *
 * - Counted BEFORE it is made in the ADMIN share of the daily allowance (lib/ivms/budget.ts classShares):
 *   budget only, no lease (review M13), so the picker never waits behind the poller and never eats into
 *   the map's or the history's share (H2). A share used up answers LIMIT without calling.
 * - Only while the company is the Ayun account's (AYUN_TENANT_SLUG) and its ivmsMode is MAP or TIMES:
 *   OFF never calls the provider (the caller checks it too).
 * - The provider's answer is returned as it came (the caller reduces it to IMEIs and plate keys: names and
 *   plates never leave lib/ivms/match.ts); nothing is stored. A wrong key (AUTH) or the allowance used up
 *   at the provider (LIMIT) pauses the background calls as the poller would (backoffUntil); any other
 *   failure is only recorded as the last error's kind. Never logged: the URL, the key, the answer.
 */
import { prisma } from '../db';
import { callAyun, type AyunCallOptions } from './ayun-client';
import { backoffUntil, classShares, eventsBackstopOn } from './budget';
import { ivmsApiReady, readIvmsEnv, type IvmsEnv } from './env';
import { IVMS_SETTING_DEFAULTS, ivmsModeAtLeast, ivmsModeOf } from './settings';
import { prismaIvmsStore, type IvmsStore } from './store';
import type { AyunResult } from './types';

export interface AdminCallDeps {
  env?: IvmsEnv;
  store?: Pick<IvmsStore, 'claimAdmin' | 'recordOk' | 'recordFailure'>;
  fetchImpl?: AyunCallOptions['fetchImpl'];
}

/** One USER_GET_OBJECTS for the admin's tracker picker, counted in the ADMIN share first. */
export async function ayunTrackerListCall(tenantId: string, now: Date = new Date(), deps: AdminCallDeps = {}): Promise<AyunResult<unknown>> {
  const env = deps.env ?? readIvmsEnv();
  if (env.disabled) return { ok: false, kind: 'DISABLED' };
  if (!ivmsApiReady(env) || !env.tenantSlug) return { ok: false, kind: 'NOT_CONFIGURED' };
  const [tenant, cfg] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { slug: true } }),
    prisma.tenantConfig.findFirst({ where: { tenantId }, select: { ivmsMode: true, ivmsDailyCallBudget: true } }),
  ]);
  const mode = ivmsModeOf(cfg);
  if (!tenant || tenant.slug.toLowerCase() !== env.tenantSlug || !ivmsModeAtLeast(mode, 'MAP')) return { ok: false, kind: 'NOT_CONFIGURED' };
  const budget = cfg?.ivmsDailyCallBudget ?? IVMS_SETTING_DEFAULTS.ivmsDailyCallBudget;
  const shares = classShares(budget, mode, eventsBackstopOn(budget, env.webhookSecrets.length > 0));
  const store = deps.store ?? prismaIvmsStore;
  if (!(await store.claimAdmin(tenantId, now, { share: shares.ADMIN, budget }))) return { ok: false, kind: 'LIMIT' };
  const r = await callAyun(env, { cmd: 'USER_GET_OBJECTS' }, { fetchImpl: deps.fetchImpl });
  if (r.ok) await store.recordOk(tenantId, now);
  else await store.recordFailure(tenantId, now, r.kind, r.kind === 'AUTH' || r.kind === 'LIMIT' ? backoffUntil(r.kind, 1, now, 60) : null);
  return r;
}
