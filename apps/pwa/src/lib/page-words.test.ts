/**
 * The web app's tab title and page description follow the language (lib/page-words.ts, called from lib/language.ts;
 * translation index item 13, words-wire-2): English as index.html has it, the pseudo-locale (no catalog needed), a language
 * that has the sentences (a FIXTURE catalog below, not a real translation), the Chat badge's number kept through a switch,
 * and the English kept where a language has not translated a sentence. Nothing contacts a node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pseudoLocalise } from '@beanpool/core';
import { applyPageWords, pageDescription, pageTitle, resetPageWordsForTests, setTitleUnread } from './page-words';
import { resetLanguageForTests, showLanguage } from './language';

// Spanish with only these two sentences, so the rest of the test shows the English kept where a sentence is missing.
// FIXTURE: invented to see the switch happen; the real words come from the translation pass.
vi.mock('../../words/es.json', async () => {
    const { wordKey } = await import('@beanpool/core');
    return {
        default: {
            [wordKey('({count}) BeanPool', 'tab title')]: 'BeanPool ({count})',
            [wordKey('BeanPool — Local-first independent community marketplace', 'page description')]: 'BeanPool: mercado comunitario independiente (fixture)',
        },
    };
});

const ENGLISH_DESCRIPTION = 'BeanPool — Local-first independent community marketplace';
const description = () => document.querySelector('meta[name="description"]')?.getAttribute('content') ?? undefined;

beforeEach(() => {
    localStorage.clear();
    resetLanguageForTests();
    resetPageWordsForTests();
    document.head.innerHTML = '<meta charset="UTF-8"><meta name="description" content="BeanPool — Local-first independent community marketplace" /><title>BeanPool</title>';
    document.documentElement.lang = 'en';
});
afterEach(() => {
    resetLanguageForTests();
    resetPageWordsForTests();
    vi.restoreAllMocks();
});

describe('in English, which is what index.html says', () => {
    it('the words are the ones in index.html, word for word', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
        expect(html).toContain('<title>BeanPool</title>');
        expect(html).toContain(`<meta name="description" content="${pageDescription()}" />`);
        expect(pageDescription()).toBe(ENGLISH_DESCRIPTION);
        expect(pageTitle(0)).toBe('BeanPool');
    });

    it('the tab title carries the Chat badge, capped at 99+', () => {
        expect(pageTitle(7)).toBe('(7) BeanPool');
        expect(pageTitle(99)).toBe('(99) BeanPool');
        expect(pageTitle(100)).toBe('(99+) BeanPool');
        setTitleUnread(2);
        expect(document.title).toBe('(2) BeanPool');
        setTitleUnread(0);
        expect(document.title).toBe('BeanPool');
        expect(description()).toBe(ENGLISH_DESCRIPTION);
    });
});

describe('the title and description switch with the language', () => {
    it('the pseudo-locale shows both at once, and English brings them back', async () => {
        await showLanguage('xx');
        expect(document.title).toBe(pseudoLocalise('BeanPool'));
        expect(description()).toBe(pseudoLocalise(ENGLISH_DESCRIPTION));
        expect(document.title).not.toBe('BeanPool');
        await showLanguage('en');
        expect(document.title).toBe('BeanPool');
        expect(description()).toBe(ENGLISH_DESCRIPTION);
    });

    it('a language that has the sentences shows them, with the badge number where that language puts it', async () => {
        await showLanguage('es');
        expect(description()).toBe('BeanPool: mercado comunitario independiente (fixture)');
        setTitleUnread(3);
        expect(document.title).toBe('BeanPool (3)');
        setTitleUnread(150);
        expect(document.title).toBe('BeanPool (99+)');
        // The name itself has no entry in the fixture: the English is kept, never blank.
        setTitleUnread(0);
        expect(document.title).toBe('BeanPool');
    });

    it('a switch redraws the title with the badge still on it, both ways', async () => {
        setTitleUnread(2);
        expect(document.title).toBe('(2) BeanPool');
        await showLanguage('es');
        expect(document.title).toBe('BeanPool (2)');
        await showLanguage('en');
        expect(document.title).toBe('(2) BeanPool');
        expect(description()).toBe(ENGLISH_DESCRIPTION);
    });

    it('a language that has not translated the sentences keeps the English', async () => {
        await showLanguage('fr');
        expect(description()).toBe(ENGLISH_DESCRIPTION);
        expect(document.title).toBe('BeanPool');
        setTitleUnread(4);
        expect(document.title).toBe('(4) BeanPool');
    });

    it('a page with no description tag is left alone, and the title is still set', () => {
        document.head.querySelector('meta[name="description"]')?.remove();
        document.title = 'something else';
        expect(() => applyPageWords()).not.toThrow();
        expect(document.title).toBe('BeanPool');
        expect(description()).toBeUndefined();
    });
});
