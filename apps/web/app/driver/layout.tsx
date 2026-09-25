import type { ReactNode } from 'react';

export const metadata = {
  title: 'RouteIQ Driver',
  description: 'The RouteIQ driver app is retired.',
};

export default function DriverLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50 text-slate-900">{children}</div>;
}
