/**
 * The global community's door for an account this phone already has (utils/global-join-existing.ts, app/join-global.tsx):
 * a member of a local community who added the global one as a guest. Before this, People told that guest "Joining it
 * from an account you already have isn't possible in the app yet".
 *
 * The phone holds one account, in its local community, and has the global community in its list as a guest. It is
 * offered the door once the global community says it is open; it signs in and joins with ITS key; it ends a member of
 * the global community, switched to it, with the local community's entry as it was and nothing sent there; the account
 * on the phone, its 12 words included, is never written, let alone replaced. Nothing here contacts a node, the vault or
 * a provider: fake-vault.ts plays the global door, the vault and the local community, and the providers' sheets are
 * stubbed.
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

// Each provider's sheet, counted: one sign-in at the door, never a second.
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const subs = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
    const sheet = (provider: 'google' | 'apple' | 'facebook') => vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: subs[provider], nonce }), nonce }));
    const sheets = { google: sheet('google'), apple: sheet('apple'), facebook: sheet('facebook') };
    return {
        ...real,
        signInWithGoogle: sheets.google,
        signInWithApple: sheets.apple,
        signInWithFacebook: sheets.facebook,
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => ({ provider, ...await sheets[provider](nonce) })),
    };
});

import { openSeedFromSso, toEd25519Pkcs8, toEd25519Seed, REQUEST_SIGNING_VERSION } from '@beanpool/core';
import { signInWithGoogle } from '../sso-signin';
import { createIdentity, getMnemonic, importIdentity, loadIdentity, draftIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { getPendingOnboarding } from '../onboarding-state';
import { addSavedNode, clearGuestNode, getSavedNodes, isGuestNode, markGuestNode } from '../nodes';
import { askGlobalDoorOffer, forgetGlobalDoorOffer } from '../global-door-offer';
import { checkNameAtDoor, nextStepFor, signInAtDoor, submitJoin, type DoorAnswer, type DoorSignIn } from '../global-join';
import {
    ACCOUNT_DOOR_MESSAGES, accountDoorMessage, accountKeyForDoor, doorOfferedToAccount, finishJoinFromAccount, rememberAccountClosed, accountClosedAtGlobal,
    globalStandingOnPhone, isGlobalCommunity, type EnterDeps,
} from '../global-join-existing';
import { boundSignatureValid } from './server-signature-check';
import { COMMUNITY, GLOBAL, VAULT, installNetwork, noVault, useVault, type Network, type SentRequest } from './fake-vault';

const ANCHOR = 'beanpool_anchor_url';
const originalFetch = globalThis.fetch;
const quietError = console.error;

let net: Network;
let account: BeanPoolIdentity;
/** What the phone held before the door, byte for byte. */
let before: { secure: Map<string, string>; local: unknown };

/**
 * The global community's info and name check, beside fake-vault's door: open, Beans off, no invites, as global answers.
 * `join` replaces the door's answer to the join itself when a test needs another one.
 */
function globalAnswers(opts: { open?: boolean; join?: (req: SentRequest) => { status: number; body: unknown } } = {}): void {
    const door = net.global.handle.bind(net.global);
    net.global.handle = (req: SentRequest) => {
        if (req.method === 'GET' && req.path === '/api/community/info') {
            return {
                status: 200,
                body: { profile: 'global', requestSigning: REQUEST_SIGNING_VERSION, features: { openJoin: opts.open !== false, invites: false, beans: false } },
            };
        }
        if (req.method === 'GET' && req.path.startsWith('/api/members/callsign-available/')) return { status: 200, body: { available: true } };
        if (req.method === 'POST' && req.path === '/api/join' && opts.join) return opts.join(req);
        return door(req);
    };
}

/** The data layer the phone switches communities with: the real saved list and guest marks, the database stubbed. */
function enterDeps(): EnterDeps & { closeDB: ReturnType<typeof vi.fn>; initDB: ReturnType<typeof vi.fn>; requestSync: ReturnType<typeof vi.fn> } {
    return { closeDB: vi.fn(async () => {}), initDB: vi.fn(async () => {}), requestSync: vi.fn(async () => {}), addSavedNode, clearGuestNode };
}

/** A member of the local community at COMMUNITY, looking in on the global one as a guest. */
async function seedPhone(identity?: BeanPoolIdentity): Promise<void> {
    if (identity) await importIdentity(identity);
    else account = await createIdentity('Sam');
    if (identity) account = identity;
    await addSavedNode(COMMUNITY, 'Mullum');
    await addSavedNode(GLOBAL, 'Global community');
    await markGuestNode(GLOBAL);
    mem.async.set(ANCHOR, GLOBAL);
    before = { secure: new Map(mem.secure), local: (await getSavedNodes()).find(n => n.url === COMMUNITY) };
}

