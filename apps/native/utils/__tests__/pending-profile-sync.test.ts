import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// A profile change waiting to reach a community is kept for THAT community (utils/pending-profile-sync.ts). Before it,
// one flag for the phone (`pending_profile_sync`, with the photo parked beside it in `pending_profile_avatar`) said
// "a change is waiting", and pillar-sync's retry published the OPEN community's row and cleared the flag. So a rename
// (or photo, or bio) made in A while offline, then a switch to B: B's sync published B's row, with A's photo, and
// cleared the flag; A never got the change and kept the old name.
//
// performSync runs here as it does on the phone: a copy per community (its own in-memory SQLite file, as nodes.ts names
// them), AsyncStorage in a map, and a stubbed node per address that keeps the member's profile as it accepts it and
// lists it in its member directory. What each community was sent is read off its POST /api/profile/update.

const A = 'https://a.beanpool.org';
const B = 'https://b.example.net';
const ME = 'ab'.repeat(32);
const SOMEONE_ELSE = 'cd'.repeat(32);
const PHOTO = 'data:image/jpeg;base64,/9j/UElDSw==';
const OTHER_PHOTO = 'bundled://koala';

const files = new Map<string, DatabaseSync>();
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
function adapterFor(name: string) {
    let sql = files.get(name);
    if (!sql) {
        sql = new DatabaseSync(':memory:');
        files.set(name, sql);
    }
    const file = sql;
    return {
        runAsync: async (q: string, p?: unknown) => {
            const r = file.prepare(q).run(...params(p));
            return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
        execAsync: async (q: string) => { file.exec(q); },
        getAllAsync: async (q: string, p?: unknown) => file.prepare(q).all(...params(p)),
        getFirstAsync: async (q: string, p?: unknown) => file.prepare(q).get(...params(p)) ?? null,
        closeAsync: async () => {},
        withTransactionAsync: async (cb: () => Promise<void>) => { await cb(); },
    };
}

const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async (name: string) => adapterFor(name)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { store.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) store.delete(k); }),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
const me = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => me.identity) }));
vi.mock('../nodes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../nodes')>()),
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
}));
// What the phone keeps of the member's own choice across every community (utils/canonical-profile.ts): nothing unless a
// case below says a picture was chosen in one.
const canonical = vi.hoisted(() => ({ value: null as null | { avatar?: string } }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => canonical.value), saveCanonicalProfile: vi.fn(async () => {}) }));
// Signed as the phone signs, minus the key: what is checked here is what each community is sent, not the signature.
vi.mock('../crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../crypto')>()),
    buildSignedHeaders: vi.fn(async () => ({ 'x-test-signature': 'signed' })),
}));

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import AsyncStorage from '@react-native-async-storage/async-storage';
import { closeDB, getDb, pushProfileToServer, signedRequest, updateMemberProfile } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

/** The module under test, read when a test asks for it: the upgrade tests below run on a build without it. */
const pendingModule = () => import('../pending-profile-sync');

/**
 * Each community's node: what it holds of the member (from accepted updates), every profile update it was sent, and
 * how it answers the next ones: 'ok', 'offline' (the request throws), 'refuse' (a 409 whose code says nothing about the
 * name) or 'busy' (503). Like the server's profile route (apps/server/src/routes/community.ts), it refuses for good a new
 * name someone else holds there (`taken`: 409 `callsign_taken`) or one under 2 characters (400 `callsign_too_short`).
 */
type NodeMode = 'ok' | 'offline' | 'refuse' | 'busy';
const TAKEN_WORDS = 'That name is already taken on this community. Try another.';
const TOO_SHORT_WORDS = 'Your name needs at least 2 characters.';
const nodes = new Map<string, { mode: NodeMode; held: { callsign: string; avatar: string | null; bio: string | null }; taken: Set<string>; updates: any[] }>();
function nodeAt(origin: string) {
    let n = nodes.get(origin);
    if (!n) {
        n = { mode: 'ok', held: { callsign: 'Marty', avatar: null, bio: null }, taken: new Set(), updates: [] };
        nodes.set(origin, n);
    }
    return n;
}
const sentTo = (origin: string) => nodeAt(origin).updates;

