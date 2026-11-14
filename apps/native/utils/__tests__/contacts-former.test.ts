/**
 * After a re-key (utils/contacts-former.ts, DESIGN-private-contacts-fable.md §6.2, slice C6): the old 12 words open the old
 * list a community keeps beside the new key, and its people are merged into the new list; "Add people I've chatted with and
 * my friends" rebuilds the BeanPool people. Against fake communities that keep a former copy by slice C6's server rules
 * (apps/server engine/contact-copies.ts: GET answers the signer's own, DELETE removes it). Each check names the change that
 * turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    CONTACTS_LIMITS, contactsCopyWire, emptyContactsList, makeContactsCopy, newContactId, putContact, readContactsCopy, unpackRecoveryWords,
    writeContactsList, type ContactsCopyWire, type ContactsList,
} from '@beanpool/core';
import { loadContacts, type ContactsAccount } from '../contacts-store';
import { CONTACTS_COPY_PATH, editContacts, resetContactsCheckForTests, type ContactsNet, type ContactsSyncDeps } from '../contacts-sync';
import {
    CONTACTS_FORMER_PATH, deleteFormerCopies, formerAlreadyMerged, formerCopyAt, openFormerWithWords, peopleToAdd, withPeopleAdded,
} from '../contacts-former';
import { oldKeyFromWords } from '../old-key-from-words';

const RIVERSIDE = 'https://riverside.example';
const RIVERBEND = 'https://riverbend.example';

/** An account whose key its 12 words make, as a restore makes it. */
function wordsAccount(): ContactsAccount & { words: string[] } {
    let words: string[] = [];
    do {
        const packed = new Uint8Array(randomBytes(17));
        packed[16] &= 0xf0;
        words = unpackRecoveryWords(packed);
    } while (!oldKeyFromWords(words));
    const k = oldKeyFromWords(words)!;
    return { publicKey: k.publicKey, privateKey: bytesToHex(k.seed), words };
}
function person(): ContactsAccount {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

const contact = (name: string, phones: string[] = [], note = '') => ({ id: newContactId(), name, phones, emails: [], note, links: [], invite: null });
function listOf(...people: ReturnType<typeof contact>[]): ContactsList {
    return people.reduce((l, c) => putContact(l, c), emptyContactsList());
}
/** The copy `who`'s device would have saved: their list, locked with their key. */
const copyOf = (who: ContactsAccount, list: ContactsList, seq = 3) => contactsCopyWire(makeContactsCopy({ json: writeContactsList(list), me: who, seq }));

/** A community that keeps, per key now, the old copy a re-key left (C6's rules), and nothing of the current list. */
class FakeCommunity {
    former = new Map<string, { copy: ContactsCopyWire; formerKey: string; keptUntil: string }>();
    off = false;
    answer(owner: string, method: string, path: string): { status: number; body: unknown } {
        if (path === '/api/me/unread') return { status: 200, body: { unread: 0, requests: 0, alerts: 0, contacts: null, asOf: '' } };
        // The current list: none kept, and no save reaches it in these checks (a change waits 2 to 15 minutes to leave).
        if (path === CONTACTS_COPY_PATH) return { status: 404, body: { code: 'no_copy' } };
        if (path !== CONTACTS_FORMER_PATH) return { status: 404, body: { error: 'Not found' } };
        if (this.off) return { status: 404, body: { code: 'contacts_off' } };
        const f = this.former.get(owner);
        if (method === 'DELETE') { this.former.delete(owner); return { status: 200, body: { deleted: !!f } }; }
        if (!f) return { status: 404, body: { code: 'no_former' } };
        return { status: 200, body: { ...f.copy, formerKey: f.formerKey, keptUntil: f.keptUntil } };
    }
}

interface Request { community: string; method: string; path: string; body: string }
function phone(communities: Record<string, FakeCommunity>, anchor: string | null) {
    const files = new Map<string, string>();
    const kv = new Map<string, string>();
    const link = { up: true };
    const requests: Request[] = [];
    const net: ContactsNet = {
        async call(community, account, method, path, body) {
            requests.push({ community, method, path, body: body === undefined ? '' : JSON.stringify(body) });
            const c = communities[community];
            return c && link.up ? c.answer(account.publicKey, method, path) : null;
        },
    };
    const deps: ContactsSyncDeps = {
        disk: {
            read: async (pk) => files.get(pk) ?? null,
            write: async (pk, text) => { files.set(pk, text); },
            setAside: async () => {},
        },
        kv: { getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } },
        now: () => 1_800_000_000_000,
        net,
        communities: async () => ({ anchor, kept: Object.keys(communities) }),
    };
    return { deps, files, kv, link, requests };
}
const names = async (me: ContactsAccount, deps: ContactsSyncDeps) => {
    const { onPhone } = await loadContacts(me, deps);
    return onPhone.kind === 'list' ? onPhone.list.contacts.map((c) => c.name).sort() : [];
};

