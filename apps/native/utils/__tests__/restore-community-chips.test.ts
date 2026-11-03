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
import { addressFieldShown, chosenRestoreChoice, fieldTextFor, restoreCommunityChoices, withCopyCommunities } from '../restore-community-choices';
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

describe('the address field follows what the member did, not what the text spells (Recover with Social; Opus review of #2807)', () => {
    const choices = restoreCommunityChoices(SAVED);

    it('addressFieldShown: typing or "another address" keeps it, a chip hides it, and before either the text decides', () => {
        // Nothing done yet: an empty field is drawn; a field filled in for the member (the copy's first community) is not.
        expect(addressFieldShown(null, '', choices)).toBe(true);
        expect(addressFieldShown(null, 'global.beanpool.org', choices)).toBe(false);
        expect(addressFieldShown(null, 'bris.example.org', choices)).toBe(true);
        // A chip was tapped: it is an address, so no field.
        expect(addressFieldShown('chip', 'global.beanpool.org', choices)).toBe(false);
        // The member is typing: whatever the text spells, even a chip's address, the field stays.
        for (const typed of ['g', 'global', 'global.beanpool.org', 'mullum', 'globalvillage.net', '']) {
            expect(addressFieldShown('another', typed, choices), typed).toBe(true);
        }
    });

    /** The screen's own wiring in miniature: the real chips, the real rule, and a field that must stay mounted and focused. */
    function Harness({ start = '', startPick = null as 'chip' | 'another' | null }) {
        const [url, setUrl] = ReactAll.useState(start);
        const [pick, setPick] = ReactAll.useState<'chip' | 'another' | null>(startPick);
        const ref = ReactAll.useRef<HTMLInputElement>(null);
        return createElement('div', null,
            createElement(RestoreCommunityChips, {
                saved: SAVED, value: url, pick,
                onChoose: (text: string) => { setPick('chip'); setUrl(text); },
                onAnother: (text: string) => { setPick('another'); setUrl(text); setTimeout(() => ref.current?.focus(), 0); },
            }),
            addressFieldShown(pick, url, choices) && createElement('input', {
                'data-field': 'address', ref, value: url,
                onChange: (e: any) => { setPick('another'); setUrl(e.target.value); },
            }));
    }
    const field = () => host.querySelector('[data-field="address"]') as HTMLInputElement | null;
    async function type(el: HTMLInputElement, text: string) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(el, text);
        await act(async () => { el.dispatchEvent(new Event('input', { bubbles: true })); });
    }

    it('typing the bare name "global" letter by letter keeps the same field mounted and focused, and so does "mullum"', async () => {
        for (const name of ['global', 'mullum']) {
            await act(async () => { root.render(createElement(Harness) as any); });
            const input = field()!;
            expect(input, 'drawn before anything is chosen').not.toBeNull();
            input.focus();
            for (let i = 1; i <= name.length; i++) {
                await type(field()!, name.slice(0, i));
                expect(field(), `${name.slice(0, i)}`).toBe(input);
                expect(document.activeElement, `${name.slice(0, i)}`).toBe(input);
            }
            // The text now reads back as a chip's address, yet the member chose "another address" by typing.
            expect(chosen()).toEqual(['another address']);
            // ...and they can go on: "globalvillage.net" is typed to the end without the field ever leaving.
            const more = name === 'global' ? 'globalvillage.net' : 'mullumbimby.example.org';
            for (let i = name.length + 1; i <= more.length; i++) await type(field()!, more.slice(0, i));
            expect(field()).toBe(input);
            expect(field()!.value).toBe(more);
            expect(document.activeElement).toBe(input);
        }
    });

    it('tapping "another address" while "global" is typed keeps what was typed (it is not emptied)', async () => {
        await act(async () => { root.render(createElement(Harness) as any); });
        await type(field()!, 'global');
        await act(async () => { chips().at(-1)!.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
        expect(field()!.value).toBe('global');
        expect(chosen()).toEqual(['another address']);
    });

    it('a chip hides the field; "another address" after a chip draws it empty, with the keyboard', async () => {
        await act(async () => { root.render(createElement(Harness) as any); });
        await act(async () => { chips()[0]!.click(); });
        expect(field()).toBeNull();
        expect(chosen()).toEqual(['Global community']);
        await act(async () => { chips().at(-1)!.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
        expect(field()).not.toBeNull();
        expect(field()!.value).toBe('');
        expect(document.activeElement).toBe(field());
    });

    it('a field filled in for the member (the copy\'s first community) starts hidden, with its chip chosen', async () => {
        await act(async () => { root.render(createElement(Harness, { start: 'global.beanpool.org' }) as any); });
        expect(field()).toBeNull();
        expect(chosen()).toEqual(['Global community']);
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

describe("a restored copy's list of communities (vault rethink VR5)", () => {
    const FROM_COPY = [
        { name: 'Mullumbimby (copy)', url: 'https://mullum.beanpool.org' },
        { name: 'Lismore Commons', url: 'https://lismore.example.org' },
        { name: 'Kitchen garden', url: 'http://192.168.1.30:8080' },
        // Not a community address: never offered.
        { name: 'path', url: 'https://bad.example.org/app' },
        { name: '', url: 'https://bare.example.org' },
    ];

    it("the chips offer the copy's communities after the phone's own, each once, by the copy's name", async () => {
        await draw('', withCopyCommunities(SAVED, FROM_COPY));
        expect(names()).toEqual([
            'Global community', 'Mullumbimby', 'castlemaine.beanpool.org', 'Home server',
            'Lismore Commons', 'Kitchen garden', 'bare.example.org', 'another address',
        ]);
    });

    it("on a new phone (nothing saved) the copy's communities are the chips; each fills the field with its address", async () => {
        await draw('', withCopyCommunities([], FROM_COPY));
        expect(names()).toEqual(['Global community', 'Mullumbimby (copy)', 'Lismore Commons', 'Kitchen garden', 'bare.example.org', 'another address']);
        for (const c of chips().slice(1, -1)) await act(async () => { c.click(); });
        expect(calls.chose.map(normalizeNodeUrl)).toEqual([
            'https://mullum.beanpool.org', 'https://lismore.example.org', 'http://192.168.1.30:8080', 'https://bare.example.org',
        ]);
    });

    it('a copy without a list leaves the chips exactly as before', async () => {
        for (const none of [null, undefined, []]) {
            expect(withCopyCommunities(SAVED, none)).toEqual(SAVED);
            await draw('', withCopyCommunities(SAVED, none));
            expect(names()).toEqual(['Global community', 'Mullumbimby', 'castlemaine.beanpool.org', 'Home server', 'another address']);
        }
    });

    it("at 320 dp with text at 1.3×, a long name from the copy wraps on a full touch target, never cut", async () => {
        await draw('', withCopyCommunities([], [{ name: 'Gemeinschaftsgarten Nördliche Flussauen und Umgebung', url: 'https://garten.example.org' }]), 'de');
        expect(host.querySelector('[data-wrap]')!.getAttribute('data-wrap')).toBe('wrap');
        const chip = chips().find((c) => c.getAttribute('aria-label')?.startsWith('Gemeinschaftsgarten'))!;
        expect(Number(chip.getAttribute('data-min-height'))).toBeGreaterThanOrEqual(48);
        expect(chip.querySelector('span')!.getAttribute('data-lines')).toBeNull();
    });

    it("the sign-in restore offers them, and starts Which community? at the copy's first (app/welcome.tsx)", () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        expect(src).toContain('nodes={withCopyCommunities(savedNodes, ssoReleased.communities)}');
        // Starts at the copy's first community, unless the member already tapped one before signing in (front doors S10:
        // Which community? is asked first, and a tap is the member's word over the copy's list).
        expect(src).toMatch(/const first = result\.restored\.communities\?\.\[0\];\s*if \(first && !ssoCommunityPicked\.current\) setSsoCommunity\(fieldTextFor\(first\.url\)\);/);
    });
});
