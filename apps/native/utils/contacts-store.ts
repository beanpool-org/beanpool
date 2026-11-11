/**
 * Private contacts on the phone: the member's list, kept here locked (scratch/fable-design/DESIGN-private-contacts-fable.md
 * §4.2, §4.5, §6.4, slice C2). The lock, the list and its merge are core's (contacts-crypto.ts, contacts-list.ts, slice C0),
 * used as they are; the sync with the member's communities is contacts-sync.ts.
 *
 * **What is kept.** One file per account (`<documents>/contacts/<public key>.json`), holding the same locked copy a
 * community keeps (`{ header, signature, nonce, sealed }`): a copied phone backup holds only locked bytes. It is opened
 * into memory when a screen asks for it. Nothing exists until the member adds a first contact: no file, no copy anywhere.
 * Beside it, in AsyncStorage under the account ({@link contactsSyncStoreKey}), what the phone knows of each community's copy.
 *
 * **Never saved over.** A file that can't be opened (damaged, or written by a newer app: core refuses that list whole) is
 * `unreadable`, and nothing here writes over it: the member's communities still keep their copies.
 *
 * **A number never used twice.** Each copy carries a number its communities only take when it is newer. A change re-locks
 * the list under the number the file has while that number has never left the phone; once one has (a save was sent with
 * it), the next change takes a new one, above every number this phone sent or merged ({@link nextSeq}). Only those: a
 * community's word for its number (GET /api/me/unread, a 409) is signed by nobody, and a huge one taken as true would put
 * every later number past core's cap, so that no change could be saved again.
 *
 * **What the sync may trust** (`merged`). For each community, the number of the copy there whose people this phone has
 * merged in, or put there itself. A community holding exactly that number holds nothing this phone lacks, so only then may
 * a save overwrite it. The file and that record are checked together: a file that is gone, or not the one the record was
 * written beside, clears `merged`, and every community is looked at again before anything is saved over it.
 *
 * **Sign out** keeps the file and the record under the account, as its block list is kept (§6.4): nobody else on the
 * phone can open the file, and the account finds its list here again.
 *
 * Every change for an account goes through one queue, so two screens' changes never cross.
 */
import {
    contactsCopyWire, dropOldContactMarkers, emptyContactsList, makeContactsCopy, mergeContactsLists, openContactsCopy,
    readContactsCopy, readContactsList, writeContactsList, type ContactsCopyWire, type ContactsList,
} from '@beanpool/core';

// The parts of core the shared vectors exercise (@beanpool/core/contacts-vectors), handed in from here by the phone's run
// (utils/__tests__/contacts-vectors.test.ts): what this store locks and opens with.
export {
    contactsKey, writeContactsList, makeContactsCopy, readContactsCopy, openContactsCopy, sealContactsBox, openContactsBox,
} from '@beanpool/core';

/** The member's keys, as identity.ts keeps them (the bare seed in hex). */
export interface ContactsAccount {
    publicKey: string;
    privateKey: string;
}

/** Where the locked file lives: read, and written whole. Tests pass a map. */
export interface ContactsDisk {
    /** The file's text, or null when there is none. Throws when it is there and can't be read. */
    read(publicKey: string): Promise<string | null>;
    write(publicKey: string, text: string): Promise<void>;
}

