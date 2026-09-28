/**
 * The migration test (tests/migrations/orders-always-have-depot.spec.ts) drops its database WITH
 * (FORCE). Its default name and the names it accepts stay inside this workstream's scratch
 * databases (routeiq_a5_<suffix>), so a documented command or an unset variable can never drop
 * another database on a shared server.
 *
 * It also applies only the migrations up to the one before the migration it tests, then that one
 * (`migrationFoldersBefore`, ../migrations/folders.ts): a migration added later never makes it fail
 * (A5 second review).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATION_TEST_DB_NAME, migrationTestDbName } from '../migrations/db-name';
import { migrationFoldersBefore } from '../migrations/folders';

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

describe('the migrations the migration test applies first', () => {
  const LAST = '20260930093000_master_data_no_orphans';
  const NEW = '20260930120000_orders_always_have_depot';
  const OLDER = ['20240101000000_init', '20260929090000_something'];

  it('every folder up to the one before, in order; migration_lock.toml is not a folder', () => {
    expect(migrationFoldersBefore([NEW, 'migration_lock.toml', LAST, ...OLDER.slice().reverse()], LAST, NEW)).toEqual([...OLDER, LAST]);
  });

  it('a migration added later does not make it fail, and is not applied (before: the tested one had to be the newest folder)', () => {
    expect(migrationFoldersBefore([...OLDER, LAST, NEW, '20261005090000_later_change'], LAST, NEW)).toEqual([...OLDER, LAST]);
  });

  it('refuses a folder sorted between the one before and the tested one, and a missing one', () => {
    expect(() => migrationFoldersBefore([...OLDER, LAST, '20260930100000_in_between', NEW], LAST, NEW)).toThrow(
      'The first migration after 20260930093000_master_data_no_orphans must be 20260930120000_orders_always_have_depot (found 20260930100000_in_between).',
    );
    expect(() => migrationFoldersBefore([...OLDER, LAST], LAST, NEW)).toThrow(/\(found none\)/);
    expect(() => migrationFoldersBefore([...OLDER, NEW], LAST, NEW)).toThrow('Migration 20260930093000_master_data_no_orphans is missing.');
  });
});
