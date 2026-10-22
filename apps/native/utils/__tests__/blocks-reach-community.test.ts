/**
 * A Block made on the phone reaches the community (design message-a-friend §7 S4; Marty accepted Q5, 23 Oct): the phone
 * sends it to the community it is set to (POST /api/blocks, the web app's route, apps/server routes/blocks.ts), signed by
 * the account that blocked, so that community stops delivering the blocked member's messages (engine/withheld-lines.ts).
 * The phone keeps its own list too: it works offline, and on a community whose node has no block list.
 *
 *   - a block goes to the community, signed; Unblock takes it off there; nothing is sent when nothing changed
 *   - offline, the block stands on the phone and goes when the community answers again
 *   - Block, Unblock and Unblock All stand on the phone, and the screens hear of them, without waiting for the community
 *     (these tests wait for it, `blockSyncsEndedForTests`, before reading what reached it)
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
    /** Communities that refuse block changes, with the node's own refusal: every change, or only the adds. */
    refuse: new Map<string, { status: number; code?: string; addsOnly?: boolean }>(),
    /** The next block request is taken by the community, and its answer never reaches the phone. */
    loseNextAnswer: false,
    /** Something in front of the community (a Wi-Fi login page) answers every block request with a 200 of its own. */
    portal: false,
    /** Held: the next block request waits for it before the community sees it. */
    hold: null as Promise<void> | null,
    /** The next block request is taken, and its answer's headers arrive, but its body never does: only an abort ends it. */
    stallBody: false,
    /** The request whose body stalled, with its signal, to see that the phone aborted it. */
    stalled: undefined as { signal?: AbortSignal } | undefined,
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
    net.refuse.clear();
    net.loseNextAnswer = false;
    net.portal = false;
    net.hold = null;
    net.stallBody = false;
    net.stalled = undefined;
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
        if (net.portal) return reply(200, null, '<!DOCTYPE html><html><title>Sign in to Wi-Fi</title></html>');
        const community = url.slice(0, url.indexOf('/api/'));
        const missing = net.noList.get(community);
        if (missing) return reply(missing, null, 'Not Found');
        const refusal = net.refuse.get(community);
        if (refusal && !(refusal.addsOnly && url.endsWith('/remove'))) return reply(refusal.status, { error: 'Refused', code: refusal.code });
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
        if (net.stallBody) {
            net.stallBody = false;
            const signal = init?.signal ?? undefined;
            net.stalled = { signal };
            const never = () => new Promise<never>((_, reject) => {
                signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
            return { ok: true, status: 200, json: never, text: never } as unknown as Response;
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
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        // Nothing changed: nothing is sent.
        net.sent = [];
        await app.syncBlocks();
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);

        expect(await app.unblockUser(HARASSER)).toBe(true);
        await app.blockSyncsEndedForTests();
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
        await app.blockSyncsEndedForTests();
        net.up = false;
        expect(await app.unblockUser(HARASSER)).toBe(true);
        await app.blockSyncsEndedForTests();
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
        await app.blockSyncsEndedForTests();
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        net.up = false;
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
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
        await app.blockSyncsEndedForTests();

        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('a 200 that is not the community\'s own answer (a Wi-Fi login page) took nothing: it is sent again at the next sync', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.portal = true;
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toHaveLength(1);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);

        net.portal = false;
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('Unblock All takes each of the phone\'s blocks off the community, and nothing the web app put there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        // Blocked in the web app, at the same community: not on the phone's list.
        listAt(NODE, ana.publicKey).add(STRANGER);

        net.sent = [];
        expect(await app.clearBlocklist()).toBe(true);
        await app.blockSyncsEndedForTests();
        expect(blockChanges().map((c) => c.at)).toEqual([`${NODE}/api/blocks/remove`, `${NODE}/api/blocks/remove`]);
        expect(blockChanges().map((c) => c.body.targetPubkey).sort()).toEqual([SPAMMER, HARASSER].sort());
        expect([...listAt(NODE, ana.publicKey)]).toEqual([STRANGER]);
    });
});

/** What `work` came to, or 'still waiting' when it had not settled a second later. */
async function withinASecond<T>(work: Promise<T>): Promise<T | 'still waiting'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'still waiting'>((resolve) => { timer = setTimeout(() => resolve('still waiting'), 1000); });
    try {
        return await Promise.race([work, late]);
    } finally {
        clearTimeout(timer);
    }
}

