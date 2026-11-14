/**
 * The phone's private contacts sync (utils/contacts-sync.ts, DESIGN-private-contacts-fable.md §4.4, §4.5, §11 slice C2),
 * against fake communities that keep copies by slice C1's rules (apps/server engine/contact-copies.ts: one copy per member,
 * only a newer number, the identical copy again is `exists`, a 409 `stale_copy` says the number kept, `no_copy`, and a
 * community whose owners switched copies off). Each check names the change that turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    CONTACTS_SEQ_MAX, contactsCopyWire, emptyContactsList, makeContactsCopy, newContactId, putContact, readContactsCopy, removeEveryContact,
    writeContactsList, type ContactsCopyWire,
} from '@beanpool/core';
import { contactsSyncStoreKey, loadContacts, readSyncState, setAsideDamaged, type ContactsAccount } from '../contacts-store';
import {
    CONTACTS_COPY_PATH, checkContactsHere, contactsCommunities, contactsHeard, contactsKeptAt, decide, editContacts, phoneSyncDeps,
    resetContactsCheckForTests, syncContacts, type ContactsNet, type ContactsSyncDeps,
} from '../contacts-sync';
import { PUSH_ALERTS_OFF_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';

const BYRON = 'https://byron.example';
const GLOBAL = 'https://global.example';
const CASTLEMAINE = 'https://castlemaine.example';

function person(): ContactsAccount {
    const seed = ed25519.utils.randomSecretKey();
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

interface Request { community: string; method: string; path: string; body: string }

/** One community's server, by C1's rules: `off` refuses everything, `old` is a server from before private contacts. */
class FakeCommunity {
    copies = new Map<string, ContactsCopyWire & { seq: number }>();
    off = false;
    old = false;
    /** A dishonest server: says it keeps a copy numbered at core's cap, holds none, and refuses every save as stale. */
    liar = false;
    /** A dishonest server: hands back another member's copy as this member's. */
    swapped: ContactsCopyWire | null = null;
    answer(owner: string, method: string, path: string, body: unknown): { status: number; body: unknown } {
        if (this.liar) {
            if (path === '/api/me/unread') return { status: 200, body: { unread: 0, requests: 0, alerts: 0, contacts: { seq: CONTACTS_SEQ_MAX }, asOf: '' } };
            if (method === 'GET') return { status: 404, body: { code: 'no_copy' } };
            return { status: 409, body: { code: 'stale_copy', seq: CONTACTS_SEQ_MAX } };
        }
        if (this.swapped && method === 'GET' && path === CONTACTS_COPY_PATH) return { status: 200, body: this.swapped };
        if (path === '/api/me/unread') {
            const kept = this.copies.get(owner);
            return { status: 200, body: { unread: 0, requests: 0, alerts: 0, ...(this.old ? {} : { contacts: kept && !this.off ? { seq: kept.seq } : null }), asOf: '' } };
        }
        if (path !== CONTACTS_COPY_PATH || this.old) return { status: 404, body: { error: 'Not found' } };
        if (this.off) return { status: 404, body: { error: 'off', code: 'contacts_off' } };
        if (method === 'GET') {
            const kept = this.copies.get(owner);
            if (!kept) return { status: 404, body: { error: 'none', code: 'no_copy' } };
            const { header, signature, nonce, sealed } = kept;
            return { status: 200, body: { header, signature, nonce, sealed } };
        }
        const read = readContactsCopy(body);
        if (!read.ok) return { status: 400, body: { code: 'bad_copy' } };
        if (read.copy.owner !== owner) return { status: 403, body: { code: 'not_yours' } };
        const kept = this.copies.get(owner);
        if (kept && kept.header === read.copy.header) return { status: 200, body: { seq: kept.seq, code: 'exists' } };
        if (kept && read.copy.seq <= kept.seq) return { status: 409, body: { code: 'stale_copy', seq: kept.seq } };
        const { header, signature, nonce, sealed } = read.copy;
        this.copies.set(owner, { header, signature, nonce, sealed, seq: read.copy.seq });
        return { status: 200, body: { seq: read.copy.seq } };
    }
}

/**
 * A phone: its own disk and AsyncStorage, the communities it keeps, and every request it makes. `link.up` false: it has no
 * connection, and no request is answered.
 */
