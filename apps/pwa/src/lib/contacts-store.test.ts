import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { putContact, readContactsCopy, removeEveryContact, toEd25519Pkcs8, contactsFromCandidates, mergeContactsLists, emptyContactsList, type ContactsCopyWire } from '@beanpool/core';
import { memoryIndexedDB } from './memory-indexeddb';
import { importIdentity } from './identity';
import { openContactsList } from './contacts-lock';
import {
    CONTACTS_SAVE_WAIT_MS, changeContacts, clearContactsStore, contactsSignOutCheck, contactsSnapshot, openContacts,
    resetContactsStoreForTest, saveContactsNow,
} from './contacts-store';

// The web's contacts store against a recording community (DESIGN-private-contacts-fable.md §4.4, §4.5, §6.4, §11 "Web
// (C4)"): what it sends, when, and what it does with each answer. The fake holds copies as C1's store does (signed by
// the signer, a newer number or 409 stale_copy with the kept one) and records every request whole.

const seed = ed25519.utils.randomSecretKey();
const me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)), callsign: 'ana', createdAt: '2026-11-12T00:00:00.000Z' };

interface Seen { method: string; url: string; headers: Record<string, string>; body: string }
let seen: Seen[] = [];
let kept: ContactsCopyWire | null = null;
let off = false;
let down = false;
/** Something in front of the community answers a save with a bare 200 page and keeps nothing. */
let blank = false;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function community(url: string, init: RequestInit = {}): Response {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    seen.push({ method: init.method ?? 'GET', url, headers, body: typeof init.body === 'string' ? init.body : '' });
    if (down) throw new TypeError('Failed to fetch');
    if (blank && init.method === 'PUT') return new Response('<!doctype html><title>OK</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (!url.endsWith('/api/contacts/copy')) return json(404, { error: 'no route' });
    if (off) return json(404, { error: 'off', code: 'contacts_off' });
    if (init.method === 'GET') return kept ? json(200, kept) : json(404, { error: 'none', code: 'no_copy' });
    const body = JSON.parse(String(init.body)) as ContactsCopyWire;
    const read = readContactsCopy(body);
    if (!read.ok || read.copy.owner !== me.publicKey) return json(400, { error: 'bad', code: 'bad_copy' });
    const had = kept ? readContactsCopy(kept) : null;
    if (had?.ok && had.copy.header === read.copy.header) return json(200, { seq: had.copy.seq, code: 'exists' });
    if (had?.ok && read.copy.seq <= had.copy.seq) return json(409, { error: 'stale', code: 'stale_copy', seq: had.copy.seq });
    kept = body;
    return json(200, { seq: read.copy.seq });
}

/** One browser: its own IndexedDB with the account in it. */
async function browser() {
    const idb = memoryIndexedDB();
    vi.stubGlobal('indexedDB', idb);
    resetContactsStoreForTest();
    await importIdentity(me);
    return idb;
}

const people = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({
    name: `${tag} Person ${i} Walker`, phones: [`+61 4${String(i).padStart(2, '0')} 555 ${String(100 + i)}`], emails: [`${tag.toLowerCase()}${i}@example.org`], note: `met at the ${tag} garden`,
}));

const listOnCommunity = () => {
    const opened = openContactsList(kept, me);
    if (!opened.ok) throw new Error(`the community's copy doesn't open: ${opened.reason}`);
    return opened.list;
};

beforeEach(async () => {
    // The in-memory IndexedDB answers on setTimeout(0): time runs, and a test moves it on past the store's waits.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-12T09:00:00Z'));
    seen = [];
    kept = null;
    off = false;
    down = false;
    blank = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => community(url, init)));
    await browser();
});

