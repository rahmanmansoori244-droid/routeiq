'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RegionFormDialog } from './region-form';

interface DepotOption {
  id: string;
  code: string;
  name: string;
}

export function AddRegionButton({ depots, label = 'Add region' }: { depots: DepotOption[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="me-2 h-4 w-4" />
        {label}
      </Button>
      <RegionFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        depots={depots}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
