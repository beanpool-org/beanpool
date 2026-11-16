/**
 * The visitors' forum on the phone reads the node's own answer (slice F7, the apps' part): `forumPublic`, as GET
 * /api/community/info carries it on the worldwide community, is kept by readNodeProfile and its cache, so visitorForumHere
 * (the Forum tab in Chat's place, Home's "From the forum", a public page's Open in the app) says yes to a visitor there.
 *
 * The owed walk on the API 26 emulator (16 Nov 2026) found the phone dropping it: readNodeProfile keeps only the switches
 * it names, `forumPublic` was not one, and a visitor on the worldwide community saw Chat in the tab bar, never Forum. The
 * screens' own suites stub visitorForumHere, so nothing ran the node's answer through the phone's read before this.
 *
 * One table over what the node says (public, members only, a private preview, a forum switched off, not a boolean, no
 * answer) x who reads (a visitor there, a member there, a visitor on another community), through the phone's own fetch,
 * cache and check. Nothing here contacts a node: every answer comes from a fetch stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_COMMUNITY_URL, forumPublicOn } from '@beanpool/core';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => store.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    },
}));

const WORLDWIDE = DEFAULT_GLOBAL_COMMUNITY_URL;
const ELSEWHERE = 'https://riverside.example.org';
/** The community in use (node-post.ts anchorUrl) and whether the phone visits it as a guest (nodes.ts isGuestNode). */
const here = vi.hoisted(() => ({ anchor: null as string | null, guestAt: [] as string[] }));
vi.mock('../node-post', () => ({ anchorUrl: async () => here.anchor }));
vi.mock('../nodes', () => ({ isGuestNode: async (url: string) => here.guestAt.includes(url) }));

import { effectiveFeatures, fetchNodeProfile, getCachedNodeProfile, readNodeProfile } from '../node-profile';
import { visitorForumHere } from '../forum-public';

/** The worldwide community's answer, in the server's shape (routes/community.ts, config/node-profile.ts publicFeatures). */
const info = (features: Record<string, unknown>, profile: 'global' | 'local' = 'global') => ({
    memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0,
    currency: { type: 'image', value: 'bean' },
    profile,
    features: { beans: false, openJoin: true, guestListingsOnly: true, door: 'open', ...features },
});

function answering(byBase: Record<string, unknown | 'offline'>) {
    return vi.fn(async (input: unknown) => {
        const url = String(input);
        const base = Object.keys(byBase).find((b) => url === `${b}/api/community/info`);
        const body = base ? byBase[base] : 'offline';
        if (body === 'offline') throw new TypeError(`Network request failed: ${url}`);
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    });
}

beforeEach(() => {
    store.clear();
    here.anchor = null;
    here.guestAt = [];
});

describe('readNodeProfile keeps forumPublic', () => {
    it('as the worldwide community says it', () => {
        const p = readNodeProfile(info({ forum: true, forumPublic: true }))!;
        expect(p.features.forumPublic).toBe(true);
        expect(forumPublicOn(p.features)).toBe(true);
    });

    it('only as a boolean', () => {
        expect(readNodeProfile(info({ forum: true, forumPublic: 'true' }))!.features.forumPublic).toBeUndefined();
        expect(readNodeProfile(info({ forum: true, forumPublic: 1 }))!.features.forumPublic).toBeUndefined();
        expect(readNodeProfile(info({ forum: true }))!.features.forumPublic).toBeUndefined();
    });

    it("in the reader's set too: the node's stands when a member's answer says nothing of it, and the member's when it does", () => {
        const node = readNodeProfile(info({ forum: true, forumPublic: true }))!.features;
        expect(effectiveFeatures(node, { forum: true }).forumPublic).toBe(true);
        expect(effectiveFeatures(node, { forum: true, forumPublic: false }).forumPublic).toBe(false);
    });
});

// What the node says x who reads: whether the phone shows the visitors' forum. Each row runs the phone's own fetch, its
// cache and the check the tab bar, Home and the links ask.
const SAYS: Record<string, unknown | 'offline'> = {
    'public': info({ forum: true, forumPublic: true }),
    'members only (no forumPublic)': info({ forum: true }),
    'a private preview (the server drops forumPublic)': info({ forum: true, privatePreview: true, openJoin: false }),
    'the forum switched off': info({ forum: false, forumPublic: true }),
    'forumPublic not a boolean': info({ forum: true, forumPublic: 'yes' }),
    'no answer': 'offline',
};
const READERS = {
    'a visitor there': { anchor: WORLDWIDE, guestAt: [WORLDWIDE] },
    'a member there': { anchor: WORLDWIDE, guestAt: [] as string[] },
    'a visitor on another community': { anchor: ELSEWHERE, guestAt: [ELSEWHERE] },
    'no community in use': { anchor: null, guestAt: [] as string[] },
};
const SHOWS = (says: string, reader: string) => says === 'public' && reader === 'a visitor there';

describe('the visitors\' forum, from the node\'s own answer', () => {
    for (const says of Object.keys(SAYS)) {
        for (const [reader, setup] of Object.entries(READERS)) {
            it(`${says} x ${reader}: ${SHOWS(says, reader) ? 'shown' : 'not shown'}`, async () => {
                // The other community says nothing of a public forum, as a local community's answer doesn't.
                const fetchImpl = answering({ [WORLDWIDE]: SAYS[says], [ELSEWHERE]: info({ forum: true }, 'local') });
                await fetchNodeProfile(WORLDWIDE, fetchImpl as unknown as typeof fetch);
                await fetchNodeProfile(ELSEWHERE, fetchImpl as unknown as typeof fetch);
                here.anchor = setup.anchor;
                here.guestAt = setup.guestAt;
                expect(await visitorForumHere()).toBe(SHOWS(says, reader));
                if (says === 'public') expect((await getCachedNodeProfile(WORLDWIDE))?.features.forumPublic).toBe(true);
            });
        }
    }
});
