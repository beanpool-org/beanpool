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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

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
        if (accessibilityState?.disabled !== undefined) attrs['aria-disabled'] = String(accessibilityState.disabled);
        if (accessibilityState?.busy !== undefined) attrs['aria-busy'] = String(accessibilityState.busy);
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
        Alert: { alert: (...a: unknown[]) => alerts.push(a) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const alerts = vi.hoisted(() => [] as unknown[][]);
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
const nav = vi.hoisted(() => ({ pushed: [] as unknown[], navigated: [] as unknown[], replaced: [] as unknown[] }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    const router = {
        push: (to: unknown) => nav.pushed.push(to), navigate: (to: unknown) => nav.navigated.push(to),
        back() {}, replace: (to: unknown) => nav.replaced.push(to), canDismiss: () => false, dismissAll() {},
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
// Where the phone keeps its key (identity.ts): a guest visit writes nothing there (recorded, so a write would show).
const secure = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async (k: string) => { secure.writes.push(k); },
    deleteItemAsync: async (k: string) => { secure.writes.push(`delete ${k}`); },
}));
// A guest visit's switch (utils/global-guest-visit.ts → reconnect.ts switchPhoneTo): the anchor written, and whether the
// guest mark was already there when it moved (the root layout must never see the phone on global unmarked).
const moved = vi.hoisted(() => ({ to: [] as string[], markedFirst: [] as boolean[] }));
vi.mock('../reconnect', () => ({
    switchPhoneTo: async (url: string) => {
        moved.markedFirst.push((JSON.parse(store.map.get('beanpool_guest_nodes') ?? '[]') as string[]).includes(url));
        moved.to.push(url);
        store.map.set('beanpool_anchor_url', url);
        return null;
    },
}));
vi.mock('../../services/pillar-sync', () => ({ requestSync: async () => ({}) }));
// The root layout's recognition (app/NodeStatusContext.tsx): asked again before a visit bounces through Welcome. Each ask
// is recorded with how many replaces were made before it, so the order shows.
const status = vi.hoisted(() => {
    const s = { rechecks: [] as number[], recheck: async (): Promise<string> => { s.rechecks.push(nav.replaced.length); return 'stranger'; } };
    return s;
});
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: 'stranger', nodeUrl: null, recheck: status.recheck }) }));
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
    // undefined: use-communities.ts is still reading the saved list (its rows are [] until then).
    active: 'https://riverside.example' as string | null | undefined,
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
import { guestRedirect, memberRedirect } from '../member-landing';
import { askGlobalDoorOffer, forgetGlobalDoorOffer } from '../global-door-offer';
import { forgetSettledGlobalEntry } from '../use-global-entry';
import { GLOBAL_STANDING_STORE_KEY } from '../global-entry';
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

// The probe's modules, loaded before any test: the probe's first ask imports them (global-entry.ts defaultAskDeps), and
// the first test to probe is the offline one's tap, mid-assertion. Loaded cold on a busy machine (PR #2131's test-all,
// 18 Oct) that outlasted settle() below, and the row read Checking…, the right word while the probe is out (§B.3), where
// a moment later it read Join.
beforeAll(async () => { await import('../membership-probe'); await import('../global-join-existing'); });

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
    nav.replaced.length = 0;
    alerts.length = 0;
    secure.writes.length = 0;
    moved.to.length = 0;
    moved.markedFirst.length = 0;
    status.rechecks.length = 0;
    list.rows = [RIVERSIDE];
    list.active = LOCAL;
    list.switched.length = 0;
    list.removed.length = 0;
    closedMark.on = false;
    scene.door = 'open';
    scene.standing = 'stranger';
    forgetGlobalDoorOffer();
    forgetSettledGlobalEntry();
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
/**
 * The sheet's first draw, before any effect has run: what the phone paints while the sheet slides in, before its own
 * reads of the phone's store (the saved list, the kept answer) come back.
 */
