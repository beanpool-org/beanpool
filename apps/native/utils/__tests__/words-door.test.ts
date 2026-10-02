/**
 * The global community's 12-words door, the phone's half (two-doors design §2, §3, §4; S4): every refusal the door can
 * give said as a sentence with `Retry-After` as "try again in N minutes", the 12-words join with its door work, the
 * work on the sign-in door when the door asks for it, adding a sign-in later (§2.5) in a build with and without the
 * key vault, and the "one way back" card's schedule.
 *
 * Nothing here contacts a node or a provider: fake-vault.ts's `installNetwork` plays the global door (with real door
 * work, checked as the node checks it), the vault and a community, and throws for anything else. `expo-crypto` is
 * Node's native SHA-256, answering as expo-crypto 55 does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
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
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
const sheets = vi.hoisted(() => ({ subs: { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as Record<string, string>, opened: [] as string[] }));
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const sheet = (provider: 'google' | 'apple' | 'facebook') => async (nonce: string) => {
        sheets.opened.push(`${provider}:${nonce}`);
        return { idToken: fakeJwt({ sub: sheets.subs[provider], nonce }), nonce };
    };
    return {
        ...real,
        // A build without a vault's door calls each provider's own sheet; everything else, the one call.
        signInWithGoogle: vi.fn(sheet('google')),
        signInWithApple: vi.fn(sheet('apple')),
        signInWithFacebook: vi.fn(sheet('facebook')),
        signInWithProvider: vi.fn(async (provider: 'google' | 'apple' | 'facebook', nonce: string) => ({ provider, ...await sheet(provider)(nonce) })),
    };
});

import { openSeedFromSso, toEd25519Seed } from '@beanpool/core';
import { draftIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import { getPendingOnboarding } from '../onboarding-state';
import {
    DOOR_MESSAGES,
    WORK_MESSAGES,
    commitJoinKey,
    doorMessage,
    joinKeyForThisPhone,
    nextStepFor,
    readDoorAnswer,
    releaseJoinKey,
    signInAtDoor,
    submitJoin,
    submitWordsJoin,
    tryAgainIn,
    type DoorAnswer,
} from '../global-join';
import { startDoorWork, type DoorWorkRun } from '../door-work';
import { LINK_MESSAGES, linkSignIn, linkedNotice, readLinkAnswer, type LinkRefusal } from '../join-link';
import {
    ONE_WAY_BACK_WEEK_MS,
    dismissOneWayBack,
    dismissedOneWayBack,
    finishOneWayBack,
    oneWayBackPlace,
    readOneWayBack,
    startOneWayBack,
    type OneWayBack,
} from '../one-way-back';
import { readNodeProfile, wordsDoorOn } from '../node-profile';
import { GLOBAL, installNetwork, noVault, useVault, type Network } from './fake-vault';
import { boundSignatureValid } from './server-signature-check';

let net: Network;
let runs: DoorWorkRun[] = [];

function startWork(identity: BeanPoolIdentity, door: 'words' | 'sign-in'): DoorWorkRun {
    const run = startDoorWork({ url: GLOBAL, identity, door });
    runs.push(run);
    return run;
}

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    sheets.opened.length = 0;
    noVault();
    net = installNetwork();
});

afterEach(() => {
    for (const run of runs) run.cancel();
    runs = [];
});

/** A code-like word (`network_busy`, `work_invalid`): never in front of a member. */
const CODE_RE = /\b[a-z]+_[a-z_]+\b/;

