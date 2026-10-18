// @vitest-environment jsdom
/**
 * The door screen for any open-door community (app/join-open-door.tsx, slice P5) rendered for real, at 320 dp and 1.3× font
 * (the runner's window): what it asks, of whom, and what it says.
 *
 *   - `?node=` a self-hoster's open community: it asks THAT address alone (its profile, its name), never the global
 *     community's; it says its own name in the header, the title and the intro, with its host under the title; and, opened
 *     by the member's Join in the app, the door's work starts for that address, for the key on the phone.
 *   - no node (and its old name, join-global): the global community's door, exactly as before: its words, no host line, and
 *     only the global community asked.
 *   - an address it refuses: says so, and asks nobody.
 *   - a community that isn't open: says why, under its own name.
 *   - opened by a link (`from=link`), or with another community's address any way but the member's Join in the app (a
 *     link in a spelling the router's intercept doesn't know, its old name with an address): the work waits for the tap.
 *
 * Nothing is contacted: fetch answers the addresses in the test and refuses anything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, value, onChangeText, disabled, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (onPress) attrs.onClick = () => { if (!disabled) onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert() {} },
        BackHandler: { addEventListener: listener },
        AppState: { addEventListener: listener, currentState: 'active' },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const route = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: { replace() {}, push() {}, back() {}, canGoBack: () => true },
        useLocalSearchParams: () => route.params,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
        ErrorBoundary: () => null,
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
vi.mock('../../components/SsoButton', () => ({
    GoogleButton: ({ title }: { title: string }) => createElement('button', null, title),
    AppleButton: ({ title }: { title: string }) => createElement('button', null, title),
    FacebookButton: ({ title }: { title: string }) => createElement('button', null, title),
}));
vi.mock('../../components/WordsDoor', () => ({
    DoorChoices: ({ onWords, signInNote }: { onWords: () => void; signInNote: string }) => createElement('div', null,
        createElement('button', { onClick: onWords }, 'Create an account with 12 secret words'),
        createElement('span', null, signInNote)),
    DoorWorkProgress: () => null,
}));
const KEY = { publicKey: 'ab'.repeat(32), privateKey: 'not-used', callsign: 'Wren' };
vi.mock('../global-join-existing', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../global-join-existing')>()),
    accountKeyForDoor: async () => ({ identity: KEY, createdHere: false }),
}));
// The door's work, counted: started for which address, by which key. Its functions are stable, as the real hook's are
// (useCallback): the screen's effects depend on them.
const work = vi.hoisted(() => {
    const started: { url: string; key: string; door: string }[] = [];
    const hook = {
        start: (url: string, identity: { publicKey: string }, door: string) => { started.push({ url, key: identity.publicKey, door }); return {}; },
        stop() {}, runFor: () => null, state: () => null, busy: null,
    };
    return { started, hook };
});
vi.mock('../use-door-work', () => ({ useDoorWork: () => work.hook }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async () => false }));
vi.mock('../vault', () => ({ vaultCopyKnown: async () => false }));
vi.mock('../one-way-back', () => ({ startOneWayBack: async () => {} }));
vi.mock('../global-door-offer', () => ({ rememberGlobalDoor: vi.fn() }));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

import JoinOpenDoorScreen from '../../app/join-open-door';
import JoinGlobalAlias from '../../app/join-global';
import { rememberGlobalDoor } from '../global-door-offer';
import { openDoorHrefForTap, takeDoorTap } from '../open-door';

const GLOBAL = 'https://global.beanpool.org';
const SELF = 'https://open.riverbend.example';
const OPEN = { profile: 'global', features: { openJoin: true, wordsDoor: true, door: 'open', invites: false, beans: false } };
const asked: string[] = [];

/** `info` per address (null: no answer), and the self-hoster's own name. */
function network(info: Record<string, unknown | null>, names: Record<string, string> = { [SELF]: 'Riverbend Open' }) {
    return vi.fn(async (input: unknown) => {
        const u = String(input);
        asked.push(u);
        for (const [base, body] of Object.entries(info)) {
            if (u === `${base}/api/community/info` && body) return new Response(JSON.stringify(body), { status: 200 });
        }
        for (const [base, name] of Object.entries(names)) {
            if (u === `${base}/api/community/health`) return new Response(JSON.stringify({ nodeName: name }), { status: 200 });
        }
        throw new TypeError(`Network request failed: ${u}`);
    }) as typeof fetch;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.map.clear();
    asked.length = 0;
    work.started.length = 0;
    route.params = {};
    takeDoorTap('');
    vi.mocked(rememberGlobalDoor).mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => {}); };
const text = () => host.textContent ?? '';
const header = () => host.querySelector('[role="heading"]');
const render = async (screen: unknown = JoinOpenDoorScreen) => { await act(async () => { root.render(createElement(screen as any) as any); }); await settle(); };

