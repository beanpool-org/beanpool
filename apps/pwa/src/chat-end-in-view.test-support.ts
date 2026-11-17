/**
 * Where a chat thread on the web opens, for jsdom, which lays nothing out: the page's scrollIntoView calls are recorded,
 * and what the screen shows is read from the last one. Used by the chat thread tests (deciding review of #3285: the guest
 * chat never scrolled to its newest line, so "You were removed from this chat." sat under 30 lines, out of view).
 *
 * The model: a thread that scrolls an element into view with `block: 'end'` shows that element at the bottom of the
 * screen and what sits just above it. An element is in view when it comes at or before that last scroll's element and no
 * line of the chat (a child of its role="log") lies between them: only the few controls under the lines can (the box,
 * Leave, a note), never the lines themselves.
 */
type Scroll = { el: Element; block: ScrollLogicalPosition | undefined };

const scrolls: Scroll[] = [];
let before: PropertyDescriptor | undefined;

/** Records every scrollIntoView from now until `stopRecordingScrolls`. */
export function recordScrolls(): void {
    scrolls.length = 0;
    before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value(this: HTMLElement, arg?: boolean | ScrollIntoViewOptions) {
            scrolls.push({ el: this, block: typeof arg === 'object' ? arg.block : arg === false ? 'end' : 'start' });
        },
    });
}

export function stopRecordingScrolls(): void {
    if (before) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', before);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    scrolls.length = 0;
}

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * Why `must` is out of view after the page's last scroll, or null when it is in view (the file's header). `name` is what
 * the failure calls it.
 */
export function outOfView(must: Element | null, name: string): string | null {
    if (!must) return `${name}: not drawn`;
    const last = scrolls[scrolls.length - 1];
    if (!last) return `${name}: nothing was scrolled into view, so the page opens at its top`;
    const end = last.el;
    if (last.block !== 'end') return `${name}: the last scroll put its element at the ${last.block ?? 'start'} of the screen, not the end`;
    if (!(must === end || end.contains(must) || follows(must, end))) return `${name}: the page scrolled to something above it`;
    const lines = Array.from(document.querySelectorAll('[role="log"] > *'))
        .filter((line) => !line.contains(must) && !line.contains(end) && follows(must, line) && follows(line, end));
    if (lines.length > 0) return `${name}: ${lines.length} line(s) of the chat between it and where the page scrolled`;
    return null;
}
