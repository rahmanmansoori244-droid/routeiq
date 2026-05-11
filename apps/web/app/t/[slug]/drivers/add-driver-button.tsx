'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DriverFormDialog } from './driver-form';

export function AddDriverButton({ label = 'Add driver' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="me-2 h-4 w-4" />
        {label}
      </Button>
      <DriverFormDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        onSaved={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
