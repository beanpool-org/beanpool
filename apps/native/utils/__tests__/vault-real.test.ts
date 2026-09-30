/**
 * The phone against BeanPool's real key vault (PR #1336 review finding 4): apps/vault's keyholder and API, from its own
 * test harness, on 127.0.0.1, with stub providers. The signed flow end to end (connect, the move, Account Protection,
 * a restore held, "Yes, it's me", the release, Stop, Disconnect, a locked vault), with every answer the phone acted on
 * checked as signed by the vault's ticket key for its own request. Then a relay at the vault's address in front of
 * the real vault that answers some calls itself, as the review's attacker did: its release and its deposit receipt
 * are refused, and the real vault's answers still go through.
 *
 * Nothing else is contacted: every fetch the phone makes is recorded, and anything but the local vault, the stub global
 * door and the stub community throws. vitest.config.ts points `@beanpool/signin` (the vault API's sign-in checks) at
 * its source.
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
    sub: { google: 'g-sub-1', apple: 'a-sub-1', facebook: 'f-sub-1' } as Record<string, string>,
}));
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return {
        ...real,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => (
            { provider, idToken: h.mint!(provider, h.sub[provider], nonce), nonce }
        )),
    };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkVaultAnswer, openSeedFromSso, openVaultRelease, sealSeedToSso, sealVaultRelease, VAULT_ANSWER_KINDS } from '@beanpool/core';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { connectAndDeposit } from '../sso-sheet-connect';
import { disconnectSsoKeeper, vaultProtection } from '../keeper-enrolment';
import { abandonSsoRestore, checkSsoRestore, finishSsoRestore, startSsoRestore, waitingSsoRestore } from '../sso-recovery';
import { finishMove, vaultMoveOffer } from '../vault-move';
import { approveVaultHold, keepVaultPushTokenCurrent, stopVaultHold, vaultStatus, VAULT_MESSAGES } from '../vault';
import { PUSH_TOKEN_STORE_KEY } from '../storage-keys';

/** apps/vault's harness (src/__tests__/harness.ts), loaded at run time: the phone's typecheck never reads the vault's sources. */
interface VaultUnderTest {
    baseUrl: string;
    stub: { mint(provider: string, claims: { sub: string; nonce: string; now: number }): string };
    restartKeyholder(): Promise<void>;
    close(): Promise<void>;
}
interface Harness {
    startVault(opts: { clock: { now(): number; advance(ms: number): void } }): Promise<VaultUnderTest>;
    doGenesis(v: VaultUnderTest): Promise<{ ticketKey: string; depositKey: string }>;
}
const HARNESS = '../../../vault/src/__tests__/harness';

const COMMUNITY = 'https://a.test';
const ANCHOR = 'beanpool_anchor_url';
const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED = { reason: 'unreachable', code: 'unverified', message: VAULT_MESSAGES.unverified };

let v: VaultUnderTest;
let ticketKey: string;
let member: BeanPoolIdentity;
const realFetch = globalThis.fetch;

interface Exchange { path: string; key: string; challenge: unknown; status: number; answer: Record<string, unknown> | null; relayed: boolean }
/** Every request the phone made to the vault's address, with the answer it got. */
const exchanges: Exchange[] = [];
const elsewhere: string[] = [];
type Relay = (path: string, body: Record<string, unknown>, headers: Record<string, string>) => { status: number; body: unknown } | null;
/** A server at the vault's address in front of the real vault: answers a path itself instead of passing it on. */
let relay: Relay | null = null;
/** The community's old sign-in copies (the move card's), and the deletes it was sent. */
const community = { copies: new Set<string>(), deletes: [] as string[] };

