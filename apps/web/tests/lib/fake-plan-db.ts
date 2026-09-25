/**
 * In-memory stand-in for the Prisma client, just enough for the plan lifecycle code (plan-service,
 * start-optimize, dispatch-job) in unit tests. Not a database: no isolation and no real locks.
 * It records every raw SQL statement (so tests can assert WHICH locks are taken and in which
 * order), and $transaction restores the tables when the callback throws (rollback).
 */
type Row = Record<string, any>;

export const tables: Record<string, Row[]> = {};
export const rawLog: string[] = [];
let seq = 0;
const newId = (p: string) => `${p}_${++seq}`;

export function resetDb() {
  for (const k of Object.keys(tables)) delete tables[k];
  rawLog.length = 0;
  seq = 0;
}

const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

function match(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => match(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(v as Row[]).every((w) => match(row, w))) return false;
      continue;
    }
    if (['run', 'order', 'customer', 'load', 'truck', 'scenario'].includes(k)) continue; // relation filters: ignored
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !(v.in as unknown[]).some((x) => eq(row[k], x))) return false;
      if ('notIn' in v && (v.notIn as unknown[]).some((x) => eq(row[k], x))) return false;
      if ('not' in v) {
        const n = v.not;
        if (n !== null && typeof n === 'object' && 'in' in n) {
          if ((n.in as unknown[]).some((x) => eq(row[k], x))) return false;
        } else if (eq(row[k], n)) return false;
      }
      continue;
    }
    if (!eq(row[k], v)) return false;
  }
  return true;
}

const REL: Record<string, Record<string, (r: Row) => unknown>> = {
  planLoad: {
    assignments: (r) => (tables.routeAssignment ?? []).filter((a) => a.loadId === r.id).map((a) => ({ ...a, order: orderOf(a.orderId) })),
    truck: (r) => (tables.truck ?? []).find((t) => t.id === r.truckId) ?? { code: '?' },
    driver: () => null,
  },
  scenarioResult: { unservedOrders: (r) => (tables.unservedOrder ?? []).filter((u) => u.scenarioId === r.id).map((u) => ({ ...u })) },
  order: { customer: () => ({ id: 'c', code: 'C', branchKey: '__MAIN__' }), lines: () => [] },
  runPlan: { depot: (r) => (tables.depot ?? []).find((d) => d.id === r.depotId) ?? { id: r.depotId, code: 'D', name: 'D', lat: 23.6, lng: 58.4 } },
  routeAssignment: { load: (r) => (tables.planLoad ?? []).find((l) => l.id === r.loadId) ?? null, order: (r) => orderOf(r.orderId) },
};

function orderOf(id: string) {
  const o = (tables.order ?? []).find((x) => x.id === id);
  const customer = { id: 'c', code: 'C', branchKey: '__MAIN__', branchCode: null, name: 'Customer C' };
  return o
    ? { lines: [], customer: { ...customer, id: o.customerId ?? 'c' }, ...o, customerId: o.customerId ?? 'c' }
    : { id, customerId: 'c', totalCases: 0, totalWeightKg: 0, lines: [], customer };
}

function withInclude(model: string, r: Row, include?: Row) {
  if (!include) return { ...r };
  const out = { ...r };
  for (const k of Object.keys(include)) out[k] = REL[model]?.[k]?.(r) ?? null;
  return out;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)).filter(([, d]) => typeof d === 'string') as [string, string][];
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      if (a[k] === b[k]) continue;
      const c = a[k] < b[k] ? -1 : 1;
      return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const DEFAULTS: Record<string, () => Row> = {
  runPlan: () => ({ status: 'DRAFT', chosenScenarioId: null, supersededAt: null, currentJobId: null, finalizedAt: null, reconciliationJson: null, summaryJson: null, changeSummaryJson: null, parentRunId: null, version: 1, reason: 'INITIAL', totalOrders: 0, unservedCount: 0 }),
  planLoad: () => ({ status: 'PLANNED', carriedFromLoadId: null, driverId: null }),
  runJob: () => ({ status: 'QUEUED', attemptNo: 1, progressPct: 0, startedAt: null, finishedAt: null }),
};

