// @vitest-environment jsdom
/**
 * The tab strip in the member's language (words slice S3, first lane): app/(tabs)/_layout.tsx rendered for real inside
 * the real LanguageProvider, with react-dom in jsdom, React Native's host components as plain tags carrying their props,
 * and expo-router's Tabs drawing each screen's options as a button (its label, title and screen-reader label).
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed) any label without the brackets
 * bypassed t(). At 320 dp with text at 1.3× (the label capped at 1.1×) six tabs share the strip; a longer word shrinks
 * to fit its tab (adjustsFontSizeToFit, down to 0.6) on its one line rather than being cut off, but a translated tab
 * word must fit at 0.8 (8.8 dp, still readable): the short `tab` word, never a full one that needs more shrink. Widths
 * are a model of the styles' own numbers, as language-switch-render.test.ts measures the welcome screen's buttons, except
 * in hi, bn, ta and ml, which the model counts far too narrow: there each tab word's width is measured as Android draws it
 * (tab-word-widths.json, from scripts/words/measure-tab-words.mjs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The layout's JSX compiles to React.createElement here, and it imports only hooks from react.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, numberOfLines, adjustsFontSizeToFit, minimumFontScale, maxFontSizeMultiplier, style } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (adjustsFontSizeToFit) attrs['data-shrinks'] = 'true';
        if (minimumFontScale !== undefined) attrs['data-min-scale'] = String(minimumFontScale);
        if (maxFontSizeMultiplier !== undefined) attrs['data-max-scale'] = String(maxFontSizeMultiplier);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        if (typeof flat.marginHorizontal === 'number') attrs['data-margin-x'] = String(flat.marginHorizontal);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
// expo-router's Tabs: each screen's options drawn as its button would carry them.
vi.mock('expo-router', () => {
    const Tabs = ({ children }: { children?: unknown }) => createElement('nav', null, children as any);
    Tabs.Screen = ({ name, options }: { name: string; options: Record<string, any> }) => createElement('button', {
        'data-tab': name,
        'data-testid': options.tabBarButtonTestID,
        'data-title': options.title,
        'aria-label': options.tabBarAccessibilityLabel,
        'data-off-strip': options.href === null ? 'true' : undefined,
    }, options.tabBarIcon({ focused: false, color: '#000' }));
    return { Tabs, ErrorBoundary: () => null, usePathname: () => '/', router: { navigate: vi.fn(), push: vi.fn() } };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
// The header and the help sheet are their own screens' tests (GlobalHeader is protected); the tour bar is tour-render's.
vi.mock('../../components/GlobalHeader', () => ({ GlobalHeader: () => null, HEADER_ROW_HEIGHT: 56 }));
vi.mock('../../components/TourBar', () => ({ TourBar: () => null, tourSceneInset: () => 0 }));
vi.mock('../../components/HelpSheet', () => ({ HelpSheet: () => null }));
vi.mock('../use-guide', () => ({ useGuide: () => ({ guide: null, source: 'bundled' }) }));
// No tour running (its bar and steps are tour-render.test.ts's).
vi.mock('../tour-store', () => ({
    OPEN_HELP_EVENT: 'open_help', helpContext: () => null, useTour: () => ({ run: null, home: null }),
    closeTour: vi.fn(), moveTour: vi.fn(), startTour: vi.fn(),
}));
vi.mock('../db', () => ({
    getGlobalUnreadCount: vi.fn(async () => 0), syncMessages: vi.fn(async () => undefined), getPosts: vi.fn(async () => []), getMarketplaceTransactions: vi.fn(async () => []),
}));
// The message backstop asks whether the socket is alive (slice L0); the socket itself loads Expo's native modules.
vi.mock('../../services/ws-client', () => ({ webSocketAliveSince: () => false }));
vi.mock('../node-profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../node-profile')>()),
    fetchNodeProfile: vi.fn(async () => null), getCachedNodeProfile: vi.fn(async () => null),
}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null }) }));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ nodeUrl: null }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ colors: lightColors, theme: 'light' }) };
});

import { pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import TabLayout from '../../app/(tabs)/_layout';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'), 'utf8');
const num = (name: string) => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(SOURCE)![1]);
const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const CATALOG_LANGS = fs.readdirSync(NATIVE_WORDS).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => f.slice(0, -5) as UiLang);
const catalog = (lang: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8'));

/** The strip's tabs, in order, with their English names; and those off the strip (routes only). */
const STRIP = [['index', 'Home'], ['market', 'Market'], ['map', 'Map'], ['chats', 'Talk'], ['projects', 'Commons'], ['ledger', 'Ledger']] as const;
const OFF_STRIP = [['people', 'People'], ['pulse', 'Pulse'], ['settings', 'Settings']] as const;
const TAB_KEY = (english: string) => `${english}\u0004tab`;