export interface ContactsKv {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** What the phone holds for an account. */
export type ContactsOnPhone =
    | { kind: 'none' }
    | { kind: 'list'; list: ContactsList; seq: number; copy: ContactsCopyWire }
    | { kind: 'unreadable'; reason: 'damaged' | 'newer' };

/**
 * Why a community isn't asked again for a while: it keeps no lists, its server is full, too many saves this hour, it holds a
 * list a newer app wrote, the account isn't a member there, it handed back a copy that doesn't open with the member's key,
 * or its copy and the phone's together are more than one copy can hold (the member removes people; the screen says so).
 */
export type ContactsRefusal = 'contacts_off' | 'node_full' | 'too_many_saves' | 'newer' | 'not_a_member' | 'unopened' | 'too_big';

/** What the phone knows of the account's copies (design §4.5), kept beside the file. */
export interface ContactsSyncState {
    /** The number of the file this was written beside: a file without it lost what `merged` says. 0 for no file. */
    fileSeq: number;
    /** The highest number that has left this phone: never used again. */
    sentSeq: number;
    /** When the member's latest change may first leave the phone (ms); null when nothing waits. */
    dueAt: number | null;
    /** Per community: the number it last said it keeps (null: none). */
    heard: Record<string, number | null>;
    /** Per community: the number of its copy whose people this phone has merged in or put there. */
    merged: Record<string, number>;
    /** Per community: a refusal, and when it may be asked again (ms). */
    refused: Record<string, { code: ContactsRefusal; until: number }>;
    /** When a community last took this phone's latest copy (ms). */
    savedAt: number | null;
    /** How many people came back to a phone that held no list (design §4.5), until the member has seen it said. */
    back: number | null;
}

const SYNC_PREFIX = 'beanpool_contacts:sync:';
const HINT_PREFIX = 'beanpool_contacts:hint:';
/** The record of `publicKey`'s copies. Kept when the account leaves the phone, as its file is. */
export function contactsSyncStoreKey(publicKey: string): string {
    return `${SYNC_PREFIX}${publicKey.toLowerCase()}`;
}
/** Whether the Chat tab's one-time line was used or closed for `publicKey` (design §3.1). */
export function contactsHintStoreKey(publicKey: string): string {
    return `${HINT_PREFIX}${publicKey.toLowerCase()}`;
}

export function emptySyncState(): ContactsSyncState {
    return { fileSeq: 0, sentSeq: 0, dueAt: null, heard: {}, merged: {}, refused: {}, savedAt: null, back: null };
}

const isSeq = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
const isMs = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const REFUSALS: readonly ContactsRefusal[] = ['contacts_off', 'node_full', 'too_many_saves', 'newer', 'not_a_member', 'unopened', 'too_big'];

/** A record as stored, never trusted: what doesn't read is left out (the worst of it is one more look at a community). */
export function readSyncState(raw: string | null): ContactsSyncState {
    const s = emptySyncState();
    let p: Record<string, unknown>;
    try {
        const parsed = JSON.parse(raw ?? 'null');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return s;
        p = parsed as Record<string, unknown>;
    } catch {
        return s;
    }
    if (isMs(p.fileSeq)) s.fileSeq = p.fileSeq;
    if (isMs(p.sentSeq)) s.sentSeq = p.sentSeq;
    if (isMs(p.dueAt)) s.dueAt = p.dueAt;
    if (isMs(p.savedAt)) s.savedAt = p.savedAt;
    if (isMs(p.back)) s.back = p.back;
    const heard = p.heard && typeof p.heard === 'object' ? p.heard as Record<string, unknown> : {};
    for (const [c, n] of Object.entries(heard)) if (n === null || isSeq(n)) s.heard[c] = n;
    const merged = p.merged && typeof p.merged === 'object' ? p.merged as Record<string, unknown> : {};
    for (const [c, n] of Object.entries(merged)) if (isSeq(n)) s.merged[c] = n;
    const refused = p.refused && typeof p.refused === 'object' ? p.refused as Record<string, unknown> : {};
    for (const [c, r] of Object.entries(refused)) {
        const { code, until } = (r ?? {}) as { code?: unknown; until?: unknown };
        if (REFUSALS.includes(code as ContactsRefusal) && isMs(until)) s.refused[c] = { code: code as ContactsRefusal, until };
    }
    return s;
}

/** The phone's own disk: one file per account under the app's documents, written through a side file so a stop never leaves half of one. */
export function phoneContactsDisk(): ContactsDisk {
    const fs = require('expo-file-system/legacy') as {
        documentDirectory: string | null;
        readAsStringAsync(uri: string): Promise<string>;
        writeAsStringAsync(uri: string, text: string): Promise<void>;
        getInfoAsync(uri: string): Promise<{ exists: boolean }>;
        makeDirectoryAsync(uri: string, o: { intermediates: boolean }): Promise<void>;
        deleteAsync(uri: string, o: { idempotent: boolean }): Promise<void>;
        moveAsync(o: { from: string; to: string }): Promise<void>;
    };
    const folder = () => {
        if (!fs.documentDirectory) throw new Error('This phone has no documents folder for the contacts list.');
        return `${fs.documentDirectory.replace(/\/?$/, '/')}contacts/`;
    };
    const fileOf = (pk: string) => `${folder()}${pk.toLowerCase()}.json`;
    return {
        async read(pk) {
            const file = fileOf(pk);
            // A write stopped between taking the old file away and putting the new one in leaves only the side file.
            for (const f of [file, `${file}.new`]) if ((await fs.getInfoAsync(f)).exists) return fs.readAsStringAsync(f);
            return null;
        },
        async write(pk, text) {
            const file = fileOf(pk);
            await fs.makeDirectoryAsync(folder(), { intermediates: true }).catch(() => {});
            await fs.writeAsStringAsync(`${file}.new`, text);
            await fs.deleteAsync(file, { idempotent: true });
            await fs.moveAsync({ from: `${file}.new`, to: file });
        },
    };
}

export interface ContactsStoreDeps {
    disk: ContactsDisk;
    kv: ContactsKv;
    now?: () => number;
}

/** The phone's own store: its disk and AsyncStorage. Loaded when first used, so tests and other modules don't load Expo. */
export function phoneContactsDeps(): ContactsStoreDeps {
    const kv = require('@react-native-async-storage/async-storage').default as ContactsKv;
    return { disk: phoneContactsDisk(), kv };
}

/** The file's copy opened for `account`. Never throws. */
export async function readOnPhone(account: ContactsAccount, disk: ContactsDisk): Promise<ContactsOnPhone> {
    let text: string | null;
    try {
        text = await disk.read(account.publicKey);
    } catch {
        return { kind: 'unreadable', reason: 'damaged' };
    }
    if (text === null) return { kind: 'none' };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { kind: 'unreadable', reason: 'damaged' }; }
    const opened = openContactsCopy(raw, account);
    if (!opened.ok) return { kind: 'unreadable', reason: 'damaged' };
    const read = readContactsList(opened.json);
    if (!read.ok) return { kind: 'unreadable', reason: read.reason === 'newer' ? 'newer' : 'damaged' };
    return { kind: 'list', list: read.list, seq: opened.copy.seq, copy: contactsCopyWire(opened.copy) };
}

