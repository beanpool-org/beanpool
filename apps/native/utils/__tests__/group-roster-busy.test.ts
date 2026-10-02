/**
 * A roster the node is too busy to send is no roster, never an empty one (heavy-read cap, docs/global-heavy-lists.md
 * slice 1).
 *
 * Under a burst of heavy list reads the node answers a big group's roster 503 with Retry-After and
 * `code: heavy_read_busy` (apps/server/src/heavy-reads.ts). fetchGroupDetails used to turn any roster it couldn't read
 * into `[]`, and the group's screen and chat put that in place of the roster they showed: nobody in the group, every
 * member offered as invitable. Now it gives the card with `members: null`, and both keep what they had. Nothing contacts
 * a node: fetch is a stub that answers as the node does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://busy.example' : null)),
        setItem: vi.fn(async () => {}),
        removeItem: vi.fn(async () => {}),
        getAllKeys: vi.fn(async () => []),
    },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { randomUUID: () => 'test-uuid', getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: '/tmp/cache/' }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
vi.mock('../nodes', () => ({ getDatabaseFilenameForNode: vi.fn(), addSavedNode: vi.fn() }));
vi.mock('../canonical-profile', () => ({ getCanonicalProfile: vi.fn(), saveCanonicalProfile: vi.fn() }));

import { fetchGroupDetails } from '../db';

const NODE = 'https://busy.example';
const card = { id: 'g1', name: 'Everyone', slug: 'everyone', category: 'social', joinPolicy: 'open', memberCount: 30000 };
const roster = [{ groupId: 'g1', memberPubkey: 'a'.repeat(64), callsign: 'Lena', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' }];
const busy = { error: 'This community is busy right now. Please try again in a moment.', code: 'heavy_read_busy' };

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

/** The node's answers by path: [status, body]. */
function serve(answers: Record<string, [number, unknown]>) {
    fetchMock.mockImplementation(async (url: string) => {
        const [status, body] = answers[url.replace(NODE, '')] ?? [404, { error: 'Not found' }];
        return { ok: status >= 200 && status < 300, status, headers: new Headers(status === 503 ? { 'Retry-After': '15' } : {}), json: async () => body };
    });
}

describe('a roster the node is too busy to send', () => {
    it('comes back as no roster (null) beside the card, not as an empty one', async () => {
        serve({ '/api/groups/g1': [200, card], '/api/groups/g1/members': [503, busy] });
        const details = await fetchGroupDetails('g1');
        expect(details?.group).toEqual(card);
        expect(details?.members).toBeNull();
    });

    it('and a roster the node sends is the roster, as before', async () => {
        serve({ '/api/groups/g1': [200, card], '/api/groups/g1/members': [200, roster] });
        const details = await fetchGroupDetails('g1');
        expect(details?.members).toEqual(roster);
    });

    it('a card that could not be read is no details at all, as before', async () => {
        serve({ '/api/groups/g1': [502, { error: 'Bad gateway' }], '/api/groups/g1/members': [200, roster] });
        expect(await fetchGroupDetails('g1')).toBeNull();
    });
});
