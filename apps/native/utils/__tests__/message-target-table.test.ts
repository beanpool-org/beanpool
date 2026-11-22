/**
 * Message on the phone, one exhaustive table (#3354 review, round 4: every round had found one more chat Message opened that
 * the member could not write in, so the class is closed here): (the contact's address: the community in use and a held one, at
 * its main, an older main, another of its names, one it had before, one on its signed list only; a name either of them LOST, to
 * a community the phone does not hold or to the other one, still on this phone's copies of it; one two of them say is theirs;
 * another community) x (what they answer now: what their names are / nothing) x (the chats there are: none, direct here, direct
 * held, across open / request / declined, across dead because its person is here, across to a held community or to a lost
 * name, and the same in a held community's file) x (the community in use: a member's or a guest's look, taking messages from
 * other communities or not, or with no address of its own to send from) x (a block: on the phone's list, seen only on another
 * community's own list, none) -> where Message goes, as Contacts and New message go there (utils/message-anyone.ts).
 *
 * The wanted targets are written out by hand (WANT, and each address's `who` and `quiet`), never worked out by the rule: they
 * are the precedence the review gives. What a community answers now decides; with no answer the copies count only where the
 * signed list, the record and the last info agree; anything else is unsure, and unsure opens nothing but a chat there is
 * already: it offers to switch to that address (`switch`). Every row that opens a chat is also asked of SERVERS, a model of what
 * each community's server takes, that shares no code with the rule: the chat it ends in must be one a line can go from now, to
 * a server that has this person. A `switch` must offer an address whose server has them. SERVERS, what a community ANSWERS and
 * what this phone KEEPS of it are three tables, each written out (round 5: the names a server answers as were made from the
 * list it publishes; round 6: no lost name was ever on the kept signed list, so the list was a way in that no row asked).
 * Then rows for what the table's fixed world can't hold: info heard only now, a saved row of the same community, a community
 * that claims another's address.
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
import { cardRefusal, existingChatRoute, messagePathOnPhone, openAcrossChat } from '../message-anyone';
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

/** Where a tap ended, and the chat it ended in; or what it offered instead: to switch to `address`. */
type Opened =
    | { at: 'here' | 'held'; existing: boolean; key: string; route: unknown }
    | { at: 'new' | 'open' | 'openHeld'; chat: string; key: string; route: unknown };
type Target = Opened | { at: 'switch'; address: string } | { at: 'refused'; why: string };

/** Why no line can go from `t` now, or null when one can; for an offer, why it leads to no one, or null when it does. */
function whyNotWritable(t: Opened | { at: 'switch'; address: string }): string | null {
    if (t.at === 'switch') return serverNamed(hostOf(t.address))?.members.has(K) ? null : 'the address offered leads to a server that does not have them';
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
    if (path.open === 'switch') return { at: 'switch', address: path.community };
    if (path.open === 'existing') {
        const route = existingChatRoute(path.chat, anchor, () => 'Hillside');
        if (path.chat.kind === 'across') return { at: path.chat.community ? 'openHeld' : 'open', chat: path.chat.id, key: path.chat.key, route };
        return { at: typeof route === 'string' ? 'here' : 'held', existing: true, key: path.chat.key, route };
    }
    if (path.open === 'shared') return { at: path.community === anchor ? 'here' : 'held', existing: false, key: path.key, route: path.community };
    const opened = await openAcrossChat(path);
    if ('chatId' in opened) return { at: 'new', chat: opened.chatId, key: path.key, route: opened.chatId };
    if ('here' in opened) return { at: 'here', existing: false, key: opened.here, route: anchor };
    return opened.refused === 'uncertain' ? { at: 'switch', address: `https://${path.home}` } : { at: 'refused', why: opened.refused };
}

// ── The table's world ────────────────────────────────────────────────────────────────────────────────────────────────
/** The phone's record of a community: where it met it (`id`), the address in use, each it proved, and its signed list as last seen (null: none). */
const record = (id: string, using: string, peerId: string, list: string[] | null, proved: string[] = []): CommunityRecord => ({
    ...makeCommunityRecord(id, { peerId, communityId: peerId, epoch: 1 }), using, proved: Object.fromEntries(proved.map((a) => [`https://${a}`, { at: 1, epoch: 1 }])),
    ...(list ? { list: { list: { peerId, addresses: [hostOf(using), ...list] }, sig: '' } as unknown as CommunityRecord['list'] } : {}),
});
/**
 * What each community answers of its own names now (its info), written out, never read from SERVERS: every name its server
 * answers as, as a real server lists them. Both are servers from before round 5 for the names taken*: each still lists as a
 * name it had before one it lost, which the other goes by now.
 */
