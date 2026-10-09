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
 *
 * Review of da76343: the Close (X) button was absolute inside the scrolling content, so it scrolled
 * away with the text (250 px above the window in Edit truck at 1366x657, scrolled 300 px). Now the
 * dialog scrolls in a box inside it and the X sits outside that box, in the dialog's own corner.
 */
import { describe, expect, it } from 'vitest';
import { elements, textOf } from './hook-host';
import { DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { AlertDialogContent } from '@/components/ui/alert-dialog';

const classesOf = (className: string) => new Set(className.split(/\s+/));

/** The className of the element a forwardRef content component puts on screen (its Radix Content). */
function contentClasses(Comp: any, props: Record<string, unknown>): Set<string> {
  const tree = Comp.render({ ...props, children: null }, null);
  const el = elements(tree).find((e) => typeof e.props?.className === 'string' && e.props.className.includes('fixed') && e.props.className.includes('p-6'));
  return classesOf(el.props.className);
}

/** DialogContent's parts: the Radix Content (the dialog on screen), the boxes that scroll, and the Close (X) button. */
function dialogParts(props: Record<string, unknown> = {}) {
  const tree = (DialogContent as any).render({ ...props, children: 'BODY' }, null);
  const els = elements(tree);
  const withClass = (c: string) => els.filter((e) => typeof e.props?.className === 'string' && classesOf(e.props.className).has(c));
  const content = withClass('fixed')[0];
  const scrolling = withClass('overflow-y-auto');
  const close = els.find((e) => typeof e.props?.className === 'string' && e.props.className.includes('absolute right-4 top-4'));
  return { content, scrolling, close };
}

describe('dialogs scroll inside themselves (ui-rest-4)', () => {
  it('DialogContent is at most 90% of the window high and scrolls (also with a width from the call site)', () => {
    for (const className of [undefined, 'sm:max-w-lg', 'max-w-2xl']) {
      const { content, scrolling } = dialogParts({ className });
      const c = classesOf(content.props.className);
      expect(c.has('max-h-[90dvh]'), String(className)).toBe(true);
      if (className) expect(c.has(className), className).toBe(true);
      // One box scrolls, and the dialog's content is in it.
      expect(scrolling, String(className)).toHaveLength(1);
      expect(textOf(scrolling[0])).toBe('BODY');
      // The sticky offsets below assume the scrolling box's padding; the content keeps its gap-4 grid.
      expect([...classesOf(scrolling[0].props.className)]).toEqual(expect.arrayContaining(['grid', 'gap-4', 'p-6']));
    }
  });

  it('the Close (X) button stays in view when the dialog is scrolled: it is outside the box that scrolls (review of da76343)', () => {
    const { content, scrolling, close } = dialogParts();
    expect(close).toBeDefined();
    // Before: the dialog itself scrolled (overflow-y-auto on it), with the X absolute inside it.
    expect(classesOf(content.props.className).has('overflow-y-auto')).toBe(false);
    expect(scrolling).toHaveLength(1);
    expect(elements(scrolling[0].props.children)).not.toContain(close);
    // In the dialog's own corner: a direct child of the Radix Content, beside the scrolling box.
    expect([content.props.children].flat()).toEqual(expect.arrayContaining([scrolling[0], close]));
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
