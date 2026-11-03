// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { ScrollHintRow } from './ScrollHintRow';

afterEach(cleanup);

/** jsdom lays nothing out: a 200px row of 100px chips, the row at x 0..200, each chip at its place less the scroll. */
function fakeLayout(row: HTMLElement) {
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 400 });
    row.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Array.from(row.children).forEach((chip, i) => {
        (chip as HTMLElement).getBoundingClientRect = () => {
            const left = i * 100 - row.scrollLeft;
            return { left, right: left + 100, width: 100, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON() {} } as DOMRect;
        };
    });
}

function Row() {
    const [on, setOn] = useState(0);
    return (
        <ScrollHintRow testId="row">
            {[0, 1, 2, 3].map(i => <button key={i} type="button" aria-pressed={on === i} onClick={() => setOn(i)}>chip {i}</button>)}
        </ScrollHintRow>
    );
}

describe('ScrollHintRow brings a newly chosen chip fully into view, clear of the ›', () => {
    it('a chip chosen under the › is scrolled out from under it (36px clear of the right edge)', () => {
        const view = render(<Row />);
        const row = view.getByTestId('row');
        fakeLayout(row);
        // chip 1 sits at 100..200: its right edge is under the › (which covers 172..200).
        act(() => { view.getByText('chip 1').click(); });
        expect(row.scrollLeft).toBe(36);
    });

    it('a chip chosen past the left edge is scrolled back', () => {
        const view = render(<Row />);
        const row = view.getByTestId('row');
        fakeLayout(row);
        row.scrollLeft = 150;
        act(() => { view.getByText('chip 1').click(); });
        expect(row.scrollLeft).toBe(100);
    });

    it('a chip already clear of both edges leaves the row where the member put it', () => {
        const view = render(<Row />);
        const row = view.getByTestId('row');
        fakeLayout(row);
        row.scrollLeft = 100;
        // chip 1 now sits at 0..100: inside the row and clear of the ›.
        act(() => { view.getByText('chip 1').click(); });
        expect(row.scrollLeft).toBe(100);
    });
});