interface Told { addresses: string[]; primaryAddress: string | null; formerAddresses: string[] }
let TOLD: Record<'riverside' | 'hillside', Told>;
/** What each said when this phone last heard its info; its signed list (LISTS) and its record (PROVED) are older or newer, each as it was then. */
const KEPT: Record<'riverside' | 'hillside', Told> = {
    riverside: { addresses: ['riverside.example', 'oldriver.example', 'river.example', 'goneriver.example', 'wentriver.example', 'wenthill.example', 'takenhill.example'], primaryAddress: 'riverside.example', formerAddresses: ['beforeriver.example', 'takenriver.example'] },
    hillside: { addresses: ['hillside.example', 'oldhill.example', 'hill.example', 'gonehill.example', 'wenthill.example', 'wentriver.example', 'takenriver.example'], primaryAddress: 'hillside.example', formerAddresses: ['beforehill.example', 'takenhill.example'] },
};
const LISTS = {
    riverside: ['oldriver.example', 'river.example', 'listedriver.example', 'lostriver.example', 'goneriver.example', 'wentriver.example'],
    hillside: ['oldhill.example', 'hill.example', 'listedhill.example', 'losthill.example', 'gonehill.example', 'wenthill.example'],
};
const PROVED = {
    riverside: ['beforeriver.example', 'lostriver.example', 'goneriver.example', 'wentriver.example'],
    hillside: ['beforehill.example', 'losthill.example', 'gonehill.example', 'wenthill.example'],
};
const infoOf = (server: Server, told: Told) => ({
    profile: 'local', features: { outsideMessages: server.takesAcross }, checkedAt: '2026-11-22T00:00:00.000Z',
    addresses: [...told.addresses], primaryAddress: server.home ? told.primaryAddress : null, formerAddresses: [...told.formerAddresses],
});
/** What each answers, asked now. */
function saysNow(): void {
    phone.info.set(RIVERSIDE, infoOf(SERVERS.riverside, TOLD.riverside));
    phone.info.set(HILLSIDE, infoOf(SERVERS.hillside, TOLD.hillside));
}
const keep = (infos: Iterable<[string, unknown]>) =>
    phone.store.set('beanpool_node_profiles', JSON.stringify(Object.fromEntries([...infos].map(([at, said]) => [at, readNodeProfile(said)]))));
/** As this phone last heard each (node-profile.ts): the table's own KEPT. */
const kept = () => keep([[RIVERSIDE, infoOf(SERVERS.riverside, KEPT.riverside)], [HILLSIDE, infoOf(SERVERS.hillside, KEPT.hillside)]]);
/** This phone heard what each answers now. */
const heard = () => keep(phone.info);

const RECORDS = () => [record('https://oldriver.example', RIVERSIDE, 'peer-riverside', LISTS.riverside, PROVED.riverside),
    record('https://oldhill.example', HILLSIDE, 'peer-hillside', LISTS.hillside, PROVED.hillside)];

beforeEach(() => {
    phone.store.clear();
    phone.blocked = []; phone.seenThere = []; phone.directHere = []; phone.directHeld = [];
    phone.files.clear(); phone.info.clear();
    SERVERS = {
        riverside: { names: ['riverside.example', 'oldriver.example', 'river.example', 'listedriver.example', 'beforeriver.example', 'wenthill.example', 'takenhill.example'], takesAcross: true, home: true, members: new Set([ME]) },
        hillside: { names: ['hillside.example', 'oldhill.example', 'hill.example', 'listedhill.example', 'beforehill.example', 'wentriver.example', 'takenriver.example'], takesAcross: true, home: true, members: new Set([ME]) },
        faraway: { names: ['faraway.example'], takesAcross: true, home: true, members: new Set() },
        lakeside: { names: ['lakeside.example', 'lostriver.example', 'losthill.example', 'goneriver.example', 'gonehill.example'], takesAcross: true, home: true, members: new Set() },
    };
    TOLD = {
        riverside: { addresses: ['riverside.example', 'oldriver.example', 'river.example', 'listedriver.example', 'wenthill.example', 'takenhill.example'], primaryAddress: 'riverside.example', formerAddresses: ['beforeriver.example', 'takenriver.example'] },
        hillside: { addresses: ['hillside.example', 'oldhill.example', 'hill.example', 'listedhill.example', 'wentriver.example', 'takenriver.example'], primaryAddress: 'hillside.example', formerAddresses: ['beforehill.example', 'takenhill.example'] },
    };
    phone.copyOf = (community) => Object.values(SERVERS).find((s) => s.names.includes(hostOf(community)))?.members ?? new Set();
    phone.store.set('beanpool_anchor_url', RIVERSIDE);
    phone.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE, alias: 'Riverside' }, { url: HILLSIDE, alias: 'Hillside' }]));
    resetCommunityIndexForTests();
    // Both moved to a new main address once, and the phone followed each (addresses S4).
    setCommunityIndex(RECORDS());
    vi.stubGlobal('fetch', async (url: string) => {
        const said = phone.info.get(new URL(url).origin);
        if (!said) throw new Error('no answer');
        return new Response(JSON.stringify(said), { status: 200 });
    });
});

/** Every across chat on the phone, by file. */
const onDisk = () => [...phone.files].flatMap(([file, chats]) => [...chats.values()].map((c) => ({ file, ...c })));

