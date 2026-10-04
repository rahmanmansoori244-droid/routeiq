import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ProductImportForm } from './import-form';

export const metadata = { title: 'Import products — RouteIQ' };

/** Products import (truck capacity in pallets): company admins only, like editing a product. */
export default async function ProductImportPage({ params }: { params: { slug: string } }) {
  const { user } = await getCurrentTenant(params.slug);
  if (!canManageMasterData(user.role)) redirect(`/t/${params.slug}/products`);

  return (
    <PageShell
      title="Import products"
      description="Upload the product master (Excel or CSV) from the ERP. Each row creates or updates a product (the code is the key, whatever its letter case or extra spaces)."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/products`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            Back to products
          </Link>
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ProductImportForm />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Columns</CardTitle>
            <CardDescription>Header names are read without case, spaces or punctuation.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <Field
              name="code"
              required
              hint="Also read as: SKU, item code, product code. As the ERP writes it (JA1.5L(6), TN1.5L (6)): letters, digits, spaces and . ( ) - _ / + &, up to 40 characters, the same rule as the order file."
            />
            <Field name="name" hint="Also: description. A new product without a name is named after its code." />
            <Field
              name="weight_per_case_kg"
              hint="Kg of one case, 0-10,000 (0 counts as blank). Also: weight per case, kg per case. A product that already has a case weight keeps it unless Update case weights is ticked."
            />
            <Field
              name="cases_per_pallet"
              hint="The ERP pallet factor: cases of the product on one pallet, a whole number (e.g. 84). Also: pallet factor, cs/pallet, qty per pallet."
            />
            <Field name="active" hint="yes / no." />
            <div className="border-t pt-2 text-muted-foreground">
              A blank cell, or a column the file does not have, keeps what the product has. A row that changes nothing writes nothing. A file with an
              error imports nothing: fix the rows listed and import it again. Trucks with bays are loaded by pallets, so every product on a day&apos;s
              orders needs its cases per pallet before that day can be optimized. Orders stay in cases.
            </div>
            <div className="text-muted-foreground">
              Other columns (for example volume_per_case_l, units_per_case or notes) are not read; the result names them. In an Excel workbook
              the first sheet with rows is read (put the products first); the other sheets are named in the result.
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
