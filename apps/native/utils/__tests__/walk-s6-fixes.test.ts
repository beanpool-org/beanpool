/**
 * The walk of S6 and Learn pictures on an Android 8 phone at 320 dp with 1.3× text (scratch/walks/RESULT-walk-s6.md, 23 Nov
 * 2026), each finding a row that fails without its fix:
 * - 1e: Chat's "{n} new messages in {community} · Switch" line counted a group's line the phone opens in place. It now
 *   counts only what can't be opened here: a community's number less every in-place chat's own (held-groups.ts
 *   noticesBesideHeldChats), its direct chats' among them (held-chats.ts heldChatShares).
 * - A "! not delivered" line in a locked group was gone at the next relaunch: it is kept (utils/group-unsent.ts).
 * - The group chat box's placeholder wrapped and was cut, and Chat's search box read "Search ch" (utils/words-that-fit.ts).
 * - "🫘 Thank Ben" began with a missing-glyph box on Android 8 (utils/glyphs-here.ts).
 * - The Learn page's last lines ran under the navigation bar (components/learn/KnowledgeDetail.tsx).
 * The rows that draw them, light and dark, are in learn-thank-render.test.ts and group-in-place-render.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 26 } }));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], isUserBlocked: async () => false }));
// The mutes this phone last heard of (db.ts getKnownChatMute): one direct chat muted for good.
vi.mock('../db', () => ({ getKnownChatMute: (id: string) => (id === 'd-muted' ? { conversationId: id, mutedUntil: null, always: true } : null) }));

import { setLanguage } from '@beanpool/core';
import { noticesBesideHeldChats, heldGroupShares, type HeldGroup, type InPlaceShare } from '../held-groups';
import { heldChatShares, type HeldChatRow, type HeldRowFill } from '../held-chats';
import { groupComposerPlaceholder, textWidthDp, wordsThatFit } from '../words-that-fit';
import { withGlyphsThisPhoneHas, BEANS_EMOJI_API } from '../glyphs-here';
import { keepUnsent, readUnsent, unsentWithCarried, UNSENT_MAX_A_CHAT, type UnsentLine } from '../group-unsent';
import { GROUP_UNSENT_STORE_PREFIX, groupUnsentStoreKey, PER_FILE_STORE_KEYS } from '../storage-keys';

const A = 'https://riverside.example';
const C = 'https://brookside.example';
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('1e: the "· Switch" line counts only what can\'t be opened here', () => {
    const notice = (count: number, alerts?: number) => ({ url: A, name: 'Riverside Walk', count, ...(alerts === undefined ? {} : { alerts }) });
    const dm = (id: string, community = A, type = 'dm'): HeldChatRow => ({ id, type, key: `held:${id}`, held: true, community, communityName: 'Riverside Walk' } as unknown as HeldChatRow);
    const fill = (unread: number): HeldRowFill => ({ unread, lastMessage: null, lastMessageFromApp: false });
    const group = (unread: number, over: Partial<HeldGroup> = {}): HeldGroup => ({ kind: 'group', conversationId: 'g1', unreadCount: unread, mute: null, community: A, ...over } as unknown as HeldGroup);
    const lineWith = (n: ReturnType<typeof notice>, shares: InPlaceShare[]) => noticesBesideHeldChats([n], shares).map((x) => x.count);

    type Row = [string, ReturnType<typeof notice>, HeldGroup[], number[], { rows: HeldChatRow[]; fill: Array<[string, number]> }?];
    const rows: Row[] = [
        // The walk: B said 1 unread for Ana, the one line in G1, a group the phone opens in place.
        ['the walk: one group line, on its row (a push told of it)', notice(1, 1), [group(1)], []],
        ['a group\'s line and a direct chat\'s, both on their rows', notice(2, 2), [group(1)], [], { rows: [dm('d1')], fill: [['held:d1', 1]] }],
        ['a direct chat held here, its two lines on its row', notice(2, 2), [], [], { rows: [dm('d1')], fill: [['held:d1', 2]] }],
        ['a direct chat whose row hasn\'t had its count read yet: counted', notice(2, 2), [], [2], { rows: [dm('d1')], fill: [] }],
        ['a chat that is no direct chat (it moves the phone): counted', notice(2, 2), [], [2], { rows: [dm('t1', A, 'transaction')], fill: [['held:t1', 2]] }],
        ['another community\'s direct chat: counted', notice(2, 2), [], [2], { rows: [dm('d1', C)], fill: [['held:d1', 2]] }],
        ['an enterprise\'s line (no row here) beside a group\'s', notice(2, 2), [group(1)], [1]],
        ['a muted group\'s line (no push), and one a push told of that has no row', notice(2, 1), [group(1, { mute: { conversationId: 'g1', mutedUntil: null, always: true } })], [1]],
    ];
    it.each(rows)('%s', (_n, n, groups, want, dms) => {
        const shares = [...heldChatShares(dms?.rows ?? [], new Map((dms?.fill ?? []).map(([k, u]) => [k, fill(u)]))), ...heldGroupShares(groups)];
        expect(lineWith(n, shares)).toEqual(want);
    });

    it('a direct chat muted as this phone last heard it: its lines are no push\'s; one not muted: every line is', () => {
        const shares = heldChatShares([dm('d-muted'), dm('d1')], new Map([['held:d-muted', fill(3)], ['held:d1', fill(2)]]), new Date('2026-11-23T00:00:00Z'));
        expect(shares).toEqual([{ community: A, lines: 3, pushed: 0 }, { community: A, lines: 2, pushed: 2 }]);
        // Its 3 lines and 1 a push told of elsewhere: the line says the 1.
        expect(lineWith(notice(5, 2), shares)).toEqual([]);
        expect(lineWith(notice(6, 3), shares)).toEqual([1]);
    });

    it('Chat draws the line from every in-place share (the wiring)', () => {
        const chats = read('app/(tabs)/chats.tsx');
        expect(chats).toContain('...heldChatShares(heldChats, heldFilled), ...heldGroupShares(groupsHeld)');
        expect(chats).toContain('noticesBesideHeldChats(noticesElsewhere, inPlaceShares)');
        // A group's chat in place takes its lines off once its server took the read, as an event's does.
        expect(read('components/GroupChatView.tsx')).toContain('.then(() => (at ? heldGroups.at(at).readThere(id) : row.markRead(id)))');
    });
});

describe('placeholders on one line at 320 dp with 1.3× text', () => {
    setLanguage('en');
    const at = (width: number, fontScale: number, photoButton = false) => ({ width, fontScale, photoButton });
    it.each([
        ['the walk: River Clean-up at 320 × 1.3', 'River Clean-up', at(320, 1.3), 'Message…'],
        ['Boat Ramp Roster at 320 × 1.3', 'Boat Ramp Roster', at(320, 1.3), 'Message…'],
        ['a short name at 320 × 1.3', 'Bees', at(320, 1.3), 'Message Bees…'],
        ['River Clean-up at 320 × 1.0', 'River Clean-up', at(320, 1), 'Message the group…'],
        ['River Clean-up at 411 × 1.0', 'River Clean-up', at(411, 1), 'Message River Clean-up…'],
        ['beside the photo button at 320 × 1.3', 'River Clean-up', at(320, 1.3, true), 'Message…'],
        ['a short name beside the photo button at 320 × 1.3', 'Bees', at(320, 1.3, true), 'Message Bees…'],
    ] as const)('%s', (_n, name, screen, want) => {
        const words = groupComposerPlaceholder(name, 'group', screen);
        expect(words).toBe(want);
        // On one line: what was chosen fits the box (Message… always does).
        const room = screen.width - (12 * 2 + 40 + 8 + 16 * 2 + 2) - (screen.photoButton ? 40 : 0);
        expect(textWidthDp(words, 16, screen.fontScale)).toBeLessThanOrEqual(room);
    });

    it('an enterprise\'s chat: its name or "Message…", never "the group"', () => {
        expect(groupComposerPlaceholder('The Long Valley Bakery Co-operative', 'enterprise', at(320, 1.3))).toBe('Message…');
    });

    it('Chat\'s search box: the long words only where they fit its own width; "Search" before it is laid out', () => {
        const long = 'Search chats, posts, partners...';
        // The walk: the box's text is about 86 dp wide at 320 dp (three 42 dp buttons beside it).
        expect(wordsThatFit([long, 'Search'], 86, 15, 1.3)).toBe('Search');
        expect(wordsThatFit([long, 'Search'], 0, 15, 1.3)).toBe('Search');
        expect(wordsThatFit([long, 'Search'], 400, 15, 1)).toBe(long);
        expect(textWidthDp('Search', 15, 1.3)).toBeLessThanOrEqual(86);
    });

    it('the screens use them (the wiring)', () => {
        expect(read('components/GroupChatView.tsx')).toContain('placeholder={groupComposerPlaceholder(name, kind, { width: windowWidth, fontScale, photoButton: !!photoButton })}');
        expect(read('app/(tabs)/chats.tsx')).toContain("placeholder={wordsThatFit([t('Search chats, posts, partners...'), t('Search')], searchRoom, SEARCH_FONT_SP, fontScale)}");
    });
});

describe('🫘 on a phone whose font has no picture for it', () => {
    it.each([
        ['Android 8', { os: 'android', api: 26 }, '🫘 Thank Ben', 'Thank Ben'],
        ['Android 12', { os: 'android', api: 32 }, '🫘 Thank Sol', 'Thank Sol'],
        ['the emoji at the end (a right-to-left language\'s order)', { os: 'android', api: 26 }, 'Ben شكرًا 🫘', 'Ben شكرًا'],
        ['Android 13 draws it', { os: 'android', api: BEANS_EMOJI_API }, '🫘 Thank Ben', '🫘 Thank Ben'],
        ['an iPhone draws it', { os: 'ios', api: 15 }, '🫘 Thank Ben', '🫘 Thank Ben'],
        ['no 🫘: as they are', { os: 'android', api: 26 }, 'Thank  Ben', 'Thank  Ben'],
    ] as const)('%s', (_n, phone, words, want) => {
        expect(withGlyphsThisPhoneHas(words, phone)).toBe(want);
    });

    it('this phone (Android 8 here): read from Platform', () => {
        expect(withGlyphsThisPhoneHas('🫘 Thank Ben')).toBe('Thank Ben');
    });
});

describe('a group line never sent is kept across a relaunch (utils/group-unsent.ts)', () => {
    const store = () => {
        const m = new Map<string, string>();
        return { m, getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); }, removeItem: async (k: string) => { m.delete(k); } };
    };
    const line = (n: number): UnsentLine => ({ clientId: `c-${n}`, text: `line ${n}`, replyToId: null, timestamp: `2026-11-23T00:00:0${n % 10}.000Z` });
    const ME = 'Ab'.padEnd(64, '0');

    it('kept by account, community file and chat; read back after a relaunch; gone once none is left', async () => {
        const s = store();
        await keepUnsent(s, ME, 'community_a.db', 'g2', [line(1)]);
        await keepUnsent(s, ME, 'community_a.db', 'g1', [line(2)]);
        expect(await readUnsent(s, ME, 'community_a.db', 'g2')).toEqual([line(1)]);
        expect(await readUnsent(s, ME, 'community_b.db', 'g2'), 'another community\'s file').toEqual([]);
        expect(await readUnsent(s, 'other'.padEnd(64, '0'), 'community_a.db', 'g2'), 'another account').toEqual([]);
        expect([...s.m.keys()]).toEqual([groupUnsentStoreKey(ME, 'community_a.db')]);
        expect(groupUnsentStoreKey(ME, 'community_a.db').startsWith(GROUP_UNSENT_STORE_PREFIX)).toBe(true);
        await keepUnsent(s, ME, 'community_a.db', 'g2', []);
        await keepUnsent(s, ME, 'community_a.db', 'g1', []);
        expect(s.m.size).toBe(0);
    });

    it('a line\'s `after` (the node\'s time of the newest line shown as it was written) is kept and read back; one of any other type is none', async () => {
        const s = store();
        await keepUnsent(s, ME, 'f.db', 'g1', [{ ...line(1), after: '2026-11-22T10:00:00.000Z' }, { ...line(2), after: '' }, line(3)]);
        expect(await readUnsent(s, ME, 'f.db', 'g1')).toEqual([{ ...line(1), after: '2026-11-22T10:00:00.000Z' }, { ...line(2), after: '' }, line(3)]);
        s.m.set(groupUnsentStoreKey(ME, 'f.db'), JSON.stringify({ g1: [{ ...line(4), after: 7 }] }));
        expect(await readUnsent(s, ME, 'f.db', 'g1')).toEqual([line(4)]);
    });

    it('the newest only, past the limit; a chat id of any other shape, or a value that can\'t be read, keeps and reads nothing', async () => {
        const s = store();
        const many = Array.from({ length: UNSENT_MAX_A_CHAT + 5 }, (_x, i) => line(i));
        await keepUnsent(s, ME, 'f.db', 'g1', many);
        expect((await readUnsent(s, ME, 'f.db', 'g1')).map((l) => l.clientId)).toEqual(many.slice(-UNSENT_MAX_A_CHAT).map((l) => l.clientId));
        for (const id of ['g/../1', 'a b', '']) {
            await keepUnsent(s, ME, 'f.db', id, [line(1)]);
            expect(await readUnsent(s, ME, 'f.db', id), JSON.stringify(id)).toEqual([]);
        }
        // An id that names an object's own field elsewhere is a plain key here (kept in a Map, written as JSON).
        await keepUnsent(s, ME, 'h.db', '__proto__', [line(1)]);
        expect([await readUnsent(s, ME, 'h.db', '__proto__'), ({} as any).clientId]).toEqual([[line(1)], undefined]);
        s.m.set(groupUnsentStoreKey(ME, 'g.db'), '{not json');
        expect(await readUnsent(s, ME, 'g.db', 'g1')).toEqual([]);
    });

    it('a community followed to a new address brings them, each once; it goes with the account (the wiring)', () => {
        const here = JSON.stringify({ g1: [line(1)] });
        const carried = JSON.stringify({ g1: [line(1), line(2)], g2: [line(3)] });
        expect(JSON.parse(unsentWithCarried(here, carried)!)).toEqual({ g1: [line(1), line(2)], g2: [line(3)] });
        expect(unsentWithCarried(JSON.stringify({ g1: [line(1)] }), JSON.stringify({ g1: [line(1)] }))).toBeNull();
        expect(PER_FILE_STORE_KEYS).toContain(groupUnsentStoreKey);
        expect(read('utils/community-copy-carry.ts')).toContain('[groupUnsentStoreKey, (here, carried) => unsentWithCarried(here, carried)]');
        expect(read('utils/identity.ts')).toContain('|| k.startsWith(GROUP_UNSENT_STORE_PREFIX));');
    });
});
