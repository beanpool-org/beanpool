/**
 * A sign-in restore at the member's community finds the account from the sign-in itself, with nothing typed (recovery
 * S2, scratch design DESIGN-recovery-no-callsign-fable.md §3-§6; Marty, 9 Nov), and saves only the account the find
 * named for it (launch-readiness review 3, 2026-10-15; #1951).
 *
 * The phone asks the community's find (`POST /api/recovery/find-nonce`, the provider's sheet with that nonce, then
 * `POST /api/recovery/find`), which names the accounts this sign-in protects there, by name and key; the member picks
 * when there are several; `POST /api/recovery/collect { candidatePublicKey }` opens the session for that key by the
 * find's hold and releases its copy; the copy opens; and the key it makes must be the key the find named for the account
 * picked. Anything else (another account's copy, a community answering for someone else) saves nothing. The web's
 * restore makes the same check (apps/pwa/src/lib/web-restore.ts `openRestoredAccount`).
 *
 * Nothing here contacts a node or a provider: the recovery routes are a stubbed signedPost, Google's sheet a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
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
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../sso-signin', () => ({
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    signInWithFacebook: vi.fn(),
    SsoSignInError: class SsoSignInError extends Error {
        constructor(readonly reason: string, message: string) { super(message); }
    },
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import { recordShareForHub, sealSeedToSso, sealShareToSso, splitHubAndWhole } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { signedPost } from '../node-post';
import { signInWithGoogle } from '../sso-signin';
import { recoverAccountWithSso, type FoundAccount } from '../sso-recovery';
import { restoreRefusalText } from '../community-restore-copy';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { mnemonicToKeypair, seedToKeypair } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';
import { answer, noNodeContacted, type Found } from './community-find';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
/** Another account's seed: the copy a stale or wrong deposit, or a community answering for someone else, hands back. */
const OTHER_SEED = new Uint8Array(32).fill(42);
const SUB = '110169484474386276334';
/** Not a real community: every request to it is answered by a stub below, and any other is refused. */
const NODE = 'https://community.example.org';
/** The community's name, as the screen names the one chosen (utils/restore-community-choices.ts restoreCommunityName). */
const COMMUNITY = 'Riverside';
const ANCHOR = 'beanpool_anchor_url';
const WRONG_ACCOUNT = "The account that came back isn't Marty, so nothing was saved on this phone. Try again, or use your 12 words.";
const UNREACHABLE = "Can't reach the community right now. Try again in a minute.";
const NONE_HERE = 'No account at Riverside uses this Google account. Try another community, or your 12 words.';
const TOO_OLD = "Riverside's server is older than this app and can't find your account from a sign-in yet. Ask its admin to update, or use your 12 words.";
const WRONG_CLOCK = "The community couldn't accept this because this device's date and time look wrong. Check them in this device's settings (set them to automatic), then try again.";

/** What the community answers each route; a test overrides one. Records nothing itself: see {@link routesAsked}. */
interface Node {
    nonce: string;
    found: Found[];
    fragments: Array<Record<string, unknown>>;
    /** Overrides for a route: its answer, or a throw for a network failure. */
    override: Partial<Record<string, () => Response>>;
}
let node: Node;

/** Google hands back a token whose `sub` is SUB and the nonce it was given; the community answers as {@link node} says. */
function mockSignInAndNode() {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    vi.mocked(signInWithGoogle).mockImplementation(async (nonce: string) => ({
        idToken: `${b64(JSON.stringify({ alg: 'RS256' }))}.${b64(JSON.stringify({ sub: SUB, nonce }))}.sig`,
        nonce,
    }));
    vi.mocked(signedPost).mockImplementation(async (_url: string, path: string) => {
        const over = node.override[path];
        if (over) return over();
        if (path === '/api/recovery/find-nonce') return answer(200, { nonce: node.nonce, expiresInSeconds: 600, clientIds: {} });
        if (path === '/api/recovery/find') return answer(200, { accounts: node.found });
        if (path === '/api/recovery/collect') return answer(200, { collectionId: 'c1', threshold: 1 });
        if (path === '/api/recovery/collect/hub') return answer(200, { status: 'hub_released' });
        if (path === '/api/recovery/collect/fragments') return answer(200, { collected: 1, threshold: 1, enough: true, fragments: node.fragments });
        throw new Error(`Unexpected path: ${path}`);
    });
}

