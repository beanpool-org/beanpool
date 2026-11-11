/**
 * The member's private contacts list in this browser (scratch/fable-design/DESIGN-private-contacts-fable.md §4.2, §4.5,
 * §6.4, slice C4), and its locked copy at the community this web app is for (the server's store is slice C1:
 * apps/server engine/contact-copies.ts, GET/PUT /api/contacts/copy).
 *
 * - **Kept locked.** This browser keeps only the locked copy (lib/contacts-lock.ts), one row per account in its own
 *   database (`beanpool-contacts`, one per web address as every store of this app is), and opens it in memory when a
 *   screen needs it. A copied browser profile holds locked bytes alone.
 * - **One change, one locked copy.** A change is read, merged and written in ONE IndexedDB transaction: the copy held
 *   here (another tab may have just written one) is opened, merged with what this tab holds, changed, locked under the
 *   next number and put back, so two tabs never drop each other's changes.
 * - **Saved after a wait.** The community gets the copy a random 2 to 15 minutes after a change (design §4.5, §5.2: a
 *   save that followed a profile view at once would say who was added), changes in between going together. Sign-out's
 *   "Save now" ({@link saveContactsNow}) is the one save without the wait.
 * - **Merged here, never there.** A copy the community holds is opened and merged in (core's merge: the higher clock
 *   wins, a removal's marker beats an older contact). A 409 `stale_copy` means another device saved first: fetch,
 *   merge, save again.
 * - **What it says, truthfully.** `where` is what the footer says: `here` (the community keeps the latest), `soon`
 *   (a change waits for its save), `retry` (the last save or read didn't arrive: tried again), `device-only` (this
 *   community keeps no list for this member: switched off, full, too big, or not a member here).
 * - **Never past the account.** Once the account leaves this browser (Sign Out, or the delete at the last community, in
 *   this tab or another: lib/account-epoch.ts), nothing started before keeps a row here, shows the list or sends
 *   anything, even after another account has signed in. What is sent is signed as the account whose list it is, never as
 *   whoever this browser holds by then.
 *
 * The web saves only to the community whose web app is open (design §4.5; reaching global from the web is a later step).
 * Signing out deletes this database (lib/device-prefs.ts clearAccountStorage), after Settings has said so when the
 * community doesn't yet hold the latest copy ({@link contactsSignOutCheck}).
 */
import { useSyncExternalStore } from 'react';
import {
    emptyContactsList, mergeContactsLists, readContactsCopy, writeContactsList, writeContactsVcard, type ContactsCopyWire, type ContactsList,
} from '@beanpool/core';
import { accountEpochHolds, onAccountEpochEnd } from './account-epoch';
import { nodeAddress, signedFetchWithKey } from './api';
import { lockContactsList, openContactsList, type ContactsKeys } from './contacts-lock';

const DB_NAME = 'beanpool-contacts';
const STORE = 'copies';
const PATH = '/api/contacts/copy';
/** The wait before a save (design §4.5): a random time from 2 to 15 minutes. */
export const CONTACTS_SAVE_WAIT_MS = { min: 2 * 60_000, max: 15 * 60_000 } as const;
/** How long a save that didn't arrive waits before it is tried again. */
const RETRY_MS = 5 * 60_000;

/** Where the list is kept, as the footer says it (see the file's note). */
export type ContactsWhere = 'here' | 'soon' | 'retry' | 'device-only';

/** What this browser keeps for an account: the latest locked copy, and what the community it talks to keeps. */
interface Held {
    copy: ContactsCopyWire;
    seq: number;
    /** The community `kept` describes (its address), the number it was last known to keep, and that copy's time. */
    at: string;
    kept: number | null;
    keptAt: string | null;
    /** The community keeps no list for this member (switched off, full, too big, not a member): device-only. */
    refused: boolean;
}

