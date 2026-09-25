/**
 * The global community's door, the phone's half (utils/global-join.ts): every answer the door gives and the
 * screen it leads to, one sign-in that both joins and protects the account, and the one key a phone ever holds.
 *
 * Nothing here contacts a node or a sign-in provider. The `fetch` stub below plays the global community's door
 * (apps/server/src/routes/open-join.ts) and refuses anything addressed elsewhere; the providers' sheets are
 * stubbed, and counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    openBrowserAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
}));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

/** An unsigned JWT with these claims: enough for the phone, which only reads claims back (the node verifies). */
function fakeJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
}

// The providers' own sheets, counted: a second sign-in is exactly what "one sign-in, two jobs" must not ask for.
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    return {
        ...real,
        signInWithGoogle: vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: 'google-sub-42', nonce }), nonce, email: 'joiner@example.com' })),
        signInWithApple: vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: 'apple-sub-7', nonce }), nonce })),
        signInWithFacebook: vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: 'fb-sub-9', nonce }), nonce })),
    };
});

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSingleBlobSso, openSeedFromSso, toEd25519Seed } from '@beanpool/core';
import { signInWithGoogle, signInWithApple, signInWithFacebook } from '../sso-signin';
import { draftIdentity, loadIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { protectionFrom } from '../protection-state';
import { enrolmentFromJoin } from '../keeper-enrolment';
import { getPendingOnboarding, setPendingOnboarding, resumePlan } from '../onboarding-state';
import {
    readDoorAnswer,
    nextStepFor,
    doorMessage,
    signInAtDoor,
    submitJoin,
    joinKeyForThisPhone,
    commitJoinKey,
    keepJoinedIdentity,
    releaseJoinKey,
    adoptJoinKey,
    checkNameAtDoor,
    nameCheckMessage,
    doorWaysOut,
    joinedUnderNodeName,
    JOIN_TIMEOUT_MS,
    MAX_JOIN_NAME,
    type DoorAnswer,
    type JoinKey,
} from '../global-join';

const NODE = 'https://global.beanpool.org';
const NONCE = '/api/join/sso-nonce';
const JOIN = '/api/join';
const GH_START = '/api/join/github/start';
const GH_POLL = '/api/join/github/poll';

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
interface Seen { url: string; path: string; body: any; headers: Record<string, string> }

function answer({ status, body = {}, headers = {} }: Answer): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** The global community's door. `routes` answers by path; anything else, or any other host, fails. */
function installDoor(routes: Partial<Record<string, Answer | (() => Answer) | 'offline'>>): Seen[] {
    const seen: Seen[] = [];
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        const p = url.startsWith(NODE) ? url.slice(NODE.length) : url;
        seen.push({ url, path: p, body, headers: { ...(init?.headers ?? {}) } });
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        const a = routes[p];
        if (!a || a === 'offline') throw new TypeError('Network request failed');
        return answer(typeof a === 'function' ? a() : a);
    }) as any;
    return seen;
}

const NONCE_OK: Answer = { status: 200, body: { nonce: 'door-nonce-1', expiresInSeconds: 600, providers: ['apple', 'google', 'facebook', 'github'], githubFlow: 'node', clientIds: {} } };

function joinedAnswer(extra: Record<string, unknown> = {}): Answer {
    return {
        status: 200,
        body: {
            success: true,
            member: { publicKey: 'x', callsign: 'Sam' },
            provider: 'google',
            recovery: { enrolled: true, generation: 1, provider: 'google', shareCount: 1, threshold: 1, keepers: ['sso'], enrolledSso: ['google'] },
            ...extra,
        },
    };
}

const originalFetch = globalThis.fetch;
let joiner: BeanPoolIdentity;

