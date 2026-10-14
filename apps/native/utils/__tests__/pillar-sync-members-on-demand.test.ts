import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Module from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Members on demand on the phone (DESIGN-global-members-by-area §2.2, #1792, slice M2). On a community whose profile says
// `features.membersOnDemand` (the worldwide one), performSync never reads /api/members whole and never asks for everyone
// who changed: after the cycle lands it asks for the referenced cards it lacks by key, at most 3 batches of 100 a cycle,
// re-checks the 100 held cards fetched longest ago with their oldest stamp, and leaves every card where it was when a
// read is refused. A community that doesn't say gets exactly the requests it got before. performSync runs against a
// fake node, writing the phone's real schema in an in-memory SQLite, with AsyncStorage kept in a map across cycles.

const sql = new DatabaseSync(':memory:');
const params = (p: unknown) => (p === undefined ? [] : Array.isArray(p) ? p : [p]) as any[];
const adapter = {
    runAsync: vi.fn(async (q: string, p?: unknown) => {
        const r = sql.prepare(q).run(...params(p));
        return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    }),
    execAsync: vi.fn(async (q: string) => { sql.exec(q); }),
    getAllAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).all(...params(p))),
    getFirstAsync: vi.fn(async (q: string, p?: unknown) => sql.prepare(q).get(...params(p)) ?? null),
    closeAsync: vi.fn(async () => {}),
    withTransactionAsync: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
};

const A_URL = 'https://a.beanpool.org';
const OWN = 'e'.repeat(64);
const store = new Map<string, string>();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn(async () => adapter) }));
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
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: 'e'.repeat(64), privateKey: 'aa', callsign: 'Me' })) }));
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: vi.fn((url: string | null) => (url ? `beanpool_${new URL(url).hostname}.db` : 'beanpool_none.db')),
    addSavedNode: vi.fn(async () => {}),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(async () => null), saveCanonicalProfile: vi.fn(async () => {}) }));

const realLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: any[]) {
    if (request === 'react-native') return { DeviceEventEmitter: { emit: () => {} } };
    return realLoad.call(this, request, ...rest);
};
afterAll(() => { (Module as any)._load = realLoad; });

import { applyDelta, getDb, getPosts, getMyPosts, getPost, getMemberRatings } from '../db';
import { performSync, resetSyncFingerprints } from '../../services/pillar-sync';

const DB = 'beanpool_a.beanpool.org.db';
const KEY = (id: string) => `pillar_sync_${DB}_${id}`;
const hexKey = (n: number) => n.toString(16).padStart(64, '0');
const FACE = (pk: string) => `/api/avatar/${pk}?v=1`;

// The node's directory: every member as the directory row shape (§2.1), with when their card last changed.
interface Card { publicKey: string; callsign: string; avatarUrl: string | null; profileUpdatedAt: string }
const node = {
    cards: new Map<string, Card>(),
    keysReads: 'ok' as 'ok' | 'busy',
    requests: [] as string[],
};
function answer(status: number, body: string) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: { get: () => null },
        text: async () => body, json: async () => JSON.parse(body),
    };
}
function listing(id: string, author: string) {
    return {
        id, type: 'offer', category: 'food', title: `Listing ${id}`, description: '', credits: 5, priceType: 'fixed',
        authorPublicKey: author, authorCallsign: 'Carried', authorAvatarUrl: FACE(author),
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
        active: true, status: 'active', audienceScope: 'public', photos: [],
    };
}
const AUTHOR = hexKey(0xa0a0);
const fetchMock = vi.fn(async (url: string) => {
    node.requests.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/marketplace/posts') return answer(200, JSON.stringify([listing('L1', AUTHOR)]));
    if (u.pathname === '/api/members') {
        const keys = u.searchParams.get('keys');
        if (keys !== null) {
            if (node.keysReads === 'busy') return answer(503, JSON.stringify({ code: 'heavy_read_busy' }));
            const asked = keys.split(',');
            if (asked.length > 100) return answer(400, '{}');
            const after = u.searchParams.get('updatedAfter');
            const rows = asked.map(k => node.cards.get(k)).filter((c): c is Card => !!c && (after === null || c.profileUpdatedAt > after));
            return answer(200, JSON.stringify(rows));
        }
        return answer(200, JSON.stringify([...node.cards.values()]));
    }
    return answer(404, '');
});

