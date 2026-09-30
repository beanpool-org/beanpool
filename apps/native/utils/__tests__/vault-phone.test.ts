/**
 * The phone and BeanPool's key vault (utils/vault.ts; key vault design §8, V4 row). Every test there:
 *
 * - A fetch spy, with the phone's community at `https://a.test`: no request to it carries `idToken`, `proof`, `shares`
 *   or `recovery`, or asks for a nonce, and every ticket and deposit goes to the vault.
 * - A ticket with a bad signature, or naming another key: no provider sheet opens.
 * - A release whose seed makes a different key than the one it names: nothing saved.
 * - The vault locked: the paused message, nothing saved.
 * - The move card: a copy at the community and none at the vault → the card, then a signed DELETE at `a.test`, after
 *   the deposit.
 * - The global door: one provider sheet for the join and the copy; the vault down → joined without a copy.
 *
 * Nothing is contacted: fake-vault.ts plays the vault (with core's real tickets, boxes and releases, and the vault's
 * own signature check for its host), the community and the global door, and refuses any other address. The providers'
 * sheets are stubbed (`signInWithProvider`) and counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
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

/** The sign-in account each provider's sheet hands back, and the token carrying the nonce it was given. */
const SUBS = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const sheet = (provider: 'google' | 'apple' | 'facebook') => vi.fn(async (nonce: string) => ({
        idToken: fakeJwt({ sub: { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' }[provider], nonce }), nonce,
    }));
    return {
        ...real,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => ({
            provider, idToken: fakeJwt({ sub: { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' }[provider], nonce }), nonce,
        })),
        // A build without a vault reaches each provider's sheet directly at the global door, as before the vault.
        signInWithGoogle: sheet('google'),
        signInWithApple: sheet('apple'),
        signInWithFacebook: sheet('facebook'),
    };
});

import { openSeedFromSso, sealSeedToSso, toEd25519Seed, vaultTicketNonce } from '@beanpool/core';
import { signInWithProvider } from '../sso-signin';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { connectAndDeposit } from '../sso-sheet-connect';
import { disconnectSsoKeeper, vaultProtection } from '../keeper-enrolment';
import {
    abandonSsoRestore, checkSsoRestore, finishSsoRestore, startSsoRestore, stopSsoRestoreAfterWords, waitingSsoRestore,
} from '../sso-recovery';
import { finishMove, moveLater, vaultMoveOffer, COMMUNITY_TIMEOUT_MS, MOVE_AGAIN_AFTER_MS } from '../vault-move';
import { signInAtDoor, submitJoin } from '../global-join';
import {
    approveVaultHold, connectWanted, holdEndsText, keepVaultPushTokenCurrent, readVaultConfig, rememberConnectWanted, stopVaultHold,
    takeHoldsToShow, vaultCopyKnown,
    vaultHoldsAtOpen, vaultStatus, VAULT_MESSAGES, VaultError,
} from '../vault';
import { PUSH_TOKEN_STORE_KEY, VAULT_RESTORE_STORE_KEY } from '../storage-keys';
import { protectionFrom } from '../protection-state';
import { boundSignatureValid } from './server-signature-check';
import {
    COMMUNITY, DEPOSIT_KEY, GLOBAL, HOLD_MS, TICKET_KEY, VAULT,
    installNetwork, keysIn, noVault, useVault, type Network, type SentRequest,
} from './fake-vault';

const ANCHOR = 'beanpool_anchor_url';
/** What must never reach a community: what opens a key, or proves a sign-in. */
const NEVER_TO_A_COMMUNITY = ['idToken', 'proof', 'shares', 'recovery'];

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
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: quietened.
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

/** The member's phone: this key, on the community at a.test. */
async function memberOnCommunity() {
    await importIdentity(member);
    mem.async.set(ANCHOR, COMMUNITY);
}

function connect(provider: 'google' | 'apple' | 'facebook' = 'google', identity = member) {
    return connectAndDeposit({ provider, identity, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal });
}

const to = (origin: string) => net.sent.filter(s => s.origin === origin);
const paths = (origin: string) => to(origin).map(s => `${s.method} ${s.path}`);

/** The member's key's seed, as the copy must give it back. */
const seedHex = (id: BeanPoolIdentity) => Buffer.from(toEd25519Seed(hexToBytes(id.privateKey))).toString('hex');

describe("the build's vault", () => {
    it('reads an address and the pinned keys, and nothing malformed', () => {
        expect(readVaultConfig(`${VAULT}/`, TICKET_KEY, DEPOSIT_KEY)).toEqual({ url: VAULT, ticketKeys: [TICKET_KEY], depositKeys: [DEPOSIT_KEY] });
        expect(readVaultConfig(VAULT, ` ${TICKET_KEY}, ${'ab'.repeat(32)} `, DEPOSIT_KEY)?.ticketKeys).toEqual([TICKET_KEY, 'ab'.repeat(32)]);
        expect(readVaultConfig(undefined, TICKET_KEY, DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig('http://vault.example.org', TICKET_KEY, DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig(`${VAULT}/v1`, TICKET_KEY, DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig('https://user@vault.test', TICKET_KEY, DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig(VAULT, '', DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig(VAULT, TICKET_KEY.toUpperCase(), DEPOSIT_KEY)).toBeNull();
        expect(readVaultConfig(VAULT, TICKET_KEY, 'not-a-key')).toBeNull();
        // A test vault on a laptop, over plain http on a private address, is allowed.
        expect(readVaultConfig('http://10.0.2.2:8787', TICKET_KEY, DEPOSIT_KEY)?.url).toBe('http://10.0.2.2:8787');
    });

    it('a build with no vault asks no vault: its sign-in copies stay at the community (release-gate.test.ts)', async () => {
        noVault();
        await memberOnCommunity();
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'not_configured' });
        expect(signInWithProvider).not.toHaveBeenCalled();
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
        expect(to(VAULT)).toEqual([]);
    });
});

describe('with the community at https://a.test, nothing that opens a key goes there (fetch spy)', () => {
    it('connect, the move, a restore, the hold, disconnect and the status check: every ticket and deposit goes to the vault', async () => {
        await memberOnCommunity();
        net.community.copies.add('facebook');

        // Connect Google (Account Protection).
        expect(await connect('google')).toMatchObject({ enrolledSso: ['google'] });
        // The move card: Facebook's copy at a.test, none at the vault.
        const offer = await vaultMoveOffer(member, COMMUNITY);
        expect(offer).toEqual({ kind: 'move', provider: 'facebook', communityUrl: COMMUNITY });
        expect(await connect('facebook')).toMatchObject({ enrolledSso: ['facebook'] });
        await finishMove(member, offer!);
        // A restore on a new phone, let through from this one, and saved onto a.test.
        const held = await startSsoRestore('google');
        const [hold] = (await vaultStatus(member)).holds;
        expect(hold.holdId).toBe(held.holdId);
        await approveVaultHold(member, hold.holdId);
        const collected = await checkSsoRestore();
        if (collected?.status !== 'released') throw new Error('expected a release');
        mem.async.clear();
        await finishSsoRestore(collected.restored, COMMUNITY, { nameOnNode: async () => 'Sam' });
        // Disconnect, and the status check at app open.
        expect(await disconnectSsoKeeper('facebook', member)).toMatchObject({ success: true, enrolledSso: ['google'] });
        await vaultHoldsAtOpen(member);

        // a.test was asked for its status and told to delete its copy. Nothing else, and nothing that opens a key.
        expect(paths(COMMUNITY)).toEqual(['POST /api/recovery/shares/status', 'DELETE /api/recovery/shares/sso/facebook']);
        for (const s of to(COMMUNITY)) {
            expect([...keysIn(s.body)].filter(k => NEVER_TO_A_COMMUNITY.includes(k)), s.path).toEqual([]);
            expect(s.path).not.toMatch(/nonce|\/collect|\/shares\/sso$/);
        }
        // Every ticket, deposit, sign-in and release is the vault's, and signed for it.
        for (const s of net.sent.filter(r => keysIn(r.body).has('idToken') || keysIn(r.body).has('box') || r.path === '/v1/ticket')) {
            expect(s.origin, s.path).toBe(VAULT);
        }
        expect(to(VAULT).filter(s => s.path === '/v1/ticket')).toHaveLength(3);
        expect(to(VAULT).filter(s => s.path === '/v1/copies')).toHaveLength(2);
        for (const s of to(VAULT)) expect(s.headers['X-Signed-For']).toBe('vault.test');
        // The account is back on the phone.
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
    });

    it('a request signed for a community is refused by the vault: the phone signs vault requests for the vault', async () => {
        await memberOnCommunity();
        await connect('google');
        const deposit = to(VAULT).find(s => s.path === '/v1/copies')!;
        expect(boundSignatureValid({ url: deposit.url, method: 'POST', headers: deposit.headers, body: deposit.raw }, member.publicKey)).toBe(true);
        const asIfForA = { url: `${COMMUNITY}/v1/copies`, method: 'POST', headers: deposit.headers, body: deposit.raw };
        expect(boundSignatureValid(asIfForA, member.publicKey)).toBe(false);
    });
});

describe('a ticket that is not the vault\'s, or not for this key: no provider sheet opens', () => {
    for (const mode of ['forged', 'other_key'] as const) {
        it(`${mode === 'forged' ? 'signed by a key the phone does not pin' : 'naming another key'}: connect`, async () => {
            await memberOnCommunity();
            net.vault.tickets = mode;
            const result = await connect('google');
            expect(result).toMatchObject({ enrolled: [], failure: 'bad_ticket', error: VAULT_MESSAGES.badTicket });
            expect(signInWithProvider).not.toHaveBeenCalled();
            expect(paths(VAULT)).toEqual(['POST /v1/ticket']);
        });

        it(`${mode === 'forged' ? 'signed by a key the phone does not pin' : 'naming another key'}: restore`, async () => {
            net.vault.tickets = mode;
            await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'bad_ticket' });
            expect(signInWithProvider).not.toHaveBeenCalled();
            expect(paths(VAULT)).toEqual(['POST /v1/ticket']);
            expect(mem.secure.has(VAULT_RESTORE_STORE_KEY)).toBe(false);
        });

        it(`${mode === 'forged' ? 'signed by a key the phone does not pin' : 'naming another key'}: the global door signs in with its own nonce, never the ticket's`, async () => {
            net.vault.tickets = mode;
            const result = await signInAtDoor('google', GLOBAL, member);
            if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
            expect(signInWithProvider).toHaveBeenCalledTimes(1);
            expect(signInWithProvider).toHaveBeenCalledWith('google', net.global.nonce);
            expect(result.signin.vaultTicket).toBeUndefined();
        });
    }
});

describe("a release whose seed makes another key than the one it names: nothing saved", () => {
    it('refused as the wrong account, and the phone keeps no account and no community', async () => {
        net.vault.keep('google', SUBS.google, member.publicKey, await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'google', SUBS.google));
        net.vault.releaseNamesOtherKey = true;
        await startSsoRestore('google');
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });

        await expect(checkSsoRestore()).rejects.toMatchObject({ reason: 'wrong_account', message: VAULT_MESSAGES.wrongAccount });
        expect(await loadIdentity()).toBeNull();
        expect(mem.async.has(ANCHOR)).toBe(false);
    });

    it('the same copy, named honestly, restores this key', async () => {
        net.vault.keep('google', SUBS.google, member.publicKey, await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'google', SUBS.google));
        await startSsoRestore('google');
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        const collected = await checkSsoRestore();
        expect(collected).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey, provider: 'google' } });
    });
});

