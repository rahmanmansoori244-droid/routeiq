import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CustomerImportForm } from './import-form';

export const metadata = { title: 'Import customers — RouteIQ' };

export default async function CustomerImportPage({ params }: { params: { slug: string } }) {
  const { user } = await getCurrentTenant(params.slug);
  if (!canPlan(user.role)) redirect(`/t/${params.slug}/customers`);

  return (
    <PageShell
      title="Import customers"
      description="Upload an Excel or CSV file. Each row creates or updates a customer (code + branch is the unique key)."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/customers`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            Back to customers
          </Link>
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CustomerImportForm slug={params.slug} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Required columns</CardTitle>
            <CardDescription>Header names are case-insensitive.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <Field name="code" required />
            <Field name="name" required />
            <Field name="branch_code" hint="Blank rows count as the main branch." />
            <Field name="region_code" hint="Must match an existing region code." />
            <Field name="address" />
            <Field name="lat" hint="-90 to 90; leave blank to fix on the map later." />
            <Field name="lng" hint="-180 to 180." />
            <Field name="priority" required hint="Integer 1-5 (1 = highest)." />
            <Field name="avg_service_time_min" hint="Minutes. Default 10." />
            <Field name="payment_type" required hint="cash | credit | prepaid" />
            <div className="border-t pt-2 text-muted-foreground">
              Duplicate <code>code + branch_code</code> within the file is rejected.
            </div>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function Field({ name, required, hint }: { name: string; required?: boolean; hint?: string }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <code className="rounded bg-muted px-1 font-mono text-[11px]">{name}</code>
        {required ? <span className="text-[10px] uppercase text-destructive">required</span> : null}
      </div>
      {hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
