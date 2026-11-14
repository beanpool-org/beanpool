/**
 * Import on the phone (utils/contacts-import.ts, DESIGN-private-contacts-fable.md §3.4, §5.4, §11, slice C3): the
 * permission asked once, at the tap, with its three answers; the phone's contacts read in pages, names, numbers and emails
 * only; a contacts file picked, held to its size, read once and never left behind; the review rows; and the import made in
 * one change. Each check names the change that turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    CONTACTS_FILE_MAX_BYTES, CONTACTS_FILE_WORDS, contactAlreadyInList, emptyContactsList, newContactId, putContact, writeContactsVcard,
    type ContactCandidate, type ContactsList,
} from '@beanpool/core';
import {
    PHONE_CONTACT_FIELDS, PHONE_CONTACTS_PAGE, askForPhoneContacts, candidateOfPhoneContact, importChosen, pickContactsFile, readPhoneContacts,
    reviewRows, type ContactsPickerModules, type PhoneContact, type PhoneContactsModule,
} from '../contacts-import';
import { loadContacts, type ContactsAccount } from '../contacts-store';
import { resetContactsCheckForTests, syncContacts, type ContactsSyncDeps } from '../contacts-sync';

const RIVERSIDE = 'https://riverside.example';

function person(): ContactsAccount {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

/** The phone's contacts library, faked: what the permission answers, and `n` people in the address book. */
function library(answer: { granted: boolean; canAskAgain: boolean; accessPrivileges?: 'all' | 'limited' | 'none' }, people: PhoneContact[] = []) {
    const calls: { ask: number; queries: { fields: readonly string[]; pageSize: number; pageOffset: number }[] } = { ask: 0, queries: [] };
    const m: PhoneContactsModule = {
        async requestPermissionsAsync() {
            calls.ask++;
            return { ...answer, status: answer.granted ? 'granted' : 'denied' };
        },
        async getContactsAsync(q) {
            calls.queries.push(q);
            const data = people.slice(q.pageOffset, q.pageOffset + q.pageSize);
            return { data, hasNextPage: q.pageOffset + q.pageSize < people.length };
        },
    };
    return { m, calls };
}

const addressBook = (n: number): PhoneContact[] => Array.from({ length: n }, (_, i) => ({
    name: `Person ${i}`, phoneNumbers: [{ number: `0412 ${String(i).padStart(6, '0')}` }], emails: [{ email: `p${i}@mail.example` }],
}));

describe('the permission is asked once, at the tap, and each answer has its own way on (design §3.4)', () => {
    it('yes, and an iPhone on selected contacts only, read the contacts; nothing is read before the answer', async () => {
        for (const accessPrivileges of ['all', 'limited'] as const) {
            const { m, calls } = library({ granted: true, canAskAgain: true, accessPrivileges }, addressBook(3));
            expect(calls.ask).toBe(0);
            expect(await askForPhoneContacts(m)).toBe('granted');
            expect(calls.ask).toBe(1);
            // Mutation: read the contacts inside the ask (before the member has seen the answer's screen) → queries > 0.
            expect(calls.queries).toHaveLength(0);
        }
    });

    it('no, and no for good, are told apart by whether the phone may ask again', async () => {
        // Mutation: map every refusal to one answer → the blocked case reads 'denied'.
        expect(await askForPhoneContacts(library({ granted: false, canAskAgain: true }).m)).toBe('denied');
        expect(await askForPhoneContacts(library({ granted: false, canAskAgain: false }).m)).toBe('blocked');
    });

    it('a library that throws is a no for now, never a crash and never a read', async () => {
        const m: PhoneContactsModule = {
            requestPermissionsAsync: async () => { throw new Error('gone'); },
            getContactsAsync: async () => { throw new Error('never'); },
        };
        expect(await askForPhoneContacts(m)).toBe('denied');
    });
});

