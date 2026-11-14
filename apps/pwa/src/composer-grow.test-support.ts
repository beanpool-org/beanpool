/**
 * A browser's textarea arithmetic for jsdom, which lays nothing out (scrollHeight and clientHeight are
 * always 0 there). Used by the chat composer tests (fix/web-composer-grow, Marty 14 Nov 2026: "a little
 * vertical bar showing? what is this?").
 *
 * The model: every line of words is LINE px tall and the box adds PAD px of padding around them, as a
 * browser does. A box with no height of its own is one row tall (rows={1}). clientHeight is the box's
 * height less its borders (border-box) or plus its padding (content-box), read from the same computed
 * style the code under test reads, so the two always agree on what "fits" means. Lines are the text's
 * own newlines; nothing wraps.
 */
export const LINE = 21;
export const PAD = 18;

function px(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function linesOf(el: HTMLTextAreaElement): number {
    return Math.max(1, (el.value || el.placeholder || '').split('\n').length);
}

function clientHeightOf(el: HTMLTextAreaElement): number {
    const own = parseFloat(el.style.height);
    if (!Number.isFinite(own)) return LINE + PAD;
    const cs = window.getComputedStyle(el);
    const inner = cs.boxSizing === 'border-box'
        ? own - px(cs.borderTopWidth) - px(cs.borderBottomWidth)
        : own + px(cs.paddingTop) + px(cs.paddingBottom);
    return Math.max(0, inner);
}

/** Gives every textarea a browser's scrollHeight and clientHeight; returns the undo. */
export function installTextareaGeometry(): () => void {
    const proto = HTMLTextAreaElement.prototype;
    Object.defineProperty(proto, 'clientHeight', {
        configurable: true,
        get(this: HTMLTextAreaElement) { return clientHeightOf(this); },
    });
    Object.defineProperty(proto, 'scrollHeight', {
        configurable: true,
        get(this: HTMLTextAreaElement) { return Math.max(clientHeightOf(this), linesOf(this) * LINE + PAD); },
    });
    return () => {
        // Both live on Element.prototype in jsdom; dropping the textarea's own copies restores them.
        delete (proto as unknown as Record<string, unknown>).clientHeight;
        delete (proto as unknown as Record<string, unknown>).scrollHeight;
    };
}

/** What the person sees: a scrollbar shows when the box scrolls and its words are taller than it. */
export function showsScrollbar(el: HTMLTextAreaElement): boolean {
    // A textarea scrolls by default (overflow: auto) unless something says otherwise.
    const overflow = el.style.overflowY || el.style.overflow || 'auto';
    return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight;
}

/** Words cut off with no way to scroll to them: never acceptable. */
export function hidesWords(el: HTMLTextAreaElement): boolean {
    const overflow = el.style.overflowY || el.style.overflow || 'auto';
    return overflow === 'hidden' && el.scrollHeight > el.clientHeight;
}

export function heightOf(el: HTMLTextAreaElement): number {
    return parseFloat(el.style.height);
}
