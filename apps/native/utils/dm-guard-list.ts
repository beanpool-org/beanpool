/**
 * The DM guard's list (§3.4 amendment 7 §3): the conversations this phone has seen as DMs in one community file, so the
 * node retyping one as a group's, an event's or an enterprise's chat (node-readable by design) can't make the phone show its
 * lines as members' words or send its next line readable. db.ts asks the DM pins (utils/dm-peer-pins.ts) first; this list
 * is the second memory, for a DM met but not pinned.
 *
 * One value per (account, community file), `beanpool_dm_conversations_seen:<my key>:<file>` → [ids as the node spelt them],
 * seeded once from that file's own `type = 'dm'` rows at its first read (its presence is the record; a seed whose write
 * fails is read again from the rows next time). Main's one list for every community is retired unshipped: one community's
 * node could grow it past Android's read window, and every read then came back empty and was written over (confirmation 5,
 * GD1). Every way a node grows it is capped, none it can lift: an id over {@link DM_SEEN_ID_MAX} characters after folding is
 * never remembered (it has no entry of any kind here), and the value is kept to {@link DM_SEEN_MAX_BYTES} as UTF-8 at every
 * write. At the cap a new id is refused and logged, never a stored one dropped, and every write is a superset of what was
 * read. A value that can't be read or parsed is UNREADABLE ({@link DmGuardUnreadError}), never empty: nothing is written
 * over it, and db.ts then writes no type of the node's and sends no readable line where the list would decide.
 */

import { dmConversationsSeenStoreKey } from './storage-keys';
import { DM_PIN_ID_MAX } from './dm-peer-pins';

export interface SeenStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** The longest id, after folding, the list remembers: the pins' cap (honest ids are 36-character UUIDs). */
export const DM_SEEN_ID_MAX = DM_PIN_ID_MAX;

/** The most one file's list may take as UTF-8, at every write: Android reads a value through a window of about 2 MiB. */
export const DM_SEEN_MAX_BYTES = 1024 * 1024;

/** The one line a send refused while this community's list can't be read says (§3.4 amendment 7 §3 iii). */
export const DM_GUARD_UNREAD_TEXT = "This phone couldn't read which chats here are private, so nothing was sent. Try again.";

export class DmGuardUnreadError extends Error {
    constructor() {
        super(DM_GUARD_UNREAD_TEXT);
        this.name = 'DmGuardUnreadError';
    }
}

export function isDmGuardUnreadError(e: unknown): e is DmGuardUnreadError {
    return e instanceof DmGuardUnreadError || (e as { name?: unknown } | null)?.name === 'DmGuardUnreadError';
}

/** True for an id the list may remember: a non-empty string of at most {@link DM_SEEN_ID_MAX} characters folded. */
export function isRememberableId(id: unknown): id is string {
    return typeof id === 'string' && id.length > 0 && id.toLowerCase().length <= DM_SEEN_ID_MAX;
}

