/**
 * An account that leaves this phone with no connection still stops its push alerts there, once the phone is back online
 * (utils/push-leave.ts, utils/account-leaves-phone.ts, utils/push-registrations.ts).
 *
 * #1184 had Sign Out send the old key's signed DELETE /api/push-tokens once, best effort. Offline it never arrived and
 * nothing retried it: the old account's alerts, message previews included, kept reaching the phone, possibly someone
 * else's by then. And a registration already on its way when Sign Out started could land after the DELETE and bring the
 * row back. Here:
 *
 *   - Sign Out offline writes down one statement per community the token went to, signed by the old key before it goes,
 *     and a later online sync presents each, unsigned, until its community confirms; it survives an app restart, and a
 *     community that can't be reached or doesn't know the statement yet keeps it for next time;
 *   - a registration on its way at Sign Out finishes before the leave goes out, one not yet sent never is, and nothing
 *     registers for the leaving key after that;
 *   - a stamp that ran ahead of the clock is kept beside the key too, so after an iOS reinstall (app storage gone, the
 *     keychain kept) the account's Sign Out is still stamped after its registrations, and takes them;
 *   - the same account signing back in on this phone is never undone by its old statement, even with the clock set back
 *     and after a restart: its statements are taken back as its key is written to the phone again, never presented,
 *     even when its registration then can't land (offline), and their communities go back on the record for its next
 *     Sign Out; one already on its way as it signs back in is outranked by its new registration.
 *
 * Nothing contacts a node: fetch is a fake community per address (fake-communities.ts), which keeps push rows as the
 * server does (apps/server state-engine.ts registerPushToken / applyPushLeave, pinned over HTTP by
 * test-push-leave-statement.ts) and checks each signature from @beanpool/core's definitions and noble, never the app's.
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
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../../services/pillar-sync', () => ({ resetSyncFingerprints: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf } from '@beanpool/core';
import { forgetCommunityPush, signOutOfThisPhone, turnAlertsOffAt, unregisterPushTokenAt } from '../account-leaves-phone';
import { announceAccountOnPhone } from '../account-on-phone';
import { draftIdentity, importIdentity, loadIdentity, updateCallsign, type BeanPoolIdentity } from '../identity';
import { pendingLeaveStatements, presentLeaveStatements, type LeaveStatement } from '../push-leave';
import { carryAlertsOff, communitiesWithAlertsOff, markAlertsOff, markAlertsOn } from '../push-alerts-off';
import {
    leaveState, registerAccountForPush, registerPushTokenWithCommunity, registerWhereMissing, retryDueRegistrations, stopRegistering,
} from '../push-registrations';
import { Communities, PHONE_TOKEN, statementValid } from './fake-communities';
import {
    PUSH_ALERTS_OFF_STORE_KEY, PUSH_LEAVE_STATEMENTS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_STAMP_STORE_KEY, PUSH_TOKEN_STORE_KEY,
    SAVED_NODES_STORE_KEY,
} from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const BELLINGEN = 'https://bellingen.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const DAY = 24 * 60 * 60 * 1000;

let kim: BeanPoolIdentity;
let ben: BeanPoolIdentity;
let nodes: Communities;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const quietError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string'
            && (args[0].startsWith('Failed to migrate legacy identity') || args[0].startsWith('Failed to fully wipe native identity state'))) return;
        quietError(...args);
    });
    kim = await draftIdentity('Kim');
    ben = await draftIdentity('Ben');
    nodes = new Communities();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Kim on the phone, with its token registered at Mullum and at Byron (the app opened while set to each), Bellingen never. */
async function kimRegisteredAtMullumAndByron(): Promise<number[]> {
    await importIdentity(kim);
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    for (const community of [MULLUM, BYRON]) {
        mem.async.set(ANCHOR, community);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
    }
    expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
    return nodes.sent.filter((s) => s.method === 'POST').map((s) => s.body.registeredAt as number);
}

/** A fresh copy of the leave module, as after an app restart (nothing in memory; storage as it was). */
async function afterRestart(): Promise<typeof import('../push-leave')> {
    vi.resetModules();
    return import('../push-leave');
}

