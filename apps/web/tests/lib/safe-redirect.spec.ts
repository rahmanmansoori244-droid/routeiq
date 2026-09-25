/**
 * Review F11: `/login?callbackUrl=` must never become an external navigation. The check below
 * reproduces what Next 14's app router does with router.replace(href) (app-router useNavigate +
 * navigate-reducer): url = new URL(addBasePath(href), location.href); a different origin means a
 * full `location.replace(url)`, which is how javascript: and //evil.example values escaped.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { safeCallbackUrl } from '@/lib/safe-redirect';

const req = createRequire(import.meta.url);
const { addBasePath } = req('next/dist/client/add-base-path') as { addBasePath: (p: string) => string };

const ORIGIN = 'https://routeiq.example';
const LOCATION = `${ORIGIN}/login?callbackUrl=x`;
const BS = String.fromCharCode(92); // backslash

function nextNavigate(href: string) {
  const url = new URL(addBasePath(href), LOCATION);
  return url.origin !== new URL(LOCATION).origin
    ? { kind: 'location.replace' as const, target: url.toString() }
    : { kind: 'spa' as const, target: url.pathname + url.search + url.hash };
}

const HOSTILE = [
  'javascript:alert(document.domain)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'https://evil.example/phish',
  '//evil.example/phish',
  `/${BS}evil.example/phish`,
  `${BS}${BS}evil.example`,
  '/\t/evil.example',
  'https://routeiq.example@evil.example/',
  'https://routeiq.example.evil.example/',
  'http://routeiq.example/t/x', // scheme downgrade = different origin
  '/api/users', // same origin but not a page
];

const BENIGN: [string, string][] = [
  ['/', '/'],
  ['/t/nmwc/dispatch', '/t/nmwc/dispatch'],
  ['/t/nmwc/dispatch?date=2026-09-25&depot=abc', '/t/nmwc/dispatch?date=2026-09-25&depot=abc'],
  [`${ORIGIN}/t/nmwc`, '/t/nmwc'],
  ['/admin', '/admin'],
  ['/t/nmwc/dispatch#plan', '/t/nmwc/dispatch#plan'],
];

describe('safeCallbackUrl', () => {
  it('the unsanitised values really are dangerous under Next navigation (guards the test model)', () => {
    expect(nextNavigate('javascript:alert(document.domain)').kind).toBe('location.replace');
    expect(nextNavigate('//evil.example/phish').target).toBe('https://evil.example/phish');
    expect(nextNavigate(`/${BS}evil.example/phish`).target).toBe('https://evil.example/phish');
  });

  it.each(HOSTILE)('reduces hostile %j to "/"', (input) => {
    expect(safeCallbackUrl(input, ORIGIN)).toBe('/');
  });

  it.each(BENIGN)('keeps benign %j as %j', (input, out) => {
    expect(safeCallbackUrl(input, ORIGIN)).toBe(out);
  });

  it('never produces an external navigation, for hostile or benign input', () => {
    for (const v of [...HOSTILE, ...BENIGN.map((b) => b[0])]) {
      expect(nextNavigate(safeCallbackUrl(v, ORIGIN)).kind, v).toBe('spa');
    }
  });

  it('falls back on empty, missing, oversized or traversal input, and honours a custom fallback', () => {
    expect(safeCallbackUrl(null, ORIGIN)).toBe('/');
    expect(safeCallbackUrl(undefined, ORIGIN)).toBe('/');
    expect(safeCallbackUrl('', ORIGIN)).toBe('/');
    expect(safeCallbackUrl(`/t/${'a'.repeat(3000)}`, ORIGIN)).toBe('/');
    expect(safeCallbackUrl('/t/../api/users', ORIGIN)).toBe('/');
    expect(safeCallbackUrl('/adminx', ORIGIN)).toBe('/');
    expect(safeCallbackUrl('//evil.example', ORIGIN, '/t/nmwc')).toBe('/t/nmwc');
  });

  it('keeps the dispatch deep-link query string that the middleware now preserves', () => {
    const fromMiddleware = '/t/nmwc/dispatch?date=2026-09-26&depot=MCT';
    expect(safeCallbackUrl(fromMiddleware, 'http://routeiq.internal')).toBe(fromMiddleware);
  });
});