/** The single-blob copy of `seed`, as the node lists it. */
async function singleBlob(seed: Uint8Array, words?: string[]) {
    const sealed = await sealSeedToSso(seed, 'google', SUB, words ? { words } : undefined);
    return [{
        holderType: 'sso', shareIndex: 1,
        payload: sealed.encryptedShare, payloadIv: sealed.shareIv, payloadTag: sealed.shareTag, kdfParams: sealed.kdfParams,
    }];
}

function restore(options: { confirmReplace?: (outgoing: BeanPoolIdentity) => Promise<boolean>; pickAccount?: (accounts: FoundAccount[]) => Promise<FoundAccount | null>; signal?: AbortSignal } = {}) {
    return recoverAccountWithSso({ anchorUrl: NODE, provider: 'google', ...options });
}

/** What the restore screen shows for this restore's refusal: welcome.tsx shows community-restore-copy.ts `restoreRefusalText`. */
function shown(attempt: Promise<unknown>): Promise<string | undefined> {
    return attempt.then(() => 'no refusal', (e) => restoreRefusalText(e, COMMUNITY));
}

/** Which of the node's recovery routes were asked, in order. */
function routesAsked(): string[] {
    return vi.mocked(signedPost).mock.calls.map(([, path]) => path as string);
}

/** The body the phone sent to `path` (the last time it asked it). */
function sentTo(path: string): unknown {
    const calls = vi.mocked(signedPost).mock.calls.filter(([, p]) => p === path);
    return calls[calls.length - 1]?.[2];
}

let accountPub: string;
let otherPub: string;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    noNodeContacted();
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    accountPub = (await mnemonicToKeypair(WORDS)).publicKeyHex;
    otherPub = (await seedToKeypair(OTHER_SEED)).publicKeyHex;
    node = { nonce: 'find-nonce-1', found: [{ publicKey: accountPub, callsign: 'Marty' }], fragments: await singleBlob(SEED, WORDS), override: {} };
    mockSignInAndNode();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Everything the phone keeps, app storage and SecureStore both, as one value to compare before and after. */
function wholePhone(): string {
    return JSON.stringify({ async: [...mem.async].sort(), secure: [...mem.secure].sort() });
}

/** Nothing at all was written: both stores are as empty as the test began them. */
async function expectEmptyPhone() {
    expect(wholePhone()).toBe(JSON.stringify({ async: [], secure: [] }));
    expect(await loadIdentity()).toBeNull();
}

