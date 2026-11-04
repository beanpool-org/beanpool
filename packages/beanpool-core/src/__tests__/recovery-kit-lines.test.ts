/**
 * The recovery kit's page in the member's language (recovery-kit-lines.ts), and the one rule that comes before every other:
 * the 12 words never pass through the words layer. They stay the English words the key is made from, in every language,
 * and no catalog, lookup or log of a sentence ever sees one.
 *
 * The 12 words below are the standard test vector the repo's other recovery tests use, not any member's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIP39_ENGLISH } from '../bip39-english.js';
import { KIT_RESTORE_STEPS, KIT_TITLE, KIT_WARNING, KIT_WEB_RESTORE_STEPS, recoveryKitHtml } from '../recovery-kit.js';
import { printedKitLines } from '../recovery-kit-lines.js';
import { LANGS, PSEUDO_LANG, setLanguage, type UiLang } from '../words.js';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const KIT = { words: WORDS, communityName: 'Mullum', communityAddress: 'http://10.0.0.7:8080', date: new Date(2026, 9, 3) };
const wordsAreThere = (html: string) => WORDS.filter((w) => !html.includes(`<span class="w">${w}</span>`));

afterEach(() => setLanguage('en'));

/** A Spanish catalog with some of the kit's sentences, as the translation pass will write them (the key is the English). */
const SOME_SPANISH = {
    _meta: { language: 'es' },
    'Your BeanPool recovery kit': 'Tu kit de recuperación de BeanPool',
    'How to get back in': 'Cómo volver a entrar',
    'Made on {date}': 'Hecho el {date}',
    'Install BeanPool on your phone and open it.': 'Instala BeanPool en tu teléfono y ábrelo.',
};

describe('the kit page in English', () => {
    it('says exactly what it always has: the lines in English are the constants, and the page is byte for byte the same', () => {
        setLanguage('en');
        const lines = printedKitLines();
        expect(lines.title).toBe(KIT_TITLE);
        expect(lines.warning).toBe(KIT_WARNING);
        expect([...lines.phoneSteps]).toEqual([...KIT_RESTORE_STEPS]);
        expect([...lines.webSteps]).toEqual([...KIT_WEB_RESTORE_STEPS]);
        expect([lines.community, lines.address, lines.howBack, lines.onPhone, lines.inBrowser]).toEqual([
            'Community:', 'Address:', 'How to get back in', 'On a phone', 'In a web browser',
        ]);
        expect(lines.madeOn('3 October 2026')).toBe('Made on 3 October 2026');
        expect(lines.lang).toBe('en');
        expect(recoveryKitHtml(KIT, lines)).toBe(recoveryKitHtml(KIT));
    });
});

describe('the kit page in another language', () => {
    it('uses the catalog\'s sentence where there is one, and the English where there is not', () => {
        setLanguage('es', [SOME_SPANISH]);
        const html = recoveryKitHtml(KIT, printedKitLines());
        expect(html).toContain('<h1>Tu kit de recuperación de BeanPool</h1>');
        expect(html).toContain('<title>Tu kit de recuperación de BeanPool</title>');
        expect(html).toContain('<h2>Cómo volver a entrar</h2>');
        expect(html).toContain('<li>Instala BeanPool en tu teléfono y ábrelo.</li>');
        // "Made on {date}" is the catalog's sentence with the date written in Spanish (the date tables, not a catalog).
        expect(html).toContain('Hecho el 3 de octubre de 2026');
        // Not translated yet: the English, whole, never a hole or a key.
        expect(html).toContain('<h3>On a phone</h3>');
        expect(html).toContain('<h3>In a web browser</h3>');
        expect(html).toContain(`<div class="warn">${KIT_WARNING}</div>`);
        expect(html).toContain('Community: <strong>Mullum</strong>');
        expect(html).toContain('Address: <strong>http://10.0.0.7:8080</strong>');
        expect(html).toContain('<li>Tap “🔑 Recover with 12 Words”.</li>');
        expect(html).toContain('<html lang="es">');
        expect(wordsAreThere(html)).toEqual([]);
    });

    it('with no catalog at all, a language reads the whole page in English and still has the 12 words', () => {
        for (const lang of LANGS) {
            setLanguage(lang);
            const html = recoveryKitHtml(KIT, printedKitLines());
            expect([lang, html.includes(KIT_TITLE), html.includes(KIT_WARNING), wordsAreThere(html)]).toEqual([lang, true, true, []]);
            expect(html).toContain(`<html lang="${lang}">`);
        }
    });

    it('follows the language at the moment the page is made: print in Spanish, change to English, print again', () => {
        setLanguage('es', [SOME_SPANISH]);
        expect(recoveryKitHtml(KIT, printedKitLines())).toContain('Cómo volver a entrar');
        setLanguage('en');
        const again = recoveryKitHtml(KIT, printedKitLines());
        expect(again).toContain('How to get back in');
        expect(again).not.toContain('Cómo volver a entrar');
    });

    it('writes a translation as text: markup and quotes in a sentence are escaped, never run', () => {
        setLanguage('fr', [{
            'Your BeanPool recovery kit': '<script>alert("x")</script> & “kit” \'bp\'',
            'Made on {date}': 'Le {date} <b>',
        }]);
        const html = recoveryKitHtml(KIT, printedKitLines());
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<b>');
        expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; “kit” &#39;bp&#39;');
        expect(html).toContain('Le 3 octobre 2026 &lt;b&gt;');
    });

    it('in the pseudo-locale every sentence of the page is bracketed (none bypassed the words layer), the words are not', () => {
        setLanguage(PSEUDO_LANG);
        const lines = printedKitLines();
        for (const sentence of [lines.title, lines.community, lines.address, lines.warning, lines.howBack, lines.onPhone, lines.inBrowser,
            ...lines.phoneSteps, ...lines.webSteps]) {
            expect(sentence, sentence).toMatch(/^\[.*\]$/s);
        }
        const html = recoveryKitHtml(KIT, lines);
        expect(wordsAreThere(html)).toEqual([]);
        expect(lines.lang).toBe('en');
    });
});

