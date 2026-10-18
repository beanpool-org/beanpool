// @vitest-environment jsdom
/**
 * A language change draws the whole app again (Marty's report on 1.2.67: picking a language in Settings changed only the
 * Language row; the rest stayed English, even after a restart). Most screens write their words with core's bare `t()`,
 * which reads the device language when the screen renders and re-renders nothing when it changes; the navigator's
 * screens are not re-rendered by their parents either. So the app's root draws the navigator inside
 * components/LanguageProvider.tsx `DrawnInLanguage`, keyed on the language: a change mounts every screen again, written
 * in the new language. What sits above it (the account, the community the phone is on) is kept.
 *
 * Rendered with react-dom in jsdom and React Native's host components as plain tags, as language-switch-render.test.ts
 * does. The "screen" here is memoised and takes no props, as a navigator's screens are: only a remount redraws it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, memo, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', radio: 'radio' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
// `holds`: a read that answers late (or never), with what was stored when it was asked (as AsyncStorage does).
const mem = vi.hoisted(() => ({ store: new Map<string, string>(), holds: new Map<string, Promise<void>>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => { const v = mem.store.get(k) ?? null; const h = mem.holds.get(k); if (h) await h; return v; }),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
// The community's default language, as the phone's copy of its profile says it (utils/node-profile.ts).
const community = vi.hoisted(() => ({ language: null as string | null }));
vi.mock('../node-profile', () => ({ getCachedNodeProfile: vi.fn(async (url: string | null) => (url && community.language ? { language: community.language } : null)) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx) };
});

import { pseudoLocalise, setLanguage, t } from '@beanpool/core';
import { DrawnInLanguage, LanguageProvider, SETTLE_MS, useWords } from '../../components/LanguageProvider';
import { LanguageRow } from '../../components/LanguagePicker';
import { LANGUAGE_PREFERENCE_KEY } from '../language-choice';

const NATIVE_WORDS = path.resolve(__dirname, '../../words');
const nativeWord = (lang: string, key: string) => JSON.parse(fs.readFileSync(path.join(NATIVE_WORDS, `${lang}.json`), 'utf8'))[key] as string;
const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };

const count = { screenMounts: 0, shellMounts: 0 };
/** A screen that writes with core's bare t(), memoised with no props: what a navigator's screen is to its parent. */
const BareScreen = memo(function BareScreen() {
    useEffect(() => { count.screenMounts += 1; }, []);
    return createElement('span', { 'data-testid': 'bare' }, t('Welcome to BeanPool'));
});
/** Above the redraw, as the account and node status providers are: its state must survive a change of language. */
function Shell({ children }: { children?: unknown }) {
    const [taps, setTaps] = useState(0);
    useEffect(() => { count.shellMounts += 1; }, []);
    return createElement('div', null,
        createElement('button', { 'data-testid': 'shell-tap', onClick: () => setTaps((n) => n + 1) }, `taps ${taps}`),
        children as any);
}
/** The app as app/_layout.tsx builds it: the provider, what sits above the navigator, and the navigator inside the redraw. */
const app = () => createElement(Shell, null,
    createElement(DrawnInLanguage, null,
        createElement(LanguageRow as any, { styles: MENU }),
        createElement(BareScreen)));

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    mem.store.clear(); mem.holds.clear(); community.language = null; vi.clearAllMocks(); setLanguage('en');
    count.screenMounts = 0; count.shellMounts = 0;
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); vi.useRealTimers(); });

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
async function mount(deviceTags: string[]): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags }, app()) as any); });
    await flush();
}
const byTestId = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(id: string) {
    const target = byTestId(id);
    expect(target, `${id} is on screen`).toBeTruthy();
    await act(async () => { target!.click(); });
    await flush();
}

describe('a language picked in Settings redraws every screen, including those that write with core\'s bare t()', () => {
    it('the screen reads the new language with no remount by hand, once per pick, and what is above it is kept', async () => {
        await mount(['en-US']);
        expect(byTestId('bare')!.textContent).toBe('Welcome to BeanPool');
        expect(count.screenMounts).toBe(1);
        await click('shell-tap');
        expect(byTestId('shell-tap')!.textContent).toBe('taps 1');

        await click('settings-language');
        await click('language-fr');
        expect(byTestId('bare')!.textContent).toBe(nativeWord('fr', 'Welcome to BeanPool'));
        expect(byTestId('bare')!.textContent).not.toBe('Welcome to BeanPool');
        expect(count.screenMounts, 'drawn again once, in French').toBe(2);
        // The Settings row, inside the redraw too, says the new language.
        expect(byTestId('settings-language')!.textContent).toContain('Français');
        // Above the redraw: never mounted again, its state as it was.
        expect(count.shellMounts).toBe(1);
        expect(byTestId('shell-tap')!.textContent).toBe('taps 1');
        expect(mem.store.get(LANGUAGE_PREFERENCE_KEY)).toBe('fr');

        await click('settings-language');
        await click('language-ru');
        expect(byTestId('bare')!.textContent).toBe(nativeWord('ru', 'Welcome to BeanPool'));
        expect(count.screenMounts).toBe(3);
        expect(count.shellMounts).toBe(1);
    });

    it('a pick of the language already shown draws nothing again', async () => {
        await mount(['en-US']);
        await click('settings-language');
        await click('language-en');
        expect(byTestId('bare')!.textContent).toBe('Welcome to BeanPool');
        expect(count.screenMounts).toBe(1);
    });

    it('the pseudo-locale reaches a bare-t() screen too', async () => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'xx' }, app()) as any); });
        await flush();
        expect(byTestId('bare')!.textContent).toBe(pseudoLocalise('Welcome to BeanPool'));
    });
});

