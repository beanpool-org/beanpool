/**
 * Which chat Message opens (S5 part 2: DESIGN-no-switch-messaging-fable.md §3 "Which path a new chat takes"): an existing
 * chat wins, else the community you share (the one set to first), else across. The path table, for the phone (a set-to
 * community and held ones) and the web (one community, none held), and the note under a first line across. Each rule is
 * taken out in turn (mutants) and every one gets rows wrong.
 */
import { describe, expect, it } from 'vitest';
import { keptClaims, nameStanding, saysNames, saysNoHome, whoseName, type KnownNames, type NameStanding, type WhoseName } from '../community-homes';
import { ACROSS_FIRST_LINE_NOTE, acrossChatListed, acrossFirstLineNoteUnder, messagePathFor, type KnownChat, type MessageLink, type MessagePath } from '../message-path';
import { nodeHomeOf } from '../node-request-signing';

const HERE = 'https://riverside.example';
const HELD_A = 'https://hillside.example';
const HELD_B = 'https://lakeside.example';
const AWAY = 'https://faraway.example';
const K = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
/** Each is a name its community answers it has: an older main it goes by still, another of its names, one it had before. */
const HERE_OLD = 'https://oldriver.example';
const HERE_ALIAS = 'https://river.example';
const HELD_A_ALIAS = 'https://oldhill.example';
const HERE_FORMER = 'https://formerriver.example';
/** A name Riverside lost, which Lakeside goes by now; and one Riverside and Hillside both say is theirs, so whose isn't certain. */
const HERE_LOST = 'https://lostriver.example';
const BOTH = 'https://both.example';
/** A name Hillside lists only as one it had before. */
const HELD_A_FORMER = 'https://formerhill.example';
const COMMUNITIES: KnownNames[] = [
    { community: HERE, reached: HERE, kept: {}, answer: { addresses: ['riverside.example', 'oldriver.example', 'river.example', 'both.example'], primaryAddress: 'riverside.example', formerAddresses: ['formerriver.example'], formerExcludesLost: true } },
    { community: HELD_A, reached: HELD_A, kept: {}, answer: { addresses: ['hillside.example', 'oldhill.example'], formerAddresses: ['both.example', 'formerhill.example'], formerExcludesLost: true } },
    { community: HELD_B, reached: HELD_B, kept: {}, answer: { addresses: ['lakeside.example', 'lostriver.example'] } },
];

