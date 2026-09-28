/**
 * The migration test (tests/migrations/orders-always-have-depot.spec.ts) drops its database WITH
 * (FORCE). Its default name and the names it accepts stay inside this workstream's scratch
 * databases (routeiq_a5_<suffix>), so a documented command or an unset variable can never drop
 * another database on a shared server.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATION_TEST_DB_NAME, migrationTestDbName } from '../migrations/db-name';

describe('the migration test database name', () => {
  it('defaults to routeiq_a5_migtest', () => {
    expect(DEFAULT_MIGRATION_TEST_DB_NAME).toBe('routeiq_a5_migtest');
    expect(migrationTestDbName(undefined)).toBe('routeiq_a5_migtest');
  });

  it.each(['routeiq_a5_migtest', 'routeiq_a5_sk1_migtest', 'routeiq_a5_2_migtest'])('accepts a scratch name of this workstream: %s', (name) => {
    expect(migrationTestDbName(name)).toBe(name);
  });

  it.each([
    'routeiq_migtest', // the old default: outside the a5 prefix
    'routeiq_a4_migtest', // another workstream
    'routeiq_a5', // the app's own database
    'routeiq_a5_sk_1_1', // a scratch database that is not a migration test
    'postgres',
    'routeiq_a5_migtest; DROP DATABASE x',
    'ROUTEIQ_A5_MIGTEST',
  ])('refuses any other name before anything is dropped: %s', (name) => {
    expect(() => migrationTestDbName(name)).toThrow(/must start with routeiq_a5_ and end in migtest/);
  });
});