describe('the vault locked: the paused message, nothing saved', () => {
    it('connect: nothing linked, the paused words, and the sign-in offered again at the next open', async () => {
        await memberOnCommunity();
        net.vault.locked = true;
        const result = await connect('google');
        expect(result).toMatchObject({ enrolled: [], failure: 'locked', error: VAULT_MESSAGES.pausedConnect });
        expect(protectionFrom(result).state).toBe('words-only');
        expect(signInWithProvider).not.toHaveBeenCalled();
        expect(await connectWanted(member.publicKey)).toEqual(['google']);

        net.vault.locked = false;
        expect(await vaultMoveOffer(member, COMMUNITY)).toEqual({ kind: 'retry', provider: 'google' });
        await connect('google');
        expect(await connectWanted(member.publicKey)).toEqual([]);
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
    });

    it('restore: the paused words, no sheet, and nothing on the phone', async () => {
        net.vault.locked = true;
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'locked', message: VAULT_MESSAGES.paused });
        expect(signInWithProvider).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();
        expect(await waitingSsoRestore()).toBeNull();
    });

    it('locked while a restore waits: the paused words, nothing saved, and the restore still waiting', async () => {
        net.vault.keep('google', SUBS.google, member.publicKey, await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'google', SUBS.google));
        const held = await startSsoRestore('google');
        net.vault.locked = true;
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        await expect(checkSsoRestore()).rejects.toMatchObject({ reason: 'locked', message: VAULT_MESSAGES.paused });
        expect(await loadIdentity()).toBeNull();
        expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId });
        net.vault.locked = false;
        expect(await checkSsoRestore()).toMatchObject({ status: 'released' });
    });

    it('the status check at app open: nothing shown, and it never throws', async () => {
        net.vault.locked = true;
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
        net.vault.locked = false;
        net.vault.unreachable = true;
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
    });
});

