/**
 * A sign-in restore at the member's community saves only the account the community lists for the name being restored
 * (launch-readiness review 3, 2026-10-15). The web's restore already refused anything else (apps/pwa/src/lib/
 * web-restore.ts `openRestoredAccount`); the phone checked only the copy's 12 words against the key it rebuilt, then
 * saved that key under the name typed. So a wrong or stale copy, or a community answering for another member, put a key
 * on the phone under a name that isn't that key's account there, and the member signed in as nobody or as someone else.
 *
 * Now the phone asks the community's public lookup (`GET /api/recovery/lookup/:callsign`, utils/sso-recovery.ts
 * `lookupRestorable`) before anything is released, and the rebuilt key must be one it lists for that name. If it
 * isn't, or the lookup can't be had, nothing on the phone changes.
 *
 * Nothing here contacts a node or a provider: the lookup is a stubbed fetch, the recovery routes a stubbed signedPost,
 * Google's sheet a stub.
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
}));
vi.mock('../node-post', () => ({ signedPost: vi.fn() }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import { recordShareForHub, sealSeedToSso, sealShareToSso, splitHubAndWhole } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { signedPost } from '../node-post';
import { signInWithGoogle } from '../sso-signin';
import { recoverAccountWithSso } from '../sso-recovery';
import { restoreRefusalText } from '../community-restore-copy';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { mnemonicToKeypair, seedToKeypair } from '../crypto';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

// Test phrases only (BIP-39 vectors), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
/** Another account's seed: the copy a stale or wrong deposit, or a community answering for someone else, hands back. */
const OTHER_SEED = new Uint8Array(32).fill(42);
const SUB = '110169484474386276334';
/** Not a real community: every request to it is answered by a stub below, and any other is refused. */
const NODE = 'https://community.example.org';
const LOOKUP = `${NODE}/api/recovery/lookup/`;
const ANCHOR = 'beanpool_anchor_url';
const WRONG_ACCOUNT = "The account that came back isn't Marty, so nothing was saved on this phone. Try again, or use your 12 words.";
const UNREACHABLE = "Can't reach the community right now. Try again in a minute.";
const NO_ACCOUNT = "No account called Marty here can come back with a sign-in. Check you've typed your whole name, or use your 12 words.";

/** Google hands back a token whose `sub` is SUB; the node releases `fragments`. Records every recovery route asked. */
function mockSignInAndNode(fragments: Array<Record<string, unknown>>) {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const token = `${b64(JSON.stringify({ alg: 'RS256' }))}.${b64(JSON.stringify({ sub: SUB }))}.sig`;
    vi.mocked(signInWithGoogle).mockResolvedValue({ idToken: token, nonce: 'n' });
    vi.mocked(signedPost).mockImplementation(async (_url: string, path: string) => {
        const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
        if (path === '/api/recovery/collect') return ok({ collectionId: 'c1', threshold: 1 });
        if (path === '/api/recovery/collect/sso-nonce') return ok({ nonce: 'n' });
        if (path === '/api/recovery/collect/sso') return ok({ collected: 1, threshold: 1, enough: true });
        if (path === '/api/recovery/collect/hub') return ok({ status: 'hub_released' });
        if (path === '/api/recovery/collect/fragments') return ok({ collected: 1, threshold: 1, enough: true, fragments });
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

/** The community's lookup answers `answer` for any name, and every other request is refused. */
function lookupAnswers(answer: () => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith(LOOKUP)) return answer();
        throw new Error(`No node may be contacted from a test: ${String(input)}`);
    }));
}

