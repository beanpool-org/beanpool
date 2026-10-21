// @vitest-environment jsdom
/**
 * The members' guide's titles in the member's language (slice S5a): the guide list (app/beanpool.tsx), every section
 * (app/guide/section/[id].tsx) and every page (app/guide/[slug].tsx), rendered for real inside the real LanguageProvider
 * with the real useGuide, which lays a language's titles file (utils/guide-titles.ts) over the guide built into the app.
 *
 * In the pseudo-locale (`xx`) every title, summary and help line is pseudo-localised by core's guideInLanguage, so any
 * guide line outside a bracket bypassed it; the page bodies are English until slice S5b (they carry lang "en"). At 320 dp
 * with 1.3× text: no word wider than its line, and no guide title cut (the title cap, packages/beanpool-guide/src/
 * titles.mjs, is 35 % over the English: what the pseudo-locale pads). In Portuguese, a titles file as the drafting round
 * writes it: its lines show, a line it lacks or holds stale shows the English, and a page says its body is English.
 *
 * The published copy is what the app bundles, so the sample section and pages are taken from it, never named
 * (packages/beanpool-guide/README.md §3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screens don't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

// use-global-guest-visit reads useNodeStatus().recheck (only during a visit, which these screens never start); the real
// context pulls expo-crypto in at import.
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'unknown' }) }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityLanguage, testID, placeholder, numberOfLines, value, onChangeText, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityLanguage) attrs.lang = accessibilityLanguage;
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        if (s.textTransform) attrs['data-transform'] = s.textTransform;
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Linking: { openURL: async () => {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    const router = { push() {}, navigate() {}, back() {}, replace() {}, canGoBack: () => true };
    return { router, useLocalSearchParams: () => params.value, useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]), ErrorBoundary: () => null };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
// Portuguese reads the file each test sets; Turkish reads the shipped (drafted) file unless a test sets one.
const titles = vi.hoisted(() => ({ pt: null as unknown, tr: null as unknown }));
vi.mock('../guide-titles', async (importOriginal) => {
    const real = await importOriginal<typeof import('../guide-titles')>();
    return {
        guideTitlesFor: (lang: string) => (lang === 'pt' ? titles.pt : lang === 'tr' && titles.tr !== null ? titles.tr : real.guideTitlesFor(lang as never)),
    };
});
vi.mock('../use-learn-videos', () => ({ useLearnVideos: () => [] }));
vi.mock('../beanpool-links', () => ({ openBeanPoolWebsite: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), callsign: 'Damo' }, setIdentity() {} }),
}));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-door-open', () => ({ useGlobalDoor: () => ({ state: 'open', wordsDoor: true, retry() {} }) }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'join' }));
vi.mock('../use-communities', () => ({
    useCommunities: () => ({
        active: 'https://riverside.example',
        current: { url: 'https://riverside.example', name: 'Riverside', status: 'online' },
        rows: [{ url: 'https://riverside.example', name: 'Riverside', status: 'online' }],
        lastSync: Date.now() - 5 * 60_000,
        switching: false,
        switchTo: async () => {},
        remove: () => {},
    }),
}));

import {
    GUIDE_SLUGS, guideBodyHash, guideCacheKey, guideSourceHash, inCapitalsOf, manualSections, pseudoLocalise, sectionPages, relatedPages, searchGuide, setLanguage, splitBold,
    type GuideTitles, type Lang, type UiLang, type Guide,
} from '@beanpool/core';
import { LanguageProvider, useWords } from '../../components/LanguageProvider';
import { getBundledGuide } from '../guide';
import { resetGuideSessionForTests } from '../use-guide';
import { setTestCatalogsFor } from '../words-catalogs';
import { displayColumns, titleCap, TITLE_FLOOR_COLUMNS } from '../../../../packages/beanpool-guide/src/titles.mjs';
import BeanPoolSheet from '../../app/beanpool';
import GuideSectionScreen from '../../app/guide/section/[id]';
import GuideScreen from '../../app/guide/[slug]';

const GUIDE = getBundledGuide();
const ENGLISH_BODY = 'This page is in English for now.';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    resetGuideSessionForTests();
    setTestCatalogsFor(null);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    titles.pt = null;
    titles.tr = null;
    params.value = {};
    globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); setTestCatalogsFor(null); });

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const grabbed: { choose: ((lang: Lang | null) => void) | null } = { choose: null };
function Grab() { grabbed.choose = useWords().chooseLanguage; return null; }
async function renderIn(lang: UiLang, screen: () => unknown) {
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(Grab), createElement(screen as any)) as any); });
    await settle();
}
const spans = () => Array.from(host.querySelectorAll('span'));
const spanWith = (text: string) => spans().find((s) => s.textContent === text);
const type = async (el: Element | null | undefined, text: string) => {
    const input = el as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
};

/** Text with letters outside a bracket, outside the English body (lang "en") and outside what others wrote. */
const OTHERS = ['Riverside', 'riverside.example', 'beanpool.org', 'BeanPool'];
function bypassing(extra: readonly string[] = []): string[] {
    const others = [...OTHERS, ...extra].sort((a, b) => b.length - a.length);
    const outside = (text: string | null | undefined) => {
        if (!text) return false;
        let rest = text;
        for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
        for (const o of others) rest = rest.split(o).join('');
        return /\p{L}/u.test(rest);
    };
    const out = new Set<string>();
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('[lang="en"]')) continue;
        const whole = n.parentElement?.textContent ?? n.nodeValue;
        if (outside(whole)) out.add(`text: ${JSON.stringify(whole)}`);
    }
    for (const [attr, kind] of [['aria-label', 'label'], ['data-hint', 'hint'], ['placeholder', 'placeholder']] as const) {
        for (const e of Array.from(host.querySelectorAll(`[${attr}]`))) if (outside(e.getAttribute(attr))) out.add(`${kind}: ${JSON.stringify(e.getAttribute(attr))}`);
    }
    return [...out];
}