describe('the phone\'s contacts are read in pages, names, numbers and emails only', () => {
    it('asks for those fields alone (never a note, a picture or an address) in pages, and makes candidates', async () => {
        const { m, calls } = library({ granted: true, canAskAgain: true }, addressBook(1234));
        const got = await readPhoneContacts(m);
        expect(got).toHaveLength(1234);
        // Mutation: drop `fields` (expo-contacts then returns every field, notes and pictures included) → fails.
        expect([...PHONE_CONTACT_FIELDS].sort()).toEqual(['emails', 'firstName', 'lastName', 'name', 'phoneNumbers']);
        for (const q of calls.queries) expect(q.fields).toEqual(PHONE_CONTACT_FIELDS);
        expect(calls.queries.map((q) => q.pageOffset)).toEqual([0, PHONE_CONTACTS_PAGE, 2 * PHONE_CONTACTS_PAGE]);
        expect(got[7]).toEqual({ name: 'Person 7', phones: ['0412 000007'], emails: ['p7@mail.example'], note: '' });
    });

    it('a person: the name, else first and last; numbers as written, each once, at most 5; emails each once, at most 3', () => {
        expect(candidateOfPhoneContact({ firstName: 'Sam', lastName: 'Jones', phoneNumbers: [{ number: '0412 345 678' }, { number: '0412345678' }, { number: '' }] }))
            .toEqual({ name: 'Sam Jones', phones: ['0412 345 678'], emails: [], note: '' });
        const many = candidateOfPhoneContact({ name: 'Many', phoneNumbers: Array.from({ length: 8 }, (_, i) => ({ number: `0${i}` })), emails: ['a@x.example', 'A@x.example', 'b@x.example', 'c@x.example', 'd@x.example'].map((email) => ({ email })) });
        expect(many?.phones).toHaveLength(5);
        expect(many?.emails).toEqual(['a@x.example', 'b@x.example', 'c@x.example']);
        // A name that hides direction marks loses them (core's cleaning).
        expect(candidateOfPhoneContact({ name: 'Ev‮il' })?.name).toBe('Evil');
        // Nothing to call them by: not offered.
        expect(candidateOfPhoneContact({ phoneNumbers: [{ number: 'n/a' }] })).toBeNull();
    });
});

describe('a contacts file: picked with no permission, held to its size, read once, never left on the phone', () => {
    const vcf = writeContactsVcard([{ name: 'Dee Walker', phones: ['0412 345 678'], emails: [], note: '' }, { name: 'Sam Jones', phones: [], emails: ['sam@mail.example'], note: '' }]);
    function picker(asset: { uri: string; size?: number } | null, text: string | Error = vcf) {
        const removed: string[] = [];
        const read: string[] = [];
        const m: ContactsPickerModules = {
            DocumentPicker: { getDocumentAsync: async () => (asset ? { canceled: false, assets: [asset] } : { canceled: true, assets: null }) },
            FileSystem: {
                readAsStringAsync: async (uri) => { read.push(uri); if (text instanceof Error) throw text; return text; },
                deleteAsync: async (uri) => { removed.push(uri); },
            },
        };
        return { m, removed, read };
    }

    it('reads the people in it, and removes the copy the picker made', async () => {
        const p = picker({ uri: 'file:///cache/DocumentPicker/a.vcf', size: vcf.length });
        const r = await pickContactsFile(p.m);
        expect(r.kind).toBe('read');
        if (r.kind === 'read') expect(r.candidates.map((c) => c.name)).toEqual(['Dee Walker', 'Sam Jones']);
        // Mutation: drop the removal → the unlocked file stays in the app's cache.
        expect(p.removed).toEqual(['file:///cache/DocumentPicker/a.vcf']);
    });

    it('a file over 25 MB is refused before it is read; one that is not a contacts file says so; both copies removed', async () => {
        const big = picker({ uri: 'file:///big.vcf', size: CONTACTS_FILE_MAX_BYTES + 1 });
        expect(await pickContactsFile(big.m)).toEqual({ kind: 'refused', words: CONTACTS_FILE_WORDS.tooBig });
        expect(big.read).toEqual([]);
        expect(big.removed).toEqual(['file:///big.vcf']);
        const notCard = picker({ uri: 'file:///photo.jpg', size: 10 }, 'not a card');
        expect(await pickContactsFile(notCard.m)).toEqual({ kind: 'refused', words: CONTACTS_FILE_WORDS.notVcard });
        expect(notCard.removed).toEqual(['file:///photo.jpg']);
        const unreadable = picker({ uri: 'file:///x.bin', size: 10 }, new Error('binary'));
        expect(await pickContactsFile(unreadable.m)).toEqual({ kind: 'refused', words: CONTACTS_FILE_WORDS.notVcard });
        expect(unreadable.removed).toEqual(['file:///x.bin']);
    });

    it('closed without choosing: nothing to say', async () => {
        expect(await pickContactsFile(picker(null).m)).toEqual({ kind: 'cancelled' });
    });
});