function firstDraw(): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = renderToString(createElement(BeanPoolSheet) as any);
    return el;
}
/** The global community's rows: there must be exactly one. */
const globalRows = (scope: ParentNode = host) => Array.from(scope.querySelectorAll('[data-testid="global-community-row"]'));
function row(scope?: ParentNode): HTMLElement {
    const rows = globalRows(scope);
    expect(rows, 'exactly one global row').toHaveLength(1);
    return rows[0] as HTMLElement;
}
const texts = (el: Element) => Array.from(el.querySelectorAll('span')).map((s) => s.textContent ?? '');
const title = (scope?: ParentNode) => texts(row(scope))[0];
const line = (scope?: ParentNode) => texts(row(scope))[1];
const icon = () => row().querySelector('i')?.getAttribute('data-icon') ?? (row().querySelector('div > div') ? 'dot' : null);
/** What leads the row: a saved row's dot, or an icon (the earth). */
const lead = (scope?: ParentNode) => {
    const first = row(scope).firstElementChild;
    return first?.tagName === 'I' ? first.getAttribute('data-icon') : 'dot';
};
async function tap(): Promise<void> {
    await act(async () => { row().click(); });
    await settle();
}
/** The rows under YOUR COMMUNITIES, in order, by what TalkBack reads. */
function communityRows(scope: ParentNode = host): string[] {
    const label = Array.from(scope.querySelectorAll('span')).find((s) => s.textContent === 'YOUR COMMUNITIES')!;
    const group = label.nextElementSibling!;
    return Array.from(group.children).map((c) => c.getAttribute('aria-label') ?? '');
}