describe('a launch is drawn once, in the language it settles on (never in the phone\'s and then again)', () => {
    it('a stored choice: nothing is drawn until it is read, then the screen is drawn once, in it', async () => {
        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'de');
        let release!: () => void;
        mem.holds.set(LANGUAGE_PREFERENCE_KEY, new Promise<void>((r) => { release = r; }));
        await mount(['en-US']);
        expect(byTestId('bare'), 'not drawn in English first').toBeNull();
        expect(count.shellMounts, 'what is above the navigator is drawn at once').toBe(1);
        await act(async () => { release(); });
        await flush();
        expect(byTestId('bare')!.textContent).toBe(nativeWord('de', 'Welcome to BeanPool'));
        expect(count.screenMounts).toBe(1);
    });

    it("the community's default, on a phone whose own language BeanPool has no version in: drawn once, in it", async () => {
        mem.store.set('beanpool_anchor_url', 'https://lyon.example');
        community.language = 'fr';
        await mount(['he-IL']);
        expect(byTestId('bare')!.textContent).toBe(nativeWord('fr', 'Welcome to BeanPool'));
        expect(count.screenMounts).toBe(1);
    });

    it('a store that never answers holds nothing past SETTLE_MS: the phone\'s language, drawn once', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'de');
        mem.holds.set(LANGUAGE_PREFERENCE_KEY, new Promise<void>(() => {}));
        await mount(['pt-BR']);
        expect(byTestId('bare')).toBeNull();
        await act(async () => { vi.advanceTimersByTime(SETTLE_MS - 1); });
        await flush();
        expect(byTestId('bare'), 'still waiting just before SETTLE_MS').toBeNull();
        await act(async () => { vi.advanceTimersByTime(1); });
        await flush();
        expect(byTestId('bare')!.textContent).toBe(nativeWord('pt', 'Welcome to BeanPool'));
        expect(count.screenMounts).toBe(1);
    });

    it('outside a provider, a lone component is settled English', () => {
        let seen: { lang: string; settled: boolean } | null = null;
        function Probe() { const w = useWords(); seen = { lang: w.lang, settled: w.settled }; return null; }
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => { root!.render(createElement(Probe) as any); });
        expect(seen).toEqual({ lang: 'en', settled: true });
    });
});

describe('app/_layout.tsx draws the navigator inside the redraw, below the account and above nothing it must keep', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
    const nav = layout.slice(layout.indexOf('function RootLayoutNav('), layout.indexOf('export default function RootLayout('));

    it("RootLayoutNav's tree (the Stack and everything drawn with it) is DrawnInLanguage's child", () => {
        const tree = nav.slice(nav.lastIndexOf('    return (\n'));
        expect(tree).toMatch(/^ {4}return \(\n(?:\s*\/\/.*\n)*\s*<DrawnInLanguage>\n\s*<View style=\{\{ flex: 1 \}\}>/);
        expect(tree).toMatch(/<\/View>\n\s*<\/DrawnInLanguage>\n\s*\);\n\}/);
        expect(tree.indexOf('<Stack')).toBeGreaterThan(tree.indexOf('<DrawnInLanguage>'));
        expect(tree.indexOf('</Stack>')).toBeLessThan(tree.indexOf('</DrawnInLanguage>'));
        expect(layout.match(/<DrawnInLanguage>/g)).toHaveLength(1);
    });

    it('nothing in RootLayoutNav routes or opens a link before the language has settled (the navigator is not there yet)', () => {
        expect(nav).toMatch(/const \{ identity, isLoading: identityLoading \} = useIdentity\(\);/);
        expect(nav).toMatch(/const \{ settled: languageSettled \} = useWords\(\);\n\s*const isLoading = identityLoading \|\| !languageSettled;/);
        expect(nav).toContain('if (isLoading || !deepLinkUrl) return;');
        expect(nav).toContain('if (isLoading || !appLockChecked) return null;');
    });

    it('the provider is above the account, so the account and the community are never drawn again by a change', () => {
        const rootLayout = layout.slice(layout.indexOf('export default function RootLayout('));
        expect(rootLayout).toMatch(/<LanguageProvider>\s*<IdentityProvider>\s*<NodeStatusProvider>\s*<RootLayoutNav \/>/);
    });
});
