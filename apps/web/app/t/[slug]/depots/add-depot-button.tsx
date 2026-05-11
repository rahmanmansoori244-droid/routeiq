'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DepotFormDialog } from './depot-form';

interface Props {
  mapboxToken: string;
  label?: string;
}

export function AddDepotButton({ mapboxToken, label = 'Add depot' }: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="me-2 h-4 w-4" />
        {label}
      </Button>
      <DepotFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        mapboxToken={mapboxToken}
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