/** The record beside the file. A file that isn't the one it was written beside clears what was merged (see the header). */
export async function readStateFor(account: ContactsAccount, kv: ContactsKv, onPhone: ContactsOnPhone): Promise<ContactsSyncState> {
    const s = readSyncState(await kv.getItem(contactsSyncStoreKey(account.publicKey)).catch(() => null));
    const seq = onPhone.kind === 'list' ? onPhone.seq : 0;
    if (onPhone.kind !== 'unreadable' && s.fileSeq !== seq) {
        s.merged = {};
        s.fileSeq = seq;
    }
    return s;
}

export function writeState(account: ContactsAccount, kv: ContactsKv, s: ContactsSyncState): Promise<void> {
    return kv.setItem(contactsSyncStoreKey(account.publicKey), JSON.stringify(s));
}

/**
 * The number a changed list is locked under: the file's while it has never left the phone, else past every one this phone
 * sent or merged (copies it opened, signed by the member; never a number a community only said).
 */
export function nextSeq(fileSeq: number, s: Pick<ContactsSyncState, 'sentSeq' | 'merged'>): number {
    const known = Math.max(0, ...Object.values(s.merged));
    if (fileSeq > s.sentSeq && fileSeq > known) return fileSeq;
    return Math.max(fileSeq, s.sentSeq, known) + 1;
}

/** Two lists in their canonical JSON: the same here, they hold the same contacts and the same removal markers. */
const sameList = (a: ContactsList, b: ContactsList) => writeContactsList(a) === writeContactsList(b);

// ── The queue ───────────────────────────────────────────────────────────────────────────────────────────────────────

const turns = new Map<string, Promise<unknown>>();
/** One turn at a time per account: every read-change-write of the file and its record. */
export function inTurn<T>(publicKey: string, job: () => Promise<T>): Promise<T> {
    const key = publicKey.toLowerCase();
    const run = (turns.get(key) ?? Promise.resolve()).then(job, job);
    turns.set(key, run.catch(() => {}));
    return run;
}