function phone(communities: Record<string, FakeCommunity>, anchor: string | null, at = 1_800_000_000_000) {
    const files = new Map<string, string>();
    const asides = new Map<string, string>();
    const kv = new Map<string, string>();
    const clock = { now: at };
    const link = { up: true };
    const requests: Request[] = [];
    const net: ContactsNet = {
        async call(community, account, method, path, body) {
            requests.push({ community, method, path, body: body === undefined ? '' : JSON.stringify(body) });
            const c = communities[community];
            return c && link.up ? c.answer(account.publicKey, method, path, body) : null;
        },
    };
    const deps: ContactsSyncDeps = {
        disk: {
            read: async (pk) => files.get(pk) ?? null,
            write: async (pk, text) => { files.set(pk, text); },
            setAside: async (pk) => { const text = files.get(pk); if (text !== undefined) { asides.set(pk, text); files.delete(pk); } },
        },
        kv: { getItem: async (k) => kv.get(k) ?? null, setItem: async (k, v) => { kv.set(k, v); } },
        now: () => clock.now,
        net,
        communities: async () => ({ anchor, kept: Object.keys(communities) }),
    };
    return { deps, files, asides, kv, clock, link, requests };
}

const person1 = (name: string, phones: string[] = [], emails: string[] = []) => ({ id: newContactId(), name, phones, emails, note: '', links: [], invite: null });
const names = async (me: ContactsAccount, deps: ContactsSyncDeps) => {
    const { onPhone } = await loadContacts(me, deps);
    return onPhone.kind === 'list' ? onPhone.list.contacts.map((c) => c.name).sort() : [];
};
const WAIT = 16 * 60 * 1000;
/** Lets a pass the timer started run to its end (setImmediate isn't faked here). */
const settle = async () => { for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
    resetContactsCheckForTests();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('a change leaves the phone only after its wait, and only to a community whose copy the phone has merged', () => {
    it('nothing is sent before the wait; after it, the community in use is asked its number, then given the copy', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        await syncContacts(me, p.deps);
        expect(p.requests.filter((r) => r.method === 'PUT')).toEqual([]);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(p.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/me/unread', `PUT ${CONTACTS_COPY_PATH}`]);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);
        const s = readSyncState(p.kv.get(contactsSyncStoreKey(me.publicKey)) ?? null);
        expect(s).toMatchObject({ heard: { [BYRON]: 1 }, merged: { [BYRON]: 1 }, dueAt: null, savedAt: p.clock.now });
        // Mutation: decide() → 'put' before contactsDue → the PUT goes at once, and the server learns when Dee was added.
    });

    it('a community holding a copy this phone hasn\'t merged is fetched and merged before anything is saved over it', async () => {
        const byron = new FakeCommunity();
        const me = person();
        // Another phone of the member's saved Sam there first.
        const other = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Sam Jones')), other.deps);
        other.clock.now += WAIT;
        await syncContacts(me, other.deps);
        // This phone, on Global alone so far, saves three times there: its number (3) goes past Byron's (1) without Sam.
        const global = new FakeCommunity();
        const kept: Record<string, FakeCommunity> = { [GLOBAL]: global };
        const p = phone(kept, GLOBAL);
        for (const name of ['Dee Walker', 'Ana Li', 'Ben Ode']) {
            await editContacts(me, (l) => putContact(l, person1(name)), p.deps);
            p.clock.now += WAIT;
            await syncContacts(me, p.deps);
        }
        expect(global.copies.get(me.publicKey)?.seq).toBe(3);
        // Then the member joins Byron on this phone.
        kept[BYRON] = byron;
        p.requests.length = 0;
        await syncContacts(me, p.deps);
        expect(p.requests.filter((r) => r.community === BYRON).map((r) => `${r.method} ${r.path}`))
            .toEqual(['GET /api/me/unread', `GET ${CONTACTS_COPY_PATH}`, `PUT ${CONTACTS_COPY_PATH}`]);
        expect(await names(me, p.deps)).toEqual(['Ana Li', 'Ben Ode', 'Dee Walker', 'Sam Jones']);
        // What Byron keeps now holds everyone, Sam included.
        const q = phone({ [BYRON]: byron }, BYRON);
        await checkContactsHere(me, q.deps);
        expect(await names(me, q.deps)).toEqual(['Ana Li', 'Ben Ode', 'Dee Walker', 'Sam Jones']);
        // Mutation: decide() → 'put' when the phone's number is past the one heard → Byron's copy is replaced without Sam.
    });

    it('a 409 stale_copy (another phone saved meanwhile) is fetched, merged and saved again, ending with both phones\' people', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const a = phone({ [BYRON]: byron }, BYRON);
        const b = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Ana')), a.deps);
        a.clock.now += WAIT;
        await syncContacts(me, a.deps);
        await checkContactsHere(me, b.deps);
        resetContactsCheckForTests();
        await editContacts(me, (l) => putContact(l, person1('Ben')), b.deps);
        await editContacts(me, (l) => putContact(l, person1('Cat')), a.deps);
        b.clock.now += WAIT;
        await syncContacts(me, b.deps);
        a.clock.now += WAIT;
        await syncContacts(me, a.deps);
        expect(a.requests.some((r) => r.method === 'GET' && r.path === CONTACTS_COPY_PATH)).toBe(true);
        expect(await names(me, a.deps)).toEqual(['Ana', 'Ben', 'Cat']);
        const kept = byron.copies.get(me.publicKey)!;
        expect(kept.seq).toBeGreaterThanOrEqual(3);
        await checkContactsHere(me, b.deps);
        expect(await names(me, b.deps)).toEqual(['Ana', 'Ben', 'Cat']);
    });

    it('a save more than one number past the one last heard asks first: a copy another phone saved there meanwhile is merged, never replaced', async () => {
        // PR #3073 review 4542103140, measured there: the community lost Yan, and a new phone restored without her.
        const byron = new FakeCommunity();
        const me = person();
        const one = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Xia')), one.deps);
        one.clock.now += WAIT;
        await syncContacts(me, one.deps);
        const two = phone({ [BYRON]: byron }, BYRON);
        await checkContactsHere(me, two.deps);
        // Phone one has no connection while it adds Zed, then Wu: its save of Zed went unanswered, so its number climbs to 3.
        one.link.up = false;
        await editContacts(me, (l) => putContact(l, person1('Zed')), one.deps);
        one.clock.now += WAIT;
        await syncContacts(me, one.deps);
        await editContacts(me, (l) => putContact(l, person1('Wu')), one.deps);
        // Meanwhile phone two adds Yan and saves: Byron keeps 2 (Xia, Yan). Phone one last heard 1 there.
        await editContacts(me, (l) => putContact(l, person1('Yan')), two.deps);
        two.clock.now += WAIT;
        await syncContacts(me, two.deps);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(2);
        one.link.up = true;
        one.requests.length = 0;
        one.clock.now += WAIT;
        await syncContacts(me, one.deps);
        // A new phone restores from Byron alone: Yan is there.
        resetContactsCheckForTests();
        const fresh = phone({ [BYRON]: byron }, BYRON);
        await checkContactsHere(me, fresh.deps);
        expect(await names(me, fresh.deps)).toEqual(['Wu', 'Xia', 'Yan', 'Zed']);
        // 3 is two past the 1 phone one heard: it asked Byron first, and fetched and merged Yan before its save.
        expect(one.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/me/unread', `GET ${CONTACTS_COPY_PATH}`, `PUT ${CONTACTS_COPY_PATH}`]);
        expect(await names(me, one.deps)).toEqual(['Wu', 'Xia', 'Yan', 'Zed']);
        // Mutation: drop decide()'s ask before a save more than one past → one PUT of 3 replaces Byron's 2, and Yan is gone.
    });

    it('one number past the one heard saves at once: Byron refuses it (409) if anything was saved there since', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Xia')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        await editContacts(me, (l) => putContact(l, person1('Zed')), p.deps);
        p.requests.length = 0;
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(p.requests.map((r) => `${r.method} ${r.path}`)).toEqual([`PUT ${CONTACTS_COPY_PATH}`]);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(2);
        // Mutation: ask before every save → a request more each time, for nothing the server doesn't already check.
    });
});

