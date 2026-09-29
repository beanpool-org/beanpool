/**
 * The phone keeps each account's block list under that account (utils/blocklist.ts; Marty on card blocklist-owner,
 * 2026-09-27: "The account's").
 *
 * The list was phone-wide. It outlived Sign Out and "Replace this phone's account", so the next account on the phone
 * inherited the blocks of the one before. Wiping it at Sign Out would be worse: a member who signs out and restores
 * their own account would find everyone they blocked unblocked, and nothing would tell them. So each account's list is
 * kept under its own key: another account on the phone never reads it, and the same account restored gets it back.
 *
 * The reports a block sends, queued while the node can't be reached, are the account's too: a node files a report as
 * whoever signs it, so a report one account made must never go out signed by another. And each goes only to the
 * community it was made at, wherever the phone is set to when it is retried.
 *
 * Real identity, Sign Out and restore code over in-memory storage; each `startApp()` is a fresh app run. Nothing here
 * contacts a node: fetch is a stub that records what would have been sent, and the node's name for a key is a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mem = vi.hoisted(() => ({
    async: new Map<string, string>(),
    secure: new Map<string, string>(),
    /** While set, a SecureStore read of `slowKey` answers late, with what the phone held when the read was made. */
    slowSecureReads: null as Promise<void> | null,
    slowKey: '',
    /** How many reads have been made slow. */
    slowReadsMade: 0,
    /** Called after each AsyncStorage write, to act at that moment. */
    afterWrite: null as ((key: string, value: string) => void) | null,
}));
const rn = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { emit: rn.emit, addListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => {
            mem.async.set(key, value);
            mem.afterWrite?.(key, value);
        }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => {
        const value = mem.secure.get(key) ?? null;
        const slow = mem.slowSecureReads;
        if (slow && key === mem.slowKey) {
            mem.slowReadsMade += 1;
            await slow;
        }
        return value;
    }),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))), randomUUID: () => 'test-uuid' };
});
// db.ts loads for Sign Out; its device modules are stubbed at the boundary, and so is dropping the open community's
// tables. Everything else in it is real.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(), defaultDatabaseDirectory: '/data/user/0/org.beanpool.app/files/SQLite' }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/', deleteAsync: vi.fn(async () => {}) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn() }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));
vi.mock('../db', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../db')>()),
    clearDB: vi.fn(async () => {}),
    closeDB: vi.fn(async () => {}),
}));

import type { BeanPoolIdentity } from '../identity';

const NODE = 'https://test.beanpool.org';
/** Another community. */
const OTHER = 'https://other.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const IDENTITY_KEY = 'sovereign-identity';
/** The phone-wide list and the offline report queue of the builds before this one. */
const PHONE_WIDE_LIST = 'beanpool_blocked_users';
const PHONE_WIDE_REPORTS = 'beanpool_pending_abuse_reports';
const HARASSER = 'ee'.repeat(32);
const SPAMMER = 'dd'.repeat(32);
const listKey = (publicKey: string) => `beanpool_blocked_users:${publicKey}`;
const reportsKey = (publicKey: string) => `beanpool_pending_abuse_reports:${publicKey}`;
const DAY = 24 * 60 * 60 * 1000;

/** A fresh run of the app: every module loads again, so nothing is remembered but what the phone stored. */
async function startApp() {
    vi.resetModules();
    const blocklist = await import('../blocklist');
    const identity = await import('../identity');
    const leaves = await import('../account-leaves-phone');
    const restore = await import('../restore-account');
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    const nameOnNode = async () => null;
    return {
        ...blocklist,
        identity,
        /**
         * Settings → Sign Out (Device Only). On a phone its last step also wipes the account's app storage
         * (identity.ts `wipeIdentity`), through a lazy `require` of AsyncStorage that can't load under vitest, so the
         * wipe is finished here as the phone does it.
         */
        signOut: async (account: BeanPoolIdentity) => {
            await leaves.signOutOfThisPhone(account);
            await identity.wipeIdentityScopedStorage(AsyncStorage);
        },
        /** Welcome → Recover with 12 Words, onto an empty phone, at `node`. */
        restore: (account: BeanPoolIdentity, node = NODE) => restore.restoreFromWords(account.mnemonic!, node, { nameOnNode }),
        /** Recover with 12 Words over the account on the phone, and "Replace this phone's account?" → Replace. */
        replaceWith: (account: BeanPoolIdentity, node = NODE) =>
            restore.restoreFromWords(account.mnemonic!, node, { nameOnNode, confirmReplace: async () => true }),
    };
}

