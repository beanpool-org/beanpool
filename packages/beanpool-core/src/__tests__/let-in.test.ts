/**
 * Let in once, core's one rule over plain facts (S3b; moved into core for both apps in S5 part 3:
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3 "Let in once"). One table (close the class): every fact the
 * rule reads, each in the form the member's own step makes and in each form someone else's word makes, x the block {none,
 * blocked} x the key {the person's now, one a re-key replaced} -> let in or not. Let in exactly when the fact is the
 * member's own step, nothing blocks, and the key is the person's now. Then the pieces both apps read: whose key a chat is
 * with, whether the member took part in it, which lines are the member's own, and when the contacts are worth opening.
 */
import { describe, expect, it } from 'vitest';
import {
    chatLetsInKey, contactsCouldLetIn, isLetIn, isMembersOwnLine, letInAmong, letInByFacts, memberTookPart,
    type LetInChat, type LetInFacts,
} from '../let-in';
import { DM_FROM_ADMINS_KEY, DM_NONCE_PREFIX } from '../dm-crypto';

const ME = 'a'.repeat(64);
const THEM = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const OLD = 'd'.repeat(64);

const chat = (c: Partial<LetInChat>): LetInChat => ({ others: [THEM], memberWrote: false, acceptedByMember: false, ...c });

interface Source { name: string; facts: LetInFacts; contacts?: string[]; letsIn: boolean }

/** Every fact the rule reads, as the member's own step makes it and as someone else's word does. */
const SOURCES: Source[] = [
    // The member's own step: let in.
    { name: 'a direct chat the member wrote a line in', facts: { chats: [chat({ memberWrote: true })] }, letsIn: true },
    { name: 'a direct chat whose request the member accepted', facts: { chats: [chat({ acceptedByMember: true })] }, letsIn: true },
    { name: 'a direct chat both wrote in and accepted', facts: { chats: [chat({ memberWrote: true, acceptedByMember: true })] }, letsIn: true },
    { name: 'a chat sealed to them, its rows naming an old key too', facts: { chats: [chat({ others: [THEM, OLD], sealedTo: THEM, memberWrote: true })] }, letsIn: true },
    { name: 'a friend the member added', facts: { friends: [{ owner: ME, friend: THEM }] }, letsIn: true },
    { name: 'a deal the member bought in, pending', facts: { deals: [{ buyer: ME, seller: THEM, status: 'pending', listingAuthor: THEM }] }, letsIn: true },
    { name: 'a deal the member bought in, completed', facts: { deals: [{ buyer: ME, seller: THEM, status: 'completed', listingAuthor: ME }] }, letsIn: true },
    { name: 'a deal the member sold in, on the buyer\'s own Need, pending', facts: { deals: [{ buyer: THEM, seller: ME, status: 'pending', listingAuthor: THEM }] }, letsIn: true },
    { name: 'a deal the member sold in, on the buyer\'s own Need, completed', facts: { deals: [{ buyer: THEM, seller: ME, status: 'completed', listingAuthor: THEM }] }, letsIn: true },
    { name: 'someone the member paid', facts: { payments: [{ from: ME, to: THEM }] }, letsIn: true },
    { name: 'a private contact the member linked', facts: {}, contacts: [THEM], letsIn: true },
    // Someone else's word, or nobody's: not let in.
    { name: 'nothing at all', facts: {}, letsIn: false },
    { name: 'a direct chat only they wrote in', facts: { chats: [chat({})] }, letsIn: false },
    { name: 'a chat the member wrote in, its rows naming two others and no seal', facts: { chats: [chat({ others: [THEM, OTHER], memberWrote: true })] }, letsIn: false },
    { name: 'a chat the member wrote in, sealed to someone else', facts: { chats: [chat({ sealedTo: OTHER, memberWrote: true })] }, letsIn: false },
    { name: 'a chat the member wrote in, its seal empty', facts: { chats: [chat({ sealedTo: '', memberWrote: true })] }, letsIn: false },
    { name: 'a friend row where they added the member', facts: { friends: [{ owner: THEM, friend: ME }] }, letsIn: false },
    { name: 'a deal the member only asked for', facts: { deals: [{ buyer: ME, seller: THEM, status: 'requested', listingAuthor: THEM }] }, letsIn: false },
    { name: 'a deal declined', facts: { deals: [{ buyer: ME, seller: THEM, status: 'rejected', listingAuthor: THEM }] }, letsIn: false },
    { name: 'a deal cancelled', facts: { deals: [{ buyer: ME, seller: THEM, status: 'cancelled', listingAuthor: THEM }] }, letsIn: false },
    { name: 'a deal on the member\'s own Offer that they took up', facts: { deals: [{ buyer: THEM, seller: ME, status: 'completed', listingAuthor: ME }] }, letsIn: false },
    { name: 'a deal the member sold in, its listing not held', facts: { deals: [{ buyer: THEM, seller: ME, status: 'pending', listingAuthor: null }] }, letsIn: false },
    { name: 'a deal between two others on their own Need', facts: { deals: [{ buyer: THEM, seller: OTHER, status: 'completed', listingAuthor: THEM }] }, letsIn: false },
    { name: 'a payment they sent the member', facts: { payments: [{ from: THEM, to: ME }] }, letsIn: false },
    { name: 'a payment between two others', facts: { payments: [{ from: OTHER, to: THEM }] }, letsIn: false },
    { name: 'a contact linked to someone else', facts: {}, contacts: [OTHER], letsIn: false },
];

