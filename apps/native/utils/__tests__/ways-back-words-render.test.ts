// @vitest-environment jsdom
/**
 * "Where your account can be brought back from" (vault rethink VR1; app/ways-back.tsx drawing
 * components/WaysBackList.tsx), rendered for real inside the real LanguageProvider: every state of the list (the vault's
 * copies with since and a last restore, a vault that couldn't say, communities that keep a copy, keep none, didn't
 * answer, a delete still waiting, the words-only line, the copy a community keeps for its admins, VR3), every confirm
 * (one copy, the last one with the 12 words first, the last one on a phone with no words, Remove everything, the admins'
 * copy) and every result line.
 *
 * In the pseudo-locale (`xx`: every sentence accented, padded and bracketed) any text, label or alert with letters
 * outside a bracket bypassed t(). In English, what each confirm offers and that a result says only what each keeper
 * answered. Then 320 dp at 1.3×: no word of a button is wider than the line it has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ shown: [] as { title: string; body?: string; buttons: { text?: string; onPress?: () => void }[] }[] }));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (disabled) attrs['data-disabled'] = 'true';
        const s = flat(typeof props.style === 'function' ? props.style({ pressed: false }) : props.style);
        if (typeof s.fontSize === 'number') attrs['data-font'] = String(s.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => flat(s) },
        Alert: { alert: (title: string, body?: string, buttons?: { text?: string; onPress?: () => void }[]) => { alerts.shown.push({ title, body, buttons: buttons ?? [] }); } },
        AppState: { currentState: 'active', addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const React = await import('react');
    return {
        router: { push: (to: unknown) => { nav.pushed.push(to); }, back() {} },
        useFocusEffect: (cb: () => void | (() => void)) => { React.useEffect(cb, [cb]); },
        ErrorBoundary: () => null,
    };
});
vi.mock('react-native-safe-area-context', async () => {
    const React = await import('react');
    return { SafeAreaView: ({ children }: { children?: unknown }) => React.createElement('div', null, children as any), useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) };
});
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), digest: async () => new ArrayBuffer(32) };
});
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [], multiRemove: async () => {} },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Sally', mnemonic: [] as string[] } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity, setIdentity() {} }) }));
vi.mock('../../components/RecoveryAlertBanner', () => ({ RecoveryAlertBanner: () => null }));

const MULLUM = 'https://mullum.beanpool.org';
const GLOBAL = 'https://global.beanpool.org';
const BELL = 'https://bellingen.beanpool.org';
const fx = vi.hoisted(() => ({
    ways: null as any,
    writtenDown: false,
    everything: null as any,
    removed: [] as unknown[],
    adminsRemoval: { removed: true } as any,
}));
vi.mock('../ways-back', async (importOriginal) => {
    const real = await importOriginal<typeof import('../ways-back')>();
    return {
        ...real,
        listWaysBack: async () => fx.ways,
        wordsWrittenDown: async () => fx.writtenDown,
        noteWordsWrittenDown: async () => {},
        removeVaultCopy: async (_i: unknown, provider: string) => { fx.removed.push(['vault', provider]); return { removed: true }; },
        removeCommunityCopyFrom: async (_i: unknown, c: { url: string }, provider: string) => { fx.removed.push([c.url, provider]); return { removed: false, why: 'remembered' }; },
        removeEverything: async () => { fx.removed.push('everything'); return fx.everything; },
        removeAdminsCopyFrom: async (_i: unknown, c: { url: string }) => { fx.removed.push([c.url, 'admins']); return fx.adminsRemoval; },
    };
});

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { LanguageProvider } from '../../components/LanguageProvider';
import WaysBackScreen from '../../app/ways-back';
import type { WaysBack } from '../ways-back';

const WORDS = 'apple banana cherry delta eagle fabric garden hollow island jungle kettle lemon'.split(' ');
/** Shown as they are in every language: the sign-ins' names, the communities' own names, the dates' digits. */
const AS_WRITTEN = ['Google', 'Apple', 'Facebook', 'Mullumbimby', 'Global community', 'Bellingen'];

