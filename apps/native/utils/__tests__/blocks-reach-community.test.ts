/**
 * A Block made on the phone reaches the community (design message-a-friend §7 S4; Marty accepted Q5, 23 Oct): the phone
 * sends it to the community it is set to (POST /api/blocks, the web app's route, apps/server routes/blocks.ts), signed by
 * the account that blocked, so that community stops delivering the blocked member's messages (engine/withheld-lines.ts).
 * The phone keeps its own list too: it works offline, and on a community whose node has no block list.
 *
 *   - a block goes to the community, signed; Unblock takes it off there; nothing is sent when nothing changed
 *   - offline, the block stands on the phone and goes when the community answers again
 *   - a node with no block list (404, 405): the block stands on the phone, one try, then nothing for a day
 *   - a block whose answer never came may be on the list: an unblock takes it off there all the same
 *   - the blocks the phone held before this build go once, in one request, and a key the community doesn't know goes
 *     on its own
 *   - each community the member is on with the phone gets the phone's list, and an unblock reaches each of them
 *   - only ever the account's own: another account on the phone neither sends nor signs them
 *   - a sync that is cut off has its record, not a second copy: what reached the community is never sent again
 *
 * Real blocklist, identity, Sign Out and restore code over in-memory storage; each `startApp()` is a fresh app run. The
 * community is a stand-in that answers as routes/blocks.ts does; utils/__tests__/blocks-reach-community-e2e.test.ts sends
 * the same requests to a real node on this machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
const rn = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { emit: rn.emit, addListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
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
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))), randomUUID: () => 'test-uuid' };
});
// db.ts loads for Sign Out; its device modules are stubbed at the boundary, as blocklist-per-account.test.ts does.
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
const OTHER = 'https://other.beanpool.org';
const ANCHOR = 'beanpool_anchor_url';
const IDENTITY_KEY = 'sovereign-identity';
const HARASSER = 'ee'.repeat(32);
const SPAMMER = 'dd'.repeat(32);
/** Someone the stand-in communities have no row for: an author from a connected community's board. */
const STRANGER = 'cc'.repeat(32);
const listKey = (publicKey: string) => `beanpool_blocked_users:${publicKey}`;
const DAY = 24 * 60 * 60 * 1000;

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
        signOut: async (account: BeanPoolIdentity) => {
            await leaves.signOutOfThisPhone(account);
            await identity.wipeIdentityScopedStorage(AsyncStorage);
        },
        restore: (account: BeanPoolIdentity, node = NODE) => restore.restoreFromWords(account.mnemonic!, node, { nameOnNode }),
    };
}

/**
 * The communities, as far as these tests go: each keeps a block list per signer, as routes/blocks.ts does (a single key
 * of any spelling-correct key, a list only of the keys it has a row for), and answers with that list. One can be made
 * unreachable, have no block list at all (an older node), or take a request and lose its answer on the way back.
 */
const net = {
    up: true,
    /** Communities whose node has no block list: each answers this status, with no JSON. */
    noList: new Map<string, number>(),
    /** The next block request is taken by the community, and its answer never reaches the phone. */
    loseNextAnswer: false,
    /** Held: the next block request waits for it before the community sees it. */
    hold: null as Promise<void> | null,
    sent: [] as { url: string; signedBy: string; body: any }[],
    lists: new Map<string, Set<string>>(),
    known: new Set<string>(),
};

const listAt = (community: string, owner: string) => {
    const k = `${community}|${owner}`;
    if (!net.lists.has(k)) net.lists.set(k, new Set());
    return net.lists.get(k)!;
};

/** Each block change the phone sent: where to, who signed it, and its body. */
function blockChanges() {
    return net.sent.filter((s) => s.url.includes('/api/blocks')).map(({ url, signedBy, body }) => ({ at: url, signedBy, body }));
}

