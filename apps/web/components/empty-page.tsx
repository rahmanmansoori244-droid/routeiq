import type { LucideIcon } from 'lucide-react';

interface EmptyPageProps {
  title: string;
  description: string;
  icon: LucideIcon;
  phase: number;
}

export function EmptyPage({ title, description, icon: Icon, phase }: EmptyPageProps) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-12 text-center">
        <Icon className="mb-3 h-10 w-10 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Coming in Phase {phase}</p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          This page is a Phase 0 placeholder. The full implementation lands in Phase {phase} of the
          v1.3 build spec — see CLAUDE.md.
        </p>
      </div>
    </div>
  );
}
