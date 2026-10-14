// @vitest-environment jsdom
/**
 * The phone's language, live (translation design §1–2, slice S1; director amendments 1–2): the real LanguageProvider,
 * Settings → Language row, the first screen's switch and the Your area screen (app/your-area.tsx with its real
 * AreaPicker), rendered with react-dom in jsdom and React Native's host components as plain tags, at the floor's window
 * (320 dp, text at 1.3×), as profile-setup-area.test.ts does. Nothing here draws a frame: what is checked is the words on
 * screen, that a pick changes them without a remount, what is stored, which catalogs were built, and (a model of the
 * styles' own numbers, as sso-button-layout.test.ts does) that the welcome and join screens' words fit 320 dp at 1.3×.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled, value, onChangeText, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (typeof props.placeholder === 'string') attrs.placeholder = props.placeholder;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
        Keyboard: { dismiss: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
// `holds`: a read that answers late, with what was stored when it was asked (as AsyncStorage does).
const mem = vi.hoisted(() => ({ store: new Map<string, string>(), holds: new Map<string, Promise<void>>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => { const v = mem.store.get(k) ?? null; const h = mem.holds.get(k); if (h) await h; return v; }),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity: vi.fn() }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({ 'X-Public-Key': 'a'.repeat(64) })) }));
// The real town search (components/AddressSearch.tsx) is drawn, so its words are checked too (review of #1954, N2); it asks
// nothing until something is typed.
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-location', () => ({
    Accuracy: { Low: 2 },
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getCurrentPositionAsync: vi.fn(async () => ({ coords: { latitude: 0, longitude: 0 } })),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { currentLanguage, pseudoLocalise, setLanguage, type UiLang } from '@beanpool/core';
import { LanguageProvider, useWords } from '../../components/LanguageProvider';
import { LanguageRow, LanguageSwitch } from '../../components/LanguagePicker';
import { LANGUAGE_NAMES, LANGUAGE_PREFERENCE_KEY, languageHeader } from '../language-choice';
import YourAreaScreen from '../../app/your-area';

const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const CORE_WORDS = path.resolve(__dirname, '../../../../packages/beanpool-core/words');
const catalog = (dir: string, lang: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
const nativeWord = (lang: string, key: string) => catalog(NATIVE_WORDS, lang)[key] as string;
const coreWord = (lang: string, key: string) => catalog(CORE_WORDS, lang)[key] as string;

/** The catalogs Node has built in this process: the measure of "loaded" (Metro does the same per require on the phone). */
const nodeRequire = createRequire(import.meta.url);
const builtCatalogs = () => Object.keys(nodeRequire.cache).filter((f) => /[\\/]words[\\/][A-Za-z-]+\.json$/.test(f)).map((f) => path.relative(path.resolve(__dirname, '../../../..'), f)).sort();
const forgetCatalogs = () => { for (const f of Object.keys(nodeRequire.cache)) if (/[\\/]words[\\/][A-Za-z-]+\.json$/.test(f)) delete nodeRequire.cache[f]; };

const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };
/** A sentence on a screen: what a member reads, through the screen's own `useWords()`. */
function Probe() {
    const { t } = useWords();
    return createElement('span', { 'data-testid': 'probe' }, t('Welcome to BeanPool'));
}

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { mem.store.clear(); mem.holds.clear(); vi.clearAllMocks(); setLanguage('en'); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); });