beforeEach(() => {
    resetContactsCheckForTests();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('the old 12 words open the old list and merge it into the new one', () => {
    it("merges the old list's people into the new list, numbers and notes as they were", async () => {
        const oldMe = wordsAccount();
        const me = person();
        const riverside = new FakeCommunity();
        riverside.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Dee Walker', ['0412 345 678'], 'met at the market'), contact('Sam Jones'))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside }, RIVERSIDE);
        await editContacts(me, (l) => putContact(l, contact('Ana Li')), p.deps);
        const r = await openFormerWithWords(oldMe.words, me, p.deps);
        expect(r).toEqual({ kind: 'merged', added: 2, people: 2 });
        expect(await names(me, p.deps)).toEqual(['Ana Li', 'Dee Walker', 'Sam Jones']);
        const { onPhone } = await loadContacts(me, p.deps);
        const dee = onPhone.kind === 'list' ? onPhone.list.contacts.find((c) => c.name === 'Dee Walker') : null;
        expect(dee?.phones).toEqual(['0412 345 678']);
        expect(dee?.note).toBe('met at the market');
        // The merged list is the new key's: kept on the phone locked under it.
        expect(onPhone.kind === 'list' && readContactsCopy(onPhone.copy).ok && (readContactsCopy(onPhone.copy) as any).copy.owner).toBe(me.publicKey);
        // Mutation: merge without editContacts (drop the change) → names stay ['Ana Li'].
    });

    it('never sends the words, the old key, or anyone in the list: only a GET of the old copy, per community', async () => {
        const oldMe = wordsAccount();
        const me = person();
        const riverside = new FakeCommunity();
        riverside.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Dee Walker', ['0412 345 678']))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside, [RIVERBEND]: new FakeCommunity() }, RIVERSIDE);
        await openFormerWithWords(oldMe.words, me, p.deps);
        expect(p.requests.map((q) => `${q.method} ${q.community}${q.path}`)).toEqual([`GET ${RIVERSIDE}${CONTACTS_FORMER_PATH}`, `GET ${RIVERBEND}${CONTACTS_FORMER_PATH}`]);
        const sent = JSON.stringify(p.requests);
        for (const secret of [...oldMe.words, oldMe.privateKey, 'Dee', '0412', '345 678']) expect(sent).not.toContain(secret);
        // Mutation: send the words to the server to check → the request body holds them.
    });

    it("words that aren't the old key's open nothing and change nothing", async () => {
        const oldMe = wordsAccount();
        const stranger = wordsAccount();
        const me = wordsAccount();
        const riverside = new FakeCommunity();
        riverside.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Dee Walker'))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside }, RIVERSIDE);
        expect(await openFormerWithWords(stranger.words, me, p.deps)).toEqual({ kind: 'not_the_key' });
        expect(await openFormerWithWords(me.words, me, p.deps)).toEqual({ kind: 'not_the_key' });
        expect(await names(me, p.deps)).toEqual([]);
        // Not 12 listed words: nothing is asked of any community.
        const before = p.requests.length;
        expect(await openFormerWithWords(['apple', 'banana'], me, p.deps)).toEqual({ kind: 'not_the_key' });
        expect(p.requests.length).toBe(before);
        // Mutation: trust the server's formerKey instead of opening the copy → the stranger's words would "merge".
    });

    it("a dishonest server's copy (another member's old list, offered as this member's) doesn't open", async () => {
        const oldMe = wordsAccount();
        const someoneElse = person();
        const me = person();
        const riverside = new FakeCommunity();
        // The server names the member's old key, but the copy is someone else's list.
        riverside.former.set(me.publicKey, { copy: copyOf(someoneElse, listOf(contact('Planted Name'))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside }, RIVERSIDE);
        expect(await openFormerWithWords(oldMe.words, me, p.deps)).toEqual({ kind: 'not_the_key' });
        expect(await names(me, p.deps)).toEqual([]);
    });

    it('two communities keeping old copies: both merged into one list', async () => {
        const oldMe = wordsAccount();
        const me = person();
        const [riverside, riverbend] = [new FakeCommunity(), new FakeCommunity()];
        riverside.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Dee Walker'))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        riverbend.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Tom Brown')), 9), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside, [RIVERBEND]: riverbend }, RIVERSIDE);
        expect(await openFormerWithWords(oldMe.words, me, p.deps)).toEqual({ kind: 'merged', added: 2, people: 2 });
        expect(await names(me, p.deps)).toEqual(['Dee Walker', 'Tom Brown']);
        // The phone notes each as merged in, so the Contacts screen stops offering it.
        expect(await formerAlreadyMerged(me, (await formerCopyAt(me, RIVERSIDE, p.deps))!, p.deps.kv)).toBe(true);
        expect(await formerAlreadyMerged(me, (await formerCopyAt(me, RIVERBEND, p.deps))!, p.deps.kv)).toBe(true);
    });

    it('none kept, no answer, or copies switched off: said so, nothing changed', async () => {
        const oldMe = wordsAccount();
        const me = person();
        const riverside = new FakeCommunity();
        const p = phone({ [RIVERSIDE]: riverside }, RIVERSIDE);
        expect(await openFormerWithWords(oldMe.words, me, p.deps)).toEqual({ kind: 'none' });
        riverside.off = true;
        expect(await openFormerWithWords(oldMe.words, me, p.deps)).toEqual({ kind: 'none' });
        p.link.up = false;
        expect(await openFormerWithWords(oldMe.words, me, p.deps)).toEqual({ kind: 'no_answer' });
        expect(p.files.size).toBe(0);
    });

    it('"Delete it": a signed DELETE to each community holding an old copy, and nothing else', async () => {
        const oldMe = wordsAccount();
        const me = person();
        const [riverside, riverbend] = [new FakeCommunity(), new FakeCommunity()];
        riverside.former.set(me.publicKey, { copy: copyOf(oldMe, listOf(contact('Dee Walker'))), formerKey: oldMe.publicKey, keptUntil: '2027-11-15T00:00:00.000Z' });
        const p = phone({ [RIVERSIDE]: riverside, [RIVERBEND]: riverbend }, RIVERSIDE);
        expect(await deleteFormerCopies(me, p.deps)).toEqual({ deleted: 1, complete: true });
        expect(riverside.former.size).toBe(0);
        expect(p.requests.filter((q) => q.method === 'DELETE').map((q) => q.community)).toEqual([RIVERSIDE]);
        expect(p.requests.every((q) => q.body === '')).toBe(true);
    });
});