describe('a community that is slow to answer', () => {
    it('Block stands on the phone, and the screens hear of it, at once: it waits neither for its own request nor for a sync already under way', async () => {
        // The phone held a block from before this build: the sync at start sends it, and the community holds its answer.
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(listKey(ana.publicKey), JSON.stringify([SPAMMER]));
        const app = await startApp();
        let answer!: () => void;
        net.hold = new Promise<void>((resolve) => { answer = resolve; });
        const atStart = app.syncBlocks();
        await vi.waitFor(() => expect(blockChanges()).toHaveLength(1));

        expect(await withinASecond(app.blockUser(HARASSER, ana.publicKey, 'Abusive user reported via Trust Profile'))).toBe(true);
        expect(rn.emit).toHaveBeenLastCalledWith(app.BLOCKLIST_UPDATED_EVENT, [SPAMMER, HARASSER]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        // The community answers: the block reaches it all the same.
        answer();
        await atStart;
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([SPAMMER, HARASSER]);
    });

    it('Unblock and Unblock All take them off the phone, and the screens hear of it, at once', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        let answer!: () => void;
        net.hold = new Promise<void>((resolve) => { answer = resolve; });
        net.sent = [];
        expect(await withinASecond(app.unblockUser(HARASSER))).toBe(true);
        expect(rn.emit).toHaveBeenLastCalledWith(app.BLOCKLIST_UPDATED_EVENT, [SPAMMER]);
        // Its removal is with the community, which holds its answer; Unblock All waits neither for that nor for its own.
        await vi.waitFor(() => expect(blockChanges()).toHaveLength(1));
        expect(await withinASecond(app.clearBlocklist())).toBe(true);
        expect(rn.emit).toHaveBeenLastCalledWith(app.BLOCKLIST_UPDATED_EVENT, []);
        expect(await app.getBlockedUsers()).toEqual([]);

        // The community answers: both come off it all the same.
        answer();
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } },
            { at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
    });
});

describe('a community whose answer stops after its headers', () => {
    it('the sync gives up at the deadline and aborts the request, and the next Block still reaches the community', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        net.stallBody = true;
        await app.blockUser(HARASSER, ana.publicKey);
        await vi.waitFor(() => expect(net.stalled).toBeDefined());
        let ended = false;
        void app.blockSyncsEndedForTests().then(() => { ended = true; });

        // The reports' 12 s: not before it, and at it.
        await vi.advanceTimersByTimeAsync(11_000);
        expect(ended).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ended).toBe(true);
        expect(net.stalled!.signal?.aborted).toBe(true);
        vi.useRealTimers();

        // Nothing is stuck behind it: the next Block goes, with the one whose answer never came.
        net.sent = [];
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());
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
            await app.blockSyncsEndedForTests();
            expect(blockChanges()).toHaveLength(1);

            net.sent = [];
            for (let i = 0; i < 5; i++) await app.syncBlocks();
            await app.blockUser(SPAMMER, ana.publicKey);
            await app.blockSyncsEndedForTests();
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

describe('a community that refuses a block (a 403, its limit)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
    });

    for (const refusal of [{ status: 403 }, { status: 409, code: 'block_limit', addsOnly: true }]) {
        it(`(${refusal.status}): its blocks wait a day, and an Unblock made meanwhile goes at once`, async () => {
            const app = await startApp();
            await app.identity.importIdentity(ana);
            await app.blockUser(HARASSER, ana.publicKey);
            await app.blockSyncsEndedForTests();

            net.refuse.set(NODE, refusal);
            net.sent = [];
            await app.blockUser(SPAMMER, ana.publicKey);
            await app.blockSyncsEndedForTests();
            expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } }]);
            expect(await app.isUserBlocked(SPAMMER)).toBe(true);

            // A 403 that passed (a Cloudflare one), or the limit, whose answer is "Unblock someone to block another".
            if (refusal.status === 403) net.refuse.delete(NODE);
            net.sent = [];
            await app.syncBlocks();
            expect(blockChanges()).toEqual([]);
            await app.unblockUser(HARASSER);
            await app.blockSyncsEndedForTests();
            expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
            expect([...listAt(NODE, ana.publicKey)]).toEqual([]);

            // A day on, the block goes.
            net.refuse.delete(NODE);
            vi.setSystemTime(new Date(Date.now() + DAY + 1000));
            net.sent = [];
            await app.syncBlocks();
            expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } }]);
            expect([...listAt(NODE, ana.publicKey)]).toEqual([SPAMMER]);
        });
    }

    it('an Unblock it refuses waits a day, and so does every change there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        net.refuse.set(NODE, { status: 403 });
        net.sent = [];
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);

        net.refuse.delete(NODE);
        net.sent = [];
        for (let i = 0; i < 3; i++) await app.syncBlocks();
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([]);

        vi.setSystemTime(new Date(Date.now() + DAY + 1000));
        await app.syncBlocks();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([SPAMMER]);
    });
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
        await app.blockSyncsEndedForTests();

        // Ana switches to the other community she belongs to.
        mem.async.set(ANCHOR, OTHER);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);

        net.sent = [];
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
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
        await app.blockSyncsEndedForTests();
        net.up = true;

        await app.signOut(ana);
        await app.restore(ben);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
        await app.blockUser(SPAMMER, ben.publicKey);
        await app.blockSyncsEndedForTests();
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
        await app.blockSyncsEndedForTests();
        const record = `beanpool_community_blocks:${ana.publicKey}`;
        expect(JSON.parse(mem.async.get(record) ?? 'null')).toEqual({ [NODE]: { on: [HARASSER], sent: [] } });
        await app.signOut(ana);
        expect(mem.async.has(record)).toBe(true);
        expect(mem.async.has(listKey(ana.publicKey))).toBe(true);
        expect([...mem.async.keys()].filter((k) => k.startsWith('beanpool_community_blocks'))).toEqual([record]);
    });
});
