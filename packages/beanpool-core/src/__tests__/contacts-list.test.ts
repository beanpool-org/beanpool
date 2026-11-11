import { describe, it, expect } from 'vitest';
import {
    contactAlreadyInList, contactsFromCandidates, dropOldContactMarkers, emptyContactsList, mergeContactsLists, putContact, readContact,
    readContactsList, removeContact, removeEveryContact, writeContactsList, CONTACTS_LIMITS, type Contact, type ContactsList,
} from '../contacts-list.js';

// The list and its merge rule (DESIGN-private-contacts-fable.md §4.1, §4.5, §11 "Core (C0)").

const id = (n: number) => n.toString(16).padStart(32, '0');
const c = (n: number, name: string, clock = 0, more: Partial<Contact> = {}): Contact =>
    ({ id: id(n), name, phones: [], emails: [], note: '', links: [], invite: null, clock, ...more });
const listOf = (contacts: Contact[], removed: ContactsList['removed'] = []): ContactsList => ({ v: 1, contacts, removed });
const T0 = new Date('2026-11-11T10:00:00.000Z');

describe('merging two devices (done on a device, never on a server)', () => {
    it('two phones that both changed the list offline end with the same list, merged in either order', () => {
        const start = listOf([c(1, 'Sam', 1), c(2, 'Dee', 1)]);
        // Phone A renames Sam and adds Ana; phone B removes Dee and adds Tom.
        const a = putContact(putContact(start, { ...c(1, 'Sam Jones') }), c(3, 'Ana'));
        const b = putContact(removeContact(start, id(2), T0), c(4, 'Tom'));
        const ab = mergeContactsLists(a, b);
        const ba = mergeContactsLists(b, a);
        expect(writeContactsList(ab)).toBe(writeContactsList(ba));
        expect(ab.contacts.map((x) => x.name)).toEqual(['Sam Jones', 'Ana', 'Tom']);
        expect(ab.removed.map((m) => m.id)).toEqual([id(2)]);
        // And with a third device's copy, in any grouping.
        const third = putContact(start, c(5, 'Lee'));
        expect(writeContactsList(mergeContactsLists(mergeContactsLists(a, b), third))).toBe(writeContactsList(mergeContactsLists(a, mergeContactsLists(b, third))));
    });

    it('a removal never comes back from an older copy, however it is merged', () => {
        const old = listOf([c(1, 'Sam', 4), c(2, 'Dee', 2)]);
        const now = removeContact(old, id(2), T0);
        expect(mergeContactsLists(now, old).contacts.map((x) => x.id)).toEqual([id(1)]);
        expect(mergeContactsLists(old, now).contacts.map((x) => x.id)).toEqual([id(1)]);
        // Remove everyone: an empty list with every marker, which no older copy refills.
        const none = removeEveryContact(old, T0);
        expect(none.contacts).toEqual([]);
        expect(mergeContactsLists(old, none).contacts).toEqual([]);
        expect(none.removed.map((m) => m.clock)).toEqual([5, 3]);
    });

    it('a tie resolves the same on both devices: a marker over a contact, else the same one of two contacts', () => {
        const left = listOf([c(1, 'Sam A', 3)]);
        const right = listOf([c(1, 'Sam B', 3)]);
        expect(mergeContactsLists(left, right)).toEqual(mergeContactsLists(right, left));
        expect(mergeContactsLists(left, right).contacts[0].name).toBe('Sam B');
        const gone = listOf([], [{ id: id(1), clock: 3, at: T0.toISOString() }]);
        expect(mergeContactsLists(left, gone).contacts).toEqual([]);
        expect(mergeContactsLists(gone, left).contacts).toEqual([]);
    });

    it('a merge keeps everyone, even past the limit: the apps say so and the member chooses', () => {
        const a = listOf(Array.from({ length: 1500 }, (_, i) => c(i, `A${i}`)));
        const b = listOf(Array.from({ length: 1500 }, (_, i) => c(10_000 + i, `B${i}`)));
        expect(mergeContactsLists(a, b).contacts.length).toBe(3000);
        expect(CONTACTS_LIMITS.contacts).toBe(2000);
    });

    it('a marker goes after a year, and only then', () => {
        const l = listOf([], [{ id: id(1), clock: 2, at: '2025-11-12T10:00:00.000Z' }, { id: id(2), clock: 2, at: '2025-11-10T10:00:00.000Z' }]);
        expect(dropOldContactMarkers(l, T0).removed.map((m) => m.id)).toEqual([id(1)]);
    });
});

