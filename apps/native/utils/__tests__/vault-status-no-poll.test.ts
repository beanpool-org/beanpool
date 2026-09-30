// @vitest-environment jsdom
/**
 * The vault is off the everyday path (Marty, 2026-09-28; PR #1336 review finding 1). The Settings banner
 * (components/RecoveryAlertBanner.tsx) and the app-open check (utils/vault.ts `vaultHoldsAtOpen`) ask BeanPool's key
 * vault for this account's status when the banner first shows, when the app comes back to the front, and on a member's
 * own action: never on a timer, and never for a member the phone knows no copy at the vault for.
 *
 * The banner is rendered for real (react-dom in jsdom, React Native's host components as plain tags) with fake timers;
 * the vault is fake-vault.ts's, and every request is counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Alert } from 'react-native';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const app = vi.hoisted(() => ({ listeners: [] as ((s: string) => void)[] }));
vi.mock('react-native', () => {
    // A button's onPress becomes a click, so a test can press it.
    const el = (tag: string) => ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
        createElement(tag, onPress ? { onClick: onPress } : null, children);
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), TouchableOpacity: el('button'), ActivityIndicator: el('i'),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn((_: string, fn: (s: string) => void) => {
                app.listeners.push(fn);
                return { remove: () => { app.listeners = app.listeners.filter(l => l !== fn); } };
            }),
        },
        DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    };
});
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
const community = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../db', () => ({ signedRequest: vi.fn(async () => { community.calls++; return { collections: [] }; }) }));
vi.mock('../LocalAuth', () => ({ authenticateUser: vi.fn(async () => true) }));
const who = vi.hoisted(() => ({ identity: null as any }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: who.identity }) }));

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sealSeedToSso } from '@beanpool/core';
import { RecoveryAlertBanner } from '../../components/RecoveryAlertBanner';
import { approveVaultHold, noteVaultCopy, vaultHoldsAtOpen, vaultStatus, vaultCopyKnown, disconnectFromVault } from '../vault';
import { installNetwork, noVault, useVault, VAULT, type Network } from './fake-vault';
import { PUSH_TOKEN_STORE_KEY } from '../storage-keys';

const COPY_KNOWN = (pk: string) => `beanpool_vault_copy_known:${pk.toLowerCase()}`;
const TEN_MINUTES = 10 * 60;
/** Ten minutes of fake time, a second at a time, each inside act(): about 1 s here beside other suites; CI is slower. */
const TEN_MINUTES_OF_FAKE_TIME_MS = 30_000;

let net: Network;
let root: Root;
let host: HTMLElement;
const originalFetch = globalThis.fetch;
const statusCalls = () => net.sent.filter(s => s.origin === VAULT && s.path === '/v1/copies/status').length;

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    app.listeners = [];
    community.calls = 0;
    const seed = new Uint8Array(32).fill(7);
    who.identity = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: 'Sam', createdAt: '' };
    useVault();
    net = installNetwork();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    host = document.createElement('div');
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    noVault();
    vi.restoreAllMocks();
});