const quietError = console.error;
beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    // identity.ts's legacy migration reaches AsyncStorage through `require`, which no vi.mock reaches: in plain Node
    // it fails and says so on every read. It is caught there and changes nothing, so only that line is quietened.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    joiner = await draftIdentity('');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('each answer from the door, and where it takes the member', () => {
    const screen = (status: number, body: unknown, retryAfter: number | null = null) => {
        const a = readDoorAnswer(status, body, retryAfter);
        return { kind: a.kind, next: nextStepFor(a), a };
    };

    it('200 or 201: joined, on to Your Photo, with the name the node kept', () => {
        expect(screen(200, { success: true, member: { callsign: 'Sam 2' } })).toMatchObject({ kind: 'joined', next: 'continue', a: { callsign: 'Sam 2' } });
        expect(screen(201, { success: true })).toMatchObject({ kind: 'joined', next: 'continue' });
    });

    it('409 already_member: this key is in already (an earlier join landed), so it carries on', () => {
        expect(screen(409, { code: 'already_member', error: 'This key is already a member of this community.' }))
            .toMatchObject({ kind: 'joined', next: 'continue' });
    });

    it('409 already_joined: the sign-in has an account there, so the member restores it', () => {
        const s = screen(409, { code: 'already_joined', error: 'This Google account already has a BeanPool identity here. Restore it with your 12 words or your sign-in instead.' });
        expect(s).toMatchObject({ kind: 'already_joined', next: 'restore' });
        expect(doorMessage(s.a as Exclude<DoorAnswer, { kind: 'joined' }>)).toMatch(/Restore it/);
    });

    it('429 with Retry-After: the limit, said with when to try again, and back to the sign-in', () => {
        const s = screen(429, { code: 'rate_limited', error: 'Too many new accounts have joined from this network in the last hour (5). Please try again later.' }, 120);
        expect(s).toMatchObject({ kind: 'rate_limited', next: 'retry', a: { retryAfterSeconds: 120 } });
        expect(doorMessage(s.a as any)).toMatch(/Try again in 2 minutes/);
        expect(screen(429, {}, null).a).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: null });
    });

    it('403 (and the 404 a shut door answers): closed, and invites are the way in', () => {
        const forbidden = screen(403, { error: 'Forbidden' });
        expect(forbidden).toMatchObject({ kind: 'door_closed', next: 'closed' });
        const shut = screen(404, { code: 'invite_only', error: 'This community is invite-only.' });
        expect(shut).toMatchObject({ kind: 'door_closed', next: 'closed' });
        expect(doorMessage(shut.a as any)).toMatch(/invite/);
        expect(doorMessage(shut.a as any)).not.toMatch(/invite-only/);
    });

    it('403 removed and 403 key_invalidated: closed, each with its own reason', () => {
        expect(screen(403, { code: 'removed', error: 'The BeanPool identity this Google account joined with was removed from this community, so it can\'t join again.' }))
            .toMatchObject({ kind: 'removed', next: 'closed' });
        expect(screen(403, { code: 'key_invalidated', error: 'This key was replaced.' })).toMatchObject({ kind: 'key_invalidated', next: 'closed' });
    });

    it('401: the sign-in was refused, sign in again', () => {
        expect(screen(401, { code: 'sign_in', error: 'jwt expired' })).toMatchObject({ kind: 'sign_in_again', next: 'retry' });
    });

    it('400 and 5xx: try again, with the node\'s words when it has some', () => {
        expect(screen(503, { code: 'sign_in_unavailable', error: 'Google sign-in could not be checked right now.' }))
            .toMatchObject({ kind: 'try_again', next: 'retry', a: { message: 'Google sign-in could not be checked right now.' } });
        expect(screen(400, { error: 'Please choose a name of at least 2 characters.' })).toMatchObject({ kind: 'try_again', next: 'retry' });
        expect(screen(502, null)).toMatchObject({ kind: 'try_again', next: 'retry' });
    });

    it('no answer at all: unreachable, back to the sign-in', async () => {
        installDoor({ [JOIN]: 'offline' });
        const a = await submitJoin(NODE, { ...joiner, callsign: 'Sam' }, 'Sam', { provider: 'google', idToken: fakeJwt({ sub: 's' }), nonce: 'n', sub: 's' });
        expect(a.kind).toBe('unreachable');
        expect(nextStepFor(a)).toBe('retry');
    });
});