afterEach(() => {
    resetContactsStoreForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('the web contacts store', () => {
    it('sends nothing on a change, then one locked copy after the wait: no name, number or email in any URL, header or body', async () => {
        await openContacts(me);
        seen = [];
        const fixtures = people(50, 'Fern');
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(fixtures) }));
        await changeContacts(me, (list) => putContact(list, { id: 'a'.repeat(32), name: 'Dee By Hand', phones: ['0412 345 678'], emails: ['dee@hand.example'], note: 'typed in', links: [], invite: null }));
        expect(seen).toEqual([]);
        expect(contactsSnapshot().where).toBe('soon');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('unsaved');

        // Not before the shortest wait; by the longest, exactly one save.
        await vi.advanceTimersByTimeAsync(CONTACTS_SAVE_WAIT_MS.min - 1_000);
        expect(seen).toEqual([]);
        await vi.advanceTimersByTimeAsync(CONTACTS_SAVE_WAIT_MS.max);
        expect(seen.map((s) => `${s.method} ${new URL(s.url, 'http://x').pathname}`)).toEqual(['PUT /api/contacts/copy']);

        const sent = JSON.stringify(seen);
        for (const p of [...fixtures, { name: 'Dee By Hand', phones: ['0412 345 678'], emails: ['dee@hand.example'], note: 'typed in' }]) {
            for (const secret of [p.name, ...p.phones, p.phones[0].replace(/\D/g, ''), ...p.emails, p.note]) expect(sent).not.toContain(secret);
        }
        // What went is the list, locked: it opens with the account's key and holds all 51.
        expect(listOnCommunity().contacts).toHaveLength(51);
        expect(contactsSnapshot().where).toBe('here');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('saved');
    });

    it('a second browser gets the list back from the community, and says how many', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(3, 'Moss')) }));
        expect(await saveContactsNow(me)).toBe('here');

        await browser();
        await openContacts(me);
        expect(contactsSnapshot().list?.contacts).toHaveLength(3);
        expect(contactsSnapshot().restored).toBe(3);
        expect(contactsSnapshot().where).toBe('here');
    });

    it('two browsers changed offline: the second save is refused as stale, fetched, merged and saved, and nobody is lost', async () => {
        const first = await browser();
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(2, 'Oak')) }));

        const second = await browser();
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(2, 'Ash')) }));

        // The first browser saves first; the second's copy carries the same number and is refused.
        vi.stubGlobal('indexedDB', first);
        resetContactsStoreForTest();
        expect(await saveContactsNow(me)).toBe('here');
        vi.stubGlobal('indexedDB', second);
        resetContactsStoreForTest();
        seen = [];
        expect(await saveContactsNow(me)).toBe('here');
        expect(seen.map((s) => s.method)).toEqual(['PUT', 'GET', 'PUT']);
        expect(listOnCommunity().contacts.map((c) => c.name).sort()).toEqual(['Ash Person 0 Walker', 'Ash Person 1 Walker', 'Oak Person 0 Walker', 'Oak Person 1 Walker']);
    });

    it('Remove everyone saves an empty list with its markers, so the older copy brings nobody back', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(4, 'Elm')) }));
        await saveContactsNow(me);
        await changeContacts(me, (list) => removeEveryContact(list));
        await saveContactsNow(me);
        expect(listOnCommunity().contacts).toEqual([]);
        expect(listOnCommunity().removed).toHaveLength(4);
    });

    it('a community that keeps no lists: never sent again, and sign-out is told the list is in this browser alone', async () => {
        off = true;
        await openContacts(me);
        expect(contactsSnapshot().where).toBe('device-only');
        seen = [];
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Yew')) }));
        await vi.advanceTimersByTimeAsync(CONTACTS_SAVE_WAIT_MS.max + 1_000);
        expect(seen).toEqual([]);
        expect(contactsSnapshot().where).toBe('device-only');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('device-only');
    });

    it('a community that keeps no lists and can\'t be reached on the next page load: still device-only, with no "will try again" and nothing tried', async () => {
        off = true;
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Gum')) }));
        expect(contactsSnapshot().where).toBe('device-only');

        // A new page load, with the community out of reach.
        resetContactsStoreForTest();
        down = true;
        seen = [];
        await openContacts(me);
        expect(contactsSnapshot().where).toBe('device-only');
        await vi.advanceTimersByTimeAsync(CONTACTS_SAVE_WAIT_MS.max + 1_000);
        expect(seen.map((s) => s.method)).toEqual(['GET']);
        expect(contactsSnapshot().where).toBe('device-only');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('device-only');
    });

    it('a save counts only when the community names this copy\'s number: a bare 200 is not taken as saved, so sign-out still warns', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Box')) }));
        blank = true;
        expect(await saveContactsNow(me)).toBe('retry');
        expect(kept).toBeNull();
        expect(contactsSnapshot().where).toBe('retry');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('unsaved');

        // The real community answers the retry: now it is saved.
        blank = false;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(contactsSnapshot().where).toBe('here');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('saved');
        expect(listOnCommunity().contacts).toHaveLength(1);
    });

    it('a save that does not arrive is said, and tried again later', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Fir')) }));
        down = true;
        expect(await saveContactsNow(me)).toBe('retry');
        expect(contactsSnapshot().where).toBe('retry');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('unsaved');
        down = false;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(contactsSnapshot().where).toBe('here');
        expect(listOnCommunity().contacts).toHaveLength(1);
    });

    it('signing out takes this browser\'s copy with it', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Ivy')) }));
        expect(await contactsSignOutCheck(me.publicKey)).toBe('unsaved');
        await clearContactsStore();
        expect(await contactsSignOutCheck(me.publicKey)).toBe('none');
        expect(contactsSnapshot().list).toBeNull();
    });
});