function answer(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}
const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const { origin, pathname } = new URL(url);
    const node = nodeAt(origin);
    if (pathname === '/api/profile/update' && init?.method === 'POST') {
        if (node.mode === 'offline') throw new TypeError('Network request failed');
        const body = JSON.parse(init.body ?? '{}');
        node.updates.push(body);
        if (node.mode === 'refuse') return answer(409, JSON.stringify({ error: 'name_taken', message: 'That name is taken here.' }));
        if (node.mode === 'busy') return answer(503, JSON.stringify({ error: 'busy' }));
        if (typeof body.callsign === 'string' && body.callsign.trim() !== node.held.callsign) {
            if (body.callsign.trim().length < 2) return answer(400, JSON.stringify({ error: 'callsign_too_short', message: TOO_SHORT_WORDS }));
            if (node.taken.has(body.callsign.trim())) return answer(409, JSON.stringify({ error: 'callsign_taken', message: TAKEN_WORDS }));
        }
        if (body.callsign !== undefined) node.held.callsign = body.callsign;
        if (body.avatar !== undefined) node.held.avatar = body.avatar;
        if (body.bio !== undefined) node.held.bio = body.bio;
        return answer(200, JSON.stringify({ success: true, profile: { ...node.held } }));
    }
    if (node.mode === 'offline') throw new TypeError('Network request failed');
    // A marketplace action, as the node answers it: with the photo it asks every member for first (engine/posts.ts).
    if (pathname === '/api/marketplace/needs-photo' && init?.method === 'POST') {
        return node.held.avatar
            ? answer(200, JSON.stringify({ success: true }))
            : answer(400, JSON.stringify({ error: 'Please set a profile photo before using the marketplace. Tap your profile to add one.' }));
    }
    if (pathname === '/api/marketplace/posts') return answer(200, '[]');
    // The member directory, the member in it as the node holds them: a members sync writes this name over the row.
    if (pathname === '/api/members') {
        return answer(200, JSON.stringify([{ publicKey: ME, callsign: node.held.callsign, avatarUrl: node.held.avatar ? `/api/avatar/${ME}?size=thumb&v=1` : null }]));
    }
    return answer(404, '');
});

/** The phone opens `url`'s copy, as a switch does (the anchor, then the copy under its name). */
async function openCommunity(url: string) {
    store.set('beanpool_anchor_url', url);
    resetSyncFingerprints();
    await getDb();
}

/** This community's row for the member, as the Save's local commit leaves it (settings.tsx, profile-setup.tsx). */
async function rowHere(data: { callsign: string; avatar_url?: string; bio?: string }) {
    await updateMemberProfile(ME, data);
}

beforeEach(async () => {
    await closeDB();
    files.clear();
    store.clear();
    nodes.clear();
    canonical.value = null;
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
    me.identity = { publicKey: ME, privateKey: 'aa', callsign: 'Marty' };
    // Both are local communities, as the phone knows them (utils/node-profile.ts): the sync reads them without asking.
    store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([A, B].map(u => [u, { profile: 'local', features: {}, checkedAt: new Date().toISOString() }]))));
    vi.mocked(AsyncStorage.setItem).mockClear();
});

