/**
 * A push registration that fails is tried again when the app comes back, not only at the next cold start
 * (utils/push-registrations.ts `registerAccountForPush` / `retryDueRegistrations`, services/push-notifications.ts,
 * app/_layout.tsx).
 *
 * The phone registered its push token only when the account's key changed. A registration that failed (no connection,
 * no answer within 12 s, a 5xx, or no token to be had with no connection) waited for the app's next cold start: a
 * member who signed in on a poor connection got no alerts from their community, recovery alerts included, and the
 * community could be missing from the push record, so their next Sign Out couldn't reach it (#1258 confirmation
 * 5859456754). Here:
 *
 *   - a registration that doesn't land stays due for its community, written down, and lands at the next return to the
 *     app once the network is back, even after an app restart; the community is then on the push record;
 *   - a community that refused it, or never answered, is left alone for a while, longer after each refusal in a row;
 *     one the phone never reached (no connection) is tried at the next chance;
 *   - #1258's rules hold: a retry goes through the same registration (stamped, never for a key that is leaving or has
 *     left); what was due for a key is dropped as its leave starts; nothing is tried for any key but the one on the
 *     phone; a key signing back in takes back its statements, and its registration then lands, stamped after them.
 *
 * Nothing contacts a node: fetch is a fake community per address (fake-communities.ts). The phone's push token comes
 * from a stub of Expo's, which can't be had with no connection, as Expo's can't.
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
import { signOutOfThisPhone } from '../account-leaves-phone';
import { discardUnjoinedIdentity, draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { pendingLeaveStatements, presentLeaveStatements, type LeaveStatement } from '../push-leave';
import {
    leaveState, registerAccountForPush, registerPushTokenWithCommunity, retryDueRegistrations, RETRY_FIRST_WAIT_MS, RETRY_LONGEST_WAIT_MS,
} from '../push-registrations';
import { saveRestoredAccount } from '../restore-account';
import { Communities, PHONE_TOKEN } from './fake-communities';
import {
    PUSH_LEAVE_STATEMENTS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY, PUSH_STAMP_STORE_KEY, PUSH_TOKEN_STORE_KEY,
} from '../storage-keys';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Expo's push token service as the phone meets it: the token when the phone is online, else it throws, as Expo's does. */
const expo = { online: true, asked: 0 };
async function phoneToken(): Promise<string> {
    expo.asked++;
    if (!expo.online) throw new TypeError('Network request failed');
    mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
    return PHONE_TOKEN;
}

let kim: BeanPoolIdentity;
let ben: BeanPoolIdentity;
let nodes: Communities;

function offline(): void {
    expo.online = false;
    nodes.answer = () => 'down';
}

function online(): void {
    expo.online = true;
    nodes.answer = () => 'up';
}

/** The app comes back to the foreground (or the 5-minute sync runs): app/_layout.tsx `retryPushRegistrations`. */
const comeBack = () => retryDueRegistrations(phoneToken, 'android');

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
    online();
    expo.asked = 0;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** A fresh copy of the registration module, as after an app restart (nothing in memory; storage as it was). */
async function afterRestart(): Promise<typeof import('../push-registrations')> {
    vi.resetModules();
    return import('../push-registrations');
}

const due = () => JSON.parse(mem.async.get(PUSH_REGISTRATIONS_DUE_STORE_KEY) ?? '[]') as Array<Record<string, unknown>>;
/** Where the phone's record says its token went, for the account on it. */
const recorded = () => (JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY) ?? '[]') as string[]).sort();
const registrations = (from = 0) => nodes.sent.slice(from).filter((s) => s.method === 'POST' && s.path === '/api/push-tokens');
const stored = () => JSON.parse(mem.async.get(PUSH_LEAVE_STATEMENTS_STORE_KEY) ?? '[]') as LeaveStatement[];

/** Kim signs in on the phone while it is set to `community`: her key is written, and the app registers her. */
async function kimSignsIn(community = MULLUM): Promise<void> {
    await importIdentity(kim);
    mem.async.set(ANCHOR, community);
    await registerAccountForPush(kim.publicKey, phoneToken, 'android');
}

