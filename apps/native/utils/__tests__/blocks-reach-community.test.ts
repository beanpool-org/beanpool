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
 *   - someone blocked in both apps comes off the community's list when the phone unblocks them; a web-app-only block stays
 *   - a community the phone visits as a guest is sent nothing; once the member joins there, the next sync sends the list,
 *     whichever screen she joins from (every invite join clears the mark, db.ts redeemInvite)
 *   - a community that has the account as no member yet (403 not_a_member) holds nothing back for a day
 *   - the blocks the phone held before this build go once, in one request, and a key the community doesn't know goes
 *     on its own; never more than 30 requests a minute of the member's 120, and the rest go by themselves
 *   - each community the member is on with the phone gets the phone's list, and an unblock reaches each of them
 *   - a re-key is one community's own: another community is sent every key of the person, and keeps the one they hold there
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
// The guest marks (markGuestNode, clearGuestNode, isGuestNode) are the real ones, over the same storage.
vi.mock('../nodes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../nodes')>()),
    getDatabaseFilenameForNode: vi.fn(),
    addSavedNode: vi.fn(),
}));
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
    const nodes = await import('../nodes');
    const nameOnNode = async () => null;
    return {
        ...blocklist,
        identity,
        nodes,
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
    /** What the community answers an invite redeem: whether the key was a member there already. */
    alreadyMember: false,
    /** Each request, and the phone's clock as it went. */
    sent: [] as { url: string; signedBy: string; body: any; time: number }[],
    lists: new Map<string, Set<string>>(),
    known: new Set<string>(),
    /** A community's own members, where they differ from `known`: a re-key is one community's, so its new key is a stranger at another. */
    knownAt: new Map<string, Set<string>>(),
    /**
     * What each community's read of a list (GET /api/blocks) names as `formerKeys`: a key a re-key put in place of others
     * (apps/server key-succession.ts rekeyedFromChains), by community, then key. Null: a node from before it, naming none.
     */
    formerKeys: new Map<string, Map<string, string[]> | null>(),
    /**
     * Each community's completed re-keys, old key → new (invalidated_keys.rekeyed_to): a block or an unblock of a key a
     * re-key replaced acts on the key its member holds now, as apps/server member-blocks.ts does (key-succession.ts
     * rekeyedToNow; test-member-blocks.ts section 7 holds the real node to it).
     */
    rekeyedTo: new Map<string, Map<string, string>>(),
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
    net.alreadyMember = false;
    net.sent = [];
    net.lists.clear();
    net.knownAt.clear();
    net.formerKeys.clear();
    net.rekeyedTo.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = JSON.parse((init?.body as string) ?? '{}');
        const signer = headers['X-Public-Key'];
        net.sent.push({ url, signedBy: signer, body, time: Date.now() });
        const reply = (status: number, answer: unknown, raw?: string) => ({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (raw !== undefined ? JSON.parse(raw) : answer),
            text: async () => raw ?? JSON.stringify(answer),
        } as unknown as Response);
        if (!url.includes('/api/blocks')) {
            if (!net.up) throw new TypeError('Network request failed');
            return reply(200, url.includes('/api/invite/') ? { success: true, alreadyMember: net.alreadyMember } : { success: true });
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
        // The key its member holds here now: a re-key's old key is answered as the new one.
        const heldNow = (key: string) => {
            let at = key;
            for (let hop = 0; hop < 8 && net.rekeyedTo.get(community)?.has(at); hop++) at = net.rekeyedTo.get(community)!.get(at)!;
            return at;
        };
        // A node from before former keys were named (null) names none, and no person, in any answer.
        const named = net.formerKeys.get(community);
        // Every key a person is known by, the key they hold now first (key-succession.ts personKeysOf).
        const personOf = (key: string) => {
            const now = heldNow(key);
            return [now, ...(named?.get(now) ?? [])];
        };
        // Every answer: the list, and for each key on it a re-key put in place of others, those others.
        const listed = () => ({
            ...(named === null ? {} : { formerKeys: Object.fromEntries([...(named ?? new Map()).entries()].filter(([k]) => list.has(k))) }),
            blocked: [...list].map((publicKey) => ({ publicKey, blockedAt: 'x' })),
            max: 500,
        });
        // One row per person (member-blocks.ts): a block leaves only their key now, an unblock takes off every key of theirs.
        let extra: Record<string, unknown>;
        if (path === '/api/blocks' && typeof body.targetPubkey === 'string') {
            const [key, ...formers] = personOf(body.targetPubkey);
            formers.forEach((k) => list.delete(k));
            extra = { added: list.has(key) ? [] : [key], ...(named === null ? {} : { person: [key, ...formers] }) };
            list.add(key);
        } else if (path === '/api/blocks' && Array.isArray(body.targetPubkeys)) {
            const keys = [...new Set<string>(body.targetPubkeys.map(heldNow))];
            const members = net.knownAt.get(community) ?? net.known;
            const here = keys.filter((k: string) => members.has(k));
            extra = { added: here.filter((k: string) => !list.has(k)), skipped: keys.length - here.length };
            here.forEach((k: string) => { personOf(k).slice(1).forEach((f) => list.delete(f)); list.add(k); });
        } else if (path === '/api/blocks/remove') {
            const person = personOf(body.targetPubkey);
            const gone = [...new Set<string>([body.targetPubkey, ...person])].map((k) => list.delete(k));
            extra = { removed: gone.some(Boolean), ...(named === null ? {} : { person }) };
        } else if (path === '/api/blocks' && init?.method === 'GET') {
            return reply(200, listed());
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
        return reply(200, { success: true, ...extra, ...listed() });
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

    it('blocked in both apps, it comes off the community\'s list when the phone unblocks it: the community keeps one list', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        // Blocked in the web app first, then on the phone.
        listAt(NODE, ana.publicKey).add(HARASSER);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        net.sent = [];
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
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

describe('a community the phone visits as a guest ("Guest view first", global-guest-visit.ts)', () => {
    // The mark as the visit writes it, and the address the phone is set to, each with and without a trailing slash.
    for (const [marked, setTo] of [[OTHER, OTHER], [OTHER, `${OTHER}/`], [`${OTHER}/`, OTHER]]) {
        it(`is sent nothing of the list (marked ${marked}, set to ${setTo}); once the member joins there, the next sync sends it`, async () => {
            const app = await startApp();
            await app.identity.importIdentity(ana);
            await app.blockUser(HARASSER, ana.publicKey);
            await app.blockSyncsEndedForTests();

            // Ana looks around the other community, which she is no member of: the phone marks it a guest visit and goes there.
            await app.nodes.markGuestNode(marked);
            mem.async.set(ANCHOR, setTo);
            net.sent = [];
            await app.syncBlocks();
            await app.blockUser(SPAMMER, ana.publicKey, 'Abusive user reported via Trust Profile');
            await app.blockSyncsEndedForTests();
            await app.syncBlocks();
            expect(blockChanges()).toEqual([]);
            expect(await app.getBlockedUsers()).toEqual([HARASSER, SPAMMER]);

            // She joins there as the same account, and registering clears the mark (nodes.ts): the next sync sends both, the
            // same day.
            await app.nodes.clearGuestNode(marked);
            await app.syncBlocks();
            expect(blockChanges()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);
            expect([...listAt(OTHER, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());
        });
    }

    // Every invite join passes db.ts redeemInvite, and not every screen that calls it clears the mark itself: Settings'
    // "Have an invite code for this community?", Join Node on an invite link, Switch & Join, the join wizard (review
    // 4354899747). Here nothing but the redeem does.
    for (const alreadyMember of [false, true]) {
        for (const [marked, setTo] of [[OTHER, OTHER], [OTHER, `${OTHER}/`], [`${OTHER}/`, OTHER]]) {
            it(`once she joins there with an invite (${alreadyMember ? 'a member there already' : 'new there'}; marked ${marked}, set to ${setTo}), the next sync sends the list`, async () => {
                const app = await startApp();
                await app.identity.importIdentity(ana);
                await app.nodes.markGuestNode(marked);
                mem.async.set(ANCHOR, setTo);
                await app.blockUser(HARASSER, ana.publicKey);
                await app.blockSyncsEndedForTests();
                expect(blockChanges()).toEqual([]);

                net.alreadyMember = alreadyMember;
                const { redeemInvite } = await import('../db');
                expect(await redeemInvite('INV-ABCD-1234', 'Ana', ana)).toEqual({ success: true, alreadyMember, nodeHasPhoto: false });
                for (const url of [OTHER, `${OTHER}/`]) expect(await app.nodes.isGuestNode(url)).toBe(false);
                net.sent = [];
                await app.syncBlocks();
                expect(blockChanges()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
                expect([...listAt(OTHER, ana.publicKey)]).toEqual([HARASSER]);
            });
        }
    }

    it('an invite that never reached the community leaves her a guest there: still nothing is sent', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.nodes.markGuestNode(OTHER);
        mem.async.set(ANCHOR, OTHER);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        net.up = false;
        const { redeemInvite } = await import('../db');
        await expect(redeemInvite('INV-ABCD-1234', 'Ana', ana)).rejects.toThrow();
        expect(await app.nodes.isGuestNode(OTHER)).toBe(true);
        net.up = true;
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
    });
});

describe('a community that has the account as no member yet (403 not_a_member, routes/blocks.ts)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
    });

    it('holds no block back for a day: once the account is a member there, the next sync sends it', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        net.refuse.set(NODE, { status: 403, code: 'not_a_member' });
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        // She joins; the 5-minute tick.
        net.refuse.delete(NODE);
        vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('nor an unblock, nor anything after it', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        net.refuse.set(NODE, { status: 403, code: 'not_a_member' });
        net.sent = [];
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);

        net.refuse.delete(NODE);
        vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));
        net.sent = [];
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([
            { at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } },
            { at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } },
        ]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([SPAMMER]);
    });
});