describe('a change made in one community while offline is kept for that community', () => {
    it('a rename in A: B\'s sync sends B nothing and leaves A\'s change; back on A, A gets the new name and nothing waits', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).mode = 'offline';
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });

        await openCommunity(B);
        await rowHere({ callsign: 'Marty', bio: 'Bio in B' });
        expect((await performSync()).success).toBe(true);
        expect(sentTo(B)).toEqual([]);
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Marty Renamed' });
        expect(await pendingProfileChange(B, ME)).toBeNull();

        nodeAt(A).mode = 'ok';
        await openCommunity(A);
        expect((await performSync()).success).toBe(true);
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(A)[0].callsign).toBe('Marty Renamed');
        expect(nodeAt(A).held.callsign).toBe('Marty Renamed');
        expect(await pendingProfileChange(A, ME)).toBeNull();

        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(B)).toEqual([]);
    });

    it('a photo picked in A: never sent to B; A gets it once A is back', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).mode = 'offline';
        await openCommunity(A);
        await rowHere({ callsign: 'Marty', avatar_url: PHOTO });
        await keepPendingProfileChange(A, ME, { avatar: PHOTO });

        await openCommunity(B);
        await rowHere({ callsign: 'Marty' });
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect((await pendingProfileChange(A, ME))?.avatar).toBe(PHOTO);

        nodeAt(A).mode = 'ok';
        await openCommunity(A);
        await performSync();
        expect(sentTo(A).map(u => u.avatar)).toEqual([PHOTO]);
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });

    it('a bio written in A: never sent to B; A gets it from A\'s own row once A is back', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).mode = 'offline';
        await openCommunity(A);
        await rowHere({ callsign: 'Marty', bio: 'Grows tomatoes in A' });
        await keepPendingProfileChange(A, ME, {});

        await openCommunity(B);
        await rowHere({ callsign: 'Marty', bio: 'Bio in B' });
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME });

        nodeAt(A).mode = 'ok';
        await openCommunity(A);
        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(A)[0].bio).toBe('Grows tomatoes in A');
        expect('avatar' in sentTo(A)[0]).toBe(false);
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });

    it('a change waiting in each community: each sync sends its own community its own change, and only that', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).mode = 'offline';
        await openCommunity(A);
        await rowHere({ callsign: 'Named in A' });
        await keepPendingProfileChange(A, ME, { callsign: 'Named in A' });
        await openCommunity(B);
        await rowHere({ callsign: 'Marty', avatar_url: OTHER_PHOTO });
        await keepPendingProfileChange(B, ME, { avatar: OTHER_PHOTO });

        await performSync();
        expect(sentTo(B)).toHaveLength(1);
        expect(sentTo(B)[0].avatar).toBe(OTHER_PHOTO);
        expect(sentTo(B)[0].callsign).toBe('Marty');
        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Named in A' });

        nodeAt(A).mode = 'ok';
        await openCommunity(A);
        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(A)[0].callsign).toBe('Named in A');
        expect('avatar' in sentTo(A)[0]).toBe(false);
        expect(sentTo(B)).toHaveLength(1);
    });

    it('a refusal from A keeps A\'s change, says so in the log as before, and the next sync tries again', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        const log = vi.spyOn(console, 'log');
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });
        nodeAt(A).mode = 'refuse';

        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(log).toHaveBeenCalledWith('[Pillar Sync] Profile heal deferred — will retry next sync');
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Marty Renamed' });

        nodeAt(A).mode = 'ok';
        await performSync();
        expect(sentTo(A)).toHaveLength(2);
        expect(nodeAt(A).held.callsign).toBe('Marty Renamed');
        expect(await pendingProfileChange(A, ME)).toBeNull();
        log.mockRestore();
    });

    it('the new name still goes after a members sync wrote A\'s old name over the row (A was busy at the retry)', async () => {
        const { keepPendingProfileChange } = await pendingModule();
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });
        nodeAt(A).mode = 'busy';

        await performSync();
        // The heal was answered busy; the members read in the same cycle wrote the name A still holds into the row.
        const row = await (await getDb()).getFirstAsync<{ callsign: string }>('SELECT callsign FROM members WHERE public_key = ?', [ME]);
        expect(row?.callsign).toBe('Marty');

        nodeAt(A).mode = 'ok';
        await performSync();
        expect(sentTo(A).at(-1).callsign).toBe('Marty Renamed');
        expect(nodeAt(A).held.callsign).toBe('Marty Renamed');
    });

    it('a change kept under another account\'s key is never sent under this one', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        await openCommunity(A);
        await rowHere({ callsign: 'Marty' });
        await keepPendingProfileChange(A, SOMEONE_ELSE, { callsign: 'Someone Else', avatar: PHOTO });

        await performSync();
        expect(sentTo(A)).toEqual([]);
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });

    it('a retry asked for A while the phone has moved to B sends nothing anywhere', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        await openCommunity(A);
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });
        await openCommunity(B);
        await rowHere({ callsign: 'Marty' });

        expect(await pushProfileToServer({ community: A })).toBe(false);
        expect(sentTo(A)).toEqual([]);
        expect(sentTo(B)).toEqual([]);
        expect(await pendingProfileChange(A, ME)).not.toBeNull();
    });

    it('a switch to B while A\'s update is out writes nothing of A\'s into B\'s copy (#2461 review r4368471301)', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        await openCommunity(B);
        await rowHere({ callsign: 'Marty', bio: 'Bio in B' });
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed', bio: 'Grows tomatoes in A' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });
        // A takes the update, and the member switches to B while its answer is on the way.
        const asNodesAnswer = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementationOnce(async (url: string, init?: { method?: string; body?: string }) => {
            const res = await asNodesAnswer(url, init);
            store.set('beanpool_anchor_url', B);
            return res;
        });

        expect(await pushProfileToServer({ community: A })).toBe(true);
        expect(nodeAt(A).held).toMatchObject({ callsign: 'Marty Renamed', bio: 'Grows tomatoes in A' });
        expect(await pendingProfileChange(A, ME)).toBeNull();
        // B's copy is the copy open now: its row is still B's own.
        const row = await (await getDb()).getFirstAsync('SELECT callsign, bio FROM members WHERE public_key = ?', [ME]);
        expect(row).toEqual({ callsign: 'Marty', bio: 'Bio in B' });
        expect(sentTo(B)).toEqual([]);
    });

    it('a switch to B before A\'s row is read sends A nothing, B\'s row least of all, and A\'s change still waits', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        const { loadIdentity } = await import('../identity');
        await openCommunity(B);
        await rowHere({ callsign: 'Marty in B', bio: 'Bio in B' });
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed', bio: 'Grows tomatoes in A' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });
        // The member switches to B just after the retry read which community it publishes to.
        vi.mocked(loadIdentity).mockImplementationOnce(async () => {
            store.set('beanpool_anchor_url', B);
            return me.identity as Awaited<ReturnType<typeof loadIdentity>>;
        });

        const published = await pushProfileToServer();
        expect(sentTo(A)).toEqual([]);
        expect(sentTo(B)).toEqual([]);
        expect(published).toBe(false);
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Marty Renamed' });
    });

    it('once A takes the waiting name, A\'s row says it, a photo already in the row and all (#2461 review r4368471301)', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        const NODE_PHOTO = `/api/avatar/${ME}?size=thumb&v=1`;
        await openCommunity(A);
        // The row as a members sync leaves it: the name A still holds, and A's own photo URL.
        await rowHere({ callsign: 'Marty', avatar_url: NODE_PHOTO });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed' });

        expect(await pushProfileToServer({ community: A })).toBe(true);
        expect(nodeAt(A).held.callsign).toBe('Marty Renamed');
        expect(await pendingProfileChange(A, ME)).toBeNull();
        const row = await (await getDb()).getFirstAsync('SELECT callsign, avatar_url FROM members WHERE public_key = ?', [ME]);
        expect(row).toEqual({ callsign: 'Marty Renamed', avatar_url: NODE_PHOTO });
    });
});

