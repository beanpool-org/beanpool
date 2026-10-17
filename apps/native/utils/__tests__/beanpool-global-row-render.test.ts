// @vitest-environment jsdom
/**
 * The BeanPool sheet's global row (app/beanpool.tsx; DESIGN-global-entry-fable.md §B.3, decisions 1 and 8), rendered for
 * real with the real door and entry hooks (use-global-door-open.ts, use-global-entry.ts, global-door-offer.ts,
 * global-entry.ts, the membership probe), so each state is reached the way a phone reaches it: by what the global
 * community answers. Under YOUR COMMUNITIES there is always exactly one row for it, whatever it answers and whether or not
 * the phone has it saved; its second line says the state, its tap does what the line says, and TalkBack reads both.
 *
 * Before P2 the sheet drew a row only when the one rule said `join`: offline, slow, shut, in a preview, closed, or a
 * member, there was no row for the global community at all unless it was in the saved list. The first tests here fail on
 * origin/main for that reason (no row offline).
 *
 * Nothing is contacted: fetch answers the global community's info and membership probe only, from the scene below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// The screen doesn't import React (Metro's automatic JSX runtime); this runner compiles JSX the classic way.
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, onLongPress, accessibilityLabel, accessibilityHint, accessibilityRole, accessibilityState, disabled, testID, numberOfLines, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onLongPress && !disabled) attrs.onDoubleClick = () => onLongPress();
        if (disabled) attrs['data-disabled'] = 'true';
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityState?.selected) attrs['aria-selected'] = 'true';
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        const style = typeof props.style === 'function' ? props.style({ pressed: false }) : props.style;
        const flat = Object.assign({}, ...[style].flat(3).filter((x) => x && typeof x === 'object'));
        if (typeof flat.fontSize === 'number') attrs['data-font'] = String(flat.fontSize);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Share: { share: async () => ({}) },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        Linking: { openURL: async () => {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], navigated: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const router = {
        push: (to: unknown) => nav.pushed.push(to), navigate: (to: unknown) => nav.navigated.push(to),
        back() {}, replace() {}, canDismiss: () => false, dismissAll() {},
    };
    return { router, useRouter: () => router, useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]), ErrorBoundary: () => null };
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
vi.mock('../use-guide', async () => {
    const { getBundledGuide } = await import('../guide');
    return { useGuide: () => ({ guide: getBundledGuide(), source: 'bundled' }) };
});
vi.mock('../beanpool-links', () => ({ openBeanPoolWebsite: async () => {} }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
const KEY = 'c'.repeat(64);
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: KEY, privateKey: 'd'.repeat(64), callsign: 'Damo' }, setIdentity() {} }),
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'X-Test-Signed': '1' }) }));
// The phone's mark that global closed this key (global-join-existing.ts), as the hook and askGlobalStanding read it.
const closedMark = vi.hoisted(() => ({ on: false }));
vi.mock('../global-join-existing', () => ({
    isGlobalCommunity: (url: string | null | undefined) => !!url && url.trim().replace(/\/+$/, '').toLowerCase() === 'https://global.beanpool.org',
    accountClosedAtGlobal: async () => closedMark.on,
    rememberAccountClosed: async () => { closedMark.on = true; },
    forgetAccountClosed: async () => { closedMark.on = false; },
}));
// The phone's saved communities, as use-communities.ts reports them (each row's own probe is that hook's, not this row's).
const list = vi.hoisted(() => ({
    rows: [] as { url: string; name: string; status: 'checking' | 'online' | 'guest' | 'offline' }[],
    active: 'https://riverside.example' as string | null,
    switched: [] as string[],
    removed: [] as string[],
}));
vi.mock('../use-communities', () => ({
    useCommunities: () => ({
        active: list.active,
        current: list.rows.find((r) => r.url === list.active) ?? null,
        rows: list.rows,
        lastSync: null,
        switching: false,
        switchTo: async (url: string) => { list.switched.push(url); },
        remove: (row: { url: string }) => { list.removed.push(row.url); },
    }),
}));

import BeanPoolSheet from '../../app/beanpool';
import { forgetGlobalDoorOffer } from '../global-door-offer';
import { setLanguage } from '@beanpool/core';

const GLOBAL = 'https://global.beanpool.org';
const LOCAL = 'https://riverside.example';
const RIVERSIDE = { url: LOCAL, name: 'Riverside', status: 'online' as const };

type Door = 'open' | 'openWords' | 'shut' | 'preview' | 'notGlobal' | 'offline';
type Standing = 'member' | 'stranger' | 'closed' | 'hang' | 'silent';
const scene = { door: 'open' as Door, standing: 'stranger' as Standing };
const asked: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function info(): Response {
    const global = (features: Record<string, unknown>) => json({ name: 'Global community', profile: 'global', features: { beans: false, invites: false, ...features } });
    switch (scene.door) {
        case 'open': return global({ openJoin: true });
        case 'openWords': return global({ openJoin: true, wordsDoor: true });
        case 'shut': return global({ openJoin: false });
        case 'preview': return global({ openJoin: true, privatePreview: true });
        case 'notGlobal': return json({ name: 'Somewhere', profile: 'local', features: { openJoin: true } });
        default: throw new TypeError('Network request failed');
    }
}
function membership(): Promise<Response> {
    switch (scene.standing) {
        case 'member': return Promise.resolve(json({ isMember: true }));
        case 'stranger': return Promise.resolve(json({ isMember: false }));
        case 'closed': return Promise.resolve(json({ error: 'Account closed', code: 'account_closed' }, 403));
        case 'hang': return new Promise<Response>(() => {});
        default: return Promise.resolve(json({ error: 'Internal' }, 500));
    }
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    asked.length = 0;
    nav.pushed.length = 0;
    nav.navigated.length = 0;
    list.rows = [RIVERSIDE];
    list.active = LOCAL;
    list.switched.length = 0;
    list.removed.length = 0;
    closedMark.on = false;
    scene.door = 'open';
    scene.standing = 'stranger';
    forgetGlobalDoorOffer();
    setLanguage('en');
    globalThis.fetch = vi.fn(async (input: unknown) => {
        const u = String(input);
        asked.push(u);
        if (scene.door === 'offline') throw new TypeError(`Network request failed: ${u}`);
        if (u === `${GLOBAL}/api/community/info`) return info();
        if (u === `${GLOBAL}/api/community/membership/${KEY}`) return membership();
        throw new TypeError(`Network request failed: ${u}`);
    }) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

// A tick of the clock each time, not only the microtasks: the probe's first ask loads its module (a dynamic import).
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
async function open(): Promise<void> {
    await act(async () => { root.render(createElement(BeanPoolSheet) as any); });
    await settle();
}
/** The global community's rows: there must be exactly one. */
const globalRows = () => Array.from(host.querySelectorAll('[data-testid="global-community-row"]'));
function row(): HTMLElement {
    const rows = globalRows();
    expect(rows, 'exactly one global row').toHaveLength(1);
    return rows[0] as HTMLElement;
}
const texts = (el: Element) => Array.from(el.querySelectorAll('span')).map((s) => s.textContent ?? '');
const title = () => texts(row())[0];
const line = () => texts(row())[1];
const icon = () => row().querySelector('i')?.getAttribute('data-icon') ?? (row().querySelector('div > div') ? 'dot' : null);
async function tap(): Promise<void> {
    await act(async () => { row().click(); });
    await settle();
}
/** The rows under YOUR COMMUNITIES, in order, by what TalkBack reads. */
function communityRows(): string[] {
    const label = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === 'YOUR COMMUNITIES')!;
    const group = label.nextElementSibling!;
    return Array.from(group.children).map((c) => c.getAttribute('aria-label') ?? '');
}

