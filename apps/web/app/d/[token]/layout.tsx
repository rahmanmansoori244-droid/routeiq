import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The driver page's frame (owner request 4 Oct 2026): no tenant navigation, a generic title, no
 * description and no preview tags (a link previewer that fetches a forwarded link learns nothing),
 * never indexed, and no Referer (the token is in this page's path). next.config.js sends the same
 * as headers for /d/ and /api/d/.
 */
export const metadata: Metadata = {
  title: 'RouteIQ - driver page',
  description: null,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'no-referrer',
  openGraph: null,
  twitter: null,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function DriverLinkLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100 text-slate-900">{children}</div>;
}
