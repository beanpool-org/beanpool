/**
 * Addresses S5 (scratch/fable-design/DESIGN-several-addresses-fable.md §3.6): a link, a QR or a directory row for any address
 * of a community the phone has opens that community: no "Switch Nodes?" to the community in front, no second row, and the
 * phone goes to the address it uses for that community (its record's `using`), never the link's. A directory row whose key
 * is a community the phone has opens that community, whatever address the row carries. Pure: the records go into the
 * index here as community-record.ts loads them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    communityRecordByKey, communityRecordNaming, directoryRowCommunity, linkLanding, resetCommunityIndexForTests, setCommunityIndex, type CommunityRecord,
} from '../community-index';

const list = (peerId: string, main: string, addresses: string[]) =>
    ({ list: { v: 1, peerId, communityId: `c-${peerId}`, epoch: 2, seq: 7, main, addresses, spares: [] }, sig: 'x' }) as unknown as CommunityRecord['list'];

/** The community in front: met at riverside.example, now using coop.example.org (followed), ourtown proved, new listed. */
const RIVERSIDE: CommunityRecord = {
    v: 1, id: 'https://riverside.example', using: 'https://coop.example.org', peerId: 'peer-r', epoch: 2,
    proved: { 'https://coop.example.org': { at: 1 }, 'https://ourtown.example.net': { at: 1 } }, refused: {},
    list: list('peer-r', 'coop.example.org', ['coop.example.org', 'ourtown.example.net', 'new.example.net', 'riverside.example']),
};
/** Another community the phone keeps, on its second address. */
const HILLTOP: CommunityRecord = {
    v: 1, id: 'https://hilltop.example', using: 'https://hill.example.org', peerId: 'peer-h', epoch: 1,
    proved: { 'https://hill.example.org': { at: 1 } }, refused: { 'https://lapsed.example.com': { at: 1, why: 'status 421' } },
    list: list('peer-h', 'hill.example.org', ['hill.example.org', 'hilltop.example', 'spare.example.org']),
};
/** An older server: no key, no list. */
const LAKESIDE: CommunityRecord = { v: 1, id: 'https://lakeside.example', using: 'https://lakeside.example', proved: {}, refused: {} };

const ANCHOR = RIVERSIDE.using;

afterEach(() => resetCommunityIndexForTests());

describe('S5: where a link lands (the community in front, another kept, or new)', () => {
    const rows: Array<[string, string, ReturnType<typeof linkLanding>]> = [
        ['the address in use', 'https://coop.example.org', { kind: 'in-use' }],
        ['the address in use, another spelling', 'https://COOP.example.org/', { kind: 'in-use' }],
        ['another proved address of the community in front', 'https://ourtown.example.net', { kind: 'in-use' }],
        ['a listed address not yet proved', 'https://new.example.net', { kind: 'in-use' }],
        ['the address the phone first met it at', 'https://riverside.example', { kind: 'in-use' }],
        ['another kept community, at its address in use', 'https://hill.example.org', { kind: 'kept', using: 'https://hill.example.org' }],
        ['another kept community, at the address the phone first met it at', 'https://hilltop.example', { kind: 'kept', using: 'https://hill.example.org' }],
        ['another kept community, at a listed address it never proved', 'https://spare.example.org', { kind: 'kept', using: 'https://hill.example.org' }],
        // An address the community refused and no longer lists is not its: a link there is a stranger's, as today (§3.5's
        // words for a look-alike, which need the address asked first, are a later slice).
        ['another kept community, at an address it refused and no longer lists', 'https://lapsed.example.com', { kind: 'new' }],
        ['an older server kept on the phone (no key), at its address', 'https://lakeside.example', { kind: 'kept', using: 'https://lakeside.example' }],
        ['a stranger', 'https://stranger.example', { kind: 'new' }],
        ['plain http of a listed address (never how the phone reaches it)', 'http://new.example.net', { kind: 'new' }],
    ];
    for (const [name, address, lands] of rows) {
        it(`${name} -> ${lands.kind}${lands.kind === 'kept' ? ` at ${lands.using}` : ''}`, () => {
            setCommunityIndex([RIVERSIDE, HILLTOP, LAKESIDE]);
            expect(linkLanding(address, ANCHOR)).toEqual(lands);
        });
    }

    it('no records yet (or none hold it): the link\'s address itself is the community in front only string for string', () => {
        expect(linkLanding('https://coop.example.org', 'https://coop.example.org')).toEqual({ kind: 'in-use' });
        expect(linkLanding('https://ourtown.example.net', 'https://coop.example.org')).toEqual({ kind: 'new' });
    });

    it('a list kept under another key than the record\'s names nothing', () => {
        setCommunityIndex([{ ...RIVERSIDE, list: list('someone-else', 'coop.example.org', ['coop.example.org', 'new.example.net']) }]);
        expect(communityRecordNaming('https://new.example.net')).toBeNull();
    });
});