function listed(accounts: Array<{ publicKey: string; callsign: string; canRecoverBySso?: boolean }>) {
    lookupAnswers(() => new Response(JSON.stringify(accounts.map(a => ({
        canRecoverBySso: true, joinedAt: null, avatarUrl: null, ...a,
    }))), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

function restore(callsign = 'Marty', confirmReplace?: (outgoing: BeanPoolIdentity) => Promise<boolean>) {
    return recoverAccountWithSso({
        callsign, anchorUrl: NODE, provider: 'google',
        ...(confirmReplace ? { confirmReplace } : {}),
    });
}

/** What the restore screen shows for this restore's refusal: welcome.tsx shows community-restore-copy.ts `restoreRefusalText`. */
function shown(attempt: Promise<unknown>): Promise<string | undefined> {
    return attempt.then(() => 'no refusal', restoreRefusalText);
}

/** Which of the node's recovery routes were asked, in order. */
function routesAsked(): string[] {
    return vi.mocked(signedPost).mock.calls.map(([, path]) => path as string);
}

let accountPub: string;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    // Until a test says what the lookup answers, every request is refused.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    accountPub = (await mnemonicToKeypair(WORDS)).publicKeyHex;
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

describe('a sign-in restore at the community: the key must be the account the community lists for the name', () => {
    it('a copy that opens to another key than the listed account saves nothing, and says so', async () => {
        listed([{ publicKey: accountPub, callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(OTHER_SEED));

        expect(await shown(restore())).toBe(WRONG_ACCOUNT);

        await expectEmptyPhone();
    });

    it('the old two-part kind of copy is held to the same rule', async () => {
        listed([{ publicKey: accountPub, callsign: 'Marty' }]);
        const { hubShare, otherHalf } = await splitHubAndWhole(OTHER_SEED);
        const sso = await sealShareToSso(otherHalf, 'google', SUB);
        const hub = recordShareForHub(hubShare);
        mockSignInAndNode([
            { holderType: 'sso', shareIndex: 2, payload: sso.encryptedShare, payloadIv: sso.shareIv, payloadTag: sso.shareTag, kdfParams: sso.kdfParams },
            { holderType: 'hub', shareIndex: 1, payload: hub.encryptedShare, payloadIv: hub.shareIv, payloadTag: hub.shareTag, kdfParams: hub.kdfParams },
        ]);

        expect(await shown(restore())).toBe(WRONG_ACCOUNT);

        await expectEmptyPhone();
    });

    it('onto a phone that holds an account: a wrong copy never asks to replace it, and the phone keeps everything', async () => {
        const phone = await draftIdentity('Kim');
        await importIdentity(phone);
        const record = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: 'https://mullum.example.org', callsign: 'Kim', redeemed: true };
        await setPendingOnboarding(record);
        mem.async.set(ANCHOR, 'https://mullum.example.org');
        // The rest of what an account and the phone keep: its saved communities, a theme, a push token.
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: 'https://mullum.example.org', name: 'Mullum' }]));
        mem.async.set('beanpool_theme_mode', 'dark');
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[kims-phone]');
        const before = wholePhone();
        listed([{ publicKey: accountPub, callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(OTHER_SEED));
        const confirmReplace = vi.fn(async () => true);

        expect(await shown(restore('Marty', confirmReplace))).toBe(WRONG_ACCOUNT);

        expect(confirmReplace).not.toHaveBeenCalled();
        // Not one key in either store changed.
        expect(wholePhone()).toBe(before);
        expect(await loadIdentity()).toEqual(phone);
        expect(await getPendingOnboarding()).toEqual(record);
        expect(mem.async.get(ANCHOR)).toBe('https://mullum.example.org');
    });

    it('the listed account comes back: its key, its 12 words, and the name the community lists for it', async () => {
        listed([{ publicKey: accountPub, callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(SEED, WORDS));

        const { identity } = await restore();

        expect(identity.publicKey).toBe(accountPub);
        expect(identity.callsign).toBe('Marty');
        expect(identity.mnemonic).toEqual(WORDS);
        expect(await loadIdentity()).toMatchObject({ publicKey: accountPub, callsign: 'Marty', mnemonic: WORDS });
        expect(mem.async.get(ANCHOR)).toBe(NODE);
        // Asked of the community the member named, for the name they typed, before anything was released.
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
        expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(`${LOOKUP}Marty`);
        expect(routesAsked()[0]).toBe('/api/recovery/collect');
    });

    it('the key is compared case-folded, as the web compares it, and saved as the phone makes it', async () => {
        listed([{ publicKey: accountPub.toUpperCase(), callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(SEED));

        const { identity } = await restore();

        expect(identity.publicKey).toBe(accountPub);
        expect((await loadIdentity())?.publicKey).toBe(accountPub);
    });

    it('saves the name the community lists for that key, not the case it was typed in', async () => {
        listed([{ publicKey: accountPub, callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(SEED));

        const { identity } = await restore('marty');

        expect(identity.callsign).toBe('Marty');
        expect((await loadIdentity())?.callsign).toBe('Marty');
    });

    // Defensive only: a real community refuses a name that more than one live account answers to, at
    // /api/recovery/collect with 409 (apps/server/src/routes/recovery-collect.ts, `resolveCallsign` ambiguous), before
    // anything is released, and registration refuses a case namesake. This pins that the name saved is always the one
    // listed for the rebuilt key.
    it('two accounts listed for one name (namesakes in different case): the one whose key it is', async () => {
        const otherPub = (await seedToKeypair(OTHER_SEED)).publicKeyHex;
        listed([{ publicKey: otherPub, callsign: 'marty' }, { publicKey: accountPub, callsign: 'Marty' }]);
        mockSignInAndNode(await singleBlob(SEED));

        const { identity } = await restore('MARTY');

        expect(identity).toMatchObject({ publicKey: accountPub, callsign: 'Marty' });
    });
});

describe('a sign-in restore at the community: no lookup, no restore', () => {
    for (const [what, answer] of [
        ['the community can\'t be reached', () => { throw new TypeError('Network request failed'); }],
        ['the lookup is rate limited', () => new Response(JSON.stringify({ error: 'slow down' }), { status: 429 })],
        ['the community answers with something that is not a list', () => new Response(JSON.stringify({ accounts: [] }), { status: 200 })],
    ] as const) {
        it(`${what}: nothing is released and nothing saved, and the member is told to try again`, async () => {
            lookupAnswers(answer);
            mockSignInAndNode(await singleBlob(SEED));

            expect(await shown(restore())).toBe(UNREACHABLE);

            expect(signInWithGoogle).not.toHaveBeenCalled();
            expect(routesAsked()).toEqual([]);
            await expectEmptyPhone();
        });
    }

    it('the community lists no account by that name: nothing is released and nothing saved, and the member is told why', async () => {
        listed([]);
        mockSignInAndNode(await singleBlob(SEED));

        expect(await shown(restore())).toBe(NO_ACCOUNT);

        expect(signInWithGoogle).not.toHaveBeenCalled();
        expect(routesAsked()).toEqual([]);
        await expectEmptyPhone();
    });

    it('an account listed without a sign-in copy is no account a sign-in can bring back', async () => {
        listed([{ publicKey: accountPub, callsign: 'Marty', canRecoverBySso: false }]);
        mockSignInAndNode(await singleBlob(SEED));

        expect(await shown(restore())).toBe(NO_ACCOUNT);

        expect(routesAsked()).toEqual([]);
        await expectEmptyPhone();
    });
});