interface Column { name: string; blocked: boolean; notCurrent: string[]; passes: boolean }
const COLUMNS: Column[] = [
    { name: 'nothing else', blocked: false, notCurrent: [], passes: true },
    { name: 'blocked', blocked: true, notCurrent: [], passes: false },
    { name: 'their key replaced by a re-key', blocked: false, notCurrent: [THEM], passes: false },
    { name: 'blocked and their key replaced', blocked: true, notCurrent: [THEM], passes: false },
    { name: 'another key replaced', blocked: false, notCurrent: [OLD, OTHER], passes: true },
];

describe('let in once: facts x block x key -> let in or not (one table)', () => {
    for (const source of SOURCES) {
        for (const column of COLUMNS) {
            const want = source.letsIn && column.passes;
            it(`${source.name} | ${column.name} -> ${want ? 'let in' : 'not'}`, () => {
                const known = { byFacts: letInByFacts(ME, source.facts), notCurrent: new Set(column.notCurrent), contacts: new Set(source.contacts ?? []) };
                expect(isLetIn({ ...known, key: THEM, blocked: column.blocked })).toBe(want);
                expect(letInAmong([THEM], known).has(THEM)).toBe(source.letsIn && !column.notCurrent.includes(THEM));
            });
        }
    }

    it('never lets the member in, whatever names them', () => {
        const facts: LetInFacts = {
            chats: [chat({ others: [ME], memberWrote: true }), chat({ others: [THEM], sealedTo: ME, memberWrote: true })],
            friends: [{ owner: ME, friend: ME }],
            deals: [{ buyer: ME, seller: ME, status: 'completed', listingAuthor: ME }],
            payments: [{ from: ME, to: ME }],
        };
        expect([...letInByFacts(ME, facts)]).toEqual([]);
    });

    it('a fact left out lets nobody in by it; every fact counts together', () => {
        const facts: LetInFacts = { friends: [{ owner: ME, friend: THEM }], payments: [{ from: ME, to: OTHER }] };
        expect([...letInByFacts(ME, facts)].sort()).toEqual([THEM, OTHER].sort());
        expect(letInAmong([THEM, OTHER, OLD], { byFacts: letInByFacts(ME, facts), notCurrent: new Set([OTHER]) })).toEqual(new Set([THEM]));
    });

    it('a contact is only read when it could let in more (the phone opens its list only then)', () => {
        const byFacts = new Set([THEM]);
        expect(contactsCouldLetIn([THEM], { byFacts, notCurrent: new Set() })).toBe(false);
        expect(contactsCouldLetIn([OTHER], { byFacts, notCurrent: new Set() })).toBe(true);
        expect(contactsCouldLetIn([OTHER], { byFacts, notCurrent: new Set([OTHER]) })).toBe(false);
        expect(contactsCouldLetIn(['', THEM], { byFacts, notCurrent: new Set() })).toBe(false);
    });
});

