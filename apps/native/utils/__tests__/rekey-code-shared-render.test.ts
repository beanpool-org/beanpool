// @vitest-environment jsdom
/**
 * A shared bring-back on the re-key screen (app/rekey-code.tsx; vault rethink VR4, DESIGN-vault-rethink-fable.md §4.3 steps 3
 * to 5), rendered for real. The admin has typed the number, so the community's poll answers with its half and its voucher.
 * The screen writes them down and waits out the key vault's day, across the app closing, and when the vault lets go it
 * joins the halves and saves the member's SAME key through the restore gate. Nothing is saved before that.
 *
 * jsdom and react-dom stand in for the phone, as in rekey-code-bring-back-render.test.ts. The screen, the flow
 * (utils/community-recovery.ts, utils/vault.ts), the copy, the halves, the release and the voucher are real, and the vault is
 * the fake vault (fake-vault.ts), which checks real tickets, vouchers and signatures. No node or vault is contacted. Test keys
 * only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
    communityHalfForRelease, joinVaultVoucher, sealReleaseToDevice, sealSeedToCopyKey, splitCopyKey, vaultCommunityRef, vaultCopyDigest,
    vaultVoucherToSign, VAULT_COMMUNITY_PROVIDER,
} from '@beanpool/core';
import type { RekeySlot } from '../rekey-redeem';
import type { BeanPoolIdentity } from '../identity';
import { FakeVault, HOLD_MS, VAULT, noVault, useVault, type SentRequest } from './fake-vault';

type AlertButton = { text?: string; style?: string; onPress?: () => void | Promise<void> };

const fake = vi.hoisted(() => ({
    slot: null as RekeySlot | null,
    phone: null as BeanPoolIdentity | null,
    imported: [] as string[],
    appIdentity: [] as Array<BeanPoolIdentity | null>,
    alerts: [] as Array<{ title: string; message?: string; buttons?: AlertButton[] }>,
    secure: new Map<string, string>(),
    async: new Map<string, string>(),
}));

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    type P = { children?: ReactNode; testID?: string };
    return {
        Platform: { OS: 'android' },
        StyleSheet: { create: <T,>(s: T) => s, absoluteFillObject: {} },
        View: ({ children, testID }: P) => h('div', { 'data-testid': testID }, children),
        Text: ({ children, testID }: P) => h('span', { 'data-testid': testID }, children),
        Pressable: ({ children, onPress, disabled }: P & { onPress?: () => void; disabled?: boolean }) => h('button', { onClick: onPress, disabled }, children),
        TextInput: ({ value, onChangeText, accessibilityLabel }: { value?: string; onChangeText?: (t: string) => void; accessibilityLabel?: string }) =>
            h('input', { value, 'aria-label': accessibilityLabel, onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value) }),
        ActivityIndicator: () => h('span', null, '…'),
        Modal: ({ visible, children }: P & { visible?: boolean }) => (visible ? h('section', null, children) : null),
        Alert: { alert: (title: string, message?: string, buttons?: AlertButton[]) => { fake.alerts.push({ title, message, buttons }); } },
    };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    return { KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('expo-router', () => ({ router: { back: () => {}, replace: () => {} }, useLocalSearchParams: () => ({}) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: async (key: string) => fake.secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { fake.secure.set(key, value); },
    deleteItemAsync: async (key: string) => { fake.secure.delete(key); },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)) };
});
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        setItem: async (k: string, v: string) => { fake.async.set(k, v); },
        getItem: async (k: string) => fake.async.get(k) ?? null,
        removeItem: async (k: string) => { fake.async.delete(k); },
    },
}));
vi.mock('../../app/ThemeContext', () => {
    const any: unknown = new Proxy({}, { get: () => any });
    return { useTheme: () => ({ colors: any, theme: 'light' }), useStyles: () => any };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ setIdentity: (i: BeanPoolIdentity | null) => { fake.appIdentity.push(i); } }) }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../identity', () => ({
    StoredKeyUnreadableError: class StoredKeyUnreadableError extends Error {},
    loadIdentity: async () => fake.phone,
    readStoredIdentity: async () => fake.phone,
    draftIdentity: async () => { throw new Error('a phone with an account asks with its own key'); },
    importIdentity: async (i: BeanPoolIdentity) => { fake.imported.push(i.publicKey); fake.phone = i; },
    removeStoredIdentity: async () => { fake.phone = null; },
    wipeIdentityScopedStorage: async () => {},
    getMnemonic: async (i: BeanPoolIdentity) => i.mnemonic,
}));
vi.mock('../account-leaves-phone', () => ({ releaseAccountFromPhone: async () => {}, communitiesOnThisPhone: async () => [], forgetCommunities: async () => {} }));
vi.mock('../onboarding-state', () => ({ clearPendingOnboarding: async () => {} }));
vi.mock('../nodes', () => ({ addSavedNode: async () => {} }));
vi.mock('../member-statements', () => ({ signReEnrollStatement: async () => ({ signature: 'sig', signedFor: 'x' }) }));
vi.mock('../rekey-slot-store', () => ({
    rekeySlotStore: {
        get: async () => (fake.slot ? JSON.parse(JSON.stringify(fake.slot)) : null),
        set: async (s: RekeySlot) => { fake.slot = JSON.parse(JSON.stringify(s)); },
        clear: async () => { fake.slot = null; },
    },
}));

import RekeyCodeScreen from '../../app/rekey-code';
import { loadPendingCommunityRestore } from '../community-recovery';

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const MEMBER_SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const MEMBER_KEY = bytesToHex(ed25519.getPublicKey(MEMBER_SEED));
const NODE_SEED = new Uint8Array(32).fill(0x33);
const NODE_KEY = bytesToHex(ed25519.getPublicKey(NODE_SEED));
const keyOf = (seed: Uint8Array, callsign: string): BeanPoolIdentity => ({
    publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign, createdAt: '2026-10-30T00:00:00.000Z',
});
const PHONE_ACCOUNT = keyOf(new Uint8Array(32).fill(3), 'Robin');
const MULLUM = 'https://mullum.example.org';
const CODE = 'BB-AB12-CD34';

let vault: FakeVault;
let toNode: string[];
let answer: unknown;
let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? '';
async function until(done: () => boolean) {
    for (let i = 0; i < 200 && !done(); i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(done(), text()).toBe(true);
}
async function open() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(RekeyCodeScreen) as Parameters<Root['render']>[0]); });
}
async function close() {
    await act(async () => { root.unmount(); });
    container.remove();
}
const hold = () => [...vault.holds.values()][0];

beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useVault();
    fake.secure.clear();
    fake.async.clear();
    fake.phone = PHONE_ACCOUNT;
    fake.imported = [];
    fake.appIdentity = [];
    fake.alerts = [];
    fake.slot = { community: MULLUM, code: CODE, publicKey: PHONE_ACCOUNT.publicKey, madeHere: false, startedAt: Date.now() - 60_000, shown: true };

    // The member's copy, as turning it on made it: the vault keeps the copy and one half, the community the other.
    vault = new FakeVault();
    const { copy, copyKey } = sealSeedToCopyKey(MEMBER_SEED, { words: WORDS });
    const { vaultHalf, nodeHalf } = splitCopyKey(copyKey);
    const digest = vaultCopyDigest(copy);
    vault.copies.set(`${VAULT_COMMUNITY_PROVIDER}:${NODE_KEY}:${MEMBER_KEY}`, {
        provider: VAULT_COMMUNITY_PROVIDER, sub: `${NODE_KEY}:${MEMBER_KEY}`, pubkey: MEMBER_KEY, clientCopy: copy, pushTokens: [], lastReleasedAt: null, day: '2026-10-01',
        community: { nodeKey: NODE_KEY, half: vaultHalf, ref: vaultCommunityRef(MEMBER_SEED, NODE_KEY) },
    });
    const { payloadB64, bytes } = vaultVoucherToSign({ v: 1, community: NODE_KEY, member: MEMBER_KEY, phone: PHONE_ACCOUNT.publicKey, copy: digest, exp: Date.now() + HOLD_MS });
    answer = {
        state: 'released', callsign: 'MiaMember', communityName: 'Mullum', memberKey: MEMBER_KEY,
        release: sealReleaseToDevice(communityHalfForRelease({ half: nodeHalf, copy: digest }), PHONE_ACCOUNT.publicKey, { collectionId: CODE, holderType: 'community-half' }),
        voucher: joinVaultVoucher(payloadB64, ed25519.sign(bytes, NODE_SEED)),
    };

    toNode = [];
    vi.stubGlobal('fetch', async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const u = new URL(input);
        const raw = typeof init?.body === 'string' ? init.body : '';
        if (u.origin === VAULT) {
            const req: SentRequest = {
                url: input, origin: u.origin, path: u.pathname, method: String(init?.method ?? 'GET').toUpperCase(),
                headers: { ...(init?.headers ?? {}) }, raw, body: raw ? JSON.parse(raw) : undefined,
            };
            const r = vault.answer(req);
            return new Response(JSON.stringify(r.body), { status: r.status });
        }
        toNode.push(u.pathname);
        return new Response(JSON.stringify(answer), { status: 200 });
    });
    await open();
});
afterEach(async () => {
    await close();
    vi.unstubAllGlobals();
    noVault();
});

describe('a shared bring-back on the re-key screen (vault rethink VR4)', () => {
    it('the number typed: the screen waits at the vault, says it takes a day, and saves nothing yet', async () => {
        await until(() => text().includes('It comes through'));
        expect(text()).toContain('Your account is on its way back');
        expect(text()).toContain('so your other phones can stop it');
        expect(hold().provider).toBe(VAULT_COMMUNITY_PROVIDER);
        expect(fake.imported).toEqual([]);
        expect(fake.appIdentity).toEqual([]);
        expect(fake.alerts).toEqual([]);
        // Written down, so the vault's day can outlive the code; the re-key's own record has gone.
        expect(fake.slot).toBeNull();
        expect(await loadPendingCommunityRestore()).toMatchObject({ memberKey: MEMBER_KEY, community: MULLUM });
        expect(text()).not.toContain('Welcome back');
    });

    it('the app closes and opens again: it comes back to the wait, asks the vault, and never asks the community again', async () => {
        await until(() => text().includes('It comes through'));
        const asked = toNode.length;
        await close();
        await open();
        await until(() => text().includes('It comes through'));
        expect(toNode.length).toBe(asked);
        expect(vault.holds.size).toBe(1);
    });

    it('the vault lets go: "Replace this phone\'s account?" first, then the SAME key, with its 12 words, and the wait is over', async () => {
        await until(() => text().includes('It comes through'));
        hold().releaseAt = Date.now() - 1;
        await close();
        await open();
        await until(() => fake.alerts.length > 0);
        const replace = fake.alerts[0];
        expect(replace.title).toBe('Replace this phone’s account?');
        expect(fake.imported).toEqual([]);
        await act(async () => { await replace.buttons?.[1].onPress?.(); });
        await until(() => text().includes('Welcome back'));
        expect(fake.imported).toEqual([MEMBER_KEY]);
        expect(fake.appIdentity[0]).toMatchObject({ publicKey: MEMBER_KEY, privateKey: bytesToHex(MEMBER_SEED), mnemonic: WORDS });
        expect(text()).toContain('Your 12 words came back with it.');
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('Keep it: nothing changes, and the release can still be collected', async () => {
        await until(() => text().includes('It comes through'));
        hold().releaseAt = Date.now() - 1;
        await close();
        await open();
        await until(() => fake.alerts.length > 0);
        await act(async () => { await fake.alerts[0].buttons?.[0].onPress?.(); });
        await until(() => text().includes('The account on this phone was kept. Nothing changed.'));
        expect(fake.imported).toEqual([]);
        expect(await loadPendingCommunityRestore()).not.toBeNull();
    });

    it('the phone\'s own account key is copied nowhere, and Sign Out during the wait ends it, saying why', async () => {
        await until(() => text().includes('It comes through'));
        expect([...fake.secure.values()].join()).not.toContain(PHONE_ACCOUNT.privateKey);
        fake.phone = null;
        await close();
        await open();
        await until(() => text().includes('This phone’s account changed while you waited, so nothing was saved.'));
        expect(fake.imported).toEqual([]);
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('a Stop from the member\'s own phone: it says so, and the wait is over with nothing saved', async () => {
        await until(() => text().includes('It comes through'));
        hold().cancelled = true;
        await close();
        await open();
        await until(() => text().includes('This restore was stopped'));
        expect(fake.imported).toEqual([]);
        expect(await loadPendingCommunityRestore()).toBeNull();
    });

    it('a paused vault: it says so in this flow\'s words, never the sign-in\'s, and the wait goes on', async () => {
        await until(() => text().includes('It comes through'));
        vault.locked = true;
        await close();
        await open();
        await until(() => text().includes('Your account is safe, and this carries on when the vault is back.'));
        expect(text()).not.toContain('sign-in');
        expect(await loadPendingCommunityRestore()).not.toBeNull();
    });
});