describe('a new phone, and the other communities', () => {
    it('a phone with no list gets it back as soon as a community answers with one, and notes how many came back', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const old = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(putContact(l, person1('Ana')), person1('Ben')), old.deps);
        old.clock.now += WAIT;
        await syncContacts(me, old.deps);
        resetContactsCheckForTests();
        const fresh = phone({ [BYRON]: byron }, BYRON);
        await checkContactsHere(me, fresh.deps);
        expect(await names(me, fresh.deps)).toEqual(['Ana', 'Ben']);
        expect((await loadContacts(me, fresh.deps)).state.back).toBe(2);
        // Nothing was sent back: the copy is kept as it came.
        expect(fresh.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    });

    it('copies from several communities are merged, and how many came back counts them all (design §4.5)', async () => {
        // PR #3073 review 4542103615, measured there: 3 people came back, and `back` said 2.
        const a = new FakeCommunity();
        const b = new FakeCommunity();
        const me = person();
        const old = phone({ [BYRON]: a, [GLOBAL]: b }, BYRON);
        await editContacts(me, (l) => putContact(putContact(l, person1('Ana')), person1('Ben')), old.deps);
        old.clock.now += WAIT;
        await syncContacts(me, old.deps);
        // Cat is added by a phone that only ever saved at the second community.
        const other = phone({ [GLOBAL]: b }, GLOBAL);
        await checkContactsHere(me, other.deps);
        await editContacts(me, (l) => putContact(l, person1('Cat')), other.deps);
        other.clock.now += WAIT;
        await syncContacts(me, other.deps);
        resetContactsCheckForTests();
        const fresh = phone({ [BYRON]: a, [GLOBAL]: b }, BYRON);
        await checkContactsHere(me, fresh.deps);
        expect(await names(me, fresh.deps)).toEqual(['Ana', 'Ben', 'Cat']);
        expect((await loadContacts(me, fresh.deps)).state.back).toBe(3);
        // Mutation: count only the first copy taken in → "Your contacts are back: 2 people" over a list of 3.
    });

    it('a phone with no list asks nothing more and writes nothing when no community keeps one', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron, [GLOBAL]: new FakeCommunity() }, BYRON);
        await checkContactsHere(me, p.deps);
        await contactsHeard(me, GLOBAL, { unread: 0, contacts: null }, true, p.deps);
        expect(p.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/me/unread']);
        expect(p.files.size + p.kv.size).toBe(0);
    });

    it('a round\'s answer brings another community level: the change made here reaches Global after the next round', async () => {
        const byron = new FakeCommunity();
        const global = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron, [GLOBAL]: global }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(global.copies.get(me.publicKey)?.seq).toBe(1);
        await editContacts(me, (l) => putContact(l, person1('Sam Jones')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        // Then another phone adds someone at Global only; this phone's round hears Global's newer number.
        const other = phone({ [GLOBAL]: global }, GLOBAL);
        await checkContactsHere(me, other.deps);
        resetContactsCheckForTests();
        await editContacts(me, (l) => putContact(l, person1('Tom')), other.deps);
        other.clock.now += WAIT;
        await syncContacts(me, other.deps);
        p.requests.length = 0;
        await contactsHeard(me, GLOBAL, global.answer(me.publicKey, 'GET', '/api/me/unread', undefined).body, true, p.deps);
        await syncContacts(me, p.deps);
        expect(await names(me, p.deps)).toEqual(['Dee Walker', 'Sam Jones', 'Tom']);
        // Byron gets Tom too, in the same pass.
        expect(byron.copies.get(me.publicKey)!.seq).toBe(global.copies.get(me.publicKey)!.seq);
    });

    it('a community that keeps no lists, or a server from before them, is left alone, and the others still get the copy', async () => {
        const byron = new FakeCommunity();
        byron.off = true;
        const old = new FakeCommunity();
        old.old = true;
        const global = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron, 'https://old.example': old, [GLOBAL]: global }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(global.copies.get(me.publicKey)?.seq).toBe(1);
        const s = (await loadContacts(me, p.deps)).state;
        expect(s.refused[BYRON]?.code).toBe('contacts_off');
        expect(s.refused['https://old.example']?.code).toBe('contacts_off');
        const before = p.requests.length;
        await editContacts(me, (l) => putContact(l, person1('Sam')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(p.requests.slice(before).every((r) => r.community === GLOBAL)).toBe(true);
    });
});

