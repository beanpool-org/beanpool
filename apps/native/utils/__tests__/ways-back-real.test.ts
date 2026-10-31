/**
 * "Where your account can be brought back from" end to end against BeanPool's real key vault (vault rethink VR1,
 * DESIGN-vault-rethink-fable.md §5.1, §7 VR1's e2e): apps/vault's keyholder and API from its own test harness on
 * 127.0.0.1, with stub providers, as vault-real.test.ts runs it. Connect Google, see the vault's copy with since (the
 * vault's own signed status) beside a community's old copy, Remove everything, and land in the words-only state with the
 * "one way back" card back; then the reverse: connect again and the copy is listed again.
 *
 * Nothing else is contacted: every fetch the phone makes is recorded, and anything but the local vault and the stub
 * community throws.
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

const h = vi.hoisted(() => ({
    mint: null as null | ((provider: string, sub: string, nonce: string) => string),
    /** Another account of the same sign-in, as the member picks in Google's account chooser; null: the usual one. */
    sub: null as string | null,
}));
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return {
        ...real,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => (
            { provider, idToken: h.mint!(provider, h.sub ?? `${provider}-sub-e2e`, nonce), nonce }
        )),
    };
});

import { checkVaultAnswer } from '@beanpool/core';
import { draftIdentity, hasMnemonic, importIdentity, type BeanPoolIdentity } from '../identity';
import { oneWayBackFromNode, oneWayBackPlace } from '../one-way-back';
import { connectAndDeposit } from '../sso-sheet-connect';
import { SAVED_NODES_STORE_KEY } from '../storage-keys';
import { vaultCopyKnowledge, vaultCopyKnown } from '../vault';
import { beforeRemoving, listWaysBack, removeEverything, removeVaultCopy, wordsOnly, wordsWrittenDown } from '../ways-back';

/** apps/vault's harness (src/__tests__/harness.ts), loaded at run time: the phone's typecheck never reads the vault's sources. */
interface VaultUnderTest {
    baseUrl: string;
    stub: { mint(provider: string, claims: { sub: string; nonce: string; now: number }): string };
    close(): Promise<void>;
}
interface Harness {
    startVault(opts: { clock: { now(): number; advance(ms: number): void } }): Promise<VaultUnderTest>;
    doGenesis(v: VaultUnderTest): Promise<{ ticketKey: string; depositKey: string }>;
}
const HARNESS = '../../../vault/src/__tests__/harness';

const GLOBAL = 'https://global.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';

let v: VaultUnderTest;
let ticketKey: string;
let member: BeanPoolIdentity;
const realFetch = globalThis.fetch;

interface Exchange { path: string; key: string; challenge: unknown; status: number; answer: Record<string, unknown> | null }
const exchanges: Exchange[] = [];
/** The global community: an old Google copy from a web-app join, until the phone deletes it. */
const community = { copies: new Set<string>(), generation: 2, deletes: [] as string[] };

beforeAll(async () => {
    const harness = await import(/* @vite-ignore */ HARNESS) as Harness;
    v = await harness.startVault({ clock: { now: () => Date.now(), advance: () => {} } });
    const g = await harness.doGenesis(v);
    ticketKey = g.ticketKey;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_URL = v.baseUrl;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_TICKET_KEYS = g.ticketKey;
    process.env.EXPO_PUBLIC_BEANPOOL_VAULT_DEPOSIT_KEYS = g.depositKey;
    h.mint = (provider, sub, nonce) => v.stub.mint(provider, { sub, nonce, now: Date.now() });

    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input);
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (url.startsWith(v.baseUrl)) {
            const path = new URL(url).pathname;
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
            const headers = { ...(init?.headers ?? {}) } as Record<string, string>;
            const res = await realFetch(input, init);
            const answer = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
            exchanges.push({ path, key: headers['X-Public-Key'], challenge: body.challenge, status: res.status, answer });
            return res;
        }
        const u = new URL(url);
        if (url.startsWith(GLOBAL) && u.pathname === '/api/recovery/shares/status') {
            return new Response(JSON.stringify({ generation: community.generation, enrolledSso: [...community.copies] }), { status: 200 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(u.pathname);
        if (url.startsWith(GLOBAL) && method === 'DELETE' && del) {
            community.deletes.push(del[1]);
            if (!community.copies.delete(del[1])) return new Response(JSON.stringify({ error: 'not connected' }), { status: 404 });
            community.generation = community.copies.size ? community.generation + 1 : 0;
            return new Response(JSON.stringify({ removed: del[1] }), { status: 200 });
        }
        throw new TypeError(`the test contacted ${url}`);
    }) as typeof fetch;

    member = await draftIdentity('Sam');
    await importIdentity(member);
    mem.async.set(ANCHOR, GLOBAL);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: GLOBAL, alias: 'Global community' }]));
}, 60_000);

afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ['URL', 'TICKET_KEYS', 'DEPOSIT_KEYS']) delete process.env[`EXPO_PUBLIC_BEANPOOL_VAULT_${k}`];
    await v?.close();
});

const quietError = console.error;
beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
});
afterEach(() => {
    vi.restoreAllMocks();
});

const connect = (provider: 'google' | 'facebook' = 'google') =>
    connectAndDeposit({ provider, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal });

/** What the real vault signed in its last status answer, checked as the phone checks it. */
function lastSignedStatus() {
    const x = exchanges.filter(e => e.path === '/v1/copies/status').at(-1)!;
    const check = checkVaultAnswer(x.answer?.signed, { ticketKeys: [ticketKey], kinds: ['status'], key: x.key, challenge: x.challenge as string });
    if (!check.ok) throw new Error(`the status the phone acted on was not the vault's signed answer (${check.reason})`);
    return check.answer;
}

