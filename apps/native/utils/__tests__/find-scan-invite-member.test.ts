// @vitest-environment jsdom
/**
 * Find a community's Scan a code, when the code is an invite (app/find-community.tsx, utils/scanned-invite.ts). From PR #2604's
 * deciding review (r4413833915): on a phone in a community, a scanned invite pushed welcome, and the root guard's
 * memberRedirect replaced welcome with the tabs before its invite step was used. No "Switch Nodes?", no join, nothing said.
 *
 *   - a phone in a community: the invite is handed, as scanned, to the root layout's invite-link handling, the one an
 *     invite opened as a link gets: it is read there as an invite for its own community, so another community's is
 *     "Switch Nodes?". Welcome is never pushed;
 *   - with no account, and on a phone waiting to be let in: the first screen's invite step, as before (welcome is a root
 *     those phones stay on);
 *   - an invite handed over before the root layout listens waits for it, and is taken once;
 *   - app/_layout.tsx reads a handed invite through the same state an opened link sets.
 *
 * Rendered for real as find-community-no-account-render.test.ts renders it: react-dom in jsdom, React Native's host
 * components as plain tags, the screen's network and storage stubbed at their modules, the camera's screen stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText, placeholder } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        Linking: { openURL: vi.fn(async () => undefined) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
const nav = vi.hoisted(() => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => ({}), ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn(async () => undefined) }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied', canAskAgain: false })),
    getLastKnownPositionAsync: vi.fn(async () => null),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
    getCurrentPositionAsync: vi.fn(async () => null),
    Accuracy: { Balanced: 3 },
}));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
    },
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: 'light', colors: lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
const who = vi.hoisted(() => ({ identity: null as any, setIdentity: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../community-directory', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    fetchCommunities: vi.fn(async () => ({ ok: true, value: { communities: [], total: 0, fetchedAt: '2026-10-31T00:00:00.000Z' } })),
    fetchGlobalHome: vi.fn(async () => ({ ok: true, value: { watches: [] } })),
    watchPlace: vi.fn(), unwatchPlace: vi.fn(),
}));
vi.mock('../knock', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    sendKnock: vi.fn(),
    readKnockStatus: vi.fn(async () => ({ ok: true, value: { status: 'pending' } })),
}));
vi.mock('../knock-key', () => ({ knockKeyForThisPhone: vi.fn(), commitKnockKey: vi.fn() }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: vi.fn(), joinedNudge: vi.fn(), PROTECT_REDIRECT: '/x', HOME_REDIRECT: '/y' }));
vi.mock('../typed-place', () => ({
    readTypedPlace: vi.fn(async () => null), saveTypedPlace: vi.fn(), forgetTypedPlace: vi.fn(async () => undefined),
    nearLine: () => '', LOCATION_NOTES: { off: 'off', failed: 'failed' },
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => 'bundled://fox') }));
vi.mock('../node-claim', () => ({ readClaimStatus: vi.fn(async () => ({ kind: 'claimed' })) }));
vi.mock('../notification-permission', () => ({ askNotificationPermissionOnAction: vi.fn(async () => 'unanswered') }));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));
// The camera's screen, stood in for: it draws, and what it reads is given to the screen's onRead.
const camera = vi.hoisted(() => ({ onRead: null as null | ((data: string) => boolean) }));
vi.mock('../../components/ScanCodeModal', async () => {
    const { createElement: h } = await import('react');
    return { default: ({ onRead }: { onRead(data: string): boolean }) => { camera.onRead = onRead; return h('div', { 'data-testid': 'camera' }); } };
});

import FindCommunityScreen from '../../app/find-community';
import { handScannedInvite, listenForScannedInvites, scannedInviteGoesToRoot } from '../scanned-invite';
import { extractInviteToken, deepLinkNodeOrigin } from '../invite-parser';
import { isAuthReturnLink } from '../auth-return';
import { isUnlockLink } from '../takeover-unlock';
import { isPairLink } from '../pair-link';
import { isGlobalLink } from '../global-link';
import { doorLinkFromSystemPath } from '../open-door';
import { isCommunityCardPath } from '../community-card-link';
import { isPeekPath } from '../peek-link';
import { parseRekeyLink } from '../rekey-redeem';

const MULLUM = 'https://mullum.example.org';
const RIVERSIDE = 'https://riverside.example.org';
/** An invite's QR, as People → Invite draws it (`${anchorUrl}/?invite=${code}`): another community's. */
const RIVERSIDE_INVITE = `${RIVERSIDE}/?invite=INV-ABCD-EFGH`;
const MEMBER = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kai', createdAt: '2026-10-01T00:00:00.000Z' };