describe('a dishonest community', () => {
    it('saying it keeps a copy numbered at core\'s cap never stops the phone saving its changes, here or elsewhere', async () => {
        const liar = new FakeCommunity();
        liar.liar = true;
        const global = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: liar, [GLOBAL]: global }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(global.copies.get(me.publicKey)?.seq).toBe(1);
        // The claim heard (a round's answer), and a change made straight after it.
        await contactsHeard(me, BYRON, liar.answer(me.publicKey, 'GET', '/api/me/unread', undefined).body, false, p.deps);
        await expect(editContacts(me, (l) => putContact(l, person1('Sam Jones')), p.deps)).resolves.toBeDefined();
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(global.copies.get(me.publicKey)?.seq).toBe(2);
        expect(await names(me, p.deps)).toEqual(['Dee Walker', 'Sam Jones']);
        // Mutation: let nextSeq go past the numbers a community only said → the next change is past the cap and throws.
    });

    it('handing back another member\'s copy adds nobody, and it isn\'t fetched again each pass', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const other = person();
        byron.swapped = contactsCopyWire(makeContactsCopy({ json: writeContactsList(putContact(emptyContactsList(), person1('Mallory'))), me: other, seq: 9 }));
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        await contactsHeard(me, BYRON, { contacts: { seq: 9 } }, false, p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        await syncContacts(me, p.deps);
        expect(p.requests.filter((r) => r.method === 'GET' && r.path === CONTACTS_COPY_PATH)).toHaveLength(1);
        expect(await names(me, p.deps)).toEqual(['Dee Walker']);
        // Mutation: no rest after a copy that doesn't open → fetched again on every pass, up to 512 KiB each time.
    });
});

