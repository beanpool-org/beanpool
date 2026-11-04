/**
 * The recovery kit's page and the share sheet's title in the member's language (utils/recovery-kit.ts, core's
 * printedKitLines()): the catalog's sentence where the language has one, the English where it has not, and the 12 words
 * English in every language whatever a catalog says.
 *
 * The 12 words are the standard test vector the repo's recovery tests use, not any member's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIP39_ENGLISH, setLanguage } from '@beanpool/core';
import { printRecoveryKit, saveRecoveryKitPdf, type KitModules } from '../recovery-kit';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const KIT = { words: WORDS, communityName: 'Mullum', communityAddress: 'https://mullum.example.org', date: new Date('2026-10-03T09:00:00Z') };
const wordsAreThere = (html: string) => WORDS.filter((w) => !html.includes(`<span class="w">${w}</span>`));

afterEach(() => setLanguage('en'));

/** The phone's print and share modules as stand-ins, keeping the page and the share sheet's title. */
function modules() {
    const seen: { html: string[]; dialogTitle: string[] } = { html: [], dialogTitle: [] };
    const stand: KitModules = {
        Print: {
            printAsync: vi.fn(async ({ html }: { html: string }) => { seen.html.push(html); }),
            printToFileAsync: vi.fn(async ({ html }: { html: string }) => { seen.html.push(html); return { uri: 'file:///cache/kit.pdf' }; }),
        },
        Sharing: { shareAsync: vi.fn(async (_uri: string, options?: { dialogTitle?: string }) => { seen.dialogTitle.push(options?.dialogTitle ?? ''); }) },
        FileSystem: { deleteAsync: vi.fn(async () => {}) },
    };
    return { stand, seen };
}

const SPANISH = {
    'Your BeanPool recovery kit': 'Tu kit de recuperación de BeanPool',
    'Type your 12 words in order, one in each box.': 'Escribe tus 12 palabras en orden, una en cada casilla.',
};

describe('the printed kit on the phone, in the member\'s language', () => {
    it('Print writes the page in Spanish where the catalog has the sentence, and in English where it has not', async () => {
        setLanguage('es', [SPANISH]);
        const { stand, seen } = modules();
        expect(await printRecoveryKit(KIT, stand)).toBe('done');
        const html = seen.html[0];
        expect(html).toContain('<h1>Tu kit de recuperación de BeanPool</h1>');
        expect(html).toContain('<li>Escribe tus 12 palabras en orden, una en cada casilla.</li>');
        expect(html).toContain('<h2>How to get back in</h2>');
        expect(html).toContain('<html lang="es">');
        expect(wordsAreThere(html)).toEqual([]);
    });

    it('Save as PDF makes the same page, and the share sheet\'s title is the kit\'s title in that language', async () => {
        setLanguage('es', [SPANISH]);
        const { stand, seen } = modules();
        expect(await saveRecoveryKitPdf(KIT, async () => true, stand)).toBe('done');
        expect(seen.html[0]).toContain('<h1>Tu kit de recuperación de BeanPool</h1>');
        expect(seen.dialogTitle).toEqual(['Tu kit de recuperación de BeanPool']);
    });

    it('in English the page and the share sheet\'s title read exactly as they always have', async () => {
        const { stand, seen } = modules();
        await printRecoveryKit(KIT, stand);
        await saveRecoveryKitPdf(KIT, async () => true, stand);
        expect(seen.html[0]).toContain('<h1>Your BeanPool recovery kit</h1>');
        expect(seen.html[0]).toContain('<html lang="en">');
        expect(seen.dialogTitle).toEqual(['Your BeanPool recovery kit']);
    });

    it('a catalog that "translates" every recovery word changes none of the 12 words on the printed page', async () => {
        const hostile = Object.fromEntries(BIP39_ENGLISH.flatMap((w) => [[w, `${w}-x`], [w[0].toUpperCase() + w.slice(1), `${w}-X`]]));
        setLanguage('fr', [hostile, { 'Your BeanPool recovery kit': 'Votre kit de récupération BeanPool' }]);
        const { stand, seen } = modules();
        await printRecoveryKit(KIT, stand);
        expect(seen.html[0]).toContain('Votre kit de récupération BeanPool');
        expect(wordsAreThere(seen.html[0])).toEqual([]);
        expect(/-[xX]\b/.test(seen.html[0])).toBe(false);
    });
});