type Input = Parameters<typeof messagePathFor>[0];
const base = { look: null, whose: whoseName(COMMUNITIES), takesAcross: () => true };
const phone = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ ...base, links, chats, setTo: HERE, held: [HELD_A, HELD_B], blocked });
/** The web holds one community; `webNoAnswer`: one that doesn't answer, so only what the page read is there. */
const WEB: KnownNames[] = [{ ...COMMUNITIES[0], answer: { ...COMMUNITIES[0].answer, addresses: ['riverside.example', 'oldriver.example', 'river.example'] }, refused: [] }];
const web = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ ...base, links, chats, setTo: HERE, held: [], whose: whoseName(WEB), blocked });
/** The same communities on a server from before `formerExcludesLost` (version skew): what they list as former may be lost. */
const older = (communities: readonly KnownNames[]): KnownNames[] => communities.map((c) => ({ ...c, answer: { ...c.answer, formerExcludesLost: undefined } }));
const webNoAnswer = (links: MessageLink[]): Input => ({ ...web(links), whose: whoseName([{ community: HERE, reached: HERE, answer: null, kept: { info: COMMUNITIES[0].answer } }]) });

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
    { name: 'phone · across: the first link that is an address', input: phone([{ community: 'not an address', key: K2 }, { community: AWAY, key: K, name: 'Dee' }]), want: across(AWAY) },
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
    // ── a name a community had before, and one it lost (#3354 review, rounds 5 and 6) ──
    { name: 'phone · a name the community in use had before is here', input: phone([{ community: HERE_FORMER, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · a name it lost to a held community is that community', input: phone([{ community: HERE_LOST, key: K }]), want: { open: 'shared', community: HELD_B, key: K } },
    { name: 'web · a name it lost: across', input: web([{ community: HERE_LOST, key: K, name: 'Dee' }]), want: across(HERE_LOST) },
    { name: 'phone · a name a held community had before is it', input: phone([{ community: HELD_A_FORMER, key: K }]), want: { open: 'shared', community: HELD_A, key: K } },
    // ── version skew: a server from before `formerExcludesLost` lists a lost name among its former ones ──
    { name: 'phone · an older server in use, a name it lists only as one it had before: to switch', input: { ...phone([{ community: HERE_FORMER, key: K }]), whose: whoseName(older(COMMUNITIES)) }, want: { open: 'switch', community: HERE_FORMER } },
    { name: 'phone · an older server held, a name it lists only as one it had before: to switch', input: { ...phone([{ community: HELD_A_FORMER, key: K }]), whose: whoseName(older(COMMUNITIES)) }, want: { open: 'switch', community: HELD_A_FORMER } },
    { name: 'web · an older server, a name it lists only as one it had before: to go there', input: { ...web([{ community: HERE_FORMER, key: K }]), whose: whoseName(older(WEB)) }, want: { open: 'switch', community: HERE_FORMER } },
    { name: 'phone · an older server, a name it goes by: here, as ever', input: { ...phone([{ community: HERE_ALIAS, key: K }]), whose: whoseName(older(COMMUNITIES)) }, want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · an older server, a chat across kept with a name it lists only as one it had before: never picked', input: { ...phone([{ community: AWAY, key: K, name: 'Dee' }], [at(xHere, 'formerriver.example')]), whose: whoseName(older(COMMUNITIES)) }, want: across(AWAY) },
    { name: 'phone · an across chat kept with a name a held community goes by now: the direct chat there', input: phone([{ community: AWAY, key: K }], [at(xHere, 'lostriver.example')]), want: { open: 'shared', community: HELD_B, key: K } },
    // ── whose isn't certain (round 6): nothing opens; to go to that address is offered ──
    { name: 'phone · a name two communities claim, no chat: to switch', input: phone([{ community: BOTH, key: K }]), want: { open: 'switch', community: BOTH } },
    { name: 'web · a name only an old page says, no answer: to go there', input: webNoAnswer([{ community: HERE_ALIAS, key: K }]), want: { open: 'switch', community: HERE_ALIAS } },
    { name: 'web · the address it is open at needs no answer', input: webNoAnswer([{ community: HERE, key: K }]), want: { open: 'shared', community: HERE, key: K } },
    { name: 'phone · uncertain, a direct chat there is: that chat', input: phone([{ community: BOTH, key: K }], [dA]), want: { open: 'existing', chat: dA } },
    { name: 'phone · uncertain, a chat across to another community: that chat', input: phone([{ community: BOTH, key: K }], [xHere]), want: { open: 'existing', chat: xHere } },
    { name: 'phone · a chat across whose own home is uncertain is never picked: the link is followed', input: phone([{ community: AWAY, key: K, name: 'Dee' }], [at(xHere, 'both.example')]), want: across(AWAY) },
    { name: 'phone · nor does it say a community is shared', input: phone([{ community: BOTH, key: K }], [at(xHere, 'both.example')]), want: { open: 'switch', community: BOTH } },
    { name: 'phone · a chat across with a certain home beside it is', input: phone([{ community: BOTH, key: K }], [at(xHere, 'both.example'), xA]), want: { open: 'existing', chat: xA } },
    { name: 'phone · uncertain, another link is of a community shared: there', input: phone([{ community: BOTH, key: K }, { community: HELD_B, key: K2 }]), want: { open: 'shared', community: HELD_B, key: K2 } },
    { name: 'phone · uncertain, another link is of none: across from that one', input: phone([{ community: BOTH, key: K2 }, { community: AWAY, key: K, name: 'Dee' }]), want: across(AWAY) },
    { name: 'phone · uncertain, another link is no address: to switch', input: phone([{ community: 'not an address', key: K2 }, { community: BOTH, key: K }]), want: { open: 'switch', community: BOTH } },
    { name: 'phone · a link the app doubts, of a community shared: to switch', input: phone([{ community: HERE_ALIAS, key: K, doubted: true }]), want: { open: 'switch', community: HERE_ALIAS } },
    { name: 'phone · a link the app doubts, of none: to switch', input: phone([{ community: AWAY, key: K, doubted: true }]), want: { open: 'switch', community: AWAY } },
    { name: 'phone · blocked, uncertain: refused', input: phone([{ community: BOTH, key: K }], [], true), want: { open: 'blocked' } },
    { name: 'look · uncertain, a link of the look\'s own: to switch', input: { ...phone([{ community: BOTH, key: K }]), setTo: null, look: HERE, held: [HELD_A, HELD_B] }, want: { open: 'switch', community: BOTH } },
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
        'chats in communities no longer held count': (i) => messagePathFor({ ...i, held: [...i.held, AWAY] }),
        // ── the invariant (round 4) ──
        'a community is one spelling (the bug: a link at another of its addresses goes across)': (i) => messagePathFor({ ...i, whose: whoseName(COMMUNITIES.map(({ community, reached }) => ({ community, reached, kept: {} }))) }),
        'a name it had before trusted from any server (the bug: an older one lists a lost name)': (i) => {
            const got = messagePathFor(i);
            return got.open === 'switch' && i.setTo ? messagePathFor({ ...i, whose: whoseName(i.held.length ? COMMUNITIES : WEB) }) : got;
        },
        'a name it had before left out': (i) => messagePathFor({ ...i, whose: whoseName(COMMUNITIES.map((c) => ({ ...c, answer: { ...c.answer, formerAddresses: [] } }))) }),
        'an uncertain name is the first\'s that claims it (the bug: a chat nobody reads)': (i) => messagePathFor({ ...i, whose: (a) => {
            const name = i.whose(a);
            return name.whose === 'uncertain' ? { whose: 'one', community: HERE } : name;
        } }),
        'an uncertain name is nobody\'s here (the bug: a chat across its own server refuses)': (i) => messagePathFor({ ...i, whose: (a) => {
            const name = i.whose(a);
            return name.whose === 'uncertain' ? { whose: 'none' } : name;
        } }),
        'a link the app doubts weighed as any other': (i) => messagePathFor({ ...i, links: i.links.map(({ doubted: _doubted, ...l }) => l) }),
        'a chat across with an uncertain home counts': (i) => messagePathFor({ ...i, chats: i.chats.map((c) => (c.kind === 'across' && i.whose(c.home).whose === 'uncertain' ? { ...c, home: 'faraway.example' } : c)) }),
        'a dead across chat counts (its person is in a community shared)': (i) => messagePathFor({ ...i, chats: i.chats.map((c) => (c.kind === 'across' ? { ...c, home: 'faraway.example' } : c)) }),
        'a community that takes none across still carries one': (i) => messagePathFor({ ...i, takesAcross: () => true }),
        'a guest\'s look counts as a membership': (i) => messagePathFor({ ...i, setTo: i.setTo ?? i.look, look: null }),
        'a direct chat on a guest\'s look left out': (i) => messagePathFor({ ...i, look: null }),
        'an across chat never says where they are': (i) => {
            const got = messagePathFor(i);
            return got.open === 'shared' && !i.links.some((l) => { const name = i.whose(l.community); return name.whose === 'one' && name.community === got.community; }) ? { open: 'across', key: i.links[0].key, home: nodeHomeOf(i.links[0].community)!, name: i.links[0].name?.trim() || null } : got;
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

/**
 * Is this address one of the community's own names? (#3354 review, round 6: five rounds had each closed one source of a wrong
 * answer, so the precedence is one rule, and this is the whole of it.) Every state of every source: what it answers now x its
 * signed list x the device's record x its last info x whether the address answered the device as something else. ORACLE is
 * the precedence written out by hand, as the review gives it; it reads the row's states and shares nothing with the rule.
 */
describe('nameStanding: every state of every source', () => {
    const NAME = 'https://hill.example';
    const HOME = 'hill.example';
    const REACHED = 'https://riverside.example';
    const OTHERS = { addresses: ['riverside.example', 'river.example'], primaryAddress: 'riverside.example', formerAddresses: ['oldriver.example'], formerExcludesLost: true };
    /** Says it had the name before: `says` that lost ones are left out, or from a server from before it said so. */
    const HAD = (says: boolean): KnownNames['answer'] => ({ ...OTHERS, formerAddresses: [...OTHERS.formerAddresses, HOME], ...(says ? {} : { formerExcludesLost: undefined }) });
    const ANSWERS: Record<string, KnownNames['answer']> = {
        'not asked': undefined,
        'no answer': null,
        'an answer that says nothing of names': { primaryAddress: HOME, formerAddresses: [HOME], formerExcludesLost: true },
        'an answer: no names at all': { addresses: [], primaryAddress: null },
        'an answer without it': OTHERS,
        'an answer: it goes by it': { ...OTHERS, addresses: [...OTHERS.addresses, HOME] },
        'an answer: it lives at it': { addresses: ['riverside.example'], primaryAddress: HOME },
        'an answer: it had it before, lost ones left out': HAD(true),
        'an older server\'s answer: it had it before': HAD(false),
        'an older server\'s answer: it goes by it': { ...OTHERS, addresses: [...OTHERS.addresses, HOME], formerExcludesLost: undefined },
        'it says something else of lost ones than true': { ...HAD(true), formerExcludesLost: 'yes' },
    };
    const COPIES = { 'not kept': null, 'holds it': true, 'without it': false } as const;
    const INFOS = { ...COPIES, 'says nothing of names': undefined, 'it had it before, lost ones left out': true, 'it had it before, an older server': true } as const;
    const infoOf = (state: keyof typeof INFOS): KnownNames['kept']['info'] => {
        switch (state) {
            case 'not kept': return null;
            case 'holds it': return { ...OTHERS, addresses: [...OTHERS.addresses, HOME] };
            case 'without it': return OTHERS;
            case 'says nothing of names': return { formerAddresses: [HOME], formerExcludesLost: true };
            default: return HAD(state === 'it had it before, lost ones left out');
        }
    };
    const ROWS = Object.keys(ANSWERS).flatMap((answer) => (Object.keys(COPIES) as Array<keyof typeof COPIES>).flatMap((list) => (Object.keys(COPIES) as Array<keyof typeof COPIES>).flatMap((record) =>
        (Object.keys(INFOS) as Array<keyof typeof INFOS>).flatMap((info) => [false, true].map((refused) => ({ answer, list, record, info, refused }))))));

    function ORACLE({ answer, list, record, info, refused }: (typeof ROWS)[number]): NameStanding {
        switch (answer) {
            // It said what its names are, and this isn't one: whatever is kept.
            case 'an answer: no names at all': case 'an answer without it': return 'not';
            case 'an answer: it goes by it': case 'an answer: it lives at it': case 'an answer: it had it before, lost ones left out':
            case 'an older server\'s answer: it goes by it': return refused ? 'uncertain' : 'own';
            // Only a former name, of a server that doesn't say the lost ones are left out: it may be lost. Never own, never certainly not.
            case 'an older server\'s answer: it had it before': case 'it says something else of lost ones than true': return 'uncertain';
        }
        const had = info === 'it had it before, lost ones left out' || info === 'it had it before, an older server';
        if (list !== 'holds it' && record !== 'holds it' && info !== 'holds it' && !had) return 'not';
        if (answer === 'not asked' || refused) return 'uncertain';
        const infoAgrees = info === 'holds it' || info === 'it had it before, lost ones left out' || info === 'not kept' || info === 'says nothing of names';
        return list === 'holds it' && record === 'holds it' && infoAgrees ? 'own' : 'uncertain';
    }
    const namesOf = (row: (typeof ROWS)[number]): KnownNames => ({
        community: REACHED, reached: REACHED, answer: ANSWERS[row.answer],
        kept: {
            list: row.list === 'not kept' ? null : row.list === 'holds it' ? ['riverside.example', HOME] : ['riverside.example'],
            record: row.record === 'not kept' ? null : row.record === 'holds it' ? [REACHED, NAME] : [REACHED],
            info: infoOf(row.info),
        },
        refused: row.refused ? [NAME] : [],
    });

    it('is the whole of it, and every verdict is in it', () => {
        expect(ROWS.length).toBe(11 * 3 * 3 * 6 * 2);
        const count = (standing: NameStanding) => ROWS.filter((r) => ORACLE(r) === standing).length;
        // own: answered (4 x 54, not refused) and the copies agreeing under two kinds of no answer (4 infos each). not: answered
        // without it (2 x 108), and no copy with it (2 lists x 2 records x 3 infos, refused or not) under the three kinds of no answer.
        expect([count('own'), count('not'), count('uncertain')]).toEqual([4 * 54 + 2 * 4, 2 * 108 + 3 * 2 * (2 * 2 * 3), 1188 - 224 - 288]);
    });
    for (const row of ROWS) it(`${row.answer} · list ${row.list} · record ${row.record} · info ${row.info}${row.refused ? ' · answered as something else' : ''}`, () => {
        expect(nameStanding(namesOf(row), NAME)).toBe(ORACLE(row));
    });

    type Rule = typeof nameStanding;
    const MUTANTS: Record<string, Rule> = {
        '(a) a copy outranks an answer without it (the bug: the kept signed list)': (n, a) => (nameStanding(n, a) === 'not' && keptClaims(n, a) ? nameStanding({ ...n, answer: null }, a) : nameStanding(n, a)),
        '(a) an empty list is no answer (the bug)': (n, a) => nameStanding(saysNames(n.answer) && (n.answer.addresses as unknown[]).length === 0 ? { ...n, answer: null } : n, a),
        '(b) a name it had before is not its own': (n, a) => nameStanding(n.answer ? { ...n, answer: { ...n.answer, formerAddresses: [] } } : n, a),
        '(b) a name it had before is own whoever says so (the bug: an older server lists a lost one)': (n, a) => nameStanding({ ...n, answer: n.answer && { ...n.answer, formerExcludesLost: true } }, a),
        '(b) a name it had before is not its own where it doesn\'t say lost ones are left out': (n, a) => nameStanding(n.answer && n.answer.formerExcludesLost !== true ? { ...n, answer: { ...n.answer, formerAddresses: [] } } : n, a),
        '(c) a kept info\'s former name is trusted whoever said so': (n, a) => nameStanding({ ...n, kept: { ...n.kept, info: n.kept.info && { ...n.kept.info, formerExcludesLost: true } } }, a),
        '(c) a kept info\'s former name is no claim where it doesn\'t say so': (n, a) => nameStanding({ ...n, kept: { ...n.kept, info: n.kept.info && n.kept.info.formerExcludesLost !== true ? { ...n.kept.info, formerAddresses: [] } : n.kept.info } }, a),
        '(b) an address that answered as something else is own': (n, a) => nameStanding({ ...n, refused: [] }, a),
        '(c) one copy is enough': (n, a) => (nameStanding(n, a) === 'uncertain' && n.answer !== undefined && !n.refused?.length ? 'own' : nameStanding(n, a)),
        '(c) the list alone is enough': (n, a) => nameStanding({ ...n, kept: { ...n.kept, record: n.kept.list } }, a),
        '(c) the record alone is enough': (n, a) => nameStanding({ ...n, kept: { ...n.kept, list: n.kept.record } }, a),
        '(c) the last info is not weighed': (n, a) => nameStanding({ ...n, kept: { ...n.kept, info: null } }, a),
        '(c) not asked is as good as no answer': (n, a) => nameStanding({ ...n, answer: n.answer ?? null }, a),
        'no copy claims anything': (n, a) => nameStanding({ ...n, kept: {} }, a),
    };
    for (const [name, mutant] of Object.entries(MUTANTS)) {
        it(`without the rule: ${name}, gets rows wrong`, () => {
            expect(ROWS.filter((r) => mutant(namesOf(r), NAME) !== ORACLE(r)).length).toBeGreaterThan(0);
        });
    }
});

describe('nameStanding: what an address is', () => {
    const said = (answer: KnownNames['answer'], more: Partial<KnownNames> = {}): KnownNames => ({ community: HERE, reached: HERE, answer, kept: {}, ...more });
    it.each([
        { name: 'the address reached: own with nothing asked', names: said(undefined), address: 'HTTPS://Riverside.example:443/x?y', want: 'own' },
        { name: 'the address reached: own though its answer names none (a server that knows no address of its own)', names: said({ addresses: [], primaryAddress: null }), address: HERE, want: 'own' },
        { name: 'the address it is kept under is not the one it is reached at: weighed as any other', names: said({ addresses: ['river.example'] }, { community: HERE, reached: 'https://river.example' }), address: HERE, want: 'not' },
        { name: 'however spelled', names: said({ addresses: ['River.example'] }), address: 'https://RIVER.example/', want: 'own' },
        { name: 'a home (a card\'s, a chat\'s)', names: said({ addresses: ['river.example'] }), address: 'river.example', want: 'own' },
        { name: 'the same host on another port is another server', names: said({ addresses: ['riverside.example'] }), address: 'https://riverside.example:8443', want: 'not' },
        { name: 'a name said with no port is on the port it is reached at, for that host only', names: said({ addresses: ['coop.example', 'other.example'] }, { reached: 'https://coop.example:8443' }), address: 'https://coop.example', want: 'not' },
        { name: 'and another host it names is on 443', names: said({ addresses: ['coop.example', 'other.example'] }, { reached: 'https://coop.example:8443' }), address: 'https://other.example', want: 'own' },
        { name: 'unless its signed list spells that host\'s port', names: said({ addresses: ['coop.example', 'other.example'] }, { reached: 'https://coop.example:8443', kept: { list: ['other.example:8443'] } }), address: 'https://other.example:8443', want: 'own' },
        { name: 'a list spells a port, never a name the answer leaves out', names: said({ addresses: ['coop.example'] }, { kept: { list: ['other.example:8443'] } }), address: 'https://other.example:8443', want: 'not' },
        { name: 'anything said that is no address is dropped', names: said({ addresses: [7, null, 'not an address', 'river.example'], formerAddresses: 'river2.example', primaryAddress: null }), address: 'https://river2.example', want: 'not' },
        { name: 'an IPv6 number, however spelled', names: said({ addresses: ['[2001:db8::7]'] }), address: 'https://[2001:DB8:0:0::7]:443/', want: 'own' },
        { name: 'a name with an underscore', names: said({ addresses: ['river_side.example'] }), address: 'https://river_side.example', want: 'own' },
        { name: 'a former name on the port its signed list spells, from a server that says lost ones are left out', names: said({ addresses: ['coop.example'], formerAddresses: ['other.example'], formerExcludesLost: true }, { kept: { list: ['other.example:8443'] } }), address: 'https://other.example:8443', want: 'own' },
        { name: 'the same, from an older server', names: said({ addresses: ['coop.example'], formerAddresses: ['other.example'] }, { kept: { list: ['other.example:8443'] } }), address: 'https://other.example:8443', want: 'uncertain' },
        { name: 'one it goes by and lists as former too, from an older server', names: said({ addresses: ['river.example'], formerAddresses: ['river.example'] }), address: 'https://river.example', want: 'own' },
        { name: 'the address reached, which an older server lists only as former', names: said({ addresses: ['river.example'], formerAddresses: ['riverside.example'] }), address: HERE, want: 'own' },
        { name: 'no address', names: said({ addresses: ['river.example'] }), address: 'not an address', want: 'not' },
        { name: 'none', names: said({ addresses: ['river.example'] }), address: null, want: 'not' },
    ] as Array<{ name: string; names: KnownNames; address: string | null; want: NameStanding }>)('$name', ({ names, address, want }) => {
        expect(nameStanding(names, address)).toBe(want);
    });

    it.each([
        { name: 'none published', said: { addresses: [], primaryAddress: null }, names: true },
        { name: 'one', said: { addresses: ['riverside.example'] }, names: true },
        { name: 'no list (an older server)', said: { primaryAddress: 'riverside.example' }, names: false },
        { name: 'nothing read', said: null, names: false },
    ])('says something of its names: $name -> $names', ({ said: s, names }) => {
        expect(saysNames(s)).toBe(names);
    });

    // #3354 review, round 5: a community with no address of its own sends nothing across (its server answers 503 no_home).
    it.each([
        { name: 'none published', said: { addresses: [], primaryAddress: null }, want: true },
        { name: 'none published, no main said', said: { addresses: [] }, want: true },
        { name: 'a name with no route yet: published, not where it lives', said: { addresses: ['riverside.example'], primaryAddress: null }, want: true },
        { name: 'one published, and lived at', said: { addresses: ['riverside.example'], primaryAddress: 'riverside.example' }, want: false },
        { name: 'no main said (an older server): not known', said: { addresses: ['riverside.example'] }, want: false },
        { name: 'nothing said of addresses (an older server): not known', said: { primaryAddress: null }, want: false },
        { name: 'nothing read: not known', said: null, want: false },
    ])('knows no address of its own: $name -> $want', ({ said: s, want }) => {
        expect(saysNoHome(s)).toBe(want);
    });
});

/** Two communities on the device, each with one claim on one name: written out by hand, both ways round. */
describe('whoseName: one name, two communities', () => {
    const NAME = 'https://hill.example';
    const CLAIMS: Record<string, (c: string) => KnownNames> = {
        'reached at it': (c) => ({ community: c, reached: NAME, kept: {}, answer: { addresses: [] } }),
        'answers it goes by it': (c) => ({ community: c, reached: c, kept: {}, answer: { addresses: ['hill.example'] } }),
        'answers it had it before': (c) => ({ community: c, reached: c, kept: {}, answer: { addresses: [], formerAddresses: ['hill.example'], formerExcludesLost: true } }),
        'answers it had it before, an older server': (c) => ({ community: c, reached: c, kept: {}, answer: { addresses: [], formerAddresses: ['hill.example'] } }),
        'no answer, its copies agree': (c) => ({ community: c, reached: c, answer: null, kept: { list: ['hill.example'], record: [NAME], info: { addresses: ['hill.example'] } } }),
        'no answer, its copies differ': (c) => ({ community: c, reached: c, answer: null, kept: { list: ['hill.example'], record: [c], info: null } }),
        'answers it is not its name, its copies say so': (c) => ({ community: c, reached: c, answer: { addresses: ['elsewhere.example'] }, kept: { list: ['hill.example'], record: [NAME], info: { addresses: ['hill.example'] } } }),
        'has nothing to do with it': (c) => ({ community: c, reached: c, answer: null, kept: { list: [], record: [c], info: { addresses: [] } } }),
    };
    /** `1`: the first's; `2`: the second's; `?`: not certain; `-`: neither's. One line a claim of the first's, one letter a claim of the second's, in CLAIMS' order. */
    const WANT = ['11111111', '2?????11', '2?????11', '2???????', '2?????11', '2???????', '222?2?--', '222?2?--'];
    const rows = Object.keys(CLAIMS).flatMap((first, i) => Object.keys(CLAIMS).map((second, j) => ({ first, second, want: WANT[i][j] })));
    it.each(rows)('the first $first; the second $second -> $want', ({ first, second, want }) => {
        const got: WhoseName = whoseName([CLAIMS[first](HERE), CLAIMS[second](HELD_A)])(NAME);
        expect(got.whose === 'one' ? (got.community === HERE ? '1' : '2') : got.whose === 'none' ? '-' : '?').toBe(want);
    });
    it('the only one with a claim: its, if it is certain', () => {
        for (const [claim, of] of Object.entries(CLAIMS)) {
            expect([claim, whoseName([of(HERE)])(NAME).whose]).toEqual([claim, { 'answers it had it before, an older server': 'uncertain', 'no answer, its copies differ': 'uncertain', 'answers it is not its name, its copies say so': 'none', 'has nothing to do with it': 'none' }[claim] ?? 'one']);
        }
        expect(whoseName([])(NAME)).toEqual({ whose: 'none' });
        for (const address of ['not an address', null, undefined]) expect(whoseName([CLAIMS['answers it goes by it'](HERE)])(address)).toEqual({ whose: 'none' });
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
