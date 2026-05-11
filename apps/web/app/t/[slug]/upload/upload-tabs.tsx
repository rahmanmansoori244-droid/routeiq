'use client';

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UploadDropzone } from './upload-dropzone';
import { BatchesTable, type BatchRow } from './batches-table';
import { OrdersTable, type OrderRow, type RegionOption } from './orders-table';

interface Props {
  slug: string;
  canEdit: boolean;
  batches: BatchRow[];
  orders: OrderRow[];
  regions: RegionOption[];
}

export function UploadTabs({ slug, canEdit, batches, orders, regions }: Props) {
  const [tab, setTab] = useState('upload');
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="upload">Upload</TabsTrigger>
        <TabsTrigger value="batches">Recent batches ({batches.length})</TabsTrigger>
        <TabsTrigger value="orders">Orders ({orders.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="upload">
        <UploadDropzone slug={slug} canEdit={canEdit} onUploaded={() => setTab('batches')} />
      </TabsContent>
      <TabsContent value="batches">
        <BatchesTable slug={slug} initial={batches} canEdit={canEdit} />
      </TabsContent>
      <TabsContent value="orders">
        <OrdersTable initial={orders} regions={regions} />
      </TabsContent>
    </Tabs>
  );
}