let ana: BeanPoolIdentity;
let ben: BeanPoolIdentity;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    rn.emit.mockClear();
    net.up = true;
    net.noList.clear();
    net.loseNextAnswer = false;
    net.hold = null;
    net.sent = [];
    net.lists.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = JSON.parse((init?.body as string) ?? '{}');
        const signer = headers['X-Public-Key'];
        net.sent.push({ url, signedBy: signer, body });
        const reply = (status: number, answer: unknown, raw?: string) => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (raw !== undefined ? JSON.parse(raw) : answer),
            text: async () => raw ?? JSON.stringify(answer),
        } as unknown as Response);
        if (!url.includes('/api/blocks')) {
            if (!net.up) throw new TypeError('Network request failed');
            return reply(200, { success: true });
        }
        if (net.hold) {
            const hold = net.hold;
            net.hold = null;
            await hold;
        }
        if (!net.up) throw new TypeError('Network request failed');
        const community = url.slice(0, url.indexOf('/api/'));
        const missing = net.noList.get(community);
        if (missing) return reply(missing, null, 'Not Found');
        const list = listAt(community, signer);
        const path = url.slice(community.length);
        let extra: Record<string, unknown>;
        if (path === '/api/blocks' && typeof body.targetPubkey === 'string') {
            extra = { added: list.has(body.targetPubkey) ? [] : [body.targetPubkey] };
            list.add(body.targetPubkey);
        } else if (path === '/api/blocks' && Array.isArray(body.targetPubkeys)) {
            const here = body.targetPubkeys.filter((k: string) => net.known.has(k));
            extra = { added: here.filter((k: string) => !list.has(k)), skipped: body.targetPubkeys.length - here.length };
            here.forEach((k: string) => list.add(k));
        } else if (path === '/api/blocks/remove') {
            extra = { removed: list.delete(body.targetPubkey) };
        } else {
            return reply(404, null, 'Not Found');
        }
        if (net.loseNextAnswer) {
            net.loseNextAnswer = false;
            throw new TypeError('Network request failed');
        }
        return reply(200, { success: true, ...extra, blocked: [...list].map((publicKey) => ({ publicKey, blockedAt: 'x' })), max: 500 });
    }));
    const { draftIdentity } = await import('../identity');
    ana = await draftIdentity('Ana');
    ben = await draftIdentity('Ben');
    net.known = new Set([HARASSER, SPAMMER, ana.publicKey, ben.publicKey]);
    mem.async.set(ANCHOR, NODE);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('a block made on the phone', () => {
    it('goes to the community the phone is set to, signed by the account that blocked, and Unblock takes it off there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);

        expect(await app.blockUser(HARASSER, ana.publicKey, 'Abusive user reported via Trust Profile')).toBe(true);
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        // Nothing changed: nothing is sent.
        net.sent = [];
        await app.syncBlocks();
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);

        expect(await app.unblockUser(HARASSER)).toBe(true);
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
    });

    it('offline: stands on the phone at once, and goes to the community when it answers again', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        expect(await app.blockUser(HARASSER, ana.publicKey)).toBe(true);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);

        // Still offline at the next return: tried, nothing lost.
        await app.syncBlocks();
        net.up = true;
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
    });

    it('and an unblock made offline goes too', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        net.up = false;
        expect(await app.unblockUser(HARASSER)).toBe(true);
        expect(await app.isUserBlocked(HARASSER)).toBe(false);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        net.up = true;
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
    });

    it('whose answer never came may be on the list: an unblock takes it off there all the same', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.loseNextAnswer = true;
        await app.blockUser(HARASSER, ana.publicKey);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        net.up = false;
        await app.unblockUser(HARASSER);
        net.up = true;
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
    });

    it('whose answer never came is sent again, and once the community has answered, never again', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.loseNextAnswer = true;
        await app.blockUser(HARASSER, ana.publicKey);

        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('Unblock All takes each of the phone\'s blocks off the community, and nothing the web app put there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockUser(SPAMMER, ana.publicKey);
        // Blocked in the web app, at the same community: not on the phone's list.
        listAt(NODE, ana.publicKey).add(STRANGER);

        net.sent = [];
        expect(await app.clearBlocklist()).toBe(true);
        expect(blockChanges().map((c) => c.at)).toEqual([`${NODE}/api/blocks/remove`, `${NODE}/api/blocks/remove`]);
        expect(blockChanges().map((c) => c.body.targetPubkey).sort()).toEqual([SPAMMER, HARASSER].sort());
        expect([...listAt(NODE, ana.publicKey)]).toEqual([STRANGER]);
    });
});