describe('every refusal at the door is a sentence, never a code', () => {
    const read = (status: number, body: unknown, retryAfter: number | null = null) => {
        const a = readDoorAnswer(status, body, retryAfter);
        return { a, said: a.kind === 'joined' ? '' : doorMessage(a), next: nextStepFor(a) };
    };

    it('the work\'s refusals (work_*): fetched again by itself; the sentence only if it happens twice', () => {
        for (const code of ['work_required', 'work_invalid', 'work_expired', 'work_spent'] as const) {
            const { a, said, next } = read(400, { error: 'node text', code });
            expect(a).toEqual({ kind: 'work_again', code, message: WORK_MESSAGES[code] });
            expect(next).toBe('retry');
            expect(said).not.toMatch(CODE_RE);
            // The node's work_required sentence tells an app from before the work to update; this one isn't.
            expect(said).not.toMatch(/update/i);
        }
    });

    it('network_busy at the 12-words door: the sign-in door named, Retry-After as "try again in N minutes"', () => {
        expect(read(429, { code: 'network_busy', door: 'words', window: 'hour', retryAfterSeconds: 600 }, 600).said)
            .toBe('A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again in 10 minutes.');
        expect(read(429, { code: 'network_busy', door: 'words', window: 'day' }, 5 * 3600).said)
            .toBe('A very large number of 12-words accounts were made from your network today. Sign in to join now, or try again in about 5 hours.');
        // The funnel's name for it, should a node ever send it, reads the same.
        expect(read(429, { code: 'network_busy_words' }, 60).said).toMatch(/12-words accounts .* Sign in to join now, or try again in a minute\.$/);
        // The header lost on the way: the body's own number.
        expect(read(429, { code: 'network_busy', door: 'words', retryAfterSeconds: 120 }, null).said).toMatch(/try again in 2 minutes\.$/);
    });

    it('network_busy at the sign-in door, and the door\'s own limiter (429 with no code)', () => {
        const signIn = read(429, { code: 'network_busy', door: 'sign-in', window: 'hour' }, 1800);
        expect(signIn.said).toBe('Too many new accounts have joined from your network in the last hour. Please try again in 30 minutes.');
        expect(signIn.next).toBe('retry');
        const limiter = read(429, { error: 'Too many attempts. Try again in 42s' }, 42);
        expect(limiter.said).toBe('There were too many tries in a short time. Please try again in a minute.');
        // An older node's code keeps its own words, with the time added once.
        expect(read(429, { code: 'rate_limited', error: 'Too many new accounts have joined from this network.' }, 300).said)
            .toBe('Too many new accounts have joined from this network. (Try again in 5 minutes.)');
    });

    it('sign_in_required (the 12-words door shut here): the sign-in buttons, said plainly', () => {
        const { a, said, next } = read(403, { error: 'node text', code: 'sign_in_required' });
        expect(a.kind).toBe('sign_in_required');
        expect(next).toBe('sign_in');
        expect(said).toBe(DOOR_MESSAGES.signInRequired);
        expect(said).not.toMatch(CODE_RE);
    });

    it('"try again in N minutes" from Retry-After', () => {
        expect(tryAgainIn(1)).toBe('in a minute');
        expect(tryAgainIn(60)).toBe('in a minute');
        expect(tryAgainIn(61)).toBe('in 2 minutes');
        expect(tryAgainIn(59 * 60)).toBe('in 59 minutes');
        expect(tryAgainIn(3600)).toBe('in about an hour');
        expect(tryAgainIn(10 * 3600)).toBe('in about 10 hours');
    });

    it('a sweep: no answer the door can give reads as a code', () => {
        const bodies: [number, unknown, number | null][] = [
            [400, { code: 'work_invalid' }, null], [400, { code: 'bad_request', error: "'door' must be 'words' or 'sign-in'." }, null],
            [403, { code: 'sign_in_required' }, null], [403, { code: 'removed' }, null], [403, { code: 'account_closed' }, null],
            [404, { code: 'invite_only' }, null], [409, { code: 'already_joined' }, null], [429, { code: 'network_busy', door: 'words' }, 60],
            [429, { code: 'network_busy', door: 'sign-in' }, 60], [429, {}, 30], [401, { code: 'sign_in' }, null], [401, { code: 'ticket_expired' }, null],
            [503, { code: 'door_key_missing', error: 'This community can\'t check sign-ins right now, so it isn\'t taking new members this way. Nothing was saved. Please try again later.' }, null],
            [503, { code: 'join_failed', error: 'Your join could not be completed, and nothing was saved. Please try again in a minute.' }, null],
        ];
        for (const [status, body, retry] of bodies) {
            const a = readDoorAnswer(status, body, retry);
            if (a.kind === 'joined') continue;
            expect(doorMessage(a), JSON.stringify(body)).not.toMatch(CODE_RE);
        }
    });
});