describe('one row for the global community, whatever it answers (the phone does not have it saved)', () => {
    it('offline: the row is there, says it can\'t reach it, and a tap asks again (fails on origin/main: no row)', async () => {
        scene.door = 'offline';
        await open();
        expect(title()).toBe('Global community');
        expect(line()).toBe("Can't reach it right now. Tap to try again.");
        expect(row().getAttribute('aria-label')).toBe("Global community, Can't reach it right now. Tap to try again. Your own community isn't affected.");
        expect(row().getAttribute('data-disabled')).toBeNull();
        // Back online, the tap asks again: the door is open and the key a stranger there, so the row is Join.
        scene.door = 'open';
        const before = asked.filter((u) => u.endsWith('/api/community/info')).length;
        await tap();
        expect(asked.filter((u) => u.endsWith('/api/community/info')).length).toBe(before + 1);
        expect(line()).toBe('Look around first, then join with this account');
        expect(nav.pushed).toEqual([]);
        expect(moved.to).toEqual([]);
    });

    it('open door, a stranger: guest view first (Marty, 21 Oct): a tap opens the global community as a guest, never the door (fails on origin/main: the door)', async () => {
        scene.door = 'openWords';
        await open();
        expect(line()).toBe('Look around first, then join with this account');
        expect(row().getAttribute('aria-label')).toBe('Global community, Look around first, then join with this account');
        expect(icon()).toBe('earth');
        await tap();
        // The phone is on the global community now, marked a guest visit BEFORE it moved, kept in the saved list, and the
        // app goes through Welcome as every switch does. The door is the header's Join pill's, later.
        expect(moved.to).toEqual([GLOBAL]);
        expect(moved.markedFirst).toEqual([true]);
        expect(JSON.parse(store.map.get('beanpool_guest_nodes') ?? '[]')).toEqual([GLOBAL]);
        expect((JSON.parse(store.map.get('beanpool_saved_nodes') ?? '[]') as { url: string }[]).map((n) => n.url)).toContain(GLOBAL);
        expect(nav.replaced).toEqual(['/welcome']);
        expect(nav.pushed).toEqual([]);
        expect(list.switched).toEqual([]);
        expect(alerts).toEqual([]);
    });

    it('open door, the sign-in alone where the door has no 12-words way: the same line (the door names its ways when the member gets there)', async () => {
        await open();
        expect(line()).toBe('Look around first, then join with this account');
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
            "Global community, Can't reach it right now. Tap to try again. Your own community isn't affected.",
            'Add a community',
        ]);
    });

    for (const door of ['shut', 'preview'] as const) {
        it(`the door ${door} and the phone hasn't it saved: the probe is never sent`, async () => {
            scene.door = door;
            await open();
            expect(globalRows()).toHaveLength(1);
            expect(asked.some((u) => u.includes('/api/community/membership/'))).toBe(false);
        });
    }

    it('the row keeps its node as its state changes under the finger (can\'t reach it → Join)', async () => {
        scene.door = 'offline';
        await open();
        const before = row();
        scene.door = 'open';
        await tap();
        expect(line()).toBe('Look around first, then join with this account');
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

describe("the global community can't be reached: the community in use isn't affected (DESIGN-global-mothership-fable.md §2.5, pick 1)", () => {
    const AFFECTED = "Your own community isn't affected.";
    const SAVED = { url: GLOBAL, name: 'BeanPool Global', status: 'guest' as const };

    it('on another community that answers: the line, then that one, and TalkBack reads both (fails on origin/main)', async () => {
        scene.door = 'offline';
        await open();
        expect(texts(row())).toEqual(['Global community', "Can't reach it right now. Tap to try again.", AFFECTED]);
        expect(row().getAttribute('aria-label')).toBe(`Global community, Can't reach it right now. Tap to try again. ${AFFECTED}`);
    });

    it('is never cut: nothing opens it whole, and in de, fr, ru, ml and ta it takes three lines at 320 dp', async () => {
        scene.door = 'offline';
        await open();
        const aside = Array.from(row().querySelectorAll('span')).find((s) => s.textContent === AFFECTED)!;
        expect(aside.getAttribute('data-lines')).toBeNull();
    });

    it('the phone has it saved: the same under the saved row\'s line, read as two sentences', async () => {
        list.rows = [RIVERSIDE, SAVED];
        scene.door = 'offline';
        await open();
        expect(texts(row()).slice(0, 3)).toEqual(['BeanPool Global', "Can't reach it right now", AFFECTED]);
        expect(row().getAttribute('aria-label')).toBe(`BeanPool Global, Can't reach it right now. ${AFFECTED}`);
    });

    it('not while the phone is on the global community itself, where it would be untrue', async () => {
        list.rows = [RIVERSIDE, SAVED];
        list.active = GLOBAL;
        scene.door = 'offline';
        await open();
        expect(line()).toBe("Can't reach it right now");
        expect(texts(row())).not.toContain(AFFECTED);
        expect(row().getAttribute('aria-label')).not.toContain(AFFECTED);
    });

    it("not while the community in use can't be reached either (the phone itself is likely offline)", async () => {
        list.rows = [{ ...RIVERSIDE, status: 'offline' }];
        scene.door = 'offline';
        await open();
        expect(texts(row())).not.toContain(AFFECTED);
        expect(row().getAttribute('aria-label')).toBe("Global community, Can't reach it right now. Tap to try again.");
    });

    it('not while the phone is a guest in the community in use: it answers, but it isn\'t "your own"', async () => {
        list.rows = [{ ...RIVERSIDE, status: 'guest' }];
        scene.door = 'offline';
        await open();
        expect(texts(row())).not.toContain(AFFECTED);
        expect(row().getAttribute('aria-label')).toBe("Global community, Can't reach it right now. Tap to try again.");
    });

    it('in every catalog TalkBack reads one stop between the two, the language\'s own (hi, bn: "।"; ur: "۔"; ja, zh: "。")', async () => {
        const dir = path.resolve(__dirname, '../../words');
        for (const f of fs.readdirSync(dir).filter((x) => /^[A-Za-z-]+\.json$/.test(x))) {
            const cat = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>;
            const aside = cat[AFFECTED];
            const stop = aside.slice(-1);
            expect(stop, `${f} ends "${aside}" with a full stop`).toMatch(/^[.。।۔]$/);
            for (const saved of [false, true]) {
                act(() => root.unmount());
                root = createRoot(host);
                forgetGlobalDoorOffer();
                setLanguage(f.replace(/\.json$/, '') as Parameters<typeof setLanguage>[0], [cat]);
                list.rows = saved ? [RIVERSIDE, SAVED] : [RIVERSIDE];
                scene.door = 'offline';
                await open();
                // Unsaved, the line has its own stop; saved ("Can't reach it right now"), it takes the aside's.
                const said = saved ? `${cat["Can't reach it right now"]}${stop} ${aside}` : `${cat["Can't reach it right now. Tap to try again."]} ${aside}`;
                expect(row().getAttribute('aria-label'), `${f}${saved ? ', saved' : ''}`).toContain(said);
            }
        }
    });

    for (const door of ['open', 'shut', 'preview'] as const) {
        it(`not when the global community answered (door ${door}): only "can't reach it" says it`, async () => {
            scene.door = door;
            await open();
            expect(texts(row())).not.toContain(AFFECTED);
        });
    }
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

    it('in the list but a stranger there (Damo\'s list after a wrong Reconnect): not "member"; the Guest mark stays, and a tap visits it as a guest, marked first (fails on origin/main: the door)', async () => {
        list.rows = [RIVERSIDE, SAVED];
        await open();
        expect(line()).toBe('Look around first, then join with this account');
        expect(texts(row())).toContain('Guest');
        await tap();
        expect(moved.to).toEqual([GLOBAL]);
        expect(moved.markedFirst).toEqual([true]);
        expect(nav.replaced).toEqual(['/welcome']);
        expect(nav.pushed).toEqual([]);
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
        expect(line()).toBe('Look around first, then join with this account');
    });

    it('in use as a member: no hint of a switch the tap doesn\'t do, and TalkBack reads the name it shows, its connection and in use', async () => {
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        list.active = GLOBAL;
        scene.standing = 'member';
        await open();
        expect(row().getAttribute('aria-selected')).toBe('true');
        expect(row().getAttribute('data-hint')).toBeNull();
        expect(row().getAttribute('aria-label')).toBe('BeanPool Global, Connected. You are a member here., in use');
    });

    it('not in use, a member: the hint stays, and the label is the shown name and its connection, as the rows beside it', async () => {
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        scene.standing = 'member';
        await open();
        expect(row().getAttribute('data-hint')).toBe('Switches to this community. Long press to remove it.');
        expect(row().getAttribute('aria-label')).toBe('BeanPool Global, Connected. You are a member here.');
    });

    it('not in use, with notices since it was last open: its number, as the rows beside it, read after its connection (utils/notice-counts.ts)', async () => {
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        scene.standing = 'member';
        store.map.set('beanpool_anchor_url', RIVERSIDE.url);
        store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE.url }, { url: GLOBAL }]));
        store.map.set('beanpool_notice_counts', JSON.stringify({ [GLOBAL]: { n: 2, seen: {} } }));
        await open();
        expect(row().getAttribute('aria-label')).toBe('BeanPool Global, Connected. You are a member here., 2 new notifications');
        expect(Array.from(row().querySelectorAll('span')).map((s) => s.textContent)).toContain('2');
    });

    for (const door of ['shut', 'preview'] as const) {
        it(`a member's own saved row with the door ${door}, nothing kept: its address, never the strangers' words`, async () => {
            list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
            list.active = GLOBAL;
            scene.door = door;
            scene.standing = 'member';
            await open();
            // The sheet already asks every saved community the probe (use-communities.ts), so asking it here tells the
            // global community nothing new.
            expect(asked).toContain(`${GLOBAL}/api/community/membership/${KEY}`);
            expect(line()).toBe('global.beanpool.org');
            expect(row().querySelector('i[data-icon="earth"]')).toBeNull();
        });
    }

    // The global community answered `member` for this key under a day ago, and the phone kept it.
    const keptMember = () => store.map.set(GLOBAL_STANDING_STORE_KEY, JSON.stringify({ [KEY]: { standing: 'member', at: Date.now() - 60_000 } }));
    const STRANGERS = ['Join with this account: a sign-in', 'Not taking new members right now.',
        'This community is in a private preview. Ask its owner for an invite.', "Can't reach it right now"];

    for (const door of ['open', 'shut', 'preview', 'offline'] as const) {
        it(`a member's own row, first open this app start with the door ${door}: its first draw is Checking… and its dot, never the strangers' words (fails on aefa582a)`, async () => {
            list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
            list.active = GLOBAL;
            scene.door = door;
            scene.standing = 'member';
            keptMember();
            await askGlobalDoorOffer(); // the door already answered this app start
            const drawn = firstDraw();
            expect(title(drawn)).toBe('BeanPool Global');
            expect(line(drawn)).toBe('Checking…');
            expect(STRANGERS).not.toContain(line(drawn));
            expect(lead(drawn)).toBe('dot');
            // Then its own row, in the same place.
            await open();
            expect(line()).toBe('global.beanpool.org');
            expect(lead()).toBe('dot');
        });
    }

    it('a member\'s own row, opened again this app start: drawn as a member from its first draw (fails on aefa582a)', async () => {
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        list.active = GLOBAL;
        scene.door = 'shut';
        scene.standing = 'member';
        await open();
        expect(line()).toBe('global.beanpool.org');
        act(() => root.unmount());
        root = createRoot(host);
        const drawn = firstDraw();
        expect(line(drawn)).toBe('global.beanpool.org');
        expect(lead(drawn)).toBe('dot');
    });

    it('not drawn while the saved list is still being read, then drawn once, in the saved row\'s place (fails on aefa582a)', async () => {
        list.rows = [];
        list.active = undefined;
        scene.standing = 'member';
        keptMember();
        await open();
        expect(globalRows()).toHaveLength(0);
        expect(communityRows()).toEqual(['Add a community']);
        // The list arrives: global is saved, so its row is the saved one, under its saved name, after Riverside.
        list.rows = [RIVERSIDE, { ...SAVED, status: 'online' }];
        list.active = GLOBAL;
        await act(async () => { root.render(createElement(BeanPoolSheet) as any); });
        await settle();
        expect(title()).toBe('BeanPool Global');
        expect(line()).toBe('global.beanpool.org');
        const group = row().parentElement!;
        expect(Array.from(group.children).indexOf(row())).toBe(1);
        expect(group.children).toHaveLength(3);
    });

    for (const inUse of [GLOBAL, LOCAL]) {
        it(`a member, both saved communities offline, ${inUse === GLOBAL ? 'global' : 'Riverside'} in use: TalkBack reads each row the same way, can't reach it and in use (fails on aefa582a)`, async () => {
            list.rows = [{ ...RIVERSIDE, status: 'offline' }, { ...SAVED, status: 'offline' }];
            list.active = inUse;
            scene.door = 'offline';
            keptMember();
            await open();
            expect(line()).toBe('global.beanpool.org');
            expect(communityRows()).toEqual(inUse === GLOBAL
                ? ["Riverside, Can't reach it right now", "BeanPool Global, Can't reach it right now, in use", 'Add a community']
                : ["Riverside, Can't reach it right now, in use", "BeanPool Global, Can't reach it right now", 'Add a community']);
        });
    }

    it('in use and not a member there: the line it shows, then in use (fails on aefa582a)', async () => {
        list.rows = [RIVERSIDE, SAVED];
        list.active = GLOBAL;
        await open();
        expect(row().getAttribute('aria-label')).toBe('BeanPool Global, Join with this account: a sign-in, in use');
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

describe('guest view first: what a visit asks, writes and never touches (utils/global-guest-visit.ts)', () => {
    /** What the phone keeps under each storage key, as a copy. */
    const kept = () => new Map(store.map);
    const written = (before: Map<string, string>) =>
        [...store.map.keys()].filter((k) => store.map.get(k) !== before.get(k)).sort();

    it('a stranger: writes the guest mark, the saved list, the probe\'s kept answer and the community in use, nothing of the account', async () => {
        await open();
        const before = kept();
        await tap();
        expect(moved.to).toEqual([GLOBAL]);
        // And the phone's copy of the community's public profile, which the door check refreshes.
        expect(written(before)).toEqual(['beanpool_anchor_url', 'beanpool_global_standing', 'beanpool_guest_nodes', 'beanpool_node_profiles', 'beanpool_saved_nodes']);
        // No key made, replaced or removed: nothing written where the phone keeps it.
        expect(secure.writes).toEqual([]);
    });

    it('a member it didn\'t know of (joined on another device since the row was drawn): switched as a member, no guest mark', async () => {
        store.map.set('beanpool_guest_nodes', JSON.stringify([GLOBAL]));
        await open();
        expect(line()).toBe('Look around first, then join with this account');
        scene.standing = 'member';
        await tap();
        expect(moved.to).toEqual([GLOBAL]);
        expect(JSON.parse(store.map.get('beanpool_guest_nodes') ?? '[]')).toEqual([]);
        expect(nav.replaced).toEqual(['/welcome']);
        expect(nav.pushed).toEqual([]);
    });

    it('the door shut since the row was drawn: nothing moves, the key is never asked about, and the door\'s page says why', async () => {
        await open();
        scene.door = 'shut';
        const probes = asked.filter((u) => u.includes('/api/community/membership/')).length;
        const before = kept();
        await tap();
        expect(asked.filter((u) => u.includes('/api/community/membership/')).length).toBe(probes);
        expect(moved.to).toEqual([]);
        expect(nav.pushed).toEqual(['/join-global']);
        expect(nav.replaced).toEqual([]);
        // At most the phone's copy of the node's profile, refreshed by the door check: never the mark, the list or the anchor.
        expect(written(before).filter((k) => !k.startsWith('beanpool_node_profile'))).toEqual([]);
    });

    it('no answer about the key this time: nothing moves, and the door screen asks again (it lands a member it didn\'t know of)', async () => {
        await open();
        scene.standing = 'silent';
        const before = kept();
        await tap();
        expect(moved.to).toEqual([]);
        expect(nav.pushed).toEqual(['/join-global']);
        expect(written(before).filter((k) => !k.startsWith('beanpool_node_profile'))).toEqual([]);
    });

    it('the global community closed this account since: nothing moves, no door, and it says so', async () => {
        await open();
        scene.standing = 'closed';
        await tap();
        expect(moved.to).toEqual([]);
        expect(nav.pushed).toEqual([]);
        expect(nav.replaced).toEqual([]);
        expect(alerts).toEqual([['Global community', 'Your account there was closed.']]);
        expect(store.map.get('beanpool_guest_nodes') ?? null).toBeNull();
    });

    it('while the visit asks: Checking…, and the row waits (never a second visit from a second tap)', async () => {
        await open();
        // The probe never answers this time: the visit is still asking when the row is read.
        scene.standing = 'hang';
        await tap();
        expect(line()).toBe('Checking…');
        expect(row().getAttribute('data-disabled')).toBe('true');
        expect(row().getAttribute('aria-disabled')).toBe('true');
        expect(row().getAttribute('aria-busy')).toBe('true');
        expect(moved.to).toEqual([]);
        expect(nav.pushed).toEqual([]);
    });

    it('already there as a guest: the row is the door itself, as before (the next step is joining)', async () => {
        list.rows = [RIVERSIDE, { url: GLOBAL, name: 'BeanPool Global', status: 'guest' }];
        list.active = GLOBAL;
        await open();
        await tap();
        expect(nav.pushed).toEqual(['/join-global']);
        expect(moved.to).toEqual([]);
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
        const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f＀-￯]/u;
        const em = (c: string) => (/\p{M}/u.test(c) ? 0 : /\p{Extended_Pictographic}/u.test(c) ? 1.25 : CJK.test(c) ? 1 : 0.62);
        const widthOf = (s: string, size: number) => Array.from(s).reduce((w, c) => w + em(c) * size * 1.3, 0);
        const widest = (s: string) => s.split(/[\s~]+/).flatMap((w) => (CJK.test(w) ? Array.from(w) : [w])).reduce((a, w) => (widthOf(w, 1) > widthOf(a, 1) ? w : a), '');
        const LINES = [
            'Join with this account: 12 words or a sign-in', 'Join with this account: a sign-in', 'Checking…',
            "Can't reach it right now. Tap to try again.", "Can't reach it right now", 'Not taking new members right now.',
            'This community is in a private preview. Ask its owner for an invite.', 'Your account there was closed.',
            // Under the line while the global community can't be reached (DESIGN-global-mothership-fable.md §2.5).
            "Your own community isn't affected.",
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
        for (const key of [...LINES.slice(0, 6), ...LINES.slice(7)]) expect(linesOf(key), key).toBeLessThanOrEqual(2);
        // Guest view first's line (21 Oct): new, so a catalog drafts it later; until then the English shows, and it fits.
        const LOOK = 'Look around first, then join with this account';
        expect(linesOf(LOOK), LOOK).toBeLessThanOrEqual(2);
        for (const f of fs.readdirSync(dir).filter((x) => /^[A-Za-z-]+\.json$/.test(x))) {
            const said = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, string>)[LOOK];
            if (typeof said === 'string') expect(widthOf(widest(said), sub), `a word of "${said}" (${f})`).toBeLessThanOrEqual(column);
        }
        expect(linesOf(LINES[6])).toBeGreaterThan(2);
    });
});

describe('the bounce through Welcome lands on the tabs, from a community that calls the key a stranger (PR #2320 review)', () => {
    // A guest on a members-only community (the Market's members-only page offers the visit there): the root layout's
    // recognition is 'stranger', and its guard holds every stranger on Welcome (mismatch-plan.ts notRecognisedStays), so
    // the visit's bounce stayed on Welcome. Each test starts with no landing asked for (member-landing.ts keeps one).
    beforeEach(() => { memberRedirect(['welcome']); });

    it('a guest: the root layout asks again before the bounce, and the tabs are asked for, for this key, once (fails on the PR head: neither)', async () => {
        await open();
        await tap();
        expect(moved.to).toEqual([GLOBAL]);
        // Asked once, before anything was replaced.
        expect(status.rechecks).toEqual([0]);
        expect(nav.replaced).toEqual(['/welcome']);
        // The root guard, finding this chosen guest on Welcome, lands where the visit asked (app/_layout.tsx).
        expect(guestRedirect(['welcome'], KEY)).toBe('/(tabs)');
        expect(guestRedirect(['welcome'], KEY)).toBeNull();
    });

    it('a member it didn\'t know of: asked again before the bounce; nothing asked for, and the guard lands a member on the tabs as before', async () => {
        await open();
        scene.standing = 'member';
        await tap();
        expect(moved.to).toEqual([GLOBAL]);
        expect(status.rechecks).toEqual([0]);
        expect(nav.replaced).toEqual(['/welcome']);
        expect(guestRedirect(['welcome'], KEY)).toBeNull();
        expect(memberRedirect(['welcome'], KEY)).toBe('/(tabs)');
    });

    it('nothing moved (the door shut since the row was drawn): nothing asked again, nothing asked for', async () => {
        await open();
        scene.door = 'shut';
        await tap();
        expect(moved.to).toEqual([]);
        expect(status.rechecks).toEqual([]);
        expect(nav.replaced).toEqual([]);
        expect(guestRedirect(['welcome'], KEY)).toBeNull();
    });
});
