/**
 * Which chat Message opens (S5 part 2: DESIGN-no-switch-messaging-fable.md §3 "Which path a new chat takes"): an existing
 * chat wins, else the community you share (the one set to first), else across. The path table, for the phone (a set-to
 * community and held ones) and the web (one community, none held), and the note under a first line across. Each rule is
 * taken out in turn (mutants) and every one gets rows wrong.
 */
import { describe, expect, it } from 'vitest';
import { communityNamed, homesOfCommunity, type NamedCommunity } from '../community-homes';
import { ACROSS_FIRST_LINE_NOTE, acrossChatListed, acrossFirstLineNoteUnder, messagePathFor, type KnownChat, type MessageLink, type MessagePath } from '../message-path';
import { nodeHomeOf } from '../node-request-signing';

const HERE = 'https://riverside.example';
const HELD_A = 'https://hillside.example';
const HELD_B = 'https://lakeside.example';
const AWAY = 'https://faraway.example';
const K = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
/** Riverside's older main address (the device's own record), and another of its names (its info says so); Hillside's too. */
const HERE_OLD = 'https://oldriver.example';
const HERE_ALIAS = 'https://river.example';
const HELD_A_ALIAS = 'https://oldhill.example';
const COMMUNITIES: NamedCommunity[] = [
    { community: HERE, known: [HERE_OLD], says: ['riverside.example', 'river.example'] },
    { community: HELD_A, known: [HELD_A_ALIAS], says: ['hillside.example'] },
    { community: HELD_B },
];

type Input = Parameters<typeof messagePathFor>[0];
const base = { look: null, whose: communityNamed(COMMUNITIES), takesAcross: () => true };
const phone = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ ...base, links, chats, setTo: HERE, held: [HELD_A, HELD_B], blocked });
const web = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ ...base, links, chats, setTo: HERE, held: [], whose: communityNamed(COMMUNITIES.slice(0, 1)), blocked });

interface Row { name: string; input: Input; want: MessagePath }
const dHere: KnownChat = { kind: 'direct', community: HERE, id: 'd-here', key: K };
const dA: KnownChat = { kind: 'direct', community: HELD_A, id: 'd-a', key: K };
const dB: KnownChat = { kind: 'direct', community: HELD_B, id: 'd-b', key: K };
const dGone: KnownChat = { kind: 'direct', community: AWAY, id: 'd-gone', key: K };
// Kept with a home this device shares no community with: their lines go there.
const xHere: KnownChat = { kind: 'across', community: null, id: 'x-here', key: K, home: 'faraway.example' };
const xA: KnownChat = { kind: 'across', community: HELD_A, id: 'x-a', key: K, home: 'faraway.example' };
const xGone: KnownChat = { kind: 'across', community: AWAY, id: 'x-gone', key: K, home: 'another.example' };
const other: KnownChat = { kind: 'direct', community: HERE, id: 'd-other', key: K2 };
// Their home is a community this device shares with them: no line across can go to it.
const at = (chat: KnownChat, home: string): KnownChat => ({ ...chat, home } as KnownChat);
const xDead = at(xHere, 'oldriver.example');
const xDeadAlias = at(xHere, 'river.example');
const xToHeld = at(xHere, 'oldhill.example');
const xHeldDead = at(xA, 'hillside.example');
const xHeldToHere = at(xA, 'river.example');
const across = (community: string, key = K, name: string | null = 'Dee'): MessagePath => ({ open: 'across', key, home: nodeHomeOf(community)!, name });