describe('"Add people I\'ve chatted with and my friends"', () => {
    const me = person().publicKey;
    const k = () => person().publicKey;

    it('adds each BeanPool person once, by callsign, linked by hand to the community in use', () => {
        const [sam, ana] = [k(), k()];
        const out = withPeopleAdded(emptyContactsList(), [{ key: sam, callsign: 'sam_j' }, { key: ana, callsign: 'ana' }, { key: sam, callsign: 'sam_j' }], me, RIVERSIDE, new Date('2026-11-15T10:00:00.000Z'));
        expect(out.contacts.map((c) => c.name).sort()).toEqual(['ana', 'sam_j']);
        const s = out.contacts.find((c) => c.name === 'sam_j')!;
        expect(s.links).toEqual([{ key: sam, community: RIVERSIDE, callsign: 'sam_j', how: 'hand', at: '2026-11-15T10:00:00.000Z' }]);
        expect(s.phones).toEqual([]);
        // Mutation: drop the dedupe → sam_j twice.
    });

    it('never the member, nobody already linked (in any community), and a second run adds nobody', () => {
        const [sam, dee] = [k(), k()];
        const linked = putContact(emptyContactsList(), { ...contact('Dee Walker'), links: [{ key: dee, community: RIVERBEND, callsign: 'dee_w', how: 'invite', at: '2026-11-01T00:00:00.000Z' }] });
        const people = [{ key: me, callsign: 'me' }, { key: dee, callsign: 'dee_w' }, { key: sam, callsign: 'sam_j' }];
        expect(peopleToAdd(linked, people, me).map((p) => p.callsign)).toEqual(['sam_j']);
        const once = withPeopleAdded(linked, people, me, RIVERSIDE);
        expect(once.contacts.map((c) => c.name).sort()).toEqual(['Dee Walker', 'sam_j']);
        expect(withPeopleAdded(once, people, me, RIVERSIDE)).toBe(once);
        // Mutation: compare links by callsign instead of key → a renamed member added twice.
    });

    it('a callsign as long as a link holds, ending in an emoji, is kept whole (cut by characters, never by halves of one)', () => {
        const long = `${'a'.repeat(CONTACTS_LIMITS.callsignChars - 1)}😀`;
        const out = withPeopleAdded(emptyContactsList(), [{ key: k(), callsign: long }], me, RIVERSIDE);
        expect(out.contacts[0]?.links[0]?.callsign).toBe(long);
        expect(out.contacts[0]?.name).toBe(long);
        // Mutation: cut with String.slice(0, 64) → the emoji's second half is cut, core drops the first: one character short.
    });

    it("stops at the list's limit", () => {
        let full = emptyContactsList();
        full = { ...full, contacts: Array.from({ length: CONTACTS_LIMITS.contacts - 1 }, (_, i) => ({ ...contact(`P${i}`), id: i.toString(16).padStart(32, '0'), clock: 0 })) };
        expect(peopleToAdd(full, [{ key: k(), callsign: 'a' }, { key: k(), callsign: 'b' }], me)).toHaveLength(1);
    });
});