// ── 320 dp with text at 1.3× ───────────────────────────────────────────────────────────────────────────────────────
const SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) || /[\uFE0F\u200B\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
const widestWord = (text: string) => text.split(/[\s\u200B~]+/).reduce((a, b) => (widthOf(b, 1) > widthOf(a, 1) ? b : a), '');
const fontOf = (el: Element): number => { for (let e: Element | null = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 14; };
/**
 * The text column of each kind of row at 320 dp (as beanpool-global-row-render.test.ts measures the sheet's from the styles):
 * the sheet's rows have an icon (188); a section's rows sit in 16 dp of padding with no icon (224); a page's Related rows in
 * 20 dp (216); a page's header spans its 20 dp padding (280); a section's header its 16 dp (288).
 */
const COLUMN = { sheet: 188, sectionRow: 224, relatedRow: 216, pageHeader: 280, sectionHeader: 288 };

/** Words wider than `column`, among the guide's lines shown (those `lines` names) — each with its own font. */
function tooWide(lines: readonly string[], column: number): string[] {
    const out: string[] = [];
    for (const line of lines) {
        const span = spanWith(line);
        if (!span) { out.push(`not shown: ${line}`); continue; }
        const word = widestWord(line);
        const px = fontOf(span) * SCALE;
        if (widthOf(word, px) > column) out.push(`${word} (${Math.round(widthOf(word, px))} > ${column})`);
    }
    return out;
}
/** Guide titles drawn with a line limit: a longer language's title would be cut. */
const cut = (lines: readonly string[]) => lines.filter((l) => spanWith(l)?.hasAttribute('data-lines'));

describe("the guide in the pseudo-locale at 320 dp with 1.3× text: every title through the language layer, none cut", () => {
    const xx = (s: string) => pseudoLocalise(s);

    it('the guide list: the guides, every part of the manual and What\'s new, each title and summary', async () => {
        await renderIn('xx', BeanPoolSheet);
        const guides = [GUIDE_SLUGS.howItWorks, GUIDE_SLUGS.rules, GUIDE_SLUGS.faq, GUIDE_SLUGS.whatsNew].map((s) => GUIDE.guides.find((p) => p.slug === s)!);
        const rows = [...guides, ...manualSections(GUIDE)];
        const titlesShown = rows.map((r) => xx(r.title));
        for (const r of rows) expect(host.textContent, r.title).toContain(xx(r.summary));
        expect(tooWide(titlesShown, COLUMN.sheet)).toEqual([]);
        expect(cut(titlesShown)).toEqual([]);
        expect(bypassing()).toEqual([]);
    });

    it('every section: its title, summary and each page in it', async () => {
        for (const section of GUIDE.sections) {
            params.value = { id: section.id };
            await renderIn('xx', GuideSectionScreen);
            const pages = sectionPages(GUIDE, section);
            expect(tooWide([xx(section.title), xx(section.summary)], COLUMN.sectionHeader), section.id).toEqual([]);
            const rowTitles = pages.map((p) => xx(p.title));
            expect(tooWide(rowTitles, COLUMN.sectionRow), section.id).toEqual([]);
            for (const p of pages) expect(host.textContent, p.slug).toContain(xx(p.summary));
            expect(cut(rowTitles), section.id).toEqual([]);
            expect(bypassing(), section.id).toEqual([]);
        }
    });

    it('every page: its section, title and summary, one line saying the body is English, the body marked English, Related', async () => {
        for (const page of GUIDE.guides) {
            params.value = { slug: page.slug };
            await renderIn('xx', GuideScreen);
            const section = GUIDE.sections.find((s) => s.id === page.section)!;
            const kicker = inCapitalsOf(xx(section.title), 'xx');
            const header = [kicker, xx(page.title), xx(page.summary)];
            expect(tooWide(header, COLUMN.pageHeader), page.slug).toEqual([]);
            expect(cut(header), page.slug).toEqual([]);
            // In capitals the language's way, never a textTransform.
            expect(spanWith(kicker)!.hasAttribute('data-transform'), page.slug).toBe(false);
            expect(host.querySelector('[data-testid="guide-english-note"]')?.textContent, page.slug).toBe(xx(ENGLISH_BODY));
            const body = Array.from(host.querySelectorAll('[lang="en"]'));
            const bodyLines = page.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).map((t) => splitBold(t).map((s) => s.text).join(''));
            expect(body.map((e) => e.textContent), page.slug).toEqual(bodyLines);
            const related = relatedPages(GUIDE, page).map((r) => xx(r.title));
            expect(tooWide(related, COLUMN.relatedRow), page.slug).toEqual([]);
            expect(cut(related), page.slug).toEqual([]);
            expect(bypassing(), page.slug).toEqual([]);
        }
    });

    it('the search: an English word finds pages, and their rows read the language layer', async () => {
        await renderIn('xx', BeanPoolSheet);
        const query = GUIDE.guides.find((p) => p.slug === GUIDE_SLUGS.rules)!.title.split(' ')[0];
        await type(host.querySelector('input'), query);
        const found = searchGuide(GUIDE, query);
        expect(found.length).toBeGreaterThan(0);
        const shown = found.map((r) => xx(r.page.title));
        expect(tooWide(shown, COLUMN.sheet)).toEqual([]);
        expect(cut(shown)).toEqual([]);
        // The snippets are the English bodies' words.
        expect(bypassing(found.map((r) => r.snippet))).toEqual([]);
    });

    it('the cap the guide package holds titles to is what these renders show: 35 % over the English, and the floor fits one line', () => {
        for (const line of [...GUIDE.sections, ...GUIDE.guides]) {
            const cap = titleCap(line.title);
            if (cap > TITLE_FLOOR_COLUMNS) expect(displayColumns(pseudoLocalise(line.title)), line.title).toBeGreaterThanOrEqual(cap);
        }
        // Fourteen columns of the widest letters this measure knows, at the row title's 16 × 1.3, in the narrowest row.
        expect(widthOf('m'.repeat(TITLE_FLOOR_COLUMNS), 16 * SCALE)).toBeLessThanOrEqual(COLUMN.sheet);
    });

    it('a page behind in the pseudo-locale: the new line and toggle at 320 dp with 1.3× text, none cut', async () => {
        const page = GUIDE.guides[0];
        const staleHash = '0000000000000000';
        const xxGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'xx',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Section', summary: 'Summary', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: page.title,
                summary: page.summary,
                section: page.section,
                related: [],
                sourceHash: staleHash,
                blocks: [{ type: 'p', text: 'Cuerpo en pseudo.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(xxGuide) })) as unknown as typeof fetch;
        params.value = { slug: page.slug };
        await renderIn('xx', GuideScreen);
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
        const newerNote = host.querySelector('[data-testid="guide-newer-note"]');
        expect(newerNote?.textContent).toBe(xx('This page is newer in English.'));
        const toggle = host.querySelector('[data-testid="guide-toggle-english"]');
        expect(toggle?.textContent).toBe(xx('Read in English'));
        const header = [xx('This page is newer in English.'), xx('Read in English')];
        expect(tooWide(header, COLUMN.pageHeader)).toEqual([]);
        expect(cut(header)).toEqual([]);
        expect(bypassing(['Cuerpo en pseudo.'])).toEqual([]);

        // When toggled to English, check "Show translation" fits too
        await act(async () => { (toggle as HTMLElement).click(); });
        await settle();
        expect(toggle?.textContent).toBe(xx('Show translation'));
        expect(tooWide([xx('Show translation')], COLUMN.pageHeader)).toEqual([]);
        expect(cut([xx('Show translation')])).toEqual([]);
    });
});

describe('the guide in Portuguese: a titles file as the drafting round writes it', () => {
    const section = manualSections(GUIDE)[0];
    const [first, second] = sectionPages(GUIDE, section);
    const guide = GUIDE.guides.find((p) => p.slug === GUIDE_SLUGS.howItWorks)!;
    const entry = (english: string, text: string) => ({ text, sourceHash: guideSourceHash(english) });
    const PT: GuideTitles = {
        sections: { [section.id]: { title: entry(section.title, 'Primeiros passos traduzidos'), summary: entry(section.summary, 'Um resumo da secção em português.') } },
        pages: {
            [first.slug]: { title: entry(first.title, 'Primeira página traduzida'), summary: entry(first.summary, 'O resumo da primeira página.') },
            // Drafted from English the page no longer says: the English shows.
            [second.slug]: { title: entry(`${second.title} (an older title)`, 'Título antigo traduzido') },
            [guide.slug]: { title: entry(guide.title, 'Como funciona o BeanPool') },
        },
    };

    it('the list, the section and the page show the translation, the English where there is none or it is stale', async () => {
        titles.pt = PT;
        await renderIn('pt', BeanPoolSheet);
        expect(host.textContent).toContain('Primeiros passos traduzidos');
        expect(host.textContent).toContain('Como funciona o BeanPool');
        expect(host.textContent).toContain(GUIDE.guides.find((p) => p.slug === GUIDE_SLUGS.rules)!.title);

        params.value = { id: section.id };
        await renderIn('pt', GuideSectionScreen);
        expect(spanWith('Primeiros passos traduzidos')).toBeTruthy();
        expect(spanWith('Um resumo da secção em português.')).toBeTruthy();
        expect(spanWith('Primeira página traduzida')).toBeTruthy();
        expect(spanWith(second.title)).toBeTruthy();
        expect(host.textContent).not.toContain('Título antigo traduzido');

        params.value = { slug: first.slug };
        await renderIn('pt', GuideScreen);
        expect(spanWith('Primeira página traduzida')).toBeTruthy();
        expect(spanWith('O resumo da primeira página.')).toBeTruthy();
        expect(spanWith(inCapitalsOf('Primeiros passos traduzidos', 'pt'))).toBeTruthy();
        // One line says the body is English, in the member's language once the words round drafts it (English until then).
        expect(host.querySelectorAll('[data-testid="guide-english-note"]')).toHaveLength(1);
        expect(host.querySelector('[lang="en"]')).not.toBeNull();

        // A page with no translation reads English throughout, and says nothing about it.
        params.value = { slug: second.slug };
        await renderIn('pt', GuideScreen);
        expect(spanWith(second.title)).toBeTruthy();
        expect(host.querySelector('[data-testid="guide-english-note"]')).toBeNull();
        expect(host.querySelector('[lang="en"]')).toBeNull();
    });

    it('the search finds a page by its Portuguese title and by its English one, and shows it in Portuguese', async () => {
        titles.pt = PT;
        await renderIn('pt', BeanPoolSheet);
        await type(host.querySelector('input'), 'traduzida');
        expect(Array.from(host.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label'))).toContain('Primeira página traduzida');
        const english = first.title.split(' ').filter((w) => w.length > 3)[0] ?? first.title;
        await type(host.querySelector('input'), english);
        expect(Array.from(host.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label'))).toContain('Primeira página traduzida');
    });

    it('a language switch is live: the open page goes from English to Portuguese and back', async () => {
        titles.pt = PT;
        params.value = { slug: first.slug };
        await renderIn('en', GuideScreen);
        expect(spanWith(first.title)).toBeTruthy();
        expect(host.querySelector('[data-testid="guide-english-note"]')).toBeNull();
        await act(async () => { grabbed.choose!('pt'); });
        await settle();
        expect(spanWith('Primeira página traduzida')).toBeTruthy();
        expect(host.querySelector('[data-testid="guide-english-note"]')).not.toBeNull();
        await act(async () => { grabbed.choose!('en'); });
        await settle();
        expect(spanWith(first.title)).toBeTruthy();
        expect(host.querySelector('[data-testid="guide-english-note"]')).toBeNull();
    });
});

// Review round 1: the page's section line is in capitals the way of its words' language, not the member's. Turkish
// writes a capital i as İ; an English title (every title until the drafting round) keeps the English capitals.
describe('the guide in Turkish: the section line in the capitals of its own words', () => {
    const section = manualSections(GUIDE).find((s) => s.title.includes('i'))!;
    const [page] = sectionPages(GUIDE, section);

    it('with an empty titles file (a section not yet translated), the English section title reads in English capitals, never with a dotted İ', async () => {
        titles.tr = { sections: {}, pages: {} } satisfies GuideTitles;
        expect(inCapitalsOf(section.title, 'tr')).not.toBe(inCapitalsOf(section.title, 'en'));
        params.value = { slug: page.slug };
        await renderIn('tr', GuideScreen);
        expect(spanWith(inCapitalsOf(section.title, 'en'))).toBeTruthy();
        expect(spanWith(inCapitalsOf(section.title, 'tr'))).toBeUndefined();
    });

    it('a Turkish section title reads in Turkish capitals', async () => {
        titles.tr = { sections: { [section.id]: { title: { text: 'Yeni başlayanlar için', sourceHash: guideSourceHash(section.title) } } }, pages: {} } satisfies GuideTitles;
        params.value = { slug: page.slug };
        await renderIn('tr', GuideScreen);
        expect(spanWith('YENİ BAŞLAYANLAR İÇİN')).toBeTruthy();
        expect(spanWith('YENI BAŞLAYANLAR IÇIN')).toBeUndefined();
    });
});

describe('the three page states in the mobile app: current, behind with toggle, missing, and offline fallback', () => {
    const page = GUIDE.guides[0];
    const otherPage = GUIDE.guides[1];
    const currentHash = guideBodyHash(page.blocks);
    const staleHash = '0000000000000000';

    it('current state: matching source-hash renders translated body without english or newer notes', async () => {
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido atual.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })) as unknown as typeof fetch;
        params.value = { slug: page.slug };
        await renderIn('pt', GuideScreen);
        expect(host.textContent).toContain('Corpo traduzido atual.');
        expect(host.querySelector('[data-testid="guide-english-note"]')).toBeNull();
        expect(host.querySelector('[data-testid="guide-newer-note"]')).toBeNull();
        expect(host.querySelector('[data-testid="guide-draft-note"]')?.textContent).toBe('Traduzido por máquina: algumas palavras podem estar erradas.');
    });

    it('behind state: older source-hash renders translated body with newer note and toggle to read English', async () => {
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: staleHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido antigo.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })) as unknown as typeof fetch;
        params.value = { slug: page.slug };
        await renderIn('pt', GuideScreen);
        expect(host.textContent).toContain('Corpo traduzido antigo.');
        expect(host.querySelector('[data-testid="guide-newer-note"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="guide-draft-note"]')?.textContent).toBe('Traduzido por máquina: algumas palavras podem estar erradas.');
        const ptHeader = ['Traduzido por máquina: algumas palavras podem estar erradas.'];
        expect(tooWide(ptHeader, COLUMN.pageHeader)).toEqual([]);
        expect(cut(ptHeader)).toEqual([]);
        const toggle = host.querySelector('[data-testid="guide-toggle-english"]');
        expect(toggle?.textContent).toBe('Ler em inglês');

        // Toggle to English
        await act(async () => { (toggle as HTMLElement).click(); });
        await settle();
        expect(toggle?.textContent).toBe('Mostrar tradução');
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
        const englishLines = page.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).map((t) => splitBold(t).map((s) => s.text).join(''));
        expect(Array.from(host.querySelectorAll('[lang="en"]')).map((e) => e.textContent)).toEqual(englishLines);

        // Toggle back to Portuguese
        await act(async () => { (toggle as HTMLElement).click(); });
        await settle();
        expect(toggle?.textContent).toBe('Ler em inglês');
        expect(host.textContent).toContain('Corpo traduzido antigo.');
        expect(host.querySelector('[data-testid="guide-draft-note"]')?.textContent).toBe('Traduzido por máquina: algumas palavras podem estar erradas.');
    });

    it('missing state: untranslated page renders English body with english note', async () => {
        titles.pt = {
            sections: {},
            pages: { [otherPage.slug]: { title: { text: 'Título traduzido', sourceHash: guideSourceHash(otherPage.title) } } },
        } satisfies GuideTitles;
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido atual.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })) as unknown as typeof fetch;
        params.value = { slug: otherPage.slug };
        await renderIn('pt', GuideScreen);
        expect(host.querySelector('[data-testid="guide-english-note"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="guide-newer-note"]')).toBeNull();
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
        const englishLines = otherPage.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).map((t) => splitBold(t).map((s) => s.text).join(''));
        expect(Array.from(host.querySelectorAll('[lang="en"]')).map((e) => e.textContent)).toEqual(englishLines);
    });

    it('missing state without translated title has no draft line', async () => {
        titles.pt = { sections: {}, pages: {} } satisfies GuideTitles;
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido atual.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })) as unknown as typeof fetch;
        params.value = { slug: otherPage.slug };
        await renderIn('pt', GuideScreen);
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
    });

    it('offline fallback: fetch failure falls back to cached guide or English without error', async () => {
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página em cache',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo em cache offline.' }],
            }],
        };
        store.map.set(guideCacheKey('pt'), JSON.stringify(ptGuide));
        params.value = { slug: page.slug };
        await renderIn('pt', GuideScreen);
        expect(host.textContent).toContain('Corpo em cache offline.');
        expect(host.querySelector('[data-testid="guide-english-note"]')).toBeNull();
        expect(host.querySelector('[data-testid="guide-draft-note"]')?.textContent).toBe('Traduzido por máquina: algumas palavras podem estar erradas.');
    });

    it('English page has no draft line', async () => {
        params.value = { slug: page.slug };
        await renderIn('en', GuideScreen);
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
    });

    it('a language whose catalogs are not machine draft has no draft line', async () => {
        setTestCatalogsFor((l) => (l === 'pt' ? [{ _meta: { language: 'pt', review: 'human', reviewed: true } }] : undefined));
        const ptGuide: Guide = {
            schema: GUIDE.schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: page.section, title: 'Início', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: page.section,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido humano.' }],
            }],
        };
        globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })) as unknown as typeof fetch;
        params.value = { slug: page.slug };
        await renderIn('pt', GuideScreen);
        expect(host.textContent).toContain('Corpo traduzido humano.');
        expect(host.querySelector('[data-testid="guide-draft-note"]')).toBeNull();
    });
});