const stored = () => JSON.parse(mem.async.get(PUSH_LEAVE_STATEMENTS_STORE_KEY) ?? '[]') as LeaveStatement[];
/** Where the phone's record says its token went, for the account on it. */
const recorded = () => (JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]') as string[]).sort();
const leavesSent = (from = 0) => nodes.sent.slice(from).filter((s) => s.path.startsWith('/api/push-tokens/leave/'));

describe('Sign Out with no connection', () => {
    it('writes down, before the key goes, a statement for each community the token went to, signed by Kim\'s key for that community only', async () => {
        const registeredAt = await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';

        await signOutOfThisPhone(kim);

        expect(await loadIdentity()).toBeNull();
        const statements = stored();
        expect(statements.map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        for (const s of statements) {
            const host = audienceOf(s.community)!;
            expect(s).toMatchObject({ publicKey: kim.publicKey, token: PHONE_TOKEN, signedFor: host });
            expect(statementValid(host, kim.publicKey, PHONE_TOKEN, s.leftAt, s.signature)).toBe(true);
            // Good at its own community only.
            expect(statementValid(audienceOf(BELLINGEN)!, kim.publicKey, PHONE_TOKEN, s.leftAt, s.signature)).toBe(false);
            // After every registration the phone made.
            expect(s.leftAt).toBeGreaterThan(Math.max(...registeredAt));
        }
        // The rows are still there: nothing reached either community.
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
        // Written before any leave went out: the DELETEs (all failed) came after the statements were on the phone.
        const setItem = vi.mocked(AsyncStorage.setItem);
        const setAt = setItem.mock.invocationCallOrder[setItem.mock.calls.findIndex(([key]) => key === PUSH_LEAVE_STATEMENTS_STORE_KEY)];
        const firstDelete = nodes.sent.findIndex((s) => s.method === 'DELETE');
        expect(setAt).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[firstDelete]);
        // The record of where the token went goes with the account; the statements stay.
        expect(mem.async.has(PUSH_REGISTERED_AT_STORE_KEY)).toBe(false);
    });

    it('a later online sync presents each, unsigned, until its community confirms, across an app restart; then Kim\'s rows are gone', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        // Someone else signs in on the phone meanwhile.
        await importIdentity(ben);

        // The app restarts. Mullum is reachable, Byron not yet.
        const leave = await afterRestart();
        nodes.answer = (s) => (s.community === BYRON ? 'down' : 'up');
        const before = nodes.sent.length;
        await leave.presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        for (const req of nodes.sent.slice(before)) {
            expect(req.method).toBe('POST');
            expect(req.path).toBe(`/api/push-tokens/leave/${kim.publicKey}`);
            // Unsigned, and nothing of the account now on the phone.
            expect(req.headers['X-Public-Key']).toBeUndefined();
            expect(req.headers['X-Signature']).toBeUndefined();
            expect(JSON.stringify(req)).not.toContain(ben.publicKey);
            expect(Object.keys(req.body).sort()).toEqual(['leftAt', 'signature', 'signedFor', 'token']);
        }

        // Byron answers, but doesn't take it yet (a server error, then a name it doesn't know as its own): kept.
        nodes.answer = () => 500;
        await leave.presentLeaveStatements();
        nodes.answer = () => 421;
        await leave.presentLeaveStatements();
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);

        // Weeks later, still there after another restart; Byron is back.
        const again = await afterRestart();
        nodes.answer = () => 'up';
        await again.presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(mem.async.has(PUSH_LEAVE_STATEMENTS_STORE_KEY)).toBe(false);

        // Nothing left to present: no request.
        const quiet = nodes.sent.length;
        await again.presentLeaveStatements();
        expect(nodes.sent.length).toBe(quiet);
    });

    it('a community that says it will never act on a statement has it dropped; one that isn\'t reached keeps it', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        const [first] = stored();
        // A statement its community refuses for good (here: one whose signature was spoiled on the phone).
        mem.async.set(PUSH_LEAVE_STATEMENTS_STORE_KEY, JSON.stringify(stored().map((s) =>
            s.community === first.community ? { ...s, signature: Buffer.alloc(64).toString('base64') } : s)));
        nodes.answer = (s) => (s.community === first.community ? 'up' : 'down');

        await presentLeaveStatements();

        expect(stored().map((s) => s.community)).toEqual([first.community === MULLUM ? BYRON : MULLUM]);
    });

    it('a 2xx that isn\'t the community\'s own answer (a captive portal\'s sign-in page, or any other body) crosses nothing off', async () => {
        await kimRegisteredAtMullumAndByron();
        // Behind a captive portal: every request, the DELETEs too, is answered 200 with its page and reaches no community.
        nodes.answer = () => 'portal';
        await signOutOfThisPhone(kim);
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        await presentLeaveStatements();
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        // A 200 that says anything else is no confirmation either.
        nodes.answer = () => 200;
        await presentLeaveStatements();
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);

        // Through to the communities themselves: confirmed, and her rows go.
        nodes.answer = () => 'up';
        await presentLeaveStatements();
        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await pendingLeaveStatements()).toEqual([]);
    });

    it('online, the signed DELETE carries the leave\'s stamp and each community that takes it has its statement crossed off', async () => {
        await kimRegisteredAtMullumAndByron();

        await signOutOfThisPhone(kim);

        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(mem.async.has(PUSH_LEAVE_STATEMENTS_STORE_KEY)).toBe(false);
        const deletes = nodes.sent.filter((s) => s.method === 'DELETE');
        expect(deletes.map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        for (const d of deletes) expect(d.body.leftAt).toBe(Number(mem.async.get(PUSH_STAMP_STORE_KEY)));
        // No statement needed presenting.
        expect(nodes.sent.some((s) => s.path.startsWith('/api/push-tokens/leave/'))).toBe(false);
    });
});

