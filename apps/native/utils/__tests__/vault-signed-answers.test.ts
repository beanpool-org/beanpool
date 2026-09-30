/**
 * The phone acts only on answers BeanPool's key vault signed (PR #1336 review finding 4; utils/vault.ts "Every answer
 * signed"; core vault-wire.ts "Signed answers").
 *
 * Before, only tickets were checked. A server at the vault's address with a valid certificate (a DNS or network
 * attacker, or a fake vault: key vault design §1.4, §7) needed only what the phone sends it (the sub in the restore
 * token, the throwaway key in the request) to:
 * - (a) seal a seed of its own to a restoring phone, under the member's sub, naming the key that seed makes: the phone
 *   saved it (the review measured `restored key is the attacker's: true`);
 * - (b) answer a deposit `{ok: true}` without keeping it: the move card then deleted the community's copy, and
 *   Settings, fed by the same server, showed the member covered.
 *
 * Here fake-vault.ts plays that server: answers with no signature, one by a key the phone doesn't pin, or the vault's
 * real signature over another request, another key or another kind. Each is taken as no answer: nothing saved, nothing
 * deleted, nothing shown as done, and the community keeps its copy. Nothing is contacted.
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

/** The sign-in account each provider's sheet hands back, and the token carrying the nonce it was given. */
const SUBS = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    return {
        ...real,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => ({
            provider, idToken: fakeJwt({ sub: { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' }[provider], nonce }), nonce,
        })),
    };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { openSeedFromSso, openVaultRelease, sealSeedToSso, sealVaultRelease, toEd25519Seed } from '@beanpool/core';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { connectAndDeposit } from '../sso-sheet-connect';
import { disconnectSsoKeeper, vaultProtection } from '../keeper-enrolment';
import { checkSsoRestore, startSsoRestore, waitingSsoRestore } from '../sso-recovery';
import { finishMove, vaultMoveOffer } from '../vault-move';
import { signInAtDoor, submitJoin } from '../global-join';
import {
    approvedHolds, approveVaultHold, stopVaultHold, vaultCopyKnowledge, vaultHoldsAtOpen, vaultStatus, VAULT_MESSAGES,
} from '../vault';
import { protectionFrom } from '../protection-state';
import { COMMUNITY, GLOBAL, HOLD_MS, VAULT, installNetwork, noVault, useVault, type AnswerMode, type Network, type SentRequest } from './fake-vault';

const ANCHOR = 'beanpool_anchor_url';
/** Every way a server at the vault's address can answer without the vault's signature on this request. */
const NOT_THE_VAULTS: AnswerMode[] = ['unsigned', 'forged', 'replayed', 'other_key', 'other_kind'];
const UNVERIFIED = { reason: 'unreachable', code: 'unverified', message: VAULT_MESSAGES.unverified };

let net: Network;
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
    useVault();
    net = installNetwork();
    member = await draftIdentity('Sam');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function memberOnCommunity() {
    await importIdentity(member);
    mem.async.set(ANCHOR, COMMUNITY);
}

function connect(provider: 'google' | 'apple' | 'facebook' = 'google') {
    return connectAndDeposit({ provider, identity: member, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal });
}

/** What the member's own copy is: their seed, sealed to their Google sub. */
async function memberCopyKept() {
    net.vault.keep('google', SUBS.google, member.publicKey,
        await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'google', SUBS.google, { words: member.mnemonic! }));
}

const deletesAtCommunity = () => net.sent.filter(s => s.origin === COMMUNITY && s.method === 'DELETE');
const pastTheHold = () => vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });

