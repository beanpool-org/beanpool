/**
 * Message on the phone, one exhaustive table (#3354 review, round 4: every round had found one more chat Message opened that
 * the member could not write in, so the class is closed here): (the contact's address: the community in use at its main, an
 * older main, another of its names, a name it had before, one on its signed list; a held community at each of those; a name
 * either of them LOST, to a community the phone does not hold or to the other one; another community) x (the chats there are:
 * none, direct here, direct held, across open / request / declined, across dead because its person is here, across to a held
 * community or to a lost name, and the same in a held community's file) x (the community in use: a member's or a guest's
 * look, taking messages from other communities or not, or with no address of its own to send from) x (a block: on the phone's
 * list, seen only on another community's own list, none) -> where Message goes, as Contacts and New message go there
 * (utils/message-anyone.ts).
 *
 * The wanted targets are written out by hand (WANT), never worked out by the rule. Every row that is not refused is also
 * asked of SERVERS, a model of what each community's server takes, that shares no code with the rule: the chat it ends in
 * must be one a line can go from now, to a server that has this person. SERVERS and what a community SAYS of itself (TOLD)
 * are two tables, each written out (round 5: the names a server answers as were made from the list it publishes, so a lost
 * name an older server still lists counted as its own in the rule and in the oracle alike, and 1867 rows missed it). Then
 * rows for what the table's fixed world can't hold: info heard only now, a saved row of the same community, a community that
 * claims another's address.
 *
 * Real: message-anyone, community-homes, community-index, held-chats, outside-chat-live, outside-mail's list and card, dm-blocked,
 * node-profile, nodes, core. In memory: the database module's reads, the phone's storage, and the info a server answers.
 * Mutations, each with the rows it turns red, are in the PR body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'e5'.repeat(32);
const K = 'a1'.repeat(32);

const phone = vi.hoisted(() => ({
    store: new Map<string, string>(),
    blocked: [] as string[],
    seenThere: [] as string[],
    directHere: [] as any[],
    directHeld: [] as any[],
    /** The across chats of each file, by community: the store openChatFromCard writes to. */
    files: new Map<string, Map<string, any>>(),
    /** What each server answers of itself now, by origin; absent: no answer. */
    info: new Map<string, unknown>(),
    /** The people this phone's copy of a community has as members (its sync): that server's, unless a row says otherwise. */
    copyOf: (_community: string): Set<string> => new Set(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {} } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => phone.store.get(k) ?? null,
        setItem: async (k: string, v: string) => { phone.store.set(k, v); },
        removeItem: async (k: string) => { phone.store.delete(k); },
    },
}));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../identity', () => ({ loadIdentity: async () => ({ publicKey: ME, privateKey: 'f0'.repeat(32), callsign: 'Me' }) }));
vi.mock('../blocklist', () => ({
    getBlockedUsers: async () => phone.blocked, isUserBlocked: async (k: string) => phone.blocked.includes(k),
    readBlockLists: async () => ({ onPhone: new Set(phone.blocked), once: new Set<string>(), seenThere: new Set(phone.seenThere) }),
    blocksOwedAt: async () => false, blockUser: async () => true, syncBlocksAt: async () => {},
}));
vi.mock('../db', () => {
    const file = (community: string) => {
        const key = community.replace(/\/+$/, '');
        if (!phone.files.has(key)) phone.files.set(key, new Map());
        return phone.files.get(key)!;
    };
    const storeOf = (community: string) => ({
        chats: async () => [...file(community).values()],
        openChat: async (_me: string, id: string, peer: { key: string; home: string; name: string | null }) => {
            file(community).set(id, { id, peerKey: peer.key, peerHome: peer.home, peerName: peer.name, state: 'open' });
        },
        getMeta: async () => null,
        setMeta: async () => {},
    });
    return {
        getConversations: async () => phone.directHere,
        getHeldConversations: async (_me: string, community: string) => (community === 'https://hillside.example' ? phone.directHeld : []),
        getHeldOutsideChats: async (_me: string, community: string) => [...file(community).values()],
        getMemberProfile: async (key: string) => (phone.copyOf('https://riverside.example').has(key) ? { public_key: key, status: 'active' } : null),
        isHeldMember: async (community: string, key: string) => phone.copyOf(community).has(key),
        closeHeldCopies: async () => {},
        outsideStore: storeOf,
        outsideStoreOf: storeOf,
    };
});