describe('a registration and Sign Out at the same time', () => {
    it('a registration on its way when Sign Out starts finishes before the leave goes out, so the leave lands after it', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        // Mullum is slow: the registration is on its way, and lands only when let through.
        nodes.answer = (s) => (s.method === 'POST' && s.path === '/api/push-tokens' ? 'hold' : 'up');

        const registering = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        await vi.waitFor(() => expect(nodes.held).toHaveLength(1));
        const signingOut = signOutOfThisPhone(kim);
        // Sign Out waits for it: nothing of the leave has gone out.
        await new Promise((r) => setTimeout(r, 50));
        expect(nodes.sent.filter((s) => s.method === 'DELETE')).toHaveLength(0);

        nodes.releaseHeld();
        await registering;
        await signingOut;

        const registration = nodes.sent.find((s) => s.method === 'POST')!;
        const del = nodes.sent.find((s) => s.method === 'DELETE')!;
        expect(del.actedAt).toBeGreaterThan(registration.actedAt!);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(await loadIdentity()).toBeNull();
    });

    it('a registration that had not gone out when Sign Out started never goes out', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);

        const registering = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
        const leaving = stopRegistering(kim.publicKey);

        expect(await registering).toBe(false);
        await leaving;
        await signOutOfThisPhone(kim);
        expect(nodes.sent.filter((s) => s.method === 'POST' && s.path === '/api/push-tokens')).toHaveLength(0);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
    });

    it('nor does one whose leave began after it was stamped and while it was being signed, just before it would have gone', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        // Sign Out starts the moment the registration's stamp is written down: after its first look, before its last.
        let leaving: Promise<void> | undefined;
        vi.mocked(AsyncStorage.setItem).mockImplementation(async (key: string, value: string) => {
            mem.async.set(key, value);
            if (key === PUSH_STAMP_STORE_KEY && !leaving) leaving = stopRegistering(kim.publicKey);
        });

        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);

        expect(leaving).toBeDefined();
        await leaving;
        expect(nodes.sent).toHaveLength(0);
    });

    it('nothing registers for Kim after Sign Out starts, not even a name change during it; Kim written to the phone again does', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);

        await stopRegistering(kim.publicKey);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);
        // A name change announces the same key: still leaving.
        announceAccountOnPhone(kim.publicKey);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(false);
        // Someone else registers as before.
        expect(await registerPushTokenWithCommunity(ben, PHONE_TOKEN, 'android')).toBe(true);
        // The key comes off the phone, and Kim signs back in: registers again.
        announceAccountOnPhone(null);
        await importIdentity(kim);
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        expect(nodes.sent.filter((s) => s.method === 'POST').map((s) => s.body.publicKey)).toEqual([ben.publicKey, kim.publicKey]);
    });
});