export interface ContactsSnapshot {
    /** The account this is for; null before a screen opened it. */
    key: string | null;
    phase: 'idle' | 'loading' | 'ready' | 'failed';
    /** The list, opened; null before it is read, or when a newer app wrote it. */
    list: ContactsList | null;
    where: ContactsWhere;
    /** When the community last took a copy (its header's time), or null. */
    keptAt: string | null;
    /** Set once when a copy from the community filled this browser: "Your contacts are back: n people." */
    restored: number | null;
    /** The list was written by a newer BeanPool: nothing here reads in part or changes it. */
    newer: boolean;
}

const IDLE: ContactsSnapshot = { key: null, phase: 'idle', list: null, where: 'here', keptAt: null, restored: null, newer: false };
let snapshot: ContactsSnapshot = IDLE;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let opening: { key: string; done: Promise<void> } | null = null;

function publish(next: Partial<ContactsSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l();
}

/** The list's state for a screen (React): re-renders on every change. */
export function useContacts(): ContactsSnapshot {
    return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => snapshot, () => snapshot);
}

export function contactsSnapshot(): ContactsSnapshot {
    return snapshot;
}

// ── The account leaving ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Moves on each time the account leaves this browser (see the file's note). Work takes it when it starts and holds to
 * it, so work started before the account left stops at its next step, even once this page has signed in again (a 'cleared'
 * end keeps the account, and with it the work under way).
 */
let session = 0;

/** Thrown inside the store when the account left while its work was under way: that work stops, keeping nothing. */
class AccountLeftError extends Error {
    constructor() {
        super('The account has left this browser.');
        this.name = 'AccountLeftError';
    }
}

/** Whether work started in `s` may still keep, show or send anything: the account hasn't left since, here or elsewhere. */
function live(s: number): boolean {
    return accountEpochHolds() && s === session;
}

/** The account left: the waiting save is dropped, no screen shows the list, and nothing under way goes on ({@link live}). */
function leave(): void {
    session += 1;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    opening = null;
    publish(IDLE);
}

onAccountEpochEnd((end) => { if (end === 'signed-out') leave(); });

/** What work started in `s` tells a screen: only while it may (see {@link live}) and the screen shows this account. */
function tell(s: number, key: string, next: Partial<ContactsSnapshot>): void {
    if (live(s) && snapshot.key === key) publish(next);
}

// ── This browser's row ─────────────────────────────────────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('This browser has no IndexedDB.');
            req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
            reject(e);
            return;
        }
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => {
            const db = req.result;
            // Another tab's Sign Out deletes the database: let go of it at once, open afresh next time.
            (db as IDBDatabase & { onversionchange: unknown }).onversionchange = () => {
                try { db.close(); } catch { /* already closed */ }
                if (dbPromise === p) dbPromise = null;
            };
            resolve(db);
        };
        req.onerror = () => reject(req.error ?? new Error('The contacts store did not open.'));
        (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = () => reject(new Error('The contacts store is blocked.'));
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
}

function asHeld(v: unknown): Held | null {
    if (!v || typeof v !== 'object') return null;
    const h = v as Held;
    const read = readContactsCopy(h.copy);
    if (!read.ok || read.copy.seq !== h.seq || typeof h.at !== 'string') return null;
    return { copy: h.copy, seq: h.seq, at: h.at, kept: Number.isSafeInteger(h.kept) ? h.kept : null, keptAt: typeof h.keptAt === 'string' ? h.keptAt : null, refused: h.refused === true };
}

/**
 * Read the account's row and decide what to write, in one readwrite transaction (see the file's note). `decide` runs
 * synchronously inside it and returns the row to put (or null for none) and a result. For work started in `s` only:
 * once the account has left this browser it opens nothing (so Sign Out's delete is never undone), and a row that landed
 * as the account left is taken out again, as tools/store.ts does.
 */
