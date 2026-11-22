/**
 * Message on the web, one exhaustive table (#3354 review, round 4: every round had found one more chat Message opened that the
 * member could not write in, so the class is closed here; the phone's is apps/native message-target-table.test.ts): (the
 * contact's address: this community at its main, an older main, another of its names, a name it had before; a community the
 * phone may hold; another community) x (the chats there are: none, direct here, a request of theirs here, across open /
 * request / declined, across dead because its person is here) x (this account: a member here or a visitor; this community
 * taking messages from other communities or not) x (a block: this community's list, none) -> where Message goes, as Contacts
 * goes there (pages/MessagesPage.tsx messageAcross, lib/message-anyone.ts messageOnWeb). The web holds one community: a
 * held one is another community to it, and a block only on another community's list is never read here (no columns).
 *
 * The wanted targets are written out by hand (WANT). Every row that is not refused is also asked of SERVERS, a model of what
 * each server takes that shares no code with the rule: the chat it ends in must be one a line can go from now. A chat here
 * is the server's own to open (POST /api/messages/conversation): a visitor gets the one it has, and starts none.
 * Real: message-anyone, community-homes, outside-mail's list and card, core. Mutations are in the PR body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'e5'.repeat(32);
const K = 'a1'.repeat(32);
const K2 = 'c3'.repeat(32);
const HERE = 'https://riverside.example';
const FARAWAY = 'https://faraway.example';

interface Server { names: string[]; takesAcross: boolean; members: Set<string> }
type Chat = { id: string; peerKey: string; peerHome: string; peerName: string | null; state: 'open' | 'request' | 'declined' };
const web = vi.hoisted(() => ({
    across: new Map<string, any>(),
    blocked: [] as string[],
    /** The info this page read once, and what the community answers now (null: no answer). */
    kept: null as null | Record<string, unknown>,
    now: null as null | Record<string, unknown>,
    member: true as boolean | null,
}));
vi.mock('./api', () => ({
    nodeAddress: () => 'https://riverside.example',
    getCommunityInfo: async () => { if (!web.now) throw new Error('no answer'); return web.now; },
    checkMembership: async () => { if (web.member === null) throw new Error('no answer'); return { isMember: web.member, callsign: null }; },
}));
vi.mock('./visitor-lobby-gate', () => ({ communityInfoOnce: async () => { if (!web.kept) throw new Error('not read'); return web.kept; } }));
vi.mock('./blocklist', () => ({
    getBlocklistStatus: () => ({ loaded: true, error: null }), loadBlocklist: async () => web.blocked,
    isUserBlocked: (k: string) => web.blocked.includes(k), unblockedInThisPage: () => false,
}));
vi.mock('./outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('./outside-mail')>();
    return {
        ...real,
        outsideContext: async () => ({
            nodeUrl: 'https://riverside.example', identity: { publicKey: 'e5'.repeat(32) }, isBlocked: async (k: string) => web.blocked.includes(k),
            store: {
                chats: async () => [...web.across.values()],
                openChat: async (_me: string, id: string, peer: { key: string; home: string; name: string | null }) => {
                    web.across.set(id, { id, peerKey: peer.key, peerHome: peer.home, peerName: peer.name, state: 'open' });
                },
            },
        }),
    };
});

import { relayConversationId } from '@beanpool/core';
import { messageOnWeb, type HereChat } from './message-anyone';

const ACROSS_ID = relayConversationId(ME, K);
let SERVERS: { riverside: Server; hillside: Server; faraway: Server };
let direct: HereChat[];
const serverNamed = (host: string) => Object.values(SERVERS).find((s) => s.names.includes(host)) ?? null;
const says = () => ({
    features: { outsideMessages: SERVERS.riverside.takesAcross }, addresses: SERVERS.riverside.names.filter((n) => !n.startsWith('former')),
    primaryAddress: 'riverside.example', formerAddresses: SERVERS.riverside.names.filter((n) => n.startsWith('former')),
});

type Target = { at: 'here'; key: string } | { at: 'open' | 'new'; chat: string } | { at: 'refused'; why: string };
async function message(url: string, key = K): Promise<Target> {
    const before = new Set(web.across.keys());
    const was = JSON.stringify(web.across.get(ACROSS_ID) ?? null);
    const done = await messageOnWeb([{ key, community: url }], 'Ana', direct);
    if ('dm' in done) return { at: 'here', key: done.dm };
    if ('refused' in done) return { at: 'refused', why: done.refused };
    return { at: before.has(done.across) && JSON.stringify(web.across.get(done.across)) === was ? 'open' : 'new', chat: done.across };
}

