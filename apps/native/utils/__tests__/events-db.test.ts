import { describe, it, expect, vi, beforeEach } from 'vitest';

// The phone's event plumbing in db.ts (docs/events-on-the-map.md slice 3): what the cache stores, who reads
// events out of it, and what an RSVP sends. Device modules are stubbed at the boundary as in apply-delta.test.ts.

const mockRunAsync = vi.fn().mockResolvedValue({ changes: 1 });
const mockGetAllAsync = vi.fn().mockResolvedValue([]);
const mockDb = {
    runAsync: mockRunAsync,
    execAsync: vi.fn().mockResolvedValue(undefined),
    getAllAsync: mockGetAllAsync,
    getFirstAsync: vi.fn().mockResolvedValue(null),
    closeAsync: vi.fn().mockResolvedValue(undefined),
    withTransactionAsync: vi.fn().mockImplementation(async (cb: () => Promise<void>) => { await cb(); }),
};

vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn().mockImplementation(() => Promise.resolve(mockDb)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k === 'beanpool_anchor_url' ? 'https://test.beanpool.org' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid', getRandomBytes: () => new Uint8Array(16) }));
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/tmp/cache/',
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => ({ publicKey: 'me-pub', privateKey: 'aa', callsign: 'Me' })),
}));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn().mockReturnValue('beanpool_test.db'), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));
vi.mock('../crypto', async (orig) => ({
    ...(await orig<any>()),
    buildSignedHeaders: vi.fn(async (method: string, path: string) => ({ 'X-Signed': `${method} ${path}` })),
    signData: vi.fn(async (msg: Uint8Array) => msg),
}));

import { applyDelta, getPosts, getMyPosts, getMemberPosts, rsvpEvent, fetchEventDetail } from '../db';
import { buildSignedHeaders, signData, decodeUtf8, decodeBase64 } from '../crypto';

const fetchMock = vi.fn();
function reply(status: number, body: any) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const serverEvent = {
    id: 'ev1', type: 'event', category: 'community', title: 'Working bee', description: '', credits: 0,
    authorPublicKey: 'host-pub', lat: -28.5, lng: 153.4, status: 'active', active: true,
    eventStartAt: '2026-09-26T23:00:00.000Z', eventEndAt: '2026-09-27T02:00:00.000Z',
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3,
};

beforeEach(() => {
    mockRunAsync.mockClear();
    mockGetAllAsync.mockReset().mockResolvedValue([]);
    fetchMock.mockReset();
    (buildSignedHeaders as any).mockClear();
    (globalThis as any).fetch = fetchMock;
});

describe('events in the local cache', () => {
    it('applyDelta stores the event columns and public counts, never the note or my RSVP', async () => {
        await applyDelta({ posts: [{ ...serverEvent, eventPrivateNote: 'Gate code 1234', myRsvp: 'going' }] });
        const call = mockRunAsync.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO posts'));
        expect(call).toBeTruthy();
        const [sql, params] = call!;
        expect(sql).toContain('event_start_at, event_end_at, event_place_name, event_state, event_going_count, event_interested_count)');
        expect((sql.match(/\?/g) || []).length).toBe(params.length);
        expect(params.slice(-6)).toEqual(['2026-09-26T23:00:00.000Z', '2026-09-27T02:00:00.000Z', 'Bindarrabi Hall', 'scheduled', 7, 3]);
        expect(params).not.toContain('Gate code 1234');
    });

    it('getPosts leaves events out unless the caller opts in, so the map tab and deals never see one', async () => {
        await getPosts();
        await getPosts({ type: 'offer' });
        await getPosts({ includeEvents: true });
        await getPosts({ type: 'event' });
        const postQueries = mockGetAllAsync.mock.calls
            .map(([sql]) => String(sql))
            .filter(sql => sql.includes('FROM posts p') && sql.includes('LEFT JOIN groups g'));
        expect(postQueries).toHaveLength(4);
        expect(postQueries[0]).toContain("p.type != 'event'");
        expect(postQueries[1]).toContain("p.type != 'event'");
        expect(postQueries[2]).not.toContain("p.type != 'event'");
        expect(postQueries[3]).not.toContain("p.type != 'event'");
    });

    it('getPosts puts my cached RSVP and the counts on an event row', async () => {
        mockGetAllAsync.mockImplementation(async (sql: string) => {
            if (sql.includes('FROM posts p')) return [{ id: 'ev1', type: 'event', status: 'active', event_going_count: 7, event_interested_count: 3 }];
            if (sql.includes('FROM event_rsvps')) return [{ post_id: 'ev1', status: 'interested' }];
            return [];
        });
        const [row] = await getPosts({ includeEvents: true });
        expect(row).toMatchObject({ goingCount: 7, interestedCount: 3, myRsvp: 'interested' });
    });

    it('My Posts (trade actions) does not list events', async () => {
        await getMyPosts('me-pub');
        const sql = mockGetAllAsync.mock.calls.map(([s]) => String(s)).find(s => s.includes('WHERE p.author_pubkey = ?'));
        expect(sql).toContain("p.type != 'event'");
    });
});

