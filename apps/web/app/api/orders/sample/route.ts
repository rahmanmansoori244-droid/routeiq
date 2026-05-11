/**
 * Dev-only sample order file generator. Outputs a 150-row CSV matching the
 * seeded NMWC customers + products. Used by the upload page to seed tests.
 *
 * The file generated will validate cleanly against a freshly-seeded tenant
 * unless explicit `mode` query params introduce errors:
 *   ?mode=clean     150 valid rows
 *   ?mode=errors    150 rows with 3 deliberately broken rows (acceptance test)
 *   ?mode=stress    500 valid rows
 *
 * Always served as text/csv with a content-disposition for download.
 */
import { withTenantApi } from '@/lib/api';
import { NextResponse } from 'next/server';

export const GET = withTenantApi(async (req, { db }) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') ?? 'clean';
  const count =
    mode === 'stress' ? 500 : mode === 'small' ? 20 : 150;

  const [customers, products] = await Promise.all([
    db.customer.findMany({
      where: { active: true, lat: { not: null }, lng: { not: null } },
      orderBy: { code: 'asc' },
      take: 500,
    }),
    db.product.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
  ]);

  if (customers.length === 0 || products.length === 0) {
    return NextResponse.json(
      { data: null, error: 'No active customers or products found. Seed the tenant first (`pnpm db:seed:nmwc`).' },
      { status: 400 },
    );
  }

  // Tomorrow, YYYY-MM-DD
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const delivery = d.toISOString().slice(0, 10);

  // Deterministic pseudo-random selection so successive downloads are stable.
  function pick<T>(arr: T[], seed: number): T {
    return arr[seed % arr.length];
  }

  const lines: string[] = ['customer_code,branch_code,delivery_date,product_code,cases,priority,payment_collection_amount,notes'];
  for (let i = 0; i < count; i++) {
    const c = pick(customers, i * 7);
    const p = pick(products, i * 13);
    // Realistic NMWC line sizes: 1–6 cases per line. With duplicate-merge by
    // (customer, product, date) the resulting per-order totals average ~6–10
    // cases — comfortably within fleet capacity for the seeded NMWC trucks.
    const cases = 1 + ((i * 5) % 6); // 1..6
    const priority = 1 + (i % 5);
    const pay = i % 7 === 0 ? (10 + i % 90).toFixed(2) : '';
    const branch = c.branchCode ?? '';
    lines.push(`${c.code},${branch},${delivery},${p.code},${cases},${priority},${pay},`);
  }

  if (mode === 'errors') {
    // Replace 3 rows with deliberate problems to exercise validation messages.
    lines[1] = 'NMWC-XXX-999,,' + delivery + ',NMW-500,1,2,,unknown customer';
    lines[5] = lines[5].replace(/,\d+,/, ',0,'); // cases=0
    lines[10] = lines[10].replace(/,\d{4}-\d{2}-\d{2},/, ',2099-01-01,'); // date too far
  }

  const body = lines.join('\n');
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nmwc-sample-${mode}.csv"`,
    },
  });
});
