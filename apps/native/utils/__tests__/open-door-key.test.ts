/**
 * Another community's open door on a phone with no account (utils/open-door-key.ts; DESIGN-account-without-global-fable.md
 * §2.1 and §2.3, slice S2): the key rule every door shares (utils/door-key.ts), at the door's own address.
 *
 *   - No account: a key made in memory, nothing written to the phone until Join.
 *   - Join: the key and the wizard's record (flow `global`, step `globalJoin`, at THAT address) are on the phone before the
 *     join is sent, and the join is counted out at that door (global-join.ts counts every join at the door it goes to).
 *   - The join's own refusal for good: the key comes off with its record. No answer: the key and the record stay, and
 *     leaving the door takes nothing off. A refusal to try again: the key stays; leaving the door takes it off.
 *   - The phone's own account, and a key another door made, are never written or taken off here.
 *   - Once in: the phone's anchor and saved list at that address, and the wizard's record at Your Photo there, with the
 *     words as new (`newKey`), which the welcome screen resumes.
 *
 * Nothing is contacted: fetch answers the door's address in the test and refuses anything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({ openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined) }));
vi.mock('expo-apple-authentication', () => ({ isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
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

import { importIdentity, loadIdentity } from '../identity';
import { getPendingOnboarding, resumePlan, doorResumeUrl, doorJoinOut, setPendingOnboarding } from '../onboarding-state';
import { submitWordsJoin, commitJoinKey, joinKeyForThisPhone, releaseJoinKey } from '../global-join';
import type { DoorWorkRun } from '../door-work';
import { commitOpenDoorKey, finishOpenDoorJoin, openDoorKeyForThisPhone, releaseOpenDoorKey } from '../open-door-key';
import { getSavedNodes } from '../nodes';
import { readOneWayBack } from '../one-way-back';
import { GLOBAL_NODE_URL } from '../global-node-url';

const SELF = 'https://open.riverbend.example';
const ANCHOR = 'beanpool_anchor_url';
const realFetch = globalThis.fetch;

/** The door's 12-words work, already done: the join carries none (the fake door asks none). */
const NO_WORK = { solution: async () => ({ kind: 'none' }), again: async () => ({ kind: 'none' }) } as unknown as DoorWorkRun;

/**
 * The door at SELF answers the join with `answer` (null: the request goes nowhere, as a lost answer). What the phone held
 * at the moment the join left is kept in `atSend`.
 */
const atSend: { stored: string | null; joinsOut: number | undefined; flow?: string; anchorUrl?: string }[] = [];
const elsewhere: string[] = [];
function door(answer: { status: number; body: unknown } | null) {
    globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
        const url = String(input);
        if (!url.startsWith(`${SELF}/`)) { elsewhere.push(url); throw new TypeError(`Network request failed: ${url}`); }
        if (url === `${SELF}/api/join` && init?.method === 'POST') {
            const record = await getPendingOnboarding();
            atSend.push({ stored: (await loadIdentity())?.publicKey ?? null, joinsOut: record?.joinsOut, flow: record?.flow, anchorUrl: record?.anchorUrl });
            if (!answer) throw new TypeError('Network request failed');
            return new Response(JSON.stringify(answer.body), { status: answer.status });
        }
        throw new TypeError(`Network request failed: ${url}`);
    }) as typeof fetch;
}

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    atSend.length = 0;
    elsewhere.length = 0;
});
afterEach(() => {
    globalThis.fetch = realFetch;
    expect(elsewhere).toEqual([]);
});

