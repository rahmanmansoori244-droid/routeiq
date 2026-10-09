/**
 * Grant or revoke RouteIQ platform admin (SUPER_ADMIN). Owner-run only.
 *
 * Platform admin sees every tenant (/admin) and can open any tenant's pages (each such view is
 * written to that tenant's audit log as CROSS_TENANT_VIEW). Nothing in the app can grant it:
 * sign-up always creates a TENANT_ADMIN and the users screen refuses SUPER_ADMIN. This script is
 * the only way, and it takes two steps on purpose:
 *
 *   1. add the email to SUPER_ADMIN_EMAILS on the web service (Railway variables), and
 *   2. run this script from the owner's machine against the production database, through the
 *      Postgres public URL (DATABASE_PUBLIC_URL; postgres.railway.internal only resolves inside
 *      Railway), after a backup:
 *        DATABASE_URL='<public url>' pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email>
 *          (shows the account, its company and the change; changes nothing)
 *        DATABASE_URL='<public url>' pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email> --tenant <company slug> [--allow-self-signup]
 *        DATABASE_URL='<public url>' pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email> --revoke
 *      (SUPER_ADMIN_EMAILS in the local environment only drives the reminder it prints.)
 *
 * The session code honours SUPER_ADMIN only while BOTH hold (lib/session-principal.ts), so an env
 * edit alone or a database edit alone grants nothing. The change applies within 30 s.
 *
 * Who holds the address (review web-auth-security-2, 9 Oct 2026): an email address proves nothing
 * about who made the account. Public sign-up is open and never checks the address, so an outsider
 * can register ops@<your domain> in a throwaway company of their own before the owner promotes that
 * address, and the script used to promote whatever account held it. A grant therefore:
 *   - shows the account (name, created) and its company (slug, name, created, and whether the
 *     company was made through public sign-up, when and by whom) with the change, before any write;
 *   - goes ahead only when --tenant names the account's own company (--no-tenant for an account
 *     without one), so the owner confirms the company and not just the address. A run without it
 *     is the dry run above;
 *   - refuses an account whose company was made through public sign-up (the company's SIGNUP audit
 *     row) unless --allow-self-signup is passed. The owner's own company may have started that way,
 *     but an outsider's company always did, and so did any company an outsider used to invite the
 *     address. The usual safe path is an invite from the owner's own company's Users screen.
 * Revoking needs no confirmation: taking the role away is always the safe direction.
 *
 * Revoking sets the user back to TENANT_ADMIN of their own tenant, or deactivates a user who has
 * no tenant. Each change writes a PLATFORM_ADMIN_GRANTED / _REVOKED audit row in the user's
 * tenant (a user without a tenant has no audit log; the script prints the change instead).
 */
import { PrismaClient, type Role } from '@prisma/client';

/** What the owner needs to see to know whose account this is. */
export interface AccountFacts {
  email: string;
  name: string;
  createdAt: Date;
  /** The account's company, or null for an account without one (made by hand in the database). */
  tenant: { slug: string; name: string; createdAt: Date } | null;
  /** Set when the company was made through public sign-up (its SIGNUP audit row): when and by whom. */
  signup: { at: Date; byEmail: string | null } | null;
}

type RoleState = { role: Role; active: boolean };

export interface PlatformAdminResult {
  email: string;
  userId: string;
  tenantId: string | null;
  before: RoleState;
  after: RoleState;
  changed: boolean;
  allowlisted: boolean;
  warnings: string[];
  facts: AccountFacts;
}