import { relayConversationId, type MessageLink } from '@beanpool/core';
import { makeCommunityRecord, resetCommunityIndexForTests, setCommunityIndex, type CommunityRecord } from '../community-index';
import { existingChatRoute, messagePathOnPhone, openAcrossChat } from '../message-anyone';
import { namesCommunityInUse } from '../community-homes';
import { readNodeProfile } from '../node-profile';

const RIVERSIDE = 'https://riverside.example';
const HILLSIDE = 'https://hillside.example';
const FARAWAY = 'https://faraway.example';
const ACROSS_ID = relayConversationId(ME, K);

// ── What the servers take: the oracle, sharing nothing with the rule, nor with what a community says of itself ───────
interface Server {
    /** The names its server answers as now (apps/server engine/node-key.ts isOwnNodeHome): a name it lost is not one. */
    names: string[];
    /** Its owner's switch. */
    takesAcross: boolean;
    /** Whether it has an address to sign as (ownNodeHome): without one it answers every send 503 no_home. */
    home: boolean;
    members: Set<string>;
}
/** lakeside: a community this phone does not hold; it holds names that Riverside and Hillside lost. */
let SERVERS: Record<'riverside' | 'hillside' | 'faraway' | 'lakeside', Server>;
const serverNamed = (host: string) => Object.values(SERVERS).find((s) => s.names.includes(host)) ?? null;
const hostOf = (url: string) => url.replace(/^https:\/\//, '').replace(/\/.*$/, '');

/** Where a tap ended, and the chat it ended in. */
type Target =
    | { at: 'here' | 'held'; existing: boolean; key: string; route: unknown }
    | { at: 'new' | 'open' | 'openHeld'; chat: string; key: string; route: unknown }
    | { at: 'refused'; why: string };

/** Why no line can go from `t` now, or null when one can. */
function whyNotWritable(t: Exclude<Target, { at: 'refused' }>): string | null {
    if (!('chat' in t)) {
        const server = t.at === 'here' ? SERVERS.riverside : SERVERS.hillside;
        const there = (t.at === 'here' ? phone.directHere : phone.directHeld).some((c) => c.peerPubkey === t.key);
        if (t.existing && !there) return 'no such chat there';
        // A visitor may write in a chat it already has, and starts none; a member starts one with a member.
        if (!server.members.has(ME)) return t.existing ? null : 'a visitor starts no chat';
        return server.members.has(t.key) ? null : 'they are not there';
    }
    const [server, file] = t.at === 'openHeld' ? [SERVERS.hillside, HILLSIDE] as const : [SERVERS.riverside, RIVERSIDE] as const;
    const chat = phone.files.get(file)?.get(t.chat);
    if (!chat || chat.peerKey !== t.key) return 'no such chat in that file';
    if (!server.members.has(ME)) return 'its server takes a line across from members alone';
    if (chat.state !== 'open' && chat.state !== 'request') return `a ${chat.state} chat has no composer`;
    if (!server.takesAcross) return 'its server takes no messages from other communities';
    if (!server.home) return 'its server has no address of its own to send from (503 no_home)';
    if (server.names.includes(chat.peerHome)) return 'That person is in this community: write to them here.';
    return serverNamed(chat.peerHome)?.members.has(t.key) ? null : 'their server does not have them';
}

/** Message on a person, as Contacts and New message do it, to the chat it ends in. */
async function message(links: MessageLink[], held: readonly string[] = [HILLSIDE]): Promise<Target> {
    const anchor = phone.store.get('beanpool_anchor_url')!;
    const path = await messagePathOnPhone(ME, links, held);
    if (path.open === 'blocked' || path.open === 'nothing') return { at: 'refused', why: path.open };
    if (path.open === 'existing') {
        const route = existingChatRoute(path.chat, anchor, () => 'Hillside');
        if (path.chat.kind === 'across') return { at: path.chat.community ? 'openHeld' : 'open', chat: path.chat.id, key: path.chat.key, route };
        return { at: typeof route === 'string' ? 'here' : 'held', existing: true, key: path.chat.key, route };
    }
    if (path.open === 'shared') return { at: path.community === anchor ? 'here' : 'held', existing: false, key: path.key, route: path.community };
    const opened = await openAcrossChat(path);
    if ('chatId' in opened) return { at: 'new', chat: opened.chatId, key: path.key, route: opened.chatId };
    if ('here' in opened) return { at: 'here', existing: false, key: opened.here, route: anchor };
    return { at: 'refused', why: opened.refused };
}

// ── The table's world ────────────────────────────────────────────────────────────────────────────────────────────────
/** `lost`: addresses it once proved to this phone, and lost since. */
const record = (id: string, using: string, peerId: string, listed: string, lost: string[] = []): CommunityRecord => ({
    ...makeCommunityRecord(id, { peerId, communityId: peerId, epoch: 1 }), using, proved: Object.fromEntries(lost.map((a) => [a, { at: 1, epoch: 1 }])),
    list: { list: { peerId, addresses: [hostOf(using), listed] }, sig: '' } as unknown as CommunityRecord['list'],
});
const RIVER_LOST = ['https://lostriver.example', 'https://takenriver.example'];
const HILL_LOST = ['https://losthill.example', 'https://takenhill.example'];
/**
 * What each community says of its own names (its info), written out, never read from SERVERS. Each other address is known one
 * way only: an older main by the record, one on the signed list by it, the rest by the info. Both are servers from before
 * round 5 for the names taken*: each still lists as a name it had before one it lost, which the other goes by now.
 */
interface Told { addresses: string[]; primaryAddress: string | null; formerAddresses: string[] }
let TOLD: Record<'riverside' | 'hillside', Told>;
const infoOf = (server: Server, told: Told) => ({
    profile: 'local', features: { outsideMessages: server.takesAcross }, checkedAt: '2026-11-22T00:00:00.000Z',
    addresses: [...told.addresses], primaryAddress: server.home ? told.primaryAddress : null, formerAddresses: [...told.formerAddresses],
});
function saysNow(): void {
    phone.info.set(RIVERSIDE, infoOf(SERVERS.riverside, TOLD.riverside));
    phone.info.set(HILLSIDE, infoOf(SERVERS.hillside, TOLD.hillside));
}
/** As this phone keeps each answer (node-profile.ts). */
function kept(): void {
    phone.store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([...phone.info].map(([at, said]) => [at, readNodeProfile(said)]))));
}