async function withHeld<T>(key: string, s: number, decide: (held: Held | null) => { put: Held | null; result: T }): Promise<T> {
    if (!live(s)) throw new AccountLeftError();
    const db = await openDb();
    if (!live(s)) throw new AccountLeftError();
    let wrote = false;
    const result = await new Promise<T>((resolve, reject) => {
        let answer: T;
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.get(key);
        req.onsuccess = () => {
            try {
                const out = decide(asHeld(req.result));
                if (out.put) { store.put(out.put, key); wrote = true; }
                answer = out.result;
            } catch (e) {
                reject(e);
                try { tx.abort(); } catch { /* already done */ }
            }
        };
        tx.oncomplete = () => resolve(answer);
        tx.onerror = () => reject(tx.error ?? new Error('The contacts store did not save.'));
        tx.onabort = () => reject(tx.error ?? new Error('The contacts store did not save.'));
    });
    if (wrote && !live(s)) {
        await dropRow(db, key);
        throw new AccountLeftError();
    }
    return result;
}

/** The account's row taken out. Never throws: a database closed under it is being deleted, and the row goes with it. */
function dropRow(db: IDBDatabase, key: string): Promise<void> {
    return new Promise<void>((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

const readHeld = (key: string, s: number) => withHeld<Held | null>(key, s, (held) => ({ put: null, result: held }));

/** Where the footer stands for a row: see {@link ContactsWhere}. */
function whereOf(held: Held | null, address: string): ContactsWhere {
    if (!held) return 'here';
    if (held.refused && held.at === address) return 'device-only';
    return held.at === address && held.kept === held.seq ? 'here' : 'soon';
}

function openHeld(held: Held | null, me: ContactsKeys): { list: ContactsList | null; newer: boolean } {
    if (!held) return { list: emptyContactsList(), newer: false };
    const opened = openContactsList(held.copy, me);
    if (opened.ok) return { list: opened.list, newer: false };
    if (opened.reason === 'newer') return { list: null, newer: true };
    // A row that doesn't open with this key isn't this account's list: read as none (a save will replace it).
    return { list: emptyContactsList(), newer: false };
}

// ── Opening, changing ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open the account's list for a screen: this browser's copy, then the community's, merged. Once per page load and key;
 * `fresh` asks the community again (the Contacts page, which another device may have changed). Never throws.
 */
export function openContacts(me: ContactsKeys, fresh = false): Promise<void> {
    const key = me.publicKey.toLowerCase();
    if (opening?.key === key && !fresh) return opening.done;
    const s = session;
    if (snapshot.key !== key) publish({ ...IDLE, key, phase: 'loading' });
    const done = (async () => {
        try {
            const held = await readHeld(key, s);
            const { list, newer } = openHeld(held, me);
            tell(s, key, { list, newer, where: whereOf(held, nodeAddress()), keptAt: held?.at === nodeAddress() ? held.keptAt : null, phase: 'ready' });
            await pull(me, s);
        } catch {
            if (snapshot.key === key && snapshot.phase !== 'ready') publish({ phase: 'failed' });
        }
    })();
    opening = { key, done };
    return done;
}

/** Thrown by {@link changeContacts} when a newer BeanPool wrote the list: nothing here may change it. */
export class ContactsNewerError extends Error {
    constructor() {
        super('A newer BeanPool saved this contacts list.');
        this.name = 'ContactsNewerError';
    }
}

/**
 * Change the list: `change` gets the list as this browser holds it (another tab's latest included) and returns the new
 * one, which is locked under the next number and kept here, and goes to the community after the wait. Returns the list.
 */
export async function changeContacts(me: ContactsKeys, change: (list: ContactsList) => ContactsList): Promise<ContactsList> {
    const key = me.publicKey.toLowerCase();
    const address = nodeAddress();
    const s = session;
    const mine = snapshot.key === key ? snapshot.list : null;
    const next = await withHeld(key, s, (held) => {
        const stored = openHeld(held, me);
        if (stored.newer || (snapshot.key === key && snapshot.newer)) throw new ContactsNewerError();
        const list = change(mine ? mergeContactsLists(stored.list ?? emptyContactsList(), mine) : stored.list ?? emptyContactsList());
        const kept = held?.at === address ? held.kept : null;
        const seq = Math.max(held?.seq ?? 0, kept ?? 0) + 1;
        const put: Held = {
            copy: lockContactsList(list, me, seq), seq, at: address, kept, keptAt: held?.at === address ? held.keptAt : null,
            // A first list where the community already said it keeps none: kept here alone, never sent.
            refused: held?.at === address ? held.refused : snapshot.key === key && snapshot.where === 'device-only',
        };
        return { put, result: { list, held: put } };
    });
    if (live(s)) publish({ key, list: next.list, phase: 'ready', where: whereOf(next.held, address) });
    if (!next.held.refused) scheduleSave(me, s);
    return next.list;
}

function scheduleSave(me: ContactsKeys, s: number, ms?: number): void {
    // Changes made during the wait go with it. Nothing waits for an account that has left this browser.
    if (saveTimer || !live(s)) return;
    const wait = ms ?? CONTACTS_SAVE_WAIT_MS.min + Math.floor(Math.random() * (CONTACTS_SAVE_WAIT_MS.max - CONTACTS_SAVE_WAIT_MS.min));
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void push(me, s);
    }, wait);
}

// ── The community's copy ───────────────────────────────────────────────────────────────────────────────────────────

/** The community's answer to a save or a read, as the store acts on it. */
type Answer = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'missing' } | { kind: 'refused' } | { kind: 'stale' } | { kind: 'failed' };