export interface PlatformAdminOptions {
  revoke?: boolean;
  /**
   * Granting only: the slug of the company the owner expects the account to belong to (--tenant),
   * or null to confirm an account without a company (--no-tenant). Left out, nothing is granted.
   */
  tenant?: string | null;
  /** Granting only: accept an account whose company was made through public sign-up. */
  allowSelfSignup?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** A grant the script would not make. Nothing was written; `facts` and the change are shown. */
export class GrantRefused extends Error {
  constructor(
    message: string,
    readonly facts: AccountFacts,
    readonly before: RoleState,
    readonly after: RoleState,
  ) {
    super(message);
    this.name = 'GrantRefused';
  }
}

type Db = Pick<PrismaClient, 'user' | 'auditLog' | '$transaction'>;

function allowlisted(email: string, env: NodeJS.ProcessEnv): boolean {
  return (env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const roleText = (s: RoleState) => `${s.role}${s.active ? '' : ' (inactive)'}`;

/** The lines printed before any change (and with a refusal), so the owner sees whose account it is. */
export function describeAccount(facts: AccountFacts): string[] {
  const lines = [`Account: ${facts.email} ("${facts.name}"), created ${when(facts.createdAt)}`];
  if (!facts.tenant) {
    lines.push('Company: none (this account belongs to no company)');
  } else {
    lines.push(`Company: ${facts.tenant.slug} ("${facts.tenant.name}"), created ${when(facts.tenant.createdAt)}`);
    lines.push(
      facts.signup
        ? `         made through public sign-up on ${when(facts.signup.at)} by ${facts.signup.byEmail ?? 'a user who no longer exists'}`
        : '         not made through public sign-up',
    );
  }
  return lines;
}

/**
 * Review web-auth-security-2: a grant goes ahead only for the company the owner names, and not for
 * a company made through public sign-up unless the owner says so. Returns the reason to refuse, or
 * null. The hint never fills in the account's slug: the owner types the company they expect.
 */
function grantRefusal(facts: AccountFacts, opts: PlatformAdminOptions): string | null {
  const { email, tenant } = facts;
  if (opts.tenant === undefined) {
    return tenant
      ? `Nothing changed. Check the account and its company above. If ${email} is the person you mean and "${tenant.slug}" is their company, confirm it: run again with --tenant <that company's slug>.`
      : `Nothing changed. ${email} belongs to no company. If that is expected, confirm it: run again with --no-tenant.`;
  }
  if (!tenant) {
    if (opts.tenant !== null) {
      return `Nothing changed. ${email} belongs to no company, not to "${opts.tenant}". This is not the account you expected.`;
    }
  } else if (opts.tenant === null || opts.tenant.trim().toLowerCase() !== tenant.slug) {
    const named = opts.tenant === null ? 'no company' : `"${opts.tenant}"`;
    return (
      `Nothing changed. ${email} belongs to company "${tenant.slug}" ("${tenant.name}"), not to ${named}. ` +
      `This is not the account you expected: someone else may have registered this address. ` +
      `Do not promote it. The address stays taken while that account exists (it can be removed only in the database, ` +
      `after a backup); then invite the person from your own company's Users screen and grant that account.`
    );
  }
  if (facts.signup && !opts.allowSelfSignup) {
    return (
      `Nothing changed. Company "${tenant!.slug}" was made through public sign-up on ${when(facts.signup.at)} ` +
      `by ${facts.signup.byEmail ?? 'a user who no longer exists'}. Sign-up never checks that whoever registers an address owns it, ` +
      `so this account may belong to an outsider. If this is your own company and you know this account is yours ` +
      `(you created it, or your company invited it), run again with --allow-self-signup.`
    );
  }
  return null;
}

export async function setPlatformAdmin(db: Db, rawEmail: string, opts: PlatformAdminOptions = {}): Promise<PlatformAdminResult> {
  const env = opts.env ?? process.env;
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${rawEmail}`);

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      active: true,
      tenantId: true,
      createdAt: true,
      tenant: { select: { slug: true, name: true, createdAt: true } },
    },
  });
  // Never "sign up first": sign-up makes a company of its own (review web-auth-security-2).
  if (!user) throw new Error(`No user with email ${email}. Invite the person from your own company's Users screen first, then run this again.`);

  // The sign-up route writes SIGNUP (entity Tenant) in the transaction that creates the company;
  // a company made by the seed or by hand has none.
  const signupRow = user.tenantId
    ? await db.auditLog.findFirst({
        where: { tenantId: user.tenantId, action: 'SIGNUP', entity: 'Tenant', entityId: user.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, user: { select: { email: true } } },
      })
    : null;
  const facts: AccountFacts = {
    email,
    name: user.name,
    createdAt: user.createdAt,
    tenant: user.tenant ? { slug: user.tenant.slug, name: user.tenant.name, createdAt: user.tenant.createdAt } : null,
    signup: signupRow ? { at: signupRow.createdAt, byEmail: signupRow.user?.email ?? null } : null,
  };

  const before = { role: user.role, active: user.active };
  let after = { ...before };
  const warnings: string[] = [];
  const isAllowlisted = allowlisted(email, env);

  if (opts.revoke) {
    if (user.role === 'SUPER_ADMIN') {
      after = user.tenantId ? { role: 'TENANT_ADMIN', active: user.active } : { role: user.role, active: false };
    } else {
      warnings.push(`${email} is not a platform admin (role ${user.role}); nothing to revoke.`);
    }
    if (isAllowlisted) warnings.push(`Also remove ${email} from SUPER_ADMIN_EMAILS on the web service.`);
  } else {
    after = { role: 'SUPER_ADMIN', active: user.active };
    const refusal = grantRefusal(facts, opts);
    if (refusal) throw new GrantRefused(refusal, facts, before, after);
    if (!user.active) warnings.push(`${email} is inactive: platform admin applies only once the user is active again.`);
    if (!isAllowlisted) {
      warnings.push(
        `${email} is not in SUPER_ADMIN_EMAILS here. The role takes effect only once the web service's SUPER_ADMIN_EMAILS lists it.`,
      );
    }
  }

  const changed = after.role !== before.role || after.active !== before.active;
  if (changed) {
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: after });
      if (user.tenantId) {
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: opts.revoke ? 'PLATFORM_ADMIN_REVOKED' : 'PLATFORM_ADMIN_GRANTED',
            entity: 'User',
            entityId: user.id,
            beforeJson: before,
            afterJson: { ...after, by: 'prisma/grant-platform-admin.ts' },
          },
        });
      }
    });
  }

  return { email, userId: user.id, tenantId: user.tenantId, before, after, changed, allowlisted: isAllowlisted, warnings, facts };
}