async function mount(children: unknown[], props: { deviceTags?: string[]; initial?: UiLang } = {}): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: props.deviceTags ?? ["en-US"], initial: props.initial }, ...(children as any[])) as any); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    return host;
}
const byTestId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(id: string) {
    const target = byTestId(id);
    expect(target, `${id} is on screen`).toBeTruthy();
    await act(async () => { target!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('Settings → Language changes the words on screen, live', () => {
    it('a pick re-renders the same sentence in the new language, without a remount, and is kept on this phone only', async () => {
        await mount([createElement(LanguageRow, { key: 'row', styles: MENU }), createElement(Probe, { key: 'p' })]);
        const before = byTestId('probe')!;
        expect(before.textContent).toBe('Welcome to BeanPool');
        expect(byTestId('settings-language')!.textContent).toContain('Same as phone (English)');

        await click('settings-language');
        expect(host!.querySelector('[data-modal]'), 'the list opens').toBeTruthy();
        // Every language is listed in its own name.
        for (const name of Object.values(LANGUAGE_NAMES)) expect(host!.querySelector('[data-modal]')!.textContent).toContain(name);
        await click('language-fr');

        const after = byTestId('probe')!;
        expect(after.textContent).toBe(nativeWord('fr', 'Welcome to BeanPool'));
        expect(after.textContent).not.toBe('Welcome to BeanPool');
        expect(after, 'the same element, re-rendered: nothing restarted').toBe(before);
        expect(host!.querySelector('[data-modal]'), 'the list closes').toBeNull();
        expect(byTestId('settings-language')!.textContent).toContain('Français');
        // Labelled as a machine draft (director amendment 3), in the language itself.
        expect(byTestId('settings-language')!.textContent).toContain(nativeWord('fr', 'Translated by machine: some words may be wrong.'));
        expect(AsyncStorage.setItem).toHaveBeenCalledWith(LANGUAGE_PREFERENCE_KEY, 'fr');
        // Core's own words follow (a helper outside React), and a node hears it (Marty's call M6).
        expect(currentLanguage()).toBe('fr');
        expect(languageHeader()).toEqual({ 'X-Language': 'fr' });

        // "Same as phone" forgets the choice: back to the phone's English.
        await click('settings-language');
        const same = Array.from(host!.querySelectorAll('[data-modal] [role="radio"]')).find((b) => b.textContent?.startsWith(nativeWord('fr', 'Same as phone ({language})').split('{language}')[0])) as HTMLElement;
        expect(same).toBeTruthy();
        await act(async () => { same.click(); });
        expect(byTestId('probe')!.textContent).toBe('Welcome to BeanPool');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LANGUAGE_PREFERENCE_KEY);
        expect(languageHeader()).toEqual({ 'X-Language': 'en' });
    });

    it("the first screen's switch does the same, and shows the language it is in", async () => {
        await mount([createElement(LanguageSwitch, { key: 's' }), createElement(Probe, { key: 'p' })]);
        expect(byTestId('language-switch')!.textContent).toBe('🌐 English ▾');
        await click('language-switch');
        await click('language-ru');
        expect(byTestId('probe')!.textContent).toBe(nativeWord('ru', 'Welcome to BeanPool'));
        expect(byTestId('language-switch')!.textContent).toBe('🌐 Русский ▾');
        expect(mem.store.get(LANGUAGE_PREFERENCE_KEY)).toBe('ru');
    });
});

describe('which language a phone starts in', () => {
    it("the phone's language when BeanPool has it, the stored choice over it, and a stale stored value never breaks a screen", async () => {
        await mount([createElement(Probe, { key: 'p' })], { deviceTags: ['pt-BR'] });
        expect(byTestId('probe')!.textContent).toBe(nativeWord('pt', 'Welcome to BeanPool'));
        act(() => root?.unmount()); host?.remove();

        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'de');
        await mount([createElement(Probe, { key: 'p' })], { deviceTags: ['pt-BR'] });
        expect(byTestId('probe')!.textContent).toBe(nativeWord('de', 'Welcome to BeanPool'));
        act(() => root?.unmount()); host?.remove();

        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'klingon');
        await mount([createElement(Probe, { key: 'p' })], { deviceTags: ['zh_TW_#Hant'] });
        expect(byTestId('probe')!.textContent).toBe(nativeWord('zh-Hant', 'Welcome to BeanPool'));
    });

    it('a pick made before the stored choice is read is not undone when the read lands (review of #1954, N3)', async () => {
        for (const stored of ['fr', null]) {
            let release!: () => void;
            mem.holds.set(LANGUAGE_PREFERENCE_KEY, new Promise<void>((r) => { release = r; }));
            if (stored) mem.store.set(LANGUAGE_PREFERENCE_KEY, stored); else mem.store.delete(LANGUAGE_PREFERENCE_KEY);
            await mount([createElement(LanguageSwitch, { key: 's' }), createElement(Probe, { key: 'p' })], { deviceTags: ['en-US'] });
            // The first frame is the phone's language until the stored choice is read (as the theme draws light first).
            expect(byTestId('probe')!.textContent).toBe('Welcome to BeanPool');
            await click('language-switch');
            await click('language-ru');
            expect(byTestId('probe')!.textContent).toBe(nativeWord('ru', 'Welcome to BeanPool'));
            // The read lands with what was stored before the pick: the pick stands, on screen, in core and for the node.
            await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
            expect(byTestId('probe')!.textContent, `a late read of ${stored} undid the pick`).toBe(nativeWord('ru', 'Welcome to BeanPool'));
            expect(currentLanguage()).toBe('ru');
            expect(languageHeader()).toEqual({ 'X-Language': 'ru' });
            expect(mem.store.get(LANGUAGE_PREFERENCE_KEY)).toBe('ru');
            act(() => root?.unmount()); host?.remove(); root = null; host = null;
            mem.holds.clear();
        }
    });

    it("a phone in English builds no catalog; a pick builds that language's alone", async () => {
        forgetCatalogs();
        expect(builtCatalogs()).toEqual([]);
        await mount([createElement(LanguageRow, { key: 'row', styles: MENU }), createElement(Probe, { key: 'p' })], { deviceTags: ['en-AU'] });
        expect(byTestId('probe')!.textContent).toBe('Welcome to BeanPool');
        expect(builtCatalogs(), 'booting in en requires no other catalog').toEqual([]);

        await click('settings-language');
        await click('language-ru');
        expect(builtCatalogs()).toEqual(['apps/native/words/ru.json', 'packages/beanpool-core/words/ru.json']);
    });
});

