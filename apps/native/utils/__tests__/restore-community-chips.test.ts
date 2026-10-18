// @vitest-environment jsdom
/**
 * The 12-words restore's community chips (components/RestoreCommunityChips.tsx, utils/restore-community-choices.ts, drawn
 * by app/welcome.tsx's `recover` above the address field; DESIGN-global-entry-fable.md §A row 8, decision 5), rendered for
 * real: **Which community?**, then **Global community**, each community saved on this phone, and **another address**. Each
 * chip puts its community's address in the field, the address the restore then goes to (the restore reads the field
 * through normalizeNodeUrl, as before); the field's address shows which chip is chosen; **another address** empties a
 * chip's address out and hands the field the keyboard. A web joiner installing the app taps Global community and types
 * their words: nobody types global.beanpool.org. A tap sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The component doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (disabled) attrs['data-disabled'] = 'true';
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        const flat = Object.assign({}, ...[props.style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.minHeight === 'number') attrs['data-min-height'] = String(flat.minHeight);
        if (flat.flexWrap) attrs['data-wrap'] = flat.flexWrap;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
const theme = vi.hoisted(() => ({ dark: false }));
vi.mock('../../app/ThemeContext', async () => {
    const { onboardingColors } = await import('../onboarding-colors');
    return { useOnboardingColors: () => onboardingColors(theme.dark ? 'dark' : 'light') };
});

import { RestoreCommunityChips } from '../../components/RestoreCommunityChips';
import { LanguageProvider } from '../../components/LanguageProvider';
import { setLanguage, type UiLang } from '@beanpool/core';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { normalizeNodeUrl } from '../node-url';
import { chosenRestoreChoice, fieldTextFor, restoreCommunityChoices } from '../restore-community-choices';
import type { SavedNode } from '../nodes';

const SAVED: SavedNode[] = [
    { url: 'https://mullum.beanpool.org', alias: 'Mullumbimby' },
    { url: 'https://castlemaine.beanpool.org' },
    // A community on the member's own network, over plain http: its address goes in whole.
    { url: 'http://192.168.1.20:8080', alias: 'Home server' },
    // The global community saved on this phone too: it is the Global community chip, not a second one.
    { url: GLOBAL_NODE_URL, alias: 'Global' },
];

let host: HTMLDivElement;
let root: Root;
const calls = { chose: [] as string[], another: [] as string[] };
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    calls.chose = [];
    calls.another = [];
    theme.dark = false;
    setLanguage('en');
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

async function draw(value: string, saved: SavedNode[] = SAVED, lang?: UiLang, disabled = false): Promise<void> {
    const chips = createElement(RestoreCommunityChips, {
        saved, value, disabled,
        onChoose: (text: string) => { calls.chose.push(text); },
        onAnother: (text: string) => { calls.another.push(text); },
    });
    await act(async () => {
        root.render((lang ? createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, chips) : chips) as any);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const chips = () => Array.from(host.querySelectorAll('[role="button"]')) as HTMLElement[];
const names = () => chips().map((c) => c.getAttribute('aria-label'));
const chosen = () => chips().filter((c) => c.getAttribute('aria-selected') === 'true').map((c) => c.getAttribute('aria-label'));

describe('the chips, in order, above the address field', () => {
    it('Which community?, then Global community first, each saved community once, then another address', async () => {
        await draw('');
        expect(host.querySelector('[role="heading"]')!.textContent).toBe('Which community?');
        expect(names()).toEqual(['Global community', 'Mullumbimby', 'castlemaine.beanpool.org', 'Home server', 'another address']);
        // Each chip shows what TalkBack reads.
        for (const c of chips()) expect(c.textContent).toBe(c.getAttribute('aria-label'));
        // An empty field: nothing chosen yet.
        expect(chosen()).toEqual([]);
    });

    it('a phone with no saved community (a fresh install): Global community and another address', async () => {
        await draw('', []);
        expect(names()).toEqual(['Global community', 'another address']);
    });

    it('each chip fills the field with its community\'s address, which the restore reads as exactly that community', async () => {
        await draw('');
        for (const c of chips().slice(0, -1)) await act(async () => { c.click(); });
        expect(calls.chose).toEqual(['global.beanpool.org', 'mullum.beanpool.org', 'castlemaine.beanpool.org', 'http://192.168.1.20:8080']);
        // What the restore does with the field (app/welcome.tsx handleRecover → normalizeNodeUrl): the chip's community.
        expect(calls.chose.map(normalizeNodeUrl)).toEqual([GLOBAL_NODE_URL, 'https://mullum.beanpool.org', 'https://castlemaine.beanpool.org', 'http://192.168.1.20:8080']);
    });

    it('the field shows which chip is chosen: a chip\'s address, its bare name, or any other address (another address)', async () => {
        const cases: Array<[string, string[]]> = [
            ['global.beanpool.org', ['Global community']],
            [GLOBAL_NODE_URL, ['Global community']],
            ['mullum', ['Mullumbimby']],
            ['https://mullum.beanpool.org', ['Mullumbimby']],
            ['http://192.168.1.20:8080', ['Home server']],
            ['bris.example.org', ['another address']],
            ['   ', []],
        ];
        for (const [value, expected] of cases) {
            await draw(value);
            expect(chosen(), value).toEqual(expected);
        }
    });

    it('another address: a chip\'s address is emptied out for typing; an address already typed is kept', async () => {
        await draw('global.beanpool.org');
        await act(async () => { chips().at(-1)!.click(); });
        await draw('bris.example.org');
        await act(async () => { chips().at(-1)!.click(); });
        await draw('');
        await act(async () => { chips().at(-1)!.click(); });
        expect(calls.another).toEqual(['', 'bris.example.org', '']);
        expect(calls.chose).toEqual([]);
    });

    it('while the restore runs, no chip changes the field', async () => {
        await draw('global.beanpool.org', SAVED, undefined, true);
        for (const c of chips()) {
            expect(c.getAttribute('data-disabled')).toBe('true');
            await act(async () => { c.click(); });
        }
        expect(calls).toEqual({ chose: [], another: [] });
    });

    it('in dark too (the same chips, the same order)', async () => {
        theme.dark = true;
        await draw('mullum');
        expect(names()).toEqual(['Global community', 'Mullumbimby', 'castlemaine.beanpool.org', 'Home server', 'another address']);
        expect(chosen()).toEqual(['Mullumbimby']);
    });

    it('every word is through t(): in the pseudo-locale the label and both fixed chips are translations; names are names', async () => {
        await draw('', SAVED, 'xx');
        expect(host.querySelector('[role="heading"]')!.textContent).toMatch(/^\[.*\]$/s);
        const [global, ...rest] = names();
        expect(global).toMatch(/^\[.*\]$/s);
        expect(rest.at(-1)).toMatch(/^\[.*\]$/s);
        expect(rest.slice(0, -1)).toEqual(['Mullumbimby', 'castlemaine.beanpool.org', 'Home server']);
    });

    it('at 320 dp with text at 1.3×: chips wrap onto more lines rather than running off, each a full touch target, never cut', async () => {
        await draw('');
        expect(host.querySelector('[data-wrap]')!.getAttribute('data-wrap')).toBe('wrap');
        for (const c of chips()) {
            expect(Number(c.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(48);
            expect(c.querySelector('span')!.getAttribute('data-lines')).toBeNull();
        }
    });
});

describe('the choices themselves (utils/restore-community-choices.ts)', () => {
    it('a chip\'s field text is read back as its address exactly, for every kind of address a phone saves', () => {
        for (const url of [GLOBAL_NODE_URL, 'https://mullum.beanpool.org', 'https://my.coop.example', 'http://192.168.1.20:8080',
            'https://192.168.1.20', 'http://localhost:8080', 'https://8.8.8.8', 'https://[2001:db8::7]']) {
            expect(normalizeNodeUrl(fieldTextFor(url)), url).toBe(url);
        }
        // Shown bare where that reads back the same: at 320 dp the scheme hid the host.
        expect(fieldTextFor(GLOBAL_NODE_URL)).toBe('global.beanpool.org');
        // A private address over https would read back as http without its scheme: kept whole.
        expect(fieldTextFor('https://192.168.1.20')).toBe('https://192.168.1.20');
    });

    it('a saved list with junk in it gives only real chips', () => {
        const junk = [{ url: '' }, { url: '  ' }, null, { url: 'https://mullum.beanpool.org/' }, { url: 'https://MULLUM.beanpool.org' }] as unknown as SavedNode[];
        expect(restoreCommunityChoices(junk).map((c) => c.url)).toEqual([GLOBAL_NODE_URL, 'https://mullum.beanpool.org/']);
    });

    it('chosenRestoreChoice: the chip, another, or nothing', () => {
        const choices = restoreCommunityChoices(SAVED);
        expect(chosenRestoreChoice('', choices)).toBeNull();
        // A bare name is read as the field reads it (`<name>.beanpool.org`): "global" is the global community.
        expect(chosenRestoreChoice('global', choices)).toMatchObject({ kind: 'global' });
        expect(chosenRestoreChoice('global.beanpool.org', choices)).toMatchObject({ kind: 'global' });
        expect(chosenRestoreChoice('bris', choices)).toBe('another');
    });
});

describe('the 12-words restore screen draws the chips above its address field (app/welcome.tsx)', () => {
    it('in `recover`, between the words and the field, which they hand the keyboard', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        const recover = src.slice(src.indexOf("if (mode === 'recover') {"), src.indexOf("if (mode === 'ssoRecover' && (!hasVault() || ssoAtCommunity))"));
        const words = recover.indexOf('<RecoveryWordsEntry');
        const chipsAt = recover.indexOf('<RestoreCommunityChips');
        const field = recover.indexOf('ref={recoveryAddressRef}');
        expect(words).toBeGreaterThan(0);
        expect(chipsAt).toBeGreaterThan(words);
        expect(field).toBeGreaterThan(chipsAt);
        expect(recover).toContain('value={recoveryAnchorUrl}');
        expect(recover).toContain('recoveryAddressRef.current?.focus()');
        // The phone's saved communities are read for this screen too.
        expect(src).toMatch(/if \(mode !== 'ssoRecover' && mode !== 'recover'\) return;\s*getSavedNodes\(\)/);
    });
});
