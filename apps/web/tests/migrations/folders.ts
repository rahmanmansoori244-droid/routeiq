/**
 * Which migration folders the migration test applies before the migration it tests
 * (tests/migrations/*.spec.ts). The test applies every folder up to `lastBefore`, fills in the data,
 * then applies `next` alone. Later migrations may exist: they are not applied, and they must never
 * make the test fail (A5 second review: the test used to require `next` to be the newest folder,
 * so the first later migration broke it although nothing it tests had changed).
 *
 * Throws when `lastBefore` is missing, or when `next` is not the first folder after it (a folder
 * sorted in between would be skipped, so the test would no longer run the real order).
 */
export function migrationFoldersBefore(folders: readonly string[], lastBefore: string, next: string): string[] {
  const sorted = folders.filter((f) => /^\d{14}_/.test(f)).sort();
  if (!sorted.includes(lastBefore)) throw new Error(`Migration ${lastBefore} is missing.`);
  const after = sorted.filter((f) => f > lastBefore);
  if (after[0] !== next) {
    throw new Error(`The first migration after ${lastBefore} must be ${next} (found ${after[0] ?? 'none'}).`);
  }
  return sorted.filter((f) => f <= lastBefore);
}
