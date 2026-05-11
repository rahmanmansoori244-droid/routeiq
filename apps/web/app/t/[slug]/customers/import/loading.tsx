import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="rounded-lg border bg-card p-6 space-y-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <Skeleton className="h-36 w-full rounded-md" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}