/** Why no line can go from `t` now, or null when one can; and for a chat here, what the server does when it is asked for. */
function whyNotWritable(t: Exclude<Target, { at: 'refused' }>): string | null {
    const here = SERVERS.riverside;
    if (t.at === 'here') {
        if (direct.some((c) => c.type === 'dm' && c.participants.includes(t.key))) return null;
        // None yet: a member starts one with a member; a visitor's is refused by the server, with its words, and none is made.
        return !here.members.has(ME) || here.members.has(t.key) ? null : 'they are not here';
    }
    const chat = web.across.get(t.chat) as Chat | undefined;
    if (!chat || chat.peerKey !== K) return 'no such chat';
    if (!here.members.has(ME)) return 'its server takes a line across from members alone';
    if (chat.state !== 'open' && chat.state !== 'request') return `a ${chat.state} chat has no composer`;
    if (!here.takesAcross) return 'its server takes no messages from other communities';
    if (here.names.includes(chat.peerHome)) return 'That person is in this community: write to them here.';
    return serverNamed(chat.peerHome)?.members.has(K) ? null : 'their server does not have them';
}

beforeEach(() => {
    web.across.clear(); web.blocked = []; web.kept = null; web.now = null; web.member = true;
    direct = [];
    SERVERS = {
        riverside: { names: ['riverside.example', 'oldriver.example', 'river.example', 'formerriver.example'], takesAcross: true, members: new Set([ME]) },
        hillside: { names: ['hillside.example'], takesAcross: true, members: new Set([ME]) },
        faraway: { names: ['faraway.example'], takesAcross: true, members: new Set() },
    };
});

type Who = 'here' | 'elsewhere';
const ADDRESSES: Array<{ name: string; who: Who; url: string; server: keyof typeof SERVERS }> = [
    { name: 'here, its main', who: 'here', url: HERE, server: 'riverside' },
    { name: 'here, spelled otherwise', who: 'here', url: 'https://Riverside.example:443/', server: 'riverside' },
    { name: 'here, its older main', who: 'here', url: 'https://oldriver.example', server: 'riverside' },
    { name: 'here, another of its names', who: 'here', url: 'https://river.example', server: 'riverside' },
    { name: 'here, a name it had before', who: 'here', url: 'https://formerriver.example', server: 'riverside' },
    { name: 'a community the phone may hold', who: 'elsewhere', url: 'https://hillside.example', server: 'hillside' },
    { name: 'another community', who: 'elsewhere', url: FARAWAY, server: 'faraway' },
];
const across = (home: string, state: Chat['state'] = 'open') => () => {
    web.across.set(ACROSS_ID, { id: ACROSS_ID, peerKey: K, peerHome: home, peerName: 'Ana', state });
    serverNamed(home)!.members.add(K);
};
const dm = (id: string): HereChat => ({ id, type: 'dm', participants: [ME, K] });
const STATES = {
    'a member, it takes messages across': { member: true, on: true, column: 0 },
    'a member, it takes none across': { member: true, on: false, column: 1 },
    'a visitor, it takes messages across': { member: false, on: true, column: 2 },
    'a visitor, it takes none across': { member: false, on: false, column: 1 },
} as const;
const OFF = "This community doesn't take messages from other communities.";
const NOT_MEMBER = 'Only members of this community can do this.';
const BLOCKED = 'You have blocked this user. Messaging is disabled.';
const WORDS: Record<string, string> = { off: OFF, visitor: NOT_MEMBER };
/** (here / elsewhere) for: a member with it on; it off; a visitor with it on. here: the chat here. open: the chat across there is. new: one made. */
const CHATS: Record<string, { set: () => void; WANT: [string, string, string] }> = {
    'none': { set: () => {}, WANT: ['here new', 'here off', 'here visitor'] },
    'direct here': { set: () => { direct = [dm('d-here')]; }, WANT: ['here here', 'here here', 'here here'] },
    'a group here is no direct chat': { set: () => { direct = [{ ...dm('g-here'), type: 'group_thread' }]; }, WANT: ['here new', 'here off', 'here visitor'] },
    'across, open': { set: across('faraway.example'), WANT: ['open open', 'here off', 'here visitor'] },
    'across, a request': { set: across('faraway.example', 'request'), WANT: ['open open', 'here off', 'here visitor'] },
    'across, declined': { set: across('faraway.example', 'declined'), WANT: ['here new', 'here off', 'here visitor'] },
    'across, dead: its home is an older main here': { set: across('oldriver.example'), WANT: ['here here', 'here here', 'here here'] },
    'across, dead: its home is another name here': { set: across('river.example'), WANT: ['here here', 'here here', 'here here'] },
    'across, dead: its home is a name it had before': { set: across('formerriver.example'), WANT: ['here here', 'here here', 'here here'] },
};
const BLOCKS = { 'blocked on this community\'s list': true, 'no block': false } as const;
const ROWS = ADDRESSES.flatMap((address) => Object.entries(CHATS).flatMap(([chats, { set, WANT }]) => Object.entries(STATES).flatMap(([state, s]) =>
    Object.entries(BLOCKS).map(([block, refused]) => ({
        row: `${address.name} x ${chats} x ${state} x ${block}`, address, set, state: s, refused,
        want: refused ? BLOCKED : ((code) => WORDS[code] ?? code)(WANT[s.column].split(' ')[address.who === 'here' ? 0 : 1]),
    })))));