/** The name in this community's row for the member, as the screens read it. */
const rowName = async () =>
    (await (await getDb()).getFirstAsync<{ callsign: string }>('SELECT callsign FROM members WHERE public_key = ?', [ME]))?.callsign;

// Review of #2461 (r4368601839): a waiting name the community refuses for good was sent again at every sync and refused
// every time, and the photo and bio waiting with it never arrived. On main the retry sent the row's name, which the
// members sync had put back, and they landed at the next sync.
const NAME_REFUSALS = [
    ['given to someone else there (409 callsign_taken)', 'Taken', 409, TAKEN_WORDS],
    ['too short (400 callsign_too_short)', 'M', 400, TOO_SHORT_WORDS],
] as const;

describe('a name the community refuses for good leaves the change, and the rest goes without it', () => {
    it.each(NAME_REFUSALS)('a waiting name %s: refused once, then the photo and bio reach A, the row has A\'s name again, and nothing waits', async (_case, name) => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).taken.add('Taken');
        await openCommunity(A);
        await rowHere({ callsign: name, avatar_url: PHOTO, bio: 'Grows tomatoes' });
        await keepPendingProfileChange(A, ME, { callsign: name, avatar: PHOTO });

        for (let i = 0; i < 4; i++) await performSync();

        expect(sentTo(A).filter(u => u.callsign === name)).toHaveLength(1);
        expect(sentTo(A)).toHaveLength(2);
        expect(sentTo(A)[1]).toMatchObject({ avatar: PHOTO, bio: 'Grows tomatoes' });
        expect(nodeAt(A).held).toEqual({ callsign: 'Marty', avatar: PHOTO, bio: 'Grows tomatoes' });
        expect(await pendingProfileChange(A, ME)).toBeNull();
        expect(await rowName()).toBe('Marty');
        expect(sentTo(B)).toEqual([]);
    });

    it.each(NAME_REFUSALS)('a waiting name %s: the member is told what A said, in A\'s words, once, in A, and under this account only', async (_case, name, status, words) => {
        const { keepPendingProfileChange, takeNameRefusal } = await pendingModule();
        nodeAt(A).taken.add('Taken');
        await openCommunity(A);
        await rowHere({ callsign: name, avatar_url: PHOTO });
        await keepPendingProfileChange(A, ME, { callsign: name, avatar: PHOTO });
        await performSync();
        await performSync();

        expect(await takeNameRefusal(B, ME)).toBeNull();
        expect(await takeNameRefusal(A, SOMEONE_ELSE)).toBeNull();
        // Two readers at once (Settings loads on mount and on focus): one of them says it.
        const both = await Promise.all([takeNameRefusal(A, ME), takeNameRefusal(A, ME)]);
        expect(both.filter(Boolean)).toEqual([{ status, message: words }]);
        expect(await takeNameRefusal(A, ME)).toBeNull();
    });

    it.each(['busy', 'offline'] as const)('a %s community keeps the name, the photo and the bio waiting, says nothing, and takes all three once it answers', async (mode) => {
        const { keepPendingProfileChange, pendingProfileChange, takeNameRefusal } = await pendingModule();
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed', avatar_url: PHOTO, bio: 'Grows tomatoes' });
        await keepPendingProfileChange(A, ME, { callsign: 'Marty Renamed', avatar: PHOTO });
        nodeAt(A).mode = mode;

        await performSync();
        await performSync();
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Marty Renamed', avatar: PHOTO });
        expect(await takeNameRefusal(A, ME)).toBeNull();

        nodeAt(A).mode = 'ok';
        await performSync();
        expect(nodeAt(A).held).toEqual({ callsign: 'Marty Renamed', avatar: PHOTO, bio: 'Grows tomatoes' });
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });

    it('a change kept while the refused update was out stays as it is, its new name and all, for the next sync', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        nodeAt(A).taken.add('Taken');
        await openCommunity(A);
        await rowHere({ callsign: 'Taken', avatar_url: PHOTO });
        await keepPendingProfileChange(A, ME, { callsign: 'Taken', avatar: PHOTO });
        // An offline Save in A names someone new while the refusal is on its way.
        const asNodesAnswer = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementationOnce(async (url: string, init?: { method?: string; body?: string }) => {
            const res = await asNodesAnswer(url, init);
            await keepPendingProfileChange(A, ME, { callsign: 'Marty Again' });
            return res;
        });

        expect(await pushProfileToServer({ community: A })).toBe(false);
        expect(sentTo(A)).toHaveLength(1);
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Marty Again', avatar: PHOTO });
    });
});