const ROWS: Row[] = [
    // ── phone: existing ──
    { name: 'phone · existing direct here beats everything', input: phone([{ community: AWAY, key: K }], [xHere, dA, dHere]), want: { open: 'existing', chat: dHere } },
    { name: 'phone · existing direct in a held community, the held order', input: phone([{ community: AWAY, key: K }], [dB, dA, xHere]), want: { open: 'existing', chat: dA } },
    { name: 'phone · existing direct in the second held community', input: phone([{ community: HERE, key: K }], [dB]), want: { open: 'existing', chat: dB } },
    { name: 'phone · existing across chat beats the shared community', input: phone([{ community: HERE, key: K }], [xHere]), want: { open: 'existing', chat: xHere } },
    { name: 'phone · existing across chat in a held file', input: phone([{ community: AWAY, key: K }], [xA]), want: { open: 'existing', chat: xA } },
    { name: 'phone · across in the set-to file before a held file', input: phone([{ community: AWAY, key: K }], [xA, xHere]), want: { open: 'existing', chat: xHere } },
    { name: 'phone · a chat under another key is not theirs', input: phone([{ community: HERE, key: K }], [other]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · a direct chat in a community no longer held does not count', input: phone([{ community: AWAY, key: K, name: 'Dee' }], [dGone]), want: across(AWAY) },
    { name: 'phone · an across chat in a file no longer held does not count', input: phone([{ community: AWAY, key: K, name: 'Dee' }], [xGone]), want: across(AWAY) },
    // ── phone: shared ──
    { name: 'phone · shared: the set-to community first', input: phone([{ community: HELD_A, key: K }, { community: HERE, key: K2 }]), want: { open: 'shared', community: HERE, key: K2 } },
    { name: 'phone · shared: a held community, however spelled', input: phone([{ community: 'https://HILLSIDE.example/', key: K }]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'phone · shared: the held order, not the link order', input: phone([{ community: HELD_B, key: K2 }, { community: HELD_A, key: K }]), want: { open: 'shared', community: HELD_A, key: K } },
    // ── phone: across ──
    { name: 'phone · across: shares none', input: phone([{ community: AWAY, key: K, name: ' Dee ' }]), want: across(AWAY) },
    { name: 'phone · across: no name', input: phone([{ community: AWAY, key: K }]), want: across(AWAY, K, null) },
    { name: 'phone · across: the first link', input: phone([{ community: AWAY, key: K, name: 'Dee' }, { community: 'https://another.example', key: K2 }]), want: across(AWAY) },
    { name: 'phone · across: no community set to (a guest look)', input: { ...phone([{ community: HERE, key: K, name: 'Dee' }]), setTo: null, held: [] }, want: across(HERE) },
    // ── phone: nothing ──
    { name: 'phone · nothing: not on BeanPool yet', input: phone([]), want: { open: 'nothing' } },
    { name: 'phone · nothing: across to an address that is not one', input: phone([{ community: 'not an address', key: K }]), want: { open: 'nothing' } },
    // ── web: one community, none held ──
    { name: 'web · existing across chat', input: web([{ community: AWAY, key: K }], [xHere]), want: { open: 'existing', chat: xHere } },
    { name: 'web · existing direct here beats an across chat', input: web([{ community: HERE, key: K }], [xHere, dHere]), want: { open: 'existing', chat: dHere } },
    { name: 'web · shared: this community', input: web([{ community: HERE, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'web · across: any other community (the web holds none)', input: web([{ community: HELD_A, key: K, name: 'Dee' }]), want: across(HELD_A) },
    { name: 'web · across: a direct chat in another community does not count', input: web([{ community: HELD_A, key: K, name: 'Dee' }], [dA]), want: across(HELD_A) },
    { name: 'web · nothing: not on BeanPool yet', input: web([]), want: { open: 'nothing' } },
    // ── blocked: asked first, on every path (#3354 review: an existing chat opened the hidden chat of someone blocked) ──
    { name: 'phone · blocked: an existing direct chat here does not open', input: phone([{ community: HERE, key: K }], [dHere], true), want: { open: 'blocked' } },
    { name: 'phone · blocked: an existing direct chat in a held community does not open', input: phone([{ community: AWAY, key: K }], [dA], true), want: { open: 'blocked' } },
    { name: 'phone · blocked: an existing across chat does not open', input: phone([{ community: AWAY, key: K }], [xHere], true), want: { open: 'blocked' } },
    { name: 'phone · blocked: no chat started in the community shared', input: phone([{ community: HELD_A, key: K }], [], true), want: { open: 'blocked' } },
    { name: 'phone · blocked: no chat across made', input: phone([{ community: AWAY, key: K, name: 'Dee' }], [], true), want: { open: 'blocked' } },
    { name: 'web · blocked: an existing across chat does not open', input: web([{ community: AWAY, key: K }], [xHere], true), want: { open: 'blocked' } },
    { name: 'web · blocked: no chat started here', input: web([{ community: HERE, key: K }], [], true), want: { open: 'blocked' } },
    { name: 'web · blocked: no chat across made', input: web([{ community: AWAY, key: K, name: 'Dee' }], [], true), want: { open: 'blocked' } },
    { name: 'blocked, not on BeanPool yet: nothing (no key to block)', input: phone([], [], true), want: { open: 'nothing' } },
    // ── the invariant (#3354 review, round 4): never a chat the member can't write in now ──
    { name: 'phone · any address of the community in use is here: its older main (the device\'s record)', input: phone([{ community: HERE_OLD, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · any address of the community in use is here: another of its names (its info)', input: phone([{ community: HERE_ALIAS, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · any address of a held community is it', input: phone([{ community: HELD_A_ALIAS, key: K }]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'web · any address of this community is here', input: web([{ community: HERE_ALIAS, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · a dead across chat (its person is here, by an older main): the direct chat here', input: phone([{ community: HERE_OLD, key: K }], [xDead]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · a dead across chat, the person found here by New message: the direct chat here', input: phone([{ community: HERE, key: K }], [xDeadAlias]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'web · a dead across chat (its person is here): the direct chat here', input: web([{ community: HERE_ALIAS, key: K }], [xDeadAlias]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · an across chat to a held community: the direct chat there', input: phone([{ community: HELD_A, key: K }], [xToHeld]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'phone · a held file\'s across chat to its own community: the direct chat there', input: phone([{ community: HELD_A, key: K }], [xHeldDead]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'phone · a held file\'s across chat to the community in use: the direct chat here', input: phone([{ community: HERE, key: K }], [xHeldToHere]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · no link names a shared community, but their across chat does: the direct chat there (here)', input: phone([{ community: AWAY, key: K }], [xDead]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · no link names a shared community, but their across chat does: the direct chat there (held)', input: phone([{ community: AWAY, key: K }], [xToHeld]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'phone · a link\'s community before the one an across chat names', input: phone([{ community: HELD_A, key: K }], [xDead]), want: { open: 'shared', community: HELD_A, key: K } },
    { name: 'web · no link names this community, but their across chat does: the direct chat here', input: web([{ community: AWAY, key: K }], [xDead, xDeadAlias]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · one across chat is dead and another can be written in: that one', input: phone([{ community: HERE, key: K }], [xDead, xA]), want: { open: 'existing', chat: xA } },
    { name: 'phone · the community in use takes none across: the community they share', input: { ...phone([{ community: HERE, key: K }], [xHere]), takesAcross: (c) => c !== HERE }, want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · the community in use takes none across, none shared: across (which the app refuses)', input: { ...phone([{ community: AWAY, key: K, name: 'Dee' }], [xHere]), takesAcross: (c) => c !== HERE }, want: across(AWAY) },
    { name: 'phone · a held community takes none across: its chat is left out', input: { ...phone([{ community: AWAY, key: K, name: 'Dee' }], [xA]), takesAcross: (c) => c !== HELD_A }, want: across(AWAY) },
    { name: 'phone · the community in use takes none across, the held one that carries the chat does: that chat', input: { ...phone([{ community: HERE, key: K }], [xHere, xA]), takesAcross: (c) => c !== HERE }, want: { open: 'existing', chat: xA } },
    { name: 'web · this community takes none across: the chat here', input: { ...web([{ community: HERE, key: K }], [xHere]), takesAcross: () => false }, want: { open: 'shared', community: HERE, key: K } },
    // ── a guest's look (#3354 review, round 4): the direct chat a visitor has there is theirs; nothing else of it counts ──
    { name: 'look · a direct chat there opens', input: { ...phone([{ community: HERE, key: K }], [dHere, dA]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: { open: 'existing', chat: dHere } },
    { name: 'look · no chat there: none is started there', input: { ...phone([{ community: HERE, key: K, name: 'Dee' }]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: across(HERE) },
    { name: 'look · an across chat in its file does not count', input: { ...phone([{ community: AWAY, key: K, name: 'Dee' }], [xHere]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: across(AWAY) },
    { name: 'look · an across chat there names no shared community', input: { ...phone([{ community: AWAY, key: K, name: 'Dee' }], [xDead]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: across(AWAY) },
    { name: 'look · a held community is still shared', input: { ...phone([{ community: HERE, key: K }, { community: HELD_A_ALIAS, key: K2 }]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: { open: 'shared', community: HELD_A, key: K2 } },
];

describe('messagePathFor: which chat Message opens', () => {
    it.each(ROWS)('$name', ({ input, want }) => {
        expect(messagePathFor(input)).toEqual(want);
    });

    type Rule = typeof messagePathFor;
    const MUTANTS: Record<string, Rule> = {
        'no existing chat looked for': (i) => messagePathFor({ ...i, chats: [] }),
        'held direct chats ignored': (i) => messagePathFor({ ...i, chats: i.chats.filter((c) => !(c.kind === 'direct' && !same(c.community, i.setTo ?? ''))) }),
        'across chats ignored': (i) => messagePathFor({ ...i, chats: i.chats.filter((c) => c.kind !== 'across') }),
        'chats under any key count': (i) => messagePathFor({ ...i, chats: i.chats.map((c) => ({ ...c, key: i.links[0]?.key ?? c.key })) }),
        'no shared community: always across': (i) => {
            const got = messagePathFor({ ...i, setTo: null, held: [] });
            return got.open === 'existing' ? messagePathFor(i) : got;
        },
        'held communities never shared (the web rule on the phone)': (i) => {
            const got = messagePathFor(i);
            return got.open === 'shared' && !same(got.community, i.setTo ?? '') ? messagePathFor({ ...i, held: [] }) : got;
        },
        'the link order, not the held order': (i) => messagePathFor({ ...i, held: [...i.held].reverse() }),
        'shared before existing': (i) => {
            const shared = messagePathFor({ ...i, chats: [] });
            return shared.open === 'shared' ? shared : messagePathFor(i);
        },
        'chats in communities no longer held count': (i) => messagePathFor({ ...i, held: [...i.held, AWAY], whose: (a) => i.whose(a) ?? (same(a ?? '', AWAY) ? AWAY : null) }),
        // ── the invariant (round 4) ──
        'a community is one spelling (the bug: a link at another of its addresses goes across)': (i) => messagePathFor({ ...i, whose: communityNamed(COMMUNITIES.map(({ community }) => ({ community }))) }),
        'what the device knows of a community left out': (i) => messagePathFor({ ...i, whose: communityNamed(COMMUNITIES.map(({ community, says }) => ({ community, says }))) }),
        'what a community says of itself left out': (i) => messagePathFor({ ...i, whose: communityNamed(COMMUNITIES.map(({ community, known }) => ({ community, known }))) }),
        'a dead across chat counts (its person is in a community shared)': (i) => messagePathFor({ ...i, chats: i.chats.map((c) => (c.kind === 'across' ? { ...c, home: 'faraway.example' } : c)) }),
        'a community that takes none across still carries one': (i) => messagePathFor({ ...i, takesAcross: () => true }),
        'a guest\'s look counts as a membership': (i) => messagePathFor({ ...i, setTo: i.setTo ?? i.look, look: null }),
        'a direct chat on a guest\'s look left out': (i) => messagePathFor({ ...i, look: null }),
        'an across chat never says where they are': (i) => {
            const got = messagePathFor(i);
            return got.open === 'shared' && !i.links.some((l) => i.whose(l.community) === got.community) ? { open: 'across', key: i.links[0].key, home: nodeHomeOf(i.links[0].community)!, name: i.links[0].name?.trim() || null } : got;
        },
        'no block asked': (i) => messagePathFor({ ...i, blocked: false }),
        'the block asked only where no chat exists': (i) => {
            const got = messagePathFor({ ...i, blocked: false });
            return got.open === 'existing' ? got : messagePathFor(i);
        },
    };
    for (const [name, mutant] of Object.entries(MUTANTS)) {
        it(`without the rule: ${name}, gets rows wrong`, () => {
            expect(ROWS.filter((r) => JSON.stringify(mutant(r.input)) !== JSON.stringify(r.want)).length).toBeGreaterThan(0);
        });
    }
});

// #3354 review, round 3: an across chat is the existing chat only while Chat lists it (open, or a request behind Requests);
// a declined one is listed nowhere and its thread has no composer and no Accept. Both apps' readers ask this before the rule.
describe('acrossChatListed: which chats across Message may open as the existing chat', () => {
    it.each([
        { state: 'open' as const, listed: true },
        { state: 'request' as const, listed: true },
        { state: 'declined' as const, listed: false },
    ])('$state -> $listed', ({ state, listed }) => {
        expect(acrossChatListed(state)).toBe(listed);
    });
});

// #3354 review, round 4: one community, all its addresses (community-homes.ts), the rule Message and the address card share.
describe('a community, all its addresses', () => {
    it.each([
        { name: 'the address reached, and every one it says: hosts, former names, its main', at: 'https://Riverside.example/',
            said: { addresses: ['riverside.example', 'river.example'], primaryAddress: 'river.example', formerAddresses: ['oldriver.example'] },
            want: ['riverside.example', 'river.example', 'oldriver.example'] },
        { name: 'a name said with no port is on the port it is reached at, for that host only', at: 'https://coop.example:8443',
            said: { addresses: ['coop.example', 'other.example', 'third.example:9443'] }, want: ['coop.example:8443', 'other.example', 'third.example:9443'] },
        { name: 'nothing said (an older server, or not read): the address reached', at: 'https://riverside.example', said: null, want: ['riverside.example'] },
        { name: 'anything that is no address is dropped', at: 'https://riverside.example',
            said: { addresses: [7, null, 'not an address', 'river.example'], formerAddresses: 'river2.example', primaryAddress: null }, want: ['riverside.example', 'river.example'] },
        { name: 'an address that is none', at: 'nowhere at all', said: { addresses: ['river.example'] }, want: ['river.example'] },
    ])('$name', ({ at: reached, said, want }) => {
        expect(homesOfCommunity(reached, said)).toEqual(want);
    });

    const whose = communityNamed([
        { community: HERE, known: [HERE_OLD], says: ['river.example', 'hillside.example', 'lakeside-known.example'] },
        { community: HELD_A, known: ['https://lakeside-known.example'], says: ['shared-claim.example', 'taken.example'], refused: ['https://taken.example'] },
        { community: HELD_B, says: ['shared-claim.example', 'taken.example'] },
    ]);
    it.each([
        { name: 'however spelled', address: 'HTTPS://Riverside.example:443/x?y', want: HERE },
        { name: 'a home (a card\'s, a chat\'s)', address: 'riverside.example', want: HERE },
        { name: 'an address the device knows as its own', address: 'oldriver.example', want: HERE },
        { name: 'an address it says is its own', address: 'https://river.example', want: HERE },
        { name: 'the same host on another port is another server', address: 'https://riverside.example:8443', want: null },
        { name: 'one community\'s own address is never another\'s, whoever says so', address: 'https://hillside.example', want: HELD_A },
        { name: 'one the device knows for a community is never another\'s, whoever says so', address: 'lakeside-known.example', want: HELD_A },
        { name: 'two say it: the first in order', address: 'shared-claim.example', want: HELD_A },
        { name: 'one that answered the device as something else is not its', address: 'taken.example', want: HELD_B },
        { name: 'another community', address: AWAY, want: null },
        { name: 'no address', address: 'not an address', want: null },
        { name: 'none', address: null, want: null },
    ])('$name', ({ address, want }) => {
        expect(whose(address)).toBe(want);
    });
});

describe('the note under a first line across', () => {
    const me = 'm'.repeat(64);
    const them = 't'.repeat(64);
    it('is said in core, word for word', () => {
        expect(ACROSS_FIRST_LINE_NOTE).toBe('They will see this if they take messages from other communities.');
    });
    it.each([
        { name: 'no lines: no note', lines: [], restored: false, want: null },
        { name: 'my first line, nothing of theirs: under it', lines: [{ id: '1', author: me }], restored: false, want: '1' },
        { name: 'two lines of mine: under the first only', lines: [{ id: '1', author: me }, { id: '2', author: me }], restored: false, want: '1' },
        { name: 'they wrote back: none', lines: [{ id: '1', author: me }, { id: '2', author: them }], restored: false, want: null },
        { name: 'they wrote first: none', lines: [{ id: '1', author: them }, { id: '2', author: me }], restored: false, want: null },
        { name: 'a chat brought back from 12 words: none', lines: [{ id: '1', author: me }], restored: true, want: null },
    ])('$name', ({ lines, restored, want }) => {
        expect(acrossFirstLineNoteUnder(lines, me, restored)).toBe(want);
    });
    it('without the rule: a line of theirs ignored, or restored ignored, gets rows wrong', () => {
        expect(acrossFirstLineNoteUnder([{ id: '1', author: me }, { id: '2', author: them }], me, false)).toBeNull();
        expect(acrossFirstLineNoteUnder([{ id: '1', author: me }], me, true)).toBeNull();
    });
});