const to = (origin: string) => net.sent.filter(s => s.origin === origin);
const signedTo = (origin: string) => to(origin).filter(s => s.method === 'POST' || s.headers['X-Public-Key']);

async function signIn(identity: BeanPoolIdentity): Promise<DoorSignIn> {
    const r = await signInAtDoor('google', GLOBAL, identity);
    if (r.kind !== 'signed_in') throw new Error(`expected a sign-in, got ${JSON.stringify(r)}`);
    return r.signin;
}

/** The phone holds exactly what it held before: the account (words and all), no wizard, the local community as it was. */
async function accountUntouched(): Promise<void> {
    expect(mem.secure).toEqual(before.secure);
    const stored = await loadIdentity();
    expect(stored?.publicKey).toBe(account.publicKey);
    expect(stored?.privateKey).toBe(account.privateKey);
    expect(await getMnemonic(stored)).toEqual(account.mnemonic ?? null);
    expect(await getPendingOnboarding()).toBeNull();
    expect((await getSavedNodes()).find(n => n.url === COMMUNITY)).toEqual(before.local);
    expect(to(COMMUNITY)).toHaveLength(0);
}

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
    forgetGlobalDoorOffer();
    net = installNetwork();
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
    vi.restoreAllMocks();
});

describe('where an account the phone already has is offered the door', () => {
    it('a guest of the global community, once it says its door is open; never a member there, never before it has said', async () => {
        await seedPhone();
        globalAnswers();
        expect(await globalStandingOnPhone()).toBe('guest');
        expect(doorOfferedToAccount({ doorOpen: false, hasAccount: true, standing: 'guest' })).toBe(false);
        expect(await askGlobalDoorOffer()).toBe(true);
        expect(doorOfferedToAccount({ doorOpen: true, hasAccount: true, standing: 'guest' })).toBe(true);
        // In its list as a member, or not known yet: nothing offered. Not in the list at all: offered (the sheet, Settings).
        expect(doorOfferedToAccount({ doorOpen: true, hasAccount: true, standing: 'member' })).toBe(false);
        expect(doorOfferedToAccount({ doorOpen: true, hasAccount: true, standing: 'unknown' })).toBe(false);
        expect(doorOfferedToAccount({ doorOpen: true, hasAccount: true, standing: 'none' })).toBe(true);
        expect(doorOfferedToAccount({ doorOpen: true, hasAccount: false, standing: 'none' })).toBe(false);
    });

    it('a door the global community says is shut offers nothing', async () => {
        await seedPhone();
        globalAnswers({ open: false });
        expect(await askGlobalDoorOffer()).toBe(false);
    });

    it('the phone\'s standing from what it keeps: not in its list, a guest, a member', async () => {
        account = await createIdentity('Sam');
        await addSavedNode(COMMUNITY, 'Mullum');
        mem.async.set(ANCHOR, COMMUNITY);
        expect(await globalStandingOnPhone()).toBe('none');
        await addSavedNode(GLOBAL, 'Global community');
        expect(await globalStandingOnPhone()).toBe('member');
        await markGuestNode(GLOBAL);
        expect(await globalStandingOnPhone()).toBe('guest');
        expect(isGlobalCommunity('https://global.beanpool.org/')).toBe(true);
        expect(isGlobalCommunity(COMMUNITY)).toBe(false);
        expect(net.sent).toHaveLength(0);
    });

    it('the door\'s key is the account on the phone, as it is; a phone with none gets none, and nothing is made', async () => {
        expect(await accountKeyForDoor()).toBeNull();
        expect(mem.secure.size).toBe(0);
        await seedPhone();
        const key = await accountKeyForDoor();
        expect(key).toEqual({ identity: await loadIdentity(), createdHere: false });
        expect(mem.secure).toEqual(before.secure);
    });
});