async function mountAndWait(seconds: number) {
    // react-dom's and React Native's element types differ only in their typings here.
    await act(async () => { root.render(createElement(RecoveryAlertBanner) as unknown as Parameters<Root['render']>[0]); });
    for (let i = 0; i < seconds; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
}

async function backToFront() {
    await act(async () => { for (const l of [...app.listeners]) l('active'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

/** A copy at the vault for this member, and the phone knowing it (as after a deposit here). */
async function memberWithCopy() {
    net.vault.keep('google', 'google-sub-42', who.identity.publicKey, await sealSeedToSso(new Uint8Array(32).fill(7), 'google', 'google-sub-42'));
    mem.async.set(COPY_KNOWN(who.identity.publicKey), '1');
}

describe('the Settings banner asks the vault on no timer', () => {
    it('a member with a copy: once when the banner shows, then nothing for ten minutes, then once when the app comes back', async () => {
        await memberWithCopy();
        await mountAndWait(TEN_MINUTES);
        expect(statusCalls()).toBe(1);
        await backToFront();
        expect(statusCalls()).toBe(2);
        await act(async () => { await vi.advanceTimersByTimeAsync(TEN_MINUTES * 1_000); });
        expect(statusCalls()).toBe(2);
        // The community's own watch is unchanged: it still runs while the app is in front.
        expect(community.calls).toBeGreaterThan(1);
    }, TEN_MINUTES_OF_FAKE_TIME_MS);

    it('a member the phone knows has no copy at the vault: never asked, not when the banner shows, not on a timer, not on return', async () => {
        await noteVaultCopy(who.identity.publicKey, false);
        await mountAndWait(TEN_MINUTES);
        await backToFront();
        expect(statusCalls()).toBe(0);
        expect(net.sent.filter(s => s.origin === VAULT)).toEqual([]);
    }, TEN_MINUTES_OF_FAKE_TIME_MS);
});

describe('the app-open check asks only for a member the phone knows a copy for', () => {
    it('known to have no copy: no request at all', async () => {
        vi.useRealTimers();
        await noteVaultCopy(who.identity.publicKey, false);
        expect(await vaultHoldsAtOpen(who.identity)).toEqual([]);
        expect(net.sent).toEqual([]);
    });

    it('a copy known: one status request', async () => {
        vi.useRealTimers();
        await memberWithCopy();
        await vaultHoldsAtOpen(who.identity);
        expect(statusCalls()).toBe(1);
    });

    it('the phone learns of a copy from a status read (Account Protection), and forgets it when none is left', async () => {
        vi.useRealTimers();
        net.vault.keep('google', 'google-sub-42', who.identity.publicKey, await sealSeedToSso(new Uint8Array(32).fill(7), 'google', 'google-sub-42'));
        expect(await vaultCopyKnown(who.identity.publicKey)).toBe(false);
        await vaultStatus(who.identity);
        expect(await vaultCopyKnown(who.identity.publicKey)).toBe(true);
        await disconnectFromVault(who.identity, 'google');
        await vaultStatus(who.identity);
        expect(await vaultCopyKnown(who.identity.publicKey)).toBe(false);
    });
});

describe('a phone that got the account back with its 12 words (confirmation review NEW-1)', () => {
    /** Phone A linked Google and is lost; the vault's copy has only A's push token. Someone with the member's Google opens a hold. */
    async function lostPhoneAndAHold() {
        net.vault.keep('google', 'google-sub-42', who.identity.publicKey, await sealSeedToSso(new Uint8Array(32).fill(7), 'google', 'google-sub-42'));
        net.vault.copies.get('google:google-sub-42')!.pushTokens.push('ExponentPushToken[phone-A]');
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[phone-B]');
        net.vault.holds.set('hold-attacker', {
            holdId: 'hold-attacker', copy: 'google:google-sub-42', requester: 'cd'.repeat(32), provider: 'google',
            openedAt: Date.now(), releaseAt: Date.now() + 86_400_000, cancelled: false, released: false,
        });
    }

    it('the next app open asks the vault, brings the hold up, and gives the copy this phone\'s push token', async () => {
        vi.useRealTimers();
        await lostPhoneAndAHold();
        // This phone (B) knows nothing yet about a copy for the account: it came back with the 12 words.
        const seen = await vaultHoldsAtOpen(who.identity);
        expect(seen.map(h => h.holdId)).toEqual(['hold-attacker']);
        await vi.waitFor(() => expect(net.vault.copies.get('google:google-sub-42')!.pushTokens).toContain('ExponentPushToken[phone-B]'));
        expect(await vaultCopyKnown(who.identity.publicKey)).toBe(true);
    });

    it('the Settings banner offers Stop for it', async () => {
        vi.useRealTimers();
        await lostPhoneAndAHold();
        vi.useFakeTimers();
        await mountAndWait(1);
        const text = host.textContent ?? '';
        expect(text).toContain('Someone is getting back into your account');
        expect(text).toContain('Stop');
        expect(text).toContain("Yes, it's me");
    });

    it('an account with no copy at the vault is asked once, and then never again', async () => {
        vi.useRealTimers();
        expect(await vaultHoldsAtOpen(who.identity)).toEqual([]);
        expect(statusCalls()).toBe(1);
        await vaultHoldsAtOpen(who.identity);
        vi.useFakeTimers();
        await mountAndWait(5);
        await backToFront();
        expect(statusCalls()).toBe(1);
    });
});

describe('a hold this phone let through ("Yes, it\'s me")', () => {
    it('shows as let through, with no Stop and no "Yes, it\'s me", until the other device collects it', async () => {
        vi.useRealTimers();
        await memberWithCopy();
        // Another phone of the member's is getting back in with Google: a hold at the vault, waiting.
        net.vault.holds.set('hold-x', {
            holdId: 'hold-x', copy: 'google:google-sub-42', requester: 'ab'.repeat(32), provider: 'google',
            openedAt: Date.now(), releaseAt: Date.now() + 86_400_000, cancelled: false, released: false,
        });
        await approveVaultHold(who.identity, 'hold-x');
        vi.useFakeTimers();

        await mountAndWait(1);
        const text = host.textContent ?? '';
        expect(text).toContain('Let through');
        expect(text).toContain('You let the restore with Google through.');
        expect(text).not.toContain('Stop');
        expect(text).not.toContain("Yes, it's me");
    });
});

describe('a Stop that comes after the other device collected (confirmation review NEW-3)', () => {
    it('says it has already gone through, and never "try again"', async () => {
        vi.useRealTimers();
        await memberWithCopy();
        net.vault.holds.set('hold-y', {
            holdId: 'hold-y', copy: 'google:google-sub-42', requester: 'ab'.repeat(32), provider: 'google',
            openedAt: Date.now(), releaseAt: Date.now() + 86_400_000, cancelled: false, released: false,
        });
        // The other device collects between the banner showing and the member's Stop: the vault answers 409 collected.
        const real = net.vault.handle.bind(net.vault);
        net.vault.handle = (req) => req.path === '/v1/holds/cancel'
            ? { status: 409, body: { error: 'That restore was already collected.', code: 'collected' } }
            : real(req);
        vi.useFakeTimers();
        await mountAndWait(1);
        const stop = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Stop'))!;
        await act(async () => { stop.click(); });
        const [, , buttons] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
        await act(async () => { await (buttons as { text: string; onPress?: () => Promise<void> }[]).find(b => b.text === 'Stop it')!.onPress!(); });
        const [title, message] = vi.mocked(Alert.alert).mock.calls.at(-1)!;
        expect(title).toBe('Already gone through');
        expect(message).toContain('That restore has already gone through: the other phone or computer has your account now.');
        expect(message).not.toMatch(/try again/i);
        expect(message).not.toContain('already collected');
    });
});
