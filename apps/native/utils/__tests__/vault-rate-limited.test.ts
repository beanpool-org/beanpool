/**
 * The vault's address limit, as the phone meets it (vault audit VLT-01, scratch/reviews/verify-audit-vault.md). The
 * vault counts every signed call per address before it reads the signature (apps/vault server.ts `handle`, B3), so the
 * 61st in a minute is a 429 it can't sign. The phone reads it as "too many tries", never as an answer that didn't check
 * out ("check your date and time"), and acts on nothing but "later": a restore keeps its throwaway key, since a relay at
 * the vault's address may have passed the restore on (the vault opened a hold) and answered the 429 itself.
 *
 * Runs the phone's utils/vault.ts against the real vault from apps/vault's harness, as vault-real.test.ts does, in a file
 * of its own: the flood fills the one address bucket every test here shares.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
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
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import { draftIdentity, type BeanPoolIdentity } from '../identity';
import {
    clearPendingVaultRestore, collectVaultRestore, loadPendingVaultRestore, startVaultRestore, vaultStatus, VAULT_MESSAGES, VaultError,
} from '../vault';
import { VAULT_WORDS, vaultErrorText, vaultTooMany } from '../vault-words';

/** apps/vault's harness (src/__tests__/harness.ts), loaded at run time: the phone's typecheck never reads the vault's sources. */
interface VaultUnderTest {
    baseUrl: string;
    stub: { mint(provider: string, claims: { sub: string; nonce: string; now: number }): string };
    close(): Promise<void>;
}
interface Member { seed: Uint8Array; key: string }
interface Harness {
    startVault(opts: { clock: { now(): number; advance(ms: number): void } }): Promise<VaultUnderTest>;
    doGenesis(v: VaultUnderTest): Promise<{ ticketKey: string; depositKey: string }>;
    newMember(): Member;
    signed(v: VaultUnderTest, p: string, body: unknown, seed: Uint8Array): Promise<{ status: number; body: Record<string, unknown> }>;
    deposit(v: VaultUnderTest, g: unknown, member: Member, provider: string, sub: string): Promise<{ status: number; body: Record<string, unknown> }>;
}
const HARNESS = '../../../vault/src/__tests__/harness';

let harness: Harness;
let v: VaultUnderTest;
let genesis: unknown;
let member: BeanPoolIdentity;
const realFetch = globalThis.fetch;

interface Exchange { path: string; status: number; answer: Record<string, unknown> | null }
const exchanges: Exchange[] = [];
/** A relay at the vault's address: passes /v1/restore on to the real vault, keeps its answer, and answers an unsigned 429. */
let relay429 = false;
let forwarded: Record<string, unknown> | null = null;

beforeAll(async () => {
    harness = await import(/* @vite-ignore */ HARNESS) as Harness;
    v = await harness.startVault({ clock: { now: () => Date.now(), advance: () => {} } });
    const g = await harness.doGenesis(v);
    genesis = g;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_URL = v.baseUrl;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS = g.ticketKey;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS = g.depositKey;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        if (!url.startsWith(v.baseUrl)) throw new TypeError(`the test contacted ${url}`);
        const path = new URL(url).pathname;
        const res = await realFetch(input, init);
        const answer = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
        exchanges.push({ path, status: res.status, answer });
        if (relay429 && path === '/v1/restore') {
            forwarded = answer;
            return new Response(JSON.stringify({ error: 'Too many requests from this address just now. Please try again later.', code: 'rate_limited', retryAfterSeconds: 60 }),
                { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } });
        }
        return res;
    }) as typeof fetch;
    member = await draftIdentity('Sam');
}, 60_000);

afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ['URL', 'TICKET_KEYS', 'DEPOSIT_KEYS']) delete process.env[`EXPO_PUBLIC_BEANPOOL_VAULT_${k}`];
    await v?.close();
});

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('the vault\'s address limit, on the phone (VLT-01)', () => {
    it('a relay passes a restore on (the vault opens a hold) and answers an unsigned 429: the phone keeps its throwaway key, and the hold is still its to collect', async () => {
        expect((await harness.deposit(v, genesis, harness.newMember(), 'google', 'relay-sub')).status).toBe(200);
        await clearPendingVaultRestore();
        relay429 = true;
        let err: unknown;
        try {
            await startVaultRestore('google', async (p, nonce) => ({ idToken: v.stub.mint(p, { sub: 'relay-sub', nonce, now: Date.now() }) }));
        } catch (e) {
            err = e;
        } finally {
            relay429 = false;
        }
        expect(err).toMatchObject({ reason: 'rate_limited', message: VAULT_MESSAGES.tooMany });
        expect(forwarded).toMatchObject({ status: 'held' });
        const pending = await loadPendingVaultRestore();
        expect(pending).not.toBeNull();
        const collected = await collectVaultRestore({ ...pending!, holdId: forwarded!.holdId as string, until: forwarded!.until as number });
        expect(collected.status).toBe('held');
        await clearPendingVaultRestore();
    });

    it('the 61st signed call in a minute from the phone\'s address is an unsigned 429: read as "too many tries", never "didn\'t check out"', async () => {
        const other = harness.newMember();
        for (let i = 0; i < 60; i++) await harness.signed(v, '/v1/copies/status', {}, other.seed);
        let err: unknown;
        try {
            await vaultStatus(member);
        } catch (e) {
            err = e;
        }
        const x = exchanges.at(-1)!;
        expect(x).toMatchObject({ path: '/v1/copies/status', status: 429, answer: { code: 'rate_limited' } });
        expect(x.answer?.signed).toBeUndefined();
        expect(err).toBeInstanceOf(VaultError);
        expect(err).toMatchObject({ reason: 'rate_limited', code: 'rate_limited', message: VAULT_MESSAGES.tooMany });
        expect((err as Error).message).not.toBe(VAULT_MESSAGES.unverified);
    });

    it('the member reads it in their language: the same English, marked for translation', () => {
        expect(VAULT_WORDS.tooMany).toBe(VAULT_MESSAGES.tooMany);
        const say = (english: string) => `«${english}»`;
        const tooMany = new VaultError('rate_limited', VAULT_MESSAGES.tooMany, 'rate_limited');
        expect(vaultTooMany(tooMany)).toBe(true);
        expect(vaultErrorText(tooMany, say)).toBe(`«${VAULT_MESSAGES.tooMany}»`);
        const unverified = new VaultError('unreachable', VAULT_MESSAGES.unverified, 'unverified');
        expect(vaultTooMany(unverified)).toBe(false);
        expect(vaultErrorText(unverified, say)).toBe(VAULT_MESSAGES.unverified);
        expect(vaultTooMany(Object.assign(new Error('x'), { reason: 'rate_limited' }))).toBe(false);
    });
});
