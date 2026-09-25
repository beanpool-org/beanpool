/**
 * "Add your 12 words to this phone": what View Recovery Phrase opens on a phone that has none.
 *
 * A phone restored with a sign-in, from a copy made before copies carried the words, has the key but not the
 * words, and they can't be rebuilt from it. A member who has them written down types them here; the identity
 * module keeps them only if they are this account's (identity.ts `addMnemonicToIdentity`, through the same check
 * as the owners' "Check your 12 words"). Everything here is the typing: twelve boxes, checked against the word
 * list as the member goes, forgiving case and spacing, and a paste of the whole phrase into any box spreads it
 * across all twelve.
 *
 * Nothing here or in the save reaches a network.
 */
import { BIP39_ENGLISH, normaliseRecoveryWords } from '@beanpool/core';
import { hasMnemonic, type BeanPoolIdentity } from './identity';
import { NO_WORDS_VIEW_LINE } from './no-words-copy';

/**
 * What View Recovery Phrase (Settings) and Show My 12 Recovery Words (Account Protection) open. Both are drawn on
 * every phone: with the words they show them, as they always have; without, they open the add form.
 */
export function viewWordsOpens(identity: BeanPoolIdentity | null | undefined): 'show-words' | 'add-words' {
    return hasMnemonic(identity) ? 'show-words' : 'add-words';
}

export const WORD_BOXES = 12;

/**
 * - `empty`: nothing typed yet.
 * - `typing`: the start of a listed word, not yet a whole one ("aban").
 * - `ok`: a listed word.
 * - `unknown`: no listed word starts like this: a typo, flagged as soon as it happens.
 */
export type WordBoxState = 'empty' | 'typing' | 'ok' | 'unknown';

const LISTED = new Set(BIP39_ENGLISH);

export function emptyWordBoxes(): string[] {
    return Array(WORD_BOXES).fill('');
}

export function wordBoxState(text: string): WordBoxState {
    const word = text.trim().toLowerCase();
    if (!word) return 'empty';
    if (LISTED.has(word)) return 'ok';
    return BIP39_ENGLISH.some((w) => w.startsWith(word)) ? 'typing' : 'unknown';
}

/**
 * The boxes after box `index` changed to `text`. One word stays in its box, lowercased with its spaces
 * dropped. Several words are a paste: a whole phrase fills the boxes from the first, and a few words fill
 * from this box on. Words past the twelfth are dropped.
 */
export function applyWordBoxChange(boxes: readonly string[], index: number, text: string): string[] {
    const words = normaliseRecoveryWords(text);
    if (words.length <= 1) {
        const next = [...boxes];
        next[index] = words[0] ?? '';
        return next;
    }
    return fillWordBoxes(boxes, words.length >= WORD_BOXES ? 0 : index, words);
}

/** A paste from the Paste button: the whole phrase, from the first box. */
export function wordBoxesFromPaste(text: string): string[] {
    return fillWordBoxes(emptyWordBoxes(), 0, normaliseRecoveryWords(text));
}

function fillWordBoxes(boxes: readonly string[], from: number, words: string[]): string[] {
    const next = [...boxes];
    for (let i = 0; i < words.length && from + i < WORD_BOXES; i++) next[from + i] = words[i];
    return next;
}

export interface WordBoxesCheck {
    states: WordBoxState[];
    /** Boxes with a listed word in them. */
    listed: number;
    /** 1-based numbers of the boxes whose word is not on the list. */
    unknown: number[];
    /** All twelve are listed words: the Add button can be pressed. Says nothing about whose words they are. */
    ready: boolean;
}

export function checkWordBoxes(boxes: readonly string[]): WordBoxesCheck {
    const states = boxes.map(wordBoxState);
    const unknown = states.flatMap((s, i) => (s === 'unknown' ? [i + 1] : []));
    const listed = states.filter((s) => s === 'ok').length;
    return { states, listed, unknown, ready: listed === WORD_BOXES };
}

/** The line under the boxes. */
export function wordBoxesStatus(check: WordBoxesCheck): string {
    if (check.unknown.length === 1) {
        return `Word ${check.unknown[0]} is not on the list of recovery words. Check the spelling.`;
    }
    if (check.unknown.length > 1) {
        return `Words ${check.unknown.join(', ')} are not on the list of recovery words. Check the spelling.`;
    }
    if (check.ready) return 'All 12 words are on the list.';
    return `${check.listed} of 12 words.`;
}

export const ADD_WORDS_COPY = {
    title: 'Add your 12 words to this phone',
    open: 'I have my 12 words',
    /** The one plain line (no-words-copy.ts). */
    intro: NO_WORDS_VIEW_LINE,
    paste: 'Paste',
    submit: 'Add these words',
    checking: 'Checking…',
    cancel: 'Cancel',
    mismatch: 'Those 12 words belong to a different account. Nothing on this phone has changed.',
    malformed: 'Those are not 12 words from the list. Nothing on this phone has changed.',
    failed: 'The words could not be saved on this phone. Nothing has changed. Try again.',
    /** Shown once, after the words are saved. */
    done: 'Your 12 words are on this phone again, and Show Recovery Phrase works. A sign-in you connected before still brings back your account without them. To include them, tap Connect again next to it under Account Protection.',
} as const;