async function ask(me: ContactsKeys, s: number, method: 'GET' | 'PUT', body?: ContactsCopyWire): Promise<Answer> {
    // Nothing goes once the account has left this browser. What goes is signed as `me`, whose list it is, never as whoever
    // this browser holds by then (signedFetch signs as that).
    if (!live(s)) throw new AccountLeftError();
    let res: Response;
    try {
        res = await signedFetchWithKey(method, PATH, body, me.privateKey, me.publicKey);
    } catch {
        return { kind: 'failed' };
    }
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok) return { kind: 'ok', body: json };
    const code = typeof json.code === 'string' ? json.code : '';
    if (res.status === 404 && code === 'no_copy') return { kind: 'missing' };
    if (res.status === 409 && code === 'stale_copy') return { kind: 'stale' };
    // The community keeps no list for this member: switched off, full, too big for it, or not a member here.
    if (code === 'contacts_off' || code === 'node_full' || code === 'copy_too_big' || code === 'not_a_member' || res.status === 401) return { kind: 'refused' };
    // Busy, a standby, a server error, or a proxy's page: tried again later.
    return { kind: 'failed' };
}

/** Mark the row for `address` (what the community keeps), keeping its copy; null when there is no row. */
async function markKept(key: string, s: number, address: string, mark: Pick<Held, 'kept' | 'keptAt' | 'refused'>): Promise<Held | null> {
    return withHeld(key, s, (held) => {
        if (!held) return { put: null, result: null };
        const put = { ...held, at: address, ...mark };
        return { put, result: put };
    });
}

/**
 * The community's copy, read and merged into this browser's (design §4.5). A list that only the community held fills
 * this browser ("Your contacts are back"); a merged list that holds more than the community's is locked under the next
 * number and saved after the wait. Never throws.
 */
