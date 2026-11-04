/**
 * The recovery kit on the web, in the language the web app is showing (lib/recovery-kit.ts, core's printedKitLines()): the
 * catalog's sentence where the language has one, the English where it has not, and the 12 words English in every language.
 *
 * The 12 words are the standard test vector the repo's recovery tests use, not any member's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BIP39_ENGLISH, setLanguage } from '@beanpool/core';
import { printRecoveryKit, removeKitFrame } from './recovery-kit';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const wordsAreThere = (html: string) => WORDS.filter((w) => !html.includes(`<span class="w">${w}</span>`));

afterEach(() => {
    removeKitFrame();
    setLanguage('en');
});

/** The kit's frame as the browser's print sees it. */
async function printed(): Promise<string> {
    let html = '';
    const result = await printRecoveryKit(WORDS, (w) => { html = w.document.documentElement.outerHTML; });
    expect(result).toBe('done');
    return html;
}

describe('the printed kit on the web, in the web app\'s language', () => {
    it('is in Spanish where the catalog has the sentence, in English where it has not, and has the 12 words', async () => {
        setLanguage('es', [{
            'Your BeanPool recovery kit': 'Tu kit de recuperación de BeanPool',
            'Click “Recover Identity”. Your name and picture come back once you’re in.': 'Haz clic en «Recover Identity». Tu nombre y tu foto vuelven cuando entras.',
        }]);
        const html = await printed();
        expect(html).toContain('Tu kit de recuperación de BeanPool');
        expect(html).toContain('Haz clic en «Recover Identity». Tu nombre y tu foto vuelven cuando entras.');
        expect(html).toContain('How to get back in');
        expect(html).toContain('lang="es"');
        expect(wordsAreThere(html)).toEqual([]);
    });

    it('in English it reads exactly as it always has', async () => {
        const html = await printed();
        expect(html).toContain('Your BeanPool recovery kit');
        expect(html).toContain('Click “Already have BeanPool?”.');
        expect(wordsAreThere(html)).toEqual([]);
    });

    it('a catalog that "translates" every recovery word changes none of the 12 words on the printed page', async () => {
        const hostile = Object.fromEntries(BIP39_ENGLISH.flatMap((w) => [[w, `${w}-x`], [w[0].toUpperCase() + w.slice(1), `${w}-X`]]));
        setLanguage('pt', [hostile]);
        const html = await printed();
        expect(wordsAreThere(html)).toEqual([]);
        expect(/-[xX]\b/.test(html)).toBe(false);
    });
});