describe('through the door with the key on the phone', () => {
    async function joinAsTheAccount(): Promise<{ answer: DoorAnswer; signin: DoorSignIn; deps: ReturnType<typeof enterDeps> }> {
        const key = await accountKeyForDoor();
        if (!key) throw new Error('no account');
        const signin = await signIn(key.identity);
        expect(await checkNameAtDoor(GLOBAL, 'Sam', key)).toEqual({ kind: 'free' });
        const answer = await submitJoin(GLOBAL, key.identity, 'Sam', signin);
        const deps = enterDeps();
        if (answer.kind === 'joined') {
            const joined = await finishJoinFromAccount(answer, key, 'Sam', { deps });
            expect(joined?.name).toBe('Sam');
        }
        return { answer, signin, deps };
    }

    it('signs every request with ITS key, joins, and ends a member of the global community; the local community and the 12 words untouched', async () => {
        await seedPhone();
        globalAnswers();
        const { answer, deps } = await joinAsTheAccount();

        expect(answer.kind).toBe('joined');
        // Every signed request to the door is the account's, and the node would take each as signed by it.
        const signed = signedTo(GLOBAL);
        expect(signed.map(s => s.path)).toEqual(['/api/join/sso-nonce', '/api/join']);
        for (const req of signed) {
            expect(req.headers['X-Public-Key']).toBe(account.publicKey);
            expect(boundSignatureValid({ url: req.url, method: req.method, headers: req.headers, body: req.raw }, account.publicKey)).toBe(true);
        }
        expect(signInWithGoogle).toHaveBeenCalledTimes(1);

        // A build without a vault: the copy rides in the join, sealed to this sign-in, and it is THIS key and the SAME words.
        const join = to(GLOBAL).find(s => s.path === '/api/join')!;
        const opened = await openSeedFromSso(join.body.recovery.shares[0], 'google', 'google-sub-42');
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(toEd25519Seed(hexToBytes(account.privateKey))).toString('hex'));
        expect(opened.words).toEqual(account.mnemonic);

        // In: switched to the global community, kept in the list, no longer a guest there.
        expect(mem.async.get(ANCHOR)).toBe(GLOBAL);
        expect(await isGuestNode(GLOBAL)).toBe(false);
        expect((await getSavedNodes()).map(n => n.url)).toEqual([COMMUNITY, GLOBAL]);
        expect(deps.closeDB).toHaveBeenCalledTimes(1);
        expect(deps.initDB).toHaveBeenCalledTimes(1);
        expect(deps.requestSync).toHaveBeenCalledTimes(1);

        // And the phone's account was never written: same key, same 12 words, no join wizard, the local community as it was.
        await accountUntouched();
    });

    it('with the key vault: the copy goes to the vault with the same sign-in, of this key and the same 12 words; nothing else changes', async () => {
        useVault();
        net = installNetwork();
        await seedPhone();
        globalAnswers();
        const { answer } = await joinAsTheAccount();

        expect(answer).toMatchObject({ kind: 'joined', enrolment: { enrolledSso: ['google'], wordsSealed: true } });
        const join = to(GLOBAL).find(s => s.path === '/api/join')!;
        expect(join.body.recovery).toBeUndefined();
        const deposit = to(VAULT).find(s => s.path === '/v1/copies')!;
        expect(deposit.headers['X-Public-Key']).toBe(account.publicKey);
        const [copy] = net.vault.copiesOf(account.publicKey);
        const opened = await openSeedFromSso(copy.clientCopy, 'google', 'google-sub-42');
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(toEd25519Seed(hexToBytes(account.privateKey))).toString('hex'));
        expect(opened.words).toEqual(account.mnemonic);
        expect(signInWithGoogle).toHaveBeenCalledTimes(1);
        await accountUntouched();
    });

    it('an account whose phone holds no words, in the browser\'s key format: signed as it is, and the copy is the key alone', async () => {
        const words = await draftIdentity('Sam');
        const seed = toEd25519Seed(hexToBytes(words.privateKey));
        const noWords: BeanPoolIdentity = { publicKey: words.publicKey, privateKey: Buffer.from(toEd25519Pkcs8(seed)).toString('hex'), callsign: 'Sam', createdAt: words.createdAt };
        await seedPhone(noWords);
        globalAnswers();
        const { answer } = await joinAsTheAccount();

        expect(answer.kind).toBe('joined');
        for (const req of signedTo(GLOBAL)) {
            expect(boundSignatureValid({ url: req.url, method: req.method, headers: req.headers, body: req.raw }, noWords.publicKey)).toBe(true);
        }
        const join = to(GLOBAL).find(s => s.path === '/api/join')!;
        const opened = await openSeedFromSso(join.body.recovery.shares[0], 'google', 'google-sub-42');
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(seed).toString('hex'));
        expect(opened.words ?? null).toBeNull();
        await accountUntouched();
    });

    it('this sign-in joined with another account: refused, nothing on the phone changes, and no restore is offered', async () => {
        await seedPhone();
        globalAnswers({
            join: () => ({ status: 409, body: { code: 'already_joined', error: 'This Google account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.' } }),
        });
        const { answer, deps } = await joinAsTheAccount();

        expect(answer.kind).toBe('already_joined');
        expect(nextStepFor(answer)).toBe('restore');
        if (answer.kind === 'joined') throw new Error('expected a refusal');
        expect(accountDoorMessage(answer)).toBe(ACCOUNT_DOOR_MESSAGES.otherAccount);
        expect(accountDoorMessage(answer)).not.toMatch(/Restore/);
        // Still the guest it was, on the community it was on: nothing to put back.
        expect(mem.async.get(ANCHOR)).toBe(GLOBAL);
        expect(await isGuestNode(GLOBAL)).toBe(true);
        expect(deps.closeDB).not.toHaveBeenCalled();
        await accountUntouched();
    });

    it('global answers account_closed: told so with no Try again, remembered for this key, and the door is no longer offered', async () => {
        await seedPhone();
        globalAnswers({
            join: () => ({ status: 403, body: { code: 'account_closed', error: "This key's account in this community was closed, so the community no longer accepts it." } }),
        });
        const { answer } = await joinAsTheAccount();
        expect(answer.kind).toBe('account_closed');
        expect(nextStepFor(answer)).toBe('closed');
        if (answer.kind === 'joined') throw new Error('expected a refusal');
        expect(accountDoorMessage(answer)).toBe("This account's place in the global community was closed, so it can't join again.");

        const input = { doorOpen: true, hasAccount: true, standing: 'none' as const };
        expect(doorOfferedToAccount(input)).toBe(true);
        expect(await accountClosedAtGlobal(account.publicKey)).toBe(false);
        await rememberAccountClosed(account.publicKey);
        await rememberAccountClosed(account.publicKey);
        expect(await accountClosedAtGlobal(account.publicKey)).toBe(true);
        expect(await accountClosedAtGlobal('another-key')).toBe(false);
        expect(JSON.parse(mem.async.get('beanpool_global_account_closed')!)).toHaveLength(1);
        expect(doorOfferedToAccount({ ...input, accountClosed: true })).toBe(false);
        expect(doorOfferedToAccount({ ...input, standing: 'guest', accountClosed: true })).toBe(false);
        await accountUntouched();
    });

    it('a member already (the phone took itself for a guest): the door says so at the sign-in, and the phone goes in', async () => {
        await seedPhone();
        globalAnswers();
        const door = net.global.handle;
        net.global.handle = (req: SentRequest) => {
            if (req.path === '/api/join/sso-nonce') return { status: 409, body: { code: 'already_member', error: 'This key is already a member of this community.' } };
            if (req.method === 'GET' && req.path === `/api/profile/${account.publicKey}`) return { status: 200, body: { callsign: 'Sam 2' } };
            return door(req);
        };
        const key = (await accountKeyForDoor())!;
        const r = await signInAtDoor('google', GLOBAL, key.identity);
        expect(r).toEqual({ kind: 'answered', answer: { kind: 'joined', enrolment: null } });
        expect(signInWithGoogle).not.toHaveBeenCalled();
        if (r.kind !== 'answered' || r.answer.kind !== 'joined') throw new Error('expected joined');
        const deps = enterDeps();
        const joined = await finishJoinFromAccount(r.answer, key, 'Sam', { deps });
        expect(joined?.name).toBe('Sam 2');
        expect(mem.async.get(ANCHOR)).toBe(GLOBAL);
        expect(await isGuestNode(GLOBAL)).toBe(false);
        await accountUntouched();
    });

    it('a screen left before the answer switches nothing: the member is in, and the door says so next time', async () => {
        await seedPhone();
        mem.async.set(ANCHOR, COMMUNITY);
        globalAnswers();
        const key = (await accountKeyForDoor())!;
        const signin = await signIn(key.identity);
        const answer = await submitJoin(GLOBAL, key.identity, 'Sam', signin);
        if (answer.kind !== 'joined') throw new Error('expected joined');
        const deps = enterDeps();
        expect(await finishJoinFromAccount(answer, key, 'Sam', { deps, stillWanted: () => false })).toBeNull();
        expect(mem.async.get(ANCHOR)).toBe(COMMUNITY);
        expect(deps.closeDB).not.toHaveBeenCalled();
        await accountUntouched();
    });
});