describe('Message on the web: where it goes, and a line can go from there', () => {
    it('the table is the whole of it: every address, chat, state and block', () => {
        expect(ROWS.length).toBe(7 * 9 * 4 * 2);
    });

    // Named in full: a title made by it.each is cut short.
    for (const { row, address, set, state, refused, want } of ROWS) it(row, async () => {
        SERVERS[address.server].members.add(K);
        SERVERS.riverside.takesAcross = state.on;
        web.member = state.member;
        if (!state.member) SERVERS.riverside.members.delete(ME);
        set();
        web.kept = says(); web.now = says();
        if (refused) web.blocked = [K];
        const before = JSON.stringify([...web.across]);
        const got = await message(address.url);
        expect(got.at === 'refused' ? got.why : got.at).toBe(want);
        if (got.at !== 'refused') expect(whyNotWritable(got)).toBeNull();
        if (got.at !== 'new') expect(JSON.stringify([...web.across])).toBe(before);
    });
});

describe('Message on the web: what the table\'s fixed world cannot hold', () => {
    const word = (t: Target) => (t.at === 'refused' ? t.why : t.at);

    it('the review\'s own step: a contact at another of this community\'s names, tapped again and again: the chat here each time, and no chat across made', async () => {
        web.kept = says(); web.now = says(); SERVERS.riverside.members.add(K);
        for (let i = 0; i < 3; i++) expect(word(await message('https://river.example'))).toBe('here');
        expect(web.across.size).toBe(0);
    });

    it('an address the community took on since this page read its info: the chat here, nothing made', async () => {
        web.kept = says(); SERVERS.riverside.names.push('newriver.example'); web.now = says(); SERVERS.riverside.members.add(K);
        expect(word(await message('https://newriver.example'))).toBe('here');
        expect(web.across.size).toBe(0);
    });

    it('the switch turned off since this page read its info: refused as the chat is made, nothing made', async () => {
        web.kept = says(); SERVERS.riverside.takesAcross = false; web.now = says(); SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe(OFF);
        expect(web.across.size).toBe(0);
    });

    it.each([
        { name: 'no answer now: what this page read decides (an older main)', url: 'https://oldriver.example', keep: true, want: 'here' },
        { name: 'no answer now: what this page read decides (another community)', url: FARAWAY, keep: true, want: 'new' },
        { name: 'no answer now and nothing read: no chat across is made', url: FARAWAY, keep: false, want: OFF },
    ])('$name', async ({ url, keep, want }) => {
        web.kept = keep ? says() : null;
        SERVERS.riverside.members.add(K); SERVERS.faraway.members.add(K);
        expect(word(await message(url))).toBe(want);
    });

    it('an answer that does not come in time: what this page read decides', async () => {
        vi.useFakeTimers();
        try {
            web.kept = says(); SERVERS.faraway.members.add(K);
            const api = await import('./api');
            const asked = vi.spyOn(api, 'getCommunityInfo').mockImplementation(() => new Promise<never>(() => {}));
            const got = message(FARAWAY);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(word(await got)).toBe('new');
            asked.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a membership that can\'t be asked is taken as one, as App takes it', async () => {
        web.member = null; web.kept = says(); web.now = says(); SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe('new');
    });

    it('a chat across where its switch was never read: it still opens', async () => {
        across('faraway.example')();
        expect(word(await message(FARAWAY))).toBe('open');
    });

    it('a declined chat kept with an older main here, the contact in another community: opened again, its lines going there', async () => {
        web.kept = says(); web.now = says();
        across('oldriver.example', 'declined')(); SERVERS.faraway.members.add(K);
        const got = await message(FARAWAY);
        expect(word(got)).toBe('new');
        expect(web.across.get(ACROSS_ID)).toMatchObject({ peerHome: 'faraway.example', state: 'open' });
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
    });

    it('a direct chat here under another of their keys a link names: that chat', async () => {
        web.kept = says(); web.now = says();
        direct = [{ id: 'd-2', type: 'dm', participants: [ME, K2] }];
        expect(await messageOnWeb([{ key: K, community: FARAWAY }, { key: K2, community: 'https://hillside.example' }], 'Ana', direct)).toEqual({ dm: K2 });
    });
});