describe('one row for the global community, whatever it answers (the phone does not have it saved)', () => {
    it('offline: the row is there, says it can\'t reach it, and a tap asks again (fails on origin/main: no row)', async () => {
        scene.door = 'offline';
        await open();
        expect(title()).toBe('Global community');
        expect(line()).toBe("Can't reach it right now. Tap to try again.");
        expect(row().getAttribute('aria-label')).toBe("Global community, Can't reach it right now. Tap to try again.");
        expect(row().getAttribute('data-disabled')).toBeNull();
        // Back online, the tap asks again: the door is open and the key a stranger there, so the row is Join.
        scene.door = 'open';
        const before = asked.filter((u) => u.endsWith('/api/community/info')).length;
        await tap();
        expect(asked.filter((u) => u.endsWith('/api/community/info')).length).toBe(before + 1);
        expect(line()).toBe('Join with this account: a sign-in');
        expect(nav.pushed).toEqual([]);
    });

    it('open door, a stranger: Join with this account, naming both ways where the door has the 12 words; a tap opens the door', async () => {
        scene.door = 'openWords';
        await open();
        expect(line()).toBe('Join with this account: 12 words or a sign-in');
        expect(row().getAttribute('aria-label')).toBe('Global community, Join with this account: 12 words or a sign-in');
        expect(icon()).toBe('earth');
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
        expect(list.switched).toEqual([]);
    });

    it('open door, the sign-in alone where the door has no 12-words way', async () => {
        await open();
        expect(line()).toBe('Join with this account: a sign-in');
    });

    it('a member there (the probe says so), with no saved row: its address, and a tap switches to it', async () => {
        scene.standing = 'member';
        await open();
        expect(title()).toBe('Global community');
        expect(line()).toBe('global.beanpool.org');
        await tap();
        expect(list.switched).toEqual([GLOBAL]);
        expect(nav.pushed).toEqual([]);
    });

    it('still asking about this key: Checking…, and the row waits (no door for a member to see flash up)', async () => {
        scene.standing = 'hang';
        await open();
        expect(line()).toBe('Checking…');
        expect(row().getAttribute('data-disabled')).toBe('true');
        await tap();
        expect(nav.pushed).toEqual([]);
    });

    it('the door is shut: not taking new members, and a tap opens the door\'s own page (Try again)', async () => {
        scene.door = 'shut';
        await open();
        expect(line()).toBe('Not taking new members right now.');
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
    });

    it('whatever answers there is not the global community: the same, never a door', async () => {
        scene.door = 'notGlobal';
        await open();
        expect(line()).toBe('Not taking new members right now.');
        // The probe is never sent where the door isn't open.
        expect(asked.some((u) => u.includes('/api/community/membership/'))).toBe(false);
    });

    it('a private preview: the node\'s own sentence, and the same page on a tap', async () => {
        scene.door = 'preview';
        await open();
        expect(line()).toBe('This community is in a private preview. Ask its owner for an invite.');
        expect(row().getAttribute('aria-label')).toBe('Global community, This community is in a private preview. Ask its owner for an invite.');
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
    });

    it('the global community closed this account: it says so and offers nothing', async () => {
        scene.standing = 'closed';
        await open();
        expect(line()).toBe('Your account there was closed.');
        expect(row().getAttribute('data-disabled')).toBe('true');
        await tap();
        expect(nav.pushed).toEqual([]);
        expect(list.switched).toEqual([]);
    });

    it('sits after the saved communities and before Add a community', async () => {
        scene.door = 'offline';
        await open();
        expect(communityRows()).toEqual([
            'Riverside, Connected. You are a member here., in use',
            "Global community, Can't reach it right now. Tap to try again.",
            'Add a community',
        ]);
    });

    it('the row keeps its node as its state changes under the finger (can\'t reach it → Join)', async () => {
        scene.door = 'offline';
        await open();
        const before = row();
        scene.door = 'open';
        await tap();
        expect(line()).toBe('Join with this account: a sign-in');
        expect(row()).toBe(before);
    });

    it('with no saved community at all, it is still there, first', async () => {
        list.rows = [];
        list.active = null;
        scene.door = 'offline';
        await open();
        expect(communityRows()).toEqual(["Global community, Can't reach it right now. Tap to try again.", 'Add a community']);
    });
});

