// @vitest-environment jsdom
/**
 * Which openers of the sign-in sheet may put the member's list of communities in the copy (vault rethink VR5; #2660
 * deciding review, finding 1). The copy carries the list only when the member saw the tick in that flow and left it on:
 * Account Protection's Protect with and Connect again (components/KeeperProtectionPanel.tsx). Settings' move card
 * (components/VaultMoveCard.tsx: Move it, Link it, and the reverse move to the community) and welcome's claim-flow Add a
 * sign-in draw no tick, so their copies carry none, even with the stored tick on (absent = on) and communities saved.
 *
 * Rendered for real: the move card, the panel and the sheet. The sheet's connect is the real deposit at the key vault
 * (utils/keeper-enrolment.ts) after a stand-in provider sign-in; fake-vault.ts opens what reached it, with core's real
 * deposit boxes, and the test opens the sealed copy with the sign-in: a list is in it, or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress({ stopPropagation() {}, nativeEvent: {} });
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (accessibilityState && 'checked' in accessibilityState) attrs['aria-checked'] = String(accessibilityState.checked);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        AppState: { currentState: 'active', addEventListener: listener },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
    };
});
vi.mock('expo-router', async () => {
    const React = await import('react');
    return { useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(() => cb(), [cb]), useIsFocused: () => true, router: { push() {} } };
});
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove() {} }), openURL: async () => undefined }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: async () => ({ type: 'cancel' }), openBrowserAsync: async () => ({}), dismissAuthSession() {}, dismissBrowser: async () => undefined }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: async () => false, signInAsync: async () => ({}), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), digest: async () => new ArrayBuffer(32) };
});
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/', EncodingType: { UTF8: 'utf8' }, writeAsStringAsync: async () => {}, deleteAsync: async () => {} }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => mem.async.get(k) ?? null,
        setItem: async (k: string, v: string) => { mem.async.set(k, v); },
        removeItem: async (k: string) => { mem.async.delete(k); },
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: async (k: string) => mem.secure.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => { mem.secure.set(k, v); },
    deleteItemAsync: async (k: string) => { mem.secure.delete(k); },
}));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: true }),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { theme: 'light', colors: lightColors };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx), useOnboardingColors: () => onboardingColors('light') };
});
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity, setIdentity() {} }) }));
vi.mock('../../components/SsoButton', () => {
    const button = (name: string) => ({ title, onPress }: { title?: string; onPress: () => void }) => createElement('button', { 'aria-label': title, 'data-sso': name, onClick: onPress }, title);
    return { GoogleButton: button('google'), AppleButton: button('apple'), FacebookButton: button('facebook') };
});
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return { ...real, returnToApp: async () => {} };
});
vi.mock('../node-post', async (importOriginal) => {
    const real = await importOriginal<typeof import('../node-post')>();
    return { ...real, anchorUrl: async () => 'https://mullum.beanpool.org' };
});
/** The sheet's connect: what the sheet handed it, then the real deposit at the key vault after a stand-in sign-in. */
const sheet = vi.hoisted(() => ({ handed: [] as Array<Record<string, any>>, subs: 0 }));
vi.mock('../sso-sheet-connect', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-sheet-connect')>();
    const { enrolSsoKeeper } = await import('../keeper-enrolment');
    const { vaultTicket } = await import('../vault');
    const { fakeJwt } = await import('./fake-vault');
    return {
        ...real,
        connectAndDeposit: async (options: Record<string, any>) => {
            sheet.handed.push(options);
            const sub = `google-sub-${++sheet.subs}`;
            const grant = await vaultTicket(options.identity, 'deposit', 'google');
            return enrolSsoKeeper({
                identity: options.identity, provider: 'google', sub, ticket: grant.ticket,
                idToken: fakeJwt({ sub, nonce: grant.nonce }), communities: options.communities,
            });
        },
    };
});
const move = vi.hoisted(() => ({ offer: null as any }));
vi.mock('../vault-move', async (importOriginal) => {
    const real = await importOriginal<typeof import('../vault-move')>();
    return { ...real, vaultMoveOffer: async () => move.offer, finishMove: async () => 'done', moveLater: async () => {}, removeInstead: async () => true };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { openSeedFromSso } from '@beanpool/core';
import { VaultMoveCard } from '../../components/VaultMoveCard';
import { KeeperProtectionPanel } from '../../components/KeeperProtectionPanel';
import { SsoEnrolSheet } from '../../components/SsoEnrolSheet';
import { lightColors } from '../../constants/colors';
import { SAVED_NODES_STORE_KEY, copyListsCommunitiesStoreKey } from '../storage-keys';
import { installNetwork, noVault, useVault, type Network } from './fake-vault';

// Test key and phrase only (a BIP-39 vector), never a real account's. A real key pair: the vault checks every signature.
const SEED = new Uint8Array(32).fill(7);
const ID = {
    callsign: 'Alice',
    publicKey: Buffer.from(ed25519.getPublicKey(SEED)).toString('hex'),
    privateKey: '07'.repeat(32),
    createdAt: '2026-10-31T00:00:00.000Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;
const SAVED = [
    { url: 'https://castlemaine.beanpool.org', alias: 'Castlemaine' },
    { url: 'https://mullum.beanpool.org', alias: 'Mullumbimby' },
];

let net: Network;
let host: HTMLDivElement;
let root: Root;
const originalFetch = globalThis.fetch;

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    // Communities saved, and the stored tick never touched (absent = on): the case the review found.
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(SAVED));
    // The phone is on Mullumbimby: a list puts it first.
    mem.async.set('beanpool_anchor_url', 'https://mullum.beanpool.org');
    sheet.handed = [];
    who.identity = ID;
    move.offer = null;
    useVault();
    net = installNetwork();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    noVault();
    vi.restoreAllMocks();
});