/**
 * The node, as far as these tests go: it answers, or it can't be reached. The next report's answer can be held, and
 * what it answers can be set.
 */
const net = {
    up: true,
    hold: null as Promise<void> | null,
    answer: { success: true } as Record<string, unknown>,
    sent: [] as { url: string; headers: Record<string, string>; body: string | undefined }[],
};

/** Each report the phone sent: where to, who signed it, and what it said. */
function reportsSent() {
    return net.sent
        .filter((s) => s.url.endsWith('/api/reports'))
        .map((s) => ({ at: s.url, signedBy: s.headers['X-Public-Key'], ...JSON.parse(s.body ?? '{}') }));
}

let ana: BeanPoolIdentity;
let ben: BeanPoolIdentity;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    mem.slowSecureReads = null;
    mem.slowKey = '';
    mem.slowReadsMade = 0;
    mem.afterWrite = null;
    rn.emit.mockClear();
    net.up = true;
    net.hold = null;
    net.answer = { success: true };
    net.sent = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        net.sent.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
        if (net.hold) {
            const hold = net.hold;
            net.hold = null;
            await hold;
        }
        if (!net.up) throw new TypeError('Network request failed');
        const answer = net.answer;
        return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) } as unknown as Response;
    }));
    const { draftIdentity } = await import('../identity');
    ana = await draftIdentity('Ana');
    ben = await draftIdentity('Ben');
    mem.async.set(ANCHOR, NODE);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Sign Out and restore', () => {
    it('keeps the blocks with the account that made them: the next account starts with none, and they come back with their owner', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        expect(await app.blockUser(HARASSER, ana.publicKey)).toBe(true);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);

        await app.signOut(ana);
        await app.restore(ben);
        expect(await app.getBlockedUsers()).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(false);

        await app.signOut(ben);
        await app.restore(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        // And after the app is closed and opened again.
        const again = await startApp();
        expect(await again.getBlockedUsers()).toEqual([HARASSER]);
    });

    it('a new account made on the phone after Sign Out starts with an empty list', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.signOut(ana);

        // The join wizard's fresh key (welcome.tsx handleCreate).
        await app.identity.createIdentity('Cat');
        expect(await app.getBlockedUsers()).toEqual([]);
    });
});

describe('Replace this phone\'s account', () => {
    it('each account keeps its own list: the replacing account never reads the replaced one\'s, and replacing back restores it', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);

        await app.replaceWith(ben);
        expect(await app.getBlockedUsers()).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(false);
        await app.blockUser(SPAMMER, ben.publicKey);

        await app.replaceWith(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);

        await app.replaceWith(ben);
        expect(await app.getBlockedUsers()).toEqual([SPAMMER]);
    });
});

