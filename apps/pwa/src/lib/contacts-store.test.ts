import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { putContact, readContactsCopy, removeEveryContact, toEd25519Pkcs8, contactsFromCandidates, mergeContactsLists, emptyContactsList, type ContactsCopyWire } from '@beanpool/core';
import { memoryIndexedDB } from './memory-indexeddb';
import { importIdentity, wipeIdentity } from './identity';
import { beginAccountEpoch, endAccountEpoch, resetAccountEpochForTest } from './account-epoch';
import { clearAccountStorage } from './device-prefs';
import { setNodeApiUrl } from './api';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from './node-version-gate';
import { openContactsList } from './contacts-lock';
import {
    CONTACTS_SAVE_WAIT_MS, changeContacts, clearContactsStore, contactsSignOutCheck, contactsSnapshot, openContacts,
    resetContactsStoreForTest, saveContactsNow,
} from './contacts-store';

// The web's contacts store against a recording community (DESIGN-private-contacts-fable.md §4.4, §4.5, §6.4, §11 "Web
// (C4)"): what it sends, when, and what it does with each answer. The fake holds copies as C1's store does (each
// member's own, by the key that signed the request: a newer number, or 409 stale_copy with the kept one; another key's
// copy 403 not_yours) and records every request whole.

const seed = ed25519.utils.randomSecretKey();
const me = { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)), callsign: 'ana', createdAt: '2026-11-12T00:00:00.000Z' };
/** The next account to sign in on this browser once Ana has signed out. */
const bobSeed = ed25519.utils.randomSecretKey();
const bob = { publicKey: bytesToHex(ed25519.getPublicKey(bobSeed)), privateKey: bytesToHex(toEd25519Pkcs8(bobSeed)), callsign: 'bob', createdAt: '2026-11-12T00:00:00.000Z' };

interface Seen { method: string; url: string; headers: Record<string, string>; body: string }
let seen: Seen[] = [];
let kept: ContactsCopyWire | null = null;
let off = false;
let down = false;
/** Something in front of the community (a captive portal, a proxy) answers every call with a bare 200 page and keeps nothing. */
let blank = false;
/** The next GET waits here, once asked, until the test lets it answer. */
let holdGet: { asked: () => void; answer: Promise<void> } | null = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function community(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const method = init.method ?? 'GET';
    seen.push({ method, url, headers, body: typeof init.body === 'string' ? init.body : '' });
    if (method === 'GET' && holdGet) {
        const held = holdGet;
        holdGet = null;
        held.asked();
        await held.answer;
    }
    if (down) throw new TypeError('Failed to fetch');
    if (blank) return new Response('<!doctype html><title>OK</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (!url.endsWith('/api/contacts/copy')) return json(404, { error: 'no route' });
    if (off) return json(404, { error: 'off', code: 'contacts_off' });
    const signer = headers['X-Public-Key'];
    if (method === 'GET') return kept && signer === me.publicKey ? json(200, kept) : json(404, { error: 'none', code: 'no_copy' });
    const body = JSON.parse(String(init.body)) as ContactsCopyWire;
    const read = readContactsCopy(body);
    if (read.ok && read.copy.owner !== signer) return json(403, { error: 'not yours', code: 'not_yours' });
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
    holdGet = null;
    setNodeApiUrl(null);
    resetNodeVersionGateForTests();
    // A test that signed the account out leaves this page's account epoch ended: each test starts as a page loaded now.
    resetAccountEpochForTest();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => community(url, init)));
    await browser();
});

/** The next GET is held once asked: `asked` resolves when it is, and `answer()` lets the community answer it. */
function holdNextGet(): { asked: Promise<void>; answer: () => void } {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const asked = new Promise<void>((resolve) => { holdGet = { asked: resolve, answer: held }; });
    return { asked, answer };
}

/** Each request as who signed it: Ana, Bob, or nobody. */
const signedAs = (s: Seen) => `${s.method} signed as ${s.headers['X-Public-Key'] === me.publicKey ? 'Ana' : s.headers['X-Public-Key'] === bob.publicKey ? 'Bob' : 'nobody'}`;

/** The number of the copy this browser keeps for Ana, or undefined when it keeps none. */
const heldSeq = (idb: ReturnType<typeof memoryIndexedDB>) => (idb.peek('beanpool-contacts', 'copies', me.publicKey.toLowerCase()) as { seq?: number } | undefined)?.seq;