describe('a community leaving the phone takes its waiting change with it', () => {
    it('removing A from the saved list clears A\'s change and leaves B\'s', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        const { removeSavedNode } = await vi.importActual<typeof import('../nodes')>('../nodes');
        store.set('beanpool_saved_nodes', JSON.stringify([{ url: A }, { url: B }]));
        store.set('beanpool_anchor_url', B);
        await keepPendingProfileChange(A, ME, { callsign: 'Named in A' });
        await keepPendingProfileChange(B, ME, { callsign: 'Named in B' });

        await removeSavedNode(A);

        expect(await pendingProfileChange(A, ME)).toBeNull();
        expect(await pendingProfileChange(B, ME)).toEqual({ publicKey: ME, callsign: 'Named in B' });
    });

    it('a community followed to its new address takes its change there', async () => {
        const { keepPendingProfileChange, pendingProfileChange, carryPendingProfileChange } = await pendingModule();
        const NEW_A = 'https://beans.a-town.org';
        await keepPendingProfileChange(A, ME, { callsign: 'Named in A', avatar: PHOTO });

        await carryPendingProfileChange(A, NEW_A);

        expect(await pendingProfileChange(NEW_A, ME)).toEqual({ publicKey: ME, callsign: 'Named in A', avatar: PHOTO });
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });

    it('one address in two spellings is one community', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        await keepPendingProfileChange('https://A.Beanpool.org:443/', ME, { callsign: 'Named in A' });
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, callsign: 'Named in A' });
        // An address that isn't plain (node-url.ts) is no community's: nothing is kept for it.
        await keepPendingProfileChange('https://a.beanpool.org\\@evil.test/', ME, { callsign: 'Nope' });
        expect([...store.keys()].filter(k => k.includes('evil'))).toEqual([]);
    });
});

