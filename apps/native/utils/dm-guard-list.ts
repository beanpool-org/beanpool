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
 *
 * The member's way out of an unreadable list (§3.4 amendment 8, DESIGN-dm-guard-reset-fable.md): the same Settings →
 * Account → Chat memory reset as the pins', never the phone's own. The raw value is set aside, a marker
 * `{ reset: <date>, keep: [...] }` takes its place (the ids the pins keep anything for, read before the pins go, then the
 * salvage of the raw value's own ids), and the next read seeds `keep` first, then the file's `dm` rows, in one write.
 */

import { dmConversationsSeenStoreKey, dmConversationsSeenSetAsideStoreKey } from './storage-keys';
import { DM_PIN_ID_MAX } from './dm-peer-pins';

export interface SeenStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** Only the member's reset removes a value (one storage can't return). */
    removeItem?(key: string): Promise<void>;
}

/** The longest id, after folding, the list remembers: the pins' cap (honest ids are 36-character UUIDs). */
export const DM_SEEN_ID_MAX = DM_PIN_ID_MAX;

/** The most one file's list may take as UTF-8, at every write: Android reads a value through a window of about 2 MiB. */
export const DM_SEEN_MAX_BYTES = 1024 * 1024;

/**
 * The one line a send refused while this community's list can't be read says (§3.4 amendment 7 §3 iii), and where the way
 * out is (amendment 8: the member's reset, the pins' twin).
 */
export const DM_GUARD_UNREAD_TEXT = "This phone couldn't read which chats here are private, so nothing was sent. Try again; if it keeps failing, Settings → Account → Chat memory can reset this community's, which re-checks every chat here from the start.";

/**
 * Settings → Account → Chat memory's words once its reset takes this list too (§3.4 amendment 8 §3), word for word: the
 * row's subtitle, the card's body, and the confirmation, which states both residuals. #1873's card (chat-memory.ts
 * CHAT_MEMORY_COPY.rowSub, body, confirm) takes them from here.
 */
export const CHAT_MEMORY_RESET_WORDS = {
    rowSub: 'Who your chats are with, and which are private.',
    body: "This phone remembers who each of your chats in a community is with, and which chats there are private, so the community can't quietly swap the person behind a chat or turn a private chat into a group one. If this phone can't read that memory, chats in that community can't send. Resetting it re-checks every chat there from the start.",
    confirm: "A chat that was paused because its key changed may open with the new key. A private chat you never sent in may come back as a group chat the community can read. Check the key code, or who's in a chat, before you send.",
} as const;

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

/** The member's reset's marker in the list's place (§3.4 amendment 8 §2): `reset` a 24-character ISO date, `keep` the ids seeded first. */
function seenResetMarkOf(v: unknown): { reset: string; keep: string[] } | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length !== 2 || typeof o.reset !== 'string' || !Array.isArray(o.keep)) return null;
    if (o.reset.length !== 24 || Number.isNaN(Date.parse(o.reset)) || new Date(o.reset).toISOString() !== o.reset) return null;
    return { reset: o.reset, keep: [...new Set(o.keep.filter(isRememberableId))] };
}

/**
 * One file's list as stored: `list`, its ids; `list: null` when nothing is stored (not seeded yet), or the reset's marker
 * is (unseeded after the member's reset: `keep`, the ids its seed takes first). DmGuardUnreadError when storage can't be
 * read or holds anything else. An entry that isn't an id the list remembers is passed over.
 */
async function readStoredSeen(storage: Pick<SeenStorage, 'getItem'>, myPubkey: string, file: string): Promise<{ list: string[] | null; keep?: string[] }> {
    let raw: string | null;
    try {
        raw = await storage.getItem(dmConversationsSeenStoreKey(myPubkey, file));
    } catch {
        throw new DmGuardUnreadError();
    }
    if (raw == null) return { list: null };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new DmGuardUnreadError();
    }
    if (Array.isArray(parsed)) return { list: [...new Set(parsed.filter(isRememberableId))] };
    const mark = seenResetMarkOf(parsed);
    if (mark) return { list: null, keep: mark.keep };
    throw new DmGuardUnreadError();
}

/** One file's list as stored: its ids, or null while unseeded (nothing stored, or the reset's marker). DmGuardUnreadError: see {@link readStoredSeen}. */
export async function readDmSeen(storage: Pick<SeenStorage, 'getItem'>, myPubkey: string, file: string): Promise<string[] | null> {
    return (await readStoredSeen(storage, myPubkey, file)).list;
}

/**
 * Each JSON string literal in `raw` that parses, in order, that the list may remember: what the reset salvages of a value
 * it can't read as a list (the phone's own earlier writes; it can only add DM-ness, never take it away). Only a literal
 * that stands as an array element (after `[` or `,`, before `,`, `]` or the end) counts, so one damaged literal costs
 * itself, never the quotes after it paired the wrong way round.
 */