/** UTF-8 bytes of a string, without building it. */
function utf8Bytes(value: string): number {
    let bytes = 0;
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

/**
 * One file's list as stored: its ids, or null when nothing is stored (not seeded yet). DmGuardUnreadError when storage
 * can't be read or holds something that isn't a list. An entry that isn't an id the list remembers is passed over.
 */
export async function readDmSeen(storage: Pick<SeenStorage, 'getItem'>, myPubkey: string, file: string): Promise<string[] | null> {
    let raw: string | null;
    try {
        raw = await storage.getItem(dmConversationsSeenStoreKey(myPubkey, file));
    } catch {
        throw new DmGuardUnreadError();
    }
    if (raw == null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new DmGuardUnreadError();
    }
    if (!Array.isArray(parsed)) throw new DmGuardUnreadError();
    return [...new Set(parsed.filter(isRememberableId))];
}

/**
 * `seen` with each of `ids` it can take added after it: never an id over {@link DM_SEEN_ID_MAX}, and a new one only while
 * the value stays within {@link DM_SEEN_MAX_BYTES} (`refused`: those that didn't fit). Nothing in `seen` is ever dropped.
 */
export function withSeen(seen: readonly string[], ids: Iterable<string>): { list: string[]; added: number; refused: string[] } {
    const have = new Set(seen);
    const list = [...have];
    let bytes = utf8Bytes(JSON.stringify(list));
    let added = 0;
    const refused: string[] = [];
    for (const id of ids) {
        if (!isRememberableId(id) || have.has(id)) continue;
        const more = utf8Bytes(JSON.stringify(id)) + (list.length ? 1 : 0);
        if (bytes + more > DM_SEEN_MAX_BYTES) {
            refused.push(id);
            continue;
        }
        have.add(id);
        list.push(id);
        bytes += more;
        added++;
    }
    return { list, added, refused };
}

/** Write one file's list; throws, with nothing written, when it is over {@link DM_SEEN_MAX_BYTES} as UTF-8. */
async function writeDmSeen(storage: Pick<SeenStorage, 'setItem'>, myPubkey: string, file: string, list: readonly string[]): Promise<void> {
    const value = JSON.stringify(list);
    if (utf8Bytes(value) > DM_SEEN_MAX_BYTES) throw new Error('DM guard list over its cap');
    await storage.setItem(dmConversationsSeenStoreKey(myPubkey, file), value);
}

/**
 * One account's list in one community file, read from storage at every ask (it is small, and a value changed behind the
 * app is met at once). Every write goes through one queue per (account, file) and is made over a read in that same turn,
 * so two writers never drop each other's ids. `seedIds`: that file's own `dm` rows, read through the handle the caller
 * holds; it is asked only while nothing is stored, and a seed that can't read them is unreadable, never empty.
 */
export interface DmSeenList {
    /** This account's list in `file`, seeded first when nothing is stored. DmGuardUnreadError when it can't be read. */
    read(myPubkey: string, file: string, seedIds: () => Promise<string[]>): Promise<string[]>;
    /** Remember `ids` in `file`'s list, over a read in the file's turn. DmGuardUnreadError, with nothing written, when it can't be read. */
    remember(myPubkey: string, file: string, ids: readonly string[], seedIds: () => Promise<string[]>): Promise<void>;
}

export function createDmSeenList(storage: SeenStorage): DmSeenList {
    const queues = new Map<string, Promise<unknown>>();
    function inTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
        const turn = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
        queues.set(key, turn);
        return turn;
    }
    /** In the file's turn: what is stored, or the seed from the file's rows (written once; read again if the write fails). */
    async function storedOrSeeded(myPubkey: string, file: string, seedIds: () => Promise<string[]>): Promise<string[]> {
        const stored = await readDmSeen(storage, myPubkey, file);
        if (stored) return stored;
        let rows: string[];
        try {
            rows = await seedIds();
        } catch {
            throw new DmGuardUnreadError();
        }
        const { list, refused } = withSeen([], rows);
        if (refused.length) console.warn(`[DM guard] ${refused.length} DM(s) held here couldn't be remembered: this community's list is full`);
        try {
            await writeDmSeen(storage, myPubkey, file, list);
        } catch (e) {
            console.warn('[DM guard] The DMs held here could not be kept; the next read seeds again', e);
        }
        return list;
    }
    async function read(myPubkey: string, file: string, seedIds: () => Promise<string[]>): Promise<string[]> {
        const stored = await readDmSeen(storage, myPubkey, file);
        if (stored) return stored;
        return inTurn(dmConversationsSeenStoreKey(myPubkey, file), () => storedOrSeeded(myPubkey, file, seedIds));
    }
    async function remember(myPubkey: string, file: string, ids: readonly string[], seedIds: () => Promise<string[]>): Promise<void> {
        await inTurn(dmConversationsSeenStoreKey(myPubkey, file), async () => {
            const seen = await storedOrSeeded(myPubkey, file, seedIds);
            const { list, added, refused } = withSeen(seen, ids);
            if (refused.length) console.warn(`[DM guard] ${refused.length} new DM(s) not remembered: this community's list is full`);
            if (added) await writeDmSeen(storage, myPubkey, file, list);
        });
    }
    return { read, remember };
}