async function pull(me: ContactsKeys, s: number): Promise<void> {
    const key = me.publicKey.toLowerCase();
    const address = nodeAddress();
    const answer = await ask(me, s, 'GET');
    // The row is brought level whatever screen is open; the screen hears of it only while it shows this account.
    const say = (next: Partial<ContactsSnapshot>) => tell(s, key, next);
    if (answer.kind === 'refused') {
        await markKept(key, s, address, { kept: null, keptAt: null, refused: true });
        say({ where: 'device-only' });
        return;
    }
    if (answer.kind === 'missing') {
        const held = await markKept(key, s, address, { kept: null, keptAt: null, refused: false });
        say({ where: whereOf(held, address) });
        if (held) scheduleSave(me, s);
        return;
    }
    const theirs = answer.kind === 'ok' ? openContactsList(answer.body, me) : null;
    if (theirs && !theirs.ok && theirs.reason === 'newer') {
        say({ newer: true, list: null });
        return;
    }
    if (answer.kind !== 'ok' || !theirs?.ok) {
        // No copy came back: the community was out of reach, or a 200 isn't this member's copy (a captive portal's page,
        // something in front of the community), as a save's bare 200 is in push(). A change it hasn't got is tried again
        // later, and said so. A list this community keeps none of stays device-only: nothing is tried, so nothing says
        // "will try again".
        const held = await readHeld(key, s);
        if (held && whereOf(held, address) !== 'device-only' && held.seq !== held.kept) { say({ where: 'retry' }); scheduleSave(me, s, RETRY_MS); }
        return;
    }
    const wire: ContactsCopyWire = { header: String(answer.body.header), signature: String(answer.body.signature), nonce: String(answer.body.nonce), sealed: String(answer.body.sealed) };
    const outcome = await withHeld(key, s, (held) => {
        const stored = openHeld(held, me);
        if (stored.newer) return { put: null, result: null };
        const merged = mergeContactsLists(stored.list ?? emptyContactsList(), theirs.list);
        const restored = !held && merged.contacts.length > 0 ? merged.contacts.length : null;
        if (writeContactsList(merged) === writeContactsList(theirs.list)) {
            // The community's copy holds everything: kept here as it is, already saved.
            const put: Held = { copy: wire, seq: theirs.seq, at: address, kept: theirs.seq, keptAt: theirs.savedAt, refused: false };
            return { put, result: { list: merged, held: put, restored } };
        }
        // This browser holds more: the merged list under a number above both, saved after the wait.
        const seq = Math.max(held?.seq ?? 0, theirs.seq) + 1;
        const put: Held = { copy: lockContactsList(merged, me, seq), seq, at: address, kept: theirs.seq, keptAt: theirs.savedAt, refused: false };
        return { put, result: { list: merged, held: put, restored } };
    });
    if (!outcome) return;
    say({ list: outcome.list, where: whereOf(outcome.held, address), keptAt: outcome.held.keptAt, newer: false, ...(outcome.restored ? { restored: outcome.restored } : {}) });
    if (outcome.held.seq !== outcome.held.kept) scheduleSave(me, s);
}

/**
 * Save this browser's copy to the community now (after the wait, or sign-out's "Save now"). A 409 `stale_copy` is
 * fetched and merged, and the merged copy saved, once. Returns where the list stands after.
 */
async function push(me: ContactsKeys, s: number, attempt = 0): Promise<ContactsWhere> {
    const key = me.publicKey.toLowerCase();
    const address = nodeAddress();
    let held: Held | null;
    try { held = await readHeld(key, s); } catch { return snapshot.where; }
    if (!held || (held.at === address && (held.kept === held.seq || held.refused))) return whereOf(held, address);
    try {
        const answer = await ask(me, s, 'PUT', held.copy);
        // Saved only when the community names this copy's number (design §6.4: sign-out removes this browser's copy once
        // the server has the same number). A 2xx naming none or another, such as a page from something in front of it,
        // is tried again like a save that didn't arrive.
        if (answer.kind === 'ok' && answer.body.seq === held.seq) {
            const savedAt = readContactsCopy(held.copy);
            const marked = await markKept(key, s, address, { kept: held.seq, keptAt: savedAt.ok ? savedAt.copy.savedAt : null, refused: false });
            // A change made while the save was on its way has its own wait.
            if (marked && marked.seq !== marked.kept) scheduleSave(me, s);
            return settle(s, key, marked, address);
        }
        if (answer.kind === 'stale' && attempt === 0) {
            await pull(me, s);
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            return push(me, s, 1);
        }
        if (answer.kind === 'refused') return settle(s, key, await markKept(key, s, address, { kept: null, keptAt: null, refused: true }), address);
    } catch {
        // The row couldn't be written, or the account left this browser: what the screen says stays as it was.
    }
    // The account left while the save was under way: nothing is tried again, and nothing said.
    if (!live(s)) return snapshot.where;
    scheduleSave(me, s, RETRY_MS);
    tell(s, key, { where: 'retry' });
    return 'retry';
}

