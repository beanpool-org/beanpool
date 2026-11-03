import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// One working style across a member's communities (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1). The
// quiz is taken once; the device carries the result; each community hears it from the device alone, a day and no clock.
//
// performSync runs here as it does on the phone (the harness of pending-profile-sync.test.ts): a copy per community, the
// device copy, the waiting results and the guest marks in a map, and a stubbed node per address that says who its members
// are and holds what it accepts. What each community was sent is read off its POST /api/profile/update.

const A = 'https://a.beanpool.org';
const B = 'https://b.example.net';
const ME = 'ab'.repeat(32);
const SOMEONE_ELSE = 'cd'.repeat(32);

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
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { emit: () => {}, addListener: () => ({ remove: () => {} }) },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => {}),
    deleteItemAsync: vi.fn(async () => {}),
}));
const me = vi.hoisted(() => ({ identity: null as null | { publicKey: string; privateKey: string; callsign: string } }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => me.identity) }));
vi.mock('../nodes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../nodes')>()),
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
}));
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

import { publicArchetype, type QuizResult } from '@beanpool/core';
import { retireParkedPickAfterPublish } from '../avatar-value';
import { blockSyncsEndedForTests, blockUser, syncBlocks } from '../blocklist';
import { getCanonicalProfile, saveCanonicalProfile } from '../canonical-profile';
import { applyDelta, closeDB, getDb, getMemberProfile, pushProfileToServer, pushWaitingArchetype, updateMemberProfile } from '../db';
import { addSavedNode, clearGuestNode, isGuestNode, markGuestNode, removeSavedNode } from '../nodes';
import {
    carryPendingProfileChange, clearPendingProfileChange, clearWaitingArchetype, keepCarriedArchetype, keepPendingProfileChange, keepWaitingArchetype,
    pendingProfileChange, waitingArchetype, waitingRemoval,
} from '../pending-profile-sync';
import { askBeforeSwitch } from '../reconnect';
import { firstRunWorkingStyle, keepQuizResult, removeWorkingStyle } from '../working-style';
import { PENDING_ARCHETYPE_STORE_PREFIX, PENDING_PROFILE_STORE_PREFIX } from '../storage-keys';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

type Member = 'yes' | 'no' | 'silent';
type NodeState = { mode: 'ok' | 'offline' | 'busy'; member: Member; profileSilent?: boolean; held: { callsign: string; bio: string | null; archetype: string | null }; updates: any[]; probes: number };
const nodes = new Map<string, NodeState>();
function nodeAt(origin: string) {
    let n = nodes.get(origin);
    if (!n) {
        n = { mode: 'ok', member: 'yes', held: { callsign: 'Marty', bio: null, archetype: null }, updates: [], probes: 0 };
        nodes.set(origin, n);
    }
    return n;
}
const sentTo = (origin: string) => nodeAt(origin).updates;

function answer(status: number, body: string) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
}
const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const { origin, pathname } = new URL(url);
    const node = nodeAt(origin);
    if (node.mode === 'offline') throw new TypeError('Network request failed');
    if (pathname.startsWith('/api/community/membership/')) {
        node.probes += 1;
        if (node.member === 'silent') return answer(503, '{}');
        return answer(200, JSON.stringify({ isMember: node.member === 'yes' }));
    }
    if (pathname === '/api/profile/update' && init?.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        node.updates.push(body);
        if (node.mode === 'busy') return answer(503, JSON.stringify({ error: 'busy' }));
        if (node.member !== 'yes') return answer(404, JSON.stringify({ error: 'Member not found' }));
        if (body.bio !== undefined) node.held.bio = body.bio;
        if (body.archetype !== undefined) node.held.archetype = body.archetype;
        return answer(200, JSON.stringify({ success: true, profile: { ...node.held } }));
    }
    if (pathname === `/api/profile/${ME}`) {
        if (node.profileSilent) return answer(503, '{}');
        return answer(200, JSON.stringify({ publicKey: ME, ...node.held }));
    }
    if (pathname === '/api/marketplace/posts') return answer(200, '[]');
    if (pathname === '/api/members') {
        return answer(200, JSON.stringify([{ publicKey: ME, callsign: node.held.callsign, archetype: node.held.archetype }]));
    }
    return answer(404, '');
});

const quiz = (takenOn: string, primary: QuizResult['primary'] = 'sage'): QuizResult => ({
    primary, secondary: 'weaver', mode: 'quick', scores: { [primary]: 3 } as QuizResult['scores'], takenOn,
});
const publicOf = (r: QuizResult) => publicArchetype(r);

async function openCommunity(url: string) {
    store.set('beanpool_anchor_url', url);
    resetSyncFingerprints();
    await getDb();
}

/** A member of both, each community's copy holding their row as the node gave it. */
async function memberOfBoth() {
    await addSavedNode(A);
    await addSavedNode(B);
    await openCommunity(B);
    await updateMemberProfile(ME, { callsign: 'Marty' });
    await openCommunity(A);
    await updateMemberProfile(ME, { callsign: 'Marty' });
}

beforeEach(async () => {
    await closeDB();
    files.clear();
    store.clear();
    nodes.clear();
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
    me.identity = { publicKey: ME, privateKey: 'aa', callsign: 'Marty' };
    store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([A, B].map(u => [u, { profile: 'local', features: {}, checkedAt: new Date().toISOString() }]))));
});

