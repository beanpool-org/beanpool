/**
 * "I can do this" on a Need (cold start N4; need-answer-words.ts): the button's words and the plain sentence under it, with the
 * deal's own amount and the name the Need shows, in English and in a language with its machine drafts. The sentence says what
 * the helper would be paid, who has to agree and when the Beans are theirs; the 1.5% fee is the deal's, not this screen's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { LANGS, setLanguage, t } from '../words.js';
import { NEED_ANSWER_WORDS, needAnswerLine } from '../need-answer-words.js';
import { NEEDS_COUNT_WORDS } from '../first-trade-words.js';
import { dealAmountFor } from '../hundredths.js';

const wordsDir = new URL('../../words/', import.meta.url);
const catalog = (lang: string) => JSON.parse(readFileSync(new URL(`${lang}.json`, wordsDir), 'utf8'));

afterEach(() => setLanguage('en'));

describe('the button and the sentence under it', () => {
    it('the button reads I can do this, and the heading too without the hand', () => {
        expect(t(NEED_ANSWER_WORDS.button)).toBe('✋ I can do this');
        expect(t(NEED_ANSWER_WORDS.title)).toBe('I can do this');
        expect(t(NEED_ANSWER_WORDS.button)).not.toMatch(/Offer to Fulfill/i);
    });

    it('a priced Need: the amount, the name, and when the Beans are theirs (the total in whole hundredths)', () => {
        expect(needAnswerLine(4000, 'Sam')).toBe("You'd do it for 40 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.");
        expect(needAnswerLine(100, 'Sam')).toBe("You'd do it for 1 Beans. Sam agrees, you do it, Sam confirms, and the Beans are yours.");
    });

    it("a total of a price times the quantity is the node's own figure (dealAmountFor), two decimals when not whole", () => {
        expect(needAnswerLine(1250, 'Sam')).toContain('for 12.50 Beans.');
        // 10 Beans an hour for 3.3333 hours: 333 hundredths of an hour, 3,330 hundredths of a Bean, as the node holds it.
        expect(needAnswerLine(dealAmountFor(1000, 3.3333), 'Sam')).toContain('for 33.30 Beans.');
        expect(needAnswerLine(1, 'Sam')).toContain('for 0.01 Beans.');
    });

    it('no name: the person who asked, never a made-up name or an empty gap', () => {
        const line = needAnswerLine(4000);
        expect(line).toBe("You'd do it for 40 Beans. The person who asked agrees, you do it, they confirm, and the Beans are yours.");
        expect(needAnswerLine(4000, null)).toBe(line);
        expect(needAnswerLine(4000, '')).toBe(line);
        expect(needAnswerLine(4000, '   ')).toBe(line);
        expect(needAnswerLine(4000, '  Sam ')).toContain('Sam agrees');
    });

    it('a Need with nothing to pay says so, and never claims Beans that will not come', () => {
        // Not a positive whole number of hundredths (a float from a stale caller among them) never shows a figure.
        for (const free of [0, -3, NaN, Infinity, 0.001, 12.5]) {
            const named = needAnswerLine(free, 'Sam');
            expect(named, String(free)).toBe("You'd do it for free. Sam agrees, you do it, and Sam confirms.");
            expect(named).not.toMatch(/Beans|0/);
        }
        expect(needAnswerLine(0)).toBe("You'd do it for free. The person who asked agrees, you do it, and they confirm.");
    });

    it('the fee is not on this screen, and no word we took out is in it', () => {
        for (const line of [needAnswerLine(4000, 'Sam'), needAnswerLine(4000), needAnswerLine(0, 'Sam'), needAnswerLine(0)]) {
            expect(line).not.toMatch(/1\.5|fee|Commons|Trust Wallet|resilience|survival/i);
        }
    });
});

describe('in a language with its drafts', () => {
    it('Spanish: the amount in the language\'s Beans, the name and the plain steps', () => {
        setLanguage('es', [catalog('es')]);
        expect(needAnswerLine(4000, 'Sam')).toBe('Lo harías por 40 frijoles. Sam acepta, tú lo haces, Sam confirma y los frijoles son tuyos.');
        expect(needAnswerLine(0)).toBe('Lo harías gratis. Quien lo pidió acepta, tú lo haces y confirma.');
        expect(t(NEED_ANSWER_WORDS.button)).toBe('✋ Puedo hacerlo');
    });

    it('French keeps the decimal comma', () => {
        setLanguage('fr', [catalog('fr')]);
        expect(needAnswerLine(1250, 'Sam')).toBe('Vous le feriez pour 12,50 haricots. Sam accepte, vous le faites, Sam confirme, et les haricots sont à vous.');
    });

    it('every language has every word this adds, with the same placeholders, and none of them is the English', () => {
        const words = [...Object.values(NEED_ANSWER_WORDS), ...Object.values(NEEDS_COUNT_WORDS)] as string[];
        const files = readdirSync(wordsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
        expect(files).toEqual([...LANGS].filter((l) => l !== 'en').sort());
        for (const lang of files) {
            const c = catalog(lang);
            for (const w of words) {
                expect(typeof c[w], `${lang}: ${w}`).toBe('string');
                for (const ph of ['{price}', '{name}', '{n}']) expect(w.includes(ph) === c[w].includes(ph), `${lang} ${ph}: ${w}`).toBe(true);
                expect(c[w], `${lang}: ${w}`).not.toBe(w);
            }
        }
    });
});