export const USAGE =
  'Usage: tsx prisma/grant-platform-admin.ts <email> [--tenant <company slug> | --no-tenant] [--allow-self-signup]\n' +
  '       tsx prisma/grant-platform-admin.ts <email> --revoke\n' +
  'Without --tenant (or --no-tenant) a grant only shows the account, its company and the change.';

export interface CliArgs {
  email: string;
  revoke: boolean;
  tenant?: string | null;
  allowSelfSignup: boolean;
}

/**
 * Strict on purpose: an unknown or mistyped option is refused rather than ignored (a mistyped
 * --revoke used to be dropped silently, which made the run a grant).
 */
export function parseArgs(argv: string[]): CliArgs {
  const emails: string[] = [];
  let revoke = false;
  let allowSelfSignup = false;
  let tenant: string | null | undefined;
  const setTenant = (v: string | null) => {
    if (tenant !== undefined) throw new Error(`Give --tenant or --no-tenant once.\n${USAGE}`);
    tenant = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '--revoke') revoke = true;
    else if (a === '--allow-self-signup') allowSelfSignup = true;
    else if (a === '--no-tenant') setTenant(null);
    else if (a === '--tenant' || a.startsWith('--tenant=')) {
      const v = a === '--tenant' ? argv[++i] : a.slice('--tenant='.length);
      if (!v || v.startsWith('--')) throw new Error(`--tenant needs the company slug, for example --tenant nmwc.\n${USAGE}`);
      setTenant(v);
    } else if (a.startsWith('-')) throw new Error(`Unknown option ${a}.\n${USAGE}`);
    else emails.push(a);
  }
  if (emails.length !== 1) throw new Error(USAGE);
  return { email: emails[0]!, revoke, tenant, allowSelfSignup };
}

async function main() {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const r = await setPlatformAdmin(prisma, args.email, {
      revoke: args.revoke,
      tenant: args.tenant,
      allowSelfSignup: args.allowSelfSignup,
    });
    for (const line of describeAccount(r.facts)) console.log(line);
    console.log(
      r.changed ? `Changed: ${roleText(r.before)} -> ${roleText(r.after)}` : `No change (${roleText(r.after)}).`,
    );
    if (r.changed && !r.tenantId) console.log('This user has no tenant, so no audit row was written. Keep this output.');
    for (const w of r.warnings) console.warn(`Note: ${w}`);
  } catch (e) {
    if (e instanceof GrantRefused) {
      for (const line of describeAccount(e.facts)) console.log(line);
      console.log(`Would change: ${roleText(e.before)} -> ${roleText(e.after)}`);
    }
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

// Run only as a script, not when a test imports setPlatformAdmin.
if (/grant-platform-admin\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error((e as Error)?.message ?? e);
    process.exit(1);
  });
}
