import { SalesPage } from './sales-page';

// The salesman link's page is a SHELL (owner request 19 Oct 2026): it never reads the database, never resolves the
// token and never puts customer data in the HTML, so a link previewer that fetches the link posted in the WhatsApp
// group gets an empty page. The client reads the token from its own URL and asks GET /api/s/view with it in a
// header. Rendered per request and never cached: a cached copy would be stored under the token's path.
export const dynamic = 'force-dynamic';

export default function SalesLinkPage() {
  return <SalesPage />;
}