describe('the 12 words never pass through the words layer', () => {
    // Every one of the 2048 words, and its capitalised form, "translated" into something else, in every language: if the kit
    // or its lines ever sent a recovery word through t() the page would show the translation, and the key made from what is
    // printed would not be the member's.
    const hostile = Object.fromEntries(BIP39_ENGLISH.flatMap((w) => [[w, `${w}-x`], [w[0].toUpperCase() + w.slice(1), `${w}-X`]]));
    const catalog = { ...hostile, ...SOME_SPANISH };

    it('a catalog that translates every recovery word leaves the printed words exactly as they are, in every language', () => {
        for (const lang of [...LANGS, PSEUDO_LANG] as UiLang[]) {
            setLanguage(lang, [catalog]);
            const html = recoveryKitHtml(KIT, printedKitLines());
            expect([lang, wordsAreThere(html)]).toEqual([lang, []]);
            expect([lang, /-[xX]\b/.test(html)]).toEqual([lang, false]);
        }
    });

    it('the lines are made from no argument: they cannot be handed a word, a community or a date', () => {
        expect(printedKitLines.length).toBe(0);
        const lines = printedKitLines();
        // madeOn takes only the date as the page writes it; it is no place for a word and the page gives it none.
        expect(lines.madeOn.length).toBe(1);
    });

    it('the kit\'s sentences hold no recovery word as a sentence of their own, and the module reads no word list', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(resolve(here, '..'), 'recovery-kit-lines.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
        expect(src).not.toMatch(/bip39|recovery-words|WORDLIST|seedFrom|BIP39_ENGLISH|mnemonic/i);
    });
});

describe('the kit steps name each button as the screen draws it', () => {
    // A member who has lost their phone follows the printed page and looks for the quoted text on the screen, so a step that
    // quotes a button in other words than the button's own catalog entry (or in English, where the button is translated)
    // sends them looking for a label that is not there. The phone's steps ("Tap …") name the phone's buttons, the web's
    // steps ("Click …") the web app's; a button with no entry in its app's catalog shows its English, so that is what is quoted.
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..');
    const catalog = (dir: string, lang: string): Record<string, unknown> => {
        try {
            return JSON.parse(readFileSync(join(repoRoot, dir, 'words', `${lang}.json`), 'utf8'));
        } catch {
            return {};
        }
    };
    const quoted = (step: string) => Array.from(step.matchAll(/“([^”]+)”/g), (m) => m[1]);
    const SURFACES = [
        { name: 'phone', dir: 'apps/native', steps: KIT_RESTORE_STEPS },
        { name: 'web', dir: 'apps/pwa', steps: KIT_WEB_RESTORE_STEPS },
    ] as const;

    it('the English steps quote the buttons below (so the languages are held to a list that is not empty)', () => {
        expect(SURFACES[0].steps.flatMap(quoted)).toEqual(['🔑 Already a Member? Restore Account →', '🔑 Recover with 12 Words', 'Recover Identity']);
        expect(SURFACES[1].steps.flatMap(quoted)).toEqual([
            'Already have BeanPool?', '🔑 Restore Existing Identity →', 'Use my 12 words', '🔑 Recover with 12 Words', 'Recover Identity',
        ]);
    });

    for (const lang of LANGS.filter((l) => l !== 'en')) {
        it(`${lang}: every quoted label in a kit step is the label of the button it names, word for word`, () => {
            const core = catalog('packages/beanpool-core', lang);
            for (const { name, dir, steps } of SURFACES) {
                const app = catalog(dir, lang);
                for (const step of steps) {
                    const written = core[step];
                    // A step with no translation reads in English, quoting the English labels: nothing to hold it to here.
                    if (typeof written !== 'string') continue;
                    for (const label of quoted(step)) {
                        const drawn = typeof app[label] === 'string' ? (app[label] as string) : label;
                        expect(written, `${lang} ${name}: "${label}" is drawn as "${drawn}", and the step quotes it differently`).toContain(drawn);
                    }
                }
            }
        });
    }
});