describe('the move card', () => {
    it('a copy at the community and none at the vault: the card, and a signed DELETE at a.test only after the deposit', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        const offer = await vaultMoveOffer(member, COMMUNITY);
        expect(offer).toEqual({ kind: 'move', provider: 'google', communityUrl: COMMUNITY });

        const result = await connect('google');
        expect(result.error).toBeUndefined();
        await finishMove(member, offer!);

        const order = net.sent.map(s => `${s.origin === VAULT ? 'vault' : s.origin === COMMUNITY ? 'a.test' : s.origin} ${s.method} ${s.path}`);
        const deposit = order.indexOf('vault POST /v1/copies');
        const del = order.indexOf('a.test DELETE /api/recovery/shares/sso/google');
        expect(deposit).toBeGreaterThan(-1);
        expect(del).toBeGreaterThan(deposit);
        const sent = net.sent[del];
        expect(sent.headers['X-Public-Key']).toBe(member.publicKey);
        expect(boundSignatureValid({ url: sent.url, method: 'DELETE', headers: sent.headers, body: sent.raw }, member.publicKey)).toBe(true);
        expect(net.community.copies.has('google')).toBe(false);
        // Moved: the vault has it, the community doesn't, and the card is gone.
        expect(net.vault.copiesOf(member.publicKey).map(c => c.provider)).toEqual(['google']);
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
    });

    it('no deposit, no delete: a move whose connect failed leaves the community its copy', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        net.vault.locked = true;
        const result = await connect('google');
        expect(result.failure).toBe('locked');
        expect(paths(COMMUNITY).filter(p => p.startsWith('DELETE'))).toEqual([]);
        expect(net.community.copies.has('google')).toBe(true);
    });

    it('"Not now" puts it away for a week; then it comes back', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        const now = Date.now();
        await moveLater(member, now);
        expect(await vaultMoveOffer(member, COMMUNITY, now + MOVE_AGAIN_AFTER_MS - 1)).toBeNull();
        expect(await vaultMoveOffer(member, COMMUNITY, now + MOVE_AGAIN_AFTER_MS + 1)).toMatchObject({ kind: 'move', provider: 'google' });
    });

    it('a delete that does not land is tried again when the card next looks, and only for a copy this phone moved', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        net.community.copies.add('facebook');
        const offer = (await vaultMoveOffer(member, COMMUNITY))!;
        expect(offer).toMatchObject({ provider: 'google' });
        await connect('google');
        const realHandle = net.community.handle.bind(net.community);
        net.community.handle = () => ({ status: 503, body: {} });
        await finishMove(member, offer);
        expect(net.community.copies.has('google')).toBe(true);

        net.community.handle = realHandle;
        // Facebook, linked at the vault some other way, is never deleted from the community by the card.
        await connect('facebook');
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
        expect(net.community.copies.has('google')).toBe(false);
        expect(net.community.copies.has('facebook')).toBe(true);
    });

    it('Apple is not offered on a phone that cannot sign in with Apple', async () => {
        await memberOnCommunity();
        net.community.copies.add('apple');
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
    });

    it('a community that never answers holds nothing back: after its wait, the card still offers a paused link', async () => {
        await memberOnCommunity();
        await rememberConnectWanted(member.publicKey, 'google');
        const network = globalThis.fetch;
        globalThis.fetch = ((input: any, init?: any) => (String(input).startsWith(COMMUNITY)
            ? new Promise<Response>(() => {})
            : network(input, init))) as typeof fetch;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let settled = false;
        const offer = vaultMoveOffer(member, COMMUNITY).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(COMMUNITY_TIMEOUT_MS - 1_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await offer).toEqual({ kind: 'retry', provider: 'google' });
    });

    it('a vault that cannot say shows no card', async () => {
        await memberOnCommunity();
        net.community.copies.add('google');
        net.vault.unreachable = true;
        expect(await vaultMoveOffer(member, COMMUNITY)).toBeNull();
    });
});