// ── The width model (language-switch-render.test.ts's): a generous 0.62 em a letter, 1.25 em an emoji, an em for CJK ──
const FLOOR = 320;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const glyphEm = (c: string) => (/\p{M}/u.test(c) ? 0 : /[\uFE0F\u200C\u200D]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
const widthOf = (text: string, px: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * px, 0);
/**
 * The smallest a translated tab word may be drawn: 0.8 of the 1.1× label, 8.8 dp (deciding review of #2152). The layout's
 * LABEL_MIN_SCALE (0.6) is only the safety net that keeps a label whole.
 */
const READABLE_SCALE = 0.8;
/**
 * Tab words in hi, bn, ta and ml, in em, shaped by HarfBuzz in Noto Sans <script> Bold (and its UI variant, the wider):
 * the model above counts these scripts 1.03–4.9× too narrow (a Tamil letter is near an em; ml "ഹോം" is one cluster three
 * em wide), and conjuncts fold several code points into one glyph, so no per-letter em is both safe and close. For the
 * other catalogs the model holds: their tab words, shaped in Roboto Bold and Noto Naskh / Nastaliq Bold, are within 8 %
 * of it and every one fits unshrunk.
 */
const MEASURED: { widths: Record<string, Record<string, number>>; probes: Record<string, Record<string, number>> } = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'tab-word-widths.json'), 'utf8'));
const MEASURED_LANGS = Object.keys(MEASURED.widths);
const REMEASURE = 'node scripts/words/measure-tab-words.mjs';
/**
 * The tab words in a catalog that fit their tab only below `scale`: each named with its tab. In a measured language a
 * word is held to its measured width, and one with none fails (`measured` adds the review's probe words).
 */
const tooWide = (words: Record<string, unknown>, scale: number, lang?: string, measured: Record<string, number> = MEASURED.widths[lang ?? ''] ?? {}) => STRIP.flatMap(([, english]) => {
    const translated = words[TAB_KEY(english)];
    if (typeof translated !== 'string') return [];
    const px = num('LABEL_SIZE') * num('LABEL_MAX_SCALE') * scale;
    if (lang && MEASURED_LANGS.includes(lang)) {
        const em = measured[translated];
        if (em === undefined) return [`"${translated}" (the ${english} tab) has no measured width: ${REMEASURE}`];
        return em * px > FLOOR / STRIP.length ? [`"${translated}" (the ${english} tab)`] : [];
    }
    return widthOf(translated, px) > FLOOR / STRIP.length ? [`"${translated}" (the ${english} tab)`] : [];
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { setLanguage('en'); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); });

async function renderTabs(lang: UiLang): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(TabLayout)) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return host;
}
const tab = (name: string) => host!.querySelector(`[data-tab="${name}"]`) as HTMLElement;
/** The label over the icon: the tab's first one-line text. */
const labelOf = (name: string) => tab(name).querySelector('span[data-lines="1"]') as HTMLElement;

describe('the tab strip in English is as it was', () => {
    it('each tab says its name, as its label, its title and to a screen reader', async () => {
        await renderTabs('en');
        for (const [name, english] of [...STRIP, ...OFF_STRIP]) {
            expect(labelOf(name).textContent, name).toBe(english);
            expect(tab(name).getAttribute('data-title')).toBe(english);
            expect(tab(name).getAttribute('aria-label')).toBe(english);
        }
        expect(STRIP.map(([name]) => name)).toEqual(Array.from(host!.querySelectorAll('[data-tab]:not([data-off-strip])')).map((b) => b.getAttribute('data-tab')));
    });
});