describe('the phone-wide list of the builds before this one', () => {
    it('goes to the account on the phone when this build first runs, and the old keys go', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER, SPAMMER]));

        const app = await startApp();
        expect(await app.getBlockedUsers()).toEqual([HARASSER, SPAMMER]);
        expect(JSON.parse(mem.async.get(listKey(ana.publicKey)) ?? 'null')).toEqual([HARASSER, SPAMMER]);
        expect(mem.async.has(PHONE_WIDE_LIST)).toBe(false);
        expect(mem.secure.has(PHONE_WIDE_LIST)).toBe(false);

        // It is that account's now, and only that account's.
        await app.signOut(ana);
        await app.restore(ben);
        expect(await app.getBlockedUsers()).toEqual([]);
        await app.signOut(ben);
        await app.restore(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER, SPAMMER]);
    });

    it('from the older SecureStore copy too', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.secure.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER]));

        const app = await startApp();
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
        expect(JSON.parse(mem.async.get(listKey(ana.publicKey)) ?? 'null')).toEqual([HARASSER]);
        expect(mem.async.has(PHONE_WIDE_LIST)).toBe(false);
        expect(mem.secure.has(PHONE_WIDE_LIST)).toBe(false);
    });

    it('goes to the account on the phone when the app starts, even when that account is replaced before any list is read', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER]));

        // The app starts on a screen that reads no list (a half-finished join wizard sends it to Welcome), and Recover
        // with 12 Words replaces Ana with Ben.
        const app = await startApp();
        await app.replaceWith(ben);

        expect(await app.getBlockedUsers()).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(false);
        expect(JSON.parse(mem.async.get(listKey(ana.publicKey)) ?? 'null')).toEqual([HARASSER]);
        expect(mem.async.has(PHONE_WIDE_LIST)).toBe(false);
        expect(mem.secure.has(PHONE_WIDE_LIST)).toBe(false);
        expect(rn.emit).not.toHaveBeenCalledWith(app.BLOCKLIST_UPDATED_EVENT, [HARASSER]);

        // Ana, back on the phone, has her blocks.
        await app.replaceWith(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
    });

    it('goes to the account on the phone when the app starts, even when the first list read is still in flight as the next account\'s key is written', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER]));

        // The phone is slow to say which account it holds: to the reads made as the app starts, and the first list read.
        let answer!: () => void;
        mem.slowKey = IDENTITY_KEY;
        mem.slowSecureReads = new Promise<void>((resolve) => { answer = resolve; });
        const app = await startApp();
        const slowAtStart = mem.slowReadsMade;
        const firstRead = app.getBlockedUsers();
        await vi.waitFor(() => expect(mem.slowReadsMade).toBe(slowAtStart + 1));
        mem.slowSecureReads = null;

        // Ben's key is written while those reads are still out.
        await app.replaceWith(ben);
        answer();

        expect(await firstRead).toEqual([]);
        expect(await app.getBlockedUsers()).toEqual([]);
        expect(JSON.parse(mem.async.get(listKey(ana.publicKey)) ?? 'null')).toEqual([HARASSER]);
        expect(mem.async.has(PHONE_WIDE_LIST)).toBe(false);
        expect(mem.secure.has(PHONE_WIDE_LIST)).toBe(false);
        expect(rn.emit).not.toHaveBeenCalledWith(app.BLOCKLIST_UPDATED_EVENT, [HARASSER]);

        await app.replaceWith(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
    });

    it('on a phone with no account, waits untouched for the next account (an older build\'s Sign Out left it there)', async () => {
        mem.async.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER]));

        const app = await startApp();
        expect(await app.getBlockedUsers()).toEqual([]);
        expect(mem.async.get(PHONE_WIDE_LIST)).toBe(JSON.stringify([HARASSER]));

        await app.restore(ana);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
        expect(mem.async.has(PHONE_WIDE_LIST)).toBe(false);
    });
});