describe('Kim signs back in on the same phone', () => {
    it('signing straight back in, still offline, her old statements are taken back and never presented: her rows stay, and her next Sign Out takes them', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        expect(stored()).toHaveLength(2);

        // She signs straight back in on the same phone while set to Mullum, still offline: her registration can't land.
        await importIdentity(kim);
        // Taken back as her key is written to the phone, before anything is presented.
        expect(await pendingLeaveStatements()).toEqual([]);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).rejects.toThrow();

        // Back online, the 5-minute sync (or a return to the app) presents what is waiting.
        nodes.answer = () => 'up';
        const before = nodes.sent.length;
        await presentLeaveStatements();

        expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
        // #1258 review 4116631769: her old statement removed her only row at Mullum, and nothing registered her again.
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(leavesSent(before)).toHaveLength(0);
        expect(await pendingLeaveStatements()).toEqual([]);
        // Both are back on the record, where her registrations from before still are, so her next Sign Out takes both.
        expect(recorded()).toEqual([BYRON, MULLUM]);
        await signOutOfThisPhone(kim);
        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await pendingLeaveStatements()).toEqual([]);
    });

    it('taking hers back leaves another account\'s statements: Ben signed in and out in between, and his still goes out', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);

        // Ben signs in while set to Mullum and his registration lands (no statement goes out), then he signs out offline.
        await importIdentity(ben);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = (s) => (s.path.startsWith('/api/push-tokens/leave/') ? 'down' : 'up');
        expect(await registerPushTokenWithCommunity(ben, PHONE_TOKEN, 'android')).toBe(true);
        expect(nodes.has(MULLUM, ben.publicKey)).toBe(true);
        nodes.answer = () => 'down';
        await signOutOfThisPhone(ben);
        expect(stored().map((s) => `${s.publicKey === kim.publicKey ? 'kim' : 'ben'} ${s.community}`).sort())
            .toEqual([`ben ${MULLUM}`, `kim ${BYRON}`, `kim ${MULLUM}`]);

        // Kim signs back in: only hers are taken back (#1258 review 4116787967).
        await importIdentity(kim);
        expect((await pendingLeaveStatements()).map((s) => [s.publicKey, s.community])).toEqual([[ben.publicKey, MULLUM]]);

        nodes.answer = () => 'up';
        await presentLeaveStatements();
        // Ben's alerts stop reaching Kim's phone; hers stay.
        expect(nodes.has(MULLUM, ben.publicKey)).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(await pendingLeaveStatements()).toEqual([]);
    });

    it('the app starting with her key back on the phone and her statements still written down (killed as she signed in): taken back, never presented', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        // Her key is written back, and the app is killed before anything else is.
        mem.secure.set('sovereign-identity', JSON.stringify(kim));

        const leave = await afterRestart();
        nodes.answer = () => 'up';
        const before = nodes.sent.length;
        await leave.presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(leavesSent(before)).toHaveLength(0);
        expect(await leave.pendingLeaveStatements()).toEqual([]);
        expect(recorded()).toEqual([BYRON, MULLUM]);
    });

    it('during her own Sign Out, a name change or a sync takes nothing back: the statements it has just written down go out', async () => {
        await kimRegisteredAtMullumAndByron();
        // The DELETEs are slow: Sign Out waits for them with her key still on the phone.
        nodes.answer = (s) => (s.method === 'DELETE' ? 'hold' : 'down');
        const signingOut = signOutOfThisPhone(kim);
        await vi.waitFor(() => expect(nodes.held).toHaveLength(2));
        expect(stored()).toHaveLength(2);

        // Meanwhile her name changes (her key written again) and the 5-minute sync runs.
        expect((await updateCallsign('Kimberley'))?.publicKey).toBe(kim.publicKey);
        const before = nodes.sent.length;
        await presentLeaveStatements();

        expect(leavesSent(before).map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        nodes.releaseHeld();
        await signingOut;
        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await pendingLeaveStatements()).toEqual([]);
    });

    it('her new registration outranks her old statement already on its way as she signs back in, with the clock set back a day and after a restart', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        const leftAt = stored()[0].leftAt;

        // The phone's clock goes back a day and the app restarts. Back online, the old statements go out, slowly...
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() - DAY);
        vi.resetModules();
        const leave = await import('../push-leave');
        const registrations = await import('../push-registrations');
        const identity = await import('../identity');
        nodes.answer = (s) => (s.path.startsWith('/api/push-tokens/leave/') ? 'hold' : 'up');
        const presenting = leave.presentLeaveStatements();
        await vi.waitFor(() => expect(nodes.held).toHaveLength(2));

        // ...and while they are on their way, Kim signs back in while set to Mullum.
        await identity.importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        expect(await registrations.registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        const back = nodes.sent.filter((s) => s.method === 'POST' && s.path === '/api/push-tokens').at(-1)!;
        expect(back.body.registeredAt).toBeGreaterThan(leftAt);

        // Then the old statements land.
        nodes.releaseHeld();
        await presenting;

        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true); // her registration since stays
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false); // the one from before, where she hasn't registered since, goes
        expect(await leave.pendingLeaveStatements()).toEqual([]);
    });

    it('signing out again later takes the new registration too', async () => {
        await kimRegisteredAtMullumAndByron();
        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = () => 'up';
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);

        nodes.answer = () => 'down';
        await signOutOfThisPhone(kim);
        // One statement per community and key: Mullum's newer one replaced the older.
        expect(stored().map((s) => s.community).sort()).toEqual([BYRON, MULLUM]);
        nodes.answer = () => 'up';
        await presentLeaveStatements();

        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await pendingLeaveStatements()).toEqual([]);
    });
});