// What a phone updated from a build with the one flag holds: `pending_profile_sync`, the community the Save was made in
// (`pending_profile_sync_anchor`, written by the settings Save since #2439) and the photo parked beside it. These run on
// that build too, where B's sync published B's row with A's photo and cleared the flag.
describe('a phone updated from a build with one flag for the phone', () => {
    it('the flag moves to the community it was set in: B\'s sync sends B nothing, A\'s sends A the change, and nothing waits after', async () => {
        nodeAt(A).mode = 'offline';
        await openCommunity(A);
        await rowHere({ callsign: 'Marty Renamed', avatar_url: PHOTO });
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', A);
        store.set('pending_profile_avatar', PHOTO);

        await openCommunity(B);
        await rowHere({ callsign: 'Marty', bio: 'Bio in B' });
        await performSync();
        expect(sentTo(B)).toEqual([]);

        nodeAt(A).mode = 'ok';
        await openCommunity(A);
        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(A)[0]).toMatchObject({ callsign: 'Marty Renamed', avatar: PHOTO });
        for (const old of ['pending_profile_sync', 'pending_profile_sync_anchor', 'pending_profile_avatar']) expect(store.has(old)).toBe(false);

        await performSync();
        expect(sentTo(A)).toHaveLength(1);
        expect(sentTo(B)).toEqual([]);
    });

    it('a flag that names no community is dropped: nothing is published to the community open, or any other', async () => {
        await openCommunity(A);
        await rowHere({ callsign: 'Marty', avatar_url: PHOTO });
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_avatar', PHOTO);

        await performSync();
        await openCommunity(B);
        await performSync();

        expect(sentTo(A)).toEqual([]);
        expect(sentTo(B)).toEqual([]);
        for (const old of ['pending_profile_sync', 'pending_profile_sync_anchor', 'pending_profile_avatar']) expect(store.has(old)).toBe(false);
    });

    it('the moved change is the account\'s on the phone, read as A\'s', async () => {
        const { pendingProfileChange } = await pendingModule();
        // A is open at the move: the photo goes with the flag (the case below where it doesn't).
        store.set('beanpool_anchor_url', A);
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', `${A}/`);
        store.set('pending_profile_avatar', PHOTO);

        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, avatar: PHOTO });
    });

    // Review of #2461: the follow came before any read had moved the flag, so the old row's removal dropped it with A.
    it('a community followed to its new address before the flag moved takes the flag there: the old row\'s removal keeps it', async () => {
        const { pendingProfileChange, carryPendingProfileChange } = await pendingModule();
        const { removeSavedNode } = await import('../nodes');
        const NEW_A = 'https://beans.a-town.org';
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', A);
        store.set('pending_profile_avatar', PHOTO);

        // As acceptAddressFollow does (address-follow.ts): the phone switches to the new address, the change follows,
        // then A's row goes.
        store.set('beanpool_anchor_url', NEW_A);
        await carryPendingProfileChange(A, NEW_A);
        await removeSavedNode(A);

        expect(await pendingProfileChange(NEW_A, ME)).toEqual({ publicKey: ME, avatar: PHOTO });
        expect(await pendingProfileChange(A, ME)).toBeNull();
        for (const old of ['pending_profile_sync', 'pending_profile_sync_anchor', 'pending_profile_avatar']) expect(store.has(old)).toBe(false);
    });

    // Review of #2461 (r4368601890): the anchor names the community of the last settings Save made offline, and the older
    // build never retired it (a successful retry removed only the flag); Re-run Setup and a first join set the flag and
    // parked a photo without touching it. So a stale A anchor with a flag and photo set later in B leaves the same
    // storage as a Save in A followed by a switch to B.
    it('a stale anchor naming A, with the flag and a photo set later in B (Re-run Setup offline there): nothing of B\'s reaches A', async () => {
        await openCommunity(A);
        await rowHere({ callsign: 'Marty', bio: 'Bio in A' });
        await openCommunity(B);
        await rowHere({ callsign: 'Marty in B', avatar_url: OTHER_PHOTO, bio: 'Bio in B' });
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', A);
        store.set('pending_profile_avatar', OTHER_PHOTO);

        await performSync();
        await openCommunity(A);
        await performSync();
        await performSync();

        expect(sentTo(A).map(u => u.avatar)).not.toContain(OTHER_PHOTO);
        expect(JSON.stringify(sentTo(A))).not.toContain('in B');
        expect(nodeAt(A).held).toEqual({ callsign: 'Marty', avatar: null, bio: 'Bio in A' });
        expect(sentTo(B)).toEqual([]);
        for (const old of ['pending_profile_sync', 'pending_profile_sync_anchor', 'pending_profile_avatar']) expect(store.has(old)).toBe(false);
    });

    it('a flag naming a community other than the one open moves bare: that community republishes its own row, with no photo', async () => {
        const { pendingProfileChange } = await pendingModule();
        await openCommunity(B);
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', A);
        store.set('pending_profile_avatar', PHOTO);

        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME });
    });

    it('a flag naming the community open at the move takes its photo there, where the older build would have sent it', async () => {
        const { pendingProfileChange } = await pendingModule();
        await openCommunity(A);
        // The row as a members sync leaves it, A's own photo URL in it: only the parked photo carries the pick.
        await rowHere({ callsign: 'Marty', avatar_url: `/api/avatar/${ME}?size=thumb&v=1` });
        store.set('pending_profile_sync', 'true');
        store.set('pending_profile_sync_anchor', A);
        store.set('pending_profile_avatar', PHOTO);

        expect(await pendingProfileChange(A, ME)).toEqual({ publicKey: ME, avatar: PHOTO });
        await performSync();
        expect(sentTo(A).map(u => u.avatar)).toEqual([PHOTO]);
        expect(await pendingProfileChange(A, ME)).toBeNull();
    });
});

