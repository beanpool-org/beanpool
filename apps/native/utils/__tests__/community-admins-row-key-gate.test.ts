// @vitest-environment jsdom
/**
 * The whole key, measured where it would leave (#2683 deciding pass, CommunityAdminsRow.tsx:171). The real row, with the real
 * status read and the real turn-on (utils/community-copy.ts): only the request itself is faked, so a body with `copyKey`
 * in it is the key reaching the community's server. community-admins-row-render.test.ts holds the row's states; this one
 * holds the promise: while the status is unknown, or its read failed, no such request is ever made. Nothing is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, accessibilityRole } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityRole === 'button') attrs.role = 'button';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: () => {} },
    };
});
vi.mock('expo-router', async () => {
    const React = await import('react');
    return { useFocusEffect: (cb: () => void) => { React.useEffect(cb, [cb]); } };
});
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => store.get(k) ?? null,
        setItem: async (k: string, v: string) => { store.set(k, v); },
        removeItem: async (k: string) => { store.delete(k); },
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
const me = vi.hoisted(() => ({ identity: { publicKey: 'a1'.repeat(32), privateKey: 'b2'.repeat(32), callsign: 'Sally' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: me.identity }) }));
vi.mock('../LocalAuth', () => ({ authenticateUser: async () => true }));
vi.mock('../../components/key-lines', () => ({ keyLineWords: (s: string) => s }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('../identity', () => ({ getMnemonic: async () => null }));
vi.mock('../crypto', () => ({ hexToBytes: (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)) }));
vi.mock('../copies-rule', () => ({ copiesRuleForScreen: async () => net.rule }));
vi.mock('../vault-config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../vault-config')>()),
    hasVault: () => net.vault,
}));
// The vault's side is another test's (community-recovery.test.ts): here nothing may reach it, a fake or the real one.
vi.mock('../community-recovery', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../community-recovery')>()),
    sharedCopySide: async () => 'none',
    turnOnSharedCopy: async () => { net.sharedTurnOns++; return { since: '2026-11-01T00:00:00.000Z' }; },
}));

/** The community's server, as far as a request can tell: every signed POST it is sent, and what it answers. */
const STATUS = '/api/recovery/community-copy/status';
const COPY = '/api/recovery/community-copy';
const net = vi.hoisted(() => ({
    rule: 'vault' as string | null,
    vault: true,
    sent: [] as { path: string; body: any }[],
    sharedTurnOns: 0,
    status: (() => { throw new Error('unset'); }) as () => Promise<Response>,
}));
vi.mock('../node-post', () => ({
    anchorUrl: async () => 'https://mullum.beanpool.org',
    signedDelete: async () => { throw new Error('no delete in this test'); },
    signedPost: async (_url: string, path: string, body: unknown) => {
        net.sent.push({ path, body });
        if (path === STATUS) return net.status();
        return new Response(JSON.stringify({ kept: true, since: '2026-11-01T00:00:00.000Z' }), { status: 200 });
    },
}));

import { CommunityAdminsRow } from '../../components/CommunityAdminsRow';

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
const OFFERED = { kept: false, since: null, offered: true, sharedOffered: false, nodeKey: 'ab'.repeat(32) };
const KEY_VAULT_RULE = { kept: false, since: null, offered: false, sharedOffered: true, nodeKey: 'ab'.repeat(32) };

/** Every way a status read can come to nothing. */
const FAILURES: [string, () => Promise<Response>][] = [
    ['the network fails', async () => { throw new Error('offline'); }],
    ['a server from before answers 404', async () => new Response('', { status: 404 })],
    ['the server fails', async () => new Response('{"error":"no"}', { status: 500 })],
    ['a proxy answers with its own page', async () => new Response('<html>Welcome to the cafe wifi</html>', { status: 200 })],
];

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    store.clear();
    net.rule = 'vault';
    net.vault = true;
    net.sent.length = 0;
    net.sharedTurnOns = 0;
    // Everything goes through the faked request above: anything that reached for the network itself would fail here.
    vi.stubGlobal('fetch', () => { throw new Error('no network in this test'); });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(CommunityAdminsRow, {}) as any); });
    await settle();
}
const turnOn = () => host!.querySelector('[data-testid="community-admins-turn-on"]') as HTMLElement | null;
const keyLeft = () => net.sent.filter(s => s.path === COPY || 'copyKey' in (s.body ?? {}));

describe('the copy and its whole key leave the phone only on the server\'s own word', () => {
    it('the control: where the server says it keeps whole copies, the tap sends the copy and its key, once', async () => {
        net.rule = 'server';
        net.status = ok(OFFERED);
        await mount();
        await act(async () => { turnOn()!.click(); });
        await settle();
        expect(keyLeft()).toHaveLength(1);
        expect(keyLeft()[0].path).toBe(COPY);
        expect(Object.keys(keyLeft()[0].body).sort()).toEqual(['copy', 'copyKey']);
    });

    for (const rule of ['vault', 'server']) {
        it(`under the rule "${rule}", the status still out: nothing to tap, and nothing sent`, async () => {
            net.rule = rule;
            net.status = () => new Promise(() => {});
            await mount();
            expect(net.sent.map(s => s.path)).toEqual([STATUS]);
            expect(turnOn()).toBeNull();
            expect(keyLeft()).toEqual([]);
        });
    }

    for (const [how, fails] of FAILURES) {
        it(`under the key vault's rule, when ${how}: nothing to tap, and nothing sent`, async () => {
            net.status = fails;
            await mount();
            expect(net.sent.map(s => s.path)).toEqual([STATUS]);
            expect(turnOn()).toBeNull();
            expect(keyLeft()).toEqual([]);
        });

        it(`where the phone read "this server", when ${how}: the tap asks first, says so, and nothing is sent`, async () => {
            net.rule = 'server';
            net.status = fails;
            await mount();
            await act(async () => { turnOn()!.click(); });
            await settle();
            expect(net.sent.filter(s => s.path === STATUS).length, 'asked again at the tap').toBeGreaterThan(1);
            expect(keyLeft()).toEqual([]);
            expect(host!.textContent).toContain('Couldn’t reach your community, so nothing changed.');
        });
    }

    for (const vault of [true, false]) {
        const then = vault ? 'the shared path is taken' : 'nothing is sent, in a build with no vault';
        it(`where the phone read "this server" and the server, asked at the tap, is on the key vault's rule: the key stays on the phone, and ${then}`, async () => {
            net.rule = 'server';
            net.vault = vault;
            net.status = async () => { throw new Error('offline'); };
            await mount();
            net.status = ok(KEY_VAULT_RULE);
            await act(async () => { turnOn()!.click(); });
            await settle();
            expect(keyLeft()).toEqual([]);
            expect(net.sharedTurnOns).toBe(vault ? 1 : 0);
        });

        it(`the row showed an offer, and the rule moved while the screen stayed open: the key stays on the phone, and ${then}`, async () => {
            net.rule = 'server';
            net.vault = vault;
            net.status = ok(OFFERED);
            await mount();
            expect(turnOn()).toBeTruthy();
            net.status = ok(KEY_VAULT_RULE);
            await act(async () => { turnOn()!.click(); });
            await settle();
            expect(keyLeft()).toEqual([]);
            expect(net.sharedTurnOns).toBe(vault ? 1 : 0);
        });
    }
});