/** Every state at once: the vault's two copies (one brought the account back), and three communities, one keeping a copy for its admins. */
const FULL: WaysBack = {
    vault: { kind: 'listed', copies: [
        { provider: 'google', since: '2026-10-03', lastReleasedAt: Date.UTC(2026, 9, 12, 9) },
        { provider: 'facebook', since: '2026-10-20', lastReleasedAt: null },
    ] },
    communities: [
        { url: MULLUM, name: 'Mullumbimby', status: { providers: ['google', 'apple'], generation: 3, adminsCopy: { since: '2026-10-29T04:05:06.000Z' } } },
        { url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } },
        { url: BELL, name: 'Bellingen', status: null },
    ],
    pending: [{ url: MULLUM, provider: 'apple' }],
};
/** The last copy the phone knows of: one at the vault, nothing elsewhere. */
const LAST: WaysBack = {
    vault: { kind: 'listed', copies: [{ provider: 'google', since: '2026-10-03', lastReleasedAt: null }] },
    communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }],
    pending: [],
};
const NOTHING: WaysBack = { vault: { kind: 'listed', copies: [] }, communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }], pending: [] };
/** Two Google accounts linked: the vault keeps a copy for each (one brought the account back), and removes them together. */
const TWO_GOOGLE: WaysBack = {
    vault: { kind: 'listed', copies: [
        { provider: 'google', since: '2026-10-04', lastReleasedAt: Date.UTC(2026, 9, 12, 9) },
        { provider: 'google', since: '2026-10-01', lastReleasedAt: null },
        { provider: 'facebook', since: '2026-10-20', lastReleasedAt: null },
    ] },
    communities: [{ url: GLOBAL, name: 'Global community', status: { providers: [], generation: 0 } }],
    pending: [],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    alerts.shown.length = 0; nav.pushed.length = 0; fx.removed.length = 0;
    fx.ways = FULL; fx.writtenDown = false; fx.everything = null; fx.adminsRemoval = { removed: true };
    me.identity.mnemonic = WORDS;
    setLanguage('en');
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(lang: 'xx' | 'en'): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: lang }, createElement(WaysBackScreen)) as any); });
    await settle();
    return host;
}
const all = (sel: string) => Array.from(host!.querySelectorAll(sel)) as HTMLElement[];
const buttonNamed = (name: string | RegExp) => all('button').find(b => (typeof name === 'string' ? (b.getAttribute('aria-label') ?? b.textContent) === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? '')));
async function click(el: HTMLElement | undefined, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { el!.click(); });
    await settle();
}
async function press(text: string) {
    const last = alerts.shown.at(-1)!;
    const b = last.buttons.find(x => x.text === text);
    expect(b, `the alert offers "${text}": ${last.buttons.map(x => x.text).join(', ')}`).toBeTruthy();
    await act(async () => { b!.onPress?.(); });
    await settle();
}

