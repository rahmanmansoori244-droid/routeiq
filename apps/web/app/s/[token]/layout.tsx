import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The salesman link page's frame (owner request 19 Oct 2026): no tenant navigation, a generic title, no description
 * and no preview tags (a link previewer that fetches the link from the WhatsApp group learns nothing), never
 * indexed, and the Referer cut to the origin (the token is in this page's path; the map tiles still get an origin,
 * critique item 16). next.config.js sends the same as headers for /s/ and /api/s/, with no-store.
 */
export const metadata: Metadata = {
  title: 'RouteIQ - deliveries',
  description: null,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'strict-origin',
  openGraph: null,
  twitter: null,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function SalesLinkLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100 text-slate-900">{children}</div>;
}
