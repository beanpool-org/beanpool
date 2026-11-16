import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdInView } from './hold-in-view';

/** A row whose place on the screen the test sets, and which counts its scrolls back into view. */
function row(top = 200) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const at = { top };
    el.getBoundingClientRect = () => ({ top: at.top, bottom: at.top + 300, left: 0, right: 320, width: 320, height: 300, x: 0, y: at.top, toJSON: () => ({}) });
    const scrolls: unknown[] = [];
    el.scrollIntoView = (o?: boolean | ScrollIntoViewOptions) => { scrolls.push(o); at.top = 200; };
    return { el, at, scrolls };
}

describe('holdInView: a landed row stays in view while the page settles (walk of 16 Nov 2026)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

    it('a card drawn above it pushes it down: it is brought back, the same way the landing put it', () => {
        const r = row();
        holdInView(r.el, { block: 'center' });
        vi.advanceTimersByTime(300);
        expect(r.scrolls).toEqual([]);
        r.at.top = 950; // the new-account card arrives above it
        vi.advanceTimersByTime(100);
        expect(r.scrolls).toEqual([{ block: 'center' }]);
        vi.advanceTimersByTime(500);
        expect(r.scrolls).toHaveLength(1);
    });

    it('a row that never moves is never scrolled', () => {
        const r = row();
        holdInView(r.el);
        vi.advanceTimersByTime(3000);
        expect(r.scrolls).toEqual([]);
    });

    it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('the member\'s own %s ends it: the row is left where they take the page', (kind) => {
        const r = row();
        holdInView(r.el);
        window.dispatchEvent(new Event(kind));
        r.at.top = 950;
        vi.advanceTimersByTime(3000);
        expect(r.scrolls).toEqual([]);
    });

    it('it ends after its time, and on its stop', () => {
        const late = row();
        holdInView(late.el, { ms: 1000 });
        vi.advanceTimersByTime(1000);
        late.at.top = 950;
        vi.advanceTimersByTime(2000);
        expect(late.scrolls).toEqual([]);

        const stopped = row();
        const stop = holdInView(stopped.el);
        stop();
        stopped.at.top = 950;
        vi.advanceTimersByTime(2000);
        expect(stopped.scrolls).toEqual([]);
    });

    it('a row taken off the page ends it, and nothing is scrolled', () => {
        const r = row();
        holdInView(r.el);
        r.el.remove();
        r.at.top = 950;
        vi.advanceTimersByTime(2000);
        expect(r.scrolls).toEqual([]);
    });
});