describe('a phone with no account at another community\'s open door', () => {
    it('makes a key in memory and writes nothing until Join; the next try is the same key', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        expect(key.createdHere).toBe(true);
        expect(key.identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
        expect(mem.secure.size).toBe(0);
        expect(await getPendingOnboarding()).toBeNull();
        expect(await loadIdentity()).toBeNull();
        expect((await openDoorKeyForThisPhone(SELF, key)).identity.publicKey).toBe(key.identity.publicKey);
    });

    it('Join: the key and THAT door\'s record are on the phone before the join goes, counted there; in, it stays counted', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        const identity = await commitOpenDoorKey(SELF, key, 'Wren');
        expect(identity).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Wren' });
        expect(await getPendingOnboarding()).toMatchObject({
            step: 'globalJoin', flow: 'global', anchorUrl: SELF, inviteCode: '', callsign: 'Wren', redeemed: false,
            freshKey: key.identity.publicKey, joinsOut: 0,
        });
        door({ status: 200, body: { member: { callsign: 'Wren' } } });
        const answer = await submitWordsJoin(SELF, identity, 'Wren', NO_WORK);
        expect(answer).toMatchObject({ kind: 'joined', callsign: 'Wren' });
        // At the moment the join left: the key stored, the record at this door, the join counted.
        expect(atSend).toEqual([{ stored: key.identity.publicKey, joinsOut: 1, flow: 'global', anchorUrl: SELF }]);
        // A 2xx is never "refused": it stays counted, so nothing can take that key off now.
        expect(await releaseOpenDoorKey(SELF, key)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
    });

    it('the join\'s own refusal for good: no longer counted, and the key comes off with its record', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        const identity = await commitOpenDoorKey(SELF, key, 'Wren');
        door({ status: 403, body: { code: 'removed', error: 'removed' } });
        expect((await submitWordsJoin(SELF, identity, 'Wren', NO_WORK)).kind).toBe('removed');
        expect((await getPendingOnboarding())?.joinsOut).toBe(0);
        expect(await releaseOpenDoorKey(SELF, key)).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
    });

    it('no answer: the key and the record stay, leaving the door takes nothing off, and the next launch comes back to THIS door', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        const identity = await commitOpenDoorKey(SELF, key, 'Wren');
        door(null);
        expect((await submitWordsJoin(SELF, identity, 'Wren', NO_WORK)).kind).toBe('unreachable');
        expect(await releaseOpenDoorKey(SELF, key)).toBe(false);
        const stored = await loadIdentity();
        expect(stored?.publicKey).toBe(key.identity.publicKey);
        const record = await getPendingOnboarding();
        expect(record).toMatchObject({ step: 'globalJoin', anchorUrl: SELF, freshKey: key.identity.publicKey, joinsOut: 1 });
        expect(doorJoinOut(record)).toBe(true);
        expect(doorResumeUrl(resumePlan(record, stored))).toBe(SELF);
        // Back at the door after a restart: the same key, still this door's own.
        const again = await openDoorKeyForThisPhone(SELF);
        expect(again).toEqual({ identity: stored, createdHere: true });
    });

    it('a refusal to try again (too many from this network): the key stays; leaving the door then takes it off', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        const identity = await commitOpenDoorKey(SELF, key, 'Wren');
        door({ status: 429, body: { error: 'Too many' } });
        expect((await submitWordsJoin(SELF, identity, 'Wren', NO_WORK)).kind).toBe('rate_limited');
        expect((await loadIdentity())?.publicKey).toBe(key.identity.publicKey);
        expect((await getPendingOnboarding())?.joinsOut).toBe(0);
        expect(await releaseOpenDoorKey(SELF, key)).toBe(true);
        expect(await loadIdentity()).toBeNull();
        expect(await getPendingOnboarding()).toBeNull();
    });

    it('in: the phone is that community\'s, and the wizard goes on at Your Photo there with the words as new', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        const identity = await commitOpenDoorKey(SELF, key, 'Wren');
        const kept = await finishOpenDoorJoin(SELF, { ...identity, callsign: 'Wren 2' }, { enrolment: null, way: 'words', communityName: 'Riverbend Open' });
        // Under the name the node kept.
        expect(kept).toMatchObject({ publicKey: key.identity.publicKey, callsign: 'Wren 2' });
        expect((await loadIdentity())?.callsign).toBe('Wren 2');
        expect(mem.async.get(ANCHOR)).toBe(SELF);
        expect((await getSavedNodes()).map(n => [n.url, n.alias])).toEqual([[SELF, 'Riverbend Open']]);
        const record = await getPendingOnboarding();
        expect(record).toEqual({
            step: 'profileSetup', flow: 'global', inviteCode: '', anchorUrl: SELF, callsign: 'Wren 2', redeemed: true,
            joinEnrolment: null, newKey: key.identity.publicKey, joinDoor: 'words', communityName: 'Riverbend Open',
        });
        expect(doorJoinOut(record)).toBe(false);
        const plan = resumePlan(record, await loadIdentity());
        expect(plan).toMatchObject({ action: 'resume', mode: 'profileSetup', flow: 'global', anchorUrl: SELF, newKey: true, joinDoor: 'words', communityName: 'Riverbend Open' });
        expect(doorResumeUrl(plan)).toBeNull();
        // In by 12 words: one way back, at this community.
        expect(await readOneWayBack(key.identity.publicKey)).toMatchObject({ url: SELF });
        // From here the record is the wizard's: leaving any door takes nothing off.
        expect(await releaseOpenDoorKey(SELF, { ...key, identity: kept })).toBe(false);
        expect((await getPendingOnboarding())?.step).toBe('profileSetup');
    });
});