describe("a self-hoster's open community's door (?node=)", () => {
    it('asks THAT address alone, says its own name with its host under the title, and starts the work there for this key', async () => {
        // The member tapped Join for it in the app (app/node-mismatch.tsx).
        route.params = (openDoorHrefForTap(SELF) as { params: Record<string, string> }).params;
        globalThis.fetch = network({ [SELF]: OPEN });
        await render();
        const heads = Array.from(host.querySelectorAll('[role="heading"]')).map(h => h.textContent);
        expect(heads).toEqual(['Riverbend Open', 'Join Riverbend Open']);
        // One line in the header at 320 dp: a long name is cut, never wrapped over Back.
        expect(header()!.getAttribute('data-lines')).toBe('1');
        expect(text()).toContain('open.riverbend.example');
        expect(text()).toContain('Riverbend Open lets anyone join. Join as the account on this phone: your key and your 12 words stay the same, and nothing changes in your other communities.');
        expect(text()).toContain('Create an account with 12 secret words');
        expect(text()).not.toMatch(/global community/i);
        expect(new Set(asked.map(u => new URL(u).origin))).toEqual(new Set([SELF]));
        expect(work.started).toEqual([{ url: SELF, key: KEY.publicKey, door: 'words' }]);
        // Its answer is never taken for the global community's (what the BeanPool sheet's row reads).
        expect(rememberGlobalDoor).not.toHaveBeenCalled();
    });

    it('its saved name first, then its own answer', async () => {
        route.params = { node: SELF };
        store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: SELF, alias: 'Riverbend (saved)', lastConnected: '2026-10-01T00:00:00.000Z' }]));
        globalThis.fetch = network({ [SELF]: OPEN }, {});
        await render();
        expect(header()!.textContent).toBe('Riverbend (saved)');
    });

    it('not open (a community that joins by invite): says why, under its own name, and starts nothing', async () => {
        route.params = { node: SELF };
        globalThis.fetch = network({ [SELF]: { profile: 'local', features: { invites: true } } });
        await render();
        expect(text()).toContain("Riverbend Open joins people by invite, so it can't be joined here. Ask one of its members for an invite.");
        expect(text()).toContain('Try again');
        expect(work.started).toEqual([]);
    });

    it('unreachable: says so by name; Try again asks it again', async () => {
        route.params = { node: SELF };
        globalThis.fetch = network({ [SELF]: null }, {});
        await render();
        expect(text()).toContain("Can't reach open.riverbend.example right now. Check your connection and try again.");
        const before = asked.filter(u => u.endsWith('/api/community/info')).length;
        await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Try again')!.click(); });
        await settle();
        expect(asked.filter(u => u.endsWith('/api/community/info')).length).toBe(before + 1);
    });

    it.each([
        ['a link in a spelling the router\'s intercept missed (beanpool://join-open-door//?node=…): no from=link, no Join', JoinOpenDoorScreen, () => {}],
        ['its old name with an address (beanpool://join-global?node=…, any spelling)', JoinGlobalAlias, () => {}],
        ['the member\'s Join was for another community', JoinOpenDoorScreen, () => { openDoorHrefForTap('https://commons.example.nz'); }],
        ['the member\'s Join for it, a minute and more ago', JoinOpenDoorScreen, () => { openDoorHrefForTap(SELF, Date.now() - 61_000); }],
    ])('opened any other way than the member\'s Join in the app (%s): held all the same (PR #2131 review)', async (_how, screen, before) => {
        before();
        route.params = { node: SELF };
        globalThis.fetch = network({ [SELF]: OPEN });
        await render(screen);
        expect(header()!.textContent).toBe('Riverbend Open');
        expect(text()).toContain('Create an account with 12 secret words');
        expect(work.started).toEqual([]);
        await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Create an account with 12 secret words')!.click(); });
        expect(work.started).toEqual([{ url: SELF, key: KEY.publicKey, door: 'words' }]);
    });

    it('opened by a link (from=link): the door is drawn, and its work waits for the member\'s tap', async () => {
        route.params = { node: SELF, from: 'link' };
        globalThis.fetch = network({ [SELF]: OPEN });
        await render();
        expect(text()).toContain('Create an account with 12 secret words');
        expect(work.started).toEqual([]);
        await act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Create an account with 12 secret words')!.click(); });
        expect(work.started).toEqual([{ url: SELF, key: KEY.publicKey, door: 'words' }]);
    });
});

describe('an address the screen refuses', () => {
    it.each(['http://open.riverbend.example', 'https://127.0.0.1\\@evil.test', 'https://open.riverbend.example/path', 'javascript:alert(1)'])('%s: says so, and asks nobody', async (node) => {
        route.params = { node };
        globalThis.fetch = network({ [SELF]: OPEN, [GLOBAL]: OPEN });
        await render();
        expect(text()).toContain("BeanPool can't open this community's door: its address isn't a plain web address it can safely connect to. Nothing was sent.");
        expect(asked).toEqual([]);
        expect(work.started).toEqual([]);
        // Never the global community's door in its place.
        expect(text()).not.toMatch(/global community/i);
    });
});

describe("the global community's door (no node, and its old name)", () => {
    it.each([['join-open-door', JoinOpenDoorScreen], ['join-global', JoinGlobalAlias]])('%s: its words as before, no host line, only global asked', async (_name, screen) => {
        globalThis.fetch = network({ [GLOBAL]: OPEN });
        await render(screen);
        const heads = Array.from(host.querySelectorAll('[role="heading"]')).map(h => h.textContent);
        expect(heads).toEqual(['Global community', '🌍 Join the global community']);
        expect(text()).toContain('Meet people from everywhere and find communities near you, as the account on this phone.');
        expect(text()).not.toContain('global.beanpool.org');
        expect(new Set(asked.map(u => new URL(u).origin))).toEqual(new Set([GLOBAL]));
        expect(work.started).toEqual([{ url: GLOBAL, key: KEY.publicKey, door: 'words' }]);
        // Its answer is what the sheet's global row reads on the way back.
        expect(rememberGlobalDoor).toHaveBeenCalledTimes(1);
    });
});
