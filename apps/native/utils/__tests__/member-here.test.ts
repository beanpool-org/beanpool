/**
 * "Member here" (addresses S5 round 2, PR #3251's deciding review, find-community.tsx:669): a directory row of one of this
 * phone's communities opens it only when the phone holds an ACCOUNT key that is a member there, as the community itself
 * answers (utils/member-here.ts). A record with a key is not membership: a guest visit's record gets its key from the first
 * proved round at its address. Guests, visitors and removed accounts keep the knock's doors: Ask to join, and Join when a
 * yes is waiting.
 *
 * The table: (viewer: an account member, a guest, a visitor, a removed account) x (row: the same community, another) x
 * (no request, a yes waiting) -> Open / Ask to join / Join. The community's answers are stand-ins; the records go into the
 * index as community-record.ts loads them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    communityRecordByKey, directoryRowCommunity, recordAddresses, resetCommunityIndexForTests, setCommunityIndex, type CommunityRecord,
} from '../community-index';
import { askMemberHere, directoryRowDoor, memberHere, type MemberHereDeps } from '../member-here';
import { knockCardState, type KnockStatusResult } from '../knock';

const list = (peerId: string, main: string, addresses: string[]) =>
    ({ list: { v: 1, peerId, communityId: `c-${peerId}`, epoch: 2, seq: 7, main, addresses, spares: [] }, sig: 'x' }) as unknown as CommunityRecord['list'];

/** The community in front. */
const RIVERSIDE: CommunityRecord = {
    v: 1, id: 'https://riverside.example', using: 'https://riverside.example', peerId: 'peer-r', epoch: 2,
    proved: { 'https://riverside.example': { at: 1 } }, refused: {}, list: list('peer-r', 'riverside.example', ['riverside.example']),
};
/** Another community on the phone, met at hilltop.example, now at hill.example.org: its record has a key from a proved round. */
const HILLTOP: CommunityRecord = {
    v: 1, id: 'https://hilltop.example', using: 'https://hill.example.org', peerId: 'peer-h', epoch: 1,
    proved: { 'https://hill.example.org': { at: 1 } }, refused: {}, list: list('peer-h', 'hill.example.org', ['hill.example.org', 'hilltop.example']),
};
const ANCHOR = RIVERSIDE.using;
const KEY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64) };

type Viewer = { key: typeof KEY | null; guestAt: string[]; answers: (url: string) => Response };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const VIEWERS: Record<string, Viewer> = {
    'an account member': { key: KEY, guestAt: [], answers: () => json(200, { isMember: true }) },
    // A guest visit (nodes.ts markGuestNode at the address it visited): the community would say "a stranger" too.
    'a guest (a record keyed by a proved round)': { key: KEY, guestAt: ['https://hilltop.example', 'https://riverside.example'], answers: () => json(200, { isMember: false }) },
    // Looking around with no account on the phone.
    'a visitor (no account on the phone)': { key: null, guestAt: [], answers: () => json(200, { isMember: true }) },
    // The community closed this key's account (403 account_closed): the record and its key are still on the phone.
    'a removed account': { key: KEY, guestAt: [], answers: () => json(403, { code: 'account_closed' }) },
};
const ROWS: Record<string, { key: string; url: string }> = {
    'the same community (another of the phone\'s, at an address it first met it at)': { key: 'peer-h', url: 'https://hilltop.example' },
    'another community': { key: 'peer-x', url: 'https://stranger.example' },
};
const YES: KnockStatusResult = { ok: true, value: { status: 'approved', invite: 'INVITE-1', expiresAt: null } };

/** What the row shows for this viewer: the member's Open, or the knock's own door (utils/knock.ts knockCardState). */
async function door(viewer: Viewer, row: { key: string; url: string }, knock: 'none' | 'yes'): Promise<string> {
    const asked: string[] = [];
    const deps: MemberHereDeps = {
        isGuestNode: async (url) => viewer.guestAt.includes(url),
        probe: async (url) => { asked.push(url); return viewer.answers(url); },
    };
    const record = communityRecordByKey(row.key);
    const member = record ? await askMemberHere({ using: record.using, addresses: recordAddresses(record) }, viewer.key, deps) : undefined;
    // Asked only at the address the phone uses for it, and never for a guest visit, a phone with no key, or a stranger's row.
    expect(asked).toEqual(record && viewer.key && !viewer.guestAt.length ? [record.using] : []);
    const shown = directoryRowDoor(directoryRowCommunity(row, ANCHOR), member);
    if (shown.kind === 'open') return 'Open';
    if (shown.kind === 'in-front') return 'You are already a member';
    const state = knockCardState(true, knock === 'yes', knock === 'yes' ? YES : undefined);
    return state.kind === 'invited' ? 'Join' : state.kind === 'ask' ? 'Ask to join' : state.kind;
}

