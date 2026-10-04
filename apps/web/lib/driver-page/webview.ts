/**
 * In-app browsers (owner request 4 Oct 2026, spec section 6.1). Casual and hired-truck drivers often
 * scan the QR with a QR app or Google Lens, or tap the link inside Facebook, Instagram or Snapchat.
 * Those browsers often refuse the location without asking, ignore the camera input and keep their
 * own storage, so the driver page shows a card to open the link in Chrome (Android) or Safari (iOS).
 * Pure and browser-safe.
 */

export type InAppBrowser = 'ANDROID_WEBVIEW' | 'FACEBOOK' | 'INSTAGRAM' | 'LINE' | 'SNAPCHAT';

/** The in-app browser a user agent belongs to, or null for a normal browser (Chrome, Safari, ...). */
export function inAppBrowser(ua: string | null | undefined): InAppBrowser | null {
  const s = ua ?? '';
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(s)) return 'FACEBOOK';
  if (/Instagram/.test(s)) return 'INSTAGRAM';
  if (/\bLine\//.test(s)) return 'LINE';
  if (/Snapchat/.test(s)) return 'SNAPCHAT';
  // The Android WebView marks itself with "; wv)" in the platform part.
  if (/; wv\)/.test(s)) return 'ANDROID_WEBVIEW';
  return null;
}

export function isAndroid(ua: string | null | undefined): boolean {
  return /Android/i.test(ua ?? '');
}

export function isIos(ua: string | null | undefined): boolean {
  return /iPhone|iPad|iPod/i.test(ua ?? '');
}

/**
 * The link that opens `link` in Chrome on Android, falling back to the link itself when Chrome is
 * not installed: intent://<host>/d/<token>#Intent;scheme=https;package=com.android.chrome;
 * S.browser_fallback_url=<url-encoded link>;end
 */
export function chromeIntentUrl(link: string): string {
  const u = new URL(link);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(link)};end`;
}

/**
 * Detection by a failure: the location was refused although the browser never asked (the
 * Permissions API still says "prompt"), which in-app browsers do.
 */
export function deniedWithoutPrompt(errorCode: number | null, permissionState: string | null): boolean {
  return errorCode === 1 && permissionState === 'prompt';
}
