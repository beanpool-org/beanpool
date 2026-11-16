/**
 * What the phone keeps of "Beside my name on the worldwide forum" (slice F10 apps, fix round 2; utils/forum-label.ts), over
 * stand-ins for the forum, the member's community and the phone's storage, with the real community index:
 *
 * - A community whose record has no server key yet (S4 fills it only from a proved read of the address in use) is, once
 *   picked here, the one the forum names on every LATER visit too: `otherCommunities` gives it the forum's key, so Settings
 *   ticks it once and never draws it twice (#3271 review 4590770190).
 * - Its note is renewed in its last week, at the address the phone uses for that community now, though no record carries
 *   the key: the forum's key is kept beside the record it is kept under.
 * - Kept for one key only: another account on the phone reads nothing of it. "Don't show" lets it go.
 *
 * Each "visit" is a fresh load of the module (a new app run), so nothing carries over in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBERSHIP_NOTE_MAX_MS, signMembershipNote } from '@beanpool/core';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
const me = vi.hoisted(() => ({ publicKey: 'a'.repeat(64) }));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: me.publicKey, privateKey: 'b'.repeat(64) })) }));
const saved = vi.hoisted(() => ({ nodes: [] as Array<{ url: string; nodeName: string }> }));
vi.mock('../nodes', () => ({ getSavedNodes: vi.fn(async () => saved.nodes) }));
vi.mock('../community-name', () => ({ communityName: (n: { nodeName?: string; url: string }) => n.nodeName ?? n.url }));
const forum = vi.hoisted(() => ({ state: null as unknown, posted: [] as unknown[], asked: [] as string[], note: null as unknown }));
vi.mock('../db', () => ({
    signedRequestWithMethod: vi.fn(async (method: string, _path: string, body?: unknown) => {
        if (method === 'POST') {
            forum.posted.push(body);
            const b = body as { show: string; note?: { community: string; name: string; expiresAt: number } };
            forum.state = b.note
                ? { show: 'community', community: { key: b.note.community, name: b.note.name }, lapsesAt: new Date(b.note.expiresAt).toISOString(), label: { kind: 'community', community: b.note.name }, why: null }
                : { show: b.show, community: null, lapsesAt: null, label: b.show === 'waiting' ? { kind: 'waiting' } : null, why: null };
        }
        return forum.state;
    }),
}));
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async (address: string) => {
        forum.asked.push(address);
        return { status: 200, json: async () => ({ note: forum.note }) };
    }),
}));

const HILLSIDE = 'https://hillside.example';
const HILLSIDE_NOW = 'https://hillside-new.example';
const WORLDWIDE = 'https://worldwide.example';
const HILLSIDE_KEY = '12D3KooWHi11sideKey111111111111111111111111111111';
const NOW = Date.now();

type Phone = typeof import('../forum-label');
type Index = typeof import('../community-index');

/** A new app run: the module and the community index loaded afresh, the index holding what this phone's records say. */
async function visit(records: (index: Index) => ReturnType<Index['makeCommunityRecord']>[]): Promise<Phone> {
    vi.resetModules();
    const index = await import('../community-index');
    index.resetCommunityIndexForTests();
    // Every saved community has its record: the one in front, and those the test names.
    index.setCommunityIndex([index.makeCommunityRecord(WORLDWIDE), ...records(index)]);
    return import('../forum-label');
}
/** Hillside's record as S4 leaves it before a proved read: no server key. */
const keyless = (index: Index) => [index.makeCommunityRecord(HILLSIDE)];

beforeEach(() => {
    mem.clear();
    mem.set('beanpool_anchor_url', WORLDWIDE);
    me.publicKey = 'a'.repeat(64);
    saved.nodes = [{ url: WORLDWIDE, nodeName: 'Worldwide' }, { url: HILLSIDE, nodeName: 'Hillside' }];
    forum.state = { show: 'none', community: null, lapsesAt: null, label: null, why: null };
    forum.posted = [];
    forum.asked = [];
    forum.note = signMembershipNote({ community: HILLSIDE_KEY, name: 'Hillside', member: me.publicKey, issuedAt: NOW, expiresAt: NOW + MEMBERSHIP_NOTE_MAX_MS }, () => new Uint8Array(64).fill(7));
});
afterEach(() => vi.resetModules());

describe('the community picked here, kept for later visits', () => {
    it('a keyless community picked on one visit carries the forum\'s key on the next, so Settings ticks it once', async () => {
        const first = await visit(keyless);
        expect(await first.otherCommunities()).toEqual([{ address: HILLSIDE, name: 'Hillside', key: null }]);
        const done = await first.setForumLabel({ show: 'community', address: HILLSIDE });
        expect(done.ok).toBe(true);
        expect(forum.asked).toEqual([HILLSIDE]);

        const second = await visit(keyless);
        expect(await second.otherCommunities()).toEqual([{ address: HILLSIDE, name: 'Hillside', key: HILLSIDE_KEY }]);
    });

    it('its note is renewed in its last week with no key on any record, at the address the phone uses for it now', async () => {
        await (await visit(keyless)).setForumLabel({ show: 'community', address: HILLSIDE });
        forum.asked = [];
        forum.posted = [];
        // A later visit: the note lapses in three days; S4 has moved the record to another of the community's addresses.
        forum.state = { ...(forum.state as object), lapsesAt: new Date(NOW + 3 * 86_400_000).toISOString() };
        const later = await visit((index) => [{ ...index.makeCommunityRecord(HILLSIDE), using: HILLSIDE_NOW, proved: { [HILLSIDE_NOW]: { at: 1 } } }]);
        await later.renewForumLabelOnce();
        expect(forum.asked).toEqual([HILLSIDE_NOW]);
        expect(forum.posted).toEqual([{ show: 'community', note: forum.note }]);
    });

    it('and once it has run out, the same', async () => {
        await (await visit(keyless)).setForumLabel({ show: 'community', address: HILLSIDE });
        forum.asked = [];
        forum.state = { ...(forum.state as object), lapsesAt: new Date(NOW - 86_400_000).toISOString(), label: null, why: 'expired' };
        await (await visit(keyless)).renewForumLabelOnce();
        expect(forum.asked).toEqual([HILLSIDE]);
    });

    it('another account on the phone reads nothing of it: no tick, no renewing', async () => {
        await (await visit(keyless)).setForumLabel({ show: 'community', address: HILLSIDE });
        forum.asked = [];
        forum.state = { ...(forum.state as object), lapsesAt: new Date(NOW + 86_400_000).toISOString() };
        me.publicKey = 'c'.repeat(64);
        const other = await visit(keyless);
        expect((await other.otherCommunities())[0].key).toBeNull();
        await other.renewForumLabelOnce();
        expect(forum.asked).toEqual([]);
    });

    it('"Don\'t show" lets it go', async () => {
        const phone = await visit(keyless);
        await phone.setForumLabel({ show: 'community', address: HILLSIDE });
        await phone.setForumLabel({ show: 'none' });
        expect((await (await visit(keyless)).otherCommunities())[0].key).toBeNull();
    });

    it('a record that proved its server key keeps that key, whatever was kept', async () => {
        await (await visit(keyless)).setForumLabel({ show: 'community', address: HILLSIDE });
        const proved = await visit((index) => [index.makeCommunityRecord(HILLSIDE, { peerId: '12D3KooWProvedKey22222222222222222222222222222222', communityId: 'c1', epoch: 1 })]);
        expect((await proved.otherCommunities())[0].key).toBe('12D3KooWProvedKey22222222222222222222222222222222');
    });
});
