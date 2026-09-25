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
import { isSingleBlobSso, openSeedFromSso, toEd25519Seed } from '@beanpool/core';
import { signInWithGoogle, signInWithApple, signInWithFacebook } from '../sso-signin';
import { draftIdentity, loadIdentity, importIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { protectionFrom } from '../protection-state';
import { enrolmentFromJoin } from '../keeper-enrolment';
import { getPendingOnboarding, setPendingOnboarding } from '../onboarding-state';
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
    JOIN_TIMEOUT_MS,
    type DoorAnswer,
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