describe('a node says whether it has the 12-words door', () => {
    it('only a node that says so outright; one that doesn\'t looks exactly as before', () => {
        expect(wordsDoorOn(readNodeProfile({ profile: 'global', features: { openJoin: true, wordsDoor: true } })?.features)).toBe(true);
        expect(wordsDoorOn(readNodeProfile({ profile: 'global', features: { openJoin: true, wordsDoor: false } })?.features)).toBe(false);
        expect(wordsDoorOn(readNodeProfile({ profile: 'global', features: { openJoin: true } })?.features)).toBe(false);
        expect(wordsDoorOn(readNodeProfile({ profile: 'global', features: { openJoin: true, wordsDoor: 'yes' } })?.features)).toBe(false);
    });
});

describe('the 12-words join, with its door work', () => {
    /** The door's screen: a key for this phone, its work started at once, the name, then the key on the phone and the join. */
    async function joinByWords(name = 'Sam') {
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'words');
        // Join tapped: the work first, while the member can still leave; then the key goes onto the phone; then the join.
        const ready = await run.solution();
        const identity = await commitJoinKey(key, name);
        const answer = await submitWordsJoin(GLOBAL, identity, name, run);
        return { key, run, ready, identity, answer };
    }

    it('joins with the name and the work alone: no provider, no token, no nonce, no email; every request signed by the joining key', async () => {
        const { key, ready, answer } = await joinByWords();
        expect(ready.kind).toBe('solved');
        expect(answer).toMatchObject({ kind: 'joined', callsign: 'Sam' });
        expect(net.global.joined.get(key.identity.publicKey)).toBe('words');

        const toGlobal = net.sent.filter(s => s.origin === GLOBAL);
        expect(toGlobal.map(s => s.path)).toEqual(['/api/join/work', '/api/join']);
        for (const req of toGlobal) {
            expect(req.headers['X-Public-Key']).toBe(key.identity.publicKey);
            expect(boundSignatureValid({ url: req.url, method: req.method, headers: req.headers, body: req.raw }, key.identity.publicKey)).toBe(true);
        }
        const join = toGlobal[1].body;
        expect(Object.keys(join).sort()).toEqual(['callsign', 'door', 'work']);
        expect(join).toMatchObject({ door: 'words', callsign: 'Sam' });
        expect(join.work.counters).toHaveLength(8);
        // The key was on the phone before the join went (memory brief-guardrails: a key the node may register is on disk first).
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
        // Nothing reached a provider or the vault.
        expect(sheets.opened).toEqual([]);
        expect(net.sent.every(s => s.origin === GLOBAL)).toBe(true);
    });

    it('a work refusal (work_expired once): a new challenge, solved, sent again; the member sees no error', async () => {
        net.global.refuseWork = { code: 'work_expired', times: 1 };
        const { answer } = await joinByWords();
        expect(answer.kind).toBe('joined');
        const paths = net.sent.filter(s => s.origin === GLOBAL).map(s => s.path);
        expect(paths).toEqual(['/api/join/work', '/api/join', '/api/join/work', '/api/join']);
    });

    it('twice in a row: then it is said, as a sentence, and the key the door made can come off the phone', async () => {
        net.global.refuseWork = { code: 'work_invalid', times: 2 };
        const { key, answer } = await joinByWords();
        expect(answer).toEqual({ kind: 'work_again', code: 'work_invalid', message: WORK_MESSAGES.work_invalid });
        // Both joins were refused by the node: nothing it signed can have landed.
        expect((await getPendingOnboarding())?.joinsOut).toBe(0);
        expect(await releaseJoinKey(key)).toBe(true);
        expect(await loadIdentity()).toBeNull();
    });

    it('a 12-words door shut here (sign_in_required): said at the work route, before any join is sent', async () => {
        net.global.wordsShut = true;
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'words');
        const answer = await submitWordsJoin(GLOBAL, key.identity, 'Sam', run);
        expect(answer).toEqual({ kind: 'sign_in_required', message: DOOR_MESSAGES.signInRequired });
        expect(net.sent.filter(s => s.path === '/api/join')).toHaveLength(0);
    });

    it('a ceiling at the join (network_busy, 12 words): the sentence with when, and the sign-in door named', async () => {
        const door = net.global.handle.bind(net.global);
        net.global.handle = (req) => req.path === '/api/join'
            ? { status: 429, body: { code: 'network_busy', door: 'words', window: 'hour', retryAfterSeconds: 900 } }
            : door(req);
        const { answer } = await joinByWords();
        expect(answer.kind).toBe('rate_limited');
        expect(doorMessage(answer as Exclude<DoorAnswer, { kind: 'joined' }>)).toBe(
            'A very large number of 12-words accounts were made from your network in the last hour. Sign in to join now, or try again in 15 minutes.');
    });
});