beforeAll(async () => {
    const harness = await import(/* @vite-ignore */ HARNESS) as Harness;
    // The vault's clock is the phone's: a jump past a hold moves both.
    v = await harness.startVault({ clock: { now: () => Date.now(), advance: () => {} } });
    const g = await harness.doGenesis(v);
    ticketKey = g.ticketKey;
    // The phone's build: this vault, and the public keys its genesis made, pinned.
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
            const own = relay?.(path, body, headers) ?? null;
            const res = own
                ? new Response(JSON.stringify(own.body), { status: own.status, headers: { 'Content-Type': 'application/json' } })
                : await realFetch(input, init);
            const answer = await res.clone().json().catch(() => null) as Record<string, unknown> | null;
            exchanges.push({ path, key: headers['X-Public-Key'], challenge: body.challenge, status: res.status, answer, relayed: !!own });
            return res;
        }
        elsewhere.push(`${method} ${url}`);
        const u = new URL(url);
        if (url.startsWith(COMMUNITY) && u.pathname === '/api/recovery/shares/status') {
            return new Response(JSON.stringify({ enrolledSso: [...community.copies] }), { status: 200 });
        }
        const del = /^\/api\/recovery\/shares\/sso\/([a-z]+)$/.exec(u.pathname);
        if (url.startsWith(COMMUNITY) && method === 'DELETE' && del) {
            community.deletes.push(del[1]);
            community.copies.delete(del[1]);
            return new Response(JSON.stringify({ removed: del[1] }), { status: 200 });
        }
        throw new TypeError(`the test contacted ${url}`);
    }) as typeof fetch;

    member = await draftIdentity('Sam');
    await importIdentity(member);
    mem.async.set(ANCHOR, COMMUNITY);
    mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[real-a]');
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
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    relay = null;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const connect = (provider: 'google' | 'facebook' = 'google') =>
    connectAndDeposit({ provider, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal });

/** A hold is over once a day has passed, for the phone and the vault alike. */
const pastTheHold = () => vi.useFakeTimers({ now: Date.now() + DAY + 5_000, toFake: ['Date'] });

/** What the vault signed in its last answer to `path`, checked as the phone checks it: that kind, that key, that request. */
function lastSigned(path: string, kind: (typeof VAULT_ANSWER_KINDS)[number]) {
    const x = exchanges.filter(e => e.path === path && !e.relayed).at(-1)!;
    const check = checkVaultAnswer(x.answer?.signed, { ticketKeys: [ticketKey], kinds: [kind], key: x.key, challenge: x.challenge as string });
    if (!check.ok) throw new Error(`${path}: the answer the phone acted on was not the vault's signed ${kind} (${check.reason})`);
    return check.answer;
}

