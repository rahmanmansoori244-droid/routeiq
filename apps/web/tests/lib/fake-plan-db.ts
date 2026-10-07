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
      // Ranges (dates, numbers, strings); a row without the field is outside every range.
      const val = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number | string;
      if ('gte' in v && !(row[k] != null && val(row[k]) >= val(v.gte))) return false;
      if ('lte' in v && !(row[k] != null && val(row[k]) <= val(v.lte))) return false;
      if ('gt' in v && !(row[k] != null && val(row[k]) > val(v.gt))) return false;
      if ('lt' in v && !(row[k] != null && val(row[k]) < val(v.lt))) return false;
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
  // carriedTo (PR9): the copy an order was brought forward to, as the test row gives it. A row's own
  // customer and lines (PR9 review: the carry window and the reconciliation read them) when it has them.
  order: {
    customer: (r) => r.customer ?? { id: 'c', code: 'C', branchKey: '__MAIN__' },
    lines: (r) => r.lines ?? [],
    carriedTo: (r) => r.carriedTo ?? null,
  },
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

/**
 * Relations a `select` reads like an include (the delivery outcome code selects a route assignment's
 * order). Only these: other tests rely on the fake ignoring `select` (the whole row, no relation).
 */
const SELECTED_RELATIONS: Record<string, string[]> = { routeAssignment: ['order'] };

function relSelect(model: string, select?: Row): Row | undefined {
  if (!select) return undefined;
  const rel = Object.keys(select).filter((k) => SELECTED_RELATIONS[model]?.includes(k) && typeof select[k] === 'object');
  return rel.length ? Object.fromEntries(rel.map((k) => [k, true])) : undefined;
}

function withInclude(model: string, r: Row, include?: Row) {
  if (!include) return { ...r };
  const out = { ...r };
  for (const k of Object.keys(include)) out[k] = REL[model]?.[k]?.(r) ?? null;
  return out;
}

function withCount(r: Row, include?: Row) {
  const sel = include?._count?.select as Row | undefined;
  if (!sel) return { ...r };
  const count: Row = {};
  for (const k of Object.keys(sel)) count[k] = Array.isArray(r[k]?.create) ? r[k].create.length : 0;
  return { ...r, _count: count };
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
  // The column defaults of Product (0 kg and 0 L = unknown): a product made from an upload or a late order.
  product: () => ({ weightPerCaseKg: 0, volumePerCaseL: 0, active: true, createdFromUpload: false }),
  // Driver leave: the @updatedAt column Prisma fills in.
  driverLeave: () => ({ updatedAt: new Date(), note: null, coverDriverId: null }),
};

function delegate(model: string) {
  const t = () => (tables[model] ??= []);
  const create = (data: Row) => {
    // An order created with its lines (a PR9 copy: lines: { create: [...] }) keeps them as rows with ids.
    const nested = model === 'order' && Array.isArray(data.lines?.create) ? { lines: data.lines.create.map((l: Row) => ({ id: newId('orderLine'), ...l })) } : {};
    const r = { id: newId(model), createdAt: new Date(), ...(DEFAULTS[model]?.() ?? {}), ...data, ...nested };
    t().push(r);
    return r;
  };
  return {
    findFirst: async (a: Row = {}) => {
      const r = sortRows(t().filter((x) => match(x, a.where)), a.orderBy)[0];
      return r ? withInclude(model, r, a.include ?? relSelect(model, a.select)) : null;
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
    findMany: async (a: Row = {}) => sortRows(t().filter((x) => match(x, a.where)), a.orderBy).map((r) => withInclude(model, r, a.include ?? relSelect(model, a.select))),
    count: async (a: Row = {}) => t().filter((x) => match(x, a.where)).length,
    groupBy: async () => [],
    // Nested creates (ManualBaseline.assignments: { create: [...] }) stay on the row; include._count counts them.
    // Other includes read the relation (an order's lines).
    create: async (a: Row) => {
      const r = create(a.data);
      return a.include && !a.include._count ? withInclude(model, r, a.include) : withCount(r, a.include);
    },
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
    delete: async (a: Row) => {
      const r = t().find((x) => match(x, a.where));
      if (!r) throw new Error(`${model} delete: not found`);
      tables[model] = t().filter((x) => x !== r);
      return { ...r };
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
  'truck', 'driver', 'depot', 'tenantConfig', 'customerTypeProfile', 'tenant', 'customer', 'uploadBatch',
  'product', 'intakeLineKey', 'manualBaseline', 'region',
  // Delivery outcome and the driver page (owner request 4 Oct 2026); users: the office side names who recorded a result.
  'driverLink', 'stopVisit', 'stopEvent', 'deliveryPhoto', 'user',
  // Start fresh (4 Oct 2026) also clears the comparison baselines and the retired driver app's rows.
  'manualBaselineAssignment', 'driverShift', 'truckLocation', 'deliveryProof',
  // The hire suggestion (6 Oct 2026): a plan job that saved its plan looks for hire options.
  'hireOption', 'hireSuggestion',
  // Driver leave (owner request 6 Oct 2026): the planner reads who is away on the delivery day.
  'driverLeave',
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
  // Driver leave (6 Oct 2026): the driver's row lock before a period is checked and saved.
  if (/FROM "Driver" WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(sql)) {
    return (tables.driver ?? []).filter((r) => r.id === values[0] && r.tenantId === values[1]).map((r) => ({ id: r.id }));
  }
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
