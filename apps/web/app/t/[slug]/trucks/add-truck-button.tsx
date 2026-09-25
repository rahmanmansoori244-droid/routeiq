'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TruckFormDialog, type DepotOption, type DriverOption } from './truck-form';

export function AddTruckButton({ depots, drivers, label = 'Add truck' }: { depots: DepotOption[]; drivers: DriverOption[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="me-2 h-4 w-4" />
        {label}
      </Button>
      <TruckFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        depots={depots}
        drivers={drivers}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
