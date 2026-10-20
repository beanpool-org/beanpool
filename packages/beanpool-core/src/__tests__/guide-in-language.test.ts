import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    findGuidePage, findGuideSection, findGuideVideo, guideInLanguage, guidePageBodyInEnglish, guidePageNewerInEnglish,
    guideSourceHash, guideBodyHash, searchGuide, refreshLanguageGuideFromWebsite, loadCachedLanguageGuide,
    type Guide, type GuideTitles, type GuideStorage,
} from '../member-guide.js';
import { helpSheetFor } from '../help-map.js';
import { pseudoLocalise } from '../words.js';

// The guide's titles in the member's language (slice S5a): a language's titles file laid over the English. The real
// guide and the real files are tested in apps/native/utils/__tests__/guide.test.ts; this is the rule on a small guide.

const GUIDE: Guide = {
    schema: 2, version: 3, hash: 'h',
    sections: [
        { id: 'about', title: 'About BeanPool', summary: 'How it works.', slugs: ['how-it-works'] },
        { id: 'market', title: 'Market', summary: 'Finding and posting Offers and Needs.', slugs: ['browsing-the-market'] },
    ],
    guides: [
        { slug: 'how-it-works', title: 'How BeanPool works', summary: 'Beans, trading, offers and needs.', section: 'about', related: ['browsing-the-market'], blocks: [{ type: 'p', text: 'Beans move between members.' }] },
        {
            slug: 'browsing-the-market', title: 'Browsing the Market', summary: 'Finding what neighbours offer.', section: 'market', related: ['how-it-works'],
            help: 'Offers and Needs near you.', blocks: [{ type: 'h2', text: 'Filters' }, { type: 'p', text: 'Pick a category.' }],
        },
    ],
};
const entry = (english: string, text: string) => ({ text, sourceHash: guideSourceHash(english) });
const PT: GuideTitles = {
    sections: { market: { title: entry('Market', 'Mercado'), summary: entry('Finding and posting Offers and Needs.', 'Encontrar e publicar Ofertas e Pedidos.') } },
    pages: {
        'browsing-the-market': {
            title: entry('Browsing the Market', 'Explorar o Mercado'),
            summary: entry('Finding what neighbours offer.', 'Encontrar o que os vizinhos oferecem.'),
            help: entry('Offers and Needs near you.', 'Ofertas e Pedidos perto de si.'),
        },
    },
};

describe('guideSourceHash', () => {
    it('is the first 16 hex digits of the sha256 of the UTF-8 (the guide package\'s titles.mjs hashes the same)', () => {
        for (const s of ['abc', 'Market', 'Mercado — café', 'マーケット']) {
            expect(guideSourceHash(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16));
        }
        expect(guideSourceHash('abc')).toBe('ba7816bf8f01cfea');
    });
});