describe('a sign-in restore at the community finds the account from the sign-in, with nothing typed', () => {
    it('one account found: it comes back with its key, its 12 words and the name the find gives it', async () => {
        const { identity } = await restore();

        expect(identity).toMatchObject({ publicKey: accountPub, callsign: 'Marty', mnemonic: WORDS });
        expect(await loadIdentity()).toMatchObject({ publicKey: accountPub, callsign: 'Marty', mnemonic: WORDS });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
        // The find first, then the collect for the key it named, then the copy. No name is sent anywhere, and the name
        // routes (the lookup, /collect/sso-nonce, /collect/sso) are never asked.
        expect(routesAsked()).toEqual(['/api/recovery/find-nonce', '/api/recovery/find', '/api/recovery/collect', '/api/recovery/collect/fragments']);
        expect(sentTo('/api/recovery/collect')).toEqual({ candidatePublicKey: accountPub });
        expect(JSON.stringify(vi.mocked(signedPost).mock.calls.map(([, , body]) => body))).not.toContain('callsign');
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('the find nonce goes to the sign-in, and the find carries the provider, its token and that nonce', async () => {
        node.nonce = 'find-nonce-77';
        await restore();

        expect(signInWithGoogle).toHaveBeenCalledWith('find-nonce-77');
        expect(sentTo('/api/recovery/find-nonce')).toEqual({});
        const find = sentTo('/api/recovery/find') as Record<string, string>;
        expect(find.provider).toBe('google');
        expect(find.nonce).toBe('find-nonce-77');
        expect(JSON.parse(Buffer.from(find.idToken.split('.')[1], 'base64url').toString()).sub).toBe(SUB);
        // Every call is signed by the restore's one throwaway key, never an account's: the node binds the nonce, the find's
        // hold and the session to it.
        const signers = new Set(vi.mocked(signedPost).mock.calls.map(([, , , who]) => (who as BeanPoolIdentity).publicKey));
        expect(signers.size).toBe(1);
        expect([...signers][0]).not.toBe(accountPub);
    });

    it('several accounts found: the member picks, and only the one picked is collected and saved, under its own name', async () => {
        node.found = [{ publicKey: otherPub, callsign: 'Marty (child)' }, { publicKey: accountPub, callsign: 'Marty' }];
        const pickAccount = vi.fn(async (accounts: FoundAccount[]) => accounts.find((a) => a.publicKey === accountPub) ?? null);

        const { identity } = await restore({ pickAccount });

        expect(pickAccount).toHaveBeenCalledTimes(1);
        expect(pickAccount.mock.calls[0][0]).toEqual([{ publicKey: otherPub, callsign: 'Marty (child)' }, { publicKey: accountPub, callsign: 'Marty' }]);
        expect(sentTo('/api/recovery/collect')).toEqual({ candidatePublicKey: accountPub });
        expect(identity).toMatchObject({ publicKey: accountPub, callsign: 'Marty' });
    });

    it('one account found: no question, it is the one collected', async () => {
        const pickAccount = vi.fn(async () => null);
        await restore({ pickAccount });
        expect(pickAccount).not.toHaveBeenCalled();
        expect(sentTo('/api/recovery/collect')).toEqual({ candidatePublicKey: accountPub });
    });

    it('several found and the member goes back: nothing is collected or saved, and nothing is said', async () => {
        node.found = [{ publicKey: otherPub, callsign: 'Kim' }, { publicKey: accountPub, callsign: 'Marty' }];

        const failed = await restore({ pickAccount: async () => null }).then(() => null, (e) => e);

        expect(failed?.reason).toBe('cancelled');
        expect(routesAsked()).toEqual(['/api/recovery/find-nonce', '/api/recovery/find']);
        await expectEmptyPhone();
    });

    it('several found and the screen has no way to ask: nothing is collected or saved', async () => {
        node.found = [{ publicKey: otherPub, callsign: 'Kim' }, { publicKey: accountPub, callsign: 'Marty' }];
        await expect(restore()).rejects.toBeTruthy();
        expect(routesAsked()).toEqual(['/api/recovery/find-nonce', '/api/recovery/find']);
        await expectEmptyPhone();
    });

    it('a pick that is not one of the accounts found collects nothing', async () => {
        node.found = [{ publicKey: otherPub, callsign: 'Kim' }, { publicKey: accountPub, callsign: 'Marty' }];
        await expect(restore({ pickAccount: async () => ({ publicKey: 'ab'.repeat(32), callsign: 'Marty' }) })).rejects.toBeTruthy();
        expect(routesAsked()).not.toContain('/api/recovery/collect');
        await expectEmptyPhone();
    });

    it('an account the find names twice, or without a key or a name, is listed once or not at all', async () => {
        node.found = [
            { publicKey: accountPub.toUpperCase(), callsign: 'Marty' }, { publicKey: accountPub, callsign: 'Marty' },
            { publicKey: 'not-a-key', callsign: 'Kim' }, { publicKey: otherPub, callsign: '  ' },
        ];
        const pickAccount = vi.fn(async () => null);

        const { identity } = await restore({ pickAccount });

        // One account is left, so nothing is asked.
        expect(pickAccount).not.toHaveBeenCalled();
        expect(identity.publicKey).toBe(accountPub);
    });

    it('the key is compared case-folded, as the web compares it, and saved as the phone makes it', async () => {
        node.found = [{ publicKey: accountPub.toUpperCase(), callsign: 'Marty' }];
        const { identity } = await restore();
        expect(identity.publicKey).toBe(accountPub);
        expect(sentTo('/api/recovery/collect')).toEqual({ candidatePublicKey: accountPub });
    });

    it('a cancel after the sign-in and before the collect releases nothing', async () => {
        const abort = new AbortController();
        vi.mocked(signInWithGoogle).mockImplementationOnce(async (nonce: string) => {
            abort.abort();
            const b64 = (s: string) => Buffer.from(s).toString('base64url');
            return { idToken: `${b64('{}')}.${b64(JSON.stringify({ sub: SUB }))}.sig`, nonce };
        });

        await expect(restore({ signal: abort.signal })).rejects.toMatchObject({ reason: 'cancelled' });

        expect(routesAsked()).not.toContain('/api/recovery/collect');
        await expectEmptyPhone();
    });
});

describe('a sign-in restore at the community: the key must be the account the find named', () => {
    it('a copy that opens to another key than the account picked saves nothing, and says so by that account\'s name', async () => {
        node.fragments = await singleBlob(OTHER_SEED);
        expect(await shown(restore())).toBe(WRONG_ACCOUNT);
        await expectEmptyPhone();
    });

    it('the old two-part kind of copy is held to the same rule', async () => {
        const { hubShare, otherHalf } = await splitHubAndWhole(OTHER_SEED);
        const sso = await sealShareToSso(otherHalf, 'google', SUB);
        const hub = recordShareForHub(hubShare);
        node.fragments = [
            { holderType: 'sso', shareIndex: 2, payload: sso.encryptedShare, payloadIv: sso.shareIv, payloadTag: sso.shareTag, kdfParams: sso.kdfParams },
            { holderType: 'hub', shareIndex: 1, payload: hub.encryptedShare, payloadIv: hub.shareIv, payloadTag: hub.shareTag, kdfParams: hub.kdfParams },
        ];

        expect(await shown(restore())).toBe(WRONG_ACCOUNT);
        // The hub's half is asked for in the same session the find's hold opened.
        expect(routesAsked()).toContain('/api/recovery/collect/hub');
        await expectEmptyPhone();
    });

    it('the old two-part kind of the account picked comes back', async () => {
        const { hubShare, otherHalf } = await splitHubAndWhole(SEED);
        const sso = await sealShareToSso(otherHalf, 'google', SUB);
        const hub = recordShareForHub(hubShare);
        node.fragments = [
            { holderType: 'sso', shareIndex: 2, payload: sso.encryptedShare, payloadIv: sso.shareIv, payloadTag: sso.shareTag, kdfParams: sso.kdfParams },
            { holderType: 'hub', shareIndex: 1, payload: hub.encryptedShare, payloadIv: hub.shareIv, payloadTag: hub.shareTag, kdfParams: hub.kdfParams },
        ];

        const { identity } = await restore();

        expect(identity).toMatchObject({ publicKey: accountPub, callsign: 'Marty' });
    });

    it('onto a phone that holds an account: a wrong copy never asks to replace it, and the phone keeps everything', async () => {
        const phone = await draftIdentity('Kim');
        await importIdentity(phone);
        const record = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: 'https://mullum.example.org', callsign: 'Kim', redeemed: true };
        await setPendingOnboarding(record);
        mem.async.set(ANCHOR, 'https://mullum.example.org');
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: 'https://mullum.example.org', name: 'Mullum' }]));
        mem.async.set('beanpool_theme_mode', 'dark');
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[kims-phone]');
        const before = wholePhone();
        node.fragments = await singleBlob(OTHER_SEED);
        const confirmReplace = vi.fn(async () => true);

        expect(await shown(restore({ confirmReplace }))).toBe(WRONG_ACCOUNT);

        expect(confirmReplace).not.toHaveBeenCalled();
        expect(wholePhone()).toBe(before);
        expect(await loadIdentity()).toEqual(phone);
        expect(await getPendingOnboarding()).toEqual(record);
        expect(mem.async.get(ANCHOR)).toBe('https://mullum.example.org');
    });
});

