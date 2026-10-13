/**
 * The restore screen's word-by-word entry, shared with the old-words unlock (components/RecoveryWordsEntry.tsx;
 * DESIGN-group-history-after-rekey-fable.md §3 "the usual words UI"): what the 12 boxes hold after typing and pasting.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ StyleSheet: { create: (s: unknown) => s }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'android' } }));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => '') }));
vi.mock('../../components/WordsOnScreen', () => ({ NoScreenCapture: 'NoScreenCapture' }));

import { wordsAfterTyping, wordsFromText } from '../../components/RecoveryWordsEntry';

const empty = (): string[] => Array(12).fill('');

describe('the 12 boxes', () => {
    it('one word fills its own box, lower-cased and trimmed', () => {
        const out = wordsAfterTyping(empty(), 3, ' Apple ');
        expect(out[3]).toBe('apple');
        expect(out.filter(Boolean)).toEqual(['apple']);
    });

    it('a whole phrase typed or pasted into any box fans out across all 12 from the first', () => {
        const phrase = 'Abandon ability able about above absent absorb abstract absurd abuse access accident';
        const out = wordsAfterTyping(empty(), 7, phrase);
        expect(out).toEqual(phrase.toLowerCase().split(' '));
    });

    it('more than 12 words keep the first 12; fewer leave the rest empty', () => {
        expect(wordsFromText(Array.from({ length: 14 }, (_, i) => `w${i}`).join('  '))).toHaveLength(12);
        expect(wordsFromText('one two')).toEqual(['one', 'two', ...Array(10).fill('')]);
        expect(wordsFromText('   ')).toBeNull();
    });
});