describe('a community that lost the member\'s list (review 4354749552)', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
    });

    /**
     * The community removes Ana: her list goes with the account (server adminPruneUser, dropBlocksOf), and her key signs
     * nothing there now (403 account_closed, https-server.ts), nor joins again with an invite (engine/invites.ts).
     */
    const removeAna = () => {
        listAt(NODE, ana.publicKey).clear();
        net.refuse.set(NODE, { status: 403, code: 'account_closed' });
    };
    /** A vote brings her back (decisions-engine.ts reinstate_member): the same key and account, with no list. */
    const reinstateAna = () => net.refuse.delete(NODE);
    const fiveMinutesOn = () => vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000));

    it('removed, then brought back by a vote: once the phone has heard she was removed, the next sync puts her blocks back', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);

        removeAna();
        // The phone's own check of its community hears it (NodeStatusContext: 403 account_closed is 'closed'), naming the
        // community as the phone is set to it, here with a trailing slash.
        await app.communityKeepsNoBlocks(ana.publicKey, `${NODE}/`);
        await app.syncBlocks();
        reinstateAna();
        fiveMinutesOn();
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);

        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([]);
    });

    it('removed, a block made meanwhile is refused (403 account_closed): nothing waits a day, and once she is back the next sync puts every block back', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        removeAna();
        net.sent = [];
        await app.blockUser(SPAMMER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: SPAMMER } }]);

        reinstateAna();
        fiveMinutesOn();
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());
    });

    it('a community set up again at the same address: she joins there again with an invite, and the next sync puts her blocks back', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        // A new node at the address: no account, so no list.
        listAt(NODE, ana.publicKey).clear();
        const { redeemInvite } = await import('../db');
        expect(await redeemInvite('INV-ABCD-1234', 'Ana', ana)).toEqual({ success: true, alreadyMember: false, nodeHasPhoto: false });
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } }]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
    });

    it('heard while a sync is under way: that sync never writes back what it read before', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();

        // A block whose request waits at the community.
        let release!: () => void;
        net.hold = new Promise<void>((resolve) => { release = resolve; });
        net.sent = [];
        await app.blockUser(SPAMMER, ana.publicKey);
        await vi.waitFor(() => expect(blockChanges()).toHaveLength(1));
        // Meanwhile the community lost her list, and the phone hears she is no member there.
        listAt(NODE, ana.publicKey).clear();
        const heard = app.communityKeepsNoBlocks(ana.publicKey, NODE);
        release();
        await heard;
        await app.blockSyncsEndedForTests();

        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toEqual([{ at: `${NODE}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER, SPAMMER] } }]);
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([HARASSER, SPAMMER].sort());
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

    it('many the community has no row for: never more than 30 requests a minute of the member\'s 120, and the rest go by themselves', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2026-10-23T08:00:00Z'));
        // 100 authors from connected communities' boards: the list goes first, then each on its own.
        const strangers = Array.from({ length: 100 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
        mem.secure.set(IDENTITY_KEY, JSON.stringify(ana));
        mem.async.set(listKey(ana.publicKey), JSON.stringify(strangers));
        const app = await startApp();

        await app.syncBlocks();
        expect(blockChanges()).toHaveLength(30);
        expect(blockChanges()[0].body).toEqual({ targetPubkeys: strangers });
        // A return to the app within that minute starts another sync: the minute's room is spent all the same.
        await vi.advanceTimersByTimeAsync(10_000);
        await app.syncBlocks();
        expect(blockChanges()).toHaveLength(30);

        // A minute at a time, with no sync asked for: every one reaches the community.
        for (let minute = 1; minute <= 4; minute++) {
            await vi.advanceTimersByTimeAsync(60_000);
            await app.blockSyncsEndedForTests();
        }
        expect([...listAt(NODE, ana.publicKey)].sort()).toEqual([...strangers].sort());
        expect(mostInAMinute()).toBe(30);

        // Unblock All: each comes off, as many a minute.
        net.sent = [];
        expect(await app.clearBlocklist()).toBe(true);
        await app.blockSyncsEndedForTests();
        expect(blockChanges()).toHaveLength(30);
        for (let minute = 1; minute <= 4; minute++) {
            await vi.advanceTimersByTimeAsync(60_000);
            await app.blockSyncsEndedForTests();
        }
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
        expect(blockChanges().filter((c) => c.at.endsWith('/remove'))).toHaveLength(100);
        expect(mostInAMinute()).toBe(30);
    });
});

/** The most block requests the phone sent in any one minute. */
function mostInAMinute(): number {
    const times = net.sent.filter((s) => s.url.includes('/api/blocks')).map((s) => s.time);
    return Math.max(0, ...times.map((t) => times.filter((u) => u >= t && u < t + 60_000).length));
}

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
        expect(JSON.parse(mem.async.get(record) ?? 'null')).toEqual({ [NODE]: { on: [HARASSER], sent: [], asked: [HARASSER] } });
        await app.signOut(ana);
        expect(mem.async.has(record)).toBe(true);
        expect(mem.async.has(listKey(ana.publicKey))).toBe(true);
        expect([...mem.async.keys()].filter((k) => k.startsWith('beanpool_community_blocks'))).toEqual([record]);
    });
});

describe("a block of someone since re-keyed follows them to their new key (followRekeyedBlocks; review of #3268, finding 2)", () => {
    /** An admin re-keys `from` to `to` at `community`: its list's block moves (moveBlocks), and its read names the old key. */
    function rekeyAt(community: string, owner: string, from: string, to: string) {
        const list = listAt(community, owner);
        if (list.delete(from)) list.add(to);
        const named = net.formerKeys.get(community) ?? new Map<string, string[]>();
        named.set(to, [from]);
        net.formerKeys.set(community, named);
        const moved = net.rekeyedTo.get(community) ?? new Map<string, string>();
        moved.set(from, to);
        net.rekeyedTo.set(community, moved);
    }
    const HARASSER_NEW = 'ef'.repeat(32);
    const reads = () => net.sent.filter((s) => s.url === `${NODE}/api/blocks` && Object.keys(s.body).length === 0);

    it('the phone blocks the new key too, sends no change for it, and every screen hears the list changed', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        rekeyAt(NODE, ana.publicKey, HARASSER, HARASSER_NEW);
        net.sent = [];
        rn.emit.mockClear();

        await app.followRekeyedBlocks();
        expect(await app.isUserBlocked(HARASSER_NEW)).toBe(true);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
        expect(rn.emit).toHaveBeenCalledWith(app.BLOCKLIST_UPDATED_EVENT, expect.arrayContaining([HARASSER, HARASSER_NEW]));
        expect(reads()).toHaveLength(1);
        // The community holds it already: the sync after sends nothing, and a second follow changes nothing.
        await app.syncBlocks();
        expect(blockChanges().filter((c) => Object.keys(c.body).length > 0)).toEqual([]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER_NEW]);
        rn.emit.mockClear();
        await app.followRekeyedBlocks();
        expect(rn.emit).not.toHaveBeenCalledWith(app.BLOCKLIST_UPDATED_EVENT, expect.anything());
    });

    it('an unblock the phone made before the re-key reached the community is taken off the new key there', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        net.up = false;
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
        rekeyAt(NODE, ana.publicKey, HARASSER, HARASSER_NEW);
        net.up = true;

        await app.followRekeyedBlocks();
        expect(await app.isUserBlocked(HARASSER_NEW)).toBe(false);
        net.sent = [];
        await app.syncBlocks();
        expect(blockChanges()).toContainEqual({ at: `${NODE}/api/blocks/remove`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER_NEW } });
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
    });

    it("nothing follows for a re-key of someone this phone never blocked, from a node that names no former keys, or with no blocks at all", async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        // No blocks: not even the read.
        await app.followRekeyedBlocks();
        expect(reads()).toEqual([]);

        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        // A block made only in the web app, of someone since re-keyed: the phone never had it, and it stays the web's.
        listAt(NODE, ana.publicKey).add(SPAMMER);
        rekeyAt(NODE, ana.publicKey, SPAMMER, STRANGER);
        await app.followRekeyedBlocks();
        expect(await app.isUserBlocked(STRANGER)).toBe(false);

        // A node from before the read named former keys: nothing to follow by.
        net.formerKeys.set(NODE, null);
        listAt(NODE, ana.publicKey).delete(HARASSER);
        listAt(NODE, ana.publicKey).add(HARASSER_NEW);
        await app.followRekeyedBlocks();
        expect(await app.isUserBlocked(HARASSER_NEW)).toBe(false);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
    });

    /** Changes the phone sent, not its reads. */
    const changesSent = () => blockChanges().filter((c) => Object.keys(c.body).length > 0);
    /** The app opened set to `community`: the follow, then the sync (app/_layout.tsx). */
    const openAt = async (app: Awaited<ReturnType<typeof startApp>>, community: string) => {
        mem.async.set(ANCHOR, community);
        await app.followRekeyedBlocks();
        await app.syncBlocks();
        await app.blockSyncsEndedForTests();
    };

    it('with two communities and a re-key at one only, the other is sent every key of theirs and keeps the one they hold there (review of #3268, round 4)', async () => {
        // He is re-keyed at the first community only: his new key is a stranger at the second.
        net.knownAt.set(NODE, new Set([...net.known, HARASSER_NEW]));
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.blockUser(HARASSER, ana.publicKey);
        await app.blockSyncsEndedForTests();
        rekeyAt(NODE, ana.publicKey, HARASSER, HARASSER_NEW);
        await openAt(app, NODE);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER_NEW]);

        // Ana next opens the app set to the second community, twice: one request, both keys; it takes the one he has there.
        net.sent = [];
        await openAt(app, OTHER);
        await openAt(app, OTHER);
        expect(changesSent()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER_NEW, HARASSER] } }]);
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([HARASSER]);

        // Back at the first, nothing more goes; an unblock at the second takes him off there, and off the first when the
        // phone is next there.
        net.sent = [];
        await openAt(app, NODE);
        expect(changesSent()).toEqual([]);
        mem.async.set(ANCHOR, OTHER);
        await app.unblockUser(HARASSER_NEW);
        await app.blockSyncsEndedForTests();
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([]);
        await openAt(app, NODE);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
        expect(await app.getBlockedUsers()).toEqual([]);
    });

    it('blocked at the second community by the key the first re-keyed him to, before the phone knew: once it learns, the second gets the key he has there too', async () => {
        net.knownAt.set(NODE, new Set([...net.known, HARASSER_NEW]));
        const app = await startApp();
        await app.identity.importIdentity(ana);
        rekeyAt(NODE, ana.publicKey, HARASSER, HARASSER_NEW);
        // Set to the second, she blocks his new key (a worldwide forum post): it holds that key, a stranger there.
        mem.async.set(ANCHOR, OTHER);
        await app.blockUser(HARASSER_NEW, ana.publicKey);
        await app.blockSyncsEndedForTests();
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([HARASSER_NEW]);
        // At the first, the block's answer names both his keys.
        await openAt(app, NODE);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER_NEW]);

        net.sent = [];
        await openAt(app, OTHER);
        await openAt(app, OTHER);
        expect(changesSent()).toEqual([{ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkeys: [HARASSER_NEW, HARASSER] } }]);
        expect([...listAt(OTHER, ana.publicKey)]).toContain(HARASSER);

        // One unblock takes every key of his off both.
        await app.unblockUser(HARASSER);
        await app.blockSyncsEndedForTests();
        await openAt(app, NODE);
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([]);
        expect([...listAt(NODE, ana.publicKey)]).toEqual([]);
    });
});

describe('a block is of a person: any order of block, unblock, re-key, follow and sync leaves the phone, the community and the web agreeing (review of #3268, round 3)', () => {
    const OLD = 'a1'.repeat(32);
    const NEW = 'a2'.repeat(32);
    const NEWER = 'a3'.repeat(32);
    const STEPS = ['block old', 're-key old→new', 'follow', 'unblock new', 'unblock old', 'sync', 're-key new→newer'] as const;
    type Step = (typeof STEPS)[number];

    /** Every order of up to `most` of the steps, each at most once in an order: 3,620 orders for 5 of the 7. */
    function orders(most: number): Step[][] {
        const out: Step[][] = [[]];
        const grow = (order: Step[]) => {
            if (order.length === most) return;
            for (const step of STEPS) {
                if (order.includes(step)) continue;
                const next = [...order, step];
                out.push(next);
                grow(next);
            }
        };
        grow([]);
        return out;
    }

    it('every order of up to 5 steps, then the app coming back (follow + sync): the DM, every key of theirs, Settings, the community and the web say the same', async () => {
        const { dmPeerKeys, isDmBlocked } = await import('../dm-blocked');
        const app = await startApp();
        net.known = new Set([...net.known, OLD, NEW, NEWER]);
        // One app run for every order, as one phone: the clock moves two minutes between orders, so none waits for room
        // in the 30 requests a minute, and each order starts on an account with nothing on the phone or the community.
        vi.useFakeTimers({ toFake: ['Date'] });
        const startedAt = Date.now();
        const all = orders(5);
        expect(all).toHaveLength(3620);
        const disagreements: string[] = [];
        for (const [i, order] of all.entries()) {
            vi.setSystemTime(startedAt + i * 2 * 60 * 1000);
            mem.async.clear();
            mem.secure.clear();
            mem.async.set(ANCHOR, NODE);
            mem.async.set('beanpool_blocked_users_moved', '1');
            net.lists.clear();
            net.formerKeys.clear();
            net.rekeyedTo.clear();
            // A change of account empties the list the module holds in memory.
            const owner = i % 2 === 0 ? ana : ben;
            await app.identity.importIdentity(owner);
            await app.getBlockedUsers();

            const chain = [OLD];
            let blocked = false;
            const rekey = (from: string, to: string) => {
                if (chain[chain.length - 1] !== from) return;
                for (const [k, list] of net.lists) if (k.startsWith(`${NODE}|`) && list.delete(from)) list.add(to);
                const moved = net.rekeyedTo.get(NODE) ?? new Map<string, string>();
                moved.set(from, to);
                net.rekeyedTo.set(NODE, moved);
                const named = net.formerKeys.get(NODE) ?? new Map<string, string[]>();
                named.set(to, [from, ...(named.get(from) ?? [])]);
                net.formerKeys.set(NODE, named);
                chain.push(to);
            };
            for (const step of order) {
                if (step === 'block old') {
                    await app.blockUser(OLD);
                    blocked = true;
                } else if (step === 'unblock new' || step === 'unblock old') {
                    const key = step === 'unblock new' ? NEW : OLD;
                    // Unblock is offered only where the phone says they are blocked (a profile, Contacts, Settings' rows).
                    if (await app.isUserBlocked(key)) {
                        await app.unblockUser(key);
                        blocked = false;
                    }
                } else if (step === 're-key old→new') {
                    rekey(OLD, NEW);
                } else if (step === 're-key new→newer') {
                    rekey(NEW, NEWER);
                } else if (step === 'follow') {
                    await app.followRekeyedBlocks();
                } else {
                    await app.syncBlocks();
                }
                await app.blockSyncsEndedForTests();
            }
            // The app comes back (app/_layout.tsx): the follow, then the sync.
            await app.followRekeyedBlocks();
            await app.syncBlocks();

            const now = chain[chain.length - 1];
            const list = await app.getBlockedUsers();
            const community = [...listAt(NODE, owner.publicKey)];
            const said: Record<string, boolean> = {
                // The thread and Talk: both participant rows and the pin followed; the old row gone after a send; a phone
                // that hasn't heard of the re-key.
                dmBothRows: isDmBlocked(dmPeerKeys(chain.join(','), { peer: now, former: chain.slice(0, -1) }), list),
                dmNewRow: isDmBlocked(dmPeerKeys([now], { peer: now, former: chain.slice(0, -1) }), list),
                dmOldRow: isDmBlocked(dmPeerKeys([OLD], null), list),
                // A profile, the market, the forum: each key they are or were known by.
                ...Object.fromEntries(await Promise.all(chain.map(async (k, n) => [`key${n}`, await app.isUserBlocked(k)] as const))),
                // The node delivers by it, and the web app's list and thread read the participants the re-key moved: their key now.
                community: community.length === 1 && community[0] === now,
                web: community.includes(now),
                // Settings' Manage Blocked Users: one row.
                settingsRow: (await app.getBlockedPeople()).length === 1,
            };
            const wrong = Object.entries(said).filter(([, v]) => v !== blocked).map(([k]) => k);
            if (community.some((k) => k !== now)) wrong.push(`community-holds-${community.length}-keys`);
            if (wrong.length > 0) disagreements.push(`${order.join(', ') || '(nothing)'} → ${blocked ? 'blocked' : 'unblocked'}, but: ${wrong.join(' ')}`);
        }
        expect(disagreements.slice(0, 12)).toEqual([]);
        expect(disagreements).toHaveLength(0);
    }, 180_000);
});

describe('a block is of a person, from every screen that blocks or unblocks, at each of two communities (a table generated from the app code; review of #3268, rounds 4 and 5)', () => {
    const OLD = 'b1'.repeat(32);
    const NEW = 'b2'.repeat(32);
    const NEWER = 'b3'.repeat(32);
    const NAMES: Record<string, string> = { [OLD]: 'old', [NEW]: 'new', [NEWER]: 'newer' };
    type Offer = 'block' | 'unblock' | 'unblock row' | 'unblock all';
    /**
     * What each place in the app that calls blockUser, unblockUser or clearBlocklist offers. A call site the scan finds and
     * this table doesn't name fails the first test, so a new screen can't skip the table. Every Block is offered where the
     * screen shows the person unblocked (isUserBlocked of the key it holds is false), an Unblock where it shows them
     * blocked, Settings' rows once each (getBlockedPeople), and Unblock All while Settings lists anyone.
     */
    const ENTRIES: Record<string, Offer> = {
        'app/public-profile.tsx blockUser': 'block',
        'app/public-profile.tsx unblockUser': 'unblock',
        'app/contacts.tsx unblockUser': 'unblock',
        'app/(tabs)/settings.tsx unblockUser': 'unblock row',
        'app/(tabs)/settings.tsx clearBlocklist': 'unblock all',
        'app/treasury-detail.tsx blockUser': 'block',
        'app/post/[id].tsx blockUser': 'block',
        'app/forum/[id].tsx blockUser': 'block',
        'app/outside-chat/[id].tsx blockUser': 'block',
        'components/Bills.tsx blockUser': 'block',
        'utils/request-report.ts blockUser': 'block',
    };

    /** Each file and function that blocks or unblocks, read from the app's own code (screens, components, utils). */
    async function callSites(): Promise<string[]> {
        const { readdirSync, readFileSync, statSync } = await import('node:fs');
        const { join, relative } = await import('node:path');
        const root = join(__dirname, '..', '..');
        const found = new Set<string>();
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const at = join(dir, name);
                if (name === '__tests__' || name === 'node_modules') continue;
                if (statSync(at).isDirectory()) {
                    walk(at);
                    continue;
                }
                const rel = relative(root, at).split('\\').join('/');
                if (!/\.tsx?$/.test(name) || rel === 'utils/blocklist.ts') continue;
                const code = readFileSync(at, 'utf8').split('\n').filter((line) => !/^\s*import\b/.test(line)).join('\n');
                for (const m of code.matchAll(/\b(blockUser|unblockUser|clearBlocklist)\s*\(/g)) found.add(`${rel} ${m[1]}`);
            }
        };
        for (const dir of ['app', 'components', 'utils']) walk(join(root, dir));
        return [...found].sort();
    }

    it('names every place in the app that blocks or unblocks', async () => {
        expect(await callSites()).toEqual(Object.keys(ENTRIES).sort());
    });

    it('every state any order of up to 6 steps reaches, with two communities and a re-key at one only, then the app back online at each (follow + sync): the phone list, each key, both DM shapes, Settings, each community and its web say the same', async () => {
        const { dmPeerKeys, isDmBlocked } = await import('../dm-blocked');
        const app = await startApp();
        vi.useFakeTimers({ toFake: ['Date'] });
        let clock = Date.now();
        mem.async.set('beanpool_blocked_users_moved', '1');
        mem.secure.clear();
        await app.identity.importIdentity(ana);

        // Two communities he is a member of under his old key (round 5 of #3268's review). A re-key is one community's
        // own (its invalidated_keys): the key it gives him is a stranger at the other until that one re-keys him too.
        const COMMUNITIES = [NODE, OTHER];
        const CALLED: Record<string, string> = { [NODE]: 'first', [OTHER]: 'second' };
        interface At { rekeyedTo: [string, string][]; formerKeys: [string, string[]][]; known: string[]; chain: string[] }
        interface World { async: [string, string][]; lists: [string, string[]][]; at: At[]; up: boolean; blocked: boolean }
        /** His keys at each community, oldest first: the last is the one he holds there now. */
        let chains: Record<string, string[]> = { [NODE]: [OLD], [OTHER]: [OLD] };
        /** Every key he is known by at any community, oldest first. */
        const everyKey = () => [OLD, NEW, NEWER].filter((k) => COMMUNITIES.some((c) => chains[c].includes(k)));
        let blocked = false;
        const save = (): World => ({
            async: [...mem.async.entries()],
            lists: [...net.lists.entries()].map(([k, v]) => [k, [...v]]),
            at: COMMUNITIES.map((c) => ({
                rekeyedTo: [...(net.rekeyedTo.get(c) ?? new Map<string, string>()).entries()],
                formerKeys: [...(net.formerKeys.get(c) ?? new Map<string, string[]>()).entries()].map(([k, v]) => [k, [...v]]),
                known: [...(net.knownAt.get(c) ?? new Set<string>())],
                chain: [...chains[c]],
            })),
            up: net.up,
            blocked,
        });
        // The module's list in memory goes with a change of account: one there and back makes it read the world restored.
        const restore = async (w: World) => {
            mem.async.clear();
            w.async.forEach(([k, v]) => mem.async.set(k, v));
            net.lists.clear();
            w.lists.forEach(([k, v]) => net.lists.set(k, new Set(v)));
            COMMUNITIES.forEach((c, i) => {
                net.rekeyedTo.set(c, new Map(w.at[i].rekeyedTo));
                net.formerKeys.set(c, new Map(w.at[i].formerKeys.map(([k, v]) => [k, [...v]])));
                net.knownAt.set(c, new Set(w.at[i].known));
            });
            chains = Object.fromEntries(COMMUNITIES.map((c, i) => [c, [...w.at[i].chain]]));
            net.up = w.up;
            blocked = w.blocked;
            net.sent = [];
            // Two minutes on each time: never short of room in the 30 requests a minute.
            clock += 2 * 60 * 1000;
            vi.setSystemTime(clock);
            for (const account of [ben, ana]) {
                mem.secure.clear();
                await app.identity.importIdentity(account);
                await app.getBlockedUsers();
            }
        };
        /** Each change's place in the order as its rank, so two orders that leave the same changes meet as one state. */
        const ranked = (v: string) => {
            try {
                const parsed = JSON.parse(v);
                return Object.entries((parsed?.of ?? {}) as Record<string, { blocked: boolean; n: number }>)
                    .sort((a, b) => a[1].n - b[1].n).map(([k, c]) => [k, c.blocked]);
            } catch {
                return v;
            }
        };
        /** What decides what happens next: the phone's block stores, the community it is set to, and what each holds. */
        const stateKey = (w: World) => JSON.stringify([
            w.async.filter(([k]) => /block/.test(k) || k === ANCHOR).map(([k, v]) => [k, /changes/.test(k) ? ranked(v) : v]).sort(),
            w.lists.filter(([, v]) => v.length > 0).sort(), w.at, w.up, w.blocked,
        ]);
        /** An admin re-keys him at `community` only: its lists' blocks move (moveBlocks), and it knows him by the new key. */
        const rekey = (community: string, from: string, to: string) => {
            for (const [k, list] of net.lists) if (k.startsWith(`${community}|`) && list.delete(from)) list.add(to);
            net.rekeyedTo.get(community)!.set(from, to);
            const named = net.formerKeys.get(community)!;
            named.set(to, [from, ...(named.get(from) ?? [])]);
            net.knownAt.get(community)!.add(to);
            chains[community].push(to);
        };

        const offers = new Set(Object.values(ENTRIES));
        /** `shown`: what the screens must show the moment the step returns, before any answer (the pending state). */
        interface Step { name: string; offered: () => Promise<boolean>; run: () => Promise<void>; shown?: () => Promise<boolean> }
        let lastUnblocked = '';
        const steps: Step[] = [];
        for (const key of [OLD, NEW, NEWER]) {
            // Offered at either community for any key he is known by anywhere: a worldwide forum post or an outside chat
            // shows a member of another community.
            if (offers.has('block')) {
                steps.push({
                    name: `block ${NAMES[key]}`,
                    offered: async () => everyKey().includes(key) && !(await app.isUserBlocked(key)),
                    run: async () => { await app.blockUser(key); blocked = true; },
                    shown: async () => app.isUserBlocked(key),
                });
            }
            if (offers.has('unblock')) {
                steps.push({
                    name: `unblock ${NAMES[key]}`,
                    offered: async () => everyKey().includes(key) && (await app.isUserBlocked(key)),
                    run: async () => { await app.unblockUser(key); blocked = false; },
                    shown: async () => !(await app.isUserBlocked(key)),
                });
            }
        }
        for (const row of offers.has('unblock row') ? [0, 1, 2] : []) {
            steps.push({
                name: `unblock Settings row ${row + 1}`,
                offered: async () => (await app.getBlockedPeople()).length > row,
                run: async () => {
                    lastUnblocked = (await app.getBlockedPeople())[row];
                    await app.unblockUser(lastUnblocked);
                    blocked = false;
                },
                shown: async () => !(await app.isUserBlocked(lastUnblocked)),
            });
        }
        if (offers.has('unblock all')) {
            steps.push({
                name: 'unblock all',
                offered: async () => (await app.getBlockedPeople()).length > 0,
                run: async () => { await app.clearBlocklist(); blocked = false; },
                shown: async () => (await app.getBlockedUsers()).length === 0 && (await app.getBlockedPeople()).length === 0,
            });
        }
        const lastOf = (community: string) => chains[community][chains[community].length - 1];
        steps.push(
            { name: 're-key old→new at the first', offered: async () => lastOf(NODE) === OLD, run: async () => rekey(NODE, OLD, NEW) },
            { name: 're-key new→newer at the first', offered: async () => lastOf(NODE) === NEW, run: async () => rekey(NODE, NEW, NEWER) },
            { name: 're-key old→new at the second', offered: async () => lastOf(OTHER) === OLD, run: async () => rekey(OTHER, OLD, NEW) },
            {
                name: 'switch community',
                offered: async () => true,
                run: async () => { mem.async.set(ANCHOR, mem.async.get(ANCHOR) === NODE ? OTHER : NODE); },
            },
            { name: 'follow', offered: async () => true, run: async () => { await app.followRekeyedBlocks(); } },
            { name: 'sync', offered: async () => true, run: async () => { await app.syncBlocks(); } },
            { name: 'offline', offered: async () => net.up, run: async () => { net.up = false; } },
            { name: 'online', offered: async () => !net.up, run: async () => { net.up = true; } },
        );

        /**
         * The app back online (app/_layout.tsx: the follow, then the sync) at the community it is set to, then at the other,
         * then back where it was; and every view held to the member's last word.
         */
        const disagreement = async (): Promise<string | null> => {
            net.up = true;
            const setTo = mem.async.get(ANCHOR)!;
            for (const community of [setTo, setTo === NODE ? OTHER : NODE, setTo]) {
                mem.async.set(ANCHOR, community);
                await app.followRekeyedBlocks();
                await app.syncBlocks();
                await app.blockSyncsEndedForTests();
            }
            const keys = everyKey();
            const list = await app.getBlockedUsers();
            const named = (ks: string[]) => ks.map((k) => NAMES[k] ?? k.slice(0, 6)).join('+') || 'nothing';
            const said: Record<string, boolean> = {
                dmOldRow: isDmBlocked(dmPeerKeys([OLD], null), list),
                ...Object.fromEntries(await Promise.all(keys.map(async (k) => [`isUserBlocked(${NAMES[k]})`, await app.isUserBlocked(k)] as const))),
                settingsOneRow: (await app.getBlockedPeople()).length === 1,
            };
            const wrong: string[] = [];
            for (const c of COMMUNITIES) {
                const chain = chains[c];
                const now = lastOf(c);
                const held = [...listAt(c, ana.publicKey)];
                // His DM at that community: both participant rows and the pin followed, and the old row gone after a send.
                said[`dmBothRows(${CALLED[c]})`] = isDmBlocked(dmPeerKeys(chain.join(','), { peer: now, former: chain.slice(0, -1) }), list);
                said[`dmNewRow(${CALLED[c]})`] = isDmBlocked(dmPeerKeys([now], { peer: now, former: chain.slice(0, -1) }), list);
                // The community delivers by the key he holds there now, one row of the keys he has had there, and its web
                // app's list and thread read that key.
                const his = held.filter((k) => chain.includes(k));
                said[`community(${CALLED[c]})`] = his.length === 1 && his[0] === now;
                said[`web(${CALLED[c]})`] = held.includes(now);
                // Of his other keys (another community's re-key, strangers here), only while the member blocks him: they
                // block nobody here, and the member's unblock takes them off.
                if (his.some((k) => k !== now) || held.some((k) => !keys.includes(k)) || (!blocked && held.length > 0)) {
                    wrong.push(`${CALLED[c]} community holds ${named(held)}`);
                }
            }
            wrong.unshift(...Object.entries(said).filter(([, v]) => v !== blocked).map(([k]) => k));
            if (list.some((k) => !keys.includes(k)) || (blocked && list.length !== keys.length) || (!blocked && list.length > 0)) {
                wrong.push(`phone list ${named(list)}`);
            }
            return wrong.length > 0 ? `→ ${blocked ? 'blocked' : 'unblocked'}, but: ${wrong.join(' ')}` : null;
        };

        for (const c of COMMUNITIES) {
            net.formerKeys.set(c, new Map());
            net.rekeyedTo.set(c, new Map());
            net.knownAt.set(c, new Set([...net.known, OLD]));
        }
        let frontier: { world: World; path: string[] }[] = [{ world: save(), path: [] }];
        const seen = new Set<string>([stateKey(frontier[0].world)]);
        const disagreements: string[] = [];
        let checked = 0;
        let stepsRun = 0;
        const perDepth: number[] = [];
        for (let depth = 0; depth <= 6; depth++) {
            perDepth.push(frontier.length);
            const next: typeof frontier = [];
            for (const { world, path } of frontier) {
                // Its next steps first, then the check (which brings the app back online and so changes the world).
                for (const step of depth < 6 ? steps : []) {
                    await restore(world);
                    if (!(await step.offered())) continue;
                    stepsRun += 1;
                    // The block and unblock syncs run behind the step; what the screens show must not wait for them.
                    await step.run();
                    if (step.shown && !(await step.shown())) disagreements.push(`${[...path, step.name].join(', ')} → not shown at once`);
                    await app.blockSyncsEndedForTests();
                    const child = save();
                    const key = stateKey(child);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    next.push({ world: child, path: [...path, step.name] });
                }
                await restore(world);
                const wrong = await disagreement();
                checked += 1;
                if (wrong) disagreements.push(`${path.join(', ') || '(nothing)'} ${wrong}`);
            }
            frontier = next;
            vi.clearAllMocks();
        }
        console.log(`[table] ${steps.length} steps (${steps.map((s) => s.name).join(' | ')}); ${stepsRun} steps run; ${checked} states checked (new at each depth 0-6: ${perDepth.join(', ')}); ${disagreements.length} disagree`);
        expect(disagreements.slice(0, 12)).toEqual([]);
        expect(disagreements).toHaveLength(0);
        // Every depth reached something new: the walk went the whole 6 steps. (States, not orders: every order of up to 6
        // offered steps reaches one of these, and orders that leave the same stores and the same community are one state.)
        expect(perDepth.every((n) => n > 0)).toBe(true);
        expect(checked).toBeGreaterThan(200);
    }, 600_000);
});

/**
 * Slice S3 (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §6): Block and Report on another community's request
 * card, answered there in place. The phone is set to NODE; the request is OTHER's. Whatever happens while the block is on its
 * way, its report goes to OTHER's moderators only, OTHER's own list takes the block, signed by the account that blocked, and
 * a third community the phone moved to meanwhile has no report of it. The block itself is the account's on this phone
 * (every community the phone is set to hears it at its own sync, as before this slice).
 */
describe('a block made on another community\'s request card, in place (slice S3)', () => {
    const THIRD = 'https://third.example';
    const MEANWHILE: Record<string, (app: Awaited<ReturnType<typeof startApp>>) => Promise<void>> = {
        'nothing': async () => {},
        'a switch to a third community': async () => { mem.async.set(ANCHOR, THIRD); },
        'a switch onto that very community': async () => { mem.async.set(ANCHOR, OTHER); },
        'the account switching': async (app) => { await app.signOut(ana); await app.identity.importIdentity(ben); },
    };
    const reportsAt = () => net.sent.filter((s) => s.url.includes('/api/reports')).map((s) => s.url.slice(0, s.url.indexOf('/api/')));

    it.each(Object.keys(MEANWHILE))('with %s while it is on its way: its report and its change land at that community, never another', async (what) => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        let release!: () => void;
        net.hold = new Promise<void>((r) => { release = r; });
        const blocking = app.blockUser(HARASSER, ana.publicKey, 'Spam or scam', undefined, OTHER);
        await new Promise((r) => setTimeout(r, 0));
        await MEANWHILE[what](app);
        release();
        expect(await blocking).toBe(true);
        await app.blockSyncsEndedForTests();

        expect(reportsAt()).toEqual([OTHER]);
        const atOther = blockChanges().filter((c) => c.at.startsWith(OTHER));
        if (what === 'the account switching') {
            // Ben is on the phone by the time OTHER's turn comes: nothing of Ana's goes in his name.
            expect(atOther.every((c) => c.signedBy === ben.publicKey)).toBe(true);
            expect([...listAt(OTHER, ben.publicKey)]).toEqual([]);
        } else {
            expect(atOther).toContainEqual({ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } });
            expect([...listAt(OTHER, ana.publicKey)]).toEqual([HARASSER]);
        }
        // Every block or report request went to one of the three communities; a report to none but OTHER.
        for (const s of net.sent.filter((x) => x.url.includes('/api/blocks') || x.url.includes('/api/reports'))) {
            expect([NODE, OTHER, THIRD]).toContain(s.url.slice(0, s.url.indexOf('/api/')));
        }
    });

    it('a guest\'s look at that community is sent nothing: no report, no change; the block stands on the phone', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        await app.nodes.markGuestNode(OTHER);
        expect(await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam', undefined, OTHER)).toBe(true);
        await app.blockSyncsEndedForTests();
        expect(net.sent.filter((s) => s.url.startsWith(OTHER))).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
    });

    // #3309 review F1: someone already on this phone's block list (blocked while the phone was set to NODE: until S7 a block
    // reaches only the community the phone is set to) whose request waits at OTHER. Report and block on OTHER's card sends
    // OTHER the block and the person's report all the same, or OTHER goes on listing the request and the card comes back.
    // Each way the card blocks: with the reporter (no line to report), and without (the line's report went).
    it.each([
        ['with the person\'s report (no line left to report)', true],
        ['with the line\'s report gone already (no reporter)', false],
    ] as const)('blocked on this phone already, blocked again on that community\'s card %s: that community still hears it', async (_how, reporter) => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        expect(await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam')).toBe(true);
        await app.blockSyncsEndedForTests();
        expect([...listAt(NODE, ana.publicKey)]).toEqual([HARASSER]);
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([]);
        net.sent = [];

        const again = reporter
            ? await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam', undefined, OTHER)
            : await app.blockUser(HARASSER, undefined, undefined, undefined, OTHER);
        expect(again, 'not a new block on the phone').toBe(false);
        await app.blockSyncsEndedForTests();

        expect(blockChanges().filter((c) => c.at.startsWith(OTHER))).toContainEqual({ at: `${OTHER}/api/blocks`, signedBy: ana.publicKey, body: { targetPubkey: HARASSER } });
        expect([...listAt(OTHER, ana.publicKey)]).toEqual([HARASSER]);
        expect(reportsAt()).toEqual(reporter ? [OTHER] : []);
        // Nothing more to NODE, which holds it already.
        expect(net.sent.filter((s) => s.url.startsWith(NODE))).toEqual([]);
        expect(await app.isUserBlocked(HARASSER)).toBe(true);
    });

    it('control: blocked on this phone already, with no community named: nothing is sent again, as before', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        expect(await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam')).toBe(true);
        await app.blockSyncsEndedForTests();
        net.sent = [];
        expect(await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam')).toBe(false);
        await app.blockSyncsEndedForTests();
        expect(net.sent).toEqual([]);
    });

    it('control: with no community named, the report goes to the community the phone is set to, as before', async () => {
        const app = await startApp();
        await app.identity.importIdentity(ana);
        expect(await app.blockUser(HARASSER, ana.publicKey, 'Spam or scam')).toBe(true);
        await app.blockSyncsEndedForTests();
        expect(reportsAt()).toEqual([NODE]);
        expect(blockChanges().filter((c) => c.at.startsWith(OTHER))).toEqual([]);
    });
});