describe('cost on an old phone', () => {
    it('a round\'s answer opens the list on the phone once, not once to note it and again to decide', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        let opens = 0;
        const counted: ContactsSyncDeps = { ...p.deps, disk: { ...p.deps.disk, read: async (pk) => { opens++; return p.deps.disk.read(pk); } } };
        // Byron keeps none yet and the change is still in its wait: nothing to do, so no pass starts.
        await contactsHeard(me, BYRON, { contacts: null }, true, counted);
        expect(opens).toBe(1);
        expect(p.requests).toEqual([]);
        // Mutation: decide on a second loadContacts after noting → 2 opens per round answer.
    });
});

describe('a list on this phone that can\'t be opened', () => {
    it('set aside, the communities\' copies bring it back, and the damaged bytes are kept beside it, never written over', async () => {
        const byron = new FakeCommunity();
        const global = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron, [GLOBAL]: global }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        await editContacts(me, (l) => putContact(l, person1('Sam Jones')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);
        const sent = readSyncState(p.kv.get(contactsSyncStoreKey(me.publicKey)) ?? null).sentSeq;
        // The file goes bad on the phone (a disk fault): nothing opens it, and every community is skipped.
        const bad = p.files.get(me.publicKey)!.replace(/"sealed":"./, '"sealed":"!');
        p.files.set(me.publicKey, bad);
        expect((await loadContacts(me, p.deps)).onPhone).toEqual({ kind: 'unreadable', reason: 'damaged' });
        await expect(setAsideDamaged(me, p.deps)).resolves.toBe(true);
        expect(p.asides.get(me.publicKey)).toBe(bad);
        await syncContacts(me, p.deps);
        expect(await names(me, p.deps)).toEqual(['Dee Walker', 'Sam Jones']);
        expect((await loadContacts(me, p.deps)).state.back).toBe(2);
        // A number that left the phone is never used again: the next change goes past it.
        await editContacts(me, (l) => putContact(l, person1('Tom')), p.deps);
        const { onPhone } = await loadContacts(me, p.deps);
        expect(onPhone.kind === 'list' && onPhone.seq).toBeGreaterThan(sent);
        // Mutation: keep `merged` after setting the file aside → the communities look level, nothing is fetched, the list stays empty.
    });

    it('a list that opens, or one a newer app wrote, is never set aside', async () => {
        const me = person();
        const p = phone({}, null);
        await expect(setAsideDamaged(me, p.deps)).resolves.toBe(false);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        await expect(setAsideDamaged(me, p.deps)).resolves.toBe(false);
        expect(await names(me, p.deps)).toEqual(['Dee Walker']);
        expect(p.asides.size).toBe(0);
        // Mutation: set aside whatever is there → a good list disappears from the phone.
    });
});

describe('refusals end', () => {
    it('a community that switched lists back on keeps the copy again, and the footer no longer names it as keeping none', async () => {
        const byron = new FakeCommunity();
        byron.off = true;
        const me = person();
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        let { onPhone, state } = await loadContacts(me, p.deps);
        expect(contactsKeptAt(state, onPhone, [BYRON])).toMatchObject({ at: [], off: [BYRON] });
        byron.off = false;
        p.clock.now += 25 * 60 * 60 * 1000;
        await syncContacts(me, p.deps);
        ({ onPhone, state } = await loadContacts(me, p.deps));
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);
        expect(contactsKeptAt(state, onPhone, [BYRON])).toMatchObject({ at: [BYRON], off: [] });
        // Mutation: keep the refusal once Byron answers → the footer says Byron both keeps the list and keeps none.
    });

    it('a copy too big to merge with the phone\'s rests a day, and isn\'t fetched each pass', async () => {
        const byron = new FakeCommunity();
        const me = person();
        // About 300 KiB of contacts on each phone: each locks alone, the two together are past the 512 KiB cap.
        const big = (tag: string) => Array.from({ length: 220 }, (_, i) => ({
            ...person1(`${tag} ${i}`, Array.from({ length: 5 }, (_, k) => `+61 4${String(i).padStart(3, '0')} ${k}${'0'.repeat(28)}`),
                Array.from({ length: 3 }, (_, k) => `${tag.toLowerCase()}${i}.${k}.${'x'.repeat(180)}@example.org`)),
            note: `${tag} ${'n'.repeat(290)}`,
        }));
        const other = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => big('Bee').reduce((acc, c) => putContact(acc, c), l), other.deps);
        other.clock.now += WAIT;
        await syncContacts(me, other.deps);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => big('Ant').reduce((acc, c) => putContact(acc, c), l), p.deps);
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        await syncContacts(me, p.deps);
        expect(p.requests.filter((r) => r.method === 'GET' && r.path === CONTACTS_COPY_PATH)).toHaveLength(1);
        expect((await loadContacts(me, p.deps)).state.refused[BYRON]?.code).toBe('too_big');
        expect((await names(me, p.deps)).length).toBe(220);
        // Mutation: let takeInCopy's throw end the pass → Byron's copy is downloaded and merged again on every pass.
    });
});

