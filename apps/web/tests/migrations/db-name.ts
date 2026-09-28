/**
 * The name of the migration test's throwaway database (tests/migrations/*.spec.ts). The test drops
 * that database WITH (FORCE) before and after it runs, so only a scratch name of this workstream is
 * allowed: routeiq_a5_..._migtest. Any other name (another team's database, the app's own) is refused
 * before anything is dropped.
 */
export const DEFAULT_MIGRATION_TEST_DB_NAME = 'routeiq_a5_migtest';

export const MIGRATION_TEST_DB_NAME_RE = /^routeiq_a5_[a-z0-9_]*migtest$/;

/** The database name to use (MIGRATION_TEST_DB_NAME, else the default). Throws for a name it may not drop. */
export function migrationTestDbName(fromEnv: string | undefined): string {
  const name = fromEnv ?? DEFAULT_MIGRATION_TEST_DB_NAME;
  if (!MIGRATION_TEST_DB_NAME_RE.test(name)) {
    throw new Error(
      `MIGRATION_TEST_DB_NAME must start with routeiq_a5_ and end in migtest (got ${name}): the test drops that database. Leave it unset to use ${DEFAULT_MIGRATION_TEST_DB_NAME}.`,
    );
  }
  return name;
}