// Profile S2 (scratch/fable-design/DESIGN-per-community-profile-fable.md §3, Marty 28-29 Oct): a name or picture chosen in
// one community never shows or publishes in another. The phone keeps a copy of the last photo chosen anywhere
// (utils/canonical-profile.ts); the catch-up publish used to send it to any community whose row held no photo, so a
// preset picked once (`bundled://bean-green`) became the picture in every community the member joined, unasked. And
// the marketplace's "please set a profile photo" gate was satisfied by it in a fresh community, which now asks again:
// the photo of a listing is that community's (design §5 question 3, Marty: yes).
describe('a picture chosen in one community is never published to another', () => {
    const PRESET = 'bundled://bean-green';
    const ownRowAvatar = async () =>
        (await (await getDb()).getFirstAsync<{ avatar_url: string | null }>('SELECT avatar_url FROM members WHERE public_key = ?', [ME]))?.avatar_url ?? null;

    it('a preset chosen in A, kept phone-wide: a change waiting in B publishes B\'s own row with no photo, and B\'s row shows none', async () => {
        const { keepPendingProfileChange, pendingProfileChange } = await pendingModule();
        canonical.value = { avatar: PRESET };
        await openCommunity(A);
        await rowHere({ callsign: 'Marty', avatar_url: PRESET });
        await openCommunity(B);
        // B's row as joining leaves it: a name and no photo. A rename made here while offline waits for B.
        await rowHere({ callsign: 'Marty in B' });
        await keepPendingProfileChange(B, ME, { callsign: 'Marty in B' });

        await performSync();

        expect(sentTo(B)).toHaveLength(1);
        expect(sentTo(B)[0].callsign).toBe('Marty in B');
        expect('avatar' in sentTo(B)[0]).toBe(false);
        expect(JSON.stringify(sentTo(B))).not.toContain(PRESET);
        expect(nodeAt(B).held.avatar).toBeNull();
        expect(await ownRowAvatar()).toBeNull();
        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(sentTo(A)).toEqual([]);
    });

    it('the marketplace photo gate in a fresh community asks for a photo again: the one chosen elsewhere is not published to open it', async () => {
        canonical.value = { avatar: PRESET };
        await openCommunity(B);
        await rowHere({ callsign: 'Marty in B' });

        await expect(signedRequest('/api/marketplace/needs-photo', {})).rejects.toThrow(/set a profile photo/i);

        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).held.avatar).toBeNull();
        expect(await ownRowAvatar()).toBeNull();
    });

    it('the same gate still heals with a photo chosen in THIS community that never reached it (an offline pick in its row)', async () => {
        canonical.value = { avatar: PRESET };
        await openCommunity(B);
        await rowHere({ callsign: 'Marty in B', avatar_url: PHOTO });

        await expect(signedRequest('/api/marketplace/needs-photo', {})).resolves.toEqual({ success: true });

        expect(sentTo(B).map(u => u.avatar)).toEqual([PHOTO]);
    });
});