describe('Choose who to bring: the same rows as the web\'s', () => {
    it('marks who is already in the list exactly as core does, and who has no number or email', () => {
        let list: ContactsList = emptyContactsList();
        list = putContact(list, { id: newContactId(), name: 'Dee', phones: ['+61 412 345 678'], emails: [], note: '', links: [], invite: null });
        list = putContact(list, { id: newContactId(), name: 'Sam', phones: [], emails: ['Sam@Mail.example'], note: '', links: [], invite: null });
        list = putContact(list, { id: newContactId(), name: 'Old Work', phones: [], emails: [], note: 'x', links: [], invite: null } as never);
        const found: ContactCandidate[] = [
            { name: 'Dee W', phones: ['61412345678'], emails: [], note: '' },
            { name: 'Sammy', phones: [], emails: ['sam@mail.example'], note: '' },
            { name: 'old work', phones: [], emails: [], note: '' },
            { name: 'Old Work', phones: ['0400 000 000'], emails: [], note: '' },
            { name: 'Ana', phones: ['0499 999 999'], emails: [], note: '' },
        ];
        const rows = reviewRows(list, found);
        // Mutation: any change to the index's rules → disagrees with core's contactAlreadyInList.
        expect(rows.map((r) => r.had)).toEqual(found.map((c) => contactAlreadyInList(list, c)));
        expect(rows.map((r) => r.had)).toEqual([true, true, true, false, false]);
        expect(rows.map((r) => r.bare)).toEqual([false, false, true, false, false]);
    });

    it('2,000 found against a list of 2,000 is one pass, not 2,000 × 2,000', () => {
        let list = emptyContactsList();
        list = { ...list, contacts: addressBook(2000).map((p, i) => ({ id: i.toString(16).padStart(32, '0'), name: p.name!, phones: [p.phoneNumbers![0].number!], emails: [], note: '', links: [], invite: null, clock: 0 })) };
        const found = addressBook(2000).map((p) => candidateOfPhoneContact(p)!);
        const t0 = performance.now();
        const rows = reviewRows(list, found);
        const ms = performance.now() - t0;
        expect(rows.every((r) => r.had)).toBe(true);
        // Core's per-row check is 4,000,000 comparisons here; the index is 4,000 lookups.
        expect(ms).toBeLessThan(250);
    });
});

describe('Import: one change for everyone chosen, and nothing named leaves the phone (design §11)', () => {
    beforeEach(() => {
        resetContactsCheckForTests();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => { vi.useRealTimers(); });

    function phone() {
        const files = new Map<string, string>();
        const kv = new Map<string, string>();
        const clock = { now: 1_800_000_000_000 };
        const counts = { reads: 0, writes: 0 };
        const requests: string[] = [];
        const kept = new Map<string, unknown>();
        const deps: ContactsSyncDeps = {
            disk: {
                read: async (pk) => { counts.reads++; return files.get(pk) ?? null; },
                write: async (pk, text) => { counts.writes++; files.set(pk, text); },
                setAside: async () => {},
            },
            kv: { getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } },
            now: () => clock.now,
            net: {
                async call(community, account, method, path, body) {
                    // Every request whole: where it goes, how, and what it carries.
                    requests.push(JSON.stringify({ community, method, path, body: body ?? null }));
                    if (path === '/api/me/unread') return { status: 200, body: { contacts: kept.has(account.publicKey) ? { seq: 1 } : null } };
                    if (method === 'GET') return { status: 404, body: { code: 'no_copy' } };
                    kept.set(account.publicKey, body);
                    return { status: 200, body: { seq: 1 } };
                },
            },
            communities: async () => ({ anchor: RIVERSIDE, kept: [RIVERSIDE] }),
        };
        return { deps, counts, requests, clock };
    }

    it('2,000 people are one open and one write of the list, and none of their names, numbers or emails is in any request', async () => {
        const me = person();
        const p = phone();
        const chosen = addressBook(2000).map((c) => candidateOfPhoneContact(c)!);
        const t0 = performance.now();
        const added = await importChosen(me, chosen, p.deps);
        const ms = performance.now() - t0;
        console.log(`[contacts-import] 2,000 contacts imported in ${ms.toFixed(0)} ms (node, this Mac)`);
        expect(added).toBe(2000);
        // Mutation: put each contact in its own change → 2,000 reads and writes.
        expect(p.counts).toEqual({ reads: 1, writes: 1 });
        const { onPhone } = await loadContacts(me, p.deps);
        expect(onPhone.kind === 'list' && onPhone.list.contacts.length).toBe(2000);
        // Nothing has left the phone yet: the wait (design §4.5).
        expect(p.requests).toEqual([]);
        p.clock.now += 16 * 60 * 1000;
        await syncContacts(me, p.deps);
        expect(p.requests.some((r) => r.includes('"PUT"'))).toBe(true);
        const sent = p.requests.join('\n');
        // Mutation: send a name (as an invite note, a header, a query) → found here.
        for (const c of chosen.slice(0, 50).concat(chosen.slice(-50))) {
            expect(sent).not.toContain(c.name);
            expect(sent).not.toContain(c.phones[0]);
            expect(sent).not.toContain(c.phones[0].replace(/\D/g, ''));
            expect(sent).not.toContain(c.emails[0]);
        }
    });
});