describe('reading a list opened from a box: nothing in it is trusted', () => {
    it('reads what the apps write, and writes it back byte for byte', () => {
        const l = putContact(emptyContactsList(), c(7, 'Dee Walker', 0, { phones: ['0412 345 678'], emails: ['Dee@Example.org'], note: 'Seedlings' }));
        const json = writeContactsList(l);
        const back = readContactsList(json);
        expect(back.ok && writeContactsList(back.list)).toBe(json);
    });

    it('refuses a list a newer app wrote (never read in part) and anything that is not a list', () => {
        expect(readContactsList('{"v":2,"contacts":[],"removed":[]}')).toEqual({ ok: false, reason: 'newer' });
        expect(readContactsList('not json')).toEqual({ ok: false, reason: 'unreadable' });
        expect(readContactsList('[]')).toEqual({ ok: false, reason: 'unreadable' });
        expect(readContactsList('{"v":1,"contacts":{}}')).toEqual({ ok: false, reason: 'unreadable' });
    });

    it('drops what is malformed, cuts what is long, and takes the reordering marks out of a name', () => {
        const long = 'x'.repeat(500);
        const raw = JSON.stringify({
            v: 1,
            contacts: [
                { id: id(1), name: `Sam‮${long}`, phones: ['a', '1', '2', '3', '4', '5', '6'], emails: ['x@y', 'bad', 'X@Y'], note: long, links: [{ key: 'zz' }], invite: { code: 'bad code' }, clock: 1 },
                { id: 'short', name: 'No id', clock: 1 },
                { id: id(2), name: 'No clock' },
                { id: id(3), name: '', phones: [], emails: [], clock: 0 },
            ],
            removed: [{ id: id(9), clock: 'x', at: T0.toISOString() }],
        });
        const r = readContactsList(raw);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.list.contacts).toHaveLength(1);
        const sam = r.list.contacts[0];
        expect(sam.name.startsWith('Samx')).toBe(true);
        expect(Array.from(sam.name)).toHaveLength(CONTACTS_LIMITS.nameChars);
        expect(sam.phones).toEqual(['1', '2', '3', '4', '5']);
        expect(sam.emails).toEqual(['x@y']);
        expect(Array.from(sam.note)).toHaveLength(CONTACTS_LIMITS.noteChars);
        expect(sam.links).toEqual([]);
        expect(sam.invite).toBeNull();
        expect(r.list.removed).toEqual([]);
    });

    it('a contact with no name is called by its number or email', () => {
        expect(readContact({ id: id(1), name: '', phones: ['0400 111 222'], emails: [], clock: 0 })?.name).toBe('0400 111 222');
    });
});

describe('import: who is already in the list', () => {
    const l = listOf([
        c(1, 'Sam Jones', 0, { phones: ['0412 345 678'] }),
        c(2, 'Dee', 0, { emails: ['dee@example.org'] }),
        c(3, 'Old Work'),
    ]);

    it('the same number (by its digits), the same email, or the same name with neither', () => {
        expect(contactAlreadyInList(l, { name: 'Samuel', phones: ['0412345678'], emails: [], note: '' })).toBe(true);
        expect(contactAlreadyInList(l, { name: 'D', phones: [], emails: ['DEE@example.org'], note: '' })).toBe(true);
        expect(contactAlreadyInList(l, { name: 'old work', phones: [], emails: [], note: '' })).toBe(true);
        expect(contactAlreadyInList(l, { name: 'Sam Jones', phones: ['0499 000 000'], emails: [], note: '' })).toBe(false);
        expect(contactAlreadyInList(l, { name: 'Tom', phones: ['0412 000 000'], emails: [], note: '' })).toBe(false);
    });

    it('candidates become contacts with ids of their own, the unreadable left out', () => {
        let n = 100;
        const made = contactsFromCandidates([
            { name: 'Ana', phones: ['1'], emails: [], note: '' },
            { name: '', phones: [], emails: [], note: '' },
        ], () => id(n++));
        expect(made.map((x) => [x.id, x.name, x.clock])).toEqual([[id(100), 'Ana', 0]]);
    });
});