describe('a community whose node has no block list', () => {
    for (const status of [404, 405]) {
        it(`(${status}): the block stands on the phone, one try, and none again that day`, async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
            const app = await startApp();
            await app.identity.importIdentity(ana);
            net.noList.set(NODE, status);

            expect(await app.blockUser(HARASSER, ana.publicKey)).toBe(true);
            expect(await app.isUserBlocked(HARASSER)).toBe(true);
            expect(blockChanges()).toHaveLength(1);

            net.sent = [];
            for (let i = 0; i < 5; i++) await app.syncBlocks();
            await app.blockUser(SPAMMER, ana.publicKey);
            expect(blockChanges()).toEqual([]);
            expect(await app.getBlockedUsers()).toEqual([HARASSER, SPAMMER]);

            // The node is updated, and a day has gone by: both go.
            net.noList.delete(NODE);
            vi.setSystemTime(new Date(Date.now() + DAY + 1000));
            await app.syncBlocks();
            expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);
            expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());
        });
    }
});

describe('the blocks the phone held before this build', () => {
    it('go to the community once, in one request; a key it has no row for goes on its own, and the next sync sends nothing', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(listKey(ana.publicKey), JSON.stringify([HARASSER, STRANGER, SPAMMER]));

        const app = await startApp();
        await app.syncBlocks();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, STRANGER, SPAMMER] } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: STRANGER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER, STRANGER].sort());

        net.sent = [];
        await app.syncBlocks();
        const again = await startApp();
        await again.syncBlocks();
        expect(blockChanges()).toEqual([]);
    });

    it('a key not written as the community keeps keys, or the account\'s own, is never sent: the community would refuse the whole list', async () => {
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(listKey(ana.publicKey), JSON.stringify([HARASSER, SPAMMER.toUpperCase(), ana.publicKey, 'not-a-key', SPAMMER]));

        const app = await startApp();
        await app.syncBlocks();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } },
        ]);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
    });
});

describe('each community the member is on with this phone', () => {
    it('gets the phone\'s list, and an unblock made at one is taken off the other when the phone is next there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockUser(SPAMMER, ana.publicKey);

        // Ana switches to the other community she belongs to.
        mem.async.set(ANCHOR, OTHER);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);

        net.sent = [];
        await app.unblockUser(HARASSER);
        expect(blockChanges()).toEqual([{ at: `${OTHER}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([SPAMMER]);
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());

        mem.async.set(ANCHOR, NODE);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([SPAMMER]);
    });
});

describe('only ever the account\'s own', () => {
    it('another account on the phone neither sends nor signs the blocks of the one before it, and they go with their owner', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.up = false;
        await app.blockUser(HARASSER, ana.publicKey);
        net.up = true;

        await app.signOut(ana);
        await app.restore(ben);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
        await app.blockUser(SPAMMER, ben.publicKey);
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ben.publicKey, body: { targetPubkey: SPAMMER } }]);

        await app.signOut(ben);
        await app.restore(ana);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ben.publicKey)]).toEqual([SPAMMER]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('is never signed by the next account, nor by one no longer on the phone, even when the account changes while the phone is sending', async () => {
        // Two people this community has no row for: the list goes first, then each on its own.
        const OUTSIDER = 'bb'.repeat(32);
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(listKey(ana.publicKey), JSON.stringify([STRANGER, OUTSIDER]));
        const app = await startApp();

        // The community is slow to answer the list; meanwhile Ana signs out and Ben restores his account.
        let answer!: () => void;
        net.hold = new Promise<void>((resolve) => { answer = resolve; });
        const sync = app.syncBlocks();
        await vi.waitFor(() => expect(blockChanges()).toHaveLength(1));
        await app.signOut(ana);
        await app.restore(ben);
        answer();
        await sync;

        // Nothing more went: not signed by Ben, and not by Ana's key, which has left the phone.
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [STRANGER, OUTSIDER] } }]);
        expect([...listAt(NODE, ben.publicKey)]).toEqual([]);

        // Back on the phone, Ana's go, signed by her: the list again (the community answered it holds neither), then each
        // on its own.
        await app.signOut(ben);
        await app.restore(ana);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [STRANGER, OUTSIDER] } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: STRANGER } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: OUTSIDER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([STRANGER, OUTSIDER]);
    });

    it('the record of what went where is kept per account, beside its list, and Sign Out leaves it for the account', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        const record = `beanpool_community_blocks:${ana.publicKey}`;
        expect(JSON.parse(mem.async.get(record) ?? 'null')).toEqual({ [NODE]: { on: [HARASSER], sent: [] } });
        await app.signOut(ana);
        expect(mem.async.has(record)).toBe(true);
        expect(mem.async.has(listKey(ana.publicKey))).toBe(true);
        expect([...mem.async.keys()].filter((k) => k.startsWith('beanpool_community_blocks'))).toEqual([record]);
    });
});