describe('never another key', () => {
    it('the phone\'s own account joins as it is: read as the account, never written, counted or taken off', async () => {
        const account = { publicKey: 'ab'.repeat(32), privateKey: '07'.repeat(32), callsign: 'Sam' } as any;
        await importIdentity(account);
        const writes = mem.secure.size;
        const key = await openDoorKeyForThisPhone(SELF);
        expect(key).toEqual({ identity: expect.objectContaining({ publicKey: account.publicKey }), createdHere: false });
        door({ status: 403, body: { code: 'removed' } });
        expect((await submitWordsJoin(SELF, key.identity, 'Sam', NO_WORK)).kind).toBe('removed');
        expect(await getPendingOnboarding()).toBeNull();
        expect(await releaseOpenDoorKey(SELF, key)).toBe(false);
        expect((await loadIdentity())?.publicKey).toBe(account.publicKey);
        expect(mem.secure.size).toBe(writes);
    });

    it('a key the global community\'s door made is that door\'s: never counted or taken off at another', async () => {
        const made = await joinKeyForThisPhone();
        const identity = await commitJoinKey(made, 'Sam');
        const globalRecord = await getPendingOnboarding();
        expect(globalRecord).toMatchObject({ flow: 'global', anchorUrl: GLOBAL_NODE_URL, freshKey: identity.publicKey, joinsOut: 0 });
        // At another door it reads as the phone's own key, not that door's.
        expect((await openDoorKeyForThisPhone(SELF)).createdHere).toBe(false);
        door({ status: 403, body: { code: 'removed' } });
        await submitWordsJoin(SELF, identity, 'Sam', NO_WORK);
        expect(await releaseOpenDoorKey(SELF, { identity, createdHere: true })).toBe(false);
        expect(await getPendingOnboarding()).toEqual(globalRecord);
        expect((await loadIdentity())?.publicKey).toBe(identity.publicKey);
        // The global community's own door still takes its own key off, as before.
        expect(await releaseJoinKey(made)).toBe(true);
        expect(await loadIdentity()).toBeNull();
    });

    it('a record at another door is never this door\'s: a different address reads as a different door', async () => {
        const key = await openDoorKeyForThisPhone(SELF);
        await commitOpenDoorKey(SELF, key, 'Wren');
        const other = 'https://commons.example.nz';
        expect((await openDoorKeyForThisPhone(other)).createdHere).toBe(false);
        expect(await releaseOpenDoorKey(other, key)).toBe(false);
        expect(await getPendingOnboarding()).toMatchObject({ anchorUrl: SELF, freshKey: key.identity.publicKey });
        // And a record from before S2, of the global door with no address, is no other door's.
        await setPendingOnboarding({ step: 'globalJoin', flow: 'global', inviteCode: '', anchorUrl: '', callsign: 'Wren', freshKey: key.identity.publicKey, joinsOut: 0 });
        expect(await releaseOpenDoorKey(SELF, key)).toBe(false);
    });
});