describe('the sign-in door does the work too, when the door asks for it (from the 30th join an hour from a network)', () => {
    it('at ordinary rates the work route says none, and the join carries none, exactly as before', async () => {
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'sign-in');
        const r = await signInAtDoor('google', GLOBAL, key.identity);
        if (r.kind !== 'signed_in') throw new Error('no sign-in');
        const identity = await commitJoinKey(key, 'Sam');
        expect(await submitJoin(GLOBAL, identity, 'Sam', r.signin, { work: run })).toMatchObject({ kind: 'joined' });
        const join = net.sent.find(s => s.path === '/api/join')!;
        expect(join.body.work).toBeUndefined();
    });

    it('asked for work: solved with the sign-in, sent with it, and a work refusal doesn\'t spend the sign-in', async () => {
        net.global.workLevel['sign-in'] = 1;
        net.global.refuseWork = { code: 'work_invalid', times: 1 };
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'sign-in');
        const r = await signInAtDoor('google', GLOBAL, key.identity);
        if (r.kind !== 'signed_in') throw new Error('no sign-in');
        const identity = await commitJoinKey(key, 'Sam');
        expect(await submitJoin(GLOBAL, identity, 'Sam', r.signin, { work: run })).toMatchObject({ kind: 'joined' });
        const joins = net.sent.filter(s => s.path === '/api/join');
        expect(joins).toHaveLength(2);
        expect(joins[1].body.work.counters).toHaveLength(8);
        // The same sign-in both times: one sheet.
        expect(joins[0].body.idToken).toBe(joins[1].body.idToken);
        expect(sheets.opened).toHaveLength(1);
    });

    it('a vault build whose ticket the door refuses: the backstop\'s second join carries new work (the first one\'s was spent)', async () => {
        useVault();
        net.global.workLevel['sign-in'] = 0;
        net.global.refuseTickets = 'ticket_expired';
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'sign-in');
        const r = await signInAtDoor('google', GLOBAL, key.identity);
        if (r.kind !== 'signed_in') throw new Error('no sign-in');
        expect(r.signin.vaultTicket).toBeTruthy();
        const identity = await commitJoinKey(key, 'Sam');
        expect(await submitJoin(GLOBAL, identity, 'Sam', r.signin, { work: run })).toMatchObject({ kind: 'joined' });
        const joins = net.sent.filter(s => s.path === '/api/join');
        expect(joins).toHaveLength(2);
        expect(joins[0].body.work.challenge).not.toBe(joins[1].body.work.challenge);
    });
});