afterEach(() => resetCommunityIndexForTests());

describe('S5 round 2: (viewer) x (row) -> Open / Ask to join / Join ("member here" is the account, never the record)', () => {
    for (const [viewerName, viewer] of Object.entries(VIEWERS)) {
        for (const [rowName, row] of Object.entries(ROWS)) {
            for (const knock of ['none', 'yes'] as const) {
                const member = viewerName === 'an account member' && rowName.startsWith('the same');
                const want = member ? 'Open' : knock === 'yes' ? 'Join' : 'Ask to join';
                it(`${viewerName} x ${rowName}${knock === 'yes' ? ', a yes waiting' : ''} -> ${want}`, async () => {
                    setCommunityIndex([RIVERSIDE, HILLTOP]);
                    expect(await door(viewer, row, knock)).toBe(want);
                });
            }
        }
    }

    it('the community in front during a guest visit: the knock, never the member line with no button', async () => {
        setCommunityIndex([RIVERSIDE, HILLTOP]);
        const row = { key: 'peer-r', url: 'https://riverside.example' };
        expect(await door(VIEWERS['a guest (a record keyed by a proved round)'], row, 'none')).toBe('Ask to join');
        expect(await door(VIEWERS['an account member'], row, 'none')).toBe('You are already a member');
    });

    it('no answer, or an answer that says nothing, is not membership: the row knocks, and a member\'s knock is answered by the community', async () => {
        setCommunityIndex([RIVERSIDE, HILLTOP]);
        const row = ROWS['the same community (another of the phone\'s, at an address it first met it at)'];
        const offline: Viewer = { key: KEY, guestAt: [], answers: () => { throw new Error('offline'); } };
        expect(await door(offline, row, 'none')).toBe('Ask to join');
        expect(await door({ key: KEY, guestAt: [], answers: () => json(401, { error: 'unsigned' }) }, row, 'none')).toBe('Ask to join');
        // Still being asked: the knock until the community answers.
        expect(directoryRowDoor(directoryRowCommunity(row, ANCHOR), undefined)).toEqual({ kind: 'knock' });
    });

    it('the rule itself: a key, no guest visit, and the community\'s own "a member"', () => {
        const member = { kind: 'member' } as const;
        expect(memberHere({ hasKey: true, guest: false, answer: member })).toBe(true);
        expect(memberHere({ hasKey: false, guest: false, answer: member })).toBe(false);
        expect(memberHere({ hasKey: true, guest: true, answer: member })).toBe(false);
        expect(memberHere({ hasKey: true, guest: false, answer: { kind: 'stranger', recovering: false } })).toBe(false);
        expect(memberHere({ hasKey: true, guest: false, answer: { kind: 'closed' } })).toBe(false);
        expect(memberHere({ hasKey: true, guest: false, answer: null })).toBe(false);
    });
});

describe('S5 round 2: the screens read the rule', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it('Find a community: a row opens only on the community\'s "a member", asked once per row key; every other row knocks', () => {
        const find = read('../../app/find-community.tsx');
        expect(find).toMatch(/const door = directoryRowDoor\(anchorNow === undefined \? null : directoryRowCommunity\(c, anchorNow\), memberAt\[c\.key\]\);\s*if \(door\.kind === 'knock'\) return renderKnock\(c\.url, c\.name, c\);/);
        expect(find).toMatch(/askMemberHere\(\{ using: record\.using, addresses: recordAddresses\(record\) \}, identity\)/);
        expect(find).toMatch(/if \(!record \|\| memberAsked\.current\.has\(c\.key\)\) continue;\s*memberAsked\.current\.add\(c\.key\);/);
        // No row says "already a member" from its record alone.
        expect(find).not.toMatch(/const mine = anchorNow === undefined \? null : directoryRowCommunity\(c, anchorNow\);\s*if \(!mine\) return renderKnock/);
    });

    it('a community\'s card: "your community" only for the community in front where the community says this key is a member', () => {
        const card = read('../../app/community-card.tsx');
        expect(card).toMatch(/if \(!anchor \|\| linkLanding\(origin, anchor\)\.kind !== 'in-use'\) return false;/);
        expect(card).toMatch(/return askMemberHere\(/);
        expect(card).toMatch(/\.then\(\(member\) => \{ if \(alive\) setMemberHere\(member\); \}\)/);
    });
});