describe('guideInLanguage', () => {
    it('English, or a tag BeanPool does not write, is the guide itself', () => {
        expect(guideInLanguage(GUIDE, 'en', PT)).toBe(GUIDE);
        expect(guideInLanguage(GUIDE, 'he' as never, PT)).toBe(GUIDE);
        expect(guideInLanguage(GUIDE, 'pt', { sections: {}, pages: {} })).toBe(GUIDE);
        expect(guideInLanguage(GUIDE, 'pt', undefined)).toBe(GUIDE);
    });

    it('a current translation shows, with its English kept; a line with none stays English, never blank', () => {
        const pt = guideInLanguage(GUIDE, 'pt', PT);
        const market = findGuideSection(pt, 'market')!;
        expect(market.title).toBe('Mercado');
        expect(market.english).toEqual({ title: 'Market', summary: 'Finding and posting Offers and Needs.' });
        const page = findGuidePage(pt, 'browsing-the-market')!;
        expect([page.title, page.summary, page.help]).toEqual(['Explorar o Mercado', 'Encontrar o que os vizinhos oferecem.', 'Ofertas e Pedidos perto de si.']);
        expect(page.english).toEqual({ title: 'Browsing the Market', summary: 'Finding what neighbours offer.', help: 'Offers and Needs near you.' });
        expect(page.blocks).toBe(GUIDE.guides[1].blocks);
        expect(guidePageBodyInEnglish(page)).toBe(true);
        // Untranslated: English, and nothing claims otherwise.
        expect(findGuideSection(pt, 'about')).toBe(GUIDE.sections[0]);
        const how = findGuidePage(pt, 'how-it-works')!;
        expect(how).toBe(GUIDE.guides[0]);
        expect(guidePageBodyInEnglish(how)).toBe(false);
        // The guide it was given is untouched.
        expect(GUIDE.sections[1].title).toBe('Market');
    });

    it('a line drafted from other English is stale: the English shows until it is redrafted', () => {
        const titles: GuideTitles = { pages: { 'browsing-the-market': { title: entry('Browse the Market', 'Explorar o Mercado'), summary: PT.pages!['browsing-the-market'].summary } } };
        const page = findGuidePage(guideInLanguage(GUIDE, 'pt', titles), 'browsing-the-market')!;
        expect(page.title).toBe('Browsing the Market');
        expect(page.summary).toBe('Encontrar o que os vizinhos oferecem.');
        expect(page.english).toEqual({ summary: 'Finding what neighbours offer.' });
        // A newer English guide (from beanpool.org) with a changed title: the bundled translation of the old one stops showing.
        const newer: Guide = { ...GUIDE, version: 4, guides: GUIDE.guides.map((p) => (p.slug === 'browsing-the-market' ? { ...p, title: 'Browse the Market' } : p)) };
        expect(findGuidePage(guideInLanguage(newer, 'pt', PT), 'browsing-the-market')!.title).toBe('Browse the Market');
    });

    it('only the help line translated: the header is English, so the page does not say its body is', () => {
        const titles: GuideTitles = { pages: { 'browsing-the-market': { help: PT.pages!['browsing-the-market'].help } } };
        const page = findGuidePage(guideInLanguage(GUIDE, 'pt', titles), 'browsing-the-market')!;
        expect(page.help).toBe('Ofertas e Pedidos perto de si.');
        expect(guidePageBodyInEnglish(page)).toBe(false);
    });

    it('anything that is not a line the apps take is passed over, never thrown', () => {
        for (const bad of [
            null, 'x', [], { sections: [] }, { pages: { 'browsing-the-market': 'Explorar' } },
            { pages: { 'browsing-the-market': { title: { text: '', sourceHash: guideSourceHash('Browsing the Market') } } } },
            { pages: { 'browsing-the-market': { title: { text: 'x'.repeat(121), sourceHash: guideSourceHash('Browsing the Market') } } } },
            { pages: { 'browsing-the-market': { title: { text: 7, sourceHash: guideSourceHash('Browsing the Market') } } } },
            { pages: { 'browsing-the-market': { title: { text: 'Explorar' } } } },
            { pages: { constructor: { title: { text: 'x', sourceHash: 'y' } } } },
        ]) {
            expect(guideInLanguage(GUIDE, 'pt', bad), JSON.stringify(bad)).toBe(GUIDE);
        }
    });

    it('in the pseudo-locale every title, summary and help line is pseudo-localised, so the 320 dp checks measure it', () => {
        const xx = guideInLanguage(GUIDE, 'xx');
        expect(xx.sections.map((s) => s.title)).toEqual(GUIDE.sections.map((s) => pseudoLocalise(s.title)));
        expect(xx.guides.map((p) => p.summary)).toEqual(GUIDE.guides.map((p) => pseudoLocalise(p.summary)));
        expect(findGuidePage(xx, 'browsing-the-market')!.help).toBe(pseudoLocalise('Offers and Needs near you.'));
        expect(xx.guides.every(guidePageBodyInEnglish)).toBe(true);
    });

    it("the \"?\" sheet reads the member's language from it", () => {
        const sheet = helpSheetFor(guideInLanguage(GUIDE, 'pt', PT), 'market');
        expect(sheet).toMatchObject({ title: 'Explorar o Mercado', text: 'Ofertas e Pedidos perto de si.', slug: 'browsing-the-market' });
    });
});

describe('search and videos on a guide in another language', () => {
    const pt = guideInLanguage(GUIDE, 'pt', PT);

    it('finds a page by its translated title and by its English one', () => {
        expect(searchGuide(pt, 'explorar').map((r) => r.page.slug)).toEqual(['browsing-the-market']);
        expect(searchGuide(pt, 'browsing').map((r) => r.page.slug)).toEqual(['browsing-the-market']);
        expect(searchGuide(pt, 'vizinhos').map((r) => r.page.slug)).toEqual(['browsing-the-market']);
        expect(searchGuide(pt, 'neighbours').map((r) => r.page.slug)).toEqual(['browsing-the-market']);
        // The row shows the member's language.
        expect(searchGuide(pt, 'browsing')[0].page.title).toBe('Explorar o Mercado');
    });

    it("a curated video still matches the page's English title", () => {
        const page = findGuidePage(pt, 'browsing-the-market')!;
        const video = { title: 'Browsing the Market', url: 'https://www.youtube.com/watch?v=abcdefghijk', source: 'curated' };
        expect(findGuideVideo(page, [video])).toBe(video);
        expect(findGuideVideo(page, [{ ...video, title: 'Explorar o Mercado' }])).toBeNull();
    });
});