describe('a quiz taken in one community reaches the others at their own next sync', () => {
    it('a quiz on A: B takes it at its next sync, the result alone, and nothing is sent twice', async () => {
        await memberOfBoth();
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);

        // Waiting is nothing sent: B hears of it only when its own turn comes.
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBe(publicOf(taken));

        await openCommunity(B);
        expect((await performSync()).success).toBe(true);
        expect(sentTo(B)).toEqual([{ publicKey: ME, archetype: publicOf(taken) }]);
        expect(nodeAt(B).held.archetype).toBe(publicOf(taken));
        expect(await waitingArchetype(B, ME)).toBeNull();

        await performSync();
        expect(sentTo(B)).toHaveLength(1);
    });

    it('the open community is not marked: its own quiz publish is its line', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03'), ME, A);
        expect(await waitingArchetype(A, ME)).toBeNull();
    });

    it('the published body carries no time of day', async () => {
        await memberOfBoth();
        // A device copy from an older build, stamped to the millisecond.
        await saveCanonicalProfile({ archetype: JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', scores: {}, updatedAt: '2026-11-03T04:05:06.789Z' }) });
        await pushProfileToServer();
        const sent = sentTo(A)[0].archetype;
        expect(JSON.parse(sent)).toEqual({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-03' });
        expect(sent).not.toContain('T04');
        expect(sent).not.toContain('updatedAt');
    });

    it('a retake the same day, after B took the first: B takes the retake too, a tie or not', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03', 'sage'), ME, A);
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(quiz('2026-11-03', 'sage')));

        await openCommunity(A);
        await keepQuizResult(quiz('2026-11-03', 'spark'), ME, A);
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
    });

    it('a quiz with no name, bio or contact waiting: what the phone holds of B is not sent back to B', async () => {
        await memberOfBoth();
        await openCommunity(B);
        // The phone's copy of B is behind: the bio on the node was changed on the web.
        await updateMemberProfile(ME, { callsign: 'Old Name Here', bio: 'What the phone last saw' });
        nodeAt(B).held.bio = 'Changed on the web';
        await openCommunity(A);
        await keepQuizResult(quiz('2026-11-03'), ME, A);

        await openCommunity(B);
        await performSync();
        expect(Object.keys(sentTo(B)[0]).sort()).toEqual(['archetype', 'publicKey']);
        expect(nodeAt(B).held.bio).toBe('Changed on the web');
        expect(nodeAt(B).held.callsign).toBe('Marty');
    });

    it('a real change waiting there and the result: that community\'s row goes with the result, and both stop waiting', async () => {
        await memberOfBoth();
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'Written offline in B' });
        await keepPendingProfileChange(B, ME, {});
        await openCommunity(A);
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);

        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toHaveLength(1);
        expect(sentTo(B)[0]).toMatchObject({ bio: 'Written offline in B', archetype: publicOf(taken) });
        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('it waits while the community is busy or out of reach, and goes when it answers', async () => {
        await memberOfBoth();
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);

        nodeAt(B).mode = 'offline';
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBe(publicOf(taken));

        nodeAt(B).mode = 'busy';
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(await waitingArchetype(B, ME)).toBe(publicOf(taken));

        nodeAt(B).mode = 'ok';
        expect(await pushWaitingArchetype({ community: B })).toBe(true);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('sent only from its own community: a cycle for B with the phone moved to A sends nothing, though A has one waiting', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03'), ME, A);
        await keepWaitingArchetype(A, ME, publicOf(quiz('2026-11-03')));
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(sentTo(A)).toEqual([]);
        expect(sentTo(B)).toEqual([]);
    });

    it('the row takes what was sent, in the copy it was sent for', async () => {
        await memberOfBoth();
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect((await getMemberProfile(ME))?.archetype).toBe(publicOf(taken));
    });

    it('a retake while the publish was out stays waiting for the next', async () => {
        await memberOfBoth();
        const first = quiz('2026-11-03', 'sage');
        const retake = quiz('2026-11-03', 'spark');
        await keepWaitingArchetype(B, ME, publicOf(retake));
        await clearWaitingArchetype(B, publicOf(first));
        expect(await waitingArchetype(B, ME)).toBe(publicOf(retake));
    });
});

describe('a Save or a catch-up carries only a newer device copy', () => {
    it('the device copy goes over A\'s older row, and A\'s row takes it', async () => {
        await memberOfBoth();
        // With the node's own photo in the row, so the row is written for the result and not on the way past.
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', avatar_url: `/api/avatar/${ME}?size=thumb`, archetype: publicOf(quiz('2026-11-01', 'guardian')) });
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03', 'spark')) });

        await pushProfileToServer();
        expect(sentTo(A)[0].archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
        expect((await getMemberProfile(ME))?.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
    });

    it('an older device copy, or a tie: nothing of it goes, and A\'s row is not sent back', async () => {
        await memberOfBoth();
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', archetype: publicOf(quiz('2026-11-02', 'guardian')) });

        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-01', 'spark')) });
        await pushProfileToServer();
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-02', 'spark')) });
        await pushProfileToServer();
        await saveCanonicalProfile({ archetype: null });
        await pushProfileToServer();

        expect(sentTo(A)).toHaveLength(3);
        for (const body of sentTo(A)) expect(body).not.toHaveProperty('archetype');
        expect(nodeAt(A).probes).toBe(0);
    });

    it('a row still stamped to the millisecond is not sent back: that stamp is never published again', async () => {
        await memberOfBoth();
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', archetype: JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', updatedAt: '2026-10-01T01:02:03.456Z' }) });
        await pushProfileToServer();
        expect(sentTo(A)[0]).not.toHaveProperty('archetype');
    });

    it('a member who never took the quiz publishes nothing of it, and no community is asked', async () => {
        await memberOfBoth();
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x' });
        await pushProfileToServer();
        expect(sentTo(A)[0]).not.toHaveProperty('archetype');
        expect(nodeAt(A).probes).toBe(0);
    });

    it('nothing but an older row to publish: no publish at all', async () => {
        await memberOfBoth();
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-02')) });
        await pushProfileToServer();
        expect(sentTo(A)).toEqual([]);
    });

    it('a community joined after the quiz gets it at the join, as before', async () => {
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03')) });
        await addSavedNode(B);
        await openCommunity(B);
        await pushProfileToServer();
        expect(sentTo(B)[0].archetype).toBe(publicOf(quiz('2026-11-03')));
    });
});