let host: HTMLDivElement;
let root: Root;
let handed: string[];
let stopListening: () => void;
beforeEach(() => {
    store.clear();
    who.identity = null;
    camera.onRead = null;
    nav.router.push.mockClear();
    nav.router.replace.mockClear();
    handed = [];
    // The root layout, listening as app/_layout.tsx does.
    stopListening = listenForScannedInvites(link => { handed.push(link); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { stopListening(); act(() => root.unmount()); host.remove(); });

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function render() {
    await act(async () => { root.render(createElement(FindCommunityScreen as any) as any); });
    await settle();
}

/** Scan a code, then the camera reads `data`. Returns what the screen told the camera. */
async function scan(data: string): Promise<boolean> {
    await act(async () => { byId('find-scan')!.click(); });
    await settle();
    expect(byId('camera')).not.toBeNull();
    let used = false;
    await act(async () => { used = camera.onRead!(data); });
    await settle();
    return used;
}

const welcomePushes = () => nav.router.push.mock.calls.filter(([to]) => (typeof to === 'string' ? to : to?.pathname) === '/welcome');

describe("Find's Scan a code, an invite, on a phone in a community", () => {
    it('hands the invite, as scanned, to the root layout\'s invite-link handling: the camera closes and welcome is never pushed', async () => {
        who.identity = MEMBER;
        store.set('beanpool_anchor_url', MULLUM);
        await render();
        expect(await scan(RIVERSIDE_INVITE)).toBe(true);
        expect(byId('camera')).toBeNull();
        expect(handed).toEqual([RIVERSIDE_INVITE]);
        expect(welcomePushes()).toEqual([]);
        expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('lands where the opened link lands: the root layout reads it as an invite for its own community, so another\'s is "Switch Nodes?"', () => {
        // app/_layout.tsx's reading of a link, in its order: none of the links that are not invites claims it ...
        expect(isAuthReturnLink(RIVERSIDE_INVITE)).toBe(false);
        expect(isUnlockLink(RIVERSIDE_INVITE)).toBe(false);
        expect(isPairLink(RIVERSIDE_INVITE)).toBe(false);
        expect(isGlobalLink(RIVERSIDE_INVITE)).toBe(false);
        expect(doorLinkFromSystemPath(RIVERSIDE_INVITE)).toBeNull();
        expect(isCommunityCardPath(RIVERSIDE_INVITE)).toBe(false);
        expect(isPeekPath(RIVERSIDE_INVITE)).toBe(false);
        expect(parseRekeyLink(RIVERSIDE_INVITE)?.community ?? null).toBeNull();
        // ... its invite is read, for the community it names, not the one in use: "Switch Nodes?" (current !== targetOrigin).
        expect(extractInviteToken(RIVERSIDE_INVITE)).toBe('INV-ABCD-EFGH');
        expect(deepLinkNodeOrigin(RIVERSIDE_INVITE, () => undefined)).toBe(RIVERSIDE);
        expect(RIVERSIDE).not.toBe(MULLUM);
    });

    it('an invite for the community in use goes the same way: the root layout asks how to go on there', async () => {
        who.identity = MEMBER;
        store.set('beanpool_anchor_url', MULLUM);
        await render();
        const own = `${MULLUM}/?invite=INV-WXYZ-1234`;
        expect(await scan(own)).toBe(true);
        expect(handed).toEqual([own]);
        expect(deepLinkNodeOrigin(own, () => undefined)).toBe(MULLUM);
        expect(welcomePushes()).toEqual([]);
    });

    it('a community\'s code still fills the address box, and is handed nowhere', async () => {
        who.identity = MEMBER;
        store.set('beanpool_anchor_url', MULLUM);
        await render();
        expect(await scan(RIVERSIDE)).toBe(true);
        expect((byId('find-address') as HTMLInputElement).value).toBe('riverside.example.org');
        expect(handed).toEqual([]);
        expect(welcomePushes()).toEqual([]);
    });
});

describe("Find's Scan a code, an invite, on a phone in no community: the first screen's invite step, as before", () => {
    it('with no account', async () => {
        await render();
        expect(await scan(RIVERSIDE_INVITE)).toBe(true);
        expect(welcomePushes()).toEqual([[{ pathname: '/welcome', params: { invite: RIVERSIDE_INVITE } }]]);
        expect(handed).toEqual([]);
    });

    it('waiting to be let in (an account, no community in use)', async () => {
        who.identity = MEMBER;
        await render();
        expect(await scan(RIVERSIDE_INVITE)).toBe(true);
        expect(welcomePushes()).toEqual([[{ pathname: '/welcome', params: { invite: RIVERSIDE_INVITE } }]]);
        expect(handed).toEqual([]);
    });
});

describe('utils/scanned-invite.ts', () => {
    it('goes to the root layout only for an account in a community', () => {
        expect(scannedInviteGoesToRoot({ hasIdentity: true, anchorUrl: MULLUM })).toBe(true);
        expect(scannedInviteGoesToRoot({ hasIdentity: true, anchorUrl: null })).toBe(false);
        expect(scannedInviteGoesToRoot({ hasIdentity: true, anchorUrl: '  ' })).toBe(false);
        expect(scannedInviteGoesToRoot({ hasIdentity: false, anchorUrl: MULLUM })).toBe(false);
    });

    it('one handed over before the root layout listens waits for it, and is taken once', () => {
        stopListening();
        handScannedInvite(`  ${RIVERSIDE_INVITE}  `);
        const first: string[] = [];
        const stopFirst = listenForScannedInvites(l => { first.push(l); });
        expect(first).toEqual([RIVERSIDE_INVITE]);
        stopFirst();
        const again: string[] = [];
        stopListening = listenForScannedInvites(l => { again.push(l); });
        expect(again).toEqual([]);
        handScannedInvite('');
        expect(again).toEqual([]);
    });
});

describe('app/_layout.tsx', () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it('reads a handed invite through the state an opened link sets, so the same handling reads it', () => {
        const src = layout();
        expect(src).toMatch(/Linking\.addEventListener\('url', \(\{ url \}\) => \{[\s\S]*?setDeepLinkUrl\(url\);/);
        expect(src).toMatch(/useEffect\(\(\) => listenForScannedInvites\(url => setDeepLinkUrl\(url\)\), \[\]\);/);
    });
});