describe('the signed flow, end to end, against the real vault', () => {
    it('the move: connect deposits on the vault\'s signed receipt, then the community\'s copy is deleted; Account Protection reads a signed status', async () => {
        community.copies.add('google');
        const offer = await vaultMoveOffer(member, COMMUNITY);
        expect(offer).toEqual({ kind: 'move', provider: 'google', communityUrl: COMMUNITY });
        const r = await connect('google');
        expect(r.error).toBeUndefined();
        expect(r.enrolledSso).toEqual(['google']);
        await finishMove(member, offer!);
        expect(community.deletes).toEqual(['google']);
        expect((await vaultProtection(member)).enrolledSso).toEqual(['google']);

        const deposit = exchanges.find(x => x.path === '/v1/copies')!;
        const receipt = checkVaultAnswer(deposit.answer?.signed, { ticketKeys: [ticketKey], kinds: ['receipt'], key: member.publicKey, challenge: deposit.challenge as string });
        expect(receipt).toMatchObject({ ok: true, answer: { kind: 'receipt', provider: 'google', replaced: false } });
    });

    it('a restore: held, "Yes, it\'s me", then the signed release opens to this key and its words, and is saved', async () => {
        const held = await startSsoRestore('google');
        expect(held.holdId).toEqual(expect.any(String));
        expect(await checkSsoRestore()).toMatchObject({ status: 'held' });
        const [hold] = (await vaultStatus(member)).holds;
        expect(hold.holdId).toBe(held.holdId);
        await approveVaultHold(member, hold.holdId);
        const collected = await checkSsoRestore();
        if (collected?.status !== 'released') throw new Error(`expected released, got ${JSON.stringify(collected)}`);
        expect(collected.restored.publicKey).toBe(member.publicKey);
        expect(collected.restored.mnemonic).toEqual(member.mnemonic);
        const saved = await finishSsoRestore(collected.restored, COMMUNITY, { nameOnNode: async () => 'Sam' });
        expect(saved.publicKey).toBe(member.publicKey);
        expect(await waitingSsoRestore()).toBeNull();

        const release = exchanges.filter(x => x.path === '/v1/restore/collect').at(-1)!;
        expect(checkVaultAnswer(release.answer?.signed, { ticketKeys: [ticketKey], kinds: ['release'], key: held.publicKey, challenge: release.challenge as string }))
            .toMatchObject({ ok: true, answer: { kind: 'release', provider: 'google', pubkey: member.publicKey } });
    });

    it('Stop on the member\'s phone: the restoring phone is told "stopped", on the vault\'s signature', async () => {
        await startSsoRestore('google');
        const [hold] = (await vaultStatus(member)).holds;
        await stopVaultHold(member, hold.holdId);
        expect(lastSigned('/v1/holds/cancel', 'hold')).toMatchObject({ status: 'stopped', key: member.publicKey });
        expect(await checkSsoRestore()).toEqual({ status: 'stopped' });
        expect(lastSigned('/v1/restore/collect', 'collect')).toMatchObject({ status: 'stopped' });
        expect(await waitingSsoRestore()).toBeNull();
    });

    it('with no answer from any device, it goes through after a day', async () => {
        const held = await startSsoRestore('google');
        expect(lastSigned('/v1/restore', 'restore')).toMatchObject({ status: 'held', holdId: held.holdId, key: held.publicKey });
        expect(await checkSsoRestore()).toMatchObject({ status: 'held' });
        expect(lastSigned('/v1/restore/collect', 'collect')).toMatchObject({ status: 'held', until: held.until });
        pastTheHold();
        expect(await checkSsoRestore()).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
        expect(lastSigned('/v1/restore/collect', 'release')).toMatchObject({ pubkey: member.publicKey, key: held.publicKey });
        vi.useRealTimers();
        await abandonSsoRestore();
    });

    it('a changed push token is given to the vault, and recorded as given only on its signed answer', async () => {
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[real-b]');
        const before = exchanges.filter(x => x.path === '/v1/push-token').length;
        await keepVaultPushTokenCurrent(member);
        await keepVaultPushTokenCurrent(member);
        expect(exchanges.filter(x => x.path === '/v1/push-token').length).toBe(before + 1);
        expect(lastSigned('/v1/push-token', 'push-token')).toMatchObject({ updated: 1, key: member.publicKey });
    });

    it('Disconnect deletes the copy on the vault\'s signed answer; a restore then gets its signed "no copy"', async () => {
        await connect('facebook');
        expect(await disconnectSsoKeeper('facebook', member)).toEqual({ success: true, enrolledSso: ['google'] });
        expect(lastSigned('/v1/copies/delete', 'deleted')).toMatchObject({ deleted: 1 });
        await expect(startSsoRestore('facebook')).rejects.toMatchObject({ reason: 'no_copy', message: VAULT_MESSAGES.noCopy });
        expect(lastSigned('/v1/restore', 'refusal')).toMatchObject({ status: 404, code: 'no_copy' });
        expect(await waitingSsoRestore()).toBeNull();
    });
});