describe('a stamp that ran ahead of the phone\'s clock', () => {
    it('is kept beside the key: after an iOS reinstall her Sign Out is still stamped after her registration a day ahead, and takes it', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        mem.async.set(ANCHOR, MULLUM);
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.now();
        // Her clock is a day ahead as the app registers: Mullum refuses it as stale (401), but the stamp is written down.
        vi.setSystemTime(now + DAY);
        nodes.answer = () => 401;
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).rejects.toThrow();
        // Her clock is put right. The next registration lands, stamped after that one: a day ahead of every clock.
        vi.setSystemTime(now);
        nodes.answer = () => 'up';
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        const ahead = nodes.sent.at(-1)!.body.registeredAt as number;
        expect(ahead).toBeGreaterThan(now + DAY);

        // The app is deleted and installed again: its app storage goes, the keychain keeps her key and the token (iOS).
        mem.async.clear();
        vi.resetModules();
        const registrations = await import('../push-registrations');
        const leaving = await import('../account-leaves-phone');
        const leave = await import('../push-leave');
        // She sets the phone to Mullum again, and the app registers her there.
        mem.async.set(ANCHOR, MULLUM);
        expect(await registrations.registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        expect(nodes.sent.at(-1)!.body.registeredAt).toBeGreaterThan(ahead);

        // Her Sign Out, online, takes her row: its stamp is later than the row's.
        await leaving.signOutOfThisPhone(kim);
        expect(nodes.sent.at(-1)!.body.leftAt).toBeGreaterThan(ahead);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(await leave.pendingLeaveStatements()).toEqual([]);
    });
});

