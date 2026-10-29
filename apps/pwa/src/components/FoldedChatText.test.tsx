/**
 * A long chat message folds with "…more" on the web (FoldedChatText.tsx; the phone's half is ChatFold.tsx).
 *
 * jsdom has no layout, so the box's heights are a model of what a browser does with a line clamp (chat-fold-layout.test-support.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FoldedChatText } from './FoldedChatText';
import { installFoldLayout, moveBubble, removeFoldLayout } from '../chat-fold-layout.test-support';

beforeEach(installFoldLayout);
afterEach(() => {
    cleanup();
    removeFoldLayout();
});

const fortyLines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long note`).join('\n');
const text = () => screen.getByTestId('chat-text');

describe('a long message folds with …more', () => {
    it('a 40-line message folds under …more, opens in place, and folds again', () => {
        render(<FoldedChatText text={fortyLines} />);
        expect(text().dataset.fold).toBe('folded');
        const more = screen.getByRole('button', { name: 'Show the whole message' });
        expect(more.textContent).toBe('…more');
        expect(more.getAttribute('aria-expanded')).toBe('false');
        expect(more.getAttribute('type')).toBe('button');

        fireEvent.click(more);
        expect(text().dataset.fold).toBe('open');
        const less = screen.getByRole('button', { name: 'Show less' });
        expect(less.textContent).toBe('less');
        expect(less.getAttribute('aria-expanded')).toBe('true');
        // The whole message is in the page whether it is folded or open: copy, find-in-page and a screen reader reach all of it.
        expect(text().textContent).toBe(fortyLines);

        fireEvent.click(less);
        expect(text().dataset.fold).toBe('folded');
        expect(screen.getByRole('button', { name: 'Show the whole message' }).textContent).toBe('…more');
        expect(text().textContent).toBe(fortyLines);
    });

    it('the control is a real button at least 44 px tall and wide', () => {
        render(<FoldedChatText text={fortyLines} />);
        const style = screen.getByRole('button', { name: 'Show the whole message' }).style;
        expect(style.minHeight).toBe('44px');
        expect(style.minWidth).toBe('44px');
    });

    it('a 3-line message never shows the control, and is just its words', () => {
        const { container } = render(<FoldedChatText text={'First line\nSecond line\nThird line'} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByTestId('chat-text')).toBeNull();
        expect(container.textContent).toBe('First line\nSecond line\nThird line');
    });

    it('a message of exactly twelve lines stays whole; a thirteenth folds it', () => {
        const lines = (n: number) => Array.from({ length: n }, (_, i) => `Line number ${i + 1} is here, in full.`).join('\n');
        const { rerender } = render(<FoldedChatText text={lines(12)} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(text().dataset.fold).toBe('whole');
        rerender(<FoldedChatText text={lines(13)} />);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('measures where the lines really break, and again when the bubble changes width', () => {
        const paragraph = 'word '.repeat(80).trim(); // 399 characters
        render(<FoldedChatText text={paragraph} />);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy(); // 13 lines at 32 a line

        // The window widens: the same words are four lines. The observer says the bubble moved.
        moveBubble(800, 100);
        expect(screen.queryByRole('button')).toBeNull();
        expect(text().dataset.fold).toBe('whole');

        moveBubble(300, 32);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('a folded message stays open through a change of width, and is measured again from open', () => {
        const paragraph = 'word '.repeat(80).trim();
        render(<FoldedChatText text={paragraph} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show the whole message' }));
        moveBubble(301.5, 32);
        expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
        expect(text().dataset.fold).toBe('open');
    });

    it('never folds a message that is not enabled (one being edited, a removed line), and folds it when it is', () => {
        const { rerender, container } = render(<FoldedChatText text={fortyLines} enabled={false} />);
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByTestId('chat-text')).toBeNull();
        expect(container.textContent).toBe(fortyLines);
        rerender(<FoldedChatText text={fortyLines} enabled />);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('measures a message again when its words change (an edit)', () => {
        const { rerender } = render(<FoldedChatText text={fortyLines} />);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
        rerender(<FoldedChatText text="Never mind, see you at nine." />);
        expect(screen.queryByRole('button')).toBeNull();
        rerender(<FoldedChatText text={fortyLines} />);
        expect(screen.getByRole('button', { name: 'Show the whole message' })).toBeTruthy();
    });

    it('draws the words as they were when they fit: in the line with the time, or a block of their own', () => {
        const medium = 'x'.repeat(60); // worth measuring, but 2 lines
        const { rerender } = render(<FoldedChatText text={medium} />);
        expect(text().dataset.fold).toBe('whole');
        expect(text().style.display).toBe('inline');
        rerender(<FoldedChatText text={medium} display="block" />);
        expect(text().style.display).toBe('block');
    });

    it('the control reads white and underlined on my own bubble, and not white on someone else\'s', () => {
        const { rerender } = render(<FoldedChatText text={fortyLines} mine />);
        const mine = screen.getByRole('button', { name: 'Show the whole message' }).style;
        expect(mine.color).toBe('rgb(255, 255, 255)');
        expect(mine.textDecoration).toBe('underline');
        rerender(<FoldedChatText text={fortyLines} />);
        const theirs = screen.getByRole('button', { name: 'Show the whole message' }).style;
        expect(theirs.color).not.toBe('rgb(255, 255, 255)');
        expect(theirs.textDecoration).not.toBe('underline');
    });
});