describe('the report a block sends', () => {
    it('queued while the node is down, goes out only when its account is back on the phone, signed by that account', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        expect(await app.blockUser(HARASSER, ana.publicKey, 'User Blocked by Member')).toBe(true);
        expect(reportsSent()).toHaveLength(1); // tried once, and the node couldn't be reached
        net.up = true;
        net.sent = [];

        await app.signOut(ana);
        await app.restore(ben);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([]);

        await app.signOut(ben);
        await app.restore(ana);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([
            expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, reporterPubkey: ana.publicKey, targetPubkey: HARASSER, reason: 'User Blocked by Member' }),
        ]);

        // Sent once: the queue is empty now.
        net.sent = [];
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([]);
    });

    it('is never signed by the next account, even when the account changes while the queue is being sent', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockUser(SPAMMER, ana.publicKey);
        net.up = true;
        net.sent = [];

        // The app comes back to the front and starts sending Ana's two reports. The node is slow to answer the first.
        let answer!: () => void;
        net.hold = new Promise<void>((resolve) => { answer = resolve; });
        const retry = app.retryPendingReports();
        await vi.waitFor(() => expect(reportsSent()).toHaveLength(1));

        // Meanwhile Ana signs out and Ben restores his account.
        await app.signOut(ana);
        await app.restore(ben);
        answer();
        await retry;

        expect(reportsSent().map((r) => r.signedBy)).not.toContain(ben.publicKey);
        expect(reportsSent()).toEqual([expect.objectContaining({ signedBy: ana.publicKey, targetPubkey: HARASSER })]);

        // Ana's second report waited for her.
        await app.signOut(ben);
        await app.restore(ana);
        net.sent = [];
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([expect.objectContaining({ signedBy: ana.publicKey, reporterPubkey: ana.publicKey, targetPubkey: SPAMMER })]);
    });

    it('the queue of the builds before this one: the account on the phone sends its own reports and no one else\'s', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ben));
        const now = Date.now();
        mem.async.set(PHONE_WIDE_REPORTS, JSON.stringify([
            { reporterPubkey: ana.publicKey, targetPubkey: HARASSER, reason: 'User Blocked by Member', timestamp: now },
            { reporterPubkey: ben.publicKey, targetPubkey: SPAMMER, reason: 'User Blocked by Member', timestamp: now },
        ]));

        const app = await startApp();
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ben.publicKey, reporterPubkey: ben.publicKey, targetPubkey: SPAMMER })]);
    });

    it('goes only to the community it was made at, wherever the phone is set to when it is retried', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        expect(await app.blockUser(HARASSER, ana.publicKey, 'User Blocked by Member', 'post-at-test')).toBe(true);
        net.up = true;
        net.sent = [];

        // Ana signs out, and Ben restores his account onto another community: nothing of Ana's goes anywhere.
        await app.signOut(ana);
        await app.restore(ben, OTHER);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([]);

        // Ana restores hers onto the other community: her report goes to the one she blocked at, signed by her.
        await app.signOut(ben);
        await app.restore(ana, OTHER);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([
            expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, reporterPubkey: ana.publicKey, targetPubkey: HARASSER, targetPostId: 'post-at-test' }),
        ]);
    });

    it('never reaches the next account\'s community, even when retried as Replace has written that community and not yet its key', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(HARASSER, ana.publicKey);
        net.up = true;
        net.sent = [];

        // The app comes back to the front just as Replace has written Ben's community, before his key.
        let retry: Promise<void> | undefined;
        mem.afterWrite = (key, value) => {
            if (key === ANCHOR && value === OTHER) retry = app.retryPendingReports();
        };
        await app.replaceWith(ben, OTHER);
        mem.afterWrite = null;
        expect(retry).toBeDefined();
        await retry;

        // Sent to where Ana blocked, signed by her, or still waiting for her.
        for (const report of reportsSent()) {
            expect(report).toEqual(expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey }));
        }
        await app.replaceWith(ana, OTHER);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, targetPubkey: HARASSER })]);
    });

    it('an older build\'s queued report is stamped with the community the phone is set to when this build starts, and goes only there', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(PHONE_WIDE_REPORTS, JSON.stringify([
            { reporterPubkey: ana.publicKey, targetPubkey: HARASSER, reason: 'User Blocked by Member', postId: 'post-at-test', timestamp: Date.now() },
            // Past the 7 days a report is kept.
            { reporterPubkey: ana.publicKey, targetPubkey: SPAMMER, reason: 'User Blocked by Member', timestamp: Date.now() - 8 * DAY },
        ]));

        const app = await startApp();
        // Moved at start, before anything can change the community, and stamped with it.
        await vi.waitFor(() => expect(mem.async.has(PHONE_WIDE_REPORTS)).toBe(false));
        expect(JSON.parse(mem.async.get(reportsKey(ana.publicKey)) ?? 'null')).toEqual([
            expect.objectContaining({ community: NODE, targetPubkey: HARASSER }),
            expect.objectContaining({ community: NODE, targetPubkey: SPAMMER }),
        ]);

        // Ana signs out and restores onto another community before the app retries: it goes where it was made.
        await app.signOut(ana);
        await app.restore(ana, OTHER);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([
            expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, targetPubkey: HARASSER, targetPostId: 'post-at-test' }),
        ]);
        expect(mem.async.has(reportsKey(ana.publicKey))).toBe(false);
    });

    it('an older build\'s queued report on a phone set to no community when this build starts has nowhere to go, and is dropped', async () => {
        mem.async.delete(ANCHOR);
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(PHONE_WIDE_REPORTS, JSON.stringify([
            { reporterPubkey: ana.publicKey, targetPubkey: HARASSER, reason: 'User Blocked by Member', timestamp: Date.now() },
        ]));

        const app = await startApp();
        await vi.waitFor(() => expect(mem.async.has(PHONE_WIDE_REPORTS)).toBe(false));
        mem.async.set(ANCHOR, OTHER);
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([]);
        expect(mem.async.has(reportsKey(ana.publicKey))).toBe(false);
    });

    it('the same person blocked at two communities is reported to each', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(HARASSER, ana.publicKey);
        await app.unblockUser(HARASSER);
        // Ana switches to another community she belongs to, and blocks the same person there.
        mem.async.set(ANCHOR, OTHER);
        await app.blockUser(HARASSER, ana.publicKey);
        net.up = true;
        net.sent = [];

        await app.retryPendingReports();
        expect(reportsSent()).toEqual([
            expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, targetPubkey: HARASSER }),
            expect.objectContaining({ at: `${OTHER}/api/reports`, signedBy: ana.publicKey, targetPubkey: HARASSER }),
        ]);
    });

    it('is dropped unsent once it is 7 days old', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(SPAMMER, ana.publicKey);
        net.up = true;
        net.sent = [];
        // And one Ana queued at the same community eight days ago.
        const queued = JSON.parse(mem.async.get(reportsKey(ana.publicKey)) ?? '[]');
        expect(queued).toEqual([expect.objectContaining({ community: NODE, targetPubkey: SPAMMER })]);
        mem.async.set(reportsKey(ana.publicKey), JSON.stringify([{ ...queued[0], targetPubkey: HARASSER, timestamp: Date.now() - 8 * DAY }, ...queued]));

        await app.retryPendingReports();
        expect(reportsSent()).toEqual([expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, targetPubkey: SPAMMER })]);
        expect(mem.async.has(reportsKey(ana.publicKey))).toBe(false);
    });

    it('leaves the queue when the node says it already has it on file (duplicate)', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(HARASSER, ana.publicKey);
        net.up = true;
        net.sent = [];

        // The first try reached the node after all: it has the report on file, and says so.
        net.answer = { success: true, duplicate: true };
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([expect.objectContaining({ at: `${NODE}/api/reports`, signedBy: ana.publicKey, targetPubkey: HARASSER })]);
        expect(mem.async.has(reportsKey(ana.publicKey))).toBe(false);

        net.sent = [];
        await app.retryPendingReports();
        expect(reportsSent()).toEqual([]);
    });
});

