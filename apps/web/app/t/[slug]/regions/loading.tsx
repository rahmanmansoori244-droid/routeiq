import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="rounded-lg border bg-card">
        <Skeleton className="h-10 rounded-t-lg" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="mx-3 my-3 h-6" />
        ))}
      </div>
    </div>
  );
}
