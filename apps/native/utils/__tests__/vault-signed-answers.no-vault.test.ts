/**
 * A build without a vault (today's release: no EXPO_PUBLIC_BEANPOOL_VAULT_* values) is untouched by the vault's signed
 * answers (PR #1336 review finding 4). The fetch spy V4 used: every flow that reaches utils/vault.ts runs, and the
 * requests they make are pinned, in order, method, address, path and body fields. The same list is what main makes:
 * this file passes unchanged on main (where there is no challenge and no signed answer at all). So: no request to a
 * vault, no new request, and no new field (`challenge`) in any request.
 *
 * Nothing is contacted: the stub below plays the member's community and the global community's door, and refuses any
 * other address.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

/** Each provider's sheet: a token for this sign-in account, carrying the nonce it was given. */
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const jwt = (sub: string, nonce: string) => {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub, nonce })}.c2lnbmF0dXJl`;
    };
    const sub = (provider: string) => `${provider}-sub-42`;
    const sheet = (provider: 'google' | 'apple' | 'facebook') => vi.fn(async (nonce: string) => ({ idToken: jwt(sub(provider), nonce), nonce }));
    const signInWithProvider = vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => ({ provider, idToken: jwt(sub(provider), nonce), nonce }));
    return {
        ...real,
        signInWithProvider,
        // The real one (the community's nonce, then the sheet), with the stubbed sheet.
        startSsoSignIn: vi.fn(async (provider: 'google' | 'apple' | 'facebook', url: string, identity: Parameters<typeof real.fetchSsoNonce>[1]) => {
            const { nonce } = await real.fetchSsoNonce(url, identity);
            return signInWithProvider(provider, nonce);
        }),
        signInWithGoogle: sheet('google'),
        signInWithApple: sheet('apple'),
        signInWithFacebook: sheet('facebook'),
    };
});

import { draftIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { connectAndDeposit } from '../sso-sheet-connect';
import { disconnectSsoKeeper } from '../keeper-enrolment';
import { checkSsoRestore, startSsoRestore } from '../sso-recovery';
import { vaultMoveOffer } from '../vault-move';
import { signInAtDoor, submitJoin } from '../global-join';
import { hasVault, keepVaultPushTokenCurrent, signInCopiesAt, vaultHoldsAtOpen, withdrawVaultPushToken } from '../vault';
import { PUSH_TOKEN_STORE_KEY } from '../storage-keys';

const COMMUNITY = 'https://a.test';
const GLOBAL = 'https://global.beanpool.org';

interface Seen { line: string; body: Record<string, unknown> | undefined }
let seen: Seen[];
let member: BeanPoolIdentity;
const originalFetch = globalThis.fetch;

function reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const k of ['URL', 'TICKET_KEYS', 'DEPOSIT_KEYS']) delete process.env[`EXPO_PUBLIC_BEANPOOL_VAULT_${k}`];
    seen = [];
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const u = new URL(url);
        const method = String(init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
        seen.push({ line: `${method} ${u.origin}${u.pathname}`, body });
        if (u.origin === COMMUNITY) {
            if (u.pathname === '/api/recovery/sso-nonce') return reply(200, { nonce: 'node-nonce-1', expiresInSeconds: 600, providers: ['google', 'facebook'] });
            if (u.pathname === '/api/recovery/shares/sso' && method === 'POST') return reply(200, { generation: 1, enrolledSso: ['google'], threshold: 1 });
            if (u.pathname === '/api/recovery/shares/sso/google' && method === 'DELETE') return reply(200, { removed: 'google', enrolledSso: [] });
            if (u.pathname === '/api/recovery/shares/status') return reply(200, { enrolledSso: ['google'], keepers: [], total: 1, threshold: 1 });
        }
        if (u.origin === GLOBAL) {
            if (u.pathname === '/api/join/sso-nonce') return reply(200, { nonce: 'door-nonce-1', expiresInSeconds: 600, providers: ['google'] });
            if (u.pathname === '/api/join') return reply(200, { success: true, member: { publicKey: init?.headers?.['X-Public-Key'], callsign: 'Sam' } });
        }
        throw new TypeError(`Network request failed: the app contacted ${url}`);
    }) as typeof fetch;
    member = await draftIdentity('Sam');
    await importIdentity(member);
    mem.async.set('beanpool_anchor_url', COMMUNITY);
    mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[no-vault-phone]');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

const lines = () => seen.map(s => s.line);
const fields = () => seen.map(s => `${s.line} ${Object.keys(s.body ?? {}).sort().join(',')}`);

describe('a build with no vault: the requests main makes, no more, no new field', () => {
    it('is a build with no vault', () => {
        expect(hasVault()).toBe(false);
        expect(signInCopiesAt()).toBe('community');
    });

    it('connect and Disconnect: at the member\'s community, exactly as before the vault', async () => {
        const linked = await connectAndDeposit({
            provider: 'google', url: COMMUNITY, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal,
        });
        expect(linked.error).toBeUndefined();
        expect(linked.enrolledSso).toEqual(['google']);
        expect(await disconnectSsoKeeper('google', member)).toMatchObject({ success: true });
        expect(fields()).toEqual([
            `POST ${COMMUNITY}/api/recovery/sso-nonce `,
            `POST ${COMMUNITY}/api/recovery/shares/sso idToken,nonce,provider,shares`,
            `DELETE ${COMMUNITY}/api/recovery/shares/sso/google `,
        ]);
    });

    it('the global door: its own nonce, the copy in the join, and no vault', async () => {
        const result = await signInAtDoor('google', GLOBAL, member);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        expect(result.signin.vaultTicket).toBeUndefined();
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin);
        expect(answer.kind).toBe('joined');
        expect(lines()).toEqual([`POST ${GLOBAL}/api/join/sso-nonce`, `POST ${GLOBAL}/api/join`]);
        expect(Object.keys(seen[1].body ?? {})).toContain('recovery');
    });

    it('the vault\'s own paths ask nothing: the app-open check, the move card, the push token, a sign-in restore', async () => {
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
        expect(await withdrawVaultPushToken(member, 1_000)).toBe(false);
        await keepVaultPushTokenCurrent(member);
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'not_configured' });
        expect(await checkSsoRestore()).toBeNull();
        expect(seen).toEqual([]);
    });

    it('no request anywhere carries a challenge', async () => {
        await connectAndDeposit({
            provider: 'google', url: COMMUNITY, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal,
        });
        await disconnectSsoKeeper('google', member);
        const door = await signInAtDoor('google', GLOBAL, member);
        if (door.kind === 'signed_in') await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', door.signin);
        expect(seen.length).toBe(5);
        for (const s of seen) expect(JSON.stringify(s.body ?? {}), s.line).not.toMatch(/"challenge"|"signed"/);
    });
});
