// @vitest-environment jsdom
/**
 * "Cancel my request" (front doors S1, the guide's finding-a-community page), on the two screens where the asker sees a
 * request waiting: the worldwide community's People (components/MyJoinRequests.tsx) and Find a community
 * (app/find-community.tsx). Pressed, it asks first; confirmed, it is a signed POST to the community's
 * /api/join/knock/cancel, and the request stops showing as waiting.
 *
 * Rendered for real, as find-community-words-render.test.ts does: react-dom in jsdom, React Native's host components as
 * plain tags. The knock code is the app's own (utils/knock.ts), its storage a map and the community a `fetch` stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as Array<{ title: string; body?: string; buttons?: Array<{ text: string; style?: string; onPress?: () => unknown }> }> }));
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: (title: string, body?: string, buttons?: any[]) => { alerts.said.push({ title, body, buttons }); } },
        Linking: { openURL: vi.fn(async () => undefined) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-crypto', () => ({ getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) }));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: true })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
const COMMUNITY = 'https://mullum.example.org';
vi.mock('../community-directory', async (importOriginal) => {
    const real = await importOriginal<typeof import('../community-directory')>();
    const mullum = { key: 'mullum', name: 'Mullumbimby', url: 'https://mullum.example.org', lat: null, lng: null, radiusKm: null, memberCount: 12, contactEmail: null, contactPhone: null, distanceKm: 3 };
    return {
        ...real,
        fetchCommunities: vi.fn(async () => ({ ok: true, value: { communities: [mullum], total: 1, fetchedAt: '2026-10-27T08:00:00.000Z' } })),
        fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
        watchPlace: vi.fn(), unwatchPlace: vi.fn(),
    };
});
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => ({ lat: -28.65, lng: 153.6, name: 'Mullumbimby' })), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));

import { getPublicKey } from '@noble/ed25519';
import { bytesToHex } from '../crypto';
import { rememberKnock, rememberedKnocks, cancelledKnocks, KNOCK_MESSAGES } from '../knock';
import { MyJoinRequests } from '../../components/MyJoinRequests';
import FindCommunityScreen from '../../app/find-community';

interface Sent { url: string; method: string }
let sent: Sent[] = [];
/** The community: its answer to a status read, and whether a cancel finds anything open. */
let open = true;

beforeEach(async () => {
    document.body.innerHTML = '';
    mem.clear();
    alerts.said = [];
    sent = [];
    open = true;
    const seed = new Uint8Array(randomBytes(32));
    who.identity = { publicKey: bytesToHex(await getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: 'Robin' };
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
        sent.push({ url, method: init?.method ?? 'GET' });
        const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
        if (url === `${COMMUNITY}/api/join/knock/status`) return json(200, { status: open ? 'pending' : 'none' });
        if (url === `${COMMUNITY}/api/join/knock/cancel`) {
            if (!open) return json(404, { error: 'There’s no open request to join to cancel.', code: 'not_found' });
            open = false;
            return json(200, { knock: { status: 'cancelled' } });
        }
        return json(404, {});
    });
    await rememberKnock(who.identity.publicKey, { url: COMMUNITY, name: 'Mullumbimby', key: 'mullum' });
});
afterEach(() => { document.body.innerHTML = ''; });

async function draw(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(node as unknown as Parameters<Root['render']>[0]); });
    for (let i = 0; i < 4; i++) await act(async () => {});
    return host;
}
const byTestId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/** Press the button, then the confirm's "Cancel my request". */
async function cancelVia(button: HTMLElement): Promise<void> {
    await act(async () => { button.click(); });
    const ask = alerts.said.at(-1)!;
    expect(ask.title).toBe('Cancel your request to join Mullumbimby?');
    expect(ask.body).toBe('You can ask again after 24 hours.');
    expect(ask.buttons?.map(b => b.text)).toEqual(['Keep it', 'Cancel my request']);
    await act(async () => { await ask.buttons![1].onPress!(); });
    for (let i = 0; i < 3; i++) await act(async () => {});
}

describe('"Cancel my request" where the asker sees a request waiting', () => {
    it("on the worldwide community's People: the waiting row has it; confirmed, the request is cancelled and the row goes", async () => {
        const host = await draw(createElement(MyJoinRequests, { identity: who.identity as any }));
        const button = byTestId(host, 'my-requests-cancel');
        expect(button?.textContent).toBe('Cancel my request');
        expect(button?.getAttribute('aria-label')).toBe('Cancel your request to join Mullumbimby');
        // "Keep it" does nothing.
        await act(async () => { button!.click(); });
        expect(sent.filter(s => s.method === 'POST')).toEqual([]);
        await cancelVia(button!);
        expect(sent.filter(s => s.method === 'POST')).toEqual([{ url: `${COMMUNITY}/api/join/knock/cancel`, method: 'POST' }]);
        expect(byTestId(host, 'my-requests-cancel')).toBeNull();
        expect(host.textContent).not.toContain('Mullumbimby');
        expect(await rememberedKnocks(who.identity!.publicKey)).toEqual([]);
    });

    it('on Find a community: the waiting card has it; confirmed, the card says it was cancelled, with nothing to press', async () => {
        const host = await draw(createElement(FindCommunityScreen as any));
        expect(host.textContent).toContain(KNOCK_MESSAGES.waiting);
        const button = byTestId(host, 'find-cancel-request');
        expect(button?.textContent).toBe('Cancel my request');
        await cancelVia(button!);
        expect(sent.filter(s => s.method === 'POST')).toEqual([{ url: `${COMMUNITY}/api/join/knock/cancel`, method: 'POST' }]);
        expect(byTestId(host, 'find-cancel-request')).toBeNull();
        expect(host.textContent).toContain(KNOCK_MESSAGES.cancelled);
        expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Ask to join');
        expect(Object.keys(await cancelledKnocks(who.identity!.publicKey))).toEqual([COMMUNITY]);
    });

    it('nothing open any more (it lapsed, or a member said yes): the community’s words, and the request stays', async () => {
        const host = await draw(createElement(MyJoinRequests, { identity: who.identity as any }));
        open = false;
        await cancelVia(byTestId(host, 'my-requests-cancel')!);
        expect(host.textContent).toContain('There’s no open request to join to cancel.');
        expect((await rememberedKnocks(who.identity!.publicKey)).map(k => k.url)).toEqual([COMMUNITY]);
    });
});