/** Whose the address is, as far as the phone can say: one of the two it holds, neither's, or not known for certain. */
type Who = 'in use' | 'held' | 'foreign' | 'unsure';
/** The chats that put the person in a copy this phone keeps: with a name that community lost, where they are is then in doubt. */
const IN_RIVERSIDE = ['direct here', 'across, dead: its home is an older main here', 'across, dead: its home is another name here'];
const IN_HILLSIDE = ['direct held', 'across, to a held community', 'across, to a name two say is theirs', 'across in the held file, dead: its home is another name there'];
/**
 * `who`: whose it is by what they answer now. `quiet`: by what this phone keeps when neither answers (left out: not in the
 * quiet rows, below the table). `server`: the server that has the person, where it isn't `who`'s. `doubt`: the chats with which
 * it is unsure though they answer (the person has a row in the copy of the community that lost it). Kept, for each: R the
 * record, L the signed list, I the last info.
 */
const ADDRESSES: Array<{ name: string; who: Who; quiet?: Who; url: string; server?: keyof typeof SERVERS; doubt?: string[] }> = [
    { name: 'in use, its main', who: 'in use', quiet: 'in use', url: RIVERSIDE },
    { name: 'in use, an older main (R L I)', who: 'in use', quiet: 'in use', url: 'https://oldriver.example' },
    { name: 'in use, another of its names (L I)', who: 'in use', quiet: 'unsure', url: 'https://river.example', server: 'riverside' },
    { name: 'in use, a name it had before (R I)', who: 'in use', quiet: 'unsure', url: 'https://beforeriver.example', server: 'riverside' },
    { name: 'in use, taken on since its info was heard (L)', who: 'in use', quiet: 'unsure', url: 'https://listedriver.example', server: 'riverside' },
    { name: 'held, its main', who: 'held', quiet: 'held', url: HILLSIDE },
    { name: 'held, an older main (R L I)', who: 'held', quiet: 'held', url: 'https://oldhill.example' },
    { name: 'held, another of its names (L I)', who: 'held', quiet: 'unsure', url: 'https://hill.example', server: 'hillside' },
    { name: 'held, a name it had before (R I)', who: 'held', quiet: 'unsure', url: 'https://beforehill.example', server: 'hillside' },
    { name: 'held, taken on since its info was heard (L)', who: 'held', quiet: 'unsure', url: 'https://listedhill.example', server: 'hillside' },
    { name: 'a name the one in use lost, to another community, its info heard since (R L)', who: 'foreign', quiet: 'unsure', url: 'https://lostriver.example', server: 'lakeside', doubt: IN_RIVERSIDE },
    { name: 'a name the one in use lost, to another community, nothing heard since (R L I)', who: 'foreign', url: 'https://goneriver.example', server: 'lakeside', doubt: IN_RIVERSIDE },
    { name: 'a name the held one lost, to another community, its info heard since (R L)', who: 'foreign', quiet: 'unsure', url: 'https://losthill.example', server: 'lakeside', doubt: IN_HILLSIDE },
    { name: 'a name the held one lost, to another community, nothing heard since (R L I)', who: 'foreign', url: 'https://gonehill.example', server: 'lakeside', doubt: IN_HILLSIDE },
    { name: 'a name the one in use lost, to the held one (R L I; the held one\'s I)', who: 'held', quiet: 'unsure', url: 'https://wentriver.example', server: 'hillside', doubt: IN_RIVERSIDE },
    { name: 'a name the held one lost, to the one in use (R L I; the one in use\'s I)', who: 'in use', quiet: 'unsure', url: 'https://wenthill.example', server: 'riverside', doubt: IN_HILLSIDE },
    { name: 'two say it: the held one goes by it, the one in use lists it as a name it had (an older server)', who: 'unsure', quiet: 'unsure', url: 'https://takenriver.example', server: 'hillside' },
    { name: 'two say it: the one in use goes by it, the held one lists it as a name it had (an older server)', who: 'unsure', quiet: 'unsure', url: 'https://takenhill.example', server: 'riverside' },
    { name: 'another community', who: 'foreign', quiet: 'foreign', url: FARAWAY },
];
const HOME_OF: Record<Who, 'riverside' | 'hillside' | 'faraway'> = { 'in use': 'riverside', held: 'hillside', foreign: 'faraway', unsure: 'faraway' };
const dm = (id: string) => ({ id, type: 'dm', peerPubkey: K, peerKeys: [K] });
/** An across chat with them in `file`, its lines going to `home`: they are a member where that is. */
const across = (file: string, home: string, state: 'open' | 'request' | 'declined' = 'open') => () => {
    phone.files.set(file, new Map([[ACROSS_ID, { id: ACROSS_ID, peerKey: K, peerHome: home, peerName: 'Ana', state }]]));
    serverNamed(home)!.members.add(K);
};

/**
 * Where Message goes, by (chats) x (whose address: in use / held / another community / unsure), written by hand for each state
 * of the community in use. here: the direct chat here (an existing one, or started). held: in place in the held community. open
 * / openHeld: the chat across that exists, in the file in use / the held community's. new: one made across from the link.
 * switch: nothing opens; to switch to the link's address is offered. off (no-home where that is why) / no-community: refused.
 * QUIET: the same where neither answers and the chat's own home is then unsure (left out: as WANT).
 */