describe('(a) a release a server at the vault\'s address sealed itself, naming a key it knows: never saved', () => {
    const attackerSeed = new Uint8Array(32).fill(0x55);
    const attackerKey = bytesToHex(ed25519.getPublicKey(attackerSeed));

    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: sealed to the throwaway key, a copy of its own seed under this sub: refused, nothing saved, the restore still waiting`, async () => {
            // Exactly what the review built from the restore token alone: the sub it names, and the throwaway key.
            net.vault.keep('google', SUBS.google, attackerKey, await sealSeedToSso(attackerSeed, 'google', SUBS.google));
            const held = await startSsoRestore('google');
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/restore/collect'];
            const answered: unknown[] = [];
            const real = net.vault.answer.bind(net.vault);
            net.vault.answer = (req: SentRequest) => {
                const r = real(req);
                if (req.path === '/v1/restore/collect') answered.push(r.body);
                return r;
            };
            pastTheHold();

            await expect(checkSsoRestore()).rejects.toMatchObject(UNVERIFIED);
            expect(await loadIdentity()).toBeNull();
            expect(mem.async.has(ANCHOR)).toBe(false);
            // Taken as no answer: the phone keeps its throwaway key and hold, to collect from the real vault.
            expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId, publicKey: held.publicKey });
            // What it refused was the review's release: it opens with the throwaway key, and its seed makes the key it
            // names, the attacker's. Before the signatures the phone saved exactly this.
            const [body] = answered as { release: unknown }[];
            const opened = openVaultRelease(body.release, hexToBytes(held.privateKey));
            expect(opened.pubkey).toBe(attackerKey);
            expect(bytesToHex(ed25519.getPublicKey((await openSeedFromSso(opened.clientCopy, 'google', SUBS.google)).seed))).toBe(attackerKey);
        });
    }

    it('the member\'s own copy in an unsigned release is not saved either: the phone never reads an unsigned box', async () => {
        await memberCopyKept();
        const held = await startSsoRestore('google');
        net.vault.answers = 'unsigned';
        net.vault.answersOn = ['/v1/restore/collect'];
        pastTheHold();
        await expect(checkSsoRestore()).rejects.toMatchObject(UNVERIFIED);
        expect(await loadIdentity()).toBeNull();
        // The same restore, answered by the vault: it goes through, to this member's key.
        net.vault.answers = 'signed';
        expect(await checkSsoRestore()).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
        expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId });
    });

    it('a release the vault signed whose box is swapped for another: the phone opens only the box the signature covers', async () => {
        await memberCopyKept();
        await startSsoRestore('google');
        pastTheHold();
        const other = await draftIdentity('Kim');
        const real = net.vault.answer.bind(net.vault);
        net.vault.answer = (req: SentRequest) => {
            const r = real(req);
            if (req.path !== '/v1/restore/collect') return r;
            // The server keeps the vault's signed answer but puts a box of its own beside it.
            const body = r.body as Record<string, unknown>;
            const clientCopy = { encryptedShare: '', shareIv: '', shareTag: '', kdfParams: '' };
            return { ...r, body: { ...body, release: sealVaultRelease({ provider: 'google', pubkey: other.publicKey, clientCopy }, req.headers['X-Public-Key']) } };
        };
        expect(await checkSsoRestore()).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
    });

    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: "stopped" or "no such hold" from the server does not make the phone forget its restore`, async () => {
            await memberCopyKept();
            const held = await startSsoRestore('google');
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/restore/collect'];
            const real = net.vault.handle.bind(net.vault);
            for (const fake of [{ status: 200, body: { status: 'stopped' } }, { status: 404, body: { error: 'x', code: 'no_hold' } }]) {
                net.vault.handle = (req: SentRequest) => (req.path === '/v1/restore/collect' ? fake : real(req));
                await expect(checkSsoRestore()).rejects.toMatchObject(UNVERIFIED);
                expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId, publicKey: held.publicKey });
            }
        });
    }

    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: a restore the server says has "no copy" is taken as a lost answer: the key is kept, and the hold comes back`, async () => {
            await memberCopyKept();
            const held = await startSsoRestore('google');
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/restore'];
            const real = net.vault.handle.bind(net.vault);
            net.vault.handle = (req: SentRequest) => (req.path === '/v1/restore' ? { status: 404, body: { error: 'x', code: 'no_copy' } } : real(req));
            await expect(startSsoRestore('google')).rejects.toMatchObject(UNVERIFIED);
            // Not "no copy, nothing waiting": the throwaway key stays, as after an answer that never came.
            expect(await waitingSsoRestore()).toMatchObject({ provider: 'google', publicKey: held.publicKey });
            // So when the vault itself answers, the same sign-in is back at its hold, never "waiting on another phone".
            net.vault.handle = real;
            net.vault.answers = 'signed';
            expect(await startSsoRestore('google')).toMatchObject({ holdId: held.holdId, publicKey: held.publicKey });
        });
    }
});

describe('(b) a deposit a server at the vault\'s address answered {ok: true} and never kept: never counted', () => {
    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: the move fails, the community keeps its copy, and nothing shows the member covered`, async () => {
            await memberOnCommunity();
            net.community.copies.add('google');
            const offer = await vaultMoveOffer(member, COMMUNITY);
            expect(offer).toEqual({ kind: 'move', provider: 'google', communityUrl: COMMUNITY });

            net.vault.keepsDeposits = false;
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/copies'];
            const result = await connect('google');
            // The sheet shows this error and never calls onEnrolled, the only place the card calls finishMove.
            expect(result).toMatchObject({ enrolled: [], failure: 'unreachable', error: VAULT_MESSAGES.unverified });
            expect(result.enrolledSso ?? []).toEqual([]);
            expect(protectionFrom(result).state).toBe('words-only');
            expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');

            // Nothing was deleted at the community, and the card still offers the move.
            expect(deletesAtCommunity()).toEqual([]);
            expect(net.community.copies.has('google')).toBe(true);
            expect(await vaultMoveOffer(member, COMMUNITY)).toEqual(offer);
        });
    }

    it('a receipt the vault signed, but for another copy or another sign-in: refused as well', async () => {
        await memberOnCommunity();
        const real = net.vault.handle.bind(net.vault);
        for (const field of ['copy', 'signIn', 'provider'] as const) {
            net.vault.handle = (req: SentRequest) => {
                const r = real(req) as ReturnType<typeof real> & { says?: { fields: Record<string, unknown> } };
                if (req.path === '/v1/copies' && r.says) r.says = { ...r.says, fields: { ...r.says.fields, [field]: field === 'provider' ? 'facebook' : 'A'.repeat(43) } };
                return r;
            };
            const result = await connect('google');
            expect(result, field).toMatchObject({ enrolled: [], failure: 'unreachable', error: VAULT_MESSAGES.unverified });
        }
    });

    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: a status saying "covered" is not believed: Account Protection can't say, and the card deletes nothing`, async () => {
            await memberOnCommunity();
            net.community.copies.add('google');
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/copies/status'];
            const real = net.vault.handle.bind(net.vault);
            net.vault.handle = (req: SentRequest) => (req.path === '/v1/copies/status'
                ? { status: 200, body: { copies: [{ provider: 'google', lastReleasedAt: null, updatedDay: '2026-10-01' }], holds: [] } }
                : real(req));

            await expect(vaultProtection(member)).rejects.toMatchObject(UNVERIFIED);
            await expect(vaultStatus(member)).rejects.toMatchObject(UNVERIFIED);
            expect(await vaultCopyKnowledge(member.publicKey)).toBe('unknown');
            // A vault that can't say shows no card, and nothing is deleted on its word.
            expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
            expect(deletesAtCommunity()).toEqual([]);
            expect(net.community.copies.has('google')).toBe(true);
        });
    }

    it('an unsigned "none" is not recorded either: the app-open check asks again next time', async () => {
        await memberOnCommunity();
        net.vault.answers = 'unsigned';
        net.vault.answersOn = ['/v1/copies/status'];
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('unknown');
    });

    it('the global door: a join whose deposit came back unsigned joins, with no copy counted', async () => {
        net.vault.keepsDeposits = false;
        net.vault.answers = 'unsigned';
        net.vault.answersOn = ['/v1/copies'];
        const result = await signInAtDoor('google', GLOBAL, member);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin);
        expect(answer.kind).toBe('joined');
        expect((answer as { enrolment?: { enrolledSso?: string[] } | null }).enrolment?.enrolledSso ?? []).toEqual([]);
        expect(await vaultCopyKnowledge(member.publicKey)).not.toBe('kept');
    });
});