describe('the tab strip in the pseudo-locale at 320 dp with 1.3× text', () => {
    it('every label, title and screen-reader label came through t() (bracketed), and no other words are drawn', async () => {
        const page = await renderTabs('xx');
        for (const [name, english] of [...STRIP, ...OFF_STRIP]) {
            expect(labelOf(name).textContent, name).toBe(pseudoLocalise(english));
            expect(tab(name).getAttribute('data-title')).toBe(pseudoLocalise(english));
            expect(tab(name).getAttribute('aria-label')).toBe(pseudoLocalise(english));
        }
        const leaves = Array.from(page.querySelectorAll('span')).filter((s) => s.children.length === 0 && /\p{L}/u.test(s.textContent ?? ''));
        expect(leaves.length).toBe(STRIP.length + OFF_STRIP.length);
        for (const leaf of leaves) expect(leaf.textContent, `"${leaf.textContent}" bypassed t()`).toMatch(/^\[.*\]$/s);
    });

    it('a label is one line that shrinks to fit its tab, never cut off; the pseudo-locale\'s longest fits at the smallest', async () => {
        await renderTabs('xx');
        const size = num('LABEL_SIZE');
        const maxScale = num('LABEL_MAX_SCALE');
        const minScale = num('LABEL_MIN_SCALE');
        expect(minScale).toBe(0.6);
        // Six tabs share the floor's width; the label's -5dp margins give it the tab's full width (TabItem).
        const tabWidth = FLOOR / STRIP.length;
        for (const [name, english] of STRIP) {
            const label = labelOf(name);
            expect(label.getAttribute('data-shrinks'), name).toBe('true');
            expect(label.getAttribute('data-min-scale')).toBe(String(minScale));
            expect(label.getAttribute('data-max-scale')).toBe(String(maxScale));
            expect(label.getAttribute('data-font')).toBe(String(size));
            expect(label.getAttribute('data-margin-x')).toBe('-5');
            // English needs no shrinking: each name fits its tab at the full 1.1× (the emulator-measured cap).
            expect(widthOf(english, size * maxScale), english).toBeLessThanOrEqual(tabWidth);
            // The pseudo-locale (+35 %, brackets) fits at its smallest, and so does its widest word.
            expect(widthOf(label.textContent!, size * maxScale) * minScale, label.textContent!).toBeLessThanOrEqual(tabWidth);
        }
    });

    it('a translated tab name, in any catalog that has one, fits its tab at 8.8 dp (0.8), not only at the safety net', () => {
        expect(READABLE_SCALE).toBeGreaterThan(num('LABEL_MIN_SCALE'));
        expect(num('LABEL_SIZE') * num('LABEL_MAX_SCALE') * READABLE_SCALE).toBeCloseTo(8.8, 5);
        for (const lang of CATALOG_LANGS) expect([lang, tooWide(catalog(lang), READABLE_SCALE, lang)]).toEqual([lang, []]);
    });

    it('a full word that fits only by shrinking below 0.8 fails: the catalog must give the short `tab` word', () => {
        // pt's full "Bens comuns" for Commons: 75 dp at 1.1×, so it would be drawn near 7.8 dp in a 53 dp tab.
        const full = { [TAB_KEY('Commons')]: 'Bens comuns', [TAB_KEY('Market')]: 'Mercado' };
        expect(tooWide(full, READABLE_SCALE)).toEqual(['"Bens comuns" (the Commons tab)']);
        // The old check, at the safety net, let it through.
        expect(tooWide(full, num('LABEL_MIN_SCALE'))).toEqual([]);
        // The short word passes; so does a word in a context other than `tab` (the page's own title).
        expect(tooWide({ [TAB_KEY('Commons')]: 'Comuns', 'Commons': 'Bens comuns' }, READABLE_SCALE)).toEqual([]);
    });
});

describe('hi, bn, ta and ml at 320 dp with 1.3× text: each tab word as the font draws it (#2152 deciding review)', () => {
    const tabWidth = FLOOR / STRIP.length;
    const labelPx = () => num('LABEL_SIZE') * num('LABEL_MAX_SCALE');

    it('every tab word in those catalogs has a measured width, and the table holds no word they no longer have', () => {
        expect(MEASURED_LANGS.sort()).toEqual(['bn', 'hi', 'ml', 'ta']);
        for (const lang of MEASURED_LANGS) {
            const words = STRIP.map(([, english]) => catalog(lang)[TAB_KEY(english)]).filter((w): w is string => typeof w === 'string');
            expect([lang, words.length]).toEqual([lang, STRIP.length]);
            expect([lang, Object.keys(MEASURED.widths[lang]).sort()], REMEASURE).toEqual([lang, [...words].sort()]);
        }
    });

    it('each is drawn at 0.8 or larger, so at 8.8 dp or more, and none leans on the 0.6 net (Tamil Map is the tightest)', () => {
        const scales: Record<string, number> = {};
        for (const lang of MEASURED_LANGS) {
            for (const [word, em] of Object.entries(MEASURED.widths[lang])) scales[`${lang} ${word}`] = Math.min(1, tabWidth / (em * labelPx()));
        }
        for (const [word, scale] of Object.entries(scales)) expect([word, scale >= READABLE_SCALE]).toEqual([word, true]);
        expect(Math.min(...Object.values(scales))).toBeCloseTo(scales['ta வரைபடம்'], 10);
        expect(scales['ta வரைபடம்']).toBeGreaterThan(0.85);
    });

    it('the model counts these scripts too narrow: it passes words the font draws below 0.8, even below the 0.6 net, which the measured check refuses', () => {
        for (const [lang, probes] of Object.entries(MEASURED.probes)) {
            for (const [word, em] of Object.entries(probes)) {
                const asLedger = { [TAB_KEY('Ledger')]: word };
                // By the model it fits at 0.8 …
                expect([lang, word, tooWide(asLedger, READABLE_SCALE)]).toEqual([lang, word, []]);
                // … the font draws it below the 0.6 net: cut off on the phone.
                expect(tabWidth / (em * labelPx())).toBeLessThan(num('LABEL_MIN_SCALE'));
                expect(tooWide(asLedger, READABLE_SCALE, lang, { ...MEASURED.widths[lang], ...probes })).toEqual([`"${word}" (the Ledger tab)`]);
            }
        }
        // A tab word changed in a catalog without being measured fails, saying how to measure it.
        expect(tooWide({ [TAB_KEY('Map')]: 'நிலவரைபடம்' }, READABLE_SCALE, 'ta')).toEqual([`"நிலவரைபடம்" (the Map tab) has no measured width: ${REMEASURE}`]);
    });
});
