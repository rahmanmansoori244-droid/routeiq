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
 *        DATABASE_URL='<public url>' pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email> --revoke
 *      (SUPER_ADMIN_EMAILS in the local environment only drives the reminder it prints.)
 *
 * The session code honours SUPER_ADMIN only while BOTH hold (lib/session-principal.ts), so an env
 * edit alone or a database edit alone grants nothing. The change applies within 30 s.
 *
 * Revoking sets the user back to TENANT_ADMIN of their own tenant, or deactivates a user who has
 * no tenant. Each change writes a PLATFORM_ADMIN_GRANTED / _REVOKED audit row in the user's
 * tenant (a user without a tenant has no audit log; the script prints the change instead).
 */
import { PrismaClient, type Role } from '@prisma/client';

export interface PlatformAdminResult {
  email: string;
  userId: string;
  tenantId: string | null;
  before: { role: Role; active: boolean };
  after: { role: Role; active: boolean };
  changed: boolean;
  allowlisted: boolean;
  warnings: string[];
}

type Db = Pick<PrismaClient, 'user' | 'auditLog' | '$transaction'>;

function allowlisted(email: string, env: NodeJS.ProcessEnv): boolean {
  return (env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

export async function setPlatformAdmin(
  db: Db,
  rawEmail: string,
  opts: { revoke?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<PlatformAdminResult> {
  const env = opts.env ?? process.env;
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`Not an email address: ${rawEmail}`);

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, active: true, tenantId: true },
  });
  if (!user) throw new Error(`No user with email ${email}. Create the account first (sign-up or invite).`);

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

  return { email, userId: user.id, tenantId: user.tenantId, before, after, changed, allowlisted: isAllowlisted, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const emails = args.filter((a) => !a.startsWith('--'));
  if (emails.length !== 1) {
    console.error('Usage: tsx prisma/grant-platform-admin.ts <email> [--revoke]');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const r = await setPlatformAdmin(prisma, emails[0]!, { revoke });
    console.log(
      r.changed
        ? `${r.email}: ${r.before.role}${r.before.active ? '' : ' (inactive)'} -> ${r.after.role}${r.after.active ? '' : ' (inactive)'}`
        : `${r.email}: no change (${r.after.role}).`,
    );
    if (r.changed && !r.tenantId) console.log('This user has no tenant, so no audit row was written. Keep this output.');
    for (const w of r.warnings) console.warn(`Note: ${w}`);
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