describe('adding a sign-in later (§2.5): one sign-in, two jobs', () => {
    async function wordsMember(): Promise<BeanPoolIdentity> {
        const key = await joinKeyForThisPhone();
        const run = startWork(key.identity, 'words');
        await run.solution();
        const identity = await commitJoinKey(key, 'Sam');
        expect((await submitWordsJoin(GLOBAL, identity, 'Sam', run)).kind).toBe('joined');
        net.sent.length = 0;
        return identity;
    }

    it('a build without a vault: the link\'s own nonce, and the copy rides in the link, sealed to that sign-in; THIS key and the same words', async () => {
        const member = await wordsMember();
        const answer = await linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: null });
        expect(answer).toMatchObject({ kind: 'linked', provider: 'google', enrolment: { enrolledSso: ['google'] } });
        expect(net.global.joined.get(member.publicKey)).toBe('google');
        expect(sheets.opened).toEqual([`google:${net.global.linkNonce}`]);
        const sent = net.sent.map(s => s.path);
        expect(sent).toEqual(['/api/join/link/sso-nonce', '/api/join/link']);
        for (const req of net.sent) expect(boundSignatureValid({ url: req.url, method: req.method, headers: req.headers, body: req.raw }, member.publicKey)).toBe(true);
        const link = net.sent[1].body;
        const opened = await openSeedFromSso(link.recovery.shares[0], 'google', 'google-sub-42');
        expect(Buffer.from(opened.seed).toString('hex')).toBe(Buffer.from(toEd25519Seed(hexToBytes(member.privateKey))).toString('hex'));
        expect(opened.words).toEqual(member.mnemonic);
        if (answer.kind === 'linked') expect(linkedNotice(answer)).toMatch(/usual new-account limits\. If you lose this phone, sign in with Google/);
    });

    it('a vault build: the vault\'s ticket for this key, the sheet once, the link with the ticket, then the copy at the vault', async () => {
        useVault();
        const member = await wordsMember();
        const answer = await linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: null });
        expect(answer).toMatchObject({ kind: 'linked', enrolment: { enrolledSso: ['google'] } });
        expect(sheets.opened).toHaveLength(1);
        const link = net.sent.find(s => s.path === '/api/join/link')!;
        expect(typeof link.body.vaultTicket).toBe('string');
        expect(link.body.recovery).toBeUndefined();
        expect(net.vault.copiesOf(member.publicKey)).toHaveLength(1);
        // Global never gets a copy in a vault build.
        expect(JSON.stringify(net.sent.filter(s => s.origin === GLOBAL).map(s => s.body))).not.toMatch(/shares|clientCopy/);
    });

    it('the backstop: a door that won\'t take the vault\'s ticket gets the sheet once more with its own nonce; linked, without a copy', async () => {
        useVault();
        const member = await wordsMember();
        net.global.refuseTickets = 'ticket_expired';
        const notices: string[] = [];
        const answer = await linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: null, onSignInAgain: n => notices.push(n) });
        expect(answer).toMatchObject({ kind: 'linked', enrolment: null });
        expect(sheets.opened).toHaveLength(2);
        expect(sheets.opened[1]).toBe(`google:${net.global.linkNonce}`);
        expect(notices).toEqual(['Checking your sign-in another way…']);
        if (answer.kind === 'linked') expect(linkedNotice(answer)).toMatch(/your 12 words are still the way/);
    });

    it('every refusal in words, and nothing changed: a sign-in already someone\'s, a removed member\'s, a second link, not a member', async () => {
        const member = await wordsMember();
        net.global.takenSignIns.add('google:google-sub-42');
        const taken = await linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: null });
        expect(taken).toEqual({ kind: 'refused', reason: 'already_joined', message: LINK_MESSAGES.already_joined.replace('{provider}', 'Google') });
        expect(net.global.joined.get(member.publicKey)).toBe('words');

        net.global.removedSignIns.add('facebook:fb-sub-9');
        const removed = await linkSignIn({ url: GLOBAL, identity: member, provider: 'facebook', phoneLock: null });
        expect(removed).toMatchObject({ kind: 'refused', reason: 'removed' });
        expect(net.global.joined.get(member.publicKey)).toBe('words');

        expect((await linkSignIn({ url: GLOBAL, identity: member, provider: 'apple', phoneLock: null })).kind).toBe('linked');
        const again = await linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: null });
        expect(again).toMatchObject({ kind: 'refused', reason: 'already_linked' });

        const stranger = await draftIdentity();
        expect(await linkSignIn({ url: GLOBAL, identity: stranger, provider: 'google', phoneLock: null })).toMatchObject({ kind: 'refused', reason: 'not_a_member' });
    });

    it('the phone\'s lock not passed: nothing starts, nothing is sent', async () => {
        const member = await wordsMember();
        await expect(linkSignIn({ url: GLOBAL, identity: member, provider: 'google', phoneLock: async () => false })).rejects.toMatchObject({ reason: 'cancelled' });
        expect(net.sent).toHaveLength(0);
        expect(sheets.opened).toHaveLength(0);
    });

    it('each link refusal reads as a sentence, never a code; Retry-After as "try again in N minutes"', () => {
        const codes: [number, string | undefined, LinkRefusal][] = [
            [409, 'already_joined', 'already_joined'], [403, 'removed', 'removed'], [409, 'not_words_member', 'not_words_member'],
            [409, 'already_linked', 'already_linked'], [403, 'not_a_member', 'not_a_member'], [503, 'door_key_missing', 'door_key_missing'],
            [503, 'sign_in_unavailable', 'sign_in_unavailable'], [404, 'invite_only', 'door_closed'], [401, 'sign_in', 'sign_in_again'],
            [401, 'ticket_used', 'sign_in_again'], [503, 'link_failed', 'try_again'], [400, 'recovery_invalid', 'try_again'],
        ];
        for (const [status, code, reason] of codes) {
            const a = readLinkAnswer(status, { code, error: 'node text' }, 'google');
            expect(a, String(code)).toMatchObject({ kind: 'refused', reason });
            if (a.kind === 'refused') {
                expect(a.message).not.toMatch(CODE_RE);
                expect(a.message).not.toContain('{');
            }
        }
        const busy = readLinkAnswer(429, { error: 'Too many attempts. Try again in 200s' }, 'google', 200);
        expect(busy).toMatchObject({ reason: 'rate_limited', message: 'There were too many tries in a short time, so nothing was added. Please try again in 4 minutes.' });
    });
});