describe('a registration that fails is tried again as the app comes back', () => {
    it('signing in with no connection (no token to be had yet): it lands at the next return once the network is back, and Mullum is then on the record', async () => {
        offline();
        await kimSignsIn();

        expect(nodes.sent).toHaveLength(0);
        // The token never went anywhere, so no community is on the record yet; Mullum is due.
        expect(recorded()).toEqual([]);
        expect(due()).toEqual([{ publicKey: kim.publicKey, community: MULLUM, refusals: 0, retryAt: 0 }]);

        // Back to the app, still offline: nothing lands, and it stays due.
        await comeBack();
        expect(nodes.sent).toHaveLength(0);
        expect(due()).toHaveLength(1);

        // The network is back: the next return registers her at Mullum, signed by her key (the community checks it),
        // with a fresh stamp.
        online();
        await comeBack();
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        const [registration] = registrations();
        expect(registration.community).toBe(MULLUM);
        expect(registration.body).toEqual({
            publicKey: kim.publicKey, token: PHONE_TOKEN, platform: 'android', registeredAt: Number(mem.async.get(PUSH_STAMP_STORE_KEY)),
        });
        expect(recorded()).toEqual([MULLUM]);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);

        // Nothing more is due: the next return sends nothing, and doesn't even ask for the token.
        const asked = expo.asked;
        await comeBack();
        expect(registrations()).toHaveLength(1);
        expect(expo.asked).toBe(asked);

        // Mullum is on the record, so her Sign Out reaches it.
        await signOutOfThisPhone(kim);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
    });

    it('one that never reached its community is still due after an app restart, and lands at the next return: at that community, whatever the phone is set to since', async () => {
        // The token is had, but Mullum can't be reached.
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = () => 'down';
        expect(await registerAccountForPush(kim.publicKey, phoneToken, 'android')).toBe(PHONE_TOKEN);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(recorded()).toEqual([MULLUM]);

        // The app is killed and started again, and the phone is set to Byron meanwhile.
        const restarted = await afterRestart();
        mem.async.set(ANCHOR, BYRON);
        nodes.answer = () => 'up';
        await restarted.retryDueRegistrations(phoneToken, 'android');

        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        const [first, retry] = registrations();
        expect(registrations().map((s) => s.community)).toEqual([MULLUM, MULLUM]);
        // Still stamped after every earlier one.
        expect(retry.body.registeredAt).toBeGreaterThan(first.body.registeredAt);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);
    });

    it('a 200 that isn\'t the community\'s own answer (a captive portal\'s sign-in page) is no registration: it stays due, and lands once through', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        nodes.answer = () => 'portal';
        await kimSignsIn();
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(due()).toEqual([{ publicKey: kim.publicKey, community: MULLUM, refusals: 1, retryAt: t0 + RETRY_FIRST_WAIT_MS }]);

        vi.setSystemTime(t0 + RETRY_FIRST_WAIT_MS);
        online();
        await comeBack();
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);
    });
});

describe('a community that keeps failing isn\'t tried on every return', () => {
    it('one that answers 500 waits a minute, then two, then four, up to an hour; the phone having no connection never adds to the wait', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        nodes.answer = () => 500;
        await kimSignsIn();
        expect(registrations()).toHaveLength(1);
        /** The app comes back `ms` after the sign-in: how many registrations went out by then. */
        const returnAt = async (ms: number) => {
            vi.setSystemTime(t0 + ms);
            await comeBack();
            return registrations().length;
        };

        // Returns every few seconds within the first minute: left alone.
        for (const at of [0, 5000, 30000, MINUTE - 1]) expect(await returnAt(at)).toBe(1);
        // Once it is over: tried, and refused again. Now two minutes.
        expect(await returnAt(MINUTE)).toBe(2);
        expect(due()[0]).toMatchObject({ refusals: 2, retryAt: t0 + MINUTE + 2 * MINUTE });
        expect(await returnAt(MINUTE + 2 * MINUTE - 1)).toBe(2);
        expect(await returnAt(3 * MINUTE)).toBe(3);
        // Then four.
        expect(due()[0]).toMatchObject({ refusals: 3, retryAt: t0 + 3 * MINUTE + 4 * MINUTE });
        expect(await returnAt(7 * MINUTE - 1)).toBe(3);

        // Once the wait is over, the phone has no connection: tried at each return, and the wait doesn't grow.
        nodes.answer = () => 'down';
        expect(await returnAt(7 * MINUTE)).toBe(4);
        expect(due()[0]).toMatchObject({ refusals: 3, retryAt: t0 + 7 * MINUTE });
        expect(await returnAt(7 * MINUTE + 1000)).toBe(5);

        // Refused again and again: the wait doubles, and stops at an hour.
        nodes.answer = () => 500;
        let at = 7 * MINUTE + 2000;
        for (const expectedWait of [8, 16, 32, 60, 60].map((m) => m * MINUTE)) {
            await returnAt(at);
            expect(Number(due()[0].retryAt) - (t0 + at)).toBe(expectedWait);
            at += expectedWait;
        }
        expect(RETRY_LONGEST_WAIT_MS).toBe(60 * MINUTE);

        // Mullum is back: the next try lands, and nothing more is due.
        nodes.answer = () => 'up';
        await returnAt(at);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);
    });

    it('one that never answers within the timeout waits as a refusal does; a phone clock put back a day doesn\'t leave it waiting a day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const t0 = Date.now();
        await importIdentity(kim);
        mem.async.set(ANCHOR, MULLUM);
        nodes.answer = () => 'silent';
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 50)).rejects.toThrow();
        expect(due()).toEqual([{ publicKey: kim.publicKey, community: MULLUM, refusals: 1, retryAt: t0 + RETRY_FIRST_WAIT_MS }]);
        await comeBack();
        expect(registrations()).toHaveLength(1);

        // The phone's clock goes back a day: the wait is further off than any wait can be, so it is over.
        vi.setSystemTime(t0 - DAY);
        nodes.answer = () => 'up';
        await comeBack();
        expect(registrations()).toHaveLength(2);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true);
    });
});