const STATES = {
    'a member\'s, takes messages across': { guest: false, on: true, home: true, column: 0, off: 'off' },
    'a member\'s, takes none across': { guest: false, on: false, home: true, column: 1, off: 'off' },
    'a member\'s, its switch on, no address of its own to send from': { guest: false, on: true, home: false, column: 1, off: 'no-home' },
    'a guest\'s look, takes messages across': { guest: true, on: true, home: true, column: 2, off: 'off' },
    'a guest\'s look, takes none across': { guest: true, on: false, home: true, column: 2, off: 'off' },
} as const;
type Wants = [string, string, string];
const NONE: Wants = ['here held new switch', 'here held off switch', 'no-community held no-community switch'];
const ALL = (one: string): Wants => [0, 1, 2].map(() => Array(4).fill(one).join(' ')) as Wants;
const CHATS: Record<string, { set: () => void; WANT: Wants; QUIET?: Wants }> = {
    //              member, on / member, off / a guest's look
    'none': { set: () => {}, WANT: NONE },
    'direct here': { set: () => { phone.directHere = [dm('d-here')]; SERVERS.riverside.members.add(K); }, WANT: ALL('here') },
    'direct held': { set: () => { phone.directHeld = [dm('d-held')]; SERVERS.hillside.members.add(K); }, WANT: ALL('held') },
    'across, open': { set: across(RIVERSIDE, 'faraway.example'), WANT: ['open open open open', NONE[1], NONE[2]] },
    'across, a request': { set: across(RIVERSIDE, 'faraway.example', 'request'), WANT: ['open open open open', NONE[1], NONE[2]] },
    'across, declined': { set: across(RIVERSIDE, 'faraway.example', 'declined'), WANT: NONE },
    'across, dead: its home is an older main here': { set: across(RIVERSIDE, 'oldriver.example'), WANT: ['here held here here', 'here held here here', NONE[2]] },
    'across, dead: its home is another name here': { set: across(RIVERSIDE, 'river.example'), WANT: ['here held here here', 'here held here here', NONE[2]], QUIET: NONE },
    'across, open: its home is a name the one in use lost': { set: across(RIVERSIDE, 'lostriver.example'), WANT: ['open open open open', NONE[1], NONE[2]], QUIET: NONE },
    'across, to a held community': { set: across(RIVERSIDE, 'oldhill.example'), WANT: ['here held held held', 'here held held held', NONE[2]] },
    'across, to a name two say is theirs': { set: across(RIVERSIDE, 'takenriver.example'), WANT: NONE },
    'across in the held file, open': { set: across(HILLSIDE, 'faraway.example'), WANT: ALL('openHeld') },
    'across in the held file, a request': { set: across(HILLSIDE, 'faraway.example', 'request'), WANT: ALL('openHeld') },
    'across in the held file, declined': { set: across(HILLSIDE, 'faraway.example', 'declined'), WANT: NONE },
    'across in the held file, dead: its home is another name there': { set: across(HILLSIDE, 'hill.example'), WANT: ['here held held held', 'here held held held', 'held held held held'], QUIET: NONE },
    'across in the held file, open, the held community takes none': { set: () => { across(HILLSIDE, 'faraway.example')(); SERVERS.hillside.takesAcross = false; }, WANT: NONE },
    'across in the held file, open, the held community has no address of its own to send from': { set: () => { across(HILLSIDE, 'faraway.example')(); SERVERS.hillside.home = false; }, WANT: NONE },
};
const WHO: Who[] = ['in use', 'held', 'foreign', 'unsure'];
const BLOCKS = {
    'blocked on the phone\'s list': { set: () => { phone.blocked = [K]; }, refused: true },
    'blocked only on another community\'s own list': { set: () => { phone.seenThere = [K]; }, refused: false },
    'no block': { set: () => {}, refused: false },
} as const;
const ANSWERS = { 'they answer': true, 'neither answers': false } as const;

const ROWS = ADDRESSES.flatMap((address) => Object.entries(ANSWERS).flatMap(([answer, answers]) => (!answers && !address.quiet ? [] : Object.entries(CHATS).flatMap(([chats, { set, WANT, QUIET }]) =>
    Object.entries(STATES).flatMap(([state, s]) => Object.entries(BLOCKS).map(([block, b]) => {
        const who = answers ? (address.doubt?.includes(chats) ? 'unsure' : address.who) : address.quiet!;
        const code = (answers ? WANT : QUIET ?? WANT)[s.column].split(' ')[WHO.indexOf(who)];
        return { row: `${address.name} x ${answer} x ${chats} x ${state} x ${block}`, address, answers, set, state: s, block: b, want: b.refused ? 'blocked' : code === 'off' ? s.off : code };
    }))))));

