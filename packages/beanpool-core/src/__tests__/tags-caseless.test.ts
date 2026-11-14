/**
 * Case in the node's exact map of every language's labels (tags/index.ts caseless, exactTagForms, caseBornTagForms;
 * DESIGN-tags-free-entry-fable.md Amendment 2, DECISION-tags-turkish-dotless.md Q2 and Q3): German ß is ss as German capitals
 * write it, Greek capitals drop the tonos and the dialytika, and in all 25 languages a label typed in capitals or lower case,
 * by its own language's rule or the default, meets the label as written. What the node does with a key born from case is
 * apps/server engine/free-tags.ts labelMapOf (test-free-tag-suggestions.ts plants a collision).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAG_LIBRARY, caseBornTagForms, exactTagForms, tagEnglish } from '../tags/index.js';
import { freeTagStored } from '../tags/free-tags.js';
import { compoundWords } from '../search-terms.js';
import { LANGS, wordsFor, type Catalog } from '../words.js';

const ITEMS = TAG_LIBRARY.filter((tag) => tag.id.includes('.'));
const CATALOGS = new Map(LANGS.filter((lang) => lang !== 'en').map((lang) =>
    [lang, JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog]));

/** Every library tag's label in one language, as the node's map reads it (engine/free-tags.ts libraryLabels). */
function labelsOf(lang: (typeof LANGS)[number]): Array<readonly [string, string]> {
    const words = wordsFor(lang, lang === 'en' ? [] : [CATALOGS.get(lang)!]);
    return ITEMS.map((tag) => [tag.id, lang === 'en' ? tagEnglish(tag) : words.t(tag.en) || tagEnglish(tag)] as const);
}
// What the node looks a typed word up by (engine/free-tags.ts libraryTagNamed): the stored form the apps send, its words
// with each compound whole, read by exactTagForms.
const asked = (typed: string) => exactTagForms(compoundWords(freeTagStored(typed)).join(' '));
const meets = (typed: string, written: string) => asked(typed).some((key) => exactTagForms(written).includes(key));
// Every way a member may type a label: as written, lower and upper case by its own language's rule and by the default rule.
const typings = (lang: string, written: string) => [
    written, written.toLocaleLowerCase(lang), written.toLocaleUpperCase(lang), written.toLowerCase(), written.toUpperCase(),
];
const label = (lang: (typeof LANGS)[number], id: string) => labelsOf(lang).find(([tagId]) => tagId === id)![1];

describe('caseless: German ß is ss, as German capitals write it', () => {
    it('Süßkartoffel and SÜSSKARTOFFEL are one key, and the capital ẞ too', () => {
        expect(exactTagForms('Süßkartoffel')).toEqual(['süsskartoffel']);
        expect(exactTagForms('SÜSSKARTOFFEL')).toEqual(['süsskartoffel']);
        expect(exactTagForms('SÜẞKARTOFFEL')).toEqual(['süsskartoffel']);
        expect(meets('SÜSSKARTOFFEL', 'Süßkartoffel')).toBe(true);
    });

    it('the four German labels with ß are found typed in German capitals', () => {
        const four: Array<[string, string, string]> = [
            ['food.vegetables.sweet-potato', 'Süßkartoffel', 'SÜSSKARTOFFEL'],
            ['food.preserves.sauces', 'Soßen', 'SOSSEN'],
            ['services.trades.welding', 'Schweißen', 'SCHWEISSEN'],
            ['tools.power.welders', 'Schweißgeräte', 'SCHWEISSGERÄTE'],
        ];
        for (const [id, written, capitals] of four) {
            expect(label('de', id), id).toBe(written);
            expect(written.toLocaleUpperCase('de')).toBe(capitals);
            expect(meets(capitals, written), `${capitals} → ${written}`).toBe(true);
        }
    });
});

