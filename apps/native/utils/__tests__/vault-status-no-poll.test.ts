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
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const app = vi.hoisted(() => ({ listeners: [] as ((s: string) => void)[] }));
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children }: { children?: ReactNode }) => createElement(tag, null, children);
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
import { vaultHoldsAtOpen, vaultStatus, vaultCopyKnown, disconnectFromVault } from '../vault';
import { installNetwork, noVault, useVault, VAULT, type Network } from './fake-vault';

const COPY_KNOWN = (pk: string) => `beanpool_vault_copy_known:${pk.toLowerCase()}`;
const TEN_MINUTES = 10 * 60;

let net: Network;
let root: Root;
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
    root = createRoot(document.createElement('div'));
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
    });

    it('a member with no copy at the vault: never asked, not when the banner shows, not on a timer, not on return', async () => {
        await mountAndWait(TEN_MINUTES);
        await backToFront();
        expect(statusCalls()).toBe(0);
        expect(net.sent.filter(s => s.origin === VAULT)).toEqual([]);
    });
});

describe('the app-open check asks only for a member the phone knows a copy for', () => {
    it('no copy known: no request at all', async () => {
        vi.useRealTimers();
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
