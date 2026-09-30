/**
 * The release gate (PR #1336 fix round, deciding review findings 6 and 3). BeanPool's key vault isn't hosted yet, so
 * every build cut from main has no vault values. Such a build must keep sign-in recovery exactly as it was before the
 * vault: the copy is deposited at the member's community, disconnected there, and restored from there with the callsign.
 * Only a build with a whole, well-formed vault (utils/vault-config.ts) switches to the vault, and no build is left with
 * neither.
 *
 * Main's own recovery suites run unchanged against this code in the `*.no-vault.test.ts` files (byte for byte main's
 * `*.test.ts`); this file holds the switch itself, end to end over a fake network.
 *
 * Nothing is contacted: fake-vault.ts plays the vault; the community here keeps old-style copies (`/api/recovery/*`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

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

/** The providers' sheets, stubbed: a token carrying the nonce they were given, for a fixed account per provider. */
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const subs = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
    const sheet = (provider: keyof typeof subs) => vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: subs[provider], nonce }), nonce }));
    const sheets = { google: sheet('google'), apple: sheet('apple'), facebook: sheet('facebook') };
    return {
        ...real,
        signInWithGoogle: sheets.google,
        signInWithApple: sheets.apple,
        signInWithFacebook: sheets.facebook,
        signInWithProvider: vi.fn(async (provider: keyof typeof subs, nonce: string) => ({ provider, ...await sheets[provider](nonce) })),
        // The community's nonce, asked of the community for real (sso-signin.ts `fetchSsoNonce`), then the stubbed sheet.
        startSsoSignIn: vi.fn(async (provider: keyof typeof subs, url: string, identity: any) => {
            const { nonce } = await real.fetchSsoNonce(url, identity);
            return { provider, ...await sheets[provider](nonce) };
        }),
    };
});

import { sealSeedToSso, toEd25519Seed, type SealedShare } from '@beanpool/core';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { connectAndDeposit } from '../sso-sheet-connect';
import { disconnectSsoKeeper } from '../keeper-enrolment';
import { recoverAccountWithSso } from '../sso-recovery';
import { signInCopiesAt, vaultConfig } from '../vault-config';
import { protectionFrom } from '../protection-state';
import {
    COMMUNITY, DEPOSIT_KEY, TICKET_KEY, VAULT,
    installNetwork, keysIn, noVault, useVault, type Network, type SentRequest,
} from './fake-vault';

const ANCHOR = 'beanpool_anchor_url';
/**
 * 27 real connects (a scrypt seal and a signed request each): 0.7 s alone here, about 4 s beside the other suites, and CI
 * runs about 3.4 times slower than that (run 36714344338 timed out at vitest's 5 s default). Room to spare.
 */
const SLOW_TEST_MS = 60_000;
const SUB = 'google-sub-42';

/**
 * A community as every live one is today: it keeps each member's sign-in copy, hands out its own nonce, and gives the
 * copy back to a restore that names the callsign and proves the sign-in.
 */
class CommunityKeepingCopies {
    /** provider → the copy (the phone's single-blob share), for the one member here. */
    readonly copies = new Map<string, SealedShare>();
    readonly nonces = new Set<string>();
    private seq = 0;
    constructor(readonly callsign: string) {}