afterEach(() => {
    setNodeApiUrl(null);
    resetNodeVersionGateForTests();
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

    it('a read answered with a 200 that isn\'t a copy (a captive portal\'s page) is a read that didn\'t arrive: the change waiting here is tried again and reaches the community', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Pine')) }));
        expect(contactsSnapshot().where).toBe('soon');

        // The next page load, behind a captive portal: every call gets the portal's 200 page.
        resetContactsStoreForTest();
        blank = true;
        seen = [];
        await openContacts(me);
        const said = contactsSnapshot().where;
        const signOut = await contactsSignOutCheck(me.publicKey);

        // Back online: within the hour the community has the change, sent once.
        blank = false;
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(seen.map((s) => s.method)).toEqual(['GET', 'PUT']);
        expect(listOnCommunity().contacts.map((c) => c.name)).toEqual(['Pine Person 0 Walker']);
        // While the portal answered, the footer said it would try again (not "within 15 minutes"), and sign-out warned.
        expect(said).toBe('retry');
        expect(signOut).toBe('unsaved');
        expect(contactsSnapshot().where).toBe('here');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('saved');
    });

    it.each([
        ['does not arrive', 'down'],
        ['gets a captive portal\'s 200 page', 'blank'],
    ] as const)('a list kept at another community, when the first read there %s: the footer says it will try again, and the new community gets the list five minutes later', async (_what, how) => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Ash')) }));
        expect(await saveContactsNow(me)).toBe('here');
        expect(listOnCommunity().contacts).toHaveLength(1);

        // The web app is pointed at another community (Settings' address, or a delete at a detached community that keeps the
        // key). It has no copy. The row still names the old address, with `kept` equal to `seq`: the number the OLD community keeps.
        kept = null;
        setNodeApiUrl('https://other.example');
        // Settings' address check has heard that community's version (it runs 1.4.0), so only the contacts calls are seen here.
        hearNodeVersionForTests('https://other.example');
        resetContactsStoreForTest();
        if (how === 'down') down = true; else blank = true;
        seen = [];
        await openContacts(me);
        const said = contactsSnapshot().where;
        const signOut = await contactsSignOutCheck(me.publicKey);
        expect(said).toBe('retry');
        expect(signOut).toBe('unsaved');

        // Back online: five minutes on, one save goes to the new community, and it holds the list.
        down = false;
        blank = false;
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(seen.map((s) => s.method)).toEqual(['GET']);
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(seen.map((s) => s.method)).toEqual(['GET', 'PUT']);
        expect(seen.every((s) => s.url.startsWith('https://other.example/'))).toBe(true);
        expect(listOnCommunity().contacts.map((c) => c.name)).toEqual(['Ash Person 0 Walker']);
        expect(contactsSnapshot().where).toBe('here');
        expect(await contactsSignOutCheck(me.publicKey)).toBe('saved');
    });

    it('Sign Out in another tab: a tab still open drops the list and the save that waited, refuses a change, and sends nothing, so the old copy never goes signed as the next account', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Rue')) }));
        expect(contactsSnapshot().where).toBe('soon');
        seen = [];

        // Ana signs out in another tab, as Settings does (her key goes, then the account's epoch ends, which this tab
        // hears), and Bob signs in there.
        await wipeIdentity();
        endAccountEpoch('signed-out');
        await importIdentity(bob);

        // Ana's old tab adds someone, and an hour passes.
        const added = await changeContacts(me, (list) => putContact(list, { id: 'b'.repeat(32), name: 'Late Add', phones: ['0400 111 222'], emails: [], note: '', links: [], invite: null }))
            .then(() => 'kept', () => 'refused');
        await vi.advanceTimersByTimeAsync(60 * 60_000);

        // Nothing went: not Ana's copy, and nothing signed as Bob.
        expect(seen.map(signedAs)).toEqual([]);
        expect(kept).toBeNull();
        expect(added).toBe('refused');
        expect(contactsSnapshot().list).toBeNull();
    });

    it('a read still on its way when the account signs out in another tab keeps nothing in this browser when it lands, and nothing more is sent', async () => {
        // Ana's list is at the community.
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(2, 'Teak')) }));
        expect(await saveContactsNow(me)).toBe('here');

        // A browser holding none of it opens the list; its read is out when Ana signs out in another tab.
        const idb = await browser();
        const get = holdNextGet();
        const opened = openContacts(me);
        await get.asked;
        endAccountEpoch('signed-out');
        get.answer();
        await opened;

        // The community's copy is not put back here, nor shown, and nothing more goes.
        expect(heldSeq(idb)).toBeUndefined();
        expect(await contactsSignOutCheck(me.publicKey)).toBe('none');
        expect(contactsSnapshot().list).toBeNull();
        expect(contactsSnapshot().restored).toBeNull();
        seen = [];
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(seen.map(signedAs)).toEqual([]);
    });

    it('a change whose write lands as the account signs out is taken out again and refused, and nothing is sent', async () => {
        const idb = await browser();
        await openContacts(me);
        const release = idb.holdNextCommit();
        const change = changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Gum')) }))
            .then(() => 'kept', () => 'refused');
        await vi.waitFor(() => expect(heldSeq(idb)).toBe(1));
        endAccountEpoch('signed-out');
        release();
        expect(await change).toBe('refused');
        expect(heldSeq(idb)).toBeUndefined();
        seen = [];
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(seen.map(signedAs)).toEqual([]);
    });

    it('a save is signed as the account whose list it is, never as another key this browser holds by then', async () => {
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Ash')) }));
        await wipeIdentity();
        await importIdentity(bob);
        seen = [];
        expect(await saveContactsNow(me)).toBe('here');
        expect(seen.map(signedAs)).toEqual(['PUT signed as Ana']);
        expect(listOnCommunity().contacts).toHaveLength(1);
    });

    it('signed out and another account signed in within this same page, with no reload: the read that was out keeps nothing of the old account, and nothing goes', async () => {
        // Ana's list is at the community, and this browser holds one change more.
        const idb = await browser();
        await openContacts(me);
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Oak')) }));
        expect(await saveContactsNow(me)).toBe('here');
        await changeContacts(me, (list) => mergeContactsLists(list, { ...emptyContactsList(), contacts: contactsFromCandidates(people(1, 'Elm')) }));

        // The next page load opens it. While its read is out, Ana signs out in this page and Bob signs in, with no reload.
        resetContactsStoreForTest();
        const get = holdNextGet();
        const opened = openContacts(me);
        await get.asked;
        await wipeIdentity();
        await clearAccountStorage();
        await importIdentity(bob);
        beginAccountEpoch();
        seen = [];
        get.answer();
        await opened;
        await vi.advanceTimersByTimeAsync(60 * 60_000);

        expect(seen.map(signedAs)).toEqual([]);
        expect(heldSeq(idb)).toBeUndefined();
        expect(contactsSnapshot().list).toBeNull();
    });
});