// ── 320 dp, text at 1.3× ─────────────────────────────────────────────────────────────────────────────────────────

const FLOOR = 320;
const FONT_SCALE = 1.3;
/**
 * A generous glyph width, as sso-button-layout.test.ts: 0.62 em for a bold Latin, Cyrillic, Greek or Arabic letter (Roboto
 * and SF average nearer 0.55), 1.25 em for an emoji, a whole em for a CJK character; joiners, selectors and combining marks
 * (\p{M}: Indic vowel signs and viramas, which sit on the letter before them) take none.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const glyphEm = (c: string) => (/\p{M}/u.test(c) ? 0 : /[️‌‍]/.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
const widthOf = (text: string, fontSize: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * fontSize * FONT_SCALE, 0);
/** The widest piece a line can't break inside: a word, or one character in CJK text (the pseudo-locale's ~ padding is not a word). */
const widestPiece = (text: string) => text.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
/** The font size a text element is drawn at: its own, or the one it inherits from the text it sits in. */
const fontOf = (el: Element | null): number => { for (let e = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 16; };
const LANGS_AT_FLOOR: UiLang[] = ['xx', 'ru', 'fr', 'ar', 'zh-Hans'];
const inLang = (lang: UiLang, key: string, dir = NATIVE_WORDS) => (lang === 'xx' ? pseudoLocalise(key) : (catalog(dir, lang)[key] as string));

describe('Your area at 320 dp with 1.3× text, in xx, ru, fr, ar (left to right for now) and zh-Hans', () => {
    for (const lang of LANGS_AT_FLOOR) {
        it(`${lang}: every sentence is the language's, core's area words follow the phone, and the one-line title fits`, async () => {
            const page = await mount([createElement(YourAreaScreen, { key: 'a' })], { initial: lang });
            await click('area-type-town');
            const town = page.querySelector('[data-testid="area-town-search"]')!;
            expect(town, 'the town search is open').toBeTruthy();
            const box = town.querySelector('input')!;
            expect(box.getAttribute('placeholder')).toBe(inLang(lang, 'Town or suburb', CORE_WORDS));
            expect(box.getAttribute('aria-label')).toBe(inLang(lang, 'Find your town or suburb', CORE_WORDS));
            expect(town.textContent).toContain(inLang(lang, 'Places from OpenStreetMap. What you type here is sent to them.', CORE_WORDS));
            const title = page.querySelector('[role="heading"][data-lines="1"]') as HTMLElement;
            expect(title.textContent).toBe(inLang(lang, 'Your area'));
            // The header's title: 320 less the two 48dp buttons and 8dp padding a side, 16 at 1.3×, in capitals.
            expect(widthOf(title.textContent!.toUpperCase(), 16)).toBeLessThanOrEqual(FLOOR - 2 * 8 - 2 * 48);
            // Core's area step words (word() in member-area-words.ts) and the Settings line (describeArea) read the language too.
            expect(page.textContent).toContain(inLang(lang, 'Roughly where are you?', CORE_WORDS));
            expect(page.textContent).toContain(inLang(lang, 'Use my location', CORE_WORDS));
            expect(page.textContent).toContain(inLang(lang, 'Cancel'));
            if (lang === 'xx') {
                // The pseudo-locale's guard: every leaf that has letters in it came through t() (it is bracketed), the open
                // town search's included.
                const leaves = Array.from(page.querySelectorAll('span')).filter((s) => s.children.length === 0 && /\p{L}/u.test(s.textContent ?? ''));
                expect(leaves.length).toBeGreaterThan(5);
                for (const leaf of leaves) expect(leaf.textContent, `"${leaf.textContent}" bypassed t()`).toMatch(/^\[.*\]$/s);
            }
            // The card's words wrap at a word, never inside one: 320 less 16dp scroll and 16dp card padding a side.
            const inner = FLOOR - 2 * 16 - 2 * 16;
            for (const leaf of Array.from(page.querySelectorAll('span')).filter((s) => s.children.length === 0)) {
                const piece = widestPiece(leaf.textContent ?? '');
                expect(widthOf(piece, fontOf(leaf)), `"${piece}" in ${lang} at ${fontOf(leaf)}`).toBeLessThanOrEqual(inner);
            }
        });
    }
});

/**
 * The welcome screen and the join screen (app/welcome.tsx), modelled from their styles' own numbers: rendering the
 * whole 3,800-line screen would need its 67 imports stubbed. The words are the catalogs' (or the pseudo-locale's).
 */
describe('the welcome and join screens\' words at 320 dp with 1.3× text', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
    // The home screen's two big buttons: one line in English, a second line for a longer language, shrinking to 0.6 at most.
    const ONE_LINE_BUTTONS = ['🎟️ Join with an invite', '🌍 Explore BeanPool worldwide'];
    // homeContent padding 24 a side, memberBtn paddingHorizontal 12 a side: the label's line.
    const BUTTON_LINE = FLOOR - 2 * 24 - 2 * 12;
    // The join card: scroll padding 24 a side, card padding 24 a side.
    const CARD_LINE = FLOOR - 2 * 24 - 2 * 24;
    // Each sentence's size where it differs from the 16 of body text (welcome.tsx makeStyles: headerTitle 24, title 20,
    // callsignLabel 18, memberBtnText 18, tosText 12); the rest at 16, the largest body size, so smaller text is over-measured.
    const FONT_OF: Record<string, number> = {
        'Welcome to BeanPool': 24, '🎟️ Join BeanPool': 20, 'What should we call you?': 18,
        '🎟️ Join with an invite': 18, '🌍 Explore BeanPool worldwide': 18,
        // The join card's helper lines (fieldHint, callsignHelper, callsignTip 13).
        "Required — the community node you're joining. Ask whoever invited you if you're unsure.": 13,
        'This is your display name — how the community sees you, e.g. Sarah. You can change it later.': 13,
        '💡 Tip: adding your suburb helps locals find you!': 13,
        // The recover link under an "already used" invite (13, bold).
        '🔑 Recover an existing account with seed phrase →': 13,
        // The terms line (tosText 12; its two links inherit it).
        'By joining you agree to our {terms} and {privacy}.': 12, 'Terms of Service & EULA': 12, 'Privacy Policy': 12,
    };
    // The home screen's column (homeContent padding 24 a side): the title's line, wider than the join card's.
    const HOME_LINE = FLOOR - 2 * 24;
    const LINE_OF: Record<string, number> = { 'Welcome to BeanPool': HOME_LINE };
    // The onboarding stepper (welcome.tsx stepperStyles): four equal quarters of the row inside the scroll's 24dp and the
    // row's 8dp padding, less three 12dp connectors with 2dp margins; labels at 11, up to three lines, shrinking to 0.7.
    // Every real language holds in two; the third line is for the pseudo-locale's +35%.
    const STEPS = ['Your Name', 'Your Photo', 'Safety Backup', 'How it Works'];
    const STEP_WIDTH = (FLOOR - 2 * 24 - 2 * 8 - 3 * (12 + 2 * 2)) / 4;
    const ALL_LANGS: UiLang[] = ['xx', ...fs.readdirSync(NATIVE_WORDS).filter((f) => /^[A-Za-z-]+\.json$/.test(f)).map((f) => f.slice(0, -5) as UiLang)];
    const keys = Array.from(source.matchAll(/\bt\((['"])((?:(?!\1)[^\\]|\\.)*)\1/g)).map((m) => m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'"));

    it('the screens\' sentences are through t(), and the two big buttons are the only lines with a limit (two lines)', () => {
        for (const key of ONE_LINE_BUTTONS) expect(keys).toContain(key);
        expect(keys.length).toBeGreaterThanOrEqual(40);
        const home = source.slice(source.indexOf('// --- MAIN WELCOME SCREEN ---'), source.indexOf('function makeStyles('));
        expect((home.match(/numberOfLines=\{\d\}/g) ?? []).length).toBe(2);
        expect((home.match(/numberOfLines=\{2\} adjustsFontSizeToFit minimumFontScale=\{0\.6\}/g) ?? []).length).toBe(2);
        expect((home.match(/adjustsFontSizeToFit minimumFontScale=\{0\.6\}/g) ?? []).length).toBe(2);
        expect(home).toContain('<LanguageSwitch />');
        // A wrapped label's two lines sit in the middle of the button (review of #1954, N5).
        expect(source).toMatch(/memberBtnText: \{[^}]*textAlign: 'center'/);
    });

    it('the stepper\'s four labels are through t(), in four equal quarters, up to three centred lines at 0.7', () => {
        expect(source).toContain("const steps = [t('Your Name'), t('Your Photo'), t('Safety Backup'), t('How it Works')];");
        expect(source).toMatch(/stepperStyles\.labelActive\]\} numberOfLines=\{3\} adjustsFontSizeToFit minimumFontScale=\{0\.7\}>\{label\}/);
        expect(source).toMatch(/stepItem: \{\s*alignItems: 'center',\s*flex: 1,/);
        expect(source).toMatch(/    label: \{[^}]*textAlign: 'center'/);
        expect(source).toMatch(/    line: \{\s*width: 12,/);
        expect(STEP_WIDTH).toBe(52);
        // English needs it too: on one line the four labels are 273dp at 0.7 by this model (237dp with real shaping) in
        // a 184dp row, so one line cut them off before any translation.
        expect(STEPS.reduce((w, k) => w + widthOf(k, 11) * 0.7, 0)).toBeGreaterThan(4 * STEP_WIDTH);
    });

    for (const lang of ALL_LANGS) {
        it(`${lang}: each big button and stepper label fits its two lines at its smallest with no word cut, and no word is wider than its line`, () => {
            for (const key of STEPS) {
                const label = inLang(lang, key);
                expect(typeof label, `${key} has a ${lang} translation`).toBe('string');
                expect(widthOf(label, 11) * 0.7, `"${label}" in ${lang}`).toBeLessThanOrEqual((lang === 'xx' ? 3 : 2) * STEP_WIDTH);
                expect(widthOf(widestPiece(label), 11) * 0.7, `a word of "${label}" in ${lang}`).toBeLessThanOrEqual(STEP_WIDTH);
            }
            for (const key of ONE_LINE_BUTTONS) {
                const label = inLang(lang, key);
                expect(typeof label, `${key} has a ${lang} translation`).toBe('string');
                expect(widthOf(label, 18) * 0.6, `"${label}" in ${lang}`).toBeLessThanOrEqual(2 * BUTTON_LINE);
                expect(widthOf(widestPiece(label), 18) * 0.6, `a word of "${label}" in ${lang}`).toBeLessThanOrEqual(BUTTON_LINE);
            }
            for (const key of keys) {
                if (lang !== 'xx') expect(typeof catalog(NATIVE_WORDS, lang)[key], `"${key}" has a ${lang} translation`).toBe('string');
                const piece = widestPiece(inLang(lang, key));
                expect(widthOf(piece, FONT_OF[key] ?? 16), `"${piece}" (${lang}) breaks inside a word on a 320 dp card`).toBeLessThanOrEqual(LINE_OF[key] ?? CARD_LINE);
            }
        });
    }
});