describe('what leaves the phone (design §11: the recording node)', () => {
    it('no request\'s URL, body or header holds any name, number, email or note, signed by the phone\'s real request code', async () => {
        vi.useRealTimers();
        const store = new Map<string, string>();
        vi.doMock('@react-native-async-storage/async-storage', () => ({
            default: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => { store.set(k, v); }, removeItem: async (k: string) => { store.delete(k); } },
        }));
        vi.doMock('expo-crypto', async () => ({ getRandomBytes: (n: number) => (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(n)), randomUUID: () => 'x' }));
        const { phoneContactsNet } = await import('../contacts-sync');
        const byron = new FakeCommunity();
        const seen: string[] = [];
        vi.stubGlobal('fetch', async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
            seen.push(url, JSON.stringify(init.headers), init.body ?? '');
            const me = init.headers['X-Public-Key'] ?? init.headers['x-public-key'] ?? Object.values(init.headers).find((v) => /^[0-9a-f]{64}$/.test(v)) ?? '';
            const out = byron.answer(me, init.method, new URL(url).pathname, init.body ? JSON.parse(init.body) : undefined);
            return { status: out.status, ok: out.status < 300, json: async () => out.body } as unknown as Response;
        });
        try {
            const me = person();
            const p = phone({ [BYRON]: byron }, BYRON);
            const deps = { ...p.deps, net: phoneContactsNet() };
            const fixtures = [
                person1('Dee Walker', ['0412 345 678', '+61 400 000 001'], ['dee@example.org']),
                person1('Sam Jones', ['(02) 6600 0000'], ['sam.jones@example.net']),
            ];
            for (const f of fixtures) await editContacts(me, (l) => putContact(l, { ...f, note: 'Seedlings on Saturdays' }), deps);
            p.clock.now += WAIT;
            await syncContacts(me, deps);
            await editContacts(me, (l) => removeEveryContact(l), deps);
            p.clock.now += WAIT;
            await syncContacts(me, deps);
            expect(byron.copies.get(me.publicKey)).toBeDefined();
            expect(seen.length).toBeGreaterThan(0);
            const sent = seen.join('\n');
            // Whole values, and each number's digits alone: short pieces (a "0412") turn up by chance in hex and base64.
            const values = ['Dee Walker', 'Sam Jones', '0412 345 678', '+61 400 000 001', '(02) 6600 0000', 'dee@example.org', 'sam.jones@example.net', 'Seedlings on Saturdays'];
            const digits = ['0412345678', '61400000001', '0266000000'];
            for (const s of [...values, ...digits]) expect(sent).not.toContain(s);
            // Mutation: send the list's JSON beside the copy (or a name in a query) → this fails on the first name.
        } finally {
            vi.unstubAllGlobals();
            vi.doUnmock('@react-native-async-storage/async-storage');
            vi.doUnmock('expo-crypto');
        }
    });
});