export function salvageSeenIds(raw: string): string[] {
    const out: string[] = [];
    // Any literal, its escapes included; JSON.parse then refuses one with a damaged byte (a raw control character, a bad escape).
    for (const m of raw.matchAll(/[[,]\s*("(?:[^"\\]|\\.)*")(?=\s*(?:[,\]]|$))/g)) {
        try {
            const id = JSON.parse(m[1]);
            if (isRememberableId(id)) out.push(id);
        } catch {}
    }
    return out;
}

/**
 * `seen` with each of `ids` it can take added after it: never an id over {@link DM_SEEN_ID_MAX}, and a new one only while
 * the value stays within {@link DM_SEEN_MAX_BYTES} (`refused`: those that didn't fit). Nothing in `seen` is ever dropped.
 */
export function withSeen(seen: readonly string[], ids: Iterable<string>, maxBytes = DM_SEEN_MAX_BYTES): { list: string[]; added: number; refused: string[] } {
    const have = new Set(seen);
    const list = [...have];
    let bytes = utf8Bytes(JSON.stringify(list));
    let added = 0;
    const refused: string[] = [];
    for (const id of ids) {
        if (!isRememberableId(id) || have.has(id)) continue;
        const more = utf8Bytes(JSON.stringify(id)) + (list.length ? 1 : 0);
        if (bytes + more > maxBytes) {
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

/** What the member's reset did with the list's value it replaced (§3.4 amendment 8, the pins' {@link DmPinsReset} twin). */
export type DmSeenReset = 'set-aside' | 'nothing-stored' | 'unreadable-removed';

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
    /**
     * The member's reset of `file`'s list (§3.4 amendment 8), never the phone's own, in the file's turn: the raw value is
     * copied aside when storage returns it (a corrupt one reads as a string; a marker has nothing to keep), a value storage
     * can't return is removed and logged, and the marker `{ reset, keep }` takes its place: `pinIds` (the ids the pins keep
     * anything for, read before they go; null when they can't be read) then the raw value's own ids, within the cap. A
     * marker that can't be written throws (the reset failed). The next read seeds `keep`, then the file's rows.
     */
    reset(myPubkey: string, file: string, pinIds: readonly string[] | null): Promise<DmSeenReset>;
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
        const stored = await readStoredSeen(storage, myPubkey, file);
        if (stored.list) return stored.list;
        let rows: string[];
        try {
            rows = await seedIds();
        } catch {
            throw new DmGuardUnreadError();
        }
        // After the member's reset, its `keep` first (the pins' ids, the salvage), then the rows; one write replaces the
        // marker, and a write that fails leaves it, so the next read seeds again.
        const { list, refused } = withSeen([], [...(stored.keep ?? []), ...rows]);
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
    async function reset(myPubkey: string, file: string, pinIds: readonly string[] | null): Promise<DmSeenReset> {
        const key = dmConversationsSeenStoreKey(myPubkey, file);
        return inTurn(key, async () => {
            let raw: string | null = null;
            let readable = true;
            try {
                raw = await storage.getItem(key);
            } catch (e) {
                readable = false;
                console.warn('[DM guard] The list being reset could not be read, so none of it is set aside', e);
            }
            let mark: { reset: string; keep: string[] } | null = null;
            try { mark = raw == null ? null : seenResetMarkOf(JSON.parse(raw)); } catch {}
            if (raw != null && !mark) {
                try {
                    await storage.setItem(dmConversationsSeenSetAsideStoreKey(myPubkey, file), raw);
                } catch (e) {
                    console.warn('[DM guard] The list being reset could not be set aside', e);
                }
            }
            if (pinIds === null) console.warn('[DM guard] The DM pins could not be read at the reset, so none of their chats is kept first');
            const salvage = mark ? mark.keep : raw != null ? salvageSeenIds(raw) : [];
            const date = new Date().toISOString();
            const { list: keep, refused } = withSeen([], [...(pinIds ?? []), ...salvage], DM_SEEN_MAX_BYTES - MARK_BYTES);
            if (refused.length) console.warn(`[DM guard] ${refused.length} chat(s) couldn't be kept at the reset: the list is full`);
            if (!readable) {
                if (!storage.removeItem) throw new DmGuardUnreadError();
                await storage.removeItem(key);
            }
            try {
                await storage.setItem(key, JSON.stringify({ reset: date, keep }));
            } catch (e) {
                console.warn('[DM guard] The list reset could not be recorded', e);
                throw e;
            }
            return !readable ? 'unreadable-removed' : raw != null && !mark ? 'set-aside' : 'nothing-stored';
        });
    }
    return { read, remember, reset };
}

/** The marker's bytes beside its `keep` list: `{"reset":"<24>","keep":` and `}`. */
const MARK_BYTES = JSON.stringify({ reset: new Date(0).toISOString(), keep: [] }).length - 2;