beforeEach(() => {
    phone.store.clear();
    phone.blocked = []; phone.seenThere = []; phone.directHere = []; phone.directHeld = [];
    phone.files.clear(); phone.info.clear();
    SERVERS = {
        riverside: { names: ['riverside.example', 'oldriver.example', 'river.example', 'formerriver.example', 'listedriver.example', 'takenhill.example'], takesAcross: true, home: true, members: new Set([ME]) },
        hillside: { names: ['hillside.example', 'oldhill.example', 'hill.example', 'formerhill.example', 'listedhill.example', 'takenriver.example'], takesAcross: true, home: true, members: new Set([ME]) },
        faraway: { names: ['faraway.example'], takesAcross: true, home: true, members: new Set() },
        lakeside: { names: ['lakeside.example', 'lostriver.example', 'losthill.example'], takesAcross: true, home: true, members: new Set() },
    };
    TOLD = {
        riverside: { addresses: ['riverside.example', 'river.example', 'takenhill.example'], primaryAddress: 'riverside.example', formerAddresses: ['formerriver.example', 'takenriver.example'] },
        hillside: { addresses: ['hillside.example', 'hill.example', 'takenriver.example'], primaryAddress: 'hillside.example', formerAddresses: ['formerhill.example', 'takenhill.example'] },
    };
    phone.copyOf = (community) => Object.values(SERVERS).find((s) => s.names.includes(hostOf(community)))?.members ?? new Set();
    phone.store.set('beanpool_anchor_url', RIVERSIDE);
    phone.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside' }, { url: HILLSIDE, alias: 'Hillside' }]));
    resetCommunityIndexForTests();
    // Both moved to a new main address once, and the phone followed each (addresses S4): its record holds both, and the names each lost.
    setCommunityIndex([record('https://oldriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example', RIVER_LOST),
        record('https://oldhill.example', HILLSIDE, 'peer-hillside', 'listedhill.example', HILL_LOST)]);
    vi.stubGlobal('fetch', async (url: string) => {
        const said = phone.info.get(new URL(url).origin);
        if (!said) throw new Error('no answer');
        return new Response(JSON.stringify(said), { status: 200 });
    });
});

/** Every across chat on the phone, by file. */
const onDisk = () => [...phone.files].flatMap(([file, chats]) => [...chats.values()].map((c) => ({ file, ...c })));