const membersRequests = () => node.requests.filter(r => new URL(r).pathname === '/api/members');
const keysOf = (r: string) => new URL(r).searchParams.get('keys')?.split(',') ?? [];
const held = () => (sql.prepare('SELECT public_key FROM members').all() as any[]).map(r => r.public_key as string);
const cardStamp = (pk: string) => (sql.prepare('SELECT card_fetched_at FROM members WHERE public_key = ?').get(pk) as any)?.card_fetched_at ?? null;
function onDemandProfile(on: boolean | undefined) {
    const features = on === undefined ? {} : { membersOnDemand: on };
    store.set('beanpool_node_profiles', JSON.stringify({ [A_URL]: { profile: on ? 'global' : 'local', features, checkedAt: new Date().toISOString() } }));
}
function partners(n: number) {
    const keys: string[] = [];
    for (let i = 1; i <= n; i++) {
        const pk = hexKey(i);
        keys.push(pk);
        sql.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits) VALUES (?, ?, ?, ?, ?)').run(`t${i}`, 'L1', OWN, pk, 1);
    }
    return keys;
}

beforeEach(async () => {
    store.clear();
    store.set('beanpool_anchor_url', A_URL);
    resetSyncFingerprints();
    (globalThis as any).fetch = fetchMock;
    await getDb();
    for (const t of ['posts', 'marketplace_transactions', 'conversations', 'conversation_participants', 'members', 'ratings', 'friends']) sql.exec(`DELETE FROM ${t}`);
    node.cards.clear();
    node.keysReads = 'ok';
    node.requests = [];
    node.cards.set(OWN, { publicKey: OWN, callsign: 'Me', avatarUrl: null, profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
    for (let i = 1; i <= 2000; i++) {
        const pk = hexKey(i);
        node.cards.set(pk, { publicKey: pk, callsign: `M${i}`, avatarUrl: FACE(pk), profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
    }
});

describe('a community that says membersOnDemand', () => {
    it('never reads the directory whole nor asks for everyone who changed, over several cycles', async () => {
        onDemandProfile(true);
        partners(5);
        for (let i = 0; i < 3; i++) expect((await performSync()).success).toBe(true);
        const reads = membersRequests();
        expect(reads.length).toBeGreaterThan(0);
        for (const r of reads) expect(new URL(r).searchParams.get('keys'), r).not.toBeNull();
        // The own card and the five partners; no one else.
        expect(held().sort()).toEqual([OWN, ...[1, 2, 3, 4, 5].map(hexKey)].sort());
    });

    it('a restore with 350 partners: 3 batches of ≤ 100 the first cycle, the rest the next; then held ⊇ referenced ∪ own', async () => {
        onDemandProfile(true);
        const keys = partners(350);
        await performSync();
        const first = membersRequests();
        const firstMissing = first.filter(r => new URL(r).searchParams.get('updatedAfter') === null);
        expect(firstMissing.length).toBe(3);
        for (const r of firstMissing) expect(keysOf(r).length).toBeLessThanOrEqual(100);
        expect(held().length).toBe(300);
        node.requests = [];
        await performSync();
        const h = new Set(held());
        for (const k of [OWN, ...keys]) expect(h.has(k)).toBe(true);
        // The second cycle asked only for the 51 left (one batch), plus the one re-check.
        const second = membersRequests();
        expect(second.filter(r => new URL(r).searchParams.get('updatedAfter') === null).map(r => keysOf(r).length)).toEqual([51]);
    });

    it('a 503 heavy_read_busy keeps every held card and fetches the missing ones next cycle', async () => {
        onDemandProfile(true);
        const keys = partners(20);
        await performSync();
        expect(held().length).toBe(21);
        // New partners arrive; the node is busy for the next cycle.
        for (let i = 21; i <= 30; i++) sql.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run('c1', hexKey(i));
        node.keysReads = 'busy';
        await performSync();
        expect(held().length).toBe(21);
        for (const k of [OWN, ...keys]) expect(held()).toContain(k);
        node.keysReads = 'ok';
        await performSync();
        expect(held().length).toBe(31);
    });

    it('re-checks the held cards round robin: the re-check URL carries the batch\'s oldest stamp, and a changed card lands', async () => {
        onDemandProfile(true);
        partners(3);
        await performSync();
        const before = [OWN, hexKey(1), hexKey(2), hexKey(3)].map(cardStamp);
        expect(before).not.toContain(null);
        // The own card was fetched a moment before the partners: it is the oldest of the batch.
        sql.prepare('UPDATE members SET card_fetched_at = ? WHERE public_key = ?').run('2026-10-01T00:00:00.000Z', OWN);
        node.requests = [];
        node.cards.set(hexKey(2), { ...node.cards.get(hexKey(2))!, callsign: 'Renamed', profileUpdatedAt: new Date(Date.now() + 60_000).toISOString() });
        await performSync();
        const recheck = membersRequests().filter(r => new URL(r).searchParams.get('updatedAfter') !== null);
        expect(recheck.length).toBe(1);
        // The oldest stamp less the 5 minutes kept for a phone clock running ahead of the node's (NB2 below).
        expect(new URL(recheck[0]).searchParams.get('updatedAfter')).toBe('2026-09-30T23:55:00.000Z');
        expect(keysOf(recheck[0]).sort()).toEqual([OWN, hexKey(1), hexKey(2), hexKey(3)].sort());
        // Every card re-checked is stamped now.
        for (const k of [OWN, hexKey(1), hexKey(2), hexKey(3)]) expect(cardStamp(k) > '2026-10-01T00:00:00.000Z').toBe(true);
        expect((sql.prepare('SELECT callsign FROM members WHERE public_key = ?').get(hexKey(2)) as any).callsign).toBe('Renamed');
    });

    it('a directory copy from before the switch is pruned to the rule: referenced and own kept, at most 1,000', async () => {
        await applyDelta({ members: [...node.cards.values()] }, DB);
        expect(held().length).toBe(2001);
        onDemandProfile(true);
        const keys = partners(10);
        await performSync();
        const h = held();
        expect(h.length).toBeLessThanOrEqual(1000);
        for (const k of [OWN, ...keys]) expect(h).toContain(k);
    });

    it('a listing by an author it holds no card for shows the carried name and face', async () => {
        onDemandProfile(true);
        await performSync();
        expect(held()).not.toContain(AUTHOR);
        const posts = await getPosts();
        const row = posts.find((p: any) => p.id === 'L1') as any;
        expect(row.author_callsign).toBe('Carried');
        expect(row.author_avatar).toBe(FACE(AUTHOR));
    });
});

// The deciding review of #1859 (scratch/reviews/opus-1859.md): its measurements, kept as checks.
const cardOf = (pk: string) => sql.prepare('SELECT callsign, avatar_url, card_fetched_at FROM members WHERE public_key = ?').get(pk) as any;

describe('review of #1859: what the phone holds, and what a by-key answer may write', () => {
    it('B1: holding other members\' ratings (the market draws PostAuthorTrust on every card) references only its own', async () => {
        onDemandProfile(true);
        const authors = Array.from({ length: 120 }, (_, i) => hexKey(0x10000 + i));
        for (const a of authors) node.cards.set(a, { publicKey: a, callsign: `A${a.slice(-4)}`, avatarUrl: null, profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
        (globalThis as any).fetch = vi.fn(async (url: string) => {
            const u = new URL(url);
            const m = u.pathname.match(/^\/api\/ratings\/([0-9a-f]{64})$/);
            if (m) {
                const idx = authors.indexOf(m[1]);
                const ratings = idx < 0 ? [] : Array.from({ length: 10 }, (_, j) => ({ id: `r-${idx}-${j}`, targetPubkey: m[1], raterPubkey: hexKey(1 + ((idx * 10 + j) % 2000)), stars: 5, role: 'provider', createdAt: '2026-09-01T00:00:00.000Z' }));
                return answer(200, JSON.stringify({ ratings }));
            }
            return fetchMock(url);
        });
        // What the market feed does for every card it draws (components/PostAuthorTrust.tsx), as a listing or profile open does.
        for (const a of authors) await getMemberRatings(a);
        expect((sql.prepare('SELECT COUNT(*) AS n FROM ratings').get() as any).n).toBe(1200);
        // The member's own: one who rated them and one they rated.
        sql.prepare('INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars) VALUES (?, ?, ?, ?, ?)').run('own-in', OWN, hexKey(7), 'provider', 5);
        sql.prepare('INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars) VALUES (?, ?, ?, ?, ?)').run('own-out', hexKey(8), OWN, 'receiver', 4);
        for (let c = 0; c < 3; c++) await performSync();
        expect(held().sort()).toEqual([OWN, hexKey(7), hexKey(8)].sort());
    });

    it('B2: a partner removes their photo: the re-check clears the held card, and so does opening their profile', async () => {
        onDemandProfile(true);
        partners(2);
        await performSync();
        expect(cardOf(hexKey(1)).avatar_url).toBe(FACE(hexKey(1)));
        node.cards.set(hexKey(1), { ...node.cards.get(hexKey(1))!, avatarUrl: null, profileUpdatedAt: new Date(Date.now() + 1000).toISOString() });
        await performSync();
        expect(cardOf(hexKey(1)).avatar_url).toBeNull();
        // The profile's fetch by key too: a held face put back, then the open clears it.
        sql.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run(FACE(hexKey(1)), hexKey(1));
        expect(await (await import('../members-lookup')).fetchCardByKey(hexKey(1))).toBe('fetched');
        expect(cardOf(hexKey(1)).avatar_url).toBeNull();
        // A by-key answer that names a photo still sets it; a partial members list (no by-key) still keeps what is held.
        await applyDelta({ members: [{ publicKey: hexKey(2), callsign: 'M2', avatarUrl: null }] }, DB);
        expect(cardOf(hexKey(2)).avatar_url).toBe(FACE(hexKey(2)));
    });

    it('B2: a listing author removes their photo: the carried face clears; a copy without the field keeps it', async () => {
        onDemandProfile(true);
        await performSync();
        const face = async () => ((await getPosts()) as any[]).find(p => p.id === 'L1').author_avatar;
        expect(await face()).toBe(FACE(AUTHOR));
        const serve = (row: Record<string, unknown>) => {
            (globalThis as any).fetch = vi.fn(async (url: string) => {
                const u = new URL(url);
                if (u.pathname === '/api/marketplace/posts') { node.requests.push(url); return answer(200, JSON.stringify([row])); }
                return fetchMock(url);
            });
        };
        // An older node: no authorAvatarUrl on the row. Says nothing about the face, so it stays.
        const { authorAvatarUrl: _face, ...older } = listing('L1', AUTHOR);
        serve({ ...older, updatedAt: new Date(Date.now() + 1000).toISOString() });
        await performSync();
        expect(await face()).toBe(FACE(AUTHOR));
        // The node says the author has no photo now.
        serve({ ...listing('L1', AUTHOR), authorAvatarUrl: null, updatedAt: new Date(Date.now() + 2000).toISOString() });
        await performSync();
        expect(await face()).toBeNull();
    });

    it('NB2: a phone clock 2 minutes fast still sees a rename made between cycles', async () => {
        onDemandProfile(true);
        partners(3);
        const real = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(real + 120_000);
            await performSync();
            expect(cardOf(hexKey(2)).callsign).toBe('M2');
            // The node renames partner 2 thirty seconds later, by its own clock.
            node.cards.set(hexKey(2), { ...node.cards.get(hexKey(2))!, callsign: 'Renamed', profileUpdatedAt: new Date(real + 30_000).toISOString() });
            vi.setSystemTime(real + 180_000); // the next cycle, a minute on
            await performSync();
            expect(cardOf(hexKey(2)).callsign).toBe('Renamed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('NB4: a keys= answer with rows nobody asked for writes only the asked ones', async () => {
        onDemandProfile(true);
        partners(1);
        const STRANGER = hexKey(0x7777);
        (globalThis as any).fetch = vi.fn(async (url: string) => {
            const res: any = await fetchMock(url);
            const u = new URL(url);
            if (u.pathname === '/api/members' && u.searchParams.get('keys')) {
                const rows = await res.json();
                rows.push({ publicKey: STRANGER, callsign: 'Injected', avatarUrl: null, profileUpdatedAt: '2026-09-01T00:00:00.000Z' });
                return answer(200, JSON.stringify(rows));
            }
            return res;
        });
        await performSync();
        await performSync();
        expect(cardOf(STRANGER)).toBeUndefined();
        expect(held().sort()).toEqual([OWN, hexKey(1)].sort());
    });
});

// The confirmation review of #1859 (scratch/reviews/opus-1859-confirm1.md, NB-2): a held card is the author's face. On a
// community with membersOnDemand on and nearbyListings off, a listing is re-sent only when the listing itself changes,
// so the face it carried can be older than the held card; a held card with no photo must not fall back to it.
describe('NB-2: a held card is the author\'s face, even when it has none', () => {
    it('F3: a held partner removes their photo; their listing is never re-sent: the listing shows no face', async () => {
        onDemandProfile(true);
        partners(2);
        const P1 = hexKey(1);
        const LP = { ...listing('LP', P1), updatedAt: '2026-09-01T00:00:00.000Z' };
        (globalThis as any).fetch = vi.fn(async (url: string) => {
            const u = new URL(url);
            if (u.pathname === '/api/marketplace/posts') {
                node.requests.push(url);
                // The plain delta: the author's face as it is now, on a listing sent only when it changed after the cursor.
                const after = u.searchParams.get('updatedAfter');
                const row = { ...LP, authorAvatarUrl: node.cards.get(P1)!.avatarUrl };
                return answer(200, JSON.stringify(after === null || after < LP.updatedAt ? [row] : []));
            }
            return fetchMock(url);
        });
        const face = async () => ((await getPosts()) as any[]).find(p => p.id === 'LP')?.author_avatar;
        const real = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(real);
            await performSync();
            expect(await face()).toBe(FACE(P1));
            node.cards.set(P1, { ...node.cards.get(P1)!, avatarUrl: null, profileUpdatedAt: new Date(real + 60_000).toISOString() });
            for (let c = 1; c <= 6; c++) { vi.setSystemTime(real + c * 10 * 60_000); await performSync(); }
            expect(cardOf(P1).avatar_url).toBeNull();
            // The listing still carries the old face; it is not shown.
            expect((sql.prepare('SELECT carried_avatar FROM posts WHERE id = ?').get('LP') as any).carried_avatar).toBe(FACE(P1));
            expect(await face()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    // The three reads that name a listing's author: the feed and map (getPosts), My Posts (getMyPosts), one listing (getPost).
    const P = hexKey(0xb0b0);
    const STRANGER = hexKey(0xc0c0);
    const OLD = FACE(P);
    function seed(card: { avatarUrl: string | null } | null) {
        if (card) sql.prepare('INSERT INTO members (public_key, callsign, avatar_url) VALUES (?, ?, ?)').run(P, 'Held', card.avatarUrl);
        for (const [id, author] of [['N1', P], ['N2', STRANGER]] as const) {
            sql.prepare('INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, audience_scope, created_at, updated_at, carried_callsign, carried_avatar) VALUES (?, ?, ?, ?, \'\', 5, ?, ?, 1, ?, ?, ?, ?, ?)')
                .run(id, 'offer', 'food', id, author, 'active', 'public', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'Carried', FACE(author));
        }
    }
    const reads = {
        getPosts: async (id: string) => ((await getPosts()) as any[]).find(p => p.id === id),
        getMyPosts: async (id: string) => ((await getMyPosts(id === 'N1' ? P : STRANGER)) as any[]).find(p => p.id === id),
        getPost: async (id: string) => (await getPost(id)) as any,
    };
    for (const [name, read] of Object.entries(reads)) {
        it(`${name}: a held card with no photo shows no face; a held face wins over the carried one; no card shows the carried face`, async () => {
            seed({ avatarUrl: null });
            const removed = await read('N1');
            expect(removed.author_callsign).toBe('Held');
            expect(removed.author_avatar).toBeNull();
            sql.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run('/api/avatar/new?v=2', P);
            expect((await read('N1')).author_avatar).toBe('/api/avatar/new?v=2');
            const unheld = await read('N2');
            expect(unheld.author_callsign).toBe('Carried');
            expect(unheld.author_avatar).toBe(FACE(STRANGER));
            sql.exec('DELETE FROM members');
            expect((await read('N1')).author_avatar).toBe(OLD);
        });
    }
});

describe('a community that does not say membersOnDemand', () => {
    it('gets exactly the requests it got before: the same with no profile, a local profile, or the switch off', async () => {
        const runs: string[][] = [];
        for (const profile of ['none', 'local', 'off'] as const) {
            store.clear();
            store.set('beanpool_anchor_url', A_URL);
            resetSyncFingerprints();
            for (const t of ['posts', 'members', 'marketplace_transactions']) sql.exec(`DELETE FROM ${t}`);
            if (profile === 'local') onDemandProfile(undefined);
            if (profile === 'off') onDemandProfile(false);
            partners(5);
            node.requests = [];
            await performSync();
            await performSync();
            runs.push(node.requests.map(r => r.replace(/updatedAfter=[^&]+/, 'updatedAfter=<cursor>')));
        }
        expect(runs[1]).toEqual(runs[0]);
        expect(runs[2]).toEqual(runs[0]);
        // The whole directory first, then the members delta; never a keys read.
        const members = runs[0].filter(r => new URL(r).pathname === '/api/members');
        expect(members[0]).toBe(`${A_URL}/api/members`);
        expect(members.some(r => r.includes('keys='))).toBe(false);
        expect(held().length).toBe(2001);
    });
});
