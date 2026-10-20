import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The salesman link page's frame (owner request 19 Oct 2026): no tenant navigation, a generic title, no description
 * and no preview tags (a link previewer that fetches the link from the WhatsApp group learns nothing), never
 * indexed, and no Referer (the token is in this page's path, critique item 16; the page has no map since 20 Oct
 * 2026). next.config.js sends the same as headers for /s/ and /api/s/, with no-store. The page itself sets its
 * language and direction (English, Arabic, Urdu: sales-page.tsx), and its title in that language in the browser
 * (a previewer runs no script and keeps this generic one).
 */
export const metadata: Metadata = {
  title: 'RouteIQ - deliveries',
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

export default function SalesLinkLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100 text-slate-900">{children}</div>;
}