describe('one community goes and the key stays (Forget Community; design R2)', () => {
    const phoneToken = async () => PHONE_TOKEN;
    const saved = (...urls: string[]) => { mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(urls.map((url) => ({ url })))); };
    const deletes = (from = 0) => nodes.sent.slice(from).filter((s) => s.method === 'DELETE');
    const posts = (from = 0) => nodes.sent.slice(from).filter((s) => s.method === 'POST' && s.path === '/api/push-tokens');

    /** Kim on Mullum, keeping Byron too, her token at both. */
    async function kimAtBoth(): Promise<void> {
        await kimRegisteredAtMullumAndByron();
        mem.async.set(ANCHOR, MULLUM);
        saved(MULLUM, BYRON);
    }

    const forget = (community: string) => forgetCommunityPush(kim, community, async () => saved(MULLUM));

    it('online: that community alone is sent the signed DELETE with a stamp later than its registration, and the key is not stopped', async () => {
        await kimAtBoth();
        const lastStamp = nodes.rowsAt(BYRON).get(`${kim.publicKey}|${PHONE_TOKEN}`) as number;
        const from = nodes.sent.length;

        await forget(BYRON);

        expect(deletes(from).map((s) => s.community)).toEqual([BYRON]);
        expect(deletes(from)[0].body).toEqual({ publicKey: kim.publicKey, token: PHONE_TOKEN, leftAt: expect.any(Number) });
        expect(deletes(from)[0].body.leftAt).toBeGreaterThan(lastStamp);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        // One statement, confirmed by the DELETE, and nothing left to present.
        expect(stored()).toEqual([]);
        expect(recorded()).toEqual([MULLUM]);
        // stopRegistering would have stopped them all.
        expect(leaveState(kim.publicKey)).toBe('none');
        expect(mem.secure.get(PUSH_TOKEN_STORE_KEY)).toBe(PHONE_TOKEN);
        const later = nodes.sent.length;
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 1000, AsyncStorage, MULLUM)).toBe(true);
        expect(posts(later).map((s) => s.community)).toEqual([MULLUM]);
    });

    it('offline: its one statement is not taken back with her key on the phone, and is presented until the community confirms', async () => {
        await kimAtBoth();
        nodes.answer = (s) => (s.community === BYRON ? 'down' : 'up');

        await forget(BYRON);

        expect(stored()).toMatchObject([{ community: BYRON, publicKey: kim.publicKey, keyStays: true }]);
        expect(recorded()).toEqual([MULLUM]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);

        // The app comes back, still with no way to Byron: kept. Not taken back, and Byron not put back on the record.
        await presentLeaveStatements();
        expect(stored()).toHaveLength(1);
        expect(recorded()).toEqual([MULLUM]);

        // Her key announced again (a name change, a restore of the same account): nothing changes.
        await updateCallsign('Kimberley');
        await presentLeaveStatements();
        expect(stored()).toHaveLength(1);

        // Byron is back: the statement lands, unsigned, and her row goes.
        nodes.answer = () => 'up';
        await presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(stored()).toEqual([]);
    });

    it('offline, and a restart before the community is back: the statement still lands', async () => {
        await kimAtBoth();
        nodes.answer = () => 'down';
        await forget(BYRON);
        expect(stored()).toHaveLength(1);

        const leave = await afterRestart();
        nodes.answer = () => 'up';
        await leave.presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(await leave.pendingLeaveStatements()).toEqual([]);
    });

    it('Sign Out afterwards leaves a forgotten community\'s statement standing, and signing back in doesn\'t take it back', async () => {
        await kimAtBoth();
        nodes.answer = (s) => (s.community === BYRON ? 'down' : 'up');
        await forget(BYRON);
        await signOutOfThisPhone(kim);
        expect(stored().map((s) => s.community)).toEqual([BYRON]);

        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        await presentLeaveStatements();
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        expect(recorded()).toEqual([]);

        nodes.answer = () => 'up';
        await presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
    });

    it('an ordinary leave\'s statement is still taken back when its key comes back: only the ones made with the key staying are kept', async () => {
        await kimAtBoth();
        nodes.answer = () => 'down';
        await forget(BYRON);
        await signOutOfThisPhone(kim);
        expect(stored().map((s) => [s.community, !!s.keyStays])).toEqual([[BYRON, true], [MULLUM, false]]);
        await importIdentity(kim);
        await presentLeaveStatements();
        expect(stored().map((s) => s.community)).toEqual([BYRON]);
        expect(recorded()).toEqual([MULLUM]);
    });

    it('a registration on its way to that community is waited for, and one on its way to another is not', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        saved(MULLUM, BYRON);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        nodes.answer = (s) => (s.method === 'POST' ? 'hold' : 'up');
        const toByron = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 12000, AsyncStorage, BYRON).catch(() => false);
        await vi.waitFor(() => expect(posts()).toHaveLength(1));

        const forgetting = forget(BYRON);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(deletes()).toEqual([]);

        nodes.releaseHeld();
        await toByron;
        await forgetting;
        expect(deletes().map((s) => s.community)).toEqual([BYRON]);
        // The row that landed first is the one the DELETE took.
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);

        // Not the same for a community that stays: Mullum's registration held does not hold up forgetting Bellingen.
        saved(MULLUM, BELLINGEN);
        nodes.answer = () => 'up';
        await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 12000, AsyncStorage, BELLINGEN);
        nodes.answer = (s) => (s.method === 'POST' ? 'hold' : 'up');
        const toMullum = registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 12000, AsyncStorage, MULLUM);
        await vi.waitFor(() => expect(posts().filter((s) => s.community === MULLUM)).toHaveLength(1));
        await forgetCommunityPush(kim, BELLINGEN, async () => saved(MULLUM));
        expect(deletes().map((s) => s.community)).toEqual([BYRON, BELLINGEN]);
        nodes.releaseHeld();
        await toMullum;
    });

    it('nothing registers there while the removal runs, the phone still set to it, however long that takes', async () => {
        await kimRegisteredAtMullumAndByron();
        mem.async.set(ANCHOR, BYRON);
        saved(MULLUM, BYRON);
        const from = nodes.sent.length;
        let duringRemoval: boolean | null = null;

        await forgetCommunityPush(kim, BYRON, async () => {
            duringRemoval = await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android');
            await registerAccountForPush(kim.publicKey, phoneToken, 'android');
            await registerWhereMissing(phoneToken, 'android');
            // The phone moves on (settings.tsx handleSwitchNode), and the list goes.
            mem.async.set(ANCHOR, MULLUM);
            saved(MULLUM);
        });

        expect(duringRemoval).toBe(false);
        expect(posts(from).filter((s) => s.community === BYRON)).toEqual([]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(recorded()).toEqual([MULLUM]);
    });

    it('a failed try at a community is due no more once it is forgotten, and it hears no more from this phone', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        saved(MULLUM, BYRON);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        nodes.answer = (s) => (s.community === BYRON && s.method === 'POST' ? 'down' : 'up');
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        await forget(BYRON);
        const from = nodes.sent.length;
        await retryDueRegistrations(phoneToken, 'android');
        await registerWhereMissing(phoneToken, 'android');
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(nodes.sent.slice(from).filter((s) => s.community === BYRON)).toEqual([]);
    });

    it('rejoining before the statement lands: the new registration carries a later stamp, and the statement can\'t take it', async () => {
        await kimAtBoth();
        nodes.answer = (s) => (s.community === BYRON ? 'down' : 'up');
        await forget(BYRON);
        expect(stored()).toHaveLength(1);

        nodes.answer = () => 'up';
        saved(MULLUM, BYRON);
        await registerAccountForPush(kim.publicKey, phoneToken, 'android');
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        await presentLeaveStatements();
        expect(stored()).toEqual([]);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
    });

    it('rejoining after the DELETE landed registers again, with a stamp the community takes', async () => {
        await kimAtBoth();
        await forget(BYRON);
        saved(MULLUM, BYRON);
        await registerWhereMissing(phoneToken, 'android');
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(recorded()).toEqual([BYRON, MULLUM].sort());
    });

    it('a community that never had the token is never handed it: the DELETE carries it, so a guest look that is forgotten hears nothing', async () => {
        await kimAtBoth();
        const from = nodes.sent.length;
        let removed = false;
        await forgetCommunityPush(kim, BELLINGEN, async () => { removed = true; });
        expect(removed).toBe(true);
        expect(nodes.sent.slice(from)).toEqual([]);
        expect(stored()).toEqual([]);
        expect(await turnAlertsOffAt(kim, BELLINGEN)).toBeUndefined();
        expect(nodes.sent.slice(from)).toEqual([]);
    });

    it('a phone that never had a token sends nothing, and the community still goes', async () => {
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        saved(MULLUM, BYRON);
        let removed = false;
        await forgetCommunityPush(kim, BYRON, async () => { removed = true; });
        expect(removed).toBe(true);
        expect(nodes.sent).toEqual([]);
        expect(stored()).toEqual([]);
    });

    it('no account on the phone: nothing is sent, and the community still goes', async () => {
        let removed = false;
        await forgetCommunityPush(null, BYRON, async () => { removed = true; });
        expect(removed).toBe(true);
        expect(nodes.sent).toEqual([]);
    });

    it('a removal that throws throws, and lets the community go on registering: the phone still keeps it', async () => {
        await kimAtBoth();
        await expect(forgetCommunityPush(kim, BYRON, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
        await registerWhereMissing(phoneToken, 'android');
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
    });

    it('neither a DELETE nor a statement went: the community stays on the record, so a later Sign Out still asks it', async () => {
        await kimAtBoth();
        nodes.answer = () => 'down';
        const noSignature = { publicKey: kim.publicKey, privateKey: '' };
        expect(await unregisterPushTokenAt(noSignature, BYRON)).toBe(false);
        expect(recorded()).toEqual([BYRON, MULLUM].sort());
    });
});