describe('a relay at the vault\'s address, in front of the real vault', () => {
    it('its own release, sealed to the throwaway key with a seed it knows under this sub: refused; the vault\'s release then restores the member', async () => {
        const attackerSeed = new Uint8Array(32).fill(0x55);
        const attackerKey = bytesToHex(ed25519.getPublicKey(attackerSeed));
        const attackerCopy = await sealSeedToSso(attackerSeed, 'google', h.sub.google);
        const held = await startSsoRestore('google');
        pastTheHold();
        // The relay passes the tickets and the restore to the vault, so the pinned-key checks pass, and answers the
        // collect itself: everything it needs was in the phone's requests.
        relay = (path, _body, headers) => (path === '/v1/restore/collect'
            ? { status: 200, body: { status: 'released', release: sealVaultRelease({ provider: 'google', pubkey: attackerKey, clientCopy: attackerCopy }, headers['X-Public-Key']) } }
            : null);
        await expect(checkSsoRestore()).rejects.toMatchObject(UNVERIFIED);
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
        expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId });
        // What it offered would have opened, to the attacker's key: the phone before this change saved it.
        const offered = exchanges.filter(x => x.relayed).at(-1)!.answer as { release: unknown };
        const opened = openVaultRelease(offered.release, hexToBytes(held.privateKey));
        expect(opened.pubkey).toBe(attackerKey);
        expect(bytesToHex(ed25519.getPublicKey((await openSeedFromSso(opened.clientCopy, 'google', h.sub.google)).seed))).toBe(attackerKey);

        relay = null;
        expect(await checkSsoRestore()).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
        await abandonSsoRestore();
    });

    it('its own {ok: true} for a deposit it never passed on: the move fails, the community keeps its copy, the vault has none', async () => {
        community.copies.add('facebook');
        const offer = await vaultMoveOffer(member, COMMUNITY);
        expect(offer).toEqual({ kind: 'move', provider: 'facebook', communityUrl: COMMUNITY });
        relay = path => (path === '/v1/copies' ? { status: 200, body: { ok: true, provider: 'facebook', replaced: false } } : null);
        const r = await connect('facebook');
        expect(r).toMatchObject({ enrolled: [], failure: 'unreachable', error: VAULT_MESSAGES.unverified });
        relay = null;
        expect(community.copies.has('facebook')).toBe(true);
        expect(community.deletes).toEqual(['google']);
        expect((await vaultProtection(member)).enrolledSso).toEqual(['google']);
        expect(await vaultMoveOffer(member, COMMUNITY)).toEqual(offer);
    });

    it('its "stopped" for a Stop it never passed on: not shown as stopped, and the hold is still open at the vault', async () => {
        const held = await startSsoRestore('google');
        relay = path => (path === '/v1/holds/cancel' ? { status: 200, body: { status: 'stopped' } } : null);
        await expect(stopVaultHold(member, held.holdId!)).rejects.toMatchObject(UNVERIFIED);
        relay = null;
        expect((await vaultStatus(member)).holds.map(x => x.holdId)).toEqual([held.holdId]);
        await stopVaultHold(member, held.holdId!);
        expect(await checkSsoRestore()).toEqual({ status: 'stopped' });
    });
});

describe('a locked vault, and what the phone saw', () => {
    // A guard, not a change: a locked vault can't sign, and a 503 is never acted on, so the paused path is main's.
    it('a restarted (locked) keyholder: the paused words, nothing linked or saved', async () => {
        await v.restartKeyholder();
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'locked', message: VAULT_MESSAGES.paused });
        expect(await connect('google')).toMatchObject({ enrolled: [], failure: 'locked', error: VAULT_MESSAGES.pausedConnect });
        await expect(vaultStatus(member)).rejects.toMatchObject({ reason: 'locked' });
    });

    it('every answer the phone acted on was the vault\'s, signed for its own request; nothing went anywhere else', () => {
        const fromVault = exchanges.filter(x => !x.relayed);
        expect(fromVault.length).toBeGreaterThan(20);
        const kinds = new Set<string>();
        for (const x of fromVault) {
            expect(x.challenge, x.path).toMatch(/^[A-Za-z0-9_-]{43}$/);
            // A ticket answers for itself; a locked vault's 503 is never acted on.
            if ((x.path === '/v1/ticket' && x.status === 200) || x.status >= 500) continue;
            const check = checkVaultAnswer(x.answer?.signed, { ticketKeys: [ticketKey], kinds: VAULT_ANSWER_KINDS, key: x.key, challenge: x.challenge as string });
            expect(check.ok, `${x.path} ${x.status}`).toBe(true);
            if (check.ok) kinds.add(check.answer.kind);
        }
        expect([...kinds].sort()).toEqual(['collect', 'deleted', 'hold', 'push-token', 'receipt', 'refusal', 'release', 'restore', 'status']);
        expect(elsewhere.every(u => u.includes(COMMUNITY))).toBe(true);
    });
});