describe('the save set for later', () => {
    it('goes when the wait is over, and never for an account that has left the phone meanwhile', async () => {
        const byron = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        await vi.advanceTimersByTimeAsync(60_000);
        await settle();
        expect(p.requests).toEqual([]);
        p.clock.now += WAIT;
        await vi.advanceTimersByTimeAsync(WAIT);
        await settle();
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);

        const q = phone({ [BYRON]: byron }, BYRON);
        const her = person();
        await editContacts(her, (l) => putContact(l, person1('Sam Jones')), q.deps);
        // Sign Out (identity.ts announces the phone's key going): the save set for her never fires.
        const { announceAccountOnPhone } = await import('../account-on-phone');
        announceAccountOnPhone(null);
        q.clock.now += WAIT;
        await vi.advanceTimersByTimeAsync(WAIT);
        await settle();
        expect(q.requests).toEqual([]);
        expect(byron.copies.get(her.publicKey)).toBeUndefined();
        // Mutation: drop the onAccountOnPhone listener → the timer fires and her copy is sent after she signed out.
    });
});

describe('the communities a pass visits: the member\'s own, never a guest\'s look (PR #3073 review 4542103430)', () => {
    it('a community the phone only looks at as a guest is never asked, the one in use included; one with alerts off still keeps the copy', async () => {
        const byron = new FakeCommunity();
        const castlemaine = new FakeCommunity();
        const global = new FakeCommunity();
        const me = person();
        const p = phone({ [BYRON]: byron, [CASTLEMAINE]: castlemaine, [GLOBAL]: global }, GLOBAL);
        // "Explore worldwide": the phone is on Global as a guest (global-guest-visit.ts marks the look first, spelled as it
        // came), and keeps Byron and Castlemaine, the member's own; Castlemaine's alerts are off.
        p.kv.set('beanpool_anchor_url', GLOBAL);
        p.kv.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: BYRON }, { url: GLOBAL }, { url: CASTLEMAINE }]));
        p.kv.set('beanpool_guest_nodes', JSON.stringify([`${GLOBAL}/`]));
        p.kv.set(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify([CASTLEMAINE]));
        const deps: ContactsSyncDeps = { ...p.deps, communities: phoneSyncDeps({ disk: p.deps.disk, kv: p.deps.kv }).communities };
        expect(await deps.communities()).toEqual({ anchor: null, kept: [BYRON, CASTLEMAINE] });
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), deps);
        p.clock.now += WAIT;
        await checkContactsHere(me, deps);
        await syncContacts(me, deps);
        expect(p.requests.filter((r) => r.community === GLOBAL)).toEqual([]);
        expect(byron.copies.get(me.publicKey)?.seq).toBe(1);
        expect(castlemaine.copies.get(me.publicKey)?.seq).toBe(1);
        // Joining clears the mark (nodes.ts clearGuestNode): the member belongs there now, and Global keeps the copy too.
        p.kv.set('beanpool_guest_nodes', '[]');
        resetContactsCheckForTests();
        await checkContactsHere(me, deps);
        expect(global.copies.get(me.publicKey)?.seq).toBe(1);
        // Mutation: phoneSyncDeps's communities as readKeptCommunities alone → Global hears the member's key each pass;
        // as push-registrations' communitiesForAlerts → the guest look in use is still asked, and Castlemaine keeps no copy.
    });

    it('guest marks that can\'t be read stop the pass: a failed read is never taken as "no looks"', async () => {
        const me = person();
        const global = new FakeCommunity();
        const p = phone({ [GLOBAL]: global }, GLOBAL);
        const kv = {
            getItem: async (k: string) => {
                if (k === 'beanpool_guest_nodes') throw new Error('storage failed');
                return k === 'beanpool_anchor_url' ? GLOBAL : null;
            },
            setItem: p.deps.kv.setItem,
        };
        await expect(contactsCommunities(kv)).rejects.toThrow('storage failed');
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        p.clock.now += WAIT;
        await checkContactsHere(me, { ...p.deps, communities: phoneSyncDeps({ disk: p.deps.disk, kv }).communities });
        expect(p.requests).toEqual([]);
        // Mutation: read the marks inside the parse's try → the failure reads as "no looks", and Global is asked.
    });
});