describe('caseless: Greek capitals drop the tonos and the dialytika, on Greek letters only', () => {
    it('a Greek label and its capitals are one key, typed composed or decomposed', () => {
        expect(label('el', 'food.fruit.lemon')).toBe('Λεμόνι');
        expect('Λεμόνι'.toLocaleUpperCase('el')).toBe('ΛΕΜΟΝΙ');
        expect(exactTagForms('Λεμόνι')).toEqual(['λεμονι']);
        expect(exactTagForms('ΛΕΜΟΝΙ')).toEqual(['λεμονι']);
        expect(exactTagForms('Λεμόνι'.normalize('NFD'))).toEqual(['λεμονι']);
        // Greek capitals write a dialytika where the tonos they drop kept two vowels apart: Λάιμ is ΛΑΪΜ.
        expect(label('el', 'food.fruit.lime')).toBe('Λάιμ');
        expect('Λάιμ'.toLocaleUpperCase('el')).toBe('ΛΑΪΜ');
        expect(exactTagForms('ΛΑΪΜ')).toEqual(exactTagForms('Λάιμ'));
        expect(exactTagForms('Μαϊντανός')).toEqual(['μαιντανος']);
        expect(exactTagForms('ΜΑΪΝΤΑΝΟΣ')).toEqual(['μαιντανος']);
    });

    it('keeps the same marks on every other letter: Latin and Cyrillic are not Greek', () => {
        expect(exactTagForms('Maïs')).toEqual(['maïs']);
        expect(exactTagForms('Maïs')).not.toEqual(exactTagForms('mais'));
        expect(exactTagForms('Café')).toEqual(['café']);
        expect(exactTagForms('Ёлка')).toEqual(['ёлка']);
        expect(exactTagForms('Чай')).toEqual(['чай']);
        expect(exactTagForms('Maçã')).toEqual(['maçã']);
        expect(exactTagForms('Cát')).toEqual(['cát']);
    });
});

describe('caseBornTagForms: the keys only case made', () => {
    it('names a key the label does not write in its own lower case, and none it does', () => {
        expect(caseBornTagForms('İnternet')).toEqual(['internet']);
        expect(caseBornTagForms('Internet')).toEqual([]);
        expect(caseBornTagForms('Balık')).toEqual(['balik']);
        expect(caseBornTagForms('BALIK')).toEqual([]);
        expect(caseBornTagForms('Süßkartoffel')).toEqual(['süsskartoffel']);
        expect(caseBornTagForms('SÜSSKARTOFFEL')).toEqual([]);
        expect(caseBornTagForms('Λεμόνι')).toEqual(['λεμονι']);
        expect(caseBornTagForms('Maçã')).toEqual([]);
        expect(caseBornTagForms('Limão-siciliano')).toEqual([]);
        expect(caseBornTagForms('Acı biber')).toEqual(['aci biber']);
    });
});

// The class table (Fable, 15 Nov): every label in all 25 languages, typed in capitals and lower case by its own language's
// rule and the default, meets the label as written. Zero misses.
describe('the class table: case never matters in any of the 25 languages', () => {
    it('every label typed every way meets the label as written', () => {
        const missed: string[] = [];
        let rows = 0;
        for (const lang of LANGS) {
            for (const [id, written] of labelsOf(lang)) {
                rows++;
                for (const typed of typings(lang, written)) if (!meets(typed, written)) missed.push(`${lang} ${id}: ${typed} (${written})`);
            }
        }
        expect(rows).toBe(LANGS.length * ITEMS.length);
        expect(missed).toEqual([]);
    });

    it('holds the labels the two new lines are for: German with ß, every Greek label', () => {
        expect(labelsOf('de').filter(([, written]) => written.includes('ß')).length).toBeGreaterThanOrEqual(4);
        const greek = labelsOf('el').filter(([, written]) => /[άέήίόύώΆΈΉΊΌΎΏϊϋΐΰΪΫ]/.test(written));
        expect(greek.length).toBeGreaterThan(400);
        expect(greek.every(([, written]) => caseBornTagForms(written).length > 0)).toBe(true);
    });
});