describe('Stop, "Yes, it\'s me" and Disconnect: an answer the phone can\'t check is never shown as done', () => {
    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: Stop and "Yes, it's me" fail, nothing is remembered, and the hold is still open at the vault`, async () => {
            await memberOnCommunity();
            await memberCopyKept();
            await startSsoRestore('google');
            const [hold] = (await vaultStatus(member)).holds;
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/holds/cancel', '/v1/holds/approve'];
            // The server says "stopped" without stopping it: the member must not be told it's stopped.
            const real = net.vault.handle.bind(net.vault);
            net.vault.handle = (req: SentRequest) => (req.path === '/v1/holds/cancel' ? { status: 200, body: { status: 'stopped' } } : real(req));
            await expect(stopVaultHold(member, hold.holdId)).rejects.toMatchObject(UNVERIFIED);
            net.vault.handle = real;
            await expect(approveVaultHold(member, hold.holdId)).rejects.toMatchObject(UNVERIFIED);
            expect(await approvedHolds(member.publicKey)).toEqual([]);
            expect(net.vault.holds.get(hold.holdId)).toMatchObject({ cancelled: false });
        });

        it(`${mode}: Disconnect is not reported done`, async () => {
            await memberOnCommunity();
            await connect('google');
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/copies/delete'];
            const real = net.vault.handle.bind(net.vault);
            net.vault.handle = (req: SentRequest) => (req.path === '/v1/copies/delete' ? { status: 200, body: { deleted: 1 } } : real(req));
            expect(await disconnectSsoKeeper('google', member)).toEqual({ success: false, error: VAULT_MESSAGES.unverified });
        });
    }
});

describe('the vault\'s own signed answers still work: the same flows, answered by the vault', () => {
    it('move, status, Stop and a release, each on the vault\'s signature', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        const offer = await vaultMoveOffer(member, COMMUNITY);
        const result = await connect('google');
        expect(result).toMatchObject({ enrolledSso: ['google'] });
        await finishMove(member, offer!);
        expect(net.community.copies.has('google')).toBe(false);
        expect((await vaultProtection(member)).enrolledSso).toEqual(['google']);
        await startSsoRestore('google');
        const [hold] = (await vaultStatus(member)).holds;
        await approveVaultHold(member, hold.holdId);
        expect(await checkSsoRestore()).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
        // Every answer from the vault carried a signature: none of the phone's requests went without a challenge.
        for (const s of net.sent.filter(r => r.origin === VAULT)) expect(s.body.challenge, s.path).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
});
