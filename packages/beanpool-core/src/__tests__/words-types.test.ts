/**
 * What t() / tn() / word() accept, proved by the compiler: core's tsc (its build and `tsc --noEmit`) checks this file,
 * and an `@ts-expect-error` that stops being an error fails the build. A recovery word is a plain `string`
 * (BIP39_ENGLISH is `readonly string[]`), so it can never be handed to t() (DESIGN-translation-fable.md, amendment 1).
 */

import { describe, expect, it } from 'vitest';
import { PLURAL_RULES, t, tn, word, wordsFor, type Lang, type PluralRule } from '../words.js';
import { BIP39_ENGLISH } from '../recovery-words.js';

describe('t() takes a literal or a word() key, never a plain string', () => {
    it('compiles only what it should', () => {
        const recoveryWord: string = BIP39_ENGLISH[0];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the point: an `any` must not reach t() either
        const anyWord: any = 'abandon';
        const either = BIP39_ENGLISH.length > 2 ? 'Yes' : 'No';
        // @ts-expect-error a plain string (a recovery word, a member's text) is not a sentence
        t(recoveryWord);
        // @ts-expect-error nor is `any`
        t(anyWord);
        // @ts-expect-error nor a union of literals: each belongs in its own t()
        t(either);
        // @ts-expect-error tn()'s forms too
        tn(2, recoveryWord, '{n} beans');
        // @ts-expect-error word() marks only literals
        word(recoveryWord);
        // @ts-expect-error wordsFor(lang).t is the same function
        wordsFor('fr').t(recoveryWord);
        const SAVED = word('Saved');
        expect([t('Saved'), t(SAVED), t(`Saved`), tn(1, '{n} bean', '{n} beans'), wordsFor('en').t(SAVED)]).toEqual(['Saved', 'Saved', 'Saved', '1 bean', 'Saved']);
    });

    it('a plural rule table missing a language does not compile', () => {
        // @ts-expect-error 24 languages missing
        const partial: Record<Lang, PluralRule> = { en: PLURAL_RULES.en };
        expect(partial.en).toBe(PLURAL_RULES.en);
    });
});