/** Whose the address is NOW. */
type Who = 'in use' | 'held' | 'foreign';
/** `but`: where it goes on a guest's look instead of WANT, by chats: this phone's copy of the held community has them, so in place. */
const ADDRESSES: Array<{ name: string; who: Who; url: string; server?: keyof typeof SERVERS; but?: Record<string, string> }> = [
    { name: 'in use, its main', who: 'in use', url: RIVERSIDE },
    { name: 'in use, its older main (the record)', who: 'in use', url: 'https://oldriver.example' },
    { name: 'in use, another of its names (its info)', who: 'in use', url: 'https://river.example' },
    { name: 'in use, a name it had before (its info)', who: 'in use', url: 'https://formerriver.example' },
    { name: 'in use, on its signed list', who: 'in use', url: 'https://listedriver.example' },
    { name: 'held, its main', who: 'held', url: HILLSIDE },
    { name: 'held, its older main (the record)', who: 'held', url: 'https://oldhill.example' },
    { name: 'held, another of its names (its info)', who: 'held', url: 'https://hill.example' },
    { name: 'held, a name it had before (its info)', who: 'held', url: 'https://formerhill.example' },
    { name: 'held, on its signed list', who: 'held', url: 'https://listedhill.example' },
    { name: 'a name the one in use lost, to another community (the record still holds it)', who: 'foreign', url: 'https://lostriver.example', server: 'lakeside' },
    { name: 'a name the one in use lost, to the held one (an older server still lists it as former)', who: 'held', url: 'https://takenriver.example' },
    { name: 'a name the held one lost, to another community (the record still holds it)', who: 'foreign', url: 'https://losthill.example', server: 'lakeside', but: { 'across, to a held community': 'held' } },
    { name: 'a name the held one lost, to the one in use (an older server still lists it as former)', who: 'in use', url: 'https://takenhill.example' },
    { name: 'another community', who: 'foreign', url: FARAWAY },
];
const HOME_OF: Record<Who, 'riverside' | 'hillside' | 'faraway'> = { 'in use': 'riverside', held: 'hillside', foreign: 'faraway' };
const dm = (id: string) => ({ id, type: 'dm', peerPubkey: K, peerKeys: [K] });
/** An across chat with them in `file`, its lines going to `home`: they are a member where that is. */
const across = (file: string, home: string, state: 'open' | 'request' | 'declined' = 'open') => () => {
    phone.files.set(file, new Map([[ACROSS_ID, { id: ACROSS_ID, peerKey: K, peerHome: home, peerName: 'Ana', state }]]));
    serverNamed(home)!.members.add(K);
};

/**
 * Where Message goes, by (chats) x (whose address: in use / held / another community), written by hand for each state of the
 * community in use. here: the direct chat here (an existing one, or started). held: in place in the held community. open /
 * openHeld: the chat across that exists, in the file in use / the held community's. new: one made across from the link.
 * off (no-home where that is why) / no-community: refused.
 */