async function draw(node: unknown): Promise<void> {
    await act(async () => { root.render(node as any); });
    await settle();
}
/** Let the sheet's connect run to the vault and back. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}
const tap = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)!;

/** The copy the vault keeps, opened with the sign-in that made it: the list in it, or undefined. */
async function sealedList(): Promise<{ keys: string[]; communities: unknown; status: string }> {
    const copies = [...net.vault.copies.values()];
    expect(copies.length).toBeGreaterThan(0);
    const copy = copies.at(-1)!.clientCopy;
    const opened = await openSeedFromSso(copy, 'google', `google-sub-${sheet.subs}`);
    expect(Buffer.from(ed25519.getPublicKey(opened.seed)).toString('hex')).toBe(ID.publicKey);
    return { keys: Object.keys(JSON.parse(copy.kdfParams)), communities: opened.communities, status: opened.communitiesStatus };
}

describe("Settings' move card draws no tick: its copy carries no list (#2660 finding 1)", () => {
    for (const [kind, label, copiesAt] of [['move', 'Move it', 'vault'], ['retry', 'Link it', 'vault'], ['keep-here', 'Move it', 'community']] as const) {
        it(`${kind} (${label}): the sheet is handed no list, and the sealed copy holds none`, async () => {
            move.offer = kind === 'retry' ? { kind, provider: 'google' } : { kind, provider: 'google', communityUrl: 'https://mullum.beanpool.org' };
            await draw(createElement(VaultMoveCard, {}));
            expect(host.querySelector('[data-testid="copy-communities-tick"]')).toBeNull();
            await tap(button(label));
            expect(sheet.handed).toHaveLength(1);
            expect(sheet.handed[0].communities ?? null).toBeNull();
            expect(sheet.handed[0].shownAt).toBe(copiesAt);
            // The stand-in deposit keeps every copy at the test vault, a reverse move's too: opened, no list in it.
            const { keys, communities, status } = await sealedList();
            expect(keys).not.toContain('communities');
            expect(communities).toBeNull();
            expect(status).toBe('absent');
        });
    }
});