describe('where the copy is kept (the Contacts footer)', () => {
    it('names the communities holding exactly the phone\'s copy, and those that keep no lists', async () => {
        const byron = new FakeCommunity();
        const global = new FakeCommunity();
        global.off = true;
        const me = person();
        const p = phone({ [BYRON]: byron, [GLOBAL]: global }, BYRON);
        await editContacts(me, (l) => putContact(l, person1('Dee Walker')), p.deps);
        let { onPhone, state } = await loadContacts(me, p.deps);
        expect(contactsKeptAt(state, onPhone, [BYRON, GLOBAL])).toEqual({ at: [], off: [], savedAt: null });
        p.clock.now += WAIT;
        await syncContacts(me, p.deps);
        ({ onPhone, state } = await loadContacts(me, p.deps));
        expect(contactsKeptAt(state, onPhone, [BYRON, GLOBAL])).toEqual({ at: [BYRON], off: [GLOBAL], savedAt: p.clock.now });
        // A change not yet sent: Byron holds the one before, so it isn't named as keeping this one.
        await editContacts(me, (l) => putContact(l, person1('Sam Jones')), p.deps);
        ({ onPhone, state } = await loadContacts(me, p.deps));
        expect(contactsKeptAt(state, onPhone, [BYRON, GLOBAL]).at).toEqual([]);
    });
});

describe('decide', () => {
    const list = { kind: 'list' as const, list: { v: 1 as const, contacts: [], removed: [] }, seq: 4, copy: { header: '', signature: '', nonce: '', sealed: '' } };
    const s = (o: Partial<ReturnType<typeof readSyncState>>) => ({ ...readSyncState(null), ...o });
    it('asks a community never heard from, fetches one holding an unmerged copy, saves to one behind (asking first when far behind), and leaves the rest', () => {
        expect(decide(BYRON, s({}), list, 0)).toBe('ask');
        expect(decide(BYRON, s({}), { kind: 'none' }, 0)).toBe('level');
        expect(decide(BYRON, s({ heard: { [BYRON]: 9 }, merged: { [BYRON]: 3 } }), list, 0)).toBe('fetch');
        expect(decide(BYRON, s({ heard: { [BYRON]: 3 }, merged: { [BYRON]: 3 } }), list, 0)).toBe('put');
        // More than one past the number heard (4 is past "none" and past 2): asked again first, then saved only on that answer.
        // The 'put' this line said at 64ce793c, with nothing asked, was the defect of review 4542103140.
        expect(decide(BYRON, s({ heard: { [BYRON]: null } }), list, 0)).toBe('ask');
        expect(decide(BYRON, s({ heard: { [BYRON]: null } }), list, 0, null)).toBe('put');
        expect(decide(BYRON, s({ heard: { [BYRON]: 2 }, merged: { [BYRON]: 2 } }), list, 0)).toBe('ask');
        expect(decide(BYRON, s({ heard: { [BYRON]: 2 }, merged: { [BYRON]: 2 } }), list, 0, 2)).toBe('put');
        expect(decide(BYRON, s({ heard: { [BYRON]: 4 }, merged: { [BYRON]: 4 } }), list, 0)).toBe('level');
        expect(decide(BYRON, s({ heard: { [BYRON]: 3 }, merged: { [BYRON]: 3 }, dueAt: 10 }), list, 5)).toBe('level');
        expect(decide(BYRON, s({ refused: { [BYRON]: { code: 'node_full', until: 10 } } }), list, 5)).toBe('skip');
        expect(decide(BYRON, s({}), { kind: 'unreadable', reason: 'damaged' }, 0)).toBe('skip');
    });
});