describe('the pieces both apps read', () => {
    it('whom a chat is with: its seal, else its one other person, never the member', () => {
        expect(chatLetsInKey({ others: [THEM] }, ME)).toBe(THEM);
        expect(chatLetsInKey({ others: [THEM, ME] }, ME)).toBe(THEM);
        expect(chatLetsInKey({ others: [THEM, OTHER] }, ME)).toBeNull();
        expect(chatLetsInKey({ others: [THEM, OTHER], sealedTo: OTHER }, ME)).toBe(OTHER);
        expect(chatLetsInKey({ others: [THEM], sealedTo: null }, ME)).toBe(THEM);
        expect(chatLetsInKey({ others: [THEM], sealedTo: '' }, ME)).toBeNull();
        expect(chatLetsInKey({ others: [], sealedTo: ME }, ME)).toBeNull();
        expect(chatLetsInKey({ others: [] }, ME)).toBeNull();
    });

    it('the member took part: a line of theirs, or an accept of theirs', () => {
        expect(memberTookPart({ memberWrote: true, acceptedByMember: false })).toBe(true);
        expect(memberTookPart({ memberWrote: false, acceptedByMember: true })).toBe(true);
        expect(memberTookPart({ memberWrote: false, acceptedByMember: false })).toBe(false);
    });

    const SEALED = `${DM_NONCE_PREFIX}abc`;
    const LINES: Array<[string, Parameters<typeof isMembersOwnLine>[0], boolean]> = [
        ['a sealed line of mine', { authorPubkey: ME, nonce: SEALED, type: 'text' }, true],
        ['a sealed line of mine with no type', { authorPubkey: ME, nonce: SEALED, type: null }, true],
        ['a sealed picture of mine', { authorPubkey: ME, nonce: SEALED, type: 'image' }, true],
        ['a sealed line of mine, metadata not JSON', { authorPubkey: ME, nonce: SEALED, metadata: '{not json' }, true],
        ['a sealed line of theirs', { authorPubkey: THEM, nonce: SEALED }, false],
        ['a node notice in my name', { authorPubkey: ME, nonce: SEALED, type: 'system' }, false],
        ['a line in my name that is not sealed', { authorPubkey: ME, nonce: 'plaintext-v1' }, false],
        ['a line in my name with no nonce', { authorPubkey: ME, nonce: null }, false],
        ['the admin page\'s message in my name (metadata text)', { authorPubkey: ME, nonce: SEALED, metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: true }) }, false],
        ['the admin page\'s message in my name (metadata object)', { authorPubkey: ME, nonce: SEALED, metadata: { [DM_FROM_ADMINS_KEY]: true } }, false],
        ['the admin mark as SQLite reads it (1)', { authorPubkey: ME, nonce: SEALED, metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: 1 }) }, false],
        ['an admin mark that is false', { authorPubkey: ME, nonce: SEALED, metadata: JSON.stringify({ [DM_FROM_ADMINS_KEY]: false }) }, true],
    ];
    for (const [name, line, want] of LINES) {
        it(`a line of the member's own: ${name} -> ${want}`, () => {
            expect(isMembersOwnLine(line, ME)).toBe(want);
        });
    }
    it('no member, no line of theirs', () => {
        expect(isMembersOwnLine({ authorPubkey: '', nonce: SEALED }, '')).toBe(false);
    });
});