describe('guideInLanguage with translated page bodies (slice S5b)', () => {
    const market = GUIDE.guides.find(p => p.slug === 'browsing-the-market')!;
    const marketBodyHash = guideBodyHash(market);

    const translatedGuide: Guide = {
        schema: 2, version: 1, hash: 'pthash', language: 'pt',
        sections: [{ id: 'market', title: 'Mercado', summary: 'Encontrar e publicar.', slugs: ['browsing-the-market'] }],
        guides: [
            {
                slug: 'browsing-the-market',
                title: 'Explorar o Mercado',
                summary: 'Encontrar o que os vizinhos oferecem.',
                section: 'market',
                related: ['how-it-works'],
                sourceHash: marketBodyHash,
                blocks: [{ type: 'h2', text: 'Filtros' }, { type: 'p', text: 'Escolha uma categoria.' }],
            },
        ],
    };

    it('current state: source-hash matches English body -> shows translated body, neither note', () => {
        const pt = guideInLanguage(GUIDE, 'pt', PT, translatedGuide);
        const page = findGuidePage(pt, 'browsing-the-market')!;
        expect(page.title).toBe('Explorar o Mercado');
        expect(page.blocks).toEqual(translatedGuide.guides[0].blocks);
        expect(page.bodyState).toBe('current');
        expect(guidePageBodyInEnglish(page)).toBe(false);
        expect(guidePageNewerInEnglish(page)).toBe(false);
    });

    it('behind state: source-hash differs from English body -> shows translated body with newer in English', () => {
        const staleGuide: Guide = {
            ...translatedGuide,
            guides: [{ ...translatedGuide.guides[0], sourceHash: '0000000000000000' }],
        };
        const pt = guideInLanguage(GUIDE, 'pt', PT, staleGuide);
        const page = findGuidePage(pt, 'browsing-the-market')!;
        expect(page.title).toBe('Explorar o Mercado');
        expect(page.blocks).toEqual(staleGuide.guides[0].blocks);
        expect(page.bodyState).toBe('behind');
        expect(guidePageBodyInEnglish(page)).toBe(false);
        expect(guidePageNewerInEnglish(page)).toBe(true);
        expect(page.englishBlocks).toEqual(market.blocks);
    });

    it('missing state: page not in translated guide -> shows English body', () => {
        const pt = guideInLanguage(GUIDE, 'pt', PT, translatedGuide);
        const how = findGuidePage(pt, 'how-it-works')!;
        expect(how.blocks).toEqual(GUIDE.guides[0].blocks);
        expect(how.bodyState).toBe('missing');
        expect(guidePageNewerInEnglish(how)).toBe(false);
    });

    it('search finds page by translated body words and English body words', () => {
        const pt = guideInLanguage(GUIDE, 'pt', PT, translatedGuide);
        // Translated body word
        expect(searchGuide(pt, 'categoria').map(r => r.page.slug)).toEqual(['browsing-the-market']);
        expect(searchGuide(pt, 'filtros').map(r => r.page.slug)).toEqual(['browsing-the-market']);
        // English body word from original blocks
        expect(searchGuide(pt, 'filters').map(r => r.page.slug)).toEqual(['browsing-the-market']);
    });

    it('caching and fetching language guide per language', async () => {
        const storage: Record<string, string> = {};
        const mockStorage: GuideStorage = {
            getItem: (k) => storage[k] ?? null,
            setItem: (k, v) => { storage[k] = v; },
        };
        expect(await loadCachedLanguageGuide(mockStorage, 'pt')).toBeNull();

        const fetched = await refreshLanguageGuideFromWebsite(
            null,
            mockStorage,
            async () => ({ ok: true, text: async () => JSON.stringify(translatedGuide) }),
            'pt',
        );
        expect(fetched?.version).toBe(1);
        expect(storage['beanpool_member_guide_v2:pt']).toBeTruthy();

        const cached = await loadCachedLanguageGuide(mockStorage, 'pt');
        expect(cached?.version).toBe(1);
        expect(cached?.guides[0].slug).toBe('browsing-the-market');

        // Rejects remote guide if its language does not match the requested locale (prevents cache poisoning)
        const englishFallback = { ...translatedGuide, language: undefined, version: 150 };
        const rejected = await refreshLanguageGuideFromWebsite(
            cached,
            mockStorage,
            async () => ({ ok: true, text: async () => JSON.stringify(englishFallback) }),
            'es',
        );
        expect(rejected).toBeNull();
        expect(storage['beanpool_member_guide_v2:es']).toBeUndefined();

        // Rejects cached guide if stored language does not match requested locale
        storage['beanpool_member_guide_v2:es'] = JSON.stringify(englishFallback);
        expect(await loadCachedLanguageGuide(mockStorage, 'es')).toBeNull();
        storage['beanpool_member_guide_v2:es'] = JSON.stringify({ ...translatedGuide, language: 'pt' });
        expect(await loadCachedLanguageGuide(mockStorage, 'es')).toBeNull();
    });

    it('ignores translatedGuide if language does not match the target language', () => {
        // translatedGuide is 'pt', but target is 'es'
        const esTitles: GuideTitles = {
            sections: {},
            pages: {
                'browsing-the-market': {
                    title: entry('Browsing the Market', 'Explorar el Mercado'),
                },
            },
        };
        const es = guideInLanguage(GUIDE, 'es', esTitles, translatedGuide);
        const page = findGuidePage(es, 'browsing-the-market')!;
        expect(page.title).toBe('Explorar el Mercado');
        expect(page.bodyInEnglish).toBe(true);
        expect(page.blocks).toEqual(GUIDE.guides.find(p => p.slug === 'browsing-the-market')!.blocks);
    });
});