const STATES = {
    'a member\'s, takes messages across': { guest: false, on: true, home: true, column: 0, off: 'off' },
    'a member\'s, takes none across': { guest: false, on: false, home: true, column: 1, off: 'off' },
    'a member\'s, its switch on, no address of its own to send from': { guest: false, on: true, home: false, column: 1, off: 'no-home' },
    'a guest\'s look, takes messages across': { guest: true, on: true, home: true, column: 2, off: 'off' },
    'a guest\'s look, takes none across': { guest: true, on: false, home: true, column: 2, off: 'off' },
} as const;
const CHATS: Record<string, { set: () => void; WANT: [string, string, string] }> = {
    //                                                                                   member, on              member, off             a guest's look
    'none': { set: () => {}, WANT: ['here held new', 'here held off', 'no-community held no-community'] },
    'direct here': { set: () => { phone.directHere = [dm('d-here')]; SERVERS.riverside.members.add(K); }, WANT: ['here here here', 'here here here', 'here here here'] },
    'direct held': { set: () => { phone.directHeld = [dm('d-held')]; SERVERS.hillside.members.add(K); }, WANT: ['held held held', 'held held held', 'held held held'] },
    'across, open': { set: across(RIVERSIDE, 'faraway.example'), WANT: ['open open open', 'here held off', 'no-community held no-community'] },
    'across, a request': { set: across(RIVERSIDE, 'faraway.example', 'request'), WANT: ['open open open', 'here held off', 'no-community held no-community'] },
    'across, declined': { set: across(RIVERSIDE, 'faraway.example', 'declined'), WANT: ['here held new', 'here held off', 'no-community held no-community'] },
    'across, dead: its home is an older main here': { set: across(RIVERSIDE, 'oldriver.example'), WANT: ['here held here', 'here held here', 'no-community held no-community'] },
    'across, dead: its home is another name here': { set: across(RIVERSIDE, 'river.example'), WANT: ['here held here', 'here held here', 'no-community held no-community'] },
    // In the community in use too (its link): where they are, so the direct chat here.
    'across, open: its home is a name the one in use lost': { set: across(RIVERSIDE, 'lostriver.example'), WANT: ['here open open', 'here held off', 'no-community held no-community'] },
    'across, to a held community': { set: across(RIVERSIDE, 'oldhill.example'), WANT: ['here held held', 'here held held', 'no-community held no-community'] },
    'across in the held file, open': { set: across(HILLSIDE, 'faraway.example'), WANT: ['openHeld openHeld openHeld', 'openHeld openHeld openHeld', 'openHeld openHeld openHeld'] },
    'across in the held file, a request': { set: across(HILLSIDE, 'faraway.example', 'request'), WANT: ['openHeld openHeld openHeld', 'openHeld openHeld openHeld', 'openHeld openHeld openHeld'] },
    'across in the held file, declined': { set: across(HILLSIDE, 'faraway.example', 'declined'), WANT: ['here held new', 'here held off', 'no-community held no-community'] },
    'across in the held file, dead: its home is another name there': { set: across(HILLSIDE, 'hill.example'), WANT: ['here held held', 'here held held', 'held held held'] },
    'across in the held file, open, the held community takes none': {
        set: () => { across(HILLSIDE, 'faraway.example')(); SERVERS.hillside.takesAcross = false; }, WANT: ['here held new', 'here held off', 'no-community held no-community'] },
    'across in the held file, open, the held community has no address of its own to send from': {
        set: () => { across(HILLSIDE, 'faraway.example')(); SERVERS.hillside.home = false; }, WANT: ['here held new', 'here held off', 'no-community held no-community'] },
};
const WHO: Who[] = ['in use', 'held', 'foreign'];
const BLOCKS = {
    'blocked on the phone\'s list': { set: () => { phone.blocked = [K]; }, refused: true },
    'blocked only on another community\'s own list': { set: () => { phone.seenThere = [K]; }, refused: false },
    'no block': { set: () => {}, refused: false },
} as const;

const ROWS = ADDRESSES.flatMap((address) => Object.entries(CHATS).flatMap(([chats, { set, WANT }]) => Object.entries(STATES).flatMap(([state, s]) =>
    Object.entries(BLOCKS).map(([block, b]) => ({
        row: `${address.name} x ${chats} x ${state} x ${block}`, address, set, state: s, block: b,
        want: b.refused ? 'blocked' : s.guest && address.but?.[chats] ? address.but[chats] : ((code) => (code === 'off' ? s.off : code))(WANT[s.column].split(' ')[WHO.indexOf(address.who)]),
    })))));

describe('Message on the phone: where it goes, and a line can go from there', () => {
    it('the table is the whole of it: every address, chat, state and block', () => {
        expect(ROWS.length).toBe(15 * 16 * 5 * 3);
    });

    // Named in full: a title made by it.each is cut short.
    for (const { row, address, set, state, block, want } of ROWS) it(row, async () => {
        SERVERS[address.server ?? HOME_OF[address.who]].members.add(K);
        SERVERS.riverside.takesAcross = state.on;
        SERVERS.riverside.home = state.home;
        if (state.guest) {
            SERVERS.riverside.members.delete(ME);
            phone.store.set('beanpool_guest_nodes', JSON.stringify([RIVERSIDE]));
        }
        set();
        saysNow();
        kept();
        block.set();
        const before = onDisk();
        const got = await message([{ community: address.url, key: K, name: 'Ana' }]);
        expect(got.at === 'refused' ? got.why : got.at).toBe(want);
        if (got.at !== 'refused') expect(whyNotWritable(got)).toBeNull();
        // Nothing is made or reopened but the chat across it opens.
        if (got.at !== 'new') expect(onDisk()).toEqual(before);
    });

    it('where each target opens: the chat here, in place, or across in the file that carries it', async () => {
        saysNow(); kept();
        phone.directHere = [dm('d-here')]; SERVERS.riverside.members.add(K);
        expect((await message([{ community: FARAWAY, key: K }]) as { route: unknown }).route).toBe('/chat/d-here');
        phone.directHere = []; phone.directHeld = [dm('d-held')];
        expect((await message([{ community: FARAWAY, key: K }]) as { route: unknown }).route).toEqual({ pathname: '/chat/[id]', params: { id: 'd-held', community: HILLSIDE, communityName: 'Hillside' } });
        phone.directHeld = []; across(RIVERSIDE, 'faraway.example')();
        expect((await message([{ community: FARAWAY, key: K }]) as { route: unknown }).route).toBe(`/outside-chat/${ACROSS_ID}`);
        phone.files.clear(); across(HILLSIDE, 'faraway.example')();
        expect((await message([{ community: FARAWAY, key: K }]) as { route: unknown }).route).toBe(`/outside-chat/${ACROSS_ID}?community=${encodeURIComponent(HILLSIDE)}`);
    });
});