function settle(s: number, key: string, held: Held | null, address: string): ContactsWhere {
    const where = whereOf(held, address);
    tell(s, key, { where, keptAt: held?.keptAt ?? null });
    return where;
}

/** Sign-out's "Save now" (design §6.4): the save without the wait. Where the list stands after. */
export async function saveContactsNow(me: ContactsKeys): Promise<ContactsWhere> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return push(me, session);
}

/**
 * What signing out would lose (design §6.4): `none` (no list here), `saved` (the community holds this browser's latest
 * copy), `unsaved` (it doesn't yet: "Save now, then sign out"), `device-only` (this community keeps no list for this
 * member: the list is in this browser alone). Reads this browser's row; never asks the community.
 */
export async function contactsSignOutCheck(publicKey: string): Promise<'none' | 'saved' | 'unsaved' | 'device-only'> {
    let held: Held | null;
    try { held = await readHeld(publicKey.toLowerCase(), session); } catch { return 'none'; }
    if (!held) return 'none';
    const address = nodeAddress();
    if (held.at === address && held.refused) return 'device-only';
    return held.at === address && held.kept === held.seq ? 'saved' : 'unsaved';
}

/** The list as this browser keeps it, opened, without asking the community; null with none (or a newer app's). */
export async function heldContactsList(me: ContactsKeys): Promise<ContactsList | null> {
    try {
        const held = await readHeld(me.publicKey.toLowerCase(), session);
        return held ? openHeld(held, me).list : null;
    } catch {
        return null;
    }
}

/** A community's name as the screens say it: its host (this web app's community by default). */
export function contactsHost(address: string = nodeAddress()): string {
    try { return new URL(address).host; } catch { return address; }
}

/** The list saved by the browser as a contacts file (design §3.9): not locked, which the screen said first. */
export function saveContactsFile(list: ContactsList): void {
    const url = URL.createObjectURL(new Blob([writeContactsVcard(list.contacts)], { type: 'text/vcard' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts.vcf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The "Your contacts are back" line has been seen. */
export function clearContactsRestored(): void {
    if (snapshot.restored !== null) publish({ restored: null });
}

/**
 * Sign Out, and the delete at the last community: this browser's row goes with the database, and nothing under way puts
 * it back. Never throws.
 */
export async function clearContactsStore(): Promise<void> {
    leave();
    const held = dbPromise;
    dbPromise = null;
    try { (await held)?.close(); } catch { /* not open */ }
    await new Promise<void>((resolve) => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.deleteDatabase !== 'function') return resolve();
            const timer = setTimeout(resolve, 2_000);
            const done = () => { clearTimeout(timer); resolve(); };
            const req = indexedDB.deleteDatabase(DB_NAME);
            req.onsuccess = done;
            req.onerror = done;
            (req as IDBOpenDBRequest & { onblocked: unknown }).onblocked = done;
        } catch {
            resolve();
        }
    });
}

/** Tests only: forget the open database, the wait, the snapshot and the work under way, as a new page load would. */
export function resetContactsStoreForTest(): void {
    session += 1;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dbPromise = null;
    opening = null;
    snapshot = IDLE;
}