describe('nothing goes to a community the member isn\'t in', () => {
    it('a guest visit is not marked, and takes nothing at a sync', async () => {
        await addSavedNode(A);
        await addSavedNode(B);
        await markGuestNode(B);
        await keepQuizResult(quiz('2026-11-03'), ME, A);
        expect(await waitingArchetype(B, ME)).toBeNull();

        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([]);
    });

    it('a guest visit takes nothing from a catch-up either, device copy or not, and is not even asked', async () => {
        await addSavedNode(B);
        await markGuestNode(B);
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03')) });
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x' });
        await pushProfileToServer();
        expect(sentTo(B)[0] ?? {}).not.toHaveProperty('archetype');
        expect(nodeAt(B).probes).toBe(0);
    });

    describe('an older result left waiting at a community that became a guest visit', () => {
        // Saved and only looked at, so a quiz marked it; then Add & Connect found the key is no member there.
        const first = quiz('2026-11-02', 'sage');
        const retake = quiz('2026-11-03', 'spark');
        const leftWaitingAtAGuestVisit = async () => {
            await addSavedNode(A);
            await addSavedNode(B);
            await keepQuizResult(first, ME, A);
            expect(await waitingArchetype(B, ME)).toBe(publicOf(first));
            await markGuestNode(B);
        };
        const joinB = async () => {
            await clearGuestNode(B);
            await openCommunity(B);
            await pushProfileToServer();
        };

        it('a retake in another community: the join sends the retake, not what was left there', async () => {
            await leftWaitingAtAGuestVisit();
            await keepQuizResult(retake, ME, A);
            expect(await waitingArchetype(B, ME)).toBeNull();
            await joinB();
            expect(sentTo(B)[0].archetype).toBe(publicOf(retake));
        });

        it('a retake on the visit itself: the same', async () => {
            await leftWaitingAtAGuestVisit();
            await openCommunity(B);
            await keepQuizResult(retake, ME, B);
            expect(await waitingArchetype(B, ME)).toBeNull();
            await joinB();
            expect(sentTo(B)[0].archetype).toBe(publicOf(retake));
        });
    });

    it('a saved community that says the key is no member: nothing sent, and it stops waiting there', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03'), ME, A);
        nodeAt(B).member = 'no';
        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('a community that won\'t say: nothing sent, and it still waits', async () => {
        await memberOfBoth();
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);
        nodeAt(B).member = 'silent';
        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBe(publicOf(taken));
    });

    it('a catch-up to a community that says no leaves the result out of what it does send', async () => {
        await memberOfBoth();
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03')) });
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x' });
        nodeAt(A).member = 'no';
        await pushProfileToServer();
        expect(sentTo(A)[0]).not.toHaveProperty('archetype');
    });

    it('a guest mark heals when the node says member, letting the result reach it', async () => {
        await addSavedNode(B);
        await markGuestNode(B);
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03')) });
        nodeAt(B).member = 'yes';
        await openCommunity(B);
        await performSync();
        expect(await isGuestNode(B)).toBe(false);
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x' });
        await pushProfileToServer();
        expect(sentTo(B)[0]?.archetype).toBe(publicOf(quiz('2026-11-03')));
    });

    describe('a guest with a row of their own on the phone: only the node says member', () => {
        // Re-run Setup has no guest gate: on a visit its POST answers 404 and it writes the row all the same
        // (app/profile-setup.tsx). A non-member can't read the directory, so no sync ever takes that row away.
        const blocksSentTo = (origin: string) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${origin}/api/blocks`));
        const guestWithARow = async () => {
            await addSavedNode(A);
            await addSavedNode(B);
            await markGuestNode(B);
            nodeAt(B).member = 'no';
            await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-03')) });
            await openCommunity(B);
            await updateMemberProfile(ME, { callsign: 'Marty', bio: 'Written on a visit' });
            expect((await getMemberProfile(ME))?.bio).toBe('Written on a visit');
        };

        it('the first run leaves the mark, which is what keeps the phone off /node-mismatch and lets it switch back', async () => {
            await guestWithARow();
            await firstRunWorkingStyle();

            // The very read the watcher in app/_layout.tsx makes of the open community before it sends a 'stranger' there.
            expect(await isGuestNode(store.get('beanpool_anchor_url')!)).toBe(true);
            const switchTo = vi.fn(async () => {});
            const asked = await askBeforeSwitch(B, me.identity!, { switchTo, fetchProfile: async () => null, cachedProfile: async () => null });
            expect(asked.kind).toBe('guest');
            expect(switchTo).toHaveBeenCalledWith(B);
        });

        it('the first run asks no community and marks nothing there', async () => {
            await guestWithARow();
            await firstRunWorkingStyle();
            expect(nodeAt(B).probes).toBe(0);
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('nothing goes there after the first run: not the result, and not the block list', async () => {
            await guestWithARow();
            await blockUser(SOMEONE_ELSE, ME, 'Abusive user reported via Trust Profile');
            await blockSyncsEndedForTests();
            await firstRunWorkingStyle();

            await syncBlocks();
            await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x' });
            await pushProfileToServer();

            expect(blocksSentTo(B)).toEqual([]);
            for (const body of sentTo(B)) expect(body).not.toHaveProperty('archetype');
        });

        it('a directory that lists a visitor\'s row is no answer either: a sync leaves the mark while the node says no', async () => {
            // This stand-in lists the key whatever it says of membership, as a node with ENFORCE_READ_AUTH=false lists a
            // visitor's row: /api/members holds them and doesn't filter them out.
            await guestWithARow();
            await performSync();
            expect(nodeAt(B).probes).toBeGreaterThan(0);
            expect(await isGuestNode(B)).toBe(true);
            expect(sentTo(B)).toEqual([]);
        });

        it('a row the node holds older, on a guest visit: nothing waits there, so nothing is held to send after a join', async () => {
            await guestWithARow();
            await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', archetype: publicOf(quiz('2026-11-03', 'spark')) });
            nodeAt(B).held.archetype = publicOf(quiz('2026-11-01', 'guardian'));
            await performSync();
            expect(await isGuestNode(B)).toBe(true);
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('no answer from the node leaves the mark too', async () => {
            await guestWithARow();
            nodeAt(B).member = 'silent';
            await performSync();
            expect(await isGuestNode(B)).toBe(true);
        });

        it('a member whose mark is stale heals once the node says so, in the spelling the visit wrote', async () => {
            await guestWithARow();
            await markGuestNode(`${B}/`);
            nodeAt(B).member = 'yes';
            await performSync();
            expect(await isGuestNode(B)).toBe(false);
            expect(await isGuestNode(`${B}/`)).toBe(false);
        });

        it('a member who is no guest anywhere: a sync asks the community nothing about it', async () => {
            await memberOfBoth();
            await performSync();
            expect(nodeAt(A).probes).toBe(0);
        });
    });
});

describe('a result carried from another community\'s row is no retake: on a tie the row stands, and nothing is sent', () => {
    // scratch/fable-design/DESIGN-archetype-across-fable.md §3: "Same day on two devices: the row stands, nothing is sent".
    const adopted = quiz('2026-11-03', 'spark');
    const sameDayThere = publicOf(quiz('2026-11-03', 'harmonizer'));

    /** A's sync brings a newer row: the phone adopts it, and it waits for B, which holds `heldAtB`. */
    const adoptedFromA = async (heldAtB: string | null) => {
        await memberOfBoth();
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-01', 'guardian')) });
        nodeAt(A).held.archetype = publicOf(adopted);
        nodeAt(B).held.archetype = heldAtB;
        await openCommunity(A);
        await performSync();
        expect((await getCanonicalProfile())?.archetype).toBe(publicOf(adopted));
        expect(await waitingArchetype(B, ME)).toBe(publicOf(adopted));
    };

    it('a different result the same day at B: B\'s row stands, no write, and it stops waiting', async () => {
        await adoptedFromA(sameDayThere);
        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).held.archetype).toBe(sameDayThere);
        expect(await waitingArchetype(B, ME)).toBeNull();

        await performSync();
        expect(sentTo(B)).toEqual([]);
    });

    it('the identical result at B: no POST', async () => {
        await adoptedFromA(publicOf(adopted));
        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('a Save at B leaves it out too', async () => {
        await adoptedFromA(sameDayThere);
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'Saved at B' });
        await pushProfileToServer();
        expect(sentTo(B)).toHaveLength(1);
        expect(sentTo(B)[0]).not.toHaveProperty('archetype');
        expect(nodeAt(B).held.archetype).toBe(sameDayThere);
    });

    it('an older result at B takes it', async () => {
        await adoptedFromA(publicOf(quiz('2026-11-02', 'sage')));
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(adopted));
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('a community holding none takes it', async () => {
        await adoptedFromA(null);
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(adopted));
    });

    it('a retake made here after it was carried is a retake: it replaces what waits and goes over the same-day row', async () => {
        await adoptedFromA(sameDayThere);
        const retake = quiz('2026-11-03', 'sage');
        await keepQuizResult(retake, ME, A);
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(retake));
    });

    it('a retake still waiting at a first run stays a retake: it goes over the same-day row', async () => {
        await memberOfBoth();
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-01', 'guardian')) });
        await openCommunity(A);
        const retake = quiz('2026-11-03', 'sage');
        await keepQuizResult(retake, ME, A);
        nodeAt(B).held.archetype = sameDayThere;

        await firstRunWorkingStyle();
        await openCommunity(B);
        await performSync();
        expect(nodeAt(B).held.archetype).toBe(publicOf(retake));
    });

    it('the first run marks a result the same way: over a row the phone holds as older, but the node holds from the same day', async () => {
        await memberOfBoth();
        await openCommunity(A);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(adopted) });
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-01', 'guardian')) });
        await saveCanonicalProfile({ archetype: null });
        nodeAt(B).held.archetype = sameDayThere;

        await firstRunWorkingStyle();
        expect(await waitingArchetype(B, ME)).toBe(publicOf(adopted));

        await performSync();
        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).held.archetype).toBe(sameDayThere);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('stays carried when the community moves to a new address', async () => {
        await addSavedNode(B);
        await keepCarriedArchetype(A, ME, publicOf(adopted));
        await carryPendingProfileChange(A, B);
        nodeAt(B).held.archetype = sameDayThere;
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty' });
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });
});

describe('never over a newer result the community already holds', () => {
    it('a second device put a newer result there since this phone last synced: what waits is not sent, and stops waiting', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-02', 'sage'), ME, A);
        // Taken on another device: the node has it, and this phone's copy of the row doesn't yet.
        nodeAt(B).held.archetype = publicOf(quiz('2026-11-03', 'spark'));
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).held.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('a catch-up too: a device copy newer than the phone\'s row but older than the node\'s stays here', async () => {
        await memberOfBoth();
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', archetype: publicOf(quiz('2026-11-01', 'guardian')) });
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-02', 'sage')) });
        nodeAt(A).held.archetype = publicOf(quiz('2026-11-03', 'spark'));
        await pushProfileToServer();
        expect(sentTo(A)[0]).not.toHaveProperty('archetype');
        expect(nodeAt(A).held.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
    });

    it('a node behind the phone\'s row catches up at the next Save, and one that holds the same day is left alone', async () => {
        await memberOfBoth();
        const now = quiz('2026-11-03', 'spark');
        await updateMemberProfile(ME, { callsign: 'Marty', bio: 'x', archetype: publicOf(now) });
        await saveCanonicalProfile({ archetype: JSON.stringify(now) });
        nodeAt(A).held.archetype = publicOf(quiz('2026-11-01', 'guardian'));
        await performSync();
        await pushProfileToServer();
        expect(nodeAt(A).held.archetype).toBe(publicOf(now));

        const sameDay = publicOf(quiz('2026-11-03', 'sage'));
        nodeAt(A).held.archetype = sameDay;
        await performSync();
        await pushProfileToServer();
        expect(nodeAt(A).held.archetype).toBe(sameDay);
    });

    it('a same-day result on the node does not stop a retake made here', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03', 'spark'), ME, A);
        nodeAt(B).held.archetype = publicOf(quiz('2026-11-03', 'sage'));
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(nodeAt(B).held.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
    });

    it('a community that says who is a member but won\'t show its row: nothing sent, and it still waits', async () => {
        await memberOfBoth();
        const taken = quiz('2026-11-03');
        await keepQuizResult(taken, ME, A);
        nodeAt(B).profileSilent = true;
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(await waitingArchetype(B, ME)).toBe(publicOf(taken));
    });
});

describe('the device copy', () => {
    it('only the quiz writes it: a row written here never overwrites it', async () => {
        await memberOfBoth();
        const taken = JSON.stringify(quiz('2026-11-03', 'spark'));
        await keepQuizResult(quiz('2026-11-03', 'spark'), ME, A);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-10-01', 'guardian')) });
        expect((await getCanonicalProfile())?.archetype).toBe(taken);
    });

    it('survives a members sync bringing an older row', async () => {
        await memberOfBoth();
        const taken = JSON.stringify(quiz('2026-11-03', 'spark'));
        await keepQuizResult(quiz('2026-11-03', 'spark'), ME, B);
        nodeAt(A).held.archetype = publicOf(quiz('2026-10-01', 'guardian'));
        await openCommunity(A);
        await performSync();
        expect((await getCanonicalProfile())?.archetype).toBe(taken);
    });

    it('adopts a newer row when the members sync brings it, and carries it on to the other community', async () => {
        await memberOfBoth();
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-01', 'guardian')) });
        nodeAt(A).held.archetype = publicOf(quiz('2026-11-03', 'spark'));
        await openCommunity(A);
        await performSync();
        expect((await getCanonicalProfile())?.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
        expect(await waitingArchetype(B, ME)).toBe(publicOf(quiz('2026-11-03', 'spark')));
    });

    it('survives an incoming older archetype from sync without overwriting local newer row or adopting into canonical copy', async () => {
        await memberOfBoth();
        await openCommunity(A);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-03', 'spark')) });
        await saveCanonicalProfile({ archetype: null });
        nodeAt(A).held.archetype = publicOf(quiz('2026-11-01', 'guardian'));
        await performSync();
        expect((await getMemberProfile(ME))?.archetype).toBe(publicOf(quiz('2026-11-03', 'spark')));
        expect((await getCanonicalProfile())?.archetype).toBeNull();
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('two rows, two days: the device copy is the newer, the older community\'s entry is marked', async () => {
        await memberOfBoth();
        await openCommunity(A);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-01', 'guardian')) });
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-02', 'spark')) });

        await saveCanonicalProfile({ archetype: null });

        await firstRunWorkingStyle();

        expect((await getCanonicalProfile())?.archetype).toBe(publicOf(quiz('2026-11-02', 'spark')));
        expect(await waitingArchetype(A, ME)).toBe(publicOf(quiz('2026-11-02', 'spark')));
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('orders the old millisecond stamps and cuts them to a date before marking', async () => {
        await memberOfBoth();
        await openCommunity(A);
        await updateMemberProfile(ME, {
            callsign: 'Marty',
            archetype: JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', updatedAt: '2026-10-01T12:00:00.000Z' }),
        });
        await openCommunity(B);
        await updateMemberProfile(ME, {
            callsign: 'Marty',
            archetype: JSON.stringify({ primary: 'spark', secondary: 'weaver', mode: 'quick', updatedAt: '2026-10-02T15:30:00.000Z' }),
        });

        await saveCanonicalProfile({ archetype: null });

        await firstRunWorkingStyle();

        expect((await getCanonicalProfile())?.archetype).toContain('spark');
        const marked = await waitingArchetype(A, ME);
        expect(marked).toBe(JSON.stringify({ primary: 'spark', secondary: 'weaver', mode: 'quick', takenOn: '2026-10-02' }));
        expect(marked).not.toContain('updatedAt');
        expect(marked).not.toContain('15:30');
    });

    it('the first run is safe to run twice and leaves ties alone', async () => {
        await memberOfBoth();
        await openCommunity(A);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-02', 'guardian')) });
        await openCommunity(B);
        await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(quiz('2026-11-02', 'spark')) });

        await saveCanonicalProfile({ archetype: null });

        await firstRunWorkingStyle();
        expect(await waitingArchetype(A, ME)).toBeNull();
        expect(await waitingArchetype(B, ME)).toBeNull();

        await firstRunWorkingStyle();
        expect(await waitingArchetype(A, ME)).toBeNull();
        expect(await waitingArchetype(B, ME)).toBeNull();
    });
});

describe('what waits goes as an entry goes', () => {
    it('Sign Out wipes it: its key is under the prefix the account\'s wipe takes', () => {
        expect(PENDING_ARCHETYPE_STORE_PREFIX.startsWith(PENDING_PROFILE_STORE_PREFIX)).toBe(true);
    });

    it('is read only for the account it was kept for', async () => {
        await keepWaitingArchetype(B, ME, 'x');
        expect(await waitingArchetype(B, SOMEONE_ELSE)).toBeNull();
    });

    it('nothing is kept for an address that isn\'t plain', async () => {
        await keepWaitingArchetype('https://user@evil.example', ME, 'x');
        expect([...store.keys()].filter(k => k.includes('archetype'))).toEqual([]);
    });

    it('goes when the community leaves the phone (Forget Community)', async () => {
        await addSavedNode(B);
        await keepWaitingArchetype(B, ME, 'x');
        await removeSavedNode(B);
        expect(await waitingArchetype(B, ME)).toBeNull();
    });

    it('follows a community to its new address', async () => {
        await keepWaitingArchetype(A, ME, 'x');
        await carryPendingProfileChange(A, B);
        expect(await waitingArchetype(B, ME)).toBe('x');
        expect(await waitingArchetype(A, ME)).toBeNull();
    });

    it('a publish that carried a parked photo and said nothing of the result leaves it waiting', async () => {
        await keepPendingProfileChange(B, ME, { avatar: 'bundled://koala' });
        await keepWaitingArchetype(B, ME, 'x');
        await retireParkedPickAfterPublish({ avatar: 'bundled://koala', clearsParkedPick: true }, B);
        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await waitingArchetype(B, ME)).toBe('x');
    });

    it('the join wizard\'s two photo publishes say nothing of the result, so they leave it waiting', async () => {
        // An account already on the phone can join by invite at an address it saved: the wizard publishes the name and
        // photo there, and no word of a result. Cleared bare, what waited would go until the next Save.
        const wizard = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../app/welcome.tsx'), 'utf8');
        expect(wizard).not.toMatch(/archetype/i);
        expect(wizard.match(/clearPendingProfileChange\(url, undefined, undefined, true\)/g)).toHaveLength(2);
        expect(wizard).not.toMatch(/clearPendingProfileChange\(url\)/);

        await keepPendingProfileChange(B, ME, { avatar: 'bundled://koala' });
        await keepWaitingArchetype(B, ME, 'x');
        await clearPendingProfileChange(B, undefined, undefined, true);
        expect(await pendingProfileChange(B, ME)).toBeNull();
        expect(await waitingArchetype(B, ME)).toBe('x');
    });
});

// ─── S3: Remove my working style, and Forget Community ───────────────────────────────────────────────────────────────────

describe('Forget Community leaves the device copy and the node\'s row', () => {
    it('the device copy stays, the community\'s own copy of what waits goes, and the node keeps its row', async () => {
        await memberOfBoth();
        await keepQuizResult(quiz('2026-11-03', 'spark'), ME, A);
        nodeAt(B).held.archetype = publicOf(quiz('2026-10-01', 'guardian'));
        expect(await waitingArchetype(B, ME)).toBe(publicOf(quiz('2026-11-03', 'spark')));

        await removeSavedNode(B);

        expect((await getCanonicalProfile())?.archetype).toBe(JSON.stringify(quiz('2026-11-03', 'spark')));
        expect(await waitingArchetype(B, ME)).toBeNull();
        // Nothing was sent to the community to take the row off: leaving a community says nothing about the working style.
        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).held.archetype).toBe(publicOf(quiz('2026-10-01', 'guardian')));
    });

    it('a removal waiting for the community goes with it, and the other community still hears it', async () => {
        await memberOfBoth();
        await saveCanonicalProfile({ archetype: JSON.stringify(quiz('2026-11-01')) });
        await removeWorkingStyle(ME);
        expect(await waitingRemoval(B, ME)).not.toBeNull();
        await removeSavedNode(B);
        expect(await waitingRemoval(B, ME)).toBeNull();
        expect(await waitingRemoval(A, ME)).not.toBeNull();
    });
});

describe('Remove my working style', () => {
    beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-03T10:00:00Z'), toFake: ['Date'] }); });
    afterEach(() => { vi.useRealTimers(); });

    const OLD = quiz('2026-11-01', 'guardian');
    /** The member took the quiz in A on 1 Nov: every community holds it, on the node and in the phone's copy of the row. */
    async function holdingOldResult() {
        await memberOfBoth();
        await saveCanonicalProfile({ archetype: JSON.stringify(OLD) });
        for (const url of [A, B]) {
            nodeAt(url).held.archetype = publicOf(OLD);
            await openCommunity(url);
            await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(OLD) });
        }
    }

    it('takes the device copy and every community\'s row off the phone, and leaves a removal waiting for each, sending nothing yet', async () => {
        await holdingOldResult();
        await removeWorkingStyle(ME);

        expect((await getCanonicalProfile())?.archetype).toBeNull();
        for (const url of [A, B]) {
            await openCommunity(url);
            expect((await getMemberProfile(ME))?.archetype).toBeNull();
            expect(await waitingRemoval(url, ME)).toEqual({ removedOn: '2026-11-03' });
            expect(sentTo(url)).toEqual([]);
        }
    });

    it('sends a null to every community on the phone, each at its own sync, and each stops waiting', async () => {
        await holdingOldResult();
        await removeWorkingStyle(ME);

        await openCommunity(A);
        expect((await performSync()).success).toBe(true);
        expect(sentTo(A)).toEqual([{ publicKey: ME, archetype: null }]);
        expect(nodeAt(A).held.archetype).toBeNull();
        expect(await waitingRemoval(A, ME)).toBeNull();
        // B has not had its turn: it waits.
        expect(sentTo(B)).toEqual([]);
        expect(await waitingRemoval(B, ME)).not.toBeNull();

        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([{ publicKey: ME, archetype: null }]);
        expect(nodeAt(B).held.archetype).toBeNull();
        expect(await waitingRemoval(B, ME)).toBeNull();

        // Neither sync brought the removed result back, and nothing is sent twice.
        expect((await getCanonicalProfile())?.archetype).toBeNull();
        await performSync();
        expect(sentTo(B)).toHaveLength(1);
        expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();
    });

    it('a null goes only where the node holds a result', async () => {
        await holdingOldResult();
        nodeAt(B).held.archetype = null;
        await removeWorkingStyle(ME);
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(await waitingRemoval(B, ME)).toBeNull();
    });

    it('a guest visit gets nothing: no removal waits there and the community is not even asked', async () => {
        await holdingOldResult();
        await markGuestNode(B);
        await removeWorkingStyle(ME);
        expect(await waitingRemoval(B, ME)).toBeNull();
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(nodeAt(B).probes).toBe(0);
    });

    it('a community that says the key is no member gets nothing, and the removal stops waiting there', async () => {
        await holdingOldResult();
        nodeAt(B).member = 'no';
        await removeWorkingStyle(ME);
        await openCommunity(B);
        await pushWaitingArchetype({ community: B });
        expect(sentTo(B)).toEqual([]);
        expect(await waitingRemoval(B, ME)).toBeNull();
    });

    it('a community that cannot be reached keeps the removal waiting, and gets it when it answers', async () => {
        await holdingOldResult();
        await removeWorkingStyle(ME);
        await openCommunity(B);
        nodeAt(B).mode = 'offline';
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(await waitingRemoval(B, ME)).toEqual({ removedOn: '2026-11-03' });
        nodeAt(B).mode = 'busy';
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(await waitingRemoval(B, ME)).not.toBeNull();
        nodeAt(B).mode = 'ok';
        expect(await pushWaitingArchetype({ community: B })).toBe(true);
        expect(nodeAt(B).held.archetype).toBeNull();
        expect(await waitingRemoval(B, ME)).toBeNull();
    });

    it('a community that will not say who is a member keeps it waiting too', async () => {
        await holdingOldResult();
        await removeWorkingStyle(ME);
        await openCommunity(B);
        nodeAt(B).member = 'silent';
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(sentTo(B)).toEqual([]);
        expect(await waitingRemoval(B, ME)).not.toBeNull();
    });

    it('sends only from its own community: a cycle for B with the phone moved to A sends nothing', async () => {
        await holdingOldResult();
        await removeWorkingStyle(ME);
        await openCommunity(A);
        expect(await pushWaitingArchetype({ community: B })).toBe(false);
        expect(sentTo(B)).toEqual([]);
    });

    describe('an old result does not come back', () => {
        it('the community still to be told shows the result at its sync: not into the row, the device copy or the other community', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            // A cannot answer who is a member right now, so the removal waits, and its sync brings the old result in.
            nodeAt(A).member = 'silent';
            await openCommunity(A);
            await performSync();

            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();
            expect(await waitingRemoval(A, ME)).not.toBeNull();
            // B's waiting is still the removal: the old result was not carried to it.
            expect(await waitingRemoval(B, ME)).not.toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('a row the phone holds that the node holds older does not send the removed result back to the node', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            // The phone's row still held the result (a copy that could not be cleared), and the node holds an older one.
            await openCommunity(A);
            await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(OLD) });
            nodeAt(A).held.archetype = publicOf(quiz('2026-10-01', 'sage'));
            nodeAt(A).member = 'silent';
            await performSync();
            expect(await waitingArchetype(A, ME)).toBeNull();
            expect(await waitingRemoval(A, ME)).not.toBeNull();
            expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();
            expect(sentTo(A)).toEqual([]);
        });

        it('another community\'s carried result from before the removal does not replace the removal waiting', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            await keepCarriedArchetype(B, ME, publicOf(OLD));
            expect(await waitingRemoval(B, ME)).not.toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('the first run does not take a result from a row of a community still to be told', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            await openCommunity(B);
            await updateMemberProfile(ME, { callsign: 'Marty', archetype: publicOf(OLD) });
            await firstRunWorkingStyle();
            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect(await waitingArchetype(A, ME)).toBeNull();
        });
    });

    describe('the later of a result and a removal stands', () => {
        it('a retake after the removal replaces it: the community hears the retake, not a null', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            const again = quiz('2026-11-03', 'spark');
            await keepQuizResult(again, ME, A);
            expect(await waitingRemoval(B, ME)).toBeNull();
            expect(await waitingArchetype(B, ME)).toBe(publicOf(again));
            await openCommunity(B);
            await performSync();
            expect(sentTo(B)).toEqual([{ publicKey: ME, archetype: publicOf(again) }]);
            expect(nodeAt(B).held.archetype).toBe(publicOf(again));
        });

        it('a removal after a result waiting replaces that result: the community hears the null', async () => {
            await holdingOldResult();
            await keepQuizResult(quiz('2026-11-02', 'spark'), ME, A);
            expect(await waitingArchetype(B, ME)).not.toBeNull();
            await removeWorkingStyle(ME);
            expect(await waitingArchetype(B, ME)).toBeNull();
            await openCommunity(B);
            await performSync();
            expect(sentTo(B)).toEqual([{ publicKey: ME, archetype: null }]);
        });

        it('a copy that could not be cleared at the removal is cleared at the community\'s turn: the next start finds nothing to adopt', async () => {
            await holdingOldResult();
            // A's copy can't be opened for the clearing (busy past 30 s): its row keeps the result.
            const sqlite = await import('expo-sqlite');
            const open = vi.mocked(sqlite.openDatabaseAsync);
            const real = open.getMockImplementation()!;
            // (getDb sets its busy timeout in a block of statements; the clearing sets it alone, and that is what fails here.)
            open.mockImplementation(async (name: string, opts?: any) => {
                const handle = await (real as any)(name, opts);
                if (name !== 'beanpool_a.beanpool.org.db') return handle;
                return new Proxy(handle, {
                    get: (t, k) => k === 'execAsync'
                        ? async (q: string) => {
                            if (q.trim() === 'PRAGMA busy_timeout = 30000;') throw new Error('database is locked');
                            return t.execAsync(q);
                        }
                        : t[k],
                });
            });
            await removeWorkingStyle(ME);
            open.mockImplementation(real);
            await openCommunity(A);
            expect((await getMemberProfile(ME))?.archetype).toBe(publicOf(OLD));

            // A's turn: the null goes in, and the row is cleared before the removal stops waiting.
            expect((await performSync()).success).toBe(true);
            expect(sentTo(A)).toEqual([{ publicKey: ME, archetype: null }]);
            expect(await waitingRemoval(A, ME)).toBeNull();
            expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();

            // The next start adopts nothing and carries nothing to B.
            await firstRunWorkingStyle();
            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('a copy still locked at the community\'s turn keeps the removal waiting, and clears when it opens', async () => {
            await holdingOldResult();
            const sqlite = await import('expo-sqlite');
            const open = vi.mocked(sqlite.openDatabaseAsync);
            const real = open.getMockImplementation()!;
            // (getDb sets its busy timeout in a block of statements; the clearing sets it alone, and that is what fails here.)
            open.mockImplementation(async (name: string, opts?: any) => {
                const handle = await (real as any)(name, opts);
                if (name !== 'beanpool_a.beanpool.org.db') return handle;
                return new Proxy(handle, {
                    get: (t, k) => k === 'execAsync'
                        ? async (q: string) => {
                            if (q.trim() === 'PRAGMA busy_timeout = 30000;') throw new Error('database is locked');
                            return t.execAsync(q);
                        }
                        : t[k],
                });
            });
            await removeWorkingStyle(ME);
            await openCommunity(A);
            await performSync();
            // The null went in, but the row could not be cleared: the removal is not dropped.
            expect(sentTo(A)).toEqual([{ publicKey: ME, archetype: null }]);
            expect(await waitingRemoval(A, ME)).not.toBeNull();
            // Nothing is adopted meanwhile.
            await firstRunWorkingStyle();
            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();

            open.mockImplementation(real);
            await performSync();
            expect(await waitingRemoval(A, ME)).toBeNull();
            expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();
            await firstRunWorkingStyle();
            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('a copy that could not be cleared, at a community that now says no member: the row is cleared before the removal goes, and nothing comes back', async () => {
            await holdingOldResult();
            const sqlite = await import('expo-sqlite');
            const open = vi.mocked(sqlite.openDatabaseAsync);
            const real = open.getMockImplementation()!;
            open.mockImplementation(async (name: string, opts?: any) => {
                const handle = await (real as any)(name, opts);
                if (name !== 'beanpool_a.beanpool.org.db') return handle;
                return new Proxy(handle, {
                    get: (t, k) => k === 'execAsync'
                        ? async (q: string) => {
                            if (q.trim() === 'PRAGMA busy_timeout = 30000;') throw new Error('database is locked');
                            return t.execAsync(q);
                        }
                        : t[k],
                });
            });
            await removeWorkingStyle(ME);
            open.mockImplementation(real);
            // A has dropped the key since: it says no member and holds no result for it.
            nodeAt(A).member = 'no';
            nodeAt(A).held.archetype = null;
            await openCommunity(A);
            expect((await getMemberProfile(ME))?.archetype).toBe(publicOf(OLD));

            await performSync();
            expect(sentTo(A)).toEqual([]);
            expect(await waitingRemoval(A, ME)).toBeNull();
            expect((await getMemberProfile(ME))?.archetype ?? null).toBeNull();
            await firstRunWorkingStyle();
            expect((await getCanonicalProfile())?.archetype).toBeNull();
            expect(await waitingArchetype(B, ME)).toBeNull();
        });

        it('a result taken on another device after the removal stands: no null is sent, and the phone takes it', async () => {
            await holdingOldResult();
            await removeWorkingStyle(ME);
            const later = quiz('2026-11-04', 'spark');
            nodeAt(B).held.archetype = publicOf(later);
            await openCommunity(B);
            await performSync();
            expect(sentTo(B)).toEqual([]);
            expect(await waitingRemoval(B, ME)).toBeNull();
            expect((await getCanonicalProfile())?.archetype).toBe(publicOf(later));
            // and it is carried to A, over A's waiting removal.
            expect(await waitingArchetype(A, ME)).toBe(publicOf(later));
        });
    });
});

describe('another member\'s removal reaches this phone (archetype-s3)', () => {
    const THEIRS = publicOf(quiz('2026-11-01', 'guardian'));
    async function holdingTheirResult() {
        await addSavedNode(A);
        await openCommunity(A);
        await updateMemberProfile(SOMEONE_ELSE, { callsign: 'Sam', archetype: THEIRS });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype).toBe(THEIRS);
    }

    it('a delta that names them with a null drops the result from their row', async () => {
        await holdingTheirResult();
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam', archetype: null }] });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype ?? null).toBeNull();
    });

    it('a keys= answer and a complete list do the same', async () => {
        await holdingTheirResult();
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam', archetype: null }], membersByKey: true });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype ?? null).toBeNull();
        await updateMemberProfile(SOMEONE_ELSE, { callsign: 'Sam', archetype: THEIRS });
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam', archetype: null }], membersComplete: true });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype ?? null).toBeNull();
    });

    it('a delta that leaves the field out keeps what the phone holds', async () => {
        await holdingTheirResult();
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam' }] });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype).toBe(THEIRS);
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam', archetype: undefined }], membersComplete: true });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype).toBe(THEIRS);
    });

    it('a delta carrying a new result replaces the old', async () => {
        await holdingTheirResult();
        const newer = publicOf(quiz('2026-11-02', 'spark'));
        await applyDelta({ members: [{ publicKey: SOMEONE_ELSE, callsign: 'Sam', archetype: newer }] });
        expect((await getMemberProfile(SOMEONE_ELSE))?.archetype).toBe(newer);
    });
});

describe('a date from a bad clock or a node does not stop a retake (archetype-s3)', () => {
    it('a node holding a far-future day takes this phone\'s retake', async () => {
        await memberOfBoth();
        nodeAt(B).held.archetype = JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', takenOn: '2099-01-01' });
        const again = quiz(new Date().toISOString().slice(0, 10), 'spark');
        await keepQuizResult(again, ME, A);
        await openCommunity(B);
        await performSync();
        expect(sentTo(B)).toEqual([{ publicKey: ME, archetype: publicOf(again) }]);
    });
});
