import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import '../globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'RouteIQ Driver',
  description: 'Driver manifest and live GPS for RouteIQ deliveries.',
  // PWA-friendly viewport — full screen on mobile, prevent zoom on inputs.
  viewport: { width: 'device-width', initialScale: 1, maximumScale: 1 },
};

export default function DriverLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body className="min-h-screen bg-slate-50 text-slate-900">
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
