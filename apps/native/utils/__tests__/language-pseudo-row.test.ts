// @vitest-environment jsdom
/**
 * The pseudo-locale on the phone (translation tooling design §2.5, slice T4): a "Pseudo (test)" row under Settings →
 * Language in a DEVELOPMENT build only, never in a release build.
 *
 * "A release build" here is the bundle's own `__DEV__`: vitest.config.ts defines it as the constant false, as Metro does for
 * a release bundle, and the first describe reads it without any override. A development build is the same code with
 * `setDevBuildForTests(true)`. The real LanguageProvider, Settings row and picker are rendered with react-dom in jsdom and
 * React Native's host components as plain tags (as language-switch-render.test.ts does); what is checked is the rows
 * listed, what a pick does to the words on screen, what is stored and what a node is told.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LANGS, currentLanguage, pseudoLocalise, setLanguage } from '@beanpool/core';
import { LanguageProvider, useWords } from '../../components/LanguageProvider';
import { LanguageRow, LanguageSwitch } from '../../components/LanguagePicker';
import {
    LANGUAGE_NAMES, LANGUAGE_PREFERENCE_KEY, PSEUDO_ROW_NAME, chooseLanguage, isDevBuild, languageHeader, languagePickerRows, setDevBuildForTests, storedChoice,
} from '../language-choice';

const MENU = { menuBtn: {}, menuIconWrap: {}, menuIcon: {}, menuText: {}, menuSub: {}, menuChevron: {} };
/** A sentence on a screen: what a member reads, through the screen's own `useWords()`. */
function Probe() {
    const { t } = useWords();
    return createElement('span', { 'data-testid': 'probe' }, t('Welcome to BeanPool'));
}

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => { mem.store.clear(); vi.clearAllMocks(); setLanguage('en'); });
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); setDevBuildForTests(null); });

async function mount(children: unknown[], deviceTags = ['en-US']): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags }, ...(children as any[])) as any); });
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
const radios = () => Array.from(host!.querySelectorAll('[data-modal] [role="radio"]')) as HTMLElement[];

describe('a release build: no Pseudo (test) row', () => {
    it("this suite's own bundle flag is the release one (vitest.config.ts defines __DEV__ as false, as Metro does for a release bundle)", () => {
        // If the flag were changed here, the absence checks below would stop standing on a release build; fail loudly.
        const config = fs.readFileSync(path.resolve(__dirname, '../../vitest.config.ts'), 'utf8');
        expect(config).toMatch(/__DEV__:\s*'false'/);
        expect(isDevBuild()).toBe(false);
    });

    it('the rows are the 25 languages and nothing else; a stored xx is no choice', () => {
        expect(languagePickerRows().map((r) => r.value)).toEqual([...LANGS]);
        expect(languagePickerRows().map((r) => r.name)).not.toContain(PSEUDO_ROW_NAME);
        expect(storedChoice('xx')).toBeNull();
        expect(chooseLanguage({ stored: 'xx', deviceTags: ['ru-RU'] })).toBe('ru');
        expect(chooseLanguage({ stored: 'xx' })).toBe('en');
    });

    it('Settings → Language draws the 25 rows and no language-xx row, in text or in the tree', async () => {
        await mount([createElement(LanguageRow, { key: 'row', styles: MENU })]);
        await click('settings-language');
        expect(byTestId('language-xx')).toBeNull();
        expect(host!.querySelector('[data-modal]')!.textContent).not.toContain('Pseudo');
        for (const name of Object.values(LANGUAGE_NAMES)) expect(host!.querySelector('[data-modal]')!.textContent).toContain(name);
        // "Same as phone" and the 25.
        expect(radios()).toHaveLength(1 + LANGS.length);
    });

    it('a development build left xx in storage: this release build starts in the phone\'s language, never in the pseudo-locale', async () => {
        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'xx');
        await mount([createElement(Probe, { key: 'p' })], ['ru-RU']);
        expect(byTestId('probe')!.textContent).not.toMatch(/^\[/);
        expect(currentLanguage()).toBe('ru');
    });
});

describe('a development build: Pseudo (test), last in the list', () => {
    beforeEach(() => setDevBuildForTests(true));

    it('lists the 25 and then Pseudo (test); a stored xx is a choice', () => {
        expect(isDevBuild()).toBe(true);
        const rows = languagePickerRows();
        expect(rows.map((r) => r.value)).toEqual([...LANGS, 'xx']);
        expect(rows[rows.length - 1]).toEqual({ value: 'xx', name: 'Pseudo (test)' });
        expect(storedChoice('xx')).toBe('xx');
        expect(chooseLanguage({ stored: 'xx', deviceTags: ['ru-RU'] })).toBe('xx');
        // A tag that is no language still counts as no choice.
        expect(storedChoice('xy')).toBeNull();
    });

    it('picking it pads every sentence on screen at once, is kept on this phone, and a node is still told English', async () => {
        await mount([createElement(LanguageRow, { key: 'row', styles: MENU }), createElement(Probe, { key: 'p' })]);
        expect(byTestId('probe')!.textContent).toBe('Welcome to BeanPool');
        await click('settings-language');
        const list = radios();
        expect(list).toHaveLength(1 + LANGS.length + 1);
        expect(list[list.length - 1].getAttribute('data-testid')).toBe('language-xx');
        expect(list[list.length - 1].textContent).toBe('Pseudo (test)');

        await click('language-xx');
        const text = byTestId('probe')!.textContent!;
        expect(text).toBe(pseudoLocalise('Welcome to BeanPool'));
        expect(text.startsWith('[') && text.endsWith(']')).toBe(true);
        expect(currentLanguage()).toBe('xx');
        expect(AsyncStorage.setItem).toHaveBeenCalledWith(LANGUAGE_PREFERENCE_KEY, 'xx');
        // The node stores nothing that is not one of the 25 (language-choice.ts languageForNode).
        expect(languageHeader()).toEqual({ 'X-Language': 'en' });
        // Settings names it, with no "machine draft" line (nobody reads the pseudo-locale as a language).
        const row = byTestId('settings-language')!;
        expect(row.textContent).toContain('Pseudo (test)');
        expect(row.textContent).not.toContain('Translated by machine');

        // The row is still listed, by name, when the list opens again (the tick itself is not checked: the React Native mock drops
        // accessibilityState), and "Same as phone" leaves it.
        await click('settings-language');
        expect(byTestId('language-xx')!.getAttribute('aria-label')).toBe('Pseudo (test)');
        await act(async () => { radios()[0].click(); });
        expect(byTestId('probe')!.textContent).toBe('Welcome to BeanPool');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LANGUAGE_PREFERENCE_KEY);
    });

    it('a launch with xx stored starts in the pseudo-locale; the first screen\'s switch names it', async () => {
        mem.store.set(LANGUAGE_PREFERENCE_KEY, 'xx');
        await mount([createElement(LanguageSwitch, { key: 's' }), createElement(Probe, { key: 'p' })]);
        expect(byTestId('probe')!.textContent).toBe(pseudoLocalise('Welcome to BeanPool'));
        expect(byTestId('language-switch')!.textContent).toBe('🌐 Pseudo (test) ▾');
    });
});
