import { describe, expect, it } from 'vitest';
import { CHAT_FOLD_LINES, mayFoldChatText } from '../chat-fold.js';

const linesOf = (n: number, line = 'a') => Array.from({ length: n }, () => line).join('\n');

describe('a long chat message folds: which texts are worth measuring', () => {
    it('folds past twelve lines, on the phone and the web alike', () => {
        expect(CHAT_FOLD_LINES).toBe(12);
    });

    it('a short message is never measured, however it is worded', () => {
        expect(mayFoldChatText('')).toBe(false);
        expect(mayFoldChatText(null)).toBe(false);
        expect(mayFoldChatText(undefined)).toBe(false);
        expect(mayFoldChatText('See you at the market at nine.')).toBe(false);
        expect(mayFoldChatText('one\ntwo\nthree')).toBe(false);
        // Twelve lines is the most that stays whole: the thirteenth is what folds.
        expect(mayFoldChatText(linesOf(12))).toBe(false);
    });

    it('a text that could run past twelve lines at some width is worth measuring', () => {
        expect(mayFoldChatText(linesOf(13))).toBe(true);
        expect(mayFoldChatText(linesOf(40, 'line'))).toBe(true);
        expect(mayFoldChatText('word '.repeat(60))).toBe(true);
    });

    it('line breaks and wrapping add up: a paragraph is a line, and one more for each four characters it may wrap to', () => {
        // 48 characters wrap to at most twelve lines, which fits; the 49th can make a thirteenth.
        expect(mayFoldChatText('x'.repeat(48))).toBe(false);
        expect(mayFoldChatText('x'.repeat(49))).toBe(true);
        // Five blank lines after a paragraph each spend a line.
        expect(mayFoldChatText(`${'x'.repeat(20)}\n\n\n\n\n`)).toBe(false);
        expect(mayFoldChatText(`${'x'.repeat(32)}\n\n\n\n\n`)).toBe(true);
    });
});
