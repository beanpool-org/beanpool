/**
 * Message on the web, one exhaustive table (#3354 review, round 4: every round had found one more chat Message opened that the
 * member could not write in, so the class is closed here; the phone's is apps/native message-target-table.test.ts): (the
 * contact's address: this community at its main, an older main, another of its names, a name it had before, one it took on
 * since this page read its info; a name it LOST, still in what this page read or not; a community the phone may hold; another
 * community) x (this community answers now what its names are, or doesn't answer) x (the chats there are: none, direct here, a
 * request of theirs here, across open / request / declined, across dead because its person is here, across to a lost name) x
 * (this account: a member here, one suspended, a visitor, or removed; this community taking messages from other communities or
 * not, or with no address of its own to send from) x (a block: this community's list, none) -> where Message goes, as Contacts goes there
 * (pages/MessagesPage.tsx messageAcross, lib/message-anyone.ts messageOnWeb). The web holds one community: a held one is
 * another community to it, and a block only on another community's list is never read here (no columns).
 *
 * The wanted targets are written out by hand (WANT, each address's `who` and `quiet`): the precedence the review gives. What
 * this community answers now decides; with no answer, what this page read is one copy, and one copy agrees with nothing, so a
 * name it holds is unsure, and unsure opens nothing but a chat there is already: Contacts links to that address (`switch`).
 * Every row that opens a chat is also asked of SERVERS, a model of what each server takes that shares no code with the rule:
 * the chat it ends in must be one a line can go from now; a `switch` must lead to a server that has them. What this community
 * ANSWERS (TOLD) and what this page READ (READ) are written out apart, never read from SERVERS (round 5: the one was made from
 * the other, so a lost name a server listed counted as its own in the rule and in the oracle alike). A chat here is the
 * server's own to open (POST /api/messages/conversation): a visitor gets the one it has, and starts none.
 * Real: message-anyone, community-homes, outside-mail's list and card, core. Mutations are in the PR body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'e5'.repeat(32);
const K = 'a1'.repeat(32);
const K2 = 'c3'.repeat(32);
const HERE = 'https://riverside.example';
const FARAWAY = 'https://faraway.example';

interface Server {
    /** The names it answers as now (apps/server engine/node-key.ts isOwnNodeHome): never one it lost. */
    names: string[];
    takesAcross: boolean;
    /** Whether it has an address to sign as (ownNodeHome): without one every send across answers 503 no_home. */
    home: boolean;
    members: Set<string>;
    /** Accounts it removed: every request of theirs is refused, with words (403 account_closed, https-server.ts). */
    removed: Set<string>;
    /** Members whose account is suspended: they write in a direct chat they have, and no line across or new chat (routes/relay.ts, engine/messaging.ts). */
    suspended: Set<string>;
}
type Chat = { id: string; peerKey: string; peerHome: string; peerName: string | null; state: 'open' | 'request' | 'declined' };
const web = vi.hoisted(() => ({
    across: new Map<string, any>(),
    blocked: [] as string[],
    /** The info this page read once, and what the community answers now (null: no answer). */
    kept: null as null | Record<string, unknown>,
    now: null as null | Record<string, unknown>,
    /** How this account stands here: a member or not, or one suspended; null: no answer; a code: refused everything, 403. */
    member: true as boolean | null | 'suspended' | 'account_closed' | 'account_retired' | 'key_invalidated' | 'some_other_403',
}));
vi.mock('./api', () => ({
    nodeAddress: () => 'https://riverside.example',
    getCommunityInfo: async () => { if (!web.now) throw new Error('no answer'); return web.now; },
    checkMembership: async () => {
        if (web.member === null) throw new Error('no answer');
        // As the server answers it (routes/community.ts): a suspended member is a member still, by `standing`.
        if (web.member === 'suspended') return { isMember: true, callsign: 'Me', standing: 'suspended' };
        if (typeof web.member === 'string') throw Object.assign(new Error('refused'), { status: 403, code: web.member });
        return web.member ? { isMember: true, callsign: 'Me', standing: 'member' } : { isMember: false, callsign: null };
    },
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
/** lakeside: the community that holds the names Riverside lost. */
let SERVERS: { riverside: Server; hillside: Server; faraway: Server; lakeside: Server };
let direct: HereChat[];
const serverNamed = (host: string) => Object.values(SERVERS).find((s) => s.names.includes(host)) ?? null;
interface Told { addresses: string[]; primaryAddress: string; formerAddresses: string[] }
/** What this community answers of its own names now (its info: a lost name is in neither list). */
let TOLD: Told;
/** This community runs a server from before `formerExcludesLost` (a page open here from another address, or a copy of one): its info doesn't say it, and lists a lost name (AGED) among the ones it had. */
let OLDER = false;
const AGED = 'agedriver.example';
/** What this page read when it loaded. */
const READ: Told = { addresses: ['riverside.example', 'oldriver.example', 'river.example', 'lostriver.example'], primaryAddress: 'riverside.example', formerAddresses: ['formerriver.example'] };
const says = (told: Told = TOLD): Record<string, unknown> => ({
    features: { outsideMessages: SERVERS.riverside.takesAcross }, addresses: [...told.addresses],
    primaryAddress: SERVERS.riverside.home ? told.primaryAddress : null,
    ...(OLDER ? { formerAddresses: [...told.formerAddresses, AGED] } : { formerAddresses: [...told.formerAddresses], formerExcludesLost: true }),
});

type Opened = { at: 'here'; key: string } | { at: 'open' | 'new'; chat: string };
type Target = Opened | { at: 'switch'; address: string } | { at: 'refused'; why: string };
async function message(url: string, key = K): Promise<Target> {
    const before = new Set(web.across.keys());
    const was = JSON.stringify(web.across.get(ACROSS_ID) ?? null);
    const done = await messageOnWeb([{ key, community: url }], 'Ana', direct);
    if ('dm' in done) return { at: 'here', key: done.dm };
    if ('refused' in done) return { at: 'refused', why: done.refused };
    if ('elsewhere' in done) return { at: 'switch', address: done.elsewhere };
    return { at: before.has(done.across) && JSON.stringify(web.across.get(done.across)) === was ? 'open' : 'new', chat: done.across };
}

/** Why no line can go from `t` now, or null when one can; for a chat here, what the server does when it is asked for; for a link, why it leads to no one. */
function whyNotWritable(t: Opened | { at: 'switch'; address: string }): string | null {
    if (t.at === 'switch') return serverNamed(new URL(t.address).host)?.members.has(K) ? null : 'the link leads to a server that does not have them';
    const here = SERVERS.riverside;
    if (t.at === 'here') {
        // One it removed is refused the chat itself, with words: nothing opens (MessagesPage handleStartDm).
        if (here.removed.has(ME)) return null;
        if (direct.some((c) => c.type === 'dm' && c.participants.includes(t.key))) return null;
        // None yet: a member starts one with a member; a visitor's, or a suspended member's, is refused by the server, with its words, and none is made.
        return !here.members.has(ME) || here.suspended.has(ME) || here.members.has(t.key) ? null : 'they are not here';
    }
    const chat = web.across.get(t.chat) as Chat | undefined;
    if (!chat || chat.peerKey !== K) return 'no such chat';
    if (here.removed.has(ME)) return 'its server takes nothing of a member it removed (403 account_closed)';
    if (!here.members.has(ME)) return 'its server takes a line across from members alone';
    if (here.suspended.has(ME)) return 'its server takes no line across from a suspended member (403 not_a_member)';
    if (chat.state !== 'open' && chat.state !== 'request') return `a ${chat.state} chat has no composer`;
    if (!here.takesAcross) return 'its server takes no messages from other communities';
    if (!here.home) return 'its server has no address of its own to send from (503 no_home)';
    if (here.names.includes(chat.peerHome)) return 'That person is in this community: write to them here.';
    return serverNamed(chat.peerHome)?.members.has(K) ? null : 'their server does not have them';
}

beforeEach(() => {
    web.across.clear(); web.blocked = []; web.kept = null; web.now = null; web.member = true;
    direct = [];
    OLDER = false;
    SERVERS = {
        riverside: { names: ['riverside.example', 'oldriver.example', 'river.example', 'newriver.example', 'formerriver.example'], takesAcross: true, home: true, members: new Set([ME]), removed: new Set(), suspended: new Set() },
        hillside: { names: ['hillside.example'], takesAcross: true, home: true, members: new Set([ME]), removed: new Set(), suspended: new Set() },
        faraway: { names: ['faraway.example'], takesAcross: true, home: true, members: new Set(), removed: new Set(), suspended: new Set() },
        lakeside: { names: ['lakeside.example', 'lostriver.example', 'goneriver.example', 'agedriver.example'], takesAcross: true, home: true, members: new Set(), removed: new Set(), suspended: new Set() },
    };
    TOLD = { addresses: ['riverside.example', 'oldriver.example', 'river.example', 'newriver.example'], primaryAddress: 'riverside.example', formerAddresses: ['formerriver.example'] };
});

type Who = 'here' | 'elsewhere' | 'unsure';
/** `who`: whose it is by what this community answers now. `quiet`: with no answer (left out: what this page read can't say). */
const ADDRESSES: Array<{ name: string; who: Who; quiet?: Who; url: string; server: keyof typeof SERVERS; older?: boolean }> = [
    { name: 'here, its main', who: 'here', quiet: 'here', url: HERE, server: 'riverside' },
    { name: 'here, spelled otherwise', who: 'here', quiet: 'here', url: 'https://Riverside.example:443/', server: 'riverside' },
    { name: 'here, its older main', who: 'here', quiet: 'unsure', url: 'https://oldriver.example', server: 'riverside' },
    { name: 'here, another of its names', who: 'here', quiet: 'unsure', url: 'https://river.example', server: 'riverside' },
    { name: 'here, a name it had before', who: 'here', quiet: 'unsure', url: 'https://formerriver.example', server: 'riverside' },
    { name: 'here, one it took on since this page read its info', who: 'here', url: 'https://newriver.example', server: 'riverside' },
    { name: 'a name this community lost, to another, since this page read its info', who: 'elsewhere', quiet: 'unsure', url: 'https://lostriver.example', server: 'lakeside' },
    { name: 'an older server here: a name it had before and answers as still', who: 'unsure', quiet: 'unsure', url: 'https://formerriver.example', server: 'riverside', older: true },
    { name: 'an older server here: a name it lost to another, listed still as one it had', who: 'unsure', quiet: 'unsure', url: 'https://agedriver.example', server: 'lakeside', older: true },
    { name: 'a name this community lost, to another, before that', who: 'elsewhere', quiet: 'elsewhere', url: 'https://goneriver.example', server: 'lakeside' },
    { name: 'a community the phone may hold', who: 'elsewhere', quiet: 'elsewhere', url: 'https://hillside.example', server: 'hillside' },
    { name: 'another community', who: 'elsewhere', quiet: 'elsewhere', url: FARAWAY, server: 'faraway' },
];
const across = (home: string, state: Chat['state'] = 'open') => () => {
    web.across.set(ACROSS_ID, { id: ACROSS_ID, peerKey: K, peerHome: home, peerName: 'Ana', state });
    serverNamed(home)!.members.add(K);
};
const dm = (id: string): HereChat => ({ id, type: 'dm', participants: [ME, K] });
const STATES = {
    'removed from here, it takes messages across': { member: 'account_closed', on: true, home: true, column: 2, off: 'off' },
    'removed from here, it takes none across': { member: 'account_closed', on: false, home: true, column: 1, off: 'off' },
    'removed from here, its switch on, no address of its own to send from': { member: 'account_closed', on: true, home: false, column: 1, off: 'no-home' },
    'a member, it takes messages across': { member: true, on: true, home: true, column: 0, off: 'off' },
    'a member, it takes none across': { member: true, on: false, home: true, column: 1, off: 'off' },
    'a member, its switch on, no address of its own to send from': { member: true, on: true, home: false, column: 1, off: 'no-home' },
    'suspended here, it takes messages across': { member: 'suspended', on: true, home: true, column: 2, off: 'off' },
    'suspended here, it takes none across': { member: 'suspended', on: false, home: true, column: 1, off: 'off' },
    'suspended here, its switch on, no address of its own to send from': { member: 'suspended', on: true, home: false, column: 1, off: 'no-home' },
    'a visitor, it takes messages across': { member: false, on: true, home: true, column: 2, off: 'off' },
    'a visitor, it takes none across': { member: false, on: false, home: true, column: 1, off: 'off' },
    'a visitor, its switch on, no address of its own to send from': { member: false, on: true, home: false, column: 1, off: 'no-home' },
} as const;
const NO_HOME = "This community's server knows none of its own names yet, so it can't send to another community.";
const OFF = "This community doesn't take messages from other communities.";
const NOT_MEMBER = 'Only members of this community can do this.';
const BLOCKED = 'You have blocked this user. Messaging is disabled.';
const WORDS: Record<string, string> = { off: OFF, 'no-home': NO_HOME, visitor: NOT_MEMBER };
type Wants = [string, string, string];
const NONE: Wants = ['here new switch', 'here off switch', 'here visitor switch'];
const ALL = (one: string): Wants => [0, 1, 2].map(() => Array(3).fill(one).join(' ')) as Wants;
/**
 * (here / elsewhere / unsure) for: a member with it on; it off (or with no address to send from); a visitor or a suspended
 * member with it on, or an account it removed. here:
 * the chat here. open: the chat across there is. new: one made. switch: nothing opens, the link to the address. QUIET: the
 * same with no answer, where the chat's own home is then unsure (left out: as WANT). OLDER: the same from an older server.
 */
const CHATS: Record<string, { set: () => void; WANT: Wants; QUIET?: Wants; OLDER?: Wants }> = {
    'none': { set: () => {}, WANT: NONE },
    'direct here': { set: () => { direct = [dm('d-here')]; }, WANT: ALL('here') },
    'a group here is no direct chat': { set: () => { direct = [{ ...dm('g-here'), type: 'group_thread' }]; }, WANT: NONE },
    'across, open': { set: across('faraway.example'), WANT: ['open open open', NONE[1], NONE[2]] },
    'across, a request': { set: across('faraway.example', 'request'), WANT: ['open open open', NONE[1], NONE[2]] },
    'across, declined': { set: across('faraway.example', 'declined'), WANT: NONE },
    'across, open: its home is a name this community lost': { set: across('lostriver.example'), WANT: ['open open open', NONE[1], NONE[2]], QUIET: NONE },
    'across, dead: its home is an older main here': { set: across('oldriver.example'), WANT: ALL('here'), QUIET: NONE },
    'across, dead: its home is another name here': { set: across('river.example'), WANT: ALL('here'), QUIET: NONE },
    'across, dead: its home is a name it had before': { set: across('formerriver.example'), WANT: ALL('here'), QUIET: NONE, OLDER: NONE },
};
const WHO: Who[] = ['here', 'elsewhere', 'unsure'];
const ANSWERS = { 'it answers': true, 'it does not answer': false } as const;
const BLOCKS = { 'blocked on this community\'s list': true, 'no block': false } as const;
const ROWS = ADDRESSES.flatMap((address) => Object.entries(ANSWERS).flatMap(([answer, answers]) => (!answers && !address.quiet ? [] : Object.entries(CHATS).flatMap(([chats, { set, WANT, QUIET, OLDER: FROM_OLDER }]) =>
    Object.entries(STATES).flatMap(([state, s]) => Object.entries(BLOCKS).map(([block, refused]) => {
        const code = (!answers ? QUIET ?? WANT : address.older ? FROM_OLDER ?? WANT : WANT)[s.column].split(' ')[WHO.indexOf(answers ? address.who : address.quiet!)];
        return { row: `${address.name} x ${answer} x ${chats} x ${state} x ${block}`, address, answers, set, state: s, refused, want: refused ? BLOCKED : WORDS[code === 'off' ? s.off : code] ?? code };
    }))))));

describe('Message on the web: where it goes, and a line can go from there', () => {
    it('the table is the whole of it: every address, answer, chat, state and block', () => {
        expect(ROWS.length).toBe((12 + 11) * 10 * 12 * 2);
    });

    // Named in full: a title made by it.each is cut short.
    for (const { row, address, answers, set, state, refused, want } of ROWS) it(row, async () => {
        OLDER = address.older === true;
        SERVERS[address.server].members.add(K);
        SERVERS.riverside.takesAcross = state.on;
        SERVERS.riverside.home = state.home;
        web.member = state.member;
        if (state.member === 'suspended') SERVERS.riverside.suspended.add(ME);
        else if (state.member !== true) SERVERS.riverside.members.delete(ME);
        if (state.member === 'account_closed') SERVERS.riverside.removed.add(ME);
        set();
        web.kept = says(READ); web.now = answers ? says() : null;
        if (refused) web.blocked = [K];
        const before = JSON.stringify([...web.across]);
        const got = await message(address.url);
        expect(got.at === 'refused' ? got.why : got.at).toBe(want);
        if (got.at !== 'refused') expect(whyNotWritable(got)).toBeNull();
        if (got.at === 'switch') expect(got.address).toBe(address.url);
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
        web.kept = says(); SERVERS.riverside.names.push('newest.example'); TOLD.addresses.push('newest.example'); web.now = says(); SERVERS.riverside.members.add(K);
        expect(word(await message('https://newest.example'))).toBe('here');
        expect(web.across.size).toBe(0);
    });

    it('the switch turned off since this page read its info: refused as the chat is made, nothing made', async () => {
        web.kept = says(); SERVERS.riverside.takesAcross = false; web.now = says(); SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe(OFF);
        expect(web.across.size).toBe(0);
    });

    it.each([
        { name: 'no answer now, and only what this page read says it is its own (an older main): the link, nothing made', url: 'https://oldriver.example', keep: true, want: 'switch' },
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

    // ── round 5: a name lost while the page was open ──
    it.each([
        { name: 'a name it had before', url: 'https://formerriver.example', lose: () => { TOLD.formerAddresses = []; }, host: 'formerriver.example' },
        { name: 'one it went by', url: 'https://river.example', lose: () => { TOLD.addresses = ['riverside.example']; }, host: 'river.example' },
    ])('lost since this page read its info ($name): asked now, so across to the community that holds it', async ({ url, lose, host }) => {
        web.kept = says();
        lose(); SERVERS.riverside.names = SERVERS.riverside.names.filter((n) => n !== host);
        SERVERS.lakeside.names.push(host); SERVERS.lakeside.members.add(K);
        web.now = says();
        const got = await message(url);
        expect(word(got)).toBe('new');
        expect(whyNotWritable(got as Opened)).toBeNull();
    });

    it('asked now, a community that says nothing of its addresses: one copy, unsure; at its own address nothing is asked', async () => {
        const api = await import('./api');
        web.kept = says(); SERVERS.riverside.members.add(K);
        web.now = { features: { outsideMessages: true } };
        expect(await message('https://formerriver.example')).toEqual({ at: 'switch', address: 'https://formerriver.example' });
        expect(web.across.size).toBe(0);
        const asked = vi.spyOn(api, 'getCommunityInfo');
        expect(word(await message(HERE))).toBe('here');
        expect(asked).not.toHaveBeenCalled();
        asked.mockRestore();
    });

    it('an answer that names none but one it had before is an answer: a name this page read is lost, the one it had is here', async () => {
        web.kept = says(); SERVERS.riverside.members.add(K);
        web.now = { features: { outsideMessages: true }, addresses: [], primaryAddress: null, formerAddresses: ['formerriver.example'], formerExcludesLost: true };
        expect(word(await message('https://oldriver.example'))).toBe(NO_HOME);
        expect(web.across.size).toBe(0);
        expect(word(await message('https://formerriver.example'))).toBe('here');
    });

    it('a name this page read, the answer not in time: the link, after the deadline and no later', async () => {
        vi.useFakeTimers();
        const api = await import('./api');
        const asked = vi.spyOn(api, 'getCommunityInfo').mockImplementation(() => new Promise<never>(() => {}));
        try {
            web.kept = says(); SERVERS.riverside.members.add(K);
            let got: Target | null = null;
            void message('https://river.example').then((t) => { got = t; });
            await vi.advanceTimersByTimeAsync(5_000);
            expect(got).toEqual({ at: 'switch', address: 'https://river.example' });
        } finally {
            asked.mockRestore();
            vi.useRealTimers();
        }
    });

    it('an existing chat opens with nothing asked, whatever the link says', async () => {
        const api = await import('./api');
        const asked = vi.spyOn(api, 'getCommunityInfo');
        web.kept = says(READ);
        direct = [dm('d-here')];
        for (const url of ['https://lostriver.example', 'https://river.example']) expect(word(await message(url))).toBe('here');
        expect(asked).not.toHaveBeenCalled();
        asked.mockRestore();
    });

    it('two links, the one tapped unsure: the other, of another community for certain', async () => {
        web.kept = says(); SERVERS.faraway.members.add(K);
        expect(await messageOnWeb([{ key: K2, community: 'https://river.example' }, { key: K, community: FARAWAY }], 'Ana', direct)).toEqual({ across: ACROSS_ID });
    });

    // ── round 5: the membership ask and the page's own read have the same deadline ──
    it.each([
        { name: 'a chat across there is', set: () => across('faraway.example')(), url: FARAWAY, want: 'open' },
        { name: 'a chat across to make', set: () => { SERVERS.faraway.members.add(K); }, url: FARAWAY, want: 'new' },
        { name: 'this community', set: () => { SERVERS.riverside.members.add(K); }, url: 'https://river.example', want: 'here' },
    ])('a membership that does not come in time is taken as one, as App takes it: $name', async ({ set, url, want }) => {
        vi.useFakeTimers();
        const api = await import('./api');
        const asked = vi.spyOn(api, 'checkMembership').mockImplementation(() => new Promise<never>(() => {}));
        try {
            web.kept = says(); web.now = says(); set();
            let got: Target | null = null;
            void message(url).then((t) => { got = t; });
            await vi.advanceTimersByTimeAsync(5_000);
            expect(got && word(got)).toBe(want);
            expect(asked).toHaveBeenCalledTimes(want === 'here' ? 0 : 1);
        } finally {
            asked.mockRestore();
            vi.useRealTimers();
        }
    });

    it('an info this page is still waiting for is not waited for past the deadline: what is known decides', async () => {
        vi.useFakeTimers();
        const gate = await import('./visitor-lobby-gate');
        const read = vi.spyOn(gate, 'communityInfoOnce').mockImplementation(() => new Promise<never>(() => {}));
        try {
            web.now = says(); SERVERS.faraway.members.add(K);
            let got: Target | null = null;
            void message(FARAWAY).then((t) => { got = t; });
            await vi.advanceTimersByTimeAsync(5_000);
            expect(got && word(got)).toBe('new');
        } finally {
            read.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each([
        { name: 'it publishes none of its own addresses', info: { addresses: [], primaryAddress: null, formerAddresses: [] } },
        { name: 'it publishes none and says no main', info: { addresses: [], formerAddresses: [] } },
    ])('$name, its switch on: no chat across is made, and one there is not picked', async ({ info }) => {
        web.kept = { features: { outsideMessages: true }, ...info }; web.now = web.kept;
        SERVERS.riverside.home = false; SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe(NO_HOME);
        expect(web.across.size).toBe(0);
        across('faraway.example')();
        expect(word(await message(FARAWAY))).toBe(NO_HOME);
    });

    it('heard only as the chat is made that it has no address of its own: refused, nothing made', async () => {
        web.kept = says(); SERVERS.riverside.home = false; web.now = says(); SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe(NO_HOME);
        expect(web.across.size).toBe(0);
    });

    it('a server that says nothing of its addresses: not known to have none, so made', async () => {
        web.kept = { features: { outsideMessages: true } }; web.now = web.kept; SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe('new');
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
        expect(whyNotWritable(got as Opened)).toBeNull();
    });

    // ── version skew (the page's own server is older, or is updated while the page is open) ──
    it('an older server, as the chat across is made: the link, nothing made', async () => {
        OLDER = true;
        web.now = says(); SERVERS.lakeside.members.add(K);
        // Nothing read by this page: no copy holds the name, so it is asked only as the chat is made.
        expect(await message('https://agedriver.example')).toEqual({ at: 'switch', address: 'https://agedriver.example' });
        expect(web.across.size).toBe(0);
    });

    it.each([
        { name: 'updated since this page read its info', read: true, now: false, want: 'here' },
        { name: 'rolled back since', read: false, now: true, want: 'switch' },
    ])('the server is $name: its answer now decides', async ({ read, now, want }) => {
        OLDER = read; web.kept = says();
        OLDER = now; web.now = says();
        SERVERS.riverside.members.add(K);
        expect(word(await message('https://formerriver.example'))).toBe(want);
        expect(web.across.size).toBe(0);
    });

    it.each([
        { name: 'an IPv6 number', host: '[2001:db8::7]', said: '[2001:DB8:0::7]' },
        { name: 'a name with an underscore', host: 'river_side.example', said: 'river_side.example' },
    ])('its own name is $name: the chat here, nothing made', async ({ host, said }) => {
        SERVERS.riverside.names.push(host); SERVERS.riverside.members.add(K);
        for (const read of [true, false]) {
            web.kept = says();
            TOLD.addresses.push(said);
            web.now = says();
            if (read) web.kept = says();
            expect(word(await message(`https://${host}`))).toBe('here');
            TOLD.addresses.pop();
        }
        expect(web.across.size).toBe(0);
    });

    // ── an account this community refuses everything, or a line across, is no member here to write one, whatever else is not known ──
    it.each([
        { name: 'closed here', member: 'account_closed', want: NOT_MEMBER },
        { name: 'retired here', member: 'account_retired', want: NOT_MEMBER },
        { name: 'its key here replaced', member: 'key_invalidated', want: NOT_MEMBER },
        { name: 'suspended here', member: 'suspended', want: NOT_MEMBER },
        { name: 'in good standing again', member: true, want: 'new' },
        { name: 'refused for another reason: not known, so taken as a member, as App does', member: 'some_other_403', want: 'new' },
    ] as Array<{ name: string; member: typeof web.member; want: string }>)('an account $name: a chat across, one there is and a new one', async ({ member, want }) => {
        web.kept = says(); web.now = says(); web.member = member; SERVERS.faraway.members.add(K);
        expect(word(await message(FARAWAY))).toBe(want);
        web.across.clear();
        across('faraway.example')();
        expect(word(await message(FARAWAY))).toBe(want === 'new' ? 'open' : want);
    });

    // ── every read Contacts' Message waits for has the one deadline ──
    it('the page\'s list of chats asked for and not in time: gone on without it, after the deadline and no later', async () => {
        vi.useFakeTimers();
        try {
            web.kept = says(); web.now = says(); SERVERS.faraway.members.add(K);
            let got: unknown = null;
            void messageOnWeb([{ key: K, community: FARAWAY }], 'Ana', () => new Promise<never>(() => {})).then((d) => { got = d; });
            await vi.advanceTimersByTimeAsync(4_900);
            expect(got).toBeNull();
            await vi.advanceTimersByTimeAsync(200);
            expect(got).toEqual({ across: ACROSS_ID });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        { name: 'in time: its chats count, a request of theirs too', ask: async () => ({ conversations: [], totalUnread: 0, requests: { count: 1, conversations: [dm('r-1')] } }), want: { dm: K } },
        { name: 'a direct chat', ask: async () => ({ conversations: [dm('d-1')], totalUnread: 0 }), want: { dm: K } },
        { name: 'fails: gone on without it', ask: async () => { throw new Error('offline'); }, want: { across: ACROSS_ID } },
    ])('the page\'s list of chats asked for ($name)', async ({ ask, want }) => {
        web.kept = says(); web.now = says(); SERVERS.faraway.members.add(K);
        expect(await messageOnWeb([{ key: K, community: FARAWAY }], 'Ana', ask as never)).toEqual(want);
    });

    it('a block list not read in time: refused, to try again, after the deadline and no later; nothing opens', async () => {
        const blocklist = await import('./blocklist');
        const status = vi.spyOn(blocklist, 'getBlocklistStatus').mockReturnValue({ loaded: false, error: null });
        const read = vi.spyOn(blocklist, 'loadBlocklist').mockImplementation(() => new Promise<never>(() => {}));
        vi.useFakeTimers();
        try {
            web.kept = says(); web.now = says(); across('faraway.example')();
            let got: Target | null = null;
            void message(FARAWAY).then((t) => { got = t; });
            await vi.advanceTimersByTimeAsync(4_900);
            expect(got).toBeNull();
            await vi.advanceTimersByTimeAsync(200);
            expect(got).toEqual({ at: 'refused', why: "Couldn't reach your community. Check your connection and try again." });
        } finally {
            vi.useRealTimers();
            status.mockRestore(); read.mockRestore();
        }
    });

    it('a block list read in time: asked, then the block', async () => {
        const blocklist = await import('./blocklist');
        const status = vi.spyOn(blocklist, 'getBlocklistStatus').mockReturnValue({ loaded: false, error: null });
        const read = vi.spyOn(blocklist, 'loadBlocklist').mockImplementation(async () => { web.blocked = [K]; return web.blocked; });
        try {
            web.kept = says(); web.now = says(); across('faraway.example')();
            expect(word(await message(FARAWAY))).toBe(BLOCKED);
        } finally {
            status.mockRestore(); read.mockRestore();
        }
    });

    it('a direct chat here under another of their keys a link names: that chat', async () => {
        web.kept = says(); web.now = says();
        direct = [{ id: 'd-2', type: 'dm', participants: [ME, K2] }];
        expect(await messageOnWeb([{ key: K, community: FARAWAY }, { key: K2, community: 'https://hillside.example' }], 'Ana', direct)).toEqual({ dm: K2 });
    });
});
