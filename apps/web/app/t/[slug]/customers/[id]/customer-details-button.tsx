'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CustomerDialog, type EditableCustomer } from '../../dispatch/customer-dialog';

/**
 * Details on the customer page, the same dialog as on Daily dispatch (data collection review: the
 * Lock refusal and the Data to collect list send the dispatcher here to confirm receiving hours):
 * customer type, priority, unloading time and the receiving hours - with "Open all day" and "These
 * hours are confirmed with the customer". Saved through PATCH /api/customers/:id.
 */
export function CustomerDetailsButton({ customer }: { customer: EditableCustomer }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="customer-details">
        <Pencil className="me-1 h-3 w-3" /> Details
      </Button>
      <CustomerDialog open={open} onOpenChange={setOpen} customer={customer} onSaved={() => router.refresh()} />
    </>
  );
}
