import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-72" />
      <div className="rounded-lg border bg-card p-6 space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="rounded-lg border bg-card">
        <Skeleton className="h-10 rounded-t-lg" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="mx-3 my-3 h-6" />
        ))}
      </div>
    </div>
  );
}