function outsideBrackets(text: string): string {
    let rest = text;
    for (let was = ''; was !== rest;) { was = rest; rest = rest.replace(/\[[^[\]]*\]/g, ''); }
    for (const n of [...AS_WRITTEN].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
    return rest.replace(/[^\p{L}]+/gu, ' ').trim();
}
function wholly(step: string) {
    const seen: string[] = [];
    for (const n of all('*')) {
        const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
        if (own.trim()) seen.push(own);
        const label = n.getAttribute('aria-label');
        if (label) seen.push(label);
    }
    for (const a of alerts.shown) seen.push(a.title, a.body ?? '', ...a.buttons.map(b => b.text ?? ''));
    expect(seen.length, `${step}: something is on screen`).toBeGreaterThan(1);
    expect(seen.filter((s) => outsideBrackets(s) !== ''), `${step}: English outside t()`).toEqual([]);
}

// ── 320 dp at 1.3× ──
const FONT_SCALE = 1.3;
const glyphEm = (c: string) => (/\p{M}/u.test(c) ? 0 : '️‌‍​'.includes(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : 0.62);
const widthOf = (text: string, fontSize: number) => Array.from(text).reduce((w, c) => w + glyphEm(c) * fontSize * FONT_SCALE, 0);
const widestPiece = (text: string) => text.split(/[\s~[\]\u200B]+/).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
const fontOf = (el: Element | null): number => { for (let e = el; e; e = e.parentElement) { const f = e.getAttribute('data-font'); if (f) return Number(f); } return 16; };
/**
 * The narrowest line a button's words have: 320 less the scroll's 16 and the card's 16 on each side, the copy's box (12
 * and a 1 dp border each side) and the Remove button's own 16 each side: 198 dp.
 */
const LINE = 320 - 2 * 16 - 2 * 16 - 2 * 13 - 2 * 16;
function buttonsFit(step: string) {
    for (const b of all('button')) {
        for (const leaf of [b, ...Array.from(b.querySelectorAll('span'))]) {
            const own = Array.from(leaf.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join('');
            if (!own.trim()) continue;
            const piece = widestPiece(own);
            expect(widthOf(piece, fontOf(leaf)), `${step}: "${piece}" at ${fontOf(leaf)} on a ${LINE} dp line`).toBeLessThanOrEqual(LINE);
        }
    }
}

describe('every sentence through t(), in every state and every confirm (pseudo-locale)', () => {
    it('the list: vault copies with since and a last restore, three communities, a delete waiting', async () => {
        await mount('xx');
        wholly('the list');
        buttonsFit('the list');
        // The dates are drawn, in the language's own way (formatDate).
        expect(host!.textContent).toMatch(/2026/);
    });

    it('a vault that could not say, and the words-only line (with and without the 12 words on the phone)', async () => {
        fx.ways = { ...FULL, vault: { kind: 'unknown', why: 'paused' } };
        await mount('xx');
        wholly('a paused vault');
        act(() => root?.unmount());
        fx.ways = NOTHING;
        await mount('xx');
        wholly('words only');
        act(() => root?.unmount());
        me.identity.mnemonic = [];
        await mount('xx');
        wholly('words only, no words on the phone');
    });

    it('each confirm: one copy, the last with the 12 words first, the last with no words, Remove everything, and the results', async () => {
        fx.everything = {
            vault: { removed: false, why: 'unverified' },
            communities: [{ url: MULLUM, name: 'Mullumbimby', provider: 'google', removal: { removed: false, why: 'remembered' } }],
            admins: [{ url: MULLUM, name: 'Mullumbimby', removal: { removed: false, why: 'unreachable' } }],
            notAsked: [{ url: BELL, name: 'Bellingen' }],
        };
        await mount('xx');
        await click(all('button').find(b => (b.getAttribute('aria-label') ?? '').includes('Google') && (b.getAttribute('aria-label') ?? '').includes('Mullumbimby')), 'Remove at Mullumbimby');
        await press(pseudoLocalise('Remove'));
        await click(all('button').at(-2), 'Remove everything');
        wholly('the confirms and the results');
        expect(alerts.shown).toHaveLength(2);
    });

    it('two accounts of one sign-in at the vault: the list, and the confirm that says both go', async () => {
        fx.ways = TWO_GOOGLE;
        await mount('xx');
        await click(all('button').find(b => (b.getAttribute('aria-label') ?? '').includes('Google')), 'Remove the Google copies');
        wholly('two Google accounts');
        buttonsFit('two Google accounts');
        expect(alerts.shown).toHaveLength(1);
    });
});

describe('what each confirm offers, and what a result says (English)', () => {
    it('one copy of several: an ordinary confirm naming where it is deleted', async () => {
        await mount('en');
        await click(buttonNamed("Remove the Google copy at BeanPool's key vault"), 'Remove Google at the vault');
        const a = alerts.shown.at(-1)!;
        expect(a.title).toBe('Remove your Google copy?');
        expect(a.body).toBe("BeanPool's key vault deletes it at once, and from its backups within 30 days, or later if the vault is paused in that time.");
        expect(a.buttons.map(b => b.text)).toEqual(['Cancel', 'Remove']);
        await press('Remove');
        expect(fx.removed).toEqual([['vault', 'google']]);
        expect(host!.textContent).toContain("Removed from BeanPool's key vault.");
    });

    it('two Google accounts at the vault: each copy listed with its own dates, and one Remove whose confirm says it takes both', async () => {
        fx.ways = TWO_GOOGLE;
        await mount('en');
        const text = host!.textContent!;
        expect(text).toContain('A copy for each of 2 Google accounts.');
        expect(text).toContain('Kept since 4 Oct 2026');
        expect(text).toContain('Kept since 1 Oct 2026');
        expect(text).toContain('Last brought your account back on 12 Oct 2026');
        // One Remove for Google, not one per account: the vault removes a sign-in's copies together.
        expect(all('button').filter(b => (b.getAttribute('aria-label') ?? '').includes('Google'))).toHaveLength(1);
        await click(buttonNamed("Remove the 2 Google copies at BeanPool's key vault"), 'Remove the Google copies');
        const a = alerts.shown.at(-1)!;
        expect(a.title).toBe('Remove your 2 Google copies?');
        expect(a.body).toBe("BeanPool's key vault keeps one for each Google account you linked, and removes them together. It deletes them at once, and from its backups within 30 days, or later if the vault is paused in that time.");
        expect(a.buttons.map(b => b.text)).toEqual(['Cancel', 'Remove']);
        await press('Remove');
        expect(fx.removed).toEqual([['vault', 'google']]);
    });

    it('the last copy, words on the phone, not written down: "Show my 12 words first?"; Show opens them and removes nothing', async () => {
        fx.ways = LAST;
        await mount('en');
        await click(buttonNamed("Remove the Google copy at BeanPool's key vault"), 'Remove the last copy');
        const a = alerts.shown.at(-1)!;
        expect(a.title).toBe('Show my 12 words first?');
        expect(a.body).toMatch(/^After this, no copy this phone knows of can bring your account back\. Only your 12 words can, so write them down first\. BeanPool's key vault deletes it at once/);
        expect(a.buttons.map(b => b.text)).toEqual(['Cancel', 'Show my 12 words', 'Remove anyway']);
        await press('Show my 12 words');
        expect(nav.pushed).toEqual([{ pathname: '/(tabs)/settings', params: { section: 'protection' } }]);
        expect(fx.removed).toEqual([]);
    });

    it('the last copy once "I have them written down" is ticked: an ordinary confirm', async () => {
        fx.ways = LAST;
        await mount('en');
        const tick = all('button').find(b => b.getAttribute('role') === 'checkbox')!;
        expect(tick.getAttribute('aria-checked')).toBe('false');
        await click(tick, 'I have them written down');
        expect(tick.getAttribute('aria-checked')).toBe('true');
        await click(buttonNamed("Remove the Google copy at BeanPool's key vault"), 'Remove the last copy');
        expect(alerts.shown.at(-1)!.title).toBe('Remove your Google copy?');
    });

    it('the last copy on a phone with no 12 words: what is left, plainly; Keep it removes nothing', async () => {
        fx.ways = LAST;
        me.identity.mnemonic = [];
        await mount('en');
        expect(host!.textContent).toContain('No copy on this phone.');
        expect(buttonNamed('Show my 12 words')).toBeUndefined();
        await click(buttonNamed("Remove the Google copy at BeanPool's key vault"), 'Remove the last copy');
        const a = alerts.shown.at(-1)!;
        expect(a.title).toBe('This phone has no 12 words');
        expect(a.body).toMatch(/Unless you have your 12 words written down, losing this phone loses your account: an admin can only move your Beans and name to a new key\./);
        expect(a.buttons.map(b => b.text)).toEqual(['Keep it', 'Remove anyway']);
        expect(fx.removed).toEqual([]);
    });

    it('Remove everything: what each keeper does, the community that did not answer, then only what each one answered', async () => {
        fx.everything = {
            vault: { removed: false, why: 'paused' },
            communities: [{ url: MULLUM, name: 'Mullumbimby', provider: 'google', removal: { removed: false, why: 'remembered' } }],
            admins: [{ url: MULLUM, name: 'Mullumbimby', removal: { removed: false, why: 'unreachable' } }],
            notAsked: [{ url: BELL, name: 'Bellingen' }],
        };
        await mount('en');
        await click(buttonNamed('Remove everything'), 'Remove everything');
        const a = alerts.shown.at(-1)!;
        expect(a.title).toBe('Show my 12 words first?');
        expect(a.body).toContain("BeanPool's key vault deletes its copies at once, and from its backups within 30 days, or later if the vault is paused in that time.");
        expect(a.body).toContain("Each community's server deletes its copy. Copies already in a server's backups stay there.");
        expect(a.body).toContain("Bellingen didn't answer, so anything kept there stays.");
        await press('Remove anyway');
        expect(fx.removed).toEqual(['everything']);
        const text = host!.textContent!;
        expect(text).toContain("Not removed: BeanPool's key vault is paused for a little while. Try again later.");
        expect(text).toContain("Not removed yet: Mullumbimby didn't answer. The app tries again each time it opens.");
        expect(text).toContain("Bellingen didn't answer, so nothing kept there was removed. Open this screen again later.");
        expect(text).toContain("Not removed: Mullumbimby couldn't do it just now. Try again later.");
        expect(text).not.toMatch(/Removed from/);
    });

    it("the copy Mullumbimby keeps for its admins (VR3): its row with since when, its own confirm, and only what Mullumbimby answered", async () => {
        await mount('en');
        // Drawn under Mullumbimby, after its sign-in copies and before the next community (the host stubs carry no testID).
        const text = host!.textContent!;
        const row = text.slice(text.indexOf('Mullumbimby'), text.indexOf('Global community'));
        expect(row).toContain("Your community's admins");
        expect(row).toContain('A locked copy an admin can bring your account back from, when they see you in person.');
        expect(row).toMatch(/Kept since 29 Oct 2026/);
        await click(buttonNamed('Remove the copy at Mullumbimby that its admins can bring you back from'), 'Remove the admins copy');
        const a = alerts.shown.at(-1)!;
        // Other copies stay (the vault's, Mullumbimby's Google): an ordinary confirm, in the row's own words.
        expect(a.title).toBe('Remove this way back?');
        expect(a.body).toBe("Mullumbimby's server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work.");
        expect(a.buttons.map(b => b.text)).toEqual(['Cancel', 'Remove']);
        await press('Remove');
        expect(fx.removed).toEqual([[MULLUM, 'admins']]);
        expect(host!.textContent).toContain('Removed from Mullumbimby.');

        fx.adminsRemoval = { removed: false, why: 'unreachable' };
        await click(buttonNamed('Remove the copy at Mullumbimby that its admins can bring you back from'), 'Remove the admins copy again');
        await press('Remove');
        expect(host!.textContent).toContain("Not removed: Mullumbimby couldn't do it just now. Try again later.");
        expect(host!.textContent).not.toContain('Removed from Mullumbimby.');
    });

    it('the list in English: since, the last restore, a delete waiting, a community that did not answer', async () => {
        await mount('en');
        const text = host!.textContent!;
        expect(text).toContain('Where your account can be brought back from');
        expect(text).toContain('Kept since 3 Oct 2026');
        expect(text).toContain('Kept since 20 Oct 2026');
        expect(text).toContain('Last brought your account back on 12 Oct 2026');
        expect(text).toContain('Not removed yet. The app tries again each time it opens.');
        expect(text).toContain("Didn't answer, so what it keeps can't be listed here.");
        expect(text).toContain('Keeps no copy of your account.');
        // The copy waiting to be removed has no Remove of its own; the one still kept does.
        expect(buttonNamed('Remove the Apple copy at Mullumbimby')).toBeUndefined();
        expect(buttonNamed('Remove the Google copy at Mullumbimby')).toBeTruthy();
        expect(text).not.toContain('Nothing is kept anywhere');
    });
});
