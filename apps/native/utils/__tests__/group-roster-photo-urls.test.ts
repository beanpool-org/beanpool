/**
 * A group's faces, and an enterprise's, come from the node's URL for each photo (#1478).
 *
 * The node sends each photo in a roster, a group's card, the invite landing and the enterprises' list as its URL,
 * relative to the node (`/api/avatar/<key>?size=thumb&v=<version>`, and on the global node `&k=<member-only key>`), as
 * it sends the member list's since #1475: never the photo, which ran the node out of memory at one big group. The phone
 * takes each field as the node sends it (utils/db.ts), and MemberAvatar draws it through avatarUri, which puts the
 * phone's node in front of a relative URL and keeps its version and key. A shipped picture stays its `bundled://` name.
 *
 * The URLs here are made by the node's own maker (@beanpool/core avatarUrlOf) with a key installed, as the global node
 * installs one at boot. Nothing contacts a node: fetch is a stub that answers as the node does.
 */
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import { avatarUrlOf, configureAvatarKeys } from '@beanpool/core';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://faces.example' : null)),
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

import { fetchGroupDetails, getGroupForLanding, getGroupActiveMembers, getTreasuries } from '../db';
import { avatarUri } from '../image-processing';

const NODE = 'https://faces.example';
const KEY = 'AbCdEfGhIjKlMnOpQrSt_-';
const LEAD = 'a'.repeat(64), MEMBER = 'b'.repeat(64), SHIPPED = 'c'.repeat(64), NONE = 'd'.repeat(64), SHOP = 'e'.repeat(64);

// Installed before the describes below make their URLs, as the global node installs it at boot.
configureAvatarKeys(() => KEY);
afterAll(() => configureAvatarKeys(null));

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

/** The node's answers, by path. */
function serve(answers: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
        const path = url.replace(NODE, '');
        if (!(path in answers)) return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
        return { ok: true, status: 200, json: async () => answers[path] };
    });
}

/** What MemberAvatar asks expo-image for, given a row's photo field and no profile time (a roster row has none). */
const drawn = (avatarUrl: string | undefined, pubkey: string) => avatarUri(avatarUrl, pubkey, undefined, NODE);

describe("a group's faces come from the node's photo URLs", () => {
    const leadUrl = avatarUrlOf(LEAD, '1a2b3c4d')!;
    const memberUrl = avatarUrlOf(MEMBER, '5e6f7a8b')!;
    const roster = [
        { groupId: 'g1', memberPubkey: LEAD, callsign: 'Lena', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z', avatarUrl: leadUrl },
        { groupId: 'g1', memberPubkey: MEMBER, callsign: 'Mo', role: 'member', status: 'active', joinedAt: '2026-01-02T00:00:00.000Z', avatarUrl: memberUrl },
        { groupId: 'g1', memberPubkey: SHIPPED, callsign: 'Sam', role: 'member', status: 'active', joinedAt: '2026-01-03T00:00:00.000Z', avatarUrl: 'bundled://leaf' },
        { groupId: 'g1', memberPubkey: NONE, callsign: 'Nell', role: 'member', status: 'active', joinedAt: '2026-01-04T00:00:00.000Z' },
    ];
    const card = {
        id: 'g1', name: 'Faces', slug: 'faces', category: 'social', joinPolicy: 'invite_only', memberCount: 4,
        convenorPubkey: LEAD, convenorCallsign: 'Lena', convenorAvatarUrl: leadUrl,
        viewerStatus: 'invited', viewerInvitedBy: { pubkey: LEAD, callsign: 'Lena', avatarUrl: leadUrl },
    };

    it('the node makes the URL the phone is given: relative, versioned, keyed', () => {
        expect(leadUrl).toBe(`/api/avatar/${LEAD}?size=thumb&v=1a2b3c4d&k=${KEY}`);
    });

    it("the roster's rows keep each photo's URL, and each is drawn from the phone's node with its version and key", async () => {
        serve({ '/api/groups/g1': card, '/api/groups/g1/members': roster });
        const details = await fetchGroupDetails('g1');
        expect(details?.members.map(m => m.avatarUrl)).toEqual([leadUrl, memberUrl, 'bundled://leaf', undefined]);

        const lead = new URL(drawn(details!.members[0].avatarUrl ?? undefined, LEAD)!);
        expect(`${lead.origin}${lead.pathname}`).toBe(`${NODE}/api/avatar/${LEAD}`);
        expect(lead.searchParams.get('size')).toBe('thumb');
        expect(lead.searchParams.get('v')).toBe('1a2b3c4d');
        expect(lead.searchParams.get('k')).toBe(KEY);
        expect(drawn(details!.members[1].avatarUrl ?? undefined, MEMBER)).toBe(`${NODE}${memberUrl}&_v=${MEMBER.slice(0, 8)}`);
        // A shipped picture stays its name (MemberAvatar draws the app's own file); no photo, no image (the initial).
        expect(drawn(details!.members[2].avatarUrl ?? undefined, SHIPPED)).toBe('bundled://leaf');
        expect(drawn(details!.members[3].avatarUrl ?? undefined, NONE)).toBeNull();
    });

    it("the invite landing's inviter and its row of faces are drawn the same way", async () => {
        serve({ '/api/groups/g1': card, '/api/groups/g1/members?status=active': roster });
        const landing = await getGroupForLanding('g1');
        expect(landing?.viewerInvitedBy?.avatarUrl).toBe(leadUrl);
        expect(drawn(landing!.viewerInvitedBy!.avatarUrl, LEAD)).toBe(`${NODE}${leadUrl}&_v=${LEAD.slice(0, 8)}`);
        const faces = await getGroupActiveMembers('g1');
        expect(faces.map(f => drawn(f.avatarUrl ?? undefined, f.memberPubkey))).toEqual([
            `${NODE}${leadUrl}&_v=${LEAD.slice(0, 8)}`, `${NODE}${memberUrl}&_v=${MEMBER.slice(0, 8)}`, 'bundled://leaf', null,
        ]);
    });

    it("still draws a photo an older node sends inline", () => {
        const inline = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
        expect(drawn(inline, LEAD)).toBe(inline);
    });
});

describe("an enterprise's face comes from the node's photo URL", () => {
    it("the enterprises' list gives its URL, and the card draws it from the phone's node (MemberAvatar)", async () => {
        const shopUrl = avatarUrlOf(SHOP, '9c8d7e6f')!;
        serve({ '/api/treasuries': { treasuries: [{ publicKey: SHOP, name: 'Shop', callsign: 'Shop', avatar: shopUrl, avatarUrl: shopUrl }] } });
        const [shop] = await getTreasuries();
        expect(shop.avatar).toBe(shopUrl);
        expect(shop.avatarUrl).toBe(shopUrl);
        expect(drawn(shop.avatar ?? undefined, SHOP)).toBe(`${NODE}${shopUrl}&_v=${SHOP.slice(0, 8)}`);
    });
});