describe('S5: a directory row by its key', () => {
    it('the row\'s key is a community the phone has: that record, whatever address the row carries', () => {
        setCommunityIndex([RIVERSIDE, HILLTOP, LAKESIDE]);
        expect(communityRecordByKey('peer-h')?.id).toBe(HILLTOP.id);
        expect(communityRecordByKey('peer-r')?.using).toBe(ANCHOR);
        expect(communityRecordByKey('peer-x')).toBeNull();
        expect(communityRecordByKey(null)).toBeNull();
    });

    const rows: Array<[string, { key: string; url: string | null }, ReturnType<typeof directoryRowCommunity>]> = [
        ['the community in front, at its main', { key: 'peer-r', url: 'https://coop.example.org' }, { using: ANCHOR, inFront: true, askList: false }],
        ['the community in front, at an address its kept list lacks', { key: 'peer-r', url: 'https://moved.example.org' }, { using: ANCHOR, inFront: true, askList: true }],
        ['another kept community, at the address the phone first met it at', { key: 'peer-h', url: 'https://hilltop.example' }, { using: 'https://hill.example.org', inFront: false, askList: false }],
        ['another kept community, at an address its kept list lacks', { key: 'peer-h', url: 'https://stranger.example' }, { using: 'https://hill.example.org', inFront: false, askList: true }],
        ['another kept community, with no address on the row', { key: 'peer-h', url: null }, { using: 'https://hill.example.org', inFront: false, askList: false }],
        // The row's address alone never makes it the phone's: the key does.
        ['a stranger\'s key at the address of a kept community', { key: 'peer-x', url: 'https://hill.example.org' }, null],
    ];
    for (const [name, row, mine] of rows) {
        it(`${name} -> ${mine ? `opens it at ${mine.using}${mine.askList ? ', the newest list asked first' : ''}` : 'a stranger\'s row (Ask to join)'}`, () => {
            setCommunityIndex([RIVERSIDE, HILLTOP, LAKESIDE]);
            expect(directoryRowCommunity(row, ANCHOR)).toEqual(mine);
        });
    }
});

describe('S5: the app is wired to it', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it('an invite link: the community it names by any of its addresses, switched to through the one switch (no second row)', () => {
        const layout = read('../../app/_layout.tsx');
        expect(layout).toMatch(/const landing = extractedNodeOrigin \? linkLanding\(extractedNodeOrigin, current\) : null;/);
        expect(layout).toMatch(/const targetOrigin = landing\?\.kind === 'in-use' \? current : landing\?\.kind === 'kept' \? landing\.using : \(extractedNodeOrigin \|\| current\);/);
        // The link's switch is reconnect.ts switchPhoneTo (the one move lock), never a write of its own.
        expect(layout).not.toMatch(/setItem\('beanpool_anchor_url', targetOrigin\)/);
        expect(layout).toMatch(/switchPhoneTo\(targetOrigin\)/);
    });

    it('a directory row of a community the phone has: said so and opened through the one switch, never Ask to join', () => {
        const find = read('../../app/find-community.tsx');
        expect(find).toMatch(/const mine = anchorNow === undefined \? null : directoryRowCommunity\(c, anchorNow\);\s*if \(!mine\) return renderKnock\(c\.url, c\.name, c\);/);
        expect(find).toMatch(/if \(!mine\.inFront\) await switchCommunity\(mine\.using\);/);
        expect(find).toMatch(/if \(mine\.askList\) verifyAddressInUse\(\{ atOpen: true \}\)/);
        expect(find).toContain('{renderMineOrKnock(c)}');
    });

    it('a community card for any address of the community in front is "your community"', () => {
        expect(read('../../app/community-card.tsx')).toMatch(/setMemberHere\(linkLanding\(origin, anchor\)\.kind === 'in-use'\)/);
    });
});