describe('Message on the phone: what the table\'s fixed world cannot hold', () => {
    const at = (url: string): MessageLink[] => [{ community: url, key: K, name: 'Ana' }];
    const word = (t: Target) => (t.at === 'refused' ? t.why : t.at);
    const made = () => [...(phone.files.get(RIVERSIDE)?.values() ?? [])];

    it('the review\'s own steps: a contact at an older main, then New message on the same person, then Contacts again: the direct chat here each time, and no chat across made', async () => {
        saysNow(); kept(); SERVERS.riverside.members.add(K);
        for (const url of [RIVERSIDE, 'https://oldriver.example', RIVERSIDE, 'https://oldriver.example']) expect(word(await message(at(url)))).toBe('here');
        expect(made()).toEqual([]);
    });

    it('an address the community took on since this phone last heard (its info asked as the chat is made): the direct chat here, nothing made', async () => {
        saysNow(); kept(); SERVERS.riverside.members.add(K);
        SERVERS.riverside.names.push('newriver.example');
        TOLD.riverside.addresses.push('newriver.example');
        saysNow();
        const got = await message(at('https://newriver.example'));
        expect(word(got)).toBe('here');
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
        expect(made()).toEqual([]);
    });

    it('the switch turned off since this phone last heard: refused as the chat is made, nothing made', async () => {
        saysNow(); kept(); SERVERS.faraway.members.add(K);
        SERVERS.riverside.takesAcross = false;
        saysNow();
        expect(word(await message(at(FARAWAY)))).toBe('off');
        expect(made()).toEqual([]);
    });

    it('turned on since: made', async () => {
        SERVERS.riverside.takesAcross = false;
        saysNow(); kept(); SERVERS.faraway.members.add(K);
        SERVERS.riverside.takesAcross = true;
        saysNow();
        const got = await message(at(FARAWAY));
        expect(word(got)).toBe('new');
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
    });

    it.each([
        { name: 'no answer now: what this phone keeps decides (an older main)', url: 'https://river.example', keep: true, want: 'here' },
        { name: 'no answer now: what this phone keeps decides (another community)', url: FARAWAY, keep: true, want: 'new' },
        { name: 'no answer now and nothing kept: no chat across is made', url: FARAWAY, keep: false, want: 'off' },
    ])('$name', async ({ url, keep, want }) => {
        saysNow();
        if (keep) kept();
        phone.info.clear();
        SERVERS.riverside.members.add(K); SERVERS.faraway.members.add(K);
        expect(word(await message(at(url)))).toBe(want);
        if (want !== 'new') expect(made()).toEqual([]);
    });

    it('a chat across already open in a community this phone never heard its switch of: it still opens', async () => {
        across(RIVERSIDE, 'faraway.example')();
        expect(word(await message(at(FARAWAY)))).toBe('open');
    });

    it('the community in use saved a second time under its older main: it is not a held community (never started in place there)', async () => {
        saysNow(); kept(); SERVERS.riverside.members.add(K);
        for (const url of ['https://oldriver.example', RIVERSIDE, 'https://river.example']) {
            expect(word(await message(at(url), ['https://oldriver.example', HILLSIDE]))).toBe('here');
        }
    });

    it('a held community saved under two of its addresses is one: in place at the first', async () => {
        saysNow(); kept(); SERVERS.hillside.members.add(K);
        expect(await message(at('https://oldhill.example'), [HILLSIDE, 'https://oldhill.example'])).toMatchObject({ at: 'held', route: HILLSIDE });
    });

    it('a held community that says another\'s address is its own takes no contact of the community in use', async () => {
        TOLD.hillside.addresses.push('riverside.example');
        saysNow(); kept(); SERVERS.riverside.members.add(K);
        expect(word(await message(at(RIVERSIDE)))).toBe('here');
    });

    it('the community in use says a held community\'s address is its own: that community\'s contact is there still, in place', async () => {
        TOLD.riverside.addresses.push('hillside.example', 'oldhill.example');
        saysNow(); kept(); SERVERS.hillside.members.add(K);
        for (const url of [HILLSIDE, 'https://oldhill.example']) expect(await message(at(url))).toMatchObject({ at: 'held', route: HILLSIDE });
    });

    it('a held community that says an address that answered this phone as something else: across, as anyone there', async () => {
        saysNow();
        (phone.info.get(HILLSIDE) as { addresses: string[] }).addresses.push('faraway.example');
        kept();
        setCommunityIndex([record('https://oldriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example'),
            { ...record('https://oldhill.example', HILLSIDE, 'peer-hillside', 'listedhill.example'), refused: { 'https://faraway.example': { at: 1, why: 'status 404' } } }]);
        SERVERS.faraway.members.add(K);
        const got = await message(at(FARAWAY));
        expect(word(got)).toBe('new');
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
    });

    it('the community in use says an address that answered this phone as something else: its server still refuses a line there, so the direct chat here', async () => {
        saysNow(); kept();
        setCommunityIndex([{ ...record('https://oldriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example'), refused: { 'https://river.example': { at: 1, why: 'status 404' } } }]);
        SERVERS.riverside.members.add(K);
        expect(word(await message(at('https://river.example')))).toBe('here');
    });

    it('a declined chat kept with an older main of the community in use, the contact in another community: opened again, its lines going there', async () => {
        saysNow(); kept();
        across(RIVERSIDE, 'oldriver.example', 'declined')();
        SERVERS.faraway.members.add(K);
        const got = await message(at(FARAWAY));
        expect(word(got)).toBe('new');
        expect(made()).toEqual([expect.objectContaining({ id: ACROSS_ID, peerHome: 'faraway.example', state: 'open' })]);
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
    });

    it('a dead chat here and one that can be written in, in the held file: that one', async () => {
        saysNow(); kept();
        across(RIVERSIDE, 'oldriver.example')(); across(HILLSIDE, 'faraway.example')();
        const got = await message(at(RIVERSIDE));
        expect(word(got)).toBe('openHeld');
        expect(whyNotWritable(got as Exclude<Target, { at: 'refused' }>)).toBeNull();
    });

    // ── a name a community lost (round 5) ──
    const nowhere = (t: Target) => (t.at === 'refused' ? null : whyNotWritable(t));

    it('a name the community in use lost, its server listing it no more: across, from the link, to the community that holds it now', async () => {
        SERVERS.lakeside.names.push('givenup.example'); SERVERS.lakeside.members.add(K);
        saysNow(); kept();
        const got = await message(at('https://givenup.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
        expect(made()).toEqual([expect.objectContaining({ peerHome: 'givenup.example' })]);
    });

    it('the address the phone first met the community at, lost since: across to the one that holds it now', async () => {
        setCommunityIndex([record('https://metriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example')]);
        SERVERS.lakeside.names.push('metriver.example'); SERVERS.lakeside.members.add(K);
        saysNow(); kept();
        const got = await message(at('https://metriver.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
    });

    it('the same, the person a member of the community in use by this phone\'s copy: the direct chat here', async () => {
        setCommunityIndex([record('https://metriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example')]);
        SERVERS.riverside.members.add(K);
        saysNow(); kept();
        const got = await message(at('https://metriver.example'));
        expect(word(got)).toBe('here');
        expect(nowhere(got)).toBeNull();
        expect(await openAcrossChat({ key: K, home: 'metriver.example', name: 'Ana' })).toEqual({ here: K });
        expect(made()).toEqual([]);
    });

    it('a copy that cannot be read says nothing of who is there: across', async () => {
        setCommunityIndex([record('https://metriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example')]);
        SERVERS.lakeside.names.push('metriver.example'); SERVERS.lakeside.members.add(K);
        saysNow(); kept();
        phone.copyOf = () => { throw new Error('no copy'); };
        expect(word(await message(at('https://metriver.example')))).toBe('new');
    });

    it('nothing heard of the community\'s own names: the record is all there is, and it says here', async () => {
        SERVERS.riverside.members.add(K);
        phone.copyOf = () => new Set();
        expect(word(await message(at('https://oldriver.example')))).toBe('here');
    });

    it('nothing heard, and the address answered this phone as something else: not here, and with no info no chat across is made', async () => {
        setCommunityIndex([{ ...record('https://metriver.example', RIVERSIDE, 'peer-riverside', 'listedriver.example'), refused: { 'https://metriver.example': { at: 1, why: 'key' } } }]);
        phone.copyOf = () => new Set();
        expect(word(await message(at('https://metriver.example')))).toBe('off');
        expect(made()).toEqual([]);
    });

    it('a name an older server lists as former that a held community goes by now: never the community in use, asked as the chat is made and by the address card', async () => {
        saysNow(); kept(); SERVERS.hillside.members.add(K);
        expect(await namesCommunityInUse(RIVERSIDE, 'takenriver.example', K)).toBe(false);
        expect(await namesCommunityInUse(RIVERSIDE, 'lostriver.example', K)).toBe(false);
        expect(await namesCommunityInUse(RIVERSIDE, 'formerriver.example', K)).toBe(true);
        expect(await openAcrossChat({ key: K, home: 'takenriver.example', name: 'Ana' })).not.toEqual({ here: K });
    });

    it('two communities that each had a name before, neither going by it now: the one in use', async () => {
        TOLD.hillside.formerAddresses.push('formerriver.example');
        saysNow(); kept(); SERVERS.riverside.members.add(K);
        const got = await message(at('https://formerriver.example'));
        expect(word(got)).toBe('here');
        expect(nowhere(got)).toBeNull();
    });

    // ── a community that knows no address of its own (round 5) ──
    it.each([
        { name: 'it publishes none of its own addresses', says: { addresses: [], primaryAddress: null, formerAddresses: [] } },
        { name: 'it publishes none and says no main (an older server)', says: { addresses: [], formerAddresses: [] } },
        { name: 'its only name waits for a route', says: { addresses: ['riverside.example'], primaryAddress: null, formerAddresses: [] } },
    ])('$name, its switch on: no chat across is made, and one there is not picked', async ({ says }) => {
        SERVERS.faraway.members.add(K); SERVERS.riverside.home = false;
        phone.info.set(RIVERSIDE, { profile: 'local', features: { outsideMessages: true }, ...says });
        kept();
        expect(word(await message(at(FARAWAY)))).toBe('no-home');
        expect(made()).toEqual([]);
        across(RIVERSIDE, 'faraway.example')();
        expect(word(await message(at(FARAWAY)))).toBe('no-home');
        SERVERS.riverside.members.add(K);
        expect(word(await message(at(RIVERSIDE)))).toBe('here');
    });

    it('heard only as the chat is made: refused, nothing made', async () => {
        saysNow(); kept(); SERVERS.faraway.members.add(K);
        SERVERS.riverside.home = false;
        saysNow();
        expect(word(await message(at(FARAWAY)))).toBe('no-home');
        expect(made()).toEqual([]);
    });

    it.each([
        { name: 'an older server that says nothing of its addresses', says: {} },
        { name: 'one whose main is an address this phone keeps none of (an IPv6 number)', says: { addresses: ['[2001:db8::1]'], primaryAddress: '[2001:db8::1]', formerAddresses: [] } },
    ])('$name: not known to have none, so made, and picked when there', async ({ says }) => {
        SERVERS.faraway.members.add(K);
        phone.info.set(RIVERSIDE, { profile: 'local', features: { outsideMessages: true }, ...says });
        kept();
        expect(word(await message(at(FARAWAY)))).toBe('new');
        expect(word(await message(at(FARAWAY)))).toBe('open');
    });

    it('several links: the community in use by another of its names before a held one; the key is that link\'s', async () => {
        saysNow(); kept();
        const K2 = 'c3'.repeat(32);
        SERVERS.riverside.members.add(K2); SERVERS.hillside.members.add(K);
        expect(await message([{ community: HILLSIDE, key: K }, { community: 'https://oldriver.example', key: K2 }])).toMatchObject({ at: 'here', key: K2 });
    });
});
