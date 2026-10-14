/**
 * useDotOnlyChip's wiring, with the layout stubbed (jsdom lays nothing out): a header that mounts after the first render
 * with the same title, as App's does after "Loading...", is measured, and the chip goes to its dot only where the title
 * wouldn't fit beside its words. The real layout at every width and text size is e2e/tour-check.mjs's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HeaderTitle, useDotOnlyChip } from './HeaderControls';
import { SyncChip } from './SyncChip';

/** The title's words' width; the room beside the chip's words is 100 px (the title's box) and the words are 50. */
let wordsOfTitle = 0;
const rangeRect = Range.prototype.getBoundingClientRect;

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const el = this as HTMLElement;
        const width = el.tagName === 'HEADER' ? 300 : el.dataset.chipWords !== undefined ? 50 : el.querySelector(':scope > [data-testid="header-title"]') ? 100 : 0;
        return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    Range.prototype.getBoundingClientRect = function () {
        return { width: wordsOfTitle, height: 20, top: 0, left: 0, right: wordsOfTitle, bottom: 20, x: 0, y: 0, toJSON() {} } as DOMRect;
    };
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Range.prototype.getBoundingClientRect = rangeRect;
});

function Header({ ready, title }: { ready: boolean; title: string }) {
    const [ref, dotOnly] = useDotOnlyChip(title);
    if (!ready) return <p>Loading...</p>;
    return (
        <header ref={ref}>
            <SyncChip mode="online" ago={null} pulsing={false} stacked dotOnly={dotOnly} />
            <HeaderTitle title={title} />
        </header>
    );
}

describe('useDotOnlyChip', () => {
    it('measures a header that mounts after loading with the same title: too wide beside the words, the dot alone', () => {
        wordsOfTitle = 120; // + the title's 12 px of padding: 132 > 100
        const { rerender } = render(<Header ready={false} title="Commons" />);
        rerender(<Header ready title="Commons" />);
        expect(screen.getByTestId('sync-chip').dataset.dotOnly).toBe('true');
    });

    it('keeps the words where the title fits beside them', () => {
        wordsOfTitle = 60; // 72 <= 100
        render(<Header ready title="Home" />);
        expect(screen.getByTestId('sync-chip').dataset.dotOnly).toBe('false');
    });
});