describe('rsvpEvent', () => {
    it('is a signed POST to the RSVP route with a signature over postId:status, and caches my status', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, post: { ...serverEvent, goingCount: 8, myRsvp: 'going' } }));
        const res = await rsvpEvent('ev1', 'going');
        expect(res.post.goingCount).toBe(8);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/marketplace/posts/ev1/rsvp');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.status).toBe('going');
        expect(body).not.toHaveProperty('memberPublicKey');
        // signData is stubbed to echo its message, so the signature decodes to what was signed.
        expect(decodeUtf8(decodeBase64(body.signature))).toBe('ev1:going');
        expect(signData).toHaveBeenCalled();
        expect(buildSignedHeaders).toHaveBeenCalledWith('POST', '/api/marketplace/posts/ev1/rsvp', init.body, 'aa', 'me-pub');

        const writes = mockRunAsync.mock.calls.map(([sql, p]) => [String(sql), p]);
        expect(writes.some(([sql]) => (sql as string).startsWith('UPDATE posts SET event_start_at'))).toBe(true);
        expect(writes.find(([sql]) => (sql as string).includes('INSERT OR REPLACE INTO event_rsvps'))?.[1]).toEqual(['ev1', 'me-pub', 'going', expect.any(String)]);
    });

    it('sends null for not going, signs "none" and clears my cached status', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, { success: true, post: { ...serverEvent, myRsvp: null } }));
        await rsvpEvent('ev1', null);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.status).toBeNull();
        expect(decodeUtf8(decodeBase64(body.signature))).toBe('ev1:none');
        expect(mockRunAsync.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM event_rsvps'))).toBe(true);
    });

    it("surfaces the node's refusal", async () => {
        fetchMock.mockResolvedValueOnce(reply(400, { error: 'This event has ended' }));
        await expect(rsvpEvent('ev1', 'going')).rejects.toThrow('This event has ended');
    });
});

describe('fetchEventDetail', () => {
    it('is a signed by-id read and returns the note without writing it to the cache', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, [{ ...serverEvent, eventPrivateNote: 'Gate code 1234', myRsvp: 'going', eventRsvps: [] }]));
        const v = await fetchEventDetail('ev1');
        expect(v.eventPrivateNote).toBe('Gate code 1234');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://test.beanpool.org/api/marketplace/posts?id=ev1');
        expect(init.headers).toMatchObject({ 'X-Signed': 'GET /api/marketplace/posts' });
        for (const [, params] of mockRunAsync.mock.calls) {
            expect(params ?? []).not.toContain('Gate code 1234');
        }
    });

    it('returns null for a post that is not an event', async () => {
        fetchMock.mockResolvedValueOnce(reply(200, [{ id: 'o1', type: 'offer' }]));
        expect(await fetchEventDetail('o1')).toBeNull();
    });
});

describe("a member's profile listings", () => {
    // From the slice 3 review: getMemberPosts selected every active post, so once the phone started caching
    // events the Listings tab rendered them as trade tiles — "EVENT", Need styling, "0" beans next to a bean
    // icon. The web profile never shows one (it asks the node with no `types=`, and events are opt-in there),
    // so the phone matches it: no events in Listings. A host page listing its events is not in v1 (§1, §5).
    it('leaves events out, so an event never renders as a zero-bean listing', async () => {
        await getMemberPosts('host-pub');
        const [sql, params] = mockGetAllAsync.mock.calls.at(-1)!;
        expect(String(sql)).toContain('FROM posts');
        expect(String(sql)).toContain("COALESCE(type, '') != 'event'");
        expect(params).toEqual(['host-pub']);
    });

    it('still returns the offers and needs the tab is for', async () => {
        mockGetAllAsync.mockResolvedValueOnce([
            { id: 'o1', type: 'offer', title: 'Spare tomatoes', credits: 5, photos: '["/api/marketplace/posts/o1/photos/0"]' },
        ]);
        const rows = await getMemberPosts('host-pub');
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('offer');
        expect(rows[0].photos[0]).toBe('https://test.beanpool.org/api/marketplace/posts/o1/photos/0');
    });
});