    handle(req: SentRequest): { status: number; body: unknown } {
        const b = req.body ?? {};
        const ok = (body: unknown) => ({ status: 200, body });
        if (req.method === 'POST' && req.path === '/api/recovery/sso-nonce') {
            const nonce = `community-nonce-${++this.seq}`;
            this.nonces.add(nonce);
            return ok({ nonce, expiresInSeconds: 600, providers: ['apple', 'google', 'facebook'] });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/shares/sso') {
            if (!this.nonces.delete(b.nonce)) return { status: 401, body: { error: 'nonce' } };
            this.copies.set(b.provider, b.shares[0]);
            return ok({ generation: 1, enrolledSso: [...this.copies.keys()], threshold: 1 });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/shares/status') {
            return ok({ enrolledSso: [...this.copies.keys()], keepers: [{ holderType: 'sso', count: this.copies.size }], total: this.copies.size, threshold: 1 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(req.path);
        if (req.method === 'DELETE' && del) {
            if (!this.copies.delete(del[1])) return { status: 404, body: { error: 'not connected' } };
            return ok({ removed: del[1], enrolledSso: [...this.copies.keys()] });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect') {
            return b.callsign === this.callsign ? ok({ collectionId: 'c-1' }) : { status: 404, body: { error: 'No such account.' } };
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/sso-nonce') {
            const nonce = `collect-nonce-${++this.seq}`;
            this.nonces.add(nonce);
            return ok({ nonce });
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/sso') {
            return this.nonces.delete(b.nonce) ? ok({ released: true }) : { status: 401, body: { error: 'nonce' } };
        }
        if (req.method === 'POST' && req.path === '/api/recovery/collect/fragments') {
            const copy = this.copies.get('google')!;
            return ok({
                fragments: [{
                    holderType: 'sso', payload: copy.encryptedShare, payloadIv: copy.shareIv, payloadTag: copy.shareTag, kdfParams: copy.kdfParams,
                }],
            });
        }
        return { status: 404, body: { error: 'Not Found' } };
    }
}

let net: Network;
let community: CommunityKeepingCopies;
let member: BeanPoolIdentity;
const originalFetch = globalThis.fetch;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    noVault();
    net = installNetwork();
    community = new CommunityKeepingCopies('Sam');
    net.community.handle = (req) => community.handle(req);
    member = await draftIdentity('Sam');
    await importIdentity(member);
    mem.async.set(ANCHOR, COMMUNITY);
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
    vi.restoreAllMocks();
});

const connect = (url: string | null = COMMUNITY) =>
    connectAndDeposit({ provider: 'google', url, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal });
const to = (origin: string) => net.sent.filter(s => s.origin === origin);
const paths = (origin: string) => to(origin).map(s => `${s.method} ${s.path}`);

describe('a build without a vault: sign-in recovery exactly as before the vault', () => {
    it('Connect deposits at the community, proven with its own nonce, and asks no vault', async () => {
        expect(signInCopiesAt()).toBe('community');
        const result = await connect();
        expect(result).toMatchObject({ enrolledSso: ['google'], generation: 1 });
        expect(result.error).toBeUndefined();
        expect(protectionFrom(result).state).toBe('covered');
        expect(paths(COMMUNITY)).toEqual(['POST /api/recovery/sso-nonce', 'POST /api/recovery/shares/sso']);
        expect(to(VAULT)).toEqual([]);
        // The community holds the copy, and it opens to this key with this sign-in.
        expect([...community.copies.keys()]).toEqual(['google']);
    });

    it('Disconnect is the signed DELETE at the community', async () => {
        await connect();
        expect(await disconnectSsoKeeper('google', member)).toEqual({ success: true, enrolledSso: [] });
        expect(paths(COMMUNITY)).toContain('DELETE /api/recovery/shares/sso/google');
        expect(community.copies.size).toBe(0);
        expect(to(VAULT)).toEqual([]);
    });

    it('a new phone restores from the community copy with the callsign and the sign-in, onto that community', async () => {
        await connect();
        mem.async.clear();
        mem.secure.clear();
        expect(await loadIdentity()).toBeNull();

        const result = await recoverAccountWithSso({ callsign: 'Sam', anchorUrl: COMMUNITY, provider: 'google' });
        expect(result.identity.publicKey).toBe(member.publicKey);
        expect(result.identity.mnemonic).toEqual(member.mnemonic);
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
        expect(mem.async.get(ANCHOR)).toBe(COMMUNITY);
        expect(to(VAULT)).toEqual([]);
    });

    it('a copy the community already keeps (made before this app) restores the same way', async () => {
        const seed = toEd25519Seed(hexToBytes(member.privateKey));
        community.copies.set('google', await sealSeedToSso(seed, 'google', SUB));
        mem.async.clear();
        mem.secure.clear();
        const result = await recoverAccountWithSso({ callsign: 'Sam', anchorUrl: COMMUNITY, provider: 'google' });
        expect(result.identity.publicKey).toBe(member.publicKey);
        expect(to(VAULT)).toEqual([]);
    });
});

describe('a build with a vault: the vault, whatever community the phone is on', () => {
    it('Connect goes to the vault even when handed the community, and the community sees nothing that opens a key', async () => {
        useVault();
        expect(signInCopiesAt()).toBe('vault');
        const result = await connect(COMMUNITY);
        expect(result).toMatchObject({ enrolledSso: ['google'] });
        expect(paths(VAULT)).toEqual(['POST /v1/ticket', 'POST /v1/copies']);
        for (const s of to(COMMUNITY)) expect([...keysIn(s.body)].filter(k => ['idToken', 'shares', 'nonce'].includes(k))).toEqual([]);
        expect(community.copies.size).toBe(0);
    });

    it('Disconnect goes to the vault', async () => {
        useVault();
        await connect();
        expect(await disconnectSsoKeeper('google', member)).toEqual({ success: true, enrolledSso: [] });
        expect(paths(VAULT)).toContain('POST /v1/copies/delete');
        expect(to(COMMUNITY)).toEqual([]);
    });
});

describe('no build ends up with neither', () => {
    const URLS = [undefined, 'vault.test', VAULT] as const;
    const TICKETS = [undefined, 'not-a-key', TICKET_KEY] as const;
    const DEPOSITS = [undefined, 'not-a-key', DEPOSIT_KEY] as const;

    it('every mix of the three build values links a sign-in somewhere: the vault only when all three are good', async () => {
        let atVault = 0;
        for (const url of URLS) {
            for (const tickets of TICKETS) {
                for (const deposits of DEPOSITS) {
                    const set = (name: string, v: string | undefined) => {
                        if (v === undefined) delete process.env[name];
                        else process.env[name] = v;
                    };
                    set('EXPO_PUBLIC_BEANPOOL_VAULT_URL', url);
                    set('EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS', tickets);
                    set('EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS', deposits);
                    const whole = url === VAULT && tickets === TICKET_KEY && deposits === DEPOSIT_KEY;
                    const label = `${url}/${tickets}/${deposits}`;
                    expect(signInCopiesAt(), label).toBe(whole ? 'vault' : 'community');
                    expect(vaultConfig() !== null, label).toBe(whole);

                    net = installNetwork();
                    community = new CommunityKeepingCopies('Sam');
                    net.community.handle = (req) => community.handle(req);
                    const result = await connect();
                    expect(result.error, label).toBeUndefined();
                    expect(result.enrolledSso, label).toEqual(['google']);
                    if (whole) {
                        atVault++;
                        expect(net.vault.copiesOf(member.publicKey), label).toHaveLength(1);
                        expect(community.copies.size, label).toBe(0);
                    } else {
                        expect(to(VAULT), label).toEqual([]);
                        expect(community.copies.size, label).toBe(1);
                    }
                }
            }
        }
        expect(atVault).toBe(1);
    }, SLOW_TEST_MS);

    it('app.config.js stops a build that sets some of the three but not all', () => {
        const load = () => {
            const require = createRequire(import.meta.url);
            const file = path.resolve(__dirname, '../../app.config.js');
            delete require.cache[file];
            return require(file) as (a: { config: Record<string, unknown> }) => Record<string, unknown>;
        };
        const names = ['EXPO_PUBLIC_BEANPOOL_VAULT_URL', 'EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS', 'EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS'];
        const values = [VAULT, TICKET_KEY, DEPOSIT_KEY];
        for (let mask = 0; mask < 8; mask++) {
            names.forEach((n, i) => {
                if (mask & (1 << i)) process.env[n] = values[i];
                else delete process.env[n];
            });
            const run = () => load()({ config: { name: 'BeanPool' } });
            if (mask === 0 || mask === 7) expect(run, `mask ${mask}`).not.toThrow();
            else expect(run, `mask ${mask}`).toThrow(/set all three or none/);
        }
    });
});