describe('the "one way back" card (§2.5): until a sign-in is added or the words are checked; back once after the first post and once after a week', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const start: OneWayBack = { url: GLOBAL, joinedAt: 0 };

    it('shown from the join until it is put away; then Settings only', () => {
        expect(oneWayBackPlace(start, DAY, false)).toBe('card');
        const away = dismissedOneWayBack(start, DAY, false);
        expect(oneWayBackPlace(away, 2 * DAY, false)).toBe('settings');
    });

    it('back once after the first post, then away again', () => {
        const away = dismissedOneWayBack(start, DAY, false);
        expect(oneWayBackPlace(away, 2 * DAY, true)).toBe('card');
        const again = dismissedOneWayBack(away, 2 * DAY, true);
        expect(oneWayBackPlace(again, 3 * DAY, true)).toBe('settings');
    });

    it('back once after a week, then Settings only for good', () => {
        let r = dismissedOneWayBack(start, DAY, false);
        r = dismissedOneWayBack(r, 2 * DAY, true);
        expect(oneWayBackPlace(r, ONE_WAY_BACK_WEEK_MS - 1, true)).toBe('settings');
        expect(oneWayBackPlace(r, ONE_WAY_BACK_WEEK_MS, true)).toBe('card');
        r = dismissedOneWayBack(r, ONE_WAY_BACK_WEEK_MS, true);
        expect(oneWayBackPlace(r, 30 * DAY, true)).toBe('settings');
        expect(oneWayBackPlace(r, 365 * DAY, true)).toBe('settings');
    });

    it('a post made while the card was up: its return is used by the first dismissal', () => {
        const r = dismissedOneWayBack(start, DAY, true);
        expect(oneWayBackPlace(r, 2 * DAY, true)).toBe('settings');
    });

    it('done (a sign-in added, or the words checked): never again, anywhere', async () => {
        expect(oneWayBackPlace({ ...start, done: 'linked' }, 0, false)).toBe('none');
        expect(oneWayBackPlace({ ...start, done: 'checked' }, 30 * DAY, true)).toBe('none');
        expect(oneWayBackPlace(null, 0, false)).toBe('none');

        const key = 'b'.repeat(64);
        await startOneWayBack(key, GLOBAL, 1000);
        expect(await readOneWayBack(key)).toEqual({ url: GLOBAL, joinedAt: 1000 });
        // A second join (or a restart) never restarts it.
        await startOneWayBack(key, GLOBAL, 5000);
        expect((await readOneWayBack(key))?.joinedAt).toBe(1000);
        await dismissOneWayBack(key, false, 2000);
        expect((await readOneWayBack(key))?.dismissedAt).toBe(2000);
        await finishOneWayBack(key, 'checked');
        expect(oneWayBackPlace(await readOneWayBack(key), 30 * DAY, true)).toBe('none');
        // Per account: another key on the phone has none.
        expect(await readOneWayBack('c'.repeat(64))).toBeNull();
    });
});

