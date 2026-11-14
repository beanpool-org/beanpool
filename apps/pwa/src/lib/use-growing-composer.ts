import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * A chat composer that grows with its words: the web's Messages box (a DM, a request, a group chat) and an
 * event's chat. Marty, 14 Nov 2026, on a web DM: "a little vertical bar showing? what is this?" It was a
 * scrollbar: the box sat at a fixed 40px, a pixel short of its own one line, so even an empty box scrolled.
 *
 * The box is one line tall when empty, the same as with one line of words, a line taller for each line of
 * words up to COMPOSER_MAX_LINES, and it scrolls, with a scrollbar, only past that. It shrinks back when the
 * words go. Below the cap nothing scrolls (overflow hidden), so a sub-pixel rounding at a zoom or a large text
 * size can never draw a bar. The cap is in lines, not pixels, so a larger text size still gets five lines.
 * The box's hint should stay on its one line (class placeholder:truncate): it is never measured.
 */
export const COMPOSER_MAX_LINES = 5;

/** What decides how tall the words stand and where they wrap; the measuring copy takes these from the box. */
const SIZING_STYLE = [
    'box-sizing', 'width',
    'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-stretch', 'font-kerning',
    'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing',
    'text-indent', 'text-transform', 'text-rendering', 'tab-size', 'white-space', 'word-break', 'overflow-wrap',
    'hyphens', 'direction',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
] as const;

let measurer: HTMLTextAreaElement | null = null;

/**
 * A hidden copy of the box, height 0, so its scrollHeight is exactly what the words need. The box itself is
 * never collapsed to measure it: collapsing it for a moment makes the chat above it taller, and a chat read
 * to its last line would be left scrolled up by the difference.
 */
function measurerLike(cs: CSSStyleDeclaration): HTMLTextAreaElement {
    if (!measurer) {
        measurer = document.createElement('textarea');
        measurer.setAttribute('aria-hidden', 'true');
        measurer.tabIndex = -1;
        measurer.rows = 1;
    }
    const s = measurer.style;
    for (const name of SIZING_STYLE) s.setProperty(name, cs.getPropertyValue(name));
    s.setProperty('border-style', 'solid');
    s.setProperty('position', 'absolute');
    s.setProperty('top', '0');
    s.setProperty('left', '0');
    s.setProperty('visibility', 'hidden');
    s.setProperty('pointer-events', 'none');
    s.setProperty('overflow', 'hidden');
    s.setProperty('height', '0');
    s.setProperty('min-height', '0');
    s.setProperty('max-height', 'none');
    return measurer;
}

function px(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

/** Sizes the box to its words now: one line up to `maxLines`, then a scrollbar. */
export function fitComposer(el: HTMLTextAreaElement, maxLines: number = COMPOSER_MAX_LINES): void {
    const cs = window.getComputedStyle(el);
    const copy = measurerLike(cs);
    document.body.appendChild(copy);
    // The words, or one line while there are none. Never the hint's lines: a hint that wraps (a long
    // translation at 320px and 130% text) would make the empty box tall and drop it on the first letter.
    // The composer keeps its hint to one line instead (placeholder:truncate).
    copy.value = el.value || 'x';
    const needs = copy.scrollHeight;
    copy.value = Array.from({ length: maxLines }, () => 'x').join('\n');
    const cap = copy.scrollHeight;
    copy.remove();

    // scrollHeight counts the words and the padding; the box's own height counts borders too (border-box)
    // or neither (content-box).
    const extra = cs.boxSizing === 'border-box'
        ? px(cs.borderTopWidth) + px(cs.borderBottomWidth)
        : -(px(cs.paddingTop) + px(cs.paddingBottom));
    let scrolls = needs > cap;
    let height = (scrolls ? cap : needs) + extra;
    // A stylesheet's own max-height still wins, and then the words past it scroll: never cut off unseen.
    const ceiling = parseFloat(cs.maxHeight);
    if (Number.isFinite(ceiling) && height > ceiling) {
        height = ceiling;
        scrolls = true;
    }
    el.style.height = `${height}px`;
    el.style.overflowY = scrolls ? 'auto' : 'hidden';
}

/**
 * Keeps the textarea in `ref` sized to its words. It refits when the box first appears (a chat opening),
 * when its words change (typing, a send clearing it), and when its width changes (a zoom, a turned
 * phone, a button appearing beside it), since a new width wraps the words anew. The box's own style must
 * leave height and overflow to this; the keys are the composer's own business.
 */
export function useGrowingComposer(ref: RefObject<HTMLTextAreaElement | null>, maxLines: number = COMPOSER_MAX_LINES): void {
    const fitted = useRef<{ el: HTMLTextAreaElement | null; words: string | null }>({ el: null, words: null });
    const stopWatching = useRef<(() => void) | null>(null);

    // Every render, but it only measures when the box or its words changed; before paint, so an
    // opening chat never shows the box at the wrong height.
    useLayoutEffect(() => {
        const el = ref.current;
        const was = fitted.current;
        if (el !== was.el) {
            stopWatching.current?.();
            stopWatching.current = el ? watchWidth(el, maxLines) : null;
        }
        if (!el) {
            fitted.current = { el: null, words: null };
            return;
        }
        const words = el.value;
        if (el === was.el && words === was.words) return;
        fitted.current = { el, words };
        fitComposer(el, maxLines);
    });

    useEffect(() => () => {
        stopWatching.current?.();
        stopWatching.current = null;
        // React may mount the same box again (StrictMode): it is then fitted and watched afresh.
        fitted.current = { el: null, words: null };
    }, []);
}

function watchWidth(el: HTMLTextAreaElement, maxLines: number): (() => void) | null {
    if (typeof ResizeObserver === 'undefined') return null;
    let width = -1;
    let frame = 0;
    const observer = new ResizeObserver((entries) => {
        const now = entries[entries.length - 1]?.contentRect.width ?? width;
        if (now === width) return;
        width = now;
        // Next frame: refitting inside the callback would resize what is being observed, mid-notification.
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitComposer(el, maxLines));
    });
    observer.observe(el);
    return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
    };
}