describe('one sign-in, two jobs: the join carries the recovery copy, and nothing asks for a second sign-in', () => {
    it('signs in once at the door, with the door\'s own nonce, signed by the joining key', async () => {
        const seen = installDoor({ [NONCE]: NONCE_OK, [JOIN]: joinedAnswer() });
        const result = await signInAtDoor('google', NODE, joiner);

        expect(result.kind).toBe('signed_in');
        expect(signInWithGoogle).toHaveBeenCalledTimes(1);
        expect(signInWithGoogle).toHaveBeenCalledWith('door-nonce-1');
        const nonceCall = seen.find(s => s.path === NONCE)!;
        expect(nonceCall.headers['X-Public-Key']).toBe(joiner.publicKey);
        // The door's nonce, never the recovery one (bound to a member key, not a joining one).
        expect(seen.some(s => s.path.startsWith('/api/recovery/'))).toBe(false);
    });

    it('sends the join with the token, the nonce and the seed sealed to that sign-in, and reads back a covered account', async () => {
        const seen = installDoor({ [NONCE]: NONCE_OK, [JOIN]: joinedAnswer() });
        const result = await signInAtDoor('google', NODE, joiner);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        const identity = { ...joiner, callsign: 'Sam' };
        const a = await submitJoin(NODE, identity, 'Sam', result.signin);

        expect(a.kind).toBe('joined');
        const join = seen.find(s => s.path === JOIN)!;
        expect(join.headers['X-Public-Key']).toBe(joiner.publicKey);
        expect(join.body).toMatchObject({ callsign: 'Sam', provider: 'google', nonce: 'door-nonce-1' });
        expect(typeof join.body.idToken).toBe('string');
        expect(join.body.recovery.shares).toHaveLength(1);
        const share = join.body.recovery.shares[0];
        expect(share).toMatchObject({ holderType: 'sso', holderRef: 'google', shareIndex: 1 });
        expect(isSingleBlobSso(share.kdfParams)).toBe(true);

        // Sealed to THIS sign-in's subject, and it gives back this phone's key and its 12 words.
        const opened = await openSeedFromSso(share, 'google', 'google-sub-42');
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(toEd25519Seed(hexToBytes(joiner.privateKey))).toString('hex'));
        expect(opened.words).toEqual(joiner.mnemonic);
        await expect(openSeedFromSso(share, 'google', 'someone-else')).rejects.toThrow();

        // Safety Backup shows the sign-in as protecting the account: no second prompt, no second deposit.
        if (a.kind !== 'joined') throw new Error('expected joined');
        expect(a.enrolment).toMatchObject({ enrolledSso: ['google'], wordsSealed: true, generation: 1 });
        expect(protectionFrom(a.enrolment).state).toBe('covered');
        expect(signInWithGoogle).toHaveBeenCalledTimes(1);
        expect(signInWithApple).not.toHaveBeenCalled();
        expect(signInWithFacebook).not.toHaveBeenCalled();
        expect(seen.map(s => s.path)).toEqual([NONCE, JOIN]);
    });

    it('when the node could not store the copy, the join still stands and Safety Backup offers the ordinary connect', async () => {
        installDoor({ [NONCE]: NONCE_OK, [JOIN]: joinedAnswer({ recovery: { enrolled: false, error: 'The recovery keeper could not be stored.' } }) });
        const result = await signInAtDoor('google', NODE, joiner);
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        const a = await submitJoin(NODE, { ...joiner, callsign: 'Sam' }, 'Sam', result.signin);
        expect(a).toMatchObject({ kind: 'joined', enrolment: null });
        expect(protectionFrom(null).state).toBe('words-only');
    });

    it('GitHub: the door runs it, the join carries the node\'s session (never a token), sealed to the id GitHub gave the node', async () => {
        const seen = installDoor({
            [NONCE]: NONCE_OK,
            [GH_START]: { status: 200, body: { sessionId: 'door-gh-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900, intervalSeconds: 0.01 } },
            [GH_POLL]: { status: 200, body: { status: 'ok', sub: '5550001' } },
            [JOIN]: joinedAnswer({ provider: 'github', recovery: { enrolled: true, generation: 1, enrolledSso: ['github'], threshold: 1 } }),
        });
        const prompts: string[] = [];
        const result = await signInAtDoor('github', NODE, joiner, { onGithubPrompt: p => prompts.push(p.userCode) });
        if (result.kind !== 'signed_in') throw new Error('expected a sign-in');
        expect(prompts).toEqual(['ABCD-1234']);
        const a = await submitJoin(NODE, { ...joiner, callsign: 'Sam' }, 'Sam', result.signin);
        expect(a.kind).toBe('joined');

        const join = seen.find(s => s.path === JOIN)!;
        expect(join.body.proof).toEqual({ sessionId: 'door-gh-1' });
        expect(join.body.idToken).toBeUndefined();
        const opened = await openSeedFromSso(join.body.recovery.shares[0], 'github', '5550001');
        expect(opened.words).toEqual(joiner.mnemonic);
        // Both GitHub calls are the door's pair, signed by the joining key.
        for (const p of [GH_START, GH_POLL]) {
            expect(seen.find(s => s.path === p)!.headers['X-Public-Key']).toBe(joiner.publicKey);
        }
    });

    it('enrolmentFromJoin reads only an answer that says the copy is stored', () => {
        expect(enrolmentFromJoin({ enrolled: true, enrolledSso: ['apple'] }, 'apple', false)).toMatchObject({ enrolledSso: ['apple'], isSingleBlob: true, wordsSealed: false });
        expect(enrolmentFromJoin({ enrolled: false }, 'apple', true)).toBeNull();
        expect(enrolmentFromJoin(undefined, 'apple', true)).toBeNull();
        expect(enrolmentFromJoin('yes', 'apple', true)).toBeNull();
    });
});

describe('the door answering before any sign-in', () => {
    it('a shut door (404) is said before a provider is ever opened', async () => {
        installDoor({ [NONCE]: { status: 404, body: { code: 'invite_only', error: 'This community is invite-only.' } } });
        const result = await signInAtDoor('google', NODE, joiner);
        expect(result).toMatchObject({ kind: 'answered', answer: { kind: 'door_closed' } });
        expect(signInWithGoogle).not.toHaveBeenCalled();
    });

    it('a key that is a member already (an earlier join landed) goes straight on', async () => {
        installDoor({ [NONCE]: { status: 409, body: { code: 'already_member' } } });
        const result = await signInAtDoor('facebook', NODE, joiner);
        expect(result).toMatchObject({ kind: 'answered', answer: { kind: 'joined' } });
        expect(signInWithFacebook).not.toHaveBeenCalled();
    });

    it('a door that never answers the nonce: unreachable once the wait runs out, never a spinner for good', async () => {
        vi.useFakeTimers();
        try {
            globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as any;
            let settled = false;
            const pending = signInAtDoor('google', NODE, joiner).finally(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toMatchObject({ kind: 'answered', answer: { kind: 'unreachable' } });
            expect(signInWithGoogle).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('the limiter (429) and no answer', async () => {
        installDoor({ [NONCE]: { status: 429, body: { error: 'Too many requests' }, headers: { 'Retry-After': '30' } } });
        expect(await signInAtDoor('google', NODE, joiner)).toMatchObject({ kind: 'answered', answer: { kind: 'rate_limited', retryAfterSeconds: 30 } });
        installDoor({ [NONCE]: 'offline' });
        expect(await signInAtDoor('google', NODE, joiner)).toMatchObject({ kind: 'answered', answer: { kind: 'unreachable' } });
    });
});

describe('one identity per device', () => {
    it('a phone with a key joins with that key: never a second one', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        const key = await joinKeyForThisPhone();
        expect(key).toMatchObject({ createdHere: false });
        expect(key.identity.publicKey).toBe(phoneKey.publicKey);
    });

    it('a phone without one gets a key in memory, written to the phone only on Join', async () => {
        const key = await joinKeyForThisPhone();
        expect(key.createdHere).toBe(true);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expect(await loadIdentity()).toBeNull();

        const identity = await commitJoinKey(key, 'Sam');
        expect(identity.callsign).toBe('Sam');
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
        expect(await getPendingOnboarding()).toMatchObject({
            step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: NODE, callsign: 'Sam', redeemed: false,
            freshKey: key.identity.publicKey,
        });
    });

    it('back at the door: a key made here and never written gives way to one the phone stored since, and is never written over it', async () => {
        const held = await joinKeyForThisPhone();
        // Meanwhile an invite join, with no key on the phone, made and stored its own.
        const inviteKey = await draftIdentity('Kim');
        await importIdentity(inviteKey);

        const key = await joinKeyForThisPhone(held);
        expect(key).toMatchObject({ createdHere: false });
        expect(key.identity.publicKey).toBe(inviteKey.publicKey);
        await commitJoinKey(key, 'Kim');
        expect((await loadIdentity())?.publicKey).toBe(inviteKey.publicKey);
        expect((await getPendingOnboarding())?.freshKey).toBeUndefined();
    });

    it('back at the door with the key this door made: the same key, still marked as this join\'s', async () => {
        const held = await joinKeyForThisPhone();
        expect(await joinKeyForThisPhone(held)).toBe(held);

        await commitJoinKey(held, 'Sam');
        const again = await joinKeyForThisPhone(held);
        expect(again).toMatchObject({ createdHere: true });
        expect(again.identity).toMatchObject({ publicKey: held.identity.publicKey, callsign: 'Sam' });
        // Still this join's, so a door that then refuses for good takes it off again.
        expect(await releaseJoinKey(again)).toBe(true);
        expect(await loadIdentity()).toBeNull();
    });

    it('a key the phone already had is not written again, and is never marked as this join\'s', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        vi.mocked(SecureStore.setItemAsync).mockClear();
        const key = await joinKeyForThisPhone();
        await commitJoinKey(key, 'Kim');
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        expect((await getPendingOnboarding())?.freshKey).toBeUndefined();
    });

    it('refused for good: a key this join made comes off the phone again, with its record', async () => {
        const key = await joinKeyForThisPhone();
        await commitJoinKey(key, 'Sam');
        expect(await releaseJoinKey(key)).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
    });

    const inviteWizard = { step: 'profileSetup' as const, inviteCode: 'INV-ABC', anchorUrl: 'https://test.beanpool.org', callsign: 'Kim', redeemed: true };

    it('refused for good: a key the phone already had stays, and gets back the wizard it was in', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        await setPendingOnboarding(inviteWizard);
        const key = await joinKeyForThisPhone();
        await commitJoinKey(key, 'Kim');
        // Kept inside the door's record, so it survives the app being killed before the door answers.
        expect(await getPendingOnboarding()).toMatchObject({ step: 'globalJoin', flow: 'global', before: inviteWizard });

        expect(await releaseJoinKey(key)).toBe(false);
        expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
        expect((await loadIdentity())?.publicKey).toBe(phoneKey.publicKey);
        expect(await getPendingOnboarding()).toEqual(inviteWizard);
    });

    it('a second try at the door keeps the wizard from before the first, never the door\'s own record', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        await setPendingOnboarding(inviteWizard);
        const key = await joinKeyForThisPhone();
        await commitJoinKey(key, 'Kim');
        await commitJoinKey(key, 'Kimberley');
        expect(await getPendingOnboarding()).toMatchObject({ callsign: 'Kimberley', before: inviteWizard });
        await releaseJoinKey(key);
        expect(await getPendingOnboarding()).toEqual(inviteWizard);
    });

    it('refused for good with a key the phone had and no wizard: the door\'s record goes, the key stays', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        const key = await joinKeyForThisPhone();
        await commitJoinKey(key, 'Kim');
        await releaseJoinKey(key);
        expect((await loadIdentity())?.publicKey).toBe(phoneKey.publicKey);
        expect(await getPendingOnboarding()).toBeNull();
    });

    it('refused before anything was written (at the sign-in): every record and key is left alone', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        await setPendingOnboarding(inviteWizard);
        expect(await releaseJoinKey(await joinKeyForThisPhone())).toBe(false);
        expect(await getPendingOnboarding()).toEqual(inviteWizard);

        // A key made for a join that the door refused at the sign-in, never written.
        const unwritten = { identity: await draftIdentity(), createdHere: true };
        expect(await releaseJoinKey(unwritten)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(phoneKey.publicKey);
        expect(await getPendingOnboarding()).toEqual(inviteWizard);
    });

    it('in, with a name the node made unique: the phone keeps the node\'s name, so a restart reads it back', async () => {
        const key = await joinKeyForThisPhone();
        const identity = await commitJoinKey(key, 'Sam');
        const kept = await keepJoinedIdentity({ ...identity, callsign: 'Sam 2' });
        expect(kept.callsign).toBe('Sam 2');
        const stored = await loadIdentity();
        expect(stored).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Sam 2' });
        expect(stored?.mnemonic).toEqual(key.identity.mnemonic);
    });

    it('in from the sign-in (already_member) with a key only in memory: the key goes on the phone before the wizard goes on', async () => {
        const key = await joinKeyForThisPhone();
        expect(await loadIdentity()).toBeNull();
        await keepJoinedIdentity({ ...key.identity, callsign: 'Sam' });
        const stored = await loadIdentity();
        expect(stored).toMatchObject({ publicKey: key.identity.publicKey, privateKey: key.identity.privateKey, callsign: 'Sam' });
        expect(stored?.mnemonic).toEqual(key.identity.mnemonic);
    });

    it('in with a key the phone already had: only its name changes, and nothing is written when the name is the same', async () => {
        const phoneKey = await draftIdentity('Kim');
        await importIdentity(phoneKey);
        vi.mocked(SecureStore.setItemAsync).mockClear();
        expect(await keepJoinedIdentity({ ...phoneKey, callsign: 'Kim' })).toEqual(phoneKey);
        expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
        await keepJoinedIdentity({ ...phoneKey, callsign: 'Kim 2' });
        expect(await loadIdentity()).toEqual({ ...phoneKey, callsign: 'Kim 2' });
    });

    it('in, while the phone holds a different account: refuses rather than writing over it', async () => {
        const other = await draftIdentity('Other');
        await importIdentity(other);
        const joined = await draftIdentity('Sam');
        await expect(keepJoinedIdentity(joined)).rejects.toThrow(/different BeanPool account/);
        expect(await loadIdentity()).toEqual(other);
    });

    it('never takes a key other than the one this join made', async () => {
        const made = await joinKeyForThisPhone();
        await commitJoinKey(made, 'Sam');
        // Something else put another key on the phone meanwhile.
        const other = await draftIdentity('Other');
        await importIdentity(other);
        expect(await releaseJoinKey(made)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
    });
});

describe('a key any node may hold is never taken off the phone', () => {
    const X = 'https://x.beanpool.org';
    /** The record handleCreate writes once an invite join has redeemed the phone's key at X (welcome.tsx). */
    const inviteRecord = { step: 'profileSetup' as const, inviteCode: 'INV-X', anchorUrl: X, callsign: 'Sam', redeemed: true };
    const PENDING = 'beanpool_pending_onboarding';

    const REFUSED_FOR_GOOD: Array<[string, Answer]> = [
        ['409 already_joined', { status: 409, body: { code: 'already_joined', error: 'This Google account already has a BeanPool identity here.' } }],
        ['403 removed', { status: 403, body: { code: 'removed', error: 'The BeanPool identity this Google account joined with was removed.' } }],
        ['404 invite_only (the door shut)', { status: 404, body: { code: 'invite_only', error: 'This community is invite-only.' } }],
    ];
    const RATE_LIMITED: Answer = { status: 429, body: { code: 'rate_limited', error: 'Too many new accounts have joined from this network.' } };
    const ALREADY_JOINED = REFUSED_FOR_GOOD[0][1];
    const SHUT = REFUSED_FOR_GOOD[2][1];
    /** The node took the join, and the answer never reached the phone. */
    const lostAnswer = (): Answer => { throw new TypeError('Network request failed'); };

    /** One visit to the door as welcome.tsx runs it: sign in, then Join (`commitJoinKey`, then `submitJoin`). */
    async function joinOnce(key: JoinKey, join: Answer | 'offline' | (() => Answer)): Promise<DoorAnswer> {
        installDoor({ [NONCE]: NONCE_OK, [JOIN]: join });
        const signedIn = await signInAtDoor('google', NODE, key.identity);
        if (signedIn.kind !== 'signed_in') throw new Error('expected a sign-in');
        const identity = await commitJoinKey(key, 'Sam');
        return submitJoin(NODE, identity, 'Sam', signedIn.signin);
    }

    /** The app starting again at the door: welcome.tsx's resume effect, which sets the door's key from the plan. */
    async function restartAtTheDoor(): Promise<JoinKey> {
        const plan = resumePlan(await getPendingOnboarding(), await loadIdentity());
        if (plan.action !== 'resume' || plan.mode !== 'globalJoin' || !plan.identity) throw new Error('expected a resume at the door');
        return { identity: plan.identity, createdHere: plan.freshKey };
    }

    async function expectKept(publicKey: string) {
        expect((await loadIdentity())?.publicKey).toBe(publicKey);
        expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    }

    describe('an invite join took over the key the door made (deciding pass, first finding)', () => {
        for (const [first, firstAnswer] of [['429', RATE_LIMITED], ['no answer', 'offline']] as const) {
            for (const [refusal, refusalAnswer] of REFUSED_FOR_GOOD) {
                it(`first join: ${first}; back, invite join with the same key, back to the door, refused for good (${refusal}): the key and the invite's record stay`, async () => {
                    const held = await joinKeyForThisPhone();
                    const K = held.identity.publicKey;
                    expect(nextStepFor(await joinOnce(held, firstAnswer))).toBe('retry');

                    // ← Back to Home, Join with an invite: handleCreate reuses the stored key, redeems it at X, and writes its record.
                    await setPendingOnboarding(inviteRecord);

                    // Back at the door, with the key the screen still holds from the first visit.
                    const key = await joinKeyForThisPhone(held);
                    expect(key.identity.publicKey).toBe(K);
                    expect(key.createdHere).toBe(false);
                    expect(nextStepFor(await joinOnce(key, refusalAnswer))).not.toBe('retry');

                    expect(await releaseJoinKey(key)).toBe(false);
                    await expectKept(K);
                    expect(await getPendingOnboarding()).toEqual(inviteRecord);
                });
            }
        }

        it('the same after a restart: the resume brings the door\'s key back, "Join with an invite" takes it over, and a later refusal leaves it', async () => {
            const first = await joinKeyForThisPhone();
            const K = first.identity.publicKey;
            await joinOnce(first, RATE_LIMITED);

            const held = await restartAtTheDoor();
            expect(held).toMatchObject({ createdHere: true });
            // "Join with an invite" on the door's screen: handleCreate reuses the key and writes its record.
            await setPendingOnboarding(inviteRecord);

            const key = await joinKeyForThisPhone(held);
            expect(key.createdHere).toBe(false);
            await joinOnce(key, ALREADY_JOINED);
            expect(await releaseJoinKey(key)).toBe(false);
            await expectKept(K);
            expect(await getPendingOnboarding()).toEqual(inviteRecord);
        });

        it('an invite join that sent the key but never wrote its record (its redeem failed): the door stops counting the key as its own', async () => {
            const held = await joinKeyForThisPhone();
            const K = held.identity.publicKey;
            await joinOnce(held, RATE_LIMITED);

            // handleCreate, just before it redeems with the stored key. The redeem then fails, so the door's record stays.
            await adoptJoinKey(K);
            expect(await getPendingOnboarding()).toMatchObject({ step: 'globalJoin', flow: 'global' });
            expect((await getPendingOnboarding())?.freshKey).toBeUndefined();

            const key = await joinKeyForThisPhone(held);
            expect(key.createdHere).toBe(false);
            await joinOnce(key, SHUT);
            expect(await releaseJoinKey(key)).toBe(false);
            await expectKept(K);
        });

        it('Join never writes a key over a different one the phone stored after the sign-in', async () => {
            const held = await joinKeyForThisPhone();
            const other = await draftIdentity('Kim');
            await importIdentity(other);
            await setPendingOnboarding(inviteRecord);
            await expect(commitJoinKey(held, 'Sam')).rejects.toThrow(/different BeanPool account/);
            expect(await loadIdentity()).toEqual(other);
            expect(await getPendingOnboarding()).toEqual(inviteRecord);
        });

        it('adoptJoinKey leaves any other record alone', async () => {
            const held = await joinKeyForThisPhone();
            await commitJoinKey(held, 'Sam');
            await adoptJoinKey((await draftIdentity()).publicKey);
            expect((await getPendingOnboarding())?.freshKey).toBe(held.identity.publicKey);
            await setPendingOnboarding(inviteRecord);
            await adoptJoinKey(held.identity.publicKey);
            expect(await getPendingOnboarding()).toEqual(inviteRecord);
        });
    });

    describe('a join that may have landed (deciding pass, second finding)', () => {
        it('join landed, answer lost, the door shut, sign in again (404 invite_only): the key stays, and reads as joined once the door opens', async () => {
            const key = await joinKeyForThisPhone();
            const K = key.identity.publicKey;
            let landed = false;
            const first = await joinOnce(key, () => { landed = true; return lostAnswer(); });
            expect(landed).toBe(true);
            expect(first.kind).toBe('unreachable');

            // The operator shuts the door and the member signs in again. The node says the door is shut before it looks
            // the key up (open-join.ts `joiningKey`), so this 404 says nothing about whether the key is a member.
            installDoor({ [NONCE]: SHUT });
            const again = await joinKeyForThisPhone(key);
            const refused = await signInAtDoor('google', NODE, again.identity);
            expect(refused).toMatchObject({ kind: 'answered', answer: { kind: 'door_closed' } });

            // On 591795c2 the screen handed this refusal to releaseJoinKey, which took the key off. The screen no longer
            // does (onboarding-resume.test.ts), and releaseJoinKey itself won't: the join it signed may have landed.
            expect(await releaseJoinKey(again)).toBe(false);
            await expectKept(K);
            expect(await getPendingOnboarding()).toMatchObject({ step: 'globalJoin', flow: 'global', freshKey: K });

            // The door opens again: the nonce says the key is a member, which reads as joined.
            installDoor({ [NONCE]: { status: 409, body: { code: 'already_member' } } });
            expect(await signInAtDoor('google', NODE, again.identity)).toMatchObject({ kind: 'answered', answer: { kind: 'joined' } });
        });

        for (const [refusal, refusalAnswer] of REFUSED_FOR_GOOD) {
            it(`an earlier join went unanswered, then the next join is refused for good (${refusal}): the key stays`, async () => {
                const key = await joinKeyForThisPhone();
                expect((await joinOnce(key, lostAnswer)).kind).toBe('unreachable');
                const again = await joinKeyForThisPhone(key);
                expect(again.createdHere).toBe(true);
                await joinOnce(again, refusalAnswer);
                expect(await releaseJoinKey(again)).toBe(false);
                await expectKept(key.identity.publicKey);
            });
        }

        it('the same after a restart: an unanswered join still counts, so a refusal at the next join leaves the key', async () => {
            const first = await joinKeyForThisPhone();
            await joinOnce(first, { status: 502, body: null });
            const held = await restartAtTheDoor();
            const key = await joinKeyForThisPhone(held);
            expect(key.createdHere).toBe(true);
            await joinOnce(key, SHUT);
            expect(await releaseJoinKey(key)).toBe(false);
            await expectKept(first.identity.publicKey);
        });

        it('the join is counted on the phone before it is sent, so an app stopped mid-join never loses the key', async () => {
            const key = await joinKeyForThisPhone();
            let atSend: Record<string, unknown> | null = null;
            await joinOnce(key, () => { atSend = JSON.parse(mem.async.get(PENDING) ?? 'null'); return lostAnswer(); });
            expect(atSend).toMatchObject({ step: 'globalJoin', freshKey: key.identity.publicKey, joinsOut: 1 });
            // Killed here: the next launch comes back to the door, and nothing takes the key off.
            const held = await restartAtTheDoor();
            await joinOnce(held, ALREADY_JOINED);
            expect(await releaseJoinKey(held)).toBe(false);
            await expectKept(key.identity.publicKey);
        });

        it('a join the phone could not count is not sent', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const key = await joinKeyForThisPhone();
            const seen = installDoor({ [NONCE]: NONCE_OK, [JOIN]: joinedAnswer() });
            const signedIn = await signInAtDoor('google', NODE, key.identity);
            if (signedIn.kind !== 'signed_in') throw new Error('expected a sign-in');
            const identity = await commitJoinKey(key, 'Sam');
            vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
            const a = await submitJoin(NODE, identity, 'Sam', signedIn.signin);
            expect(a.kind).toBe('try_again');
            expect(seen.some(s => s.path === JOIN)).toBe(false);
        });

        it('a join the node took (2xx) is never counted as refused', async () => {
            const key = await joinKeyForThisPhone();
            expect((await joinOnce(key, joinedAnswer())).kind).toBe('joined');
            expect(await getPendingOnboarding()).toMatchObject({ freshKey: key.identity.publicKey, joinsOut: 1 });
            expect(await releaseJoinKey(key)).toBe(false);
            await expectKept(key.identity.publicKey);
        });
    });

    describe('a key no node can hold still comes off, as before', () => {
        for (const [refusal, refusalAnswer] of REFUSED_FOR_GOOD) {
            it(`made here, and its first join is refused for good (${refusal}): it comes off the phone with its record`, async () => {
                const key = await joinKeyForThisPhone();
                expect(nextStepFor(await joinOnce(key, refusalAnswer))).not.toBe('retry');
                expect(await releaseJoinKey(key)).toBe(true);
                expect(await loadIdentity()).toBeNull();
                expect(await getPendingOnboarding()).toBeNull();
            });
        }

        it('every join it signed was refused (429, 401, then the door shut): it comes off', async () => {
            const key = await joinKeyForThisPhone();
            expect((await joinOnce(key, RATE_LIMITED)).kind).toBe('rate_limited');
            expect((await joinOnce(await joinKeyForThisPhone(key), { status: 401, body: { code: 'sign_in', error: 'jwt expired' } })).kind).toBe('sign_in_again');
            const last = await joinKeyForThisPhone(key);
            expect((await joinOnce(last, SHUT)).kind).toBe('door_closed');
            expect(await releaseJoinKey(last)).toBe(true);
            expect(await loadIdentity()).toBeNull();
        });
    });
});

