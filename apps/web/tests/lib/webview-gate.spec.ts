/**
 * In-app browsers (owner request 4 Oct 2026, spec section 6.1): the user-agent detector and the
 * "Open in Chrome" intent link. Plain Chrome and Safari are never flagged.
 */
import { describe, expect, it } from 'vitest';
import { chromeIntentUrl, deniedWithoutPrompt, inAppBrowser, isAndroid, isIos } from '@/lib/driver-page/webview';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  webview: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 12; SM-A125F Build/SP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/447.0.0.0;]',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/430.0]',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.1.0',
  snapchat: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.0',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

describe('inAppBrowser', () => {
  it('flags the Android WebView, Facebook, Instagram, Line and Snapchat', () => {
    expect(inAppBrowser(UA.webview)).toBe('ANDROID_WEBVIEW');
    expect(inAppBrowser(UA.facebookAndroid)).toBe('FACEBOOK');
    expect(inAppBrowser(UA.facebookIos)).toBe('FACEBOOK');
    expect(inAppBrowser(UA.instagram)).toBe('INSTAGRAM');
    expect(inAppBrowser(UA.line)).toBe('LINE');
    expect(inAppBrowser(UA.snapchat)).toBe('SNAPCHAT');
  });

  it('never flags plain Chrome or Safari', () => {
    expect(inAppBrowser(UA.chromeAndroid)).toBeNull();
    expect(inAppBrowser(UA.safari)).toBeNull();
    expect(inAppBrowser(UA.desktopChrome)).toBeNull();
    expect(inAppBrowser('')).toBeNull();
    expect(inAppBrowser(null)).toBeNull();
  });

  it('tells Android from iOS', () => {
    expect(isAndroid(UA.webview)).toBe(true);
    expect(isIos(UA.webview)).toBe(false);
    expect(isIos(UA.instagram)).toBe(true);
  });
});

describe('chromeIntentUrl', () => {
  it('opens the same link in Chrome, falling back to the link itself (URL-encoded)', () => {
    const link = 'https://routeiq.example/d/Ab3_dE5-gH7iJ9kL1mN3oP5q';
    const u = chromeIntentUrl(link);
    expect(u).toBe(
      `intent://routeiq.example/d/Ab3_dE5-gH7iJ9kL1mN3oP5q#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(link)};end`,
    );
    expect(decodeURIComponent(/S\.browser_fallback_url=([^;]+);end$/.exec(u)![1]!)).toBe(link);
  });

  it('a refusal of the location without any prompt counts as an in-app browser', () => {
    expect(deniedWithoutPrompt(1, 'prompt')).toBe(true);
    expect(deniedWithoutPrompt(1, 'denied')).toBe(false);
    expect(deniedWithoutPrompt(3, 'prompt')).toBe(false);
  });
});