describe("the global door: one provider sheet for the join and the copy", () => {
    it("a vault ticket for the joining key: the join carries it, and the copy goes to the vault with the same sign-in", async () => {
        const result = await signInAtDoor('google', GLOBAL, member);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        const ticket = result.signin.vaultTicket!;
        expect(signInWithProvider).toHaveBeenCalledTimes(1);
        expect(signInWithProvider).toHaveBeenCalledWith('google', vaultTicketNonce(ticket));

        await importIdentity({ ...member, callsign: 'Sam' });
        const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin);
        expect(answer).toMatchObject({ kind: 'joined', enrolment: { enrolledSso: ['google'], wordsSealed: true } });
        expect(protectionFrom(answer.kind === 'joined' ? answer.enrolment : null).state).toBe('covered');
        expect(signInWithProvider).toHaveBeenCalledTimes(1);

        const join = to(GLOBAL).find(s => s.path === '/api/join')!;
        expect(Object.keys(join.body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider', 'vaultTicket']);
        expect(join.body).toMatchObject({ vaultTicket: ticket, nonce: vaultTicketNonce(ticket) });
        const deposit = to(VAULT).find(s => s.path === '/v1/copies')!;
        expect(deposit.body).toMatchObject({ ticket, provider: 'google', idToken: join.body.idToken });
        expect(net.sent.map(s => `${s.origin} ${s.path}`)).toEqual([
            `${GLOBAL} /api/join/sso-nonce`, `${VAULT} /v1/ticket`, `${GLOBAL} /api/join`, `${VAULT} /v1/copies`,
        ]);
        // The copy at the vault gives back this key and its 12 words, with this sign-in only.
        const [copy] = net.vault.copiesOf(member.publicKey);
        const opened = await openSeedFromSso(copy.clientCopy, 'google', SUBS.google);
        expect(Buffer.from(opened.seed).toString('hex')).toBe(seedHex(member));
        expect(opened.words).toEqual(member.mnemonic);
    });

    for (const down of ['unreachable', 'locked'] as const) {
        it(`the vault ${down}: one sheet with the door's own nonce, joined, and no copy anywhere`, async () => {
            net.vault[down] = true;
            const result = await signInAtDoor('google', GLOBAL, member);
            if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
            expect(signInWithProvider).toHaveBeenCalledTimes(1);
            expect(signInWithProvider).toHaveBeenCalledWith('google', net.global.nonce);
            const answer = await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin);
            expect(answer).toMatchObject({ kind: 'joined', enrolment: null });
            const join = to(GLOBAL).find(s => s.path === '/api/join')!;
            expect(Object.keys(join.body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider']);
            expect(to(VAULT).filter(s => s.path === '/v1/copies')).toEqual([]);
        });
    }

    it('a build with no vault joins with the door\'s nonce and the copy in the join, as before the vault, and asks no vault', async () => {
        noVault();
        const result = await signInAtDoor('google', GLOBAL, member);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        expect(result.signin).toMatchObject({ nonce: net.global.nonce });
        expect(result.signin.vaultTicket).toBeUndefined();
        expect(await submitJoin(GLOBAL, { ...member, callsign: 'Sam' }, 'Sam', result.signin)).toMatchObject({ kind: 'joined' });
        const join = to(GLOBAL).find(s => s.path === '/api/join')!;
        expect(Object.keys(join.body).sort()).toEqual(['callsign', 'idToken', 'nonce', 'provider', 'recovery']);
        expect(to(VAULT)).toEqual([]);
    });
});

describe('a sign-in restore: no name, no address, and every one waits (D2)', () => {
    async function kept(words = true) {
        net.vault.keep('google', SUBS.google, member.publicKey,
            await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'google', SUBS.google, { words: words ? member.mnemonic! : null }));
    }

    it('held, then let through by "Yes, it\'s me" on the member\'s phone, then saved onto the global community', async () => {
        await kept();
        const held = await startSsoRestore('google');
        expect(held).toMatchObject({ provider: 'google', sub: SUBS.google, holdId: expect.any(String) });
        expect(held.until).toBeGreaterThan(Date.now() + HOLD_MS - 60_000);
        // Nothing asked of a community, and no name typed.
        expect(to(COMMUNITY)).toEqual([]);
        expect(await checkSsoRestore()).toMatchObject({ status: 'held' });

        const [hold] = (await vaultStatus(member)).holds;
        await approveVaultHold(member, hold.holdId);
        const collected = await checkSsoRestore();
        if (collected?.status !== 'released') throw new Error('expected a release');
        expect(collected.restored).toMatchObject({ publicKey: member.publicKey, mnemonic: member.mnemonic });

        const saved = await finishSsoRestore(collected.restored, GLOBAL, { nameOnNode: async () => 'Sam' });
        expect(saved).toMatchObject({ publicKey: member.publicKey, callsign: 'Sam', mnemonic: member.mnemonic });
        expect(mem.async.get(ANCHOR)).toBe(GLOBAL);
        expect(await waitingSsoRestore()).toBeNull();
    });

    it('goes through by itself once the day is up', async () => {
        await kept(false);
        await startSsoRestore('google');
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        const collected = await checkSsoRestore();
        expect(collected).toMatchObject({ status: 'released', restored: { publicKey: member.publicKey } });
        if (collected?.status === 'released') expect(collected.restored.mnemonic).toBeUndefined();
    });

    it('Stop on the member\'s phone: never released, and the restoring phone stops waiting', async () => {
        await kept();
        await startSsoRestore('google');
        const [hold] = (await vaultStatus(member)).holds;
        await stopVaultHold(member, hold.holdId);
        vi.useFakeTimers({ now: Date.now() + HOLD_MS + 1000, toFake: ['Date'] });
        expect(await checkSsoRestore()).toEqual({ status: 'stopped' });
        expect(await waitingSsoRestore()).toBeNull();
        expect(await loadIdentity()).toBeNull();
    });

    it('no copy for this sign-in: the vault\'s words, and nothing waiting', async () => {
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'no_copy' });
        expect(await waitingSsoRestore()).toBeNull();
    });

    it('a restore whose answer was lost keeps its throwaway key, and the next try uses it again', async () => {
        await kept();
        const realHandle = net.vault.handle.bind(net.vault);
        net.vault.handle = (req: SentRequest) => {
            if (req.path === '/v1/restore') throw new TypeError('Network request failed');
            return realHandle(req);
        };
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'unreachable' });
        const lost = await waitingSsoRestore();
        expect(lost).toMatchObject({ holdId: null, provider: 'google' });

        net.vault.handle = realHandle;
        const held = await startSsoRestore('google');
        expect(held.publicKey).toBe(lost!.publicKey);
        expect(held.holdId).toEqual(expect.any(String));
    });

    it('"Start again" with the same sign-in comes back to the same hold, never "waiting on another phone"', async () => {
        await kept();
        const held = await startSsoRestore('google');
        // Start again (welcome.tsx) leaves the restore on the phone; the member signs in with Google again.
        const again = await startSsoRestore('google');
        expect(again).toMatchObject({ holdId: held.holdId, publicKey: held.publicKey, until: held.until });
        expect((await vaultStatus(member)).holds).toHaveLength(1);
        expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId });
    });

    it('another sign-in in between keeps the key: the first sign-in still comes back to its own hold', async () => {
        await kept();
        net.vault.keep('facebook', SUBS.facebook, member.publicKey,
            await sealSeedToSso(toEd25519Seed(hexToBytes(member.privateKey)), 'facebook', SUBS.facebook));
        const first = await startSsoRestore('google');
        const second = await startSsoRestore('facebook');
        expect(second.publicKey).toBe(first.publicKey);
        expect(second.holdId).not.toBe(first.holdId);
        expect(await startSsoRestore('google')).toMatchObject({ holdId: first.holdId });
    });

    it('a sign-in the vault has no copy for does not lose the key of a hold already waiting', async () => {
        await kept();
        const held = await startSsoRestore('google');
        await expect(startSsoRestore('facebook')).rejects.toMatchObject({ reason: 'no_copy' });
        expect(await waitingSsoRestore()).toMatchObject({ provider: 'google', holdId: held.holdId, publicKey: held.publicKey });
        expect(await checkSsoRestore()).toMatchObject({ status: 'held' });
    });

    it('"Use my 12 words instead": once the words bring the account back, its own key stops the hold it left, and the phone forgets it', async () => {
        await kept();
        const held = await startSsoRestore('google');
        // The words restore saves the member's account on this phone; then the phone tidies up (welcome.tsx).
        await stopSsoRestoreAfterWords(member);
        expect(net.vault.holds.get(held.holdId!)?.cancelled).toBe(true);
        expect((await vaultStatus(member)).holds).toEqual([]);
        expect(await waitingSsoRestore()).toBeNull();
    });

    it('the words brought back a different account: the hold is not that key\'s to stop, and stays on record', async () => {
        await kept();
        const held = await startSsoRestore('google');
        const someoneElse = await draftIdentity('Kim');
        await stopSsoRestoreAfterWords(someoneElse);
        expect(net.vault.holds.get(held.holdId!)?.cancelled).toBe(false);
        expect(await waitingSsoRestore()).toMatchObject({ holdId: held.holdId });
    });

    it('the welcome screen\'s Start again and "Use my 12 words instead" keep the restore\'s key; a words restore stops it', () => {
        const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        const at = welcome.indexOf('async function handleSsoStartAgain(');
        const startAgain = welcome.slice(at, welcome.indexOf('\n    }\n', at));
        expect(startAgain).not.toMatch(/abandonSsoRestore|clearPendingVaultRestore/);
        expect(welcome).not.toMatch(/abandonSsoRestore\(/);
        expect(welcome).toMatch(/await restoreFromWords\([\s\S]{0,400}stopSsoRestoreAfterWords\(identity\)/);
    });

    it('the throwaway key signs the restore; the release opens only with it', async () => {
        await kept();
        const held = await startSsoRestore('google');
        const restore = to(VAULT).find(s => s.path === '/v1/restore')!;
        expect(restore.headers['X-Public-Key']).toBe(held.publicKey);
        expect(restore.headers['X-Public-Key']).not.toBe(member.publicKey);
        expect(Object.keys(restore.body).sort()).toEqual(['idToken', 'provider', 'ticket']);
        await abandonSsoRestore();
        expect(mem.secure.has(VAULT_RESTORE_STORE_KEY)).toBe(false);
    });
});