describe('alerts from one community, off and on (design R8, the DELETE half)', () => {
    const phoneToken = async () => PHONE_TOKEN;
    const saved = (...urls: string[]) => { mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(urls.map((url) => ({ url })))); };

    async function kimAtBoth(): Promise<void> {
        await kimRegisteredAtMullumAndByron();
        mem.async.set(ANCHOR, MULLUM);
        saved(MULLUM, BYRON);
    }

    it('off: that community is told, and stays off across a restart, a start and a return, while the phone keeps it', async () => {
        await kimAtBoth();
        await turnAlertsOffAt(kim, BYRON);
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(await communitiesWithAlertsOff()).toEqual([BYRON]);
        expect(JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY)!).map((n: { url: string }) => n.url)).toEqual([MULLUM, BYRON]);

        vi.resetModules();
        const registrations = await import('../push-registrations');
        await registrations.registerAccountForPush(kim.publicKey, phoneToken, 'android');
        await registrations.registerWhereMissing(phoneToken, 'android');
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
    });

    it('off with no connection: told by its statement, as Forget is', async () => {
        await kimAtBoth();
        nodes.answer = () => 'down';
        await turnAlertsOffAt(kim, BYRON);
        expect(stored()).toMatchObject([{ community: BYRON, keyStays: true }]);
        nodes.answer = () => 'up';
        await presentLeaveStatements();
        expect(nodes.has(BYRON, kim.publicKey)).toBe(false);
    });

    it('a list that can\'t be written says so, and tells nobody: the switch never says off while the token still goes there', async () => {
        await kimAtBoth();
        const from = nodes.sent.length;
        vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async () => { throw new Error('disk full'); });
        await expect(turnAlertsOffAt(kim, BYRON)).rejects.toThrow('disk full');
        expect(nodes.sent.slice(from)).toEqual([]);
        expect(await communitiesWithAlertsOff()).toEqual([]);
    });

    it('on again: off the list, and registered at the next chance', async () => {
        await kimAtBoth();
        await turnAlertsOffAt(kim, BYRON);
        await markAlertsOn(BYRON);
        await registerWhereMissing(phoneToken, 'android');
        expect(nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(mem.async.has(PUSH_ALERTS_OFF_STORE_KEY)).toBe(false);
    });

    it('a community that leaves the phone takes its choice with it: a rejoin starts from the default, on', async () => {
        await kimAtBoth();
        await turnAlertsOffAt(kim, BYRON);
        await forgetCommunityPush(kim, BYRON, async () => saved(MULLUM));
        expect(await communitiesWithAlertsOff()).toEqual([]);
    });

    it('a community followed to its new address keeps its choice there, and a list without it is left alone', async () => {
        await markAlertsOff(BYRON);
        await carryAlertsOff(BELLINGEN, MULLUM);
        expect(await communitiesWithAlertsOff()).toEqual([BYRON]);
        await carryAlertsOff(BYRON, `${MULLUM}/`);
        expect(await communitiesWithAlertsOff()).toEqual([MULLUM]);
    });

    it('a follow names the old address in one spelling, however the phone saved it: the choice still moves, and the token never goes to the new address', async () => {
        // A typed address keeps its capitals (node-url.ts normalizeNodeUrl); address-follow.ts offers plainOriginOf's lower case.
        const typed = 'https://Byron.example:443';
        await markAlertsOff(typed);
        await carryAlertsOff('https://byron.example', MULLUM);
        expect(await communitiesWithAlertsOff()).toEqual([MULLUM]);
        expect(await registerPushTokenWithCommunity(kim, 'ExponentPushToken[kim]', 'android', 1000, AsyncStorage, MULLUM)).toBe(false);
    });
});