describe('the list in memory', () => {
    it('a read begun while one account is on the phone that ends after the next account\'s key is written answers with the next account\'s list', async () => {
        // An old list, in the older SecureStore copy, which the phone is slow to read: its move waits.
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.secure.set(PHONE_WIDE_LIST, JSON.stringify([HARASSER]));
        let answer!: () => void;
        mem.slowKey = PHONE_WIDE_LIST;
        mem.slowSecureReads = new Promise<void>((resolve) => { answer = resolve; });

        // A screen asks for the list with Ana on the phone; the read waits for the move, and Ben's key is written.
        const app = await startApp();
        const read = app.getBlockedUsers();
        await vi.waitFor(() => expect(mem.slowReadsMade).toBe(1));
        mem.slowSecureReads = null;
        await app.replaceWith(ben);
        answer();

        expect(await read).toEqual([]);
        expect(JSON.parse(mem.async.get(listKey(ana.publicKey)) ?? 'null')).toEqual([HARASSER]);
        expect(rn.emit).not.toHaveBeenCalledWith(app.BLOCKLIST_UPDATED_EVENT, [HARASSER]);
    });

    it('follows an account change without a restart, and tells the screens with the new account\'s list', async () => {
        const app = await startApp();
        // Ben used this phone before, and blocked someone.
        await app.identity.importIdentity(ben);
        await app.blockUser(SPAMMER, ben.publicKey);
        await app.signOut(ben);

        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        expect(await app.getBlockedUsers()).toEqual([HARASSER]);
        rn.emit.mockClear();

        await app.replaceWith(ben);
        expect(await app.getBlockedUsers()).toEqual([SPAMMER]);
        await vi.waitFor(() => expect(rn.emit).toHaveBeenLastCalledWith(app.BLOCKLIST_UPDATED_EVENT, [SPAMMER]));

        await app.signOut(ben);
        expect(await app.getBlockedUsers()).toEqual([]);
        await vi.waitFor(() => expect(rn.emit).toHaveBeenLastCalledWith(app.BLOCKLIST_UPDATED_EVENT, []));
    });
});