describe('Message on the phone: where it goes, and a line can go from there', () => {
    it('the table is the whole of it: every address, answer, chat, state and block', () => {
        expect(ROWS.length).toBe((19 + 17) * 17 * 5 * 3);
    });

    // Named in full: a title made by it.each is cut short.
    for (const { row, address, answers, set, state, block, want } of ROWS) it(row, async () => {
        SERVERS[address.server ?? HOME_OF[address.who]].members.add(K);
        SERVERS.riverside.takesAcross = state.on;
        SERVERS.riverside.home = state.home;
        if (state.guest) {
            SERVERS.riverside.members.delete(ME);
            phone.store.set('beanpool_guest_nodes', JSON.stringify([RIVERSIDE]));
        }
        set();
        kept();
        if (answers) saysNow();
        block.set();
        const before = onDisk();
        const got = await message([{ community: address.url, key: K, name: 'Ana' }]);
        expect(got.at === 'refused' ? got.why : got.at).toBe(want);
        if (got.at !== 'refused') expect(whyNotWritable(got)).toBeNull();
        if (got.at === 'switch') expect(got.address).toBe(address.url);
        // Nothing is made or reopened but the chat across it opens.
        if (got.at !== 'new') expect(onDisk()).toEqual(before);
    });

    /**
     * The one case precedence (c) leaves (the review's round 6 brief: with no answer, copies that agree make a name own): lost
     * since this phone last heard anything at all of the community, which does not answer now. A chat can't be started in a
     * community that can't be reached, so it opens nothing unless the community's server answers that and not its info.
     */
    it.each([
        { url: 'https://goneriver.example', want: 'here' },
        { url: 'https://gonehill.example', want: 'held' },
    ])('neither answers, and the record, the signed list and the last info all still hold a lost name ($url): the copies agree', async ({ url, want }) => {
        SERVERS.lakeside.members.add(K);
        kept();
        const got = await message([{ community: url, key: K, name: 'Ana' }]);
        expect(got.at).toBe(want);
        saysNow();
        expect((await message([{ community: url, key: K, name: 'Ana' }])).at).toBe('new');
    });

    it('where each target opens: the chat here, in place, or across in the file that carries it', async () => {
        saysNow(); heard();
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
    const nowhere = (t: Target) => (t.at === 'refused' ? null : whyNotWritable(t));

    it('the review\'s own steps: a contact at an older main, then New message on the same person, then Contacts again: the direct chat here each time, and no chat across made', async () => {
        saysNow(); heard(); SERVERS.riverside.members.add(K);
        for (const url of [RIVERSIDE, 'https://oldriver.example', RIVERSIDE, 'https://oldriver.example']) expect(word(await message(at(url)))).toBe('here');
        expect(made()).toEqual([]);
    });

    it('an address the community took on since this phone last heard (its info asked as the chat is made): the direct chat here, nothing made', async () => {
        saysNow(); heard(); SERVERS.riverside.members.add(K);
        SERVERS.riverside.names.push('newriver.example');
        TOLD.riverside.addresses.push('newriver.example');
        saysNow();
        const got = await message(at('https://newriver.example'));
        expect(word(got)).toBe('here');
        expect(nowhere(got)).toBeNull();
        expect(made()).toEqual([]);
    });

    it('the switch turned off since this phone last heard: refused as the chat is made, nothing made', async () => {
        saysNow(); heard(); SERVERS.faraway.members.add(K);
        SERVERS.riverside.takesAcross = false;
        saysNow();
        expect(word(await message(at(FARAWAY)))).toBe('off');
        expect(made()).toEqual([]);
    });

    it('turned on since: made', async () => {
        SERVERS.riverside.takesAcross = false;
        saysNow(); heard(); SERVERS.faraway.members.add(K);
        SERVERS.riverside.takesAcross = true;
        saysNow();
        const got = await message(at(FARAWAY));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
    });

    it.each([
        { name: 'no answer now: what this phone keeps decides (an older main its record, its list and its info all hold)', url: 'https://oldriver.example', keep: true, want: 'here' },
        { name: 'no answer now, and only one of them holds it: unsure, nothing made', url: 'https://river.example', keep: true, want: 'switch' },
        { name: 'no answer now: what this phone keeps decides (another community)', url: FARAWAY, keep: true, want: 'new' },
        { name: 'no answer now and nothing kept: no chat across is made', url: FARAWAY, keep: false, want: 'off' },
    ])('$name', async ({ url, keep: kept, want }) => {
        saysNow();
        if (kept) heard();
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
        saysNow(); heard(); SERVERS.riverside.members.add(K);
        for (const url of ['https://oldriver.example', RIVERSIDE, 'https://river.example']) {
            expect(word(await message(at(url), ['https://oldriver.example', HILLSIDE]))).toBe('here');
        }
    });

    it('a held community saved under two of its addresses is one: in place at the first', async () => {
        saysNow(); heard(); SERVERS.hillside.members.add(K);
        expect(await message(at('https://oldhill.example'), [HILLSIDE, 'https://oldhill.example'])).toMatchObject({ at: 'held', route: HILLSIDE });
    });

    it('a held community whose chats are read under another spelling of its address: its chat, as Message names it', async () => {
        saysNow(); heard();
        phone.directHeld = [dm('d-held')]; SERVERS.hillside.members.add(K);
        expect(await message(at(FARAWAY), ['https://Hillside.example/'])).toMatchObject({ at: 'held', existing: true });
    });

    it('a held community that says the address the phone reaches the one in use at: its contact is here still', async () => {
        TOLD.hillside.addresses.push('riverside.example');
        saysNow(); heard(); SERVERS.riverside.members.add(K);
        expect(word(await message(at(RIVERSIDE)))).toBe('here');
    });

    it('the community in use says a held community\'s addresses: the one the phone reaches it at is its still, in place; another of them is said by two, so unsure', async () => {
        TOLD.riverside.addresses.push('hillside.example', 'oldhill.example');
        saysNow(); heard(); SERVERS.hillside.members.add(K);
        expect(await message(at(HILLSIDE))).toMatchObject({ at: 'held', route: HILLSIDE });
        expect(await message(at('https://oldhill.example'))).toEqual({ at: 'switch', address: 'https://oldhill.example' });
    });

    it.each([
        { name: 'the held one', url: FARAWAY, set: () => { TOLD.hillside.addresses.push('faraway.example'); SERVERS.faraway.members.add(K); } },
        { name: 'the one in use', url: 'https://river.example', set: () => { SERVERS.riverside.members.add(K); } },
    ])('an address a community says is its own that answered this phone as something else ($name): two proofs that differ, so unsure', async ({ url, set }) => {
        set();
        saysNow(); heard();
        setCommunityIndex(RECORDS().map((r) => ({ ...r, refused: { [url]: { at: 1, why: 'status 404' } } })));
        expect(await message(at(url))).toEqual({ at: 'switch', address: url });
        expect(made()).toEqual([]);
    });

    it('a declined chat kept with an older main of the community in use, the contact in another community: opened again, its lines going there', async () => {
        saysNow(); heard();
        across(RIVERSIDE, 'oldriver.example', 'declined')();
        SERVERS.faraway.members.add(K);
        const got = await message(at(FARAWAY));
        expect(word(got)).toBe('new');
        expect(made()).toEqual([expect.objectContaining({ id: ACROSS_ID, peerHome: 'faraway.example', state: 'open' })]);
        expect(nowhere(got)).toBeNull();
    });

    it('a dead chat here and one that can be written in, in the held file: that one', async () => {
        saysNow(); heard();
        across(RIVERSIDE, 'oldriver.example')(); across(HILLSIDE, 'faraway.example')();
        const got = await message(at(RIVERSIDE));
        expect(word(got)).toBe('openHeld');
        expect(nowhere(got)).toBeNull();
    });

    // ── a name a community lost (rounds 5 and 6) ──
    it('a name the community in use lost, no copy of it on this phone: across, from the link, to the community that holds it now', async () => {
        SERVERS.lakeside.names.push('givenup.example'); SERVERS.lakeside.members.add(K);
        saysNow(); heard();
        const got = await message(at('https://givenup.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
        expect(made()).toEqual([expect.objectContaining({ peerHome: 'givenup.example' })]);
    });

    const METRIVER = (list: string[] | null = []) => setCommunityIndex([record('https://metriver.example', RIVERSIDE, 'peer-riverside', list)]);
    const LOST_METRIVER = () => { SERVERS.lakeside.names.push('metriver.example'); SERVERS.lakeside.members.add(K); };

    it('the address the phone first met the community at, lost since: across to the one that holds it now', async () => {
        METRIVER(); LOST_METRIVER();
        saysNow(); heard();
        const got = await message(at('https://metriver.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
    });

    it.each([
        { name: 'a member of the community in use', set: () => { SERVERS.riverside.members.add(K); } },
        { name: 'only a visitor\'s row there, a member of the community that has the name now', set: () => { phone.copyOf = () => new Set([K]); } },
    ])('the same, this phone\'s copy has a row for the person ($name): it can\'t tell which, so unsure, and nothing is made', async ({ set }) => {
        METRIVER(); LOST_METRIVER(); set();
        saysNow(); heard();
        expect(await message(at('https://metriver.example'))).toEqual({ at: 'switch', address: 'https://metriver.example' });
        expect(await openAcrossChat({ key: K, home: 'metriver.example', name: 'Ana' })).toEqual({ refused: 'uncertain' });
        expect(made()).toEqual([]);
    });

    it('a community this phone only looks at as a guest has no claim, and its copy is never read, as the chat is made', async () => {
        METRIVER(); LOST_METRIVER();
        saysNow(); heard();
        TOLD.hillside.addresses.push('metriver.example'); saysNow(); heard();
        phone.store.set('beanpool_guest_nodes', JSON.stringify([HILLSIDE]));
        const read: string[] = [];
        phone.copyOf = (community) => { read.push(community); return new Set(); };
        expect(await openAcrossChat({ key: K, home: 'metriver.example', name: 'Ana' })).toEqual({ chatId: ACROSS_ID });
        expect(read).toEqual([RIVERSIDE]);
    });

    it('a row there for someone else, or under another of their links\' keys, is no doubt of this one', async () => {
        METRIVER(); LOST_METRIVER();
        phone.copyOf = () => new Set(['d4'.repeat(32)]);
        saysNow(); heard();
        expect(word(await message([...at('https://metriver.example'), { community: 'not an address', key: 'd4'.repeat(32) }]))).toBe('new');
    });

    it('a copy that cannot be read says nothing of who is there: across', async () => {
        METRIVER(); LOST_METRIVER();
        saysNow(); heard();
        phone.copyOf = () => { throw new Error('no copy'); };
        expect(word(await message(at('https://metriver.example')))).toBe('new');
    });

    it.each([
        { name: 'its record and its signed list both hold it', list: ['metriver.example'], want: 'here' },
        { name: 'its record alone, its signed list without it', list: [], want: 'switch' },
        { name: 'its record alone, no list kept', list: null, want: 'switch' },
    ])('nothing heard of the community\'s names ($name)', async ({ list, want }) => {
        METRIVER(list); SERVERS.riverside.members.add(K);
        expect(word(await message(at('https://metriver.example')))).toBe(want);
        expect(made()).toEqual([]);
    });

    it.each([
        { name: 'as it spells it', met: 'https://metriver.example' },
        { name: 'however the record spells it', met: 'https://MetRiver.example/' },
    ])('its copies agree, and the address answered this phone as something else ($name): unsure, and nothing is made', async ({ met }) => {
        setCommunityIndex([{ ...record(met, RIVERSIDE, 'peer-riverside', ['metriver.example']), refused: { 'https://metriver.example': { at: 1, why: 'key' } } }]);
        expect(word(await message(at('https://metriver.example')))).toBe('switch');
        expect(made()).toEqual([]);
    });

    const LOSE = (side: 'riverside' | 'hillside', host: string) => {
        TOLD[side].addresses = TOLD[side].addresses.filter((a) => a !== host);
        TOLD[side].formerAddresses = TOLD[side].formerAddresses.filter((a) => a !== host);
        SERVERS[side].names = SERVERS[side].names.filter((n) => n !== host);
        SERVERS.lakeside.names.push(host); SERVERS.lakeside.members.add(K);
    };
    it.each((['riverside', 'hillside'] as const).flatMap((side) => {
        const river = side === 'riverside' ? 'river' : 'hill';
        return [
            { name: 'an older main (R L I)', host: `old${river}.example`, side }, { name: 'one it went by (L I)', host: `${river}.example`, side },
            { name: 'one it had before (R I)', host: `before${river}.example`, side }, { name: 'one on its list alone (L)', host: `listed${river}.example`, side },
        ];
    }))('a name lost since this phone last heard, asked now, so across to the one that holds it: $side, $name', async ({ host, side }) => {
        kept();
        LOSE(side, host);
        saysNow();
        const got = await message(at(`https://${host}`));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
    });

    it('lost by the one in use since, and said by the held one before this phone last heard of it, which lost it too: each is asked, so across', async () => {
        TOLD.riverside.addresses.push('twice.example'); TOLD.hillside.addresses.push('twice.example');
        saysNow(); heard();
        TOLD.riverside.addresses.pop(); TOLD.hillside.addresses.pop();
        SERVERS.lakeside.names.push('twice.example'); SERVERS.lakeside.members.add(K);
        saysNow();
        const got = await message(at('https://twice.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
    });

    it('lost by the one in use, the only one that answers, to a held one whose copies say it: unsure until it answers too', async () => {
        SERVERS.hillside.members.add(K);
        kept(); saysNow();
        phone.info.delete(HILLSIDE);
        expect(await message(at('https://wentriver.example'))).toEqual({ at: 'switch', address: 'https://wentriver.example' });
        saysNow();
        const got = await message(at('https://wentriver.example'));
        expect(word(got)).toBe('held');
        expect(nowhere(got)).toBeNull();
    });

    it('asked now, a community that says nothing of its addresses (or does not answer): what this phone keeps decides; at the address it is reached at, nothing is asked', async () => {
        saysNow(); heard(); SERVERS.riverside.members.add(K); SERVERS.hillside.members.add(K);
        phone.info.set(RIVERSIDE, { profile: 'local', features: { outsideMessages: true } });
        phone.info.delete(HILLSIDE);
        expect(word(await message(at('https://oldriver.example')))).toBe('here');
        expect(word(await message(at('https://oldhill.example')))).toBe('held');
        expect(word(await message(at('https://beforeriver.example')))).toBe('switch');
        expect(word(await message(at('https://beforehill.example')))).toBe('switch');
        const asked: string[] = [];
        saysNow(); heard();
        vi.stubGlobal('fetch', async (url: string) => { asked.push(url); throw new Error('no answer'); });
        expect(word(await message(at(RIVERSIDE)))).toBe('here');
        expect(word(await message(at(HILLSIDE)))).toBe('held');
        expect(asked).toEqual([]);
        expect(word(await message(at('https://river.example')))).toBe('switch');
        expect(asked).toEqual([`${RIVERSIDE}/api/community/info`]);
    });

    it('an existing direct chat opens with nothing asked, whatever the link says', async () => {
        kept();
        phone.directHere = [dm('d-here')]; SERVERS.riverside.members.add(K);
        const asked: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => { asked.push(url); throw new Error('no answer'); });
        for (const url of ['https://lostriver.example', 'https://takenriver.example', 'https://river.example']) expect(word(await message(at(url)))).toBe('here');
        expect(asked).toEqual([]);
    });

    it('the address card: here, no address of its own to send from, or on to the box, as Message has it; unsure is the box, as ever', async () => {
        kept(); saysNow();
        const card = (home: string) => ({ key: K, home });
        expect(await cardRefusal(RIVERSIDE, card('riverside.example'), 'riverside.example')).toBe('here');
        for (const home of ['oldriver.example', 'river.example', 'beforeriver.example', 'listedriver.example', 'wenthill.example']) expect(await cardRefusal(RIVERSIDE, card(home), null)).toBe('here');
        for (const home of ['lostriver.example', 'goneriver.example', 'wentriver.example', 'takenriver.example', 'takenhill.example', 'faraway.example', 'hillside.example']) expect(await cardRefusal(RIVERSIDE, card(home), 'riverside.example')).toBeNull();
        // Neither answers: here only where the copies agree.
        phone.info.clear();
        expect(await cardRefusal(RIVERSIDE, card('oldriver.example'), null)).toBe('here');
        for (const home of ['river.example', 'beforeriver.example', 'listedriver.example', 'lostriver.example']) expect(await cardRefusal(RIVERSIDE, card(home), null)).toBeNull();
        SERVERS.riverside.home = false;
        saysNow(); heard();
        expect(await cardRefusal(RIVERSIDE, card('faraway.example'), null)).toBe('no-home');
        expect(await cardRefusal(RIVERSIDE, card('river.example'), null)).toBe('here');
    });

    it('a name an older server lists as former that a held community goes by now: never the community in use, as the chat is made', async () => {
        saysNow(); heard(); SERVERS.hillside.members.add(K);
        expect(await openAcrossChat({ key: K, home: 'takenriver.example', name: 'Ana' })).toEqual({ refused: 'uncertain' });
        expect(made()).toEqual([]);
        expect(await openAcrossChat({ key: K, home: 'beforeriver.example', name: 'Ana' })).toEqual({ here: K });
    });

    it('two communities that each had a name before, neither going by it now: unsure', async () => {
        TOLD.hillside.formerAddresses.push('beforeriver.example');
        saysNow(); heard(); SERVERS.riverside.members.add(K);
        expect(await message(at('https://beforeriver.example'))).toEqual({ at: 'switch', address: 'https://beforeriver.example' });
    });

    // ── an answer that names none (round 6): an empty list is an answer, only one with no list is none ──
    it('the held one answers that it has no names but one it had before: a name all its copies hold is lost, so across; the one it had is in place', async () => {
        kept(); saysNow();
        SERVERS.hillside.names = ['hillside.example', 'beforehill.example']; SERVERS.lakeside.names.push('oldhill.example');
        SERVERS.lakeside.members.add(K);
        phone.info.set(HILLSIDE, { profile: 'local', features: { outsideMessages: true }, addresses: [], primaryAddress: null, formerAddresses: ['beforehill.example'] });
        const got = await message(at('https://oldhill.example'));
        expect(word(got)).toBe('new');
        expect(nowhere(got)).toBeNull();
        SERVERS.hillside.members.add(K);
        expect(word(await message([{ community: 'https://beforehill.example', key: K }]))).not.toBe('switch');
    });

    it('the same of the one in use: never the direct chat here, and nothing is made (it has no address to send from)', async () => {
        kept(); saysNow();
        SERVERS.riverside.names = ['riverside.example']; SERVERS.riverside.home = false; SERVERS.lakeside.names.push('oldriver.example'); SERVERS.lakeside.members.add(K);
        phone.info.set(RIVERSIDE, { profile: 'local', features: { outsideMessages: true }, addresses: [], primaryAddress: null, formerAddresses: [] });
        expect(word(await message(at('https://oldriver.example')))).toBe('no-home');
        expect(made()).toEqual([]);
    });

    // ── a community that knows no address of its own (round 5) ──
    it.each([
        { name: 'it publishes none of its own addresses', says: { addresses: [], primaryAddress: null, formerAddresses: [] } },
        { name: 'it publishes none and says no main (an older server)', says: { addresses: [], formerAddresses: [] } },
        { name: 'its only name waits for a route', says: { addresses: ['riverside.example'], primaryAddress: null, formerAddresses: [] } },
    ])('$name, its switch on: no chat across is made, and one there is not picked', async ({ says }) => {
        SERVERS.faraway.members.add(K); SERVERS.riverside.home = false;
        phone.info.set(RIVERSIDE, { profile: 'local', features: { outsideMessages: true }, ...says });
        heard();
        expect(word(await message(at(FARAWAY)))).toBe('no-home');
        expect(made()).toEqual([]);
        across(RIVERSIDE, 'faraway.example')();
        expect(word(await message(at(FARAWAY)))).toBe('no-home');
        SERVERS.riverside.members.add(K);
        expect(word(await message(at(RIVERSIDE)))).toBe('here');
    });

    it('heard only as the chat is made: refused, nothing made', async () => {
        saysNow(); heard(); SERVERS.faraway.members.add(K);
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
        heard();
        expect(word(await message(at(FARAWAY)))).toBe('new');
        expect(word(await message(at(FARAWAY)))).toBe('open');
    });

    it('several links: the community in use by another of its names before a held one; the key is that link\'s', async () => {
        saysNow(); heard();
        const K2 = 'c3'.repeat(32);
        SERVERS.riverside.members.add(K2); SERVERS.hillside.members.add(K);
        expect(await message([{ community: HILLSIDE, key: K }, { community: 'https://oldriver.example', key: K2 }])).toMatchObject({ at: 'here', key: K2 });
        // Not certain of the one in use: the held one, which is.
        expect(await message([{ community: 'https://takenhill.example', key: K2 }, { community: HILLSIDE, key: K }])).toMatchObject({ at: 'held', key: K });
    });
});