describe('the phone has it saved: the saved row is the global row, never a second one', () => {
    const SAVED = { url: GLOBAL, name: 'BeanPool Global', status: 'guest' as const };

    it('a member: the saved row as any row (dot, name, address), a tap switches to it', async () => {
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        scene.standing = 'member';
        await open();
        expect(title()).toBe('BeanPool Global');
        expect(line()).toBe('global.beanpool.org');
        expect(row().querySelector('i[data-icon="earth"]')).toBeNull();
        expect(row().getAttribute('data-hint')).toBe('Switches to this community. Long press to remove it.');
        await tap();
        expect(list.switched).toEqual([GLOBAL]);
        expect(communityRows()).toHaveLength(3);
    });

    it('in the list but a stranger there (Damo\'s list after a wrong Reconnect): Join, not "member"; the Guest mark stays', async () => {
        list.rows = [RIVERSIDE, SAVED];
        await open();
        expect(line()).toBe('Join with this account: a sign-in');
        expect(texts(row())).toContain('Guest');
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
        expect(list.switched).toEqual([]);
    });

    it('in use as a guest visit: the same Join, marked in use', async () => {
        list.rows = [RIVERSIDE, SAVED];
        list.active = GLOBAL;
        await open();
        expect(row().getAttribute('aria-selected')).toBe('true');
        expect(line()).toBe('Join with this account: a sign-in');
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
    });

    for (const [name, set, words] of [
        ['offline', () => { scene.door = 'offline'; }, "Can't reach it right now"],
        ['shut', () => { scene.door = 'shut'; }, 'Not taking new members right now.'],
        ['a preview', () => { scene.door = 'preview'; }, 'This community is in a private preview. Ask its owner for an invite.'],
        ['still asking', () => { scene.standing = 'hang'; }, 'Checking…'],
        ['closed this account', () => { scene.standing = 'closed'; }, 'Your account there was closed.'],
    ] as const) {
        it(`${name}: says so, and still switches to it as any saved row does (nothing a member had is taken away)`, async () => {
            list.rows = [RIVERSIDE, SAVED];
            set();
            await open();
            expect(line()).toBe(words);
            await tap();
            expect(list.switched).toEqual([GLOBAL]);
            expect(nav.pushed).toEqual([]);
        });
    }

    it('a long press removes it from the list, as any saved row (and the row comes back as the Join row: decision 8)', async () => {
        list.rows = [RIVERSIDE, SAVED];
        await open();
        await act(async () => { row().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
        expect(list.removed).toEqual([GLOBAL]);
        list.rows = [RIVERSIDE];
        await act(async () => { root.render(createElement(BeanPoolSheet, { key: 'again' }) as any); });
        await settle();
        expect(title()).toBe('Global community');
        expect(line()).toBe('Join with this account: a sign-in');
    });

    it('the row keeps its node when the sheet draws again (a press, a long press or TalkBack\'s focus on it survives)', async () => {
        list.rows = [RIVERSIDE, SAVED];
        await open();
        const riverside = host.querySelector('[aria-label^="Riverside"]');
        const before = row();
        await act(async () => { root.render(createElement(BeanPoolSheet) as any); });
        await settle();
        expect(host.querySelector('[aria-label^="Riverside"]')).toBe(riverside);
        expect(row()).toBe(before);
    });
});

describe('the row\'s words', () => {
    it('are all through t(): in the pseudo-locale every word on the row is its translation', async () => {
        setLanguage('xx', []);
        for (const set of [() => { scene.door = 'offline'; }, () => { scene.door = 'openWords'; }, () => { scene.door = 'preview'; }]) {
            act(() => root.unmount());
            root = createRoot(host);
            forgetGlobalDoorOffer();
            set();
            await open();
            for (const piece of texts(row())) expect(piece, `"${piece}" bypassed t()`).toMatch(/^\[.*\]$/s);
            expect(row().getAttribute('aria-label')).toMatch(/^\[.*\]$/s);
        }
    });

    it('two lines at most for the state and for the title, and no word of any language wider than the line at 320 dp × 1.3', async () => {
        scene.door = 'offline';
        await open();
        const [titleEl, lineEl] = Array.from(row().querySelectorAll('span'));
        expect(titleEl.getAttribute('data-lines')).toBe('2');
        expect(lineEl.getAttribute('data-lines')).toBe('2');
        // The row's text column at 320 dp, from the sheet's own styles: the scroll's padding, the group's border, the row's
        // padding, the earth icon and the chevron with their gaps.
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/beanpool.tsx'), 'utf-8');
        const n = (re: RegExp) => Number(src.match(re)![1]);
        const scroll = n(/scroll: \{ padding: (\d+) \}/);
        const border = n(/group: \{[^}]*borderWidth: (\d+)/);
        const pad = n(/row: \{[^}]*paddingHorizontal: (\d+)/);
        const gap = n(/row: \{[^}]*gap: (\d+)/);
        const column = 320 - 2 * scroll - 2 * border - 2 * pad - (24 + gap) - (22 + gap);
        expect(column).toBe(188);
        const sub = n(/rowSub: \{ fontSize: (\d+)/);
        const head = n(/rowTitle: \{ fontSize: (\d+)/);
        // A generous glyph (0.62 em, 1.25 for an emoji, 1 for CJK, none for a combining mark) at 1.3×, as
        // language-switch-render.test.ts measures; the words are the catalogs' (all 24) and the pseudo-locale's.
        const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
        const em = (c: string) => (/\p{M}/u.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
        const widthOf = (s: string, size: number) => Array.from(s).reduce((w, c) => w + em(c) * size * 1.3, 0);
        const widest = (s: string) => s.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
        const LINES = [
            'Join with this account: 12 words or a sign-in', 'Join with this account: a sign-in', 'Checking…',
            "Can't reach it right now. Tap to try again.", "Can't reach it right now", 'Not taking new members right now.',
            'This community is in a private preview. Ask its owner for an invite.', 'Your account there was closed.',
        ];
        const dir = path.resolve(__dirname, '../../words');
        for (const f of fs.readdirSync(dir).filter((x) => /^[A-Za-z-]+\.json$/.test(x))) {
            const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
            for (const key of LINES) {
                const said = cat[key];
                expect(typeof said, `${key} in ${f}`).toBe('string');
                expect(widthOf(widest(said), sub), `a word of "${said}" (${f})`).toBeLessThanOrEqual(column);
            }
            expect(widthOf(widest(cat['Global community']), head), `${f} title`).toBeLessThanOrEqual(column);
        }
        // In English the common lines take at most their two lines at the app's real text cap (constants/responsive.ts
        // MAX_FONT_SCALE: the app draws a 1.3× phone at 1.2×), wrapped word by word with a regular face's widths (a space
        // or a narrow letter 0.3 em or less, m and w 0.8, a capital 0.65, any other 0.55). The preview's sentence is the
        // one the floor cuts: TalkBack reads it whole (the label above), and its tap opens the page that shows it whole.
        const cap = Number(fs.readFileSync(path.resolve(__dirname, '../../constants/responsive.ts'), 'utf-8').match(/MAX_FONT_SCALE = ([\d.]+)/)![1]);
        expect(cap).toBeLessThanOrEqual(1.2);
        const glyph = (c: string) => (c === ' ' ? 0.25 : /[ilt:;,.'’!|\-]/.test(c) ? 0.3 : /[mwMW]/.test(c) ? 0.8 : /[A-Z]/.test(c) ? 0.65 : 0.55);
        const wide = (w: string) => Array.from(w).reduce((x, c) => x + glyph(c), 0) * sub * cap;
        const linesOf = (text: string) => {
            let lines = 1;
            let at = 0;
            for (const w of text.split(' ')) {
                const next = at === 0 ? wide(w) : at + wide(' ') + wide(w);
                if (next <= column) at = next;
                else { lines++; at = wide(w); }
            }
            return lines;
        };
        for (const key of LINES.slice(0, 6)) expect(linesOf(key), key).toBeLessThanOrEqual(2);
        expect(linesOf(LINES[6])).toBeGreaterThan(2);
    });
});