describe('#1258\'s rules hold for a retry', () => {
    it('what was due for Kim is dropped as her Sign Out starts, and no retry goes for her during it or after', async () => {
        nodes.answer = () => 'down';
        await kimSignsIn();
        expect(due()).toHaveLength(1);

        // Sign Out: its DELETE to Mullum is slow, so it waits with her key still on the phone.
        nodes.answer = (s) => (s.method === 'DELETE' ? 'hold' : 'up');
        const signingOut = signOutOfThisPhone(kim);
        await vi.waitFor(() => expect(nodes.held).toHaveLength(1));
        expect(leaveState(kim.publicKey)).toBe('leaving');
        expect(due()).toEqual([]);

        // The app comes back meanwhile, online: nothing goes for her.
        const before = nodes.sent.length;
        await comeBack();
        nodes.releaseHeld();
        await signingOut;
        await comeBack();

        expect(registrations(before)).toHaveLength(0);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
        expect(await loadIdentity()).toBeNull();
    });

    it('a retry already under way as her Sign Out starts sends nothing once it has the token: it goes through the same registration, which stops for a leaving key', async () => {
        nodes.answer = () => 'down';
        await kimSignsIn();
        nodes.answer = () => 'up';

        // Back to the app: the retry asks for the token, which is slow to come.
        let giveToken: (() => void) | undefined;
        const slowToken = () => new Promise<string>((resolve) => { giveToken = () => resolve(PHONE_TOKEN); });
        const retrying = retryDueRegistrations(slowToken, 'android');
        await vi.waitFor(() => expect(giveToken).toBeDefined());

        // Meanwhile she signs out. Its DELETE is slow: her key is still on the phone when the token comes.
        nodes.answer = (s) => (s.method === 'DELETE' ? 'hold' : 'up');
        const signingOut = signOutOfThisPhone(kim);
        await vi.waitFor(() => expect(nodes.held).toHaveLength(1));
        expect(leaveState(kim.publicKey)).toBe('leaving');
        expect((await loadIdentity())?.publicKey).toBe(kim.publicKey);
        const before = nodes.sent.length;
        giveToken!();
        await retrying;
        nodes.releaseHeld();
        await signingOut;

        expect(registrations(before)).toHaveLength(0);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(false);
    });

    it('Replace (Kim → Ben): Kim\'s are dropped and none goes for her; Ben\'s registration is his own, signed by his key, where he is', async () => {
        nodes.answer = () => 'down';
        await kimSignsIn();
        expect(due().map((d) => d.publicKey)).toEqual([kim.publicKey]);

        // Ben's 12 words replace her account on this phone, set to Byron; still no connection, and his registration fails.
        offline();
        await saveRestoredAccount({ identity: ben, replacesAnother: true }, BYRON);
        expect((await loadIdentity())?.publicKey).toBe(ben.publicKey);
        expect(due()).toEqual([]);
        await registerAccountForPush(ben.publicKey, phoneToken, 'android');
        expect(due()).toEqual([{ publicKey: ben.publicKey, community: BYRON, refusals: 0, retryAt: 0 }]);

        // Online again: the next return registers Ben at Byron, and nothing for Kim anywhere.
        online();
        const before = nodes.sent.length;
        await comeBack();
        expect(registrations(before).map((s) => [s.community, s.body.publicKey])).toEqual([[BYRON, ben.publicKey]]);
        expect(nodes.has(BYRON, ben.publicKey)).toBe(true);
        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);
    });

    it('only the account on the phone\'s own is tried: one left due by a key taken off without a leave (a join refused at the door) never goes', async () => {
        // A join's key whose registration failed, then discarded when the door refused it (identity.ts discardUnjoinedIdentity).
        offline();
        await importIdentity(ben);
        mem.async.set(ANCHOR, BYRON);
        await registerAccountForPush(ben.publicKey, phoneToken, 'android');
        expect(await discardUnjoinedIdentity(ben.publicKey)).toBe(true);
        // Kim signs in, with no connection either.
        await kimSignsIn();
        expect(due().map((d) => d.publicKey).sort()).toEqual([ben.publicKey, kim.publicKey].sort());

        online();
        await comeBack();

        expect(registrations().map((s) => [s.community, s.body.publicKey])).toEqual([[MULLUM, kim.publicKey]]);
        expect(nodes.has(BYRON, ben.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
        // Ben's stays written down, and is never tried while he isn't on the phone.
        expect(due().map((d) => d.publicKey)).toEqual([ben.publicKey]);
    });

    it('Kim signing straight back in offline after an offline Sign Out: her statements are taken back, and her registration lands at the next return, stamped after them', async () => {
        await importIdentity(kim);
        mem.secure.set(PUSH_TOKEN_STORE_KEY, PHONE_TOKEN);
        for (const community of [MULLUM, BYRON]) {
            mem.async.set(ANCHOR, community);
            expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android')).toBe(true);
        }
        offline();
        await signOutOfThisPhone(kim);
        const leftAt = stored()[0].leftAt;

        // She signs straight back in while set to Mullum, still offline: her statements are taken back (#1258), and
        // her registration can't land.
        await kimSignsIn(MULLUM);
        expect(await pendingLeaveStatements()).toEqual([]);
        expect(nodes.has(MULLUM, kim.publicKey)).toBe(true); // her row from before, still there

        // Online, the app comes back: the statements (none of hers), then the registrations due.
        online();
        const before = nodes.sent.length;
        await presentLeaveStatements();
        await comeBack();

        const [back] = registrations(before);
        expect(back.community).toBe(MULLUM);
        expect(back.body.registeredAt).toBeGreaterThan(leftAt);
        expect(nodes.sent.slice(before).some((s) => s.path.startsWith('/api/push-tokens/leave/'))).toBe(false);
        expect(nodes.has(MULLUM, kim.publicKey) && nodes.has(BYRON, kim.publicKey)).toBe(true);
        expect(recorded()).toEqual([BYRON, MULLUM]);
        expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);

        // Her next Sign Out, online, takes both.
        await signOutOfThisPhone(kim);
        expect(nodes.has(MULLUM, kim.publicKey) || nodes.has(BYRON, kim.publicKey)).toBe(false);
    });
});

describe('storage that fails', () => {
    it('a due list that can\'t be written doesn\'t stop the registration (recovery alerts come first); a corrupt one is nothing due, and is left alone', async () => {
        const setItem = vi.mocked(AsyncStorage.setItem);
        const write = async (key: string, value: string) => { mem.async.set(key, value); };
        try {
            setItem.mockImplementation(async (key: string, value: string) => {
                if (key === PUSH_REGISTRATIONS_DUE_STORE_KEY) throw new Error('storage full');
                return write(key, value);
            });
            nodes.answer = () => 'down';
            await kimSignsIn();
            expect(registrations()).toHaveLength(1);
            expect(mem.async.has(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe(false);
        } finally {
            setItem.mockImplementation(write);
        }

        mem.async.set(PUSH_REGISTRATIONS_DUE_STORE_KEY, '{not json');
        online();
        await comeBack();
        expect(registrations()).toHaveLength(1);
        expect(mem.async.get(PUSH_REGISTRATIONS_DUE_STORE_KEY)).toBe('{not json');
    });
});
