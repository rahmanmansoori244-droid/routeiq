import { DriverPage } from './driver-page';

// The QR landing page is a SHELL (owner request 4 Oct 2026, spec section 6.1): it never reads the
// database, never resolves the token and never puts customer data in the HTML, so a link previewer
// that fetches a forwarded link gets an empty page. The client reads the token from its own URL and
// asks GET /api/d/manifest with it in a header. Rendered per request and never cached: a cached
// copy would be stored under the token's path.
export const dynamic = 'force-dynamic';

export default function DriverLinkPage() {
  return <DriverPage />;
}