describe('the name step at the door: never a spinner for good, and it can always be left (G7 follow-up, 4106491691)', () => {
    const AVAILABLE = (name: string) => `/api/members/callsign-available/${encodeURIComponent(name)}`;
    const doorKey = (): JoinKey => ({ identity: joiner, createdHere: true });
    /** A node that takes the connection and then never answers, as a stalled one does. */
    function stalledDoor(): Seen[] {
        const seen: Seen[] = [];
        globalThis.fetch = vi.fn((input: any, init?: any) => {
            const url = String(input);
            seen.push({ url, path: url.slice(NODE.length), body: undefined, headers: { ...(init?.headers ?? {}) } });
            if (!url.startsWith(`${NODE}/`)) return Promise.reject(new TypeError(`Network request failed: the app contacted ${url}`));
            return new Promise<Response>(() => {});
        }) as any;
        return seen;
    }

    it('a free name goes on; a node that answers with an error goes on too, as before (it makes a taken name unique)', async () => {
        installDoor({ [AVAILABLE('Sam')]: { status: 200, body: { available: true } } });
        expect(await checkNameAtDoor(NODE, 'Sam', doorKey())).toEqual({ kind: 'free' });
        installDoor({ [AVAILABLE('Sam')]: 'offline' });
        expect(await checkNameAtDoor(NODE, 'Sam', doorKey())).toEqual({ kind: 'free' });
    });

    it('a node that never answers the check: the wait runs out, the screen says so, and nothing is stored or sent', async () => {
        vi.useFakeTimers();
        try {
            const seen = stalledDoor();
            let settled = false;
            const pending = checkNameAtDoor(NODE, 'Sam', doorKey()).finally(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const result = await pending;
            expect(result).toEqual({ kind: 'timed_out' });
            const said = nameCheckMessage('Sam', result);
            expect(said).toMatch(/didn't answer in time/);
            expect(said).toMatch(/nothing was sent/);
            expect(said).toMatch(/try again/);
            expect(said).toMatch(/go back/);
            // Only the check went out: no key on the phone, no record, no join.
            expect(seen.map(s => s.path)).toEqual([AVAILABLE('Sam')]);
            expect(await loadIdentity()).toBeNull();
            expect(await getPendingOnboarding()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaving while the check is out (Back to Home, or Use a different sign-in) ends it at once, and the request with it', async () => {
        stalledDoor();
        const leave = new AbortController();
        const pending = checkNameAtDoor(NODE, 'Sam', doorKey(), { signal: leave.signal });
        await Promise.resolve();
        leave.abort();
        expect(await pending).toEqual({ kind: 'cancelled' });
        const init = vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit;
        expect(init.signal?.aborted).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
    });

    it('while the check is out, every way off the name step stays open; only the join itself holds the screen', () => {
        expect(doorWaysOut('name', true, false)).toEqual({ back: true, otherSignIn: true });
        expect(doorWaysOut('name', false, false)).toEqual({ back: true, otherSignIn: true });
        expect(doorWaysOut('joining', true, false)).toEqual({ back: false, otherSignIn: false });
        // Unchanged elsewhere: the sign-in's own wait (bounded since 3e513312), and GitHub's code, which has its Cancel.
        expect(doorWaysOut('signIn', true, false).back).toBe(false);
        expect(doorWaysOut('signIn', true, true).back).toBe(true);
        expect(doorWaysOut('signIn', false, false).back).toBe(true);
    });

    it('a taken name: the free suggestions, no longer than the join keeps', async () => {
        globalThis.fetch = vi.fn(async (input: any) => {
            const url = String(input);
            if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
            const name = decodeURIComponent(url.slice(`${NODE}/api/members/callsign-available/`.length));
            return answer({ status: 200, body: { available: name !== 'Samantha Jane Smith' } });
        }) as any;
        const result = await checkNameAtDoor(NODE, 'Samantha Jane Smith', doorKey());
        expect(result.kind).toBe('taken');
        if (result.kind !== 'taken') return;
        expect(result.suggestionsTimedOut).toBe(false);
        expect(result.suggestions).toHaveLength(3);
        for (const s of result.suggestions) expect(s.length).toBeLessThanOrEqual(MAX_JOIN_NAME);
        expect(nameCheckMessage('Samantha Jane Smith', result)).toMatch(/already taken in the global community\. Pick one of the suggestions/);
    });

    it('a taken name whose suggestions never come: still said as taken once the wait runs out, and why there are none', async () => {
        vi.useFakeTimers();
        try {
            globalThis.fetch = vi.fn((input: any) => {
                const url = String(input);
                if (url === `${NODE}${AVAILABLE('Sam')}`) return Promise.resolve(answer({ status: 200, body: { available: false } }));
                return new Promise<Response>(() => {});
            }) as any;
            const pending = checkNameAtDoor(NODE, 'Sam', doorKey());
            await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
            const result = await pending;
            expect(result).toEqual({ kind: 'taken', suggestions: [], suggestionsTimedOut: true });
            const said = nameCheckMessage('Sam', result);
            expect(said).toMatch(/"Sam" is already taken/);
            expect(said).toMatch(/suggestions didn't load in time/);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a join learnt from already_member keeps the name the node holds, not the one typed (G7 follow-up, 4106491871)', () => {
    const PROFILE = (publicKey: string) => `/api/profile/${publicKey}`;
    const GOOGLE_SIGNIN = { provider: 'google' as const, idToken: fakeJwt({ sub: 'google-sub-42' }), nonce: 'door-nonce-1', sub: 'google-sub-42' };

    /** The first join went out as "Sam", the node kept "Sam 2", and the answer was lost. */
    async function lostAnswer(): Promise<BeanPoolIdentity> {
        return commitJoinKey(await joinKeyForThisPhone(), 'Sam');
    }

    it('after a restart, at the sign-in: the node is asked, signed by the key, and the phone keeps "Sam 2"', async () => {
        const typed = await lostAnswer();
        // The app restarts: the resume brings back the door's key and the name typed at the first Join.
        const plan = resumePlan(await getPendingOnboarding(), await loadIdentity());
        if (plan.action !== 'resume' || !plan.identity) throw new Error('expected a resume with the key');
        expect(plan.callsign).toBe('Sam');
        const seen = installDoor({
            [NONCE]: { status: 409, body: { code: 'already_member', error: 'This key is already a member of this community.' } },
            [PROFILE(typed.publicKey)]: { status: 200, body: { publicKey: typed.publicKey, callsign: 'Sam 2' } },
        });
        const result = await signInAtDoor('google', NODE, plan.identity);
        if (result.kind !== 'answered' || result.answer.kind !== 'joined') throw new Error('expected joined');
        const joined = await joinedUnderNodeName(NODE, result.answer, { ...plan.identity, callsign: plan.callsign });
        expect((await keepJoinedIdentity(joined)).callsign).toBe('Sam 2');
        expect(await loadIdentity()).toMatchObject({ publicKey: typed.publicKey, callsign: 'Sam 2' });
        const read = seen.find(s => s.path === PROFILE(typed.publicKey));
        expect(read?.headers['X-Public-Key']).toBe(typed.publicKey);
        expect(read?.headers['X-Signature']).toBeTruthy();
    });

    it('at the join itself (409 already_member): the same', async () => {
        const typed = await lostAnswer();
        installDoor({
            [JOIN]: { status: 409, body: { code: 'already_member' } },
            [PROFILE(typed.publicKey)]: { status: 200, body: { publicKey: typed.publicKey, callsign: 'Sam 2' } },
        });
        const answered = await submitJoin(NODE, typed, 'Sam', GOOGLE_SIGNIN);
        if (answered.kind !== 'joined') throw new Error('expected joined');
        expect((await keepJoinedIdentity(await joinedUnderNodeName(NODE, answered, typed))).callsign).toBe('Sam 2');
        expect((await loadIdentity())?.callsign).toBe('Sam 2');
    });

    for (const [what, reply] of [
        ['offline', 'offline'],
        ['refused (403)', { status: 403, body: { error: 'Read access requires a member identity' } }],
        ['an answer with no name', { status: 200, body: { publicKey: 'x' } }],
    ] as Array<[string, Answer | 'offline']>) {
        it(`the node can't say (${what}): the typed name stays, and no other name is made up`, async () => {
            const typed = await lostAnswer();
            installDoor({ [PROFILE(typed.publicKey)]: reply });
            const joined = await joinedUnderNodeName(NODE, { kind: 'joined', enrolment: null }, typed);
            expect(joined).toEqual(typed);
            expect((await keepJoinedIdentity(joined)).callsign).toBe('Sam');
        });
    }

    it('a node that never answers the name read: the typed name once the wait runs out, never a spinner for good', async () => {
        const typed = await lostAnswer();
        vi.useFakeTimers();
        try {
            globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as any;
            const pending = joinedUnderNodeName(NODE, { kind: 'joined', enrolment: null }, typed);
            await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
            expect(await pending).toEqual(typed);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a join whose own answer names the member: that name, and the node is not asked again', async () => {
        const typed = await lostAnswer();
        const seen = installDoor({});
        const joined = await joinedUnderNodeName(NODE, { kind: 'joined', enrolment: null, callsign: 'Sam 3' }, typed);
        expect(joined.callsign).toBe('Sam 3');
        expect(seen).toHaveLength(0);
    });
});