function delegate(model: string) {
  const t = () => (tables[model] ??= []);
  const create = (data: Row) => {
    const r = { id: newId(model), createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}), ...data };
    t().push(r);
    return r;
  };
  return {
    findFirst: async (a: Row = {}) => {
      const r = sortRows(t().filter((x) => match(x, a.where)), a.orderBy)[0];
      return r ? withInclude(model, r, a.include) : null;
    },
    findFirstOrThrow: async (a: Row = {}) => {
      const r = sortRows(t().filter((x) => match(x, a.where)), a.orderBy)[0];
      if (!r) throw new Error(`${model} not found`);
      return withInclude(model, r, a.include);
    },
    findUnique: async (a: Row = {}) => {
      const r = t().find((x) => match(x, a.where));
      return r ? withInclude(model, r, a.include) : null;
    },
    findUniqueOrThrow: async (a: Row = {}) => {
      const r = t().find((x) => match(x, a.where));
      if (!r) throw new Error(`${model} not found`);
      return withInclude(model, r, a.include);
    },
    findMany: async (a: Row = {}) => sortRows(t().filter((x) => match(x, a.where)), a.orderBy).map((r) => withInclude(model, r, a.include)),
    count: async (a: Row = {}) => t().filter((x) => match(x, a.where)).length,
    groupBy: async () => [],
    create: async (a: Row) => ({ ...create(a.data) }),
    createMany: async (a: Row) => {
      for (const d of a.data) create(d);
      return { count: a.data.length };
    },
    update: async (a: Row) => {
      const r = t().find((x) => match(x, a.where));
      if (!r) throw new Error(`${model} update: not found`);
      Object.assign(r, a.data);
      return { ...r };
    },
    updateMany: async (a: Row) => {
      const rs = t().filter((x) => match(x, a.where));
      for (const r of rs) Object.assign(r, a.data);
      return { count: rs.length };
    },
    deleteMany: async (a: Row = {}) => {
      const keep = t().filter((x) => !match(x, a.where));
      const n = t().length - keep.length;
      tables[model] = keep;
      return { count: n };
    },
  };
}

const MODELS = [
  'runPlan', 'planLoad', 'routeAssignment', 'runJob', 'auditLog', 'scenarioResult', 'unservedOrder', 'order', 'orderLine',
  'truck', 'driver', 'depot', 'tenantConfig', 'customerTypeProfile', 'tenant', 'customer',
];

export const fakePrisma: Row = {};
for (const m of MODELS) fakePrisma[m] = delegate(m);

fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?').replace(/\s+/g, ' ').trim();
  rawLog.push(sql);
  if (/FROM "RunPlan" WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(sql)) {
    return (tables.runPlan ?? []).filter((r) => r.id === values[0] && r.tenantId === values[1]).map((r) => ({ id: r.id, status: r.status }));
  }
  if (/pg_advisory_xact_lock/.test(sql)) return [{ locked: 1 }];
  return [];
};
fakePrisma.$executeRaw = async (strings: TemplateStringsArray) => {
  rawLog.push(strings.join('?').replace(/\s+/g, ' ').trim());
  return 0;
};
fakePrisma.$executeRawUnsafe = async (sql: string) => {
  rawLog.push(sql);
  return 0;
};
/** Interactive transaction with rollback: the tables are restored when the callback throws. */
fakePrisma.$transaction = async (cb: (tx: Row) => Promise<unknown>) => {
  const snapshot = structuredClone(tables);
  try {
    return await cb(fakePrisma);
  } catch (e) {
    for (const k of Object.keys(tables)) delete tables[k];
    Object.assign(tables, snapshot);
    throw e;
  }
};

export function row(model: string, id: string): Row {
  const r = (tables[model] ?? []).find((x) => x.id === id);
  if (!r) throw new Error(`${model} ${id} missing`);
  return r;
}
