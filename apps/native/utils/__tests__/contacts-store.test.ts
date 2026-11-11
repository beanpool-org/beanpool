/**
 * The phone's private contacts store (utils/contacts-store.ts, DESIGN-private-contacts-fable.md §4.2, §4.5, slice C2), over an
 * in-memory disk and AsyncStorage: what the file holds, the number a change is locked under, the record beside the file,
 * and a community's copy taken in. Each check names the change to the store that turns it red.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    emptyContactsList, makeContactsCopy, newContactId, openContactsCopy, putContact, readContactsList, removeContact, toEd25519Pkcs8,
    writeContactsList, contactsCopyWire, type ContactsList,
} from '@beanpool/core';
import {
    CONTACTS_SAVE_WAIT_MS, ContactsUnreadableError, changeContacts, contactsSyncStoreKey, loadContacts, nextSeq, readSyncState, takeInCopy,
    type ContactsAccount, type ContactsStoreDeps,
} from '../contacts-store';

function person(): ContactsAccount & { seed: Uint8Array } {
    const seed = ed25519.utils.randomSecretKey();
    return { seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed) };
}

function fakeDeps(at = 1_800_000_000_000): ContactsStoreDeps & { files: Map<string, string>; kvMap: Map<string, string>; clock: { now: number } } {
    const files = new Map<string, string>();
    const kvMap = new Map<string, string>();
    const clock = { now: at };
    return {
        files, kvMap, clock,
        disk: { read: async (pk) => files.get(pk) ?? null, write: async (pk, text) => { files.set(pk, text); } },
        kv: { getItem: async (k) => kvMap.get(k) ?? null, setItem: async (k, v) => { kvMap.set(k, v); } },
        now: () => clock.now,
    };
}

const dee = (id = newContactId()) => ({ id, name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: 'Seedlings', links: [], invite: null });
const add = (c: ReturnType<typeof dee>) => (l: ContactsList) => putContact(l, c);
const fixedRandom = (r: number) => () => r;

describe('the phone keeps the list locked, in a file per account', () => {
    it('writes nothing, file or record, until a first contact (design §0.2: optional)', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, (l) => l, deps);
        await changeContacts(me, (l) => removeContact(l, newContactId()), deps);
        expect(deps.files.size).toBe(0);
        expect(deps.kvMap.size).toBe(0);
        // Mutation: drop the guard on an empty first change → a file of nobody is written.
    });

    it('holds only locked bytes: no name, number or email readable in the file, and it opens with the web app\'s PKCS8 key', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps);
        const text = deps.files.get(me.publicKey)!;
        for (const s of ['Dee', 'Walker', '0412', '345 678', 'dee@example.org', 'Seedlings']) expect(text).not.toContain(s);
        // The web app keeps the same key as PKCS8 (DESIGN §1.1): the phone's file opens there, which is the vectors' promise.
        const web = { publicKey: me.publicKey, privateKey: bytesToHex(toEd25519Pkcs8(me.seed)) };
        const opened = openContactsCopy(JSON.parse(text), web);
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const list = readContactsList(opened.json);
        expect(list.ok && list.list.contacts.map((c) => c.name)).toEqual(['Dee Walker']);
    });

    it('a change waits a random 2 to 15 minutes before it may leave the phone, and later changes join that wait', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps, fixedRandom(0));
        let s = readSyncState(deps.kvMap.get(contactsSyncStoreKey(me.publicKey)) ?? null);
        expect(s.dueAt).toBe(deps.clock.now + CONTACTS_SAVE_WAIT_MS.min);
        deps.clock.now += 60_000;
        await changeContacts(me, add(dee()), deps, fixedRandom(0.999));
        s = readSyncState(deps.kvMap.get(contactsSyncStoreKey(me.publicKey)) ?? null);
        expect(s.dueAt).toBe(deps.clock.now - 60_000 + CONTACTS_SAVE_WAIT_MS.min);
        const top = fakeDeps();
        await changeContacts(me, add(dee()), top, fixedRandom(0.999));
        const wait = readSyncState(top.kvMap.get(contactsSyncStoreKey(me.publicKey)) ?? null).dueAt! - top.clock.now;
        expect(wait).toBeGreaterThan(14 * 60_000);
        expect(wait).toBeLessThanOrEqual(CONTACTS_SAVE_WAIT_MS.max);
    });
});

describe('a copy\'s number is never used twice once it has left the phone', () => {
    it('re-locks under the same number until it is sent, then takes the next', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps);
        await changeContacts(me, add(dee()), deps);
        let { onPhone } = await loadContacts(me, deps);
        expect(onPhone.kind === 'list' && onPhone.seq).toBe(1);
        // Sent (contacts-sync.ts writes sentSeq before the PUT goes out).
        const key = contactsSyncStoreKey(me.publicKey);
        deps.kvMap.set(key, JSON.stringify({ ...JSON.parse(deps.kvMap.get(key)!), sentSeq: 1 }));
        await changeContacts(me, add(dee()), deps);
        ({ onPhone } = await loadContacts(me, deps));
        expect(onPhone.kind === 'list' && onPhone.seq).toBe(2);
        // Mutation: always reuse the file's number → 1 again, and a community would keep the copy sent before this change.
    });

    it('goes past every number a community was heard to keep', () => {
        expect(nextSeq(3, { sentSeq: 0, heard: { a: 9, b: null }, merged: { a: 9 } })).toBe(10);
        expect(nextSeq(12, { sentSeq: 0, heard: { a: 9 }, merged: {} })).toBe(12);
        expect(nextSeq(12, { sentSeq: 12, heard: {}, merged: {} })).toBe(13);
    });
});

describe('the record beside the file', () => {
    it('a file that is gone, or not the one the record was written beside, clears what was merged', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps);
        const key = contactsSyncStoreKey(me.publicKey);
        deps.kvMap.set(key, JSON.stringify({ ...JSON.parse(deps.kvMap.get(key)!), merged: { 'https://byron.example': 1 }, heard: { 'https://byron.example': 1 } }));
        expect((await loadContacts(me, deps)).state.merged).toEqual({ 'https://byron.example': 1 });
        deps.files.delete(me.publicKey);
        const { state } = await loadContacts(me, deps);
        expect(state.merged).toEqual({});
        // Mutation: keep `merged` whatever the file → a later save overwrites a community's people this phone never merged.
    });

    it('a file that can\'t be opened is never written over', async () => {
        const me = person();
        const deps = fakeDeps();
        deps.files.set(me.publicKey, '{"header":"not a copy"}');
        expect((await loadContacts(me, deps)).onPhone).toEqual({ kind: 'unreadable', reason: 'damaged' });
        await expect(changeContacts(me, add(dee()), deps)).rejects.toBeInstanceOf(ContactsUnreadableError);
        expect(deps.files.get(me.publicKey)).toBe('{"header":"not a copy"}');
    });

    it('a list a newer app wrote is said as such, and never written over', async () => {
        const me = person();
        const deps = fakeDeps();
        const json = JSON.stringify({ v: 2, contacts: [], removed: [] });
        deps.files.set(me.publicKey, JSON.stringify(contactsCopyWire(makeContactsCopy({ json, me, seq: 4 }))));
        expect((await loadContacts(me, deps)).onPhone).toEqual({ kind: 'unreadable', reason: 'newer' });
        await expect(changeContacts(me, add(dee()), deps)).rejects.toMatchObject({ reason: 'newer' });
    });
});

describe('a community\'s copy taken in', () => {
    const BYRON = 'https://byron.example';
    const copyOf = (me: ContactsAccount, list: ContactsList, seq: number) => contactsCopyWire(makeContactsCopy({ json: writeContactsList(list), me, seq }));

    it('on a phone with no list: the copy is kept as it is, and how many came back is noted (design §4.5)', async () => {
        const me = person();
        const deps = fakeDeps();
        const theirs = putContact(putContact(emptyContactsList(), dee()), { ...dee(), name: 'Sam Jones' });
        const wire = copyOf(me, theirs, 7);
        const took = await takeInCopy(me, BYRON, wire, deps);
        expect(took).toEqual({ kind: 'merged', changed: true, seq: 7, back: 2 });
        expect(JSON.parse(deps.files.get(me.publicKey)!)).toEqual(wire);
        const { state } = await loadContacts(me, deps);
        expect(state).toMatchObject({ fileSeq: 7, heard: { [BYRON]: 7 }, merged: { [BYRON]: 7 }, back: 2 });
    });

    it('merges with the phone\'s own list, keeping both, under a number past the copy\'s', async () => {
        const me = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps);
        const theirs = putContact(emptyContactsList(), { ...dee(), name: 'Sam Jones' });
        const took = await takeInCopy(me, BYRON, copyOf(me, theirs, 5), deps);
        expect(took).toMatchObject({ kind: 'merged', changed: true, seq: 5, back: null });
        const { onPhone, state } = await loadContacts(me, deps);
        expect(onPhone.kind === 'list' && onPhone.list.contacts.map((c) => c.name).sort()).toEqual(['Dee Walker', 'Sam Jones']);
        expect(onPhone.kind === 'list' && onPhone.seq).toBe(6);
        expect(state.merged[BYRON]).toBe(5);
    });

    it('another member\'s copy, or a forged one, adds nobody: only its number is noted, so the next save replaces it', async () => {
        const me = person();
        const other = person();
        const deps = fakeDeps();
        await changeContacts(me, add(dee()), deps);
        const theirs = putContact(emptyContactsList(), { ...dee(), name: 'Mallory' });
        expect(await takeInCopy(me, BYRON, copyOf(other, theirs, 40), deps)).toEqual({ kind: 'unopened', seq: 40 });
        const { onPhone, state } = await loadContacts(me, deps);
        expect(onPhone.kind === 'list' && onPhone.list.contacts.map((c) => c.name)).toEqual(['Dee Walker']);
        expect(state.heard[BYRON]).toBe(40);
        expect(state.merged[BYRON]).toBeUndefined();
    });

    it('a removal made here is not undone by an older copy (core\'s markers, through the store)', async () => {
        const me = person();
        const deps = fakeDeps();
        const d = dee();
        await changeContacts(me, add(d), deps);
        const { onPhone } = await loadContacts(me, deps);
        const old = onPhone.kind === 'list' ? onPhone.list : emptyContactsList();
        await changeContacts(me, (l) => removeContact(l, d.id), deps);
        await takeInCopy(me, BYRON, copyOf(me, old, 1), deps);
        const after = await loadContacts(me, deps);
        expect(after.onPhone.kind === 'list' && after.onPhone.list.contacts).toEqual([]);
    });
});
