import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-10 w-28" />
      </div>
      <div className="rounded-lg border bg-card">
        <Skeleton className="h-10 rounded-t-lg" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="mx-3 my-3 h-6" />
        ))}
      </div>
    </div>
  );
}
