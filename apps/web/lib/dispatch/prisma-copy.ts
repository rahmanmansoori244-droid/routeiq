/**
 * Copying rows between plan versions (createNextVersion). A row read back from Prisma holds `null`
 * for an empty Json column, but Prisma refuses a plain `null` for a Json column on create: it must
 * be `Prisma.DbNull` (SQL NULL) or `Prisma.JsonNull` (a JSON null value). This helper finds the
 * model's Json columns from the generated client's schema (DMMF), so a Json column added later
 * (for example load snapshots) is copied correctly without touching the copy code.
 */
import { Prisma } from '@prisma/client';

const jsonFieldCache = new Map<string, ReadonlySet<string>>();

/** The Json scalar columns of a Prisma model. */
export function jsonFieldsOf(model: Prisma.ModelName): ReadonlySet<string> {
  const hit = jsonFieldCache.get(model);
  if (hit) return hit;
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`Unknown Prisma model ${model}`);
  const set = new Set(m.fields.filter((f) => f.kind === 'scalar' && f.type === 'Json').map((f) => f.name));
  jsonFieldCache.set(model, set);
  return set;
}

/**
 * Create data for a copy of `row`: the keys in `omit` are dropped, every Json column that is
 * `null` becomes `Prisma.DbNull`, and `overrides` are applied last. Relation objects must not be
 * in `row` (select or destructure them away first).
 */
export function copyRowData<T extends Record<string, unknown>, K extends keyof T, O extends Record<string, unknown>>(
  model: Prisma.ModelName,
  row: T,
  omit: readonly K[],
  overrides: O,
): Omit<T, K> & O {
  const json = jsonFieldsOf(model);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if ((omit as readonly string[]).includes(k)) continue;
    out[k] = v === null && json.has(k) ? Prisma.DbNull : v;
  }
  return { ...out, ...overrides } as Omit<T, K> & O;
}