describe('the source: only a build without a vault asks a community for a nonce, sends it a sign-in copy, or restores from it', () => {
    const ROOT = path.resolve(__dirname, '../..');
    /** Every .ts/.tsx the app runs (app, components, services, utils; not tests), as code without comments. */
    function sources(): { rel: string; src: string }[] {
        const out: { rel: string; src: string }[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full);
                } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
                    const raw = fs.readFileSync(full, 'utf8');
                    out.push({ rel: path.relative(ROOT, full), src: raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') });
                }
            }
        };
        for (const d of ['app', 'components', 'services', 'utils']) walk(path.join(ROOT, d));
        return out;
    }
    const src = (rel: string) => sources().find(s => s.rel === rel)!.src;
    /** The body of `name` in `text`: from its declaration to the next top-level declaration. */
    const body = (text: string, name: string) => {
        const at = text.indexOf(`function ${name}(`);
        expect(at, name).toBeGreaterThan(-1);
        const next = text.slice(at + 1).search(/\n(export )?(async )?function /);
        return next < 0 ? text.slice(at) : text.slice(at, at + 1 + next);
    };
    // The dev builds' measurement probes (inert outside __DEV__, app/google-probe.tsx) are the one exception, and say so.
    const PROBES = ['app/google-probe.tsx', 'app/apple-probe.tsx'];

    it('the community paths are the ones a build without a vault keeps (release gate), and nothing else has them', () => {
        // The alert banner's watch of this account's own old sessions at its community (`/collect/mine`) and its Stop
        // (`/collect/cancel`) carry no sign-in and no copy.
        const offenders = sources()
            .filter(({ rel }) => !PROBES.includes(rel))
            .filter(({ src }) => /\/api\/recovery\/sso-nonce|\/api\/recovery\/shares\/sso['"`]|\/api\/recovery\/collect(?!\/(?:mine|cancel)['"`])|fetchSsoNonce\(/.test(src))
            .map(({ rel }) => rel)
            .sort();
        expect(offenders).toEqual(['utils/keeper-enrolment.ts', 'utils/sso-recovery.ts', 'utils/sso-signin.ts']);
    });

    it('each is reached only when the build has no vault', () => {
        // The community's nonce: only through startSsoSignIn, which only the community connect calls, after the switch.
        const signin = src('utils/sso-signin.ts');
        expect(signin.match(/fetchSsoNonce\(/g)).toHaveLength(2);
        expect(body(signin, 'startSsoSignIn')).toMatch(/fetchSsoNonce\(/);
        const callers = sources().filter(({ rel, src: s }) => !PROBES.includes(rel) && rel !== 'utils/sso-signin.ts' && /startSsoSignIn\(/.test(s));
        expect(callers.map(c => c.rel)).toEqual(['utils/sso-sheet-connect.ts']);
        const connect = src('utils/sso-sheet-connect.ts');
        expect(body(connect, 'connectAtCommunity')).toMatch(/startSsoSignIn\(/);
        expect(body(connect, 'connectAndDeposit')).toMatch(/if \(signInCopiesAt\(\) === 'community'\) return connectAtCommunity\(/);
        // The deposit at the community: only for a sign-in bound to the community's nonce (no vault ticket).
        const enrol = src('utils/keeper-enrolment.ts');
        expect(body(enrol, 'enrolSsoKeeper')).toMatch(/'ticket' in input \? enrolAtVault\(input\) : enrolAtCommunity\(input\)/);
        expect(body(enrol, 'disconnectSsoKeeper')).toMatch(/if \(signInCopiesAt\(\) === 'community'\) return disconnectAtCommunity\(/);
        // The restore at a community: only the welcome screen's community branch.
        const callersOfRestore = sources().filter(({ src: s }) => /recoverAccountWithSso\(/.test(s)).map(c => c.rel).sort();
        expect(callersOfRestore).toEqual(['app/welcome.tsx', 'utils/sso-recovery.ts']);
        expect(src('app/welcome.tsx')).toMatch(/if \(mode === 'ssoRecover' && !hasVault\(\)\) \{/);
    });

    it('the sign-in sheets are reached with a nonce only from the sign-in flows and the global door', () => {
        const callers = sources()
            .filter(({ rel }) => rel !== 'utils/sso-signin.ts' && !PROBES.includes(rel))
            .filter(({ src }) => /signInWith(Provider|Google|Apple|Facebook)\(/.test(src))
            .map(({ rel }) => rel)
            .sort();
        expect(callers).toEqual(['utils/global-join.ts', 'utils/sso-recovery.ts', 'utils/sso-sheet-connect.ts']);
    });
});

describe('status, disconnect, push token, and the check at app open', () => {
    it('a deposit here tells the phone the vault keeps a copy (so the app-open check may ask about holds)', async () => {
        await memberOnCommunity();
        expect(await vaultCopyKnown(member.publicKey)).toBe(false);
        await connect('google');
        expect(await vaultCopyKnown(member.publicKey)).toBe(true);
    });

    it('Account Protection reads the vault: the sign-ins it keeps a copy for', async () => {
        await memberOnCommunity();
        await connect('google');
        await connect('facebook');
        expect(await vaultProtection(member)).toMatchObject({ enrolledSso: ['google', 'facebook'], isSingleBlob: true });
    });

    it('Disconnect deletes the copy at the vault', async () => {
        await memberOnCommunity();
        await connect('google');
        expect(await disconnectSsoKeeper('google', member)).toEqual({ success: true, enrolledSso: [] });
        expect(net.vault.copiesOf(member.publicKey)).toEqual([]);
        expect(to(VAULT).find(s => s.path === '/v1/copies/delete')?.body).toEqual({ provider: 'google' });
    });

    it('the deposit carries this phone\'s push token, and a changed one is given to the vault once', async () => {
        await memberOnCommunity();
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[first]');
        await connect('google');
        expect(net.vault.copiesOf(member.publicKey)[0].pushTokens).toEqual(['ExponentPushToken[first]']);
        await keepVaultPushTokenCurrent(member);
        expect(to(VAULT).filter(s => s.path === '/v1/push-token')).toEqual([]);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[second]');
        await keepVaultPushTokenCurrent(member);
        await keepVaultPushTokenCurrent(member);
        expect(to(VAULT).filter(s => s.path === '/v1/push-token').map(s => s.body)).toEqual([{ token: 'ExponentPushToken[second]' }]);
    });

    it('at app open, a waiting restore is brought up once per run: marked only when its alert is shown', async () => {
        await memberOnCommunity();
        await connect('google');
        await startSsoRestore('google');
        // Two answers at once (the app opening and turning active): one alert.
        const [a, b] = await Promise.all([vaultHoldsAtOpen(member), vaultHoldsAtOpen(member)]);
        expect(a).toHaveLength(1);
        expect(takeHoldsToShow(a)).toHaveLength(1);
        expect(takeHoldsToShow(b)).toEqual([]);
        expect(await vaultHoldsAtOpen(member)).toEqual([]);
    });

    it('an answer nobody showed (the screen that asked has gone) keeps the hold\'s alert for the next check', async () => {
        await memberOnCommunity();
        await connect('google');
        await startSsoRestore('google');
        const unshown = await vaultHoldsAtOpen(member);
        expect(unshown).toHaveLength(1);
        // Not taken: the layout was remounted before it could show it.
        const again = await vaultHoldsAtOpen(member);
        expect(again.map(h => h.holdId)).toEqual(unshown.map(h => h.holdId));
        expect(takeHoldsToShow(again)).toHaveLength(1);
    });

    it('when a hold ends, in words', () => {
        const now = Date.UTC(2026, 9, 1, 12, 0, 0);
        expect(holdEndsText(now + 30_000, now)).toBe('any moment now');
        expect(holdEndsText(now + 20 * 60_000, now)).toBe('in a few minutes');
        expect(holdEndsText(now + HOLD_MS, now)).toMatch(/^in about 24 hours \(/);
        expect(holdEndsText(now + 60 * 60_000, now)).toMatch(/^in about 1 hour \(/);
    });

    it('a VaultError carries the vault\'s reason', () => {
        expect(new VaultError('locked', VAULT_MESSAGES.paused)).toMatchObject({ reason: 'locked', message: VAULT_MESSAGES.paused });
    });
});