type Listener = (publicKey: string) => void;
const listeners = new Set<Listener>();
/** Called after the list or its record changes for an account. Returns the way to stop listening. */
export function onContactsChanged(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function told(publicKey: string): void {
    for (const l of [...listeners]) {
        try { l(publicKey); } catch (e) { console.warn('[Contacts] A listener failed', e); }
    }
}
/** Tell the screens the record changed (contacts-sync.ts, after a save or a refusal). */
export function contactsRecordChanged(publicKey: string): void {
    told(publicKey);
}

/** Lock `list` as `account`'s under `seq`, write the file, then its record. */
async function writeList(account: ContactsAccount, deps: ContactsStoreDeps, list: ContactsList, seq: number, s: ContactsSyncState): Promise<ContactsCopyWire> {
    const copy = makeContactsCopy({ json: writeContactsList(list), me: account, seq });
    const wire = contactsCopyWire(copy);
    await deps.disk.write(account.publicKey, JSON.stringify(wire));
    s.fileSeq = seq;
    await writeState(account, deps.kv, s);
    return wire;
}

/** The waits design §4.5 gives a change before it leaves the phone: a random 2 to 15 minutes. */
export const CONTACTS_SAVE_WAIT_MS = { min: 2 * 60 * 1000, max: 15 * 60 * 1000 } as const;
export function saveWait(random: () => number = Math.random): number {
    const { min, max } = CONTACTS_SAVE_WAIT_MS;
    return Math.floor(min + random() * (max - min));
}

export class ContactsUnreadableError extends Error {
    constructor(readonly reason: 'damaged' | 'newer') {
        super(reason === 'newer' ? 'The contacts list here was saved by a newer BeanPool.' : 'The contacts list on this phone can’t be opened.');
        this.name = 'ContactsUnreadableError';
    }
}

/**
 * The member's change: `change` gets the list (empty when there is none yet) and returns the next. Written locked at once,
 * and due to leave the phone after the wait: the first change since the last save sets it, and later ones join it while it
 * runs. A change after it ran out (a save still on its way, or none possible offline) starts a fresh one, so no change ever
 * leaves the phone straight after it was made. Returns the list as kept. A list that can't be opened is never written
 * over: throws {@link ContactsUnreadableError}.
 */
export function changeContacts(
    account: ContactsAccount, change: (list: ContactsList) => ContactsList, deps: ContactsStoreDeps = phoneContactsDeps(),
    random: () => number = Math.random,
): Promise<ContactsList> {
    return inTurn(account.publicKey, async () => {
        const now = (deps.now ?? Date.now)();
        const onPhone = await readOnPhone(account, deps.disk);
        if (onPhone.kind === 'unreadable') throw new ContactsUnreadableError(onPhone.reason);
        const s = await readStateFor(account, deps.kv, onPhone);
        const before = onPhone.kind === 'list' ? onPhone.list : emptyContactsList();
        const next = dropOldContactMarkers(change(before), new Date(now));
        if (onPhone.kind === 'list' && sameList(before, next)) return before;
        // Nothing exists until a first contact: a change that leaves nobody and no marker writes no file.
        if (onPhone.kind === 'none' && next.contacts.length === 0 && next.removed.length === 0) return before;
        if (s.dueAt === null || s.dueAt <= now) s.dueAt = now + saveWait(random);
        await writeList(account, deps, next, nextSeq(onPhone.kind === 'list' ? onPhone.seq : 0, s), s);
        told(account.publicKey);
        return next;
    });
}

/** What taking in a community's copy did. */
export type TakeIn =
    | { kind: 'merged'; changed: boolean; seq: number; back: number | null }
    | { kind: 'unopened'; seq: number | null }
    | { kind: 'newer'; seq: number };

/**
 * A copy fetched from `community` taken in (design §4.5): opened with the member's key, merged with the phone's list, and
 * the result kept here when it differs. `merged` then names the copy's number for that community. When the copy holds
 * everything the phone does, under a newer number, it becomes the phone's file as it is (so that community holds exactly
 * the phone's copy); when the phone holds something it lacks, the merge is locked under a number past it, to be saved there.
 * A copy that doesn't open (another member's, damaged, forged) adds nobody and that community is left alone for a day: it
 * isn't fetched again each pass. One a newer app wrote is left alone too. A phone that held no list notes how many came back.
 */
export function takeInCopy(account: ContactsAccount, community: string, raw: unknown, deps: ContactsStoreDeps = phoneContactsDeps()): Promise<TakeIn> {
    return inTurn(account.publicKey, async () => {
        const onPhone = await readOnPhone(account, deps.disk);
        const s = await readStateFor(account, deps.kv, onPhone);
        const opened = openContactsCopy(raw, account);
        const day = (deps.now ?? Date.now)() + 24 * 60 * 60 * 1000;
        if (!opened.ok) {
            const header = readContactsCopy(raw);
            delete s.merged[community];
            s.refused[community] = { code: 'unopened', until: day };
            await writeState(account, deps.kv, s);
            return { kind: 'unopened', seq: header.ok ? header.copy.seq : null };
        }
        const theirs = readContactsList(opened.json);
        const seq = opened.copy.seq;
        s.heard[community] = seq;
        if (!theirs.ok) {
            delete s.merged[community];
            s.refused[community] = { code: theirs.reason === 'newer' ? 'newer' : 'unopened', until: day };
            await writeState(account, deps.kv, s);
            return theirs.reason === 'newer' ? { kind: 'newer', seq } : { kind: 'unopened', seq };
        }
        if (onPhone.kind === 'unreadable') {
            // The phone's own file can't be opened: never written over, so nothing is merged into it either.
            await writeState(account, deps.kv, s);
            return { kind: 'merged', changed: false, seq, back: null };
        }
        s.merged[community] = seq;
        delete s.refused[community];
        const mine = onPhone.kind === 'list' ? onPhone.list : emptyContactsList();
        const both = mergeContactsLists(mine, theirs.list);
        const fileSeq = onPhone.kind === 'list' ? onPhone.seq : 0;
        // Nothing of the phone's is missing from their copy / nothing of theirs is missing from the phone's.
        const theyHaveAll = sameList(both, theirs.list);
        const weHaveAll = onPhone.kind === 'list' && sameList(both, mine);
        let back: number | null = null;
        if (onPhone.kind === 'none') {
            back = both.contacts.length;
            s.back = back > 0 ? back : null;
        }
        let changed = false;
        if (theyHaveAll && seq > fileSeq && seq > s.sentSeq) {
            // Their copy is the phone's list under a newer number: kept as it is, so that community holds exactly the phone's.
            await deps.disk.write(account.publicKey, JSON.stringify(contactsCopyWire(opened.copy)));
            s.fileSeq = seq;
            await writeState(account, deps.kv, s);
            changed = true;
        } else if (!weHaveAll || (!theyHaveAll && fileSeq <= seq)) {
            // Both lists made one, under a number past theirs, so it can be saved there.
            await writeList(account, deps, both, nextSeq(fileSeq, s), s);
            changed = true;
        } else {
            await writeState(account, deps.kv, s);
        }
        if (changed) told(account.publicKey);
        return { kind: 'merged', changed, seq, back };
    });
}

/** The account's list as the screens show it, with its record. Never throws. */
export async function loadContacts(account: ContactsAccount, deps: ContactsStoreDeps = phoneContactsDeps()): Promise<{ onPhone: ContactsOnPhone; state: ContactsSyncState }> {
    return inTurn(account.publicKey, async () => {
        const onPhone = await readOnPhone(account, deps.disk);
        return { onPhone, state: await readStateFor(account, deps.kv, onPhone) };
    });
}

/** "Your contacts are back" said: the line goes. */
export function backLineSeen(account: ContactsAccount, deps: ContactsStoreDeps = phoneContactsDeps()): Promise<void> {
    return inTurn(account.publicKey, async () => {
        const onPhone = await readOnPhone(account, deps.disk);
        const s = await readStateFor(account, deps.kv, onPhone);
        if (s.back === null) return;
        s.back = null;
        await writeState(account, deps.kv, s);
        told(account.publicKey);
    });
}
