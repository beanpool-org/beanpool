/**
 * useGrowingComposer / fitComposer (fix/web-composer-grow): the arithmetic, a box that appears with words
 * it already had (the bug Marty saw: a chat opening with an empty draft was never fitted), a stylesheet's
 * own max-height, and the hidden measuring copy never left in the page.
 */
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { useRef, useState } from 'react';
import { COMPOSER_MAX_LINES, fitComposer, useGrowingComposer } from './use-growing-composer';
import { installTextareaGeometry, showsScrollbar, hidesWords, heightOf, LINE, PAD } from '../composer-grow.test-support';

let undoGeometry: () => void = () => {};
beforeEach(() => { undoGeometry = installTextareaGeometry(); });
afterEach(() => { undoGeometry(); });

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

function Composer({ open = true, style, initial = '' }: { open?: boolean; style?: React.CSSProperties; initial?: string }) {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [draft, setDraft] = useState(initial);
    useGrowingComposer(ref);
    return open
        ? <textarea ref={ref} rows={1} aria-label="box" value={draft} onChange={e => setDraft(e.target.value)} style={style} />
        : <p>closed</p>;
}

const borderBox: React.CSSProperties = { boxSizing: 'border-box', border: '1px solid black', padding: '9px 12px', lineHeight: `${LINE}px` };

describe('fitComposer', () => {
    it('border-box: the height is the words plus padding plus borders, exactly; five lines is the cap', () => {
        const { getByLabelText } = render(<Composer style={borderBox} />);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        expect(heightOf(box)).toBe(LINE + PAD + 2);
        expect(box.style.overflowY).toBe('hidden');

        fireEvent.change(box, { target: { value: lines(COMPOSER_MAX_LINES) } });
        expect(heightOf(box)).toBe(COMPOSER_MAX_LINES * LINE + PAD + 2);
        expect(box.style.overflowY).toBe('hidden');
        expect(hidesWords(box)).toBe(false);

        fireEvent.change(box, { target: { value: lines(COMPOSER_MAX_LINES + 3) } });
        expect(heightOf(box)).toBe(COMPOSER_MAX_LINES * LINE + PAD + 2);
        expect(box.style.overflowY).toBe('auto');
        expect(showsScrollbar(box)).toBe(true);
    });

    it('content-box: the height is the words alone', () => {
        const { getByLabelText } = render(<Composer style={{ ...borderBox, boxSizing: 'content-box' }} />);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        fireEvent.change(box, { target: { value: lines(2) } });
        expect(heightOf(box)).toBe(2 * LINE + PAD - 18);
        expect(showsScrollbar(box)).toBe(false);
        expect(hidesWords(box)).toBe(false);
    });

    it("a stylesheet's max-height still wins, and the words past it scroll rather than hide", () => {
        const { getByLabelText } = render(<Composer style={{ ...borderBox, maxHeight: '70px' }} />);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        fireEvent.change(box, { target: { value: lines(4) } });
        expect(heightOf(box)).toBe(70);
        expect(box.style.overflowY).toBe('auto');
        expect(hidesWords(box)).toBe(false);
    });

    it('leaves no measuring copy in the page', () => {
        const { getByLabelText } = render(<Composer style={borderBox} />);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        fireEvent.change(box, { target: { value: lines(3) } });
        fitComposer(box);
        expect(document.querySelectorAll('textarea')).toHaveLength(1);
    });
});

describe('useGrowingComposer', () => {
    it('a box that appears with the same words it had (a chat opening on an empty draft) is fitted at once', () => {
        const { getByLabelText, rerender, getByText } = render(<Composer style={borderBox} open={false} />);
        getByText('closed');
        rerender(<Composer style={borderBox} open />);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        expect(heightOf(box)).toBe(LINE + PAD + 2);
        expect(showsScrollbar(box)).toBe(false);

        // Closed and opened again: a new box, still the empty draft, fitted again.
        rerender(<Composer style={borderBox} open={false} />);
        rerender(<Composer style={borderBox} open />);
        const again = getByLabelText('box') as HTMLTextAreaElement;
        expect(again).not.toBe(box);
        expect(heightOf(again)).toBe(LINE + PAD + 2);
    });

    it('a box that opens on a long draft is that tall from the start', () => {
        const { getByLabelText } = render(<Composer style={borderBox} initial={lines(3)} />);
        expect(heightOf(getByLabelText('box') as HTMLTextAreaElement)).toBe(3 * LINE + PAD + 2);
    });

    it('works in StrictMode, where React mounts each effect twice', () => {
        const { getByLabelText } = render(<React.StrictMode><Composer style={borderBox} /></React.StrictMode>);
        const box = getByLabelText('box') as HTMLTextAreaElement;
        fireEvent.change(box, { target: { value: lines(2) } });
        expect(heightOf(box)).toBe(2 * LINE + PAD + 2);
    });
});
