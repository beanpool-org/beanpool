/**
 * Keeps an element where a landing put it while the page around it is still being drawn (global yes Y2's landing on Home's
 * row, walked 16 Nov 2026). A card drawn above the row after the landing's scroll, such as App's "Your account is new" card,
 * which reads on its own and can arrive after Home, pushed the landed row below a 320 px screen, its Join in focus but out
 * of sight. A browser with scroll anchoring sometimes made up for it; Safari has none.
 *
 * For `ms` after the landing it looks every `everyMs` at where the element is on the screen, and when it has moved since the
 * landing left it, brings it back into view the same way. The member's own wheel, touch, pointer or key ends it at once, so it
 * never fights a scroll they make. Returns a stop for whoever goes first (an unmount, a newer landing).
 */
const MEMBER_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export function holdInView(el: HTMLElement, opts: { ms?: number; everyMs?: number; block?: ScrollLogicalPosition } = {}): () => void {
    const { ms = 2500, everyMs = 100, block = 'center' } = opts;
    let landedAt = el.getBoundingClientRect().top;
    let done = false;
    const look = () => {
        if (done) return;
        if (!el.isConnected) return stop();
        const top = el.getBoundingClientRect().top;
        if (Math.abs(top - landedAt) <= 2) return;
        try { el.scrollIntoView({ block }); } catch { /* an old browser: the row is still on the card */ }
        landedAt = el.getBoundingClientRect().top;
    };
    const timer = setInterval(look, everyMs);
    const until = setTimeout(() => stop(), ms);
    function stop(): void {
        if (done) return;
        done = true;
        clearInterval(timer);
        clearTimeout(until);
        for (const kind of MEMBER_MOVES) window.removeEventListener(kind, stop, true);
    }
    for (const kind of MEMBER_MOVES) window.addEventListener(kind, stop, { capture: true, passive: true });
    return stop;
}