describe('connect, see where the copies are, remove everything, and the way back again: against the real vault', () => {
    it('lists, removes and lands in the words-only state with the "one way back" card', async () => {
        // A 12-words member of the global community (the node's word), with an old Google copy on global's server
        // from a web-app join, links Google in the phone app: the vault keeps a copy too.
        community.copies.add('google');
        expect(hasMnemonic(member)).toBe(true);
        const linked = await connect('google');
        expect(linked.error).toBeUndefined();
        expect(linked.enrolledSso).toEqual(['google']);
        expect(await vaultCopyKnown(member.publicKey)).toBe(true);

        // The list: the vault's copy, kept since today (UTC), on the vault's own signature; global's old copy.
        const today = new Date().toISOString().slice(0, 10);
        const ways = await listWaysBack(member);
        expect(ways.vault).toEqual({ kind: 'listed', copies: [{ provider: 'google', since: today, lastReleasedAt: null }] });
        expect(lastSignedStatus()).toMatchObject({ kind: 'status', key: member.publicKey, copies: [{ provider: 'google', since: today, updatedDay: today, lastReleasedAt: null }] });
        expect(ways.communities).toEqual([{ url: GLOBAL, name: 'Global community', status: { providers: ['google'], generation: 2 } }]);

        // Remove everything asks about the 12 words first: the phone has them, and they aren't marked written down.
        expect(await wordsWrittenDown(member.publicKey)).toBe(false);
        expect(beforeRemoving(ways, 'everything', { hasWords: true, writtenDown: false })).toBe('show-words-first');

        const done = await removeEverything(member, ways);
        expect(done).toEqual({
            vault: { removed: true },
            communities: [{ url: GLOBAL, name: 'Global community', provider: 'google', removal: { removed: true } }],
            // The global community keeps no copy for its admins (never offered there, vault rethink VR3).
            admins: [],
            notAsked: [],
        });
        // The vault signed that it deleted the copy, about this key, for this request.
        const del = exchanges.filter(e => e.path === '/v1/copies/delete').at(-1)!;
        expect(checkVaultAnswer(del.answer?.signed, { ticketKeys: [ticketKey], kinds: ['deleted'], key: member.publicKey, challenge: del.challenge as string }))
            .toMatchObject({ ok: true, answer: { deleted: 1 } });
        expect(community.deletes).toEqual(['google']);

        // The words-only state, by every keeper's own answer.
        const after = await listWaysBack(member);
        expect(after.vault).toEqual({ kind: 'listed', copies: [] });
        expect(lastSignedStatus()).toMatchObject({ copies: [], holds: [] });
        expect(after.communities[0].status).toEqual({ providers: [], generation: 0 });
        expect(wordsOnly(after)).toBe(true);

        // The card: the phone knows the vault keeps none, so for the node's "12 words" it is the card, not the quiet offer.
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');
        const standing = { words: true, joinedAt: Date.now() - 60_000 };
        const record = await oneWayBackFromNode(member.publicKey, GLOBAL, standing, Date.now(), { vaultCopy: await vaultCopyKnown(member.publicKey) });
        expect(oneWayBackPlace(record, Date.now(), false)).toBe('card');
    });

    it('the reverse: linking Google again makes a fresh copy, listed again since today', async () => {
        const linked = await connect('google');
        expect(linked.error).toBeUndefined();
        const today = new Date().toISOString().slice(0, 10);
        const ways = await listWaysBack(member);
        expect(ways.vault).toEqual({ kind: 'listed', copies: [{ provider: 'google', since: today, lastReleasedAt: null }] });
        expect(wordsOnly(ways)).toBe(false);
        expect(await vaultCopyKnown(member.publicKey)).toBe(true);
    });

    it('a second Google account: the vault keeps a copy for each, the list shows both, and Remove takes both', async () => {
        // "Connect again" signs out of Google and shows its account chooser; the member picks another account. The copy
        // from the test above stays: the vault keeps one per sign-in account.
        h.sub = 'google-sub-another-account';
        try {
            expect((await connect('google')).error).toBeUndefined();
        } finally {
            h.sub = null;
        }
        const today = new Date().toISOString().slice(0, 10);
        const ways = await listWaysBack(member);
        // Both, from the vault's own signed status: on PR #2570 before its review fix, the phone listed one.
        expect(ways.vault).toEqual({ kind: 'listed', copies: [
            { provider: 'google', since: today, lastReleasedAt: null },
            { provider: 'google', since: today, lastReleasedAt: null },
        ] });
        expect(lastSignedStatus()).toMatchObject({ copies: [{ provider: 'google', since: today }, { provider: 'google', since: today }] });

        // The vault removes a sign-in's copies together: one Remove, and it signs that it deleted both.
        expect(await removeVaultCopy(member, 'google')).toEqual({ removed: true });
        const del = exchanges.filter(e => e.path === '/v1/copies/delete').at(-1)!;
        expect(checkVaultAnswer(del.answer?.signed, { ticketKeys: [ticketKey], kinds: ['deleted'], key: member.publicKey, challenge: del.challenge as string }))
            .toMatchObject({ ok: true, answer: { deleted: 2 } });
        expect((await listWaysBack(member)).vault).toEqual({ kind: 'listed', copies: [] });
    });
});