describe('a sign-in restore at the community: what stops it, and what the member is told', () => {
    it('no account at the community uses this sign-in: nothing is collected or saved, and the member is told where and with what', async () => {
        node.found = [];
        expect(await shown(restore())).toBe(NONE_HERE);
        expect(routesAsked()).toEqual(['/api/recovery/find-nonce', '/api/recovery/find']);
        await expectEmptyPhone();
    });

    it('a server older than the find (no find nonce, 404): no sign-in is started, and the member is told to ask its admin', async () => {
        node.override['/api/recovery/find-nonce'] = () => answer(404, 'Not Found');
        expect(await shown(restore())).toBe(TOO_OLD);
        expect(signInWithGoogle).not.toHaveBeenCalled();
        expect(routesAsked()).toEqual(['/api/recovery/find-nonce']);
        await expectEmptyPhone();
    });

    it('the community can\'t be reached: no sign-in is started, nothing saved, and the member is told to try again', async () => {
        node.override['/api/recovery/find-nonce'] = () => { throw new TypeError('Network request failed'); };
        expect(await shown(restore())).toBe(UNREACHABLE);
        expect(signInWithGoogle).not.toHaveBeenCalled();
        await expectEmptyPhone();
    });

    it('the community drops out at the find or the collect: the same sentence, and nothing saved', async () => {
        for (const path of ['/api/recovery/find', '/api/recovery/collect']) {
            node.override = { [path]: () => { throw new TypeError('Network request failed'); } };
            expect(await shown(restore()), path).toBe(UNREACHABLE);
            await expectEmptyPhone();
        }
    });

    it('a refused find says what the web says for the same answer (lib/web-restore.ts findRefusalMessage)', async () => {
        const cases: Array<[Response, string]> = [
            [answer(400, { error: 'That sign-in has expired.' }), 'That sign-in has expired.'],
            [answer(401, { error: 'Request signature expired.' }), WRONG_CLOCK],
            [answer(401, { error: 'x', code: 'sign_in' }), "Google sign-in couldn't be checked or took too long. Try again."],
            [answer(429, {}), 'Too many tries from this network. Please try again later.'],
            [answer(429, { error: 'Slow down.' }), 'Slow down.'],
            [answer(503, { error: 'Busy finding another account. Wait a minute, then sign in again.', code: 'find_busy' }), 'Busy finding another account. Wait a minute, then sign in again.'],
            [answer(503, {}), 'Google sign-in could not be checked right now. Please try again in a minute.'],
            [answer(500, {}), 'The community could not bring the account back (500). Please try again.'],
        ];
        for (const [refusal, sentence] of cases) {
            node.override = { '/api/recovery/find': () => refusal };
            expect(await shown(restore()), sentence).toBe(sentence);
            expect(routesAsked()).not.toContain('/api/recovery/collect');
            await expectEmptyPhone();
        }
    });

    it('a refused find nonce says the web\'s sentence for it, before any sign-in', async () => {
        node.override['/api/recovery/find-nonce'] = () => answer(409, { error: 'This server is a standby.', code: 'standby' });
        expect(await shown(restore())).toBe('This server is a standby.');
        node.override['/api/recovery/find-nonce'] = () => answer(500, {});
        expect(await shown(restore())).toBe('The community could not bring the account back (500). Please try again.');
        expect(signInWithGoogle).not.toHaveBeenCalled();
    });

    it('a refused collect (the hold ran out) shows the community\'s words, and nothing is saved', async () => {
        node.override['/api/recovery/collect'] = () => answer(400, { error: "Sign in with your account's sign-in first." });
        expect(await shown(restore())).toBe("Sign in with your account's sign-in first.");
        expect(routesAsked()).not.toContain('/api/recovery/collect/fragments');
        await expectEmptyPhone();
        node.override['/api/recovery/collect'] = () => answer(502, {});
        expect(await shown(restore())).toBe('The community could not bring the account back (502). Please try again.');
    });
});
