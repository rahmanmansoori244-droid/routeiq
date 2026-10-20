/**
 * The salesman page's version (review of 20 Oct 2026). Browser-safe: the page (lib/sales-page/api.ts) sends it on
 * every request as `X-Sales-Page`; GET /api/s/view (day-read.ts salesView) answers a request without it, or with an
 * older one, 410 LINK_REPLACED with the link's date, before reading anything.
 *
 * Why: the page stays open all day and refreshes every minute, and a deploy does not reload it. The page of 19 Oct
 * 2026 (#89, no version) reads trucks, positions and deliveries that the simple answer no longer has, and would crash
 * on its next refresh ("Something went wrong", again on Try again). With this answer it shows its own full-page "This
 * link was replaced by a newer one. Use the newest link in your group, or ask the office." and stops asking; opening
 * the link again loads the current page. Raise the version whenever the answer changes in a way an open older page
 * cannot read.
 */
export const SALES_PAGE_HEADER = 'X-Sales-Page';
export const SALES_PAGE_VERSION = 2;

/** The page's version header says this version or a newer one. */
export function salesPageCurrent(raw: string | null | undefined): boolean {
  const text = String(raw ?? '').trim();
  if (!/^\d{1,4}$/.test(text)) return false;
  return Number(text) >= SALES_PAGE_VERSION;
}
