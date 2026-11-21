/**
 * Which chat Message opens (S5 part 2: DESIGN-no-switch-messaging-fable.md §3 "Which path a new chat takes"): an existing
 * chat wins, else the community you share (the one set to first), else across. The path table, for the phone (a set-to
 * community and held ones) and the web (one community, none held), and the note under a first line across. Each rule is
 * taken out in turn (mutants) and every one gets rows wrong.
 */
import { describe, expect, it } from 'vitest';
import { ACROSS_FIRST_LINE_NOTE, acrossFirstLineNoteUnder, messagePathFor, type KnownChat, type MessageLink, type MessagePath } from '../message-path';
import { nodeHomeOf } from '../node-request-signing';

const HERE = 'https://riverside.example';
const HELD_A = 'https://hillside.example';
const HELD_B = 'https://lakeside.example';
const AWAY = 'https://faraway.example';
const K = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const same = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

type Input = Parameters<typeof messagePathFor>[0];
const phone = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ links, chats, setTo: HERE, held: [HELD_A, HELD_B], same, blocked });
const web = (links: MessageLink[], chats: KnownChat[] = [], blocked = false): Input => ({ links, chats, setTo: HERE, held: [], same, blocked });

interface Row { name: string; input: Input; want: MessagePath }
const dHere: KnownChat = { kind: 'direct', community: HERE, id: 'd-here', key: K };
const dA: KnownChat = { kind: 'direct', community: HELD_A, id: 'd-a', key: K };
const dB: KnownChat = { kind: 'direct', community: HELD_B, id: 'd-b', key: K };
const dGone: KnownChat = { kind: 'direct', community: AWAY, id: 'd-gone', key: K };
const xHere: KnownChat = { kind: 'across', community: null, id: 'x-here', key: K };
const xA: KnownChat = { kind: 'across', community: HELD_A, id: 'x-a', key: K };
const xGone: KnownChat = { kind: 'across', community: AWAY, id: 'x-gone', key: K };
const other: KnownChat = { kind: 'direct', community: HERE, id: 'd-other', key: K2 };
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