describe('the screens are wired to what is tested above (the screens can\'t render here: vitest.config.ts)', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
    const between = (s: string, from: string, to: string) => {
        const a = s.indexOf(from);
        const b = s.indexOf(to, a + from.length);
        expect(a, from).toBeGreaterThanOrEqual(0);
        return s.slice(a, b < 0 ? undefined : b);
    };

    it('a node without the 12-words door: the door looks exactly as before, the sign-in alone (both door screens)', () => {
        expect(src('app/welcome.tsx')).toMatch(/const words = wordsDoorOn\(check\.profile\.features\);\s*setWordsDoor\(words\);\s*setGlobalPhase\(words \? 'choose' : 'signIn'\);/);
        expect(src('app/join-global.tsx')).toMatch(/const words = wordsDoorOn\(check\.profile\.features\);\s*setWordsDoor\(words\);\s*setPhase\(words \? 'choose' : 'signIn'\);/);
    });

    it('the work starts as the door opens (the two choices), with the key the join is signed by', () => {
        const welcome = src('app/welcome.tsx');
        expect(between(welcome, "if (mode !== 'globalJoin' || globalPhase !== 'choose') return;", '}, [mode, globalPhase]);'))
            .toMatch(/joinKeyForThisPhone\(globalKey\)[\s\S]*doorWork\.start\(GLOBAL_NODE_URL, key\.identity, 'words'\)/);
        expect(between(src('app/join-global.tsx'), "if (phase !== 'choose') return;", '}, [phase, startWork]);'))
            .toMatch(/accountKeyForDoor\(\)[\s\S]*startWork\(GLOBAL_NODE_URL, account\.identity, 'words'\)/);
    });

    it('the 12-words join: the name check, then the work (Back still works), then the key onto the phone, then the join', () => {
        const join = between(src('app/welcome.tsx'), 'async function handleWordsJoin()', 'async function afterDoorAnswer(');
        const order = ['checkNameAtDoor(', 'await run.solution()', 'joinSendingRef.current = true', 'commitJoinKey(key, name)', 'submitWordsJoin('].map(s => join.indexOf(s));
        expect(order.every(i => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('the existing-account join by words asks no lock and writes no key: no sign-in, so no copy', () => {
        const join = between(src('app/join-global.tsx'), 'async function handleWordsJoin()', 'async function afterAnswer(');
        expect(join).not.toMatch(/authenticateUser|commitJoinKey|importIdentity|keepJoinedIdentity/);
        expect(join).toMatch(/submitWordsJoin\(GLOBAL_NODE_URL, account\.identity, typed, run\)/);
    });

    it('Safety Backup for a 12-words member: the words note first, the tickbox, then "Add a sign-in as a second way back"', () => {
        const backup = between(src('app/welcome.tsx'), "if (mode === 'seedBackup' && pendingIdentity)", "if (mode === 'onboardingGuide' && pendingIdentity)");
        expect(backup).toMatch(/\{wordsMember \? \(\s*<WordsBackupNote \/>/);
        const tick = backup.indexOf("I've saved these words");
        const add = backup.indexOf('WORDS_BACKUP_TEXT.addSignIn');
        expect(tick).toBeGreaterThan(backup.indexOf('<WordsBackupNote />'));
        expect(add).toBeGreaterThan(tick);
        // The phone's lock for a key the join didn't make, as the protection sheet asks it.
        expect(backup).toMatch(/<LinkSignInSheet[\s\S]*askPhoneLock=\{!pendingWordsAreNew\}/);
    });

    it('the card is on the landing screen and in Account Protection', () => {
        expect(src('app/(tabs)/index.tsx')).toContain('<OneWayBackCard place="landing" colors={colors} />');
        expect(src('app/(tabs)/settings.tsx')).toContain('<OneWayBackCard place="settings" colors={colors} />');
        // A 12-words join starts it; a sign-in join never does.
        expect(src('app/welcome.tsx')).toContain("if (way === 'words') await startOneWayBack(identity.publicKey, GLOBAL_NODE_URL);");
    });
});