describe("welcome's claim-flow Add a sign-in draws no tick: its copy carries no list", () => {
    it('the sheet as that button opens it (copyAt community, listCommunities off) hands no list', async () => {
        await draw(createElement(SsoEnrolSheet, {
            visible: true, provider: 'google', identity: ID, askPhoneLock: false, copyAt: 'community', copiesAt: 'community',
            listCommunities: false, onClose() {}, onEnrolled() {},
        }));
        expect(sheet.handed).toHaveLength(1);
        expect(sheet.handed[0].communities ?? null).toBeNull();
    });

    it('a sheet opened with no say at all (any other opener) hands no list either', async () => {
        await draw(createElement(SsoEnrolSheet, { visible: true, provider: 'google', identity: ID, askPhoneLock: false, onClose() {}, onEnrolled() {} }));
        expect(sheet.handed[0].communities ?? null).toBeNull();
        const { keys, communities } = await sealedList();
        expect(keys).not.toContain('communities');
        expect(communities).toBeNull();
    });

    it('app/welcome.tsx: Add a sign-in turns the list off before it opens the sheet; the sheet takes the screen\'s choice', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        expect(src).toMatch(/if \(joinFlow !== 'claim'\) return setShowLinkSheet\(true\);\s*\/\/[^\n]*\n\s*setSsoListCommunities\(false\);\s*setShowSsoSheet\(true\);/);
        expect(src).toMatch(/copiesAt=\{backupCopiesAt\}\s*listCommunities=\{ssoListCommunities\}/);
        expect(src).toMatch(/onProtectSso=\{Platform\.OS !== 'web' \? \(prov, listCommunities\) => \{\s*if \(prov\) setSsoProvider\(prov\);\s*setSsoListCommunities\(listCommunities\);/);
        const settings = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf8');
        expect(settings).toMatch(/setSsoListCommunities\(listCommunities\);/);
        expect(settings).toMatch(/copiesAt=\{copiesAt\}\s*listCommunities=\{ssoListCommunities\}/);
        // Each screen keeps what its panel's tick shows, for the panel to hand back with Protect with.
        for (const screen of [src, settings]) expect(screen).toMatch(/listShown=\{listTickShown\}\s*onListShown=\{setListTickShown\}/);
        // The move card passes none: its sheet keeps the default, off.
        const card = fs.readFileSync(path.resolve(__dirname, '../../components/VaultMoveCard.tsx'), 'utf8');
        expect(card).not.toMatch(/listCommunities=/);
    });
});

describe("Account Protection's tick: the list rides only with the tick on screen and on", () => {
    const COVERED = { state: 'covered', holding: ['Google'], enrolledSso: ['google'] } as any;
    const NONE = { state: 'none', holding: [], enrolledSso: [] } as any;

    /** The panel inside a screen that keeps what its tick shows, as settings.tsx and welcome.tsx do. */
    async function panel(protection: any, hasWords: boolean, listCommunitiesFor?: string) {
        const calls: Array<[string, boolean]> = [];
        function Screen() {
            const [listShown, setListShown] = ReactAll.useState(false);
            return createElement(KeeperProtectionPanel, {
                colors: lightColors, protection, hasWords, waysBack: true,
                onProtectSso: (prov: string, list: boolean) => { calls.push([prov, list]); },
                onDisconnectSso() {}, listCommunitiesFor, listShown, onListShown: setListShown,
            } as any);
        }
        await draw(createElement(Screen));
        return calls;
    }

    it('Protect with hands the tick as shown: on (never touched), then off once unticked', async () => {
        const calls = await panel(NONE, true, ID.publicKey);
        const tick = host.querySelector('[data-testid="copy-communities-tick"]')!;
        expect(tick.getAttribute('aria-checked')).toBe('true');
        await tap(host.querySelector('[data-sso="google"]')!);
        await tap(tick);
        expect(tick.getAttribute('aria-checked')).toBe('false');
        expect(mem.async.get(copyListsCommunitiesStoreKey(ID.publicKey))).toBe('0');
        await tap(host.querySelector('[data-sso="google"]')!);
        expect(calls).toEqual([['google', true], ['google', false]]);
    });

    it('a panel drawn without the tick hands no list', async () => {
        const calls = await panel(NONE, true);
        expect(host.querySelector('[data-testid="copy-communities-tick"]')).toBeNull();
        await tap(host.querySelector('[data-sso="google"]')!);
        expect(calls).toEqual([['google', false]]);
    });

    it('the sheet opened from it with the tick on seals the list in the copy', async () => {
        await draw(createElement(SsoEnrolSheet, {
            visible: true, provider: 'google', identity: ID, askPhoneLock: false, listCommunities: true, onClose() {}, onEnrolled() {},
        }));
        const { keys, communities } = await sealedList();
        expect(keys).toContain('communities');
        expect((communities as Array<{ url: string }>).map((c) => c.url)).toEqual(['https://mullum.beanpool.org', 'https://castlemaine.beanpool.org']);
    });

    // #2660 finding 2: under a sign-in already connected, the tick says it is for the next copy, not the one kept.
    it('under a connected sign-in, with the 12 words: the tick applies to the next copy (Protect with, or Connect again)', async () => {
        const calls = await panel(COVERED, true, ID.publicKey);
        expect(host.querySelector('[data-testid="copy-communities-applies"]')!.textContent)
            .toBe('This applies to the next copy made: Protect with, or Connect again. A copy already kept stays as it was until then.');
        await tap(button('Connect again'));
        expect(calls).toEqual([['google', true]]);
    });

    it('under a connected sign-in, without the 12 words (no Connect again): only to a sign-in connected from now on', async () => {
        await panel(COVERED, false, ID.publicKey);
        expect(button('Connect again')).toBeUndefined();
        expect(host.querySelector('[data-testid="copy-communities-applies"]')!.textContent)
            .toBe('This applies to a sign-in you connect from now on. A copy already kept stays as it was.');
    });

    it('with nothing connected yet, the tick is about the copy about to be made: no extra line', async () => {
        await panel(NONE, false, ID.publicKey);
        expect(host.querySelector('[data-testid="copy-communities-tick"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="copy-communities-applies"]')).toBeNull();
    });
});
