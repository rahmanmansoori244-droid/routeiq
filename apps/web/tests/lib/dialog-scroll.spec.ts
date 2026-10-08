/**
 * Dialogs taller than the window (review of 8 Oct 2026, ui-rest-4). DialogContent had no height
 * limit and no scrolling, and Radix locks the page's own scroll while a dialog is open: the Edit
 * truck dialog (about 1,180 px) put its title above the window and Save below it on a laptop
 * (1366x768, also 1920x1080 at 100%), with no way to reach them. Now the content is at most 90% of
 * the window high and scrolls inside itself, and its header and footer are sticky, so the title and
 * Save / Cancel stay on screen (checked in a browser harness at 1366x657 with the app's compiled
 * Tailwind; there is no DOM here, so this spec keeps the classes that do it).
 *
 * The header and footer stick where the content's p-6 puts them anyway (a sticky box stops at the
 * scroll container's padding: top-0 / bottom-0) and use no margins, so a dialog that fits the window
 * looks exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { elements } from './hook-host';
import { DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AlertDialogContent } from '@/components/ui/alert-dialog';

const classesOf = (className: string) => new Set(className.split(/\s+/));

/** The className of the element a forwardRef content component puts on screen (its Radix Content). */
function contentClasses(Comp: any, props: Record<string, unknown>): Set<string> {
  const tree = Comp.render({ ...props, children: null }, null);
  const el = elements(tree).find((e) => typeof e.props?.className === 'string' && e.props.className.includes('fixed') && e.props.className.includes('p-6'));
  return classesOf(el.props.className);
}

describe('dialogs scroll inside themselves (ui-rest-4)', () => {
  it('DialogContent is at most 90% of the window high and scrolls (also with a width from the call site)', () => {
    for (const className of [undefined, 'sm:max-w-lg', 'max-w-2xl']) {
      const c = contentClasses(DialogContent, { className });
      expect(c.has('max-h-[90dvh]'), String(className)).toBe(true);
      expect(c.has('overflow-y-auto'), String(className)).toBe(true);
      expect(c.has('p-6')).toBe(true); // the sticky offsets below assume the content's padding
    }
  });

  it('AlertDialogContent too', () => {
    const c = contentClasses(AlertDialogContent, {});
    expect(c.has('max-h-[90dvh]')).toBe(true);
    expect(c.has('overflow-y-auto')).toBe(true);
  });

  it('the close button stays above the sticky header', () => {
    const tree = (DialogContent as any).render({ children: null }, null);
    const close = elements(tree).find((e) => typeof e.props?.className === 'string' && e.props.className.includes('absolute right-4 top-4'));
    expect(classesOf(close.props.className).has('z-20')).toBe(true);
  });

  it('the header sticks at the top and the footer at the bottom, on the dialog background, with no margins', () => {
    const header = classesOf((DialogHeader as any)({}).props.className);
    expect([...header]).toEqual(expect.arrayContaining(['sticky', 'top-0', 'z-10', 'bg-background']));
    const footer = classesOf((DialogFooter as any)({}).props.className);
    expect([...footer]).toEqual(expect.arrayContaining(['sticky', 'bottom-0', 'z-10', 'bg-background']));
    // Layout-neutral: no margin or padding of their own (a margin would move every dialog's content).
    for (const c of [...header, ...footer]) expect(c, c).not.toMatch(/^-?(m|p)[trblxy]?-/);
    // A call site's own layout classes keep the sticky footer (outcome-dialog.tsx).
    const custom = classesOf((DialogFooter as any)({ className: 'flex-wrap gap-2 sm:justify-between' }).props.className);
    expect([...custom]).toEqual(expect.arrayContaining(['sticky', 'bottom-0', 'z-10', 'bg-background', 'flex-wrap', 'sm:justify-between']));
  });
});
