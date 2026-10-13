/**
 * What a by-area sync read sends of a member's set (`nearby=1`, routes/marketplace.ts) when it changed: only what changed,
 * against a set this node sent that member before (scratch/global-node/DESIGN-nearby-set-diff-fable.md). At a busy town
 * the set is ~500 ids, ~11 KB of UUIDs gzipped, and a delta of a few rows whose set moved named all of them again
 * (REPORT-geosync-load-B: 11.8-15.5 KB against 10 KB). Now it names the ids that came in and went.
 *
 * The node keeps, in memory only, the sets it named by hash (one entry per distinct set, so the members of one town who
 * hold the same set share it) and, per reader, the last NEARBY_SET_HASHES_PER_READER hashes it named or confirmed to
 * them. A diff is answered only against a hash on the caller's own list: an entry carries no reader and is reachable
 * only through one, so someone else's hash is "unknown" and answered with the caller's own whole set. Everything else
 * (an unknown or evicted hash, the memory off, a diff no smaller than the set) is answered whole, as before.
 *
 * Correctness never rests on the memory: an entry under a hash is the set that hashed to it, and the phone writes an
 * applied diff only where the result hashes to the `setHash` beside it (apps/native utils/posts-nearby.ts nearbyLastSet).
 * So nothing here is invalidated by a write, an import or a restart; a restart empties it, and each phone's next changed
 * set is named whole once.
 */
import crypto from 'node:crypto';

/** The hash a phone sends back (`setHash`): 24 lowercase hex, as nearbySetHash makes it. Anything else is none. */
export const NEARBY_SET_HASH_RE = /^[0-9a-f]{24}$/;
/** The hashes a reader's list holds: a read cut short on the phone leaves it the hash before, and one account may run two phones. */
export const NEARBY_SET_HASHES_PER_READER = 4;
const NEARBY_SET_MEMORY_MB_DEFAULT = 32;
const NEARBY_SET_MEMORY_MB_MAX = 4096;
const NEARBY_SET_ENTRIES_MAX = 20_000;
const NEARBY_SET_READERS_MAX = 20_000;
/** What an entry costs beyond its ids, as the budget counts it (the Map slot, the key, the entry, two arrays). */
const ENTRY_OVERHEAD_BYTES = 128;

/** UTF-16 code-unit order, the same on V8 and Hermes (never localeCompare): the phone sorts with the same comparator. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (ids: readonly string[]) => [...new Set(ids)].sort(byCodeUnit);
const hashOfCanonical = (ids: readonly string[], tied: readonly string[]) =>
    crypto.createHash('sha256').update(JSON.stringify([ids, tied]), 'utf8').digest('hex').slice(0, 24);

/**
 * A member's set's hash, `tied` included (a deal opened on a listing already in the set moves no id, and the phone must
 * still learn the tie), of the ids as sets, not in their order (a listing in it moving a little nearer changes no member
 * of it). JSON, not a join: a client-minted id may hold a comma or a newline, and the phone verifies an applied diff by
 * this hash, so the form must be injective. The phone computes the same (apps/native utils/nearby-hash.ts); a pinned
 * vector in both suites holds them together.
 */
export function nearbySetHash(ids: readonly string[], tied: readonly string[]): string {
    return hashOfCanonical(canonical(ids), canonical(tied));
}

// A canonical UUID, lowercase as crypto.randomUUID mints one (engine/posts.ts): packed in 16 bytes, unpacked exactly.
// Any other id (a client may send its own) is kept as the string.
const PACKABLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Packed = Buffer | string[];

function pack(ids: readonly string[]): Packed {
    if (!ids.every(id => PACKABLE.test(id))) return [...ids];
    // Buffer.alloc, never allocUnsafe: a pooled slice would hold an 8 KB slab the budget doesn't count.
    const out = Buffer.alloc(ids.length * 16);
    ids.forEach((id, i) => out.write(id.replace(/-/g, ''), i * 16, 16, 'hex'));
    return out;
}

function unpack(p: Packed): string[] {
    if (Array.isArray(p)) return p;
    const hex = p.toString('hex');
    const out: string[] = new Array(p.length / 16);
    for (let i = 0; i < out.length; i++) {
        const h = hex.slice(i * 32, i * 32 + 32);
        out[i] = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    return out;
}

const sizeOf = (p: Packed) => (Array.isArray(p) ? p.reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0) : p.length);

interface Entry {
    /** The set's ids in the canonical order, packed. */
    ids: Packed;
    /** Its `tied`, the same way. */
    tied: Packed;
    bytes: number;
}

export interface NearbySetMemoryLimits {
    /** What the entries may hold in all, as `bytes` counts it; 0 turns the memory off (every changed set is answered whole). */
    budgetBytes: number;
    maxSets: number;
    maxReaders: number;
}

/** What a by-area read answers where the set goes, beside its `posts`. */
export type NearbySetAnswer =
    | { setUnchanged: string }
    | { setAdd: string[]; setDrop: string[]; setHash: string; tied?: string[] }
    | { set: string[]; setHash: string; tied: string[] };

export interface NearbySetMemoryHeld {
    sets: number;
    bytes: number;
    readers: number;
    answers: { whole: number; diff: number; unchanged: number; notModified: number };
    evictions: number;
}

/**
 * The diff of a set against one held: `setAdd`, the ids of `current` not held, in `current`'s order (nearest first, so
 * the phone's fetch of what it lacks stays nearest first), each once; `setDrop`, the held ids not in `current`.
 */
export function diffNearbySet(held: readonly string[], current: readonly string[]): { setAdd: string[]; setDrop: string[] } {
    const was = new Set(held);
    const now = new Set(current);
    const setAdd: string[] = [];
    const added = new Set<string>();
    for (const id of current) {
        if (was.has(id) || added.has(id)) continue;
        added.add(id);
        setAdd.push(id);
    }
    return { setAdd, setDrop: [...was].filter(id => !now.has(id)) };
}

export class NearbySetMemory {
    /** Sets by hash, oldest first (a touch is a delete and a set). */
    private readonly sets = new Map<string, Entry>();
    /** Per reader, the hashes named or confirmed to them, newest last, each once; readers oldest first. */
    private readonly sent = new Map<string, string[]>();
    private bytes = 0;
    private evictions = 0;
    private readonly answers = { whole: 0, diff: 0, unchanged: 0, notModified: 0 };

    constructor(private readonly limits: NearbySetMemoryLimits) {}

    get enabled(): boolean {
        return this.limits.budgetBytes > 0 && this.limits.maxSets > 0 && this.limits.maxReaders > 0;
    }

    /**
     * What a read answers where the set goes, for `reader`, whose current set is `current` (its ids nearest first, its
     * `tied`): `{ setUnchanged }` while the hash the phone sent (`ask.setHash`) is still the set's; with `ask.setDiff`, a
     * diff against that hash where it is on the reader's own list, still held here, and smaller than the set; else the
     * whole set. Every answer remembers the current set under its hash and puts that hash on the reader's list.
     */
    answer(reader: string, current: { ids: readonly string[]; tied: readonly string[] }, ask: { setHash?: unknown; setDiff?: boolean }): NearbySetAnswer {
        const ids = canonical(current.ids);
        const tied = canonical(current.tied);
        const hash = hashOfCanonical(ids, tied);
        const sentHash = typeof ask.setHash === 'string' && NEARBY_SET_HASH_RE.test(ask.setHash) ? ask.setHash : null;
        let out: NearbySetAnswer | null = null;
        if (sentHash === hash) {
            out = { setUnchanged: hash };
            this.answers.unchanged++;
        } else if (ask.setDiff && sentHash && this.enabled) {
            const entry = this.heldFor(reader, sentHash);
            if (entry) {
                const { setAdd, setDrop } = diffNearbySet(unpack(entry.ids), current.ids);
                if (setAdd.length + setDrop.length < ids.length) {
                    const heldTied = unpack(entry.tied);
                    const sameTied = heldTied.length === tied.length && heldTied.every((id, i) => id === tied[i]);
                    out = { setAdd, setDrop, setHash: hash, ...(sameTied ? {} : { tied: [...current.tied] }) };
                    this.answers.diff++;
                }
            }
        }
        if (!out) {
            out = { set: [...current.ids], setHash: hash, tied: [...current.tied] };
            this.answers.whole++;
        }
        this.remember(reader, hash, ids, tied);
        return out;
    }

    /** A 304 on a by-area read: the phone's set is current. The set is remembered and its hash put on the reader's list. */
    confirmed(reader: string, current: { ids: readonly string[]; tied: readonly string[] }): void {
        this.answers.notModified++;
        const ids = canonical(current.ids);
        const tied = canonical(current.tied);
        this.remember(reader, hashOfCanonical(ids, tied), ids, tied);
    }

    held(): NearbySetMemoryHeld {
        return { sets: this.sets.size, bytes: this.bytes, readers: this.sent.size, answers: { ...this.answers }, evictions: this.evictions };
    }

    /** The entry under `hash`, only where `hash` is on `reader`'s own list. */
    private heldFor(reader: string, hash: string): Entry | null {
        if (!this.sent.get(reader)?.includes(hash)) return null;
        return this.sets.get(hash) ?? null;
    }

    private remember(reader: string, hash: string, ids: readonly string[], tied: readonly string[]): void {
        if (!this.enabled) return;
        const had = this.sets.get(hash);
        if (had) {
            this.sets.delete(hash);
            this.sets.set(hash, had);
        } else {
            const entry: Entry = { ids: pack(ids), tied: pack(tied), bytes: 0 };
            entry.bytes = sizeOf(entry.ids) + sizeOf(entry.tied) + ENTRY_OVERHEAD_BYTES;
            this.sets.set(hash, entry);
            this.bytes += entry.bytes;
            while (this.sets.size > 0 && (this.bytes > this.limits.budgetBytes || this.sets.size > this.limits.maxSets)) {
                const [oldest, gone] = this.sets.entries().next().value as [string, Entry];
                this.sets.delete(oldest);
                this.bytes -= gone.bytes;
                this.evictions++;
            }
        }
        const list = (this.sent.get(reader) ?? []).filter(h => h !== hash);
        list.push(hash);
        if (list.length > NEARBY_SET_HASHES_PER_READER) list.splice(0, list.length - NEARBY_SET_HASHES_PER_READER);
        this.sent.delete(reader);
        this.sent.set(reader, list);
        while (this.sent.size > this.limits.maxReaders) this.sent.delete(this.sent.keys().next().value as string);
    }
}

/**
 * The memory's bounds: NEARBY_SET_MEMORY_MB (default 32; 0 turns it off, and every changed set is answered whole while
 * `setUnchanged` and the 304 keep working), at most 20,000 sets and 20,000 readers. Read once, at the first by-area
 * read, as config/node-profile.ts nearbyListingsLimits reads its own; a value out of range is the default.
 */
export function nearbySetMemoryLimits(): NearbySetMemoryLimits {
    const raw = process.env.NEARBY_SET_MEMORY_MB;
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    const mb = Number.isInteger(n) && n >= 0 && n <= NEARBY_SET_MEMORY_MB_MAX ? n : NEARBY_SET_MEMORY_MB_DEFAULT;
    return { budgetBytes: mb * 1024 * 1024, maxSets: NEARBY_SET_ENTRIES_MAX, maxReaders: NEARBY_SET_READERS_MAX };
}

let memory: NearbySetMemory | null = null;

/** The node's one memory of the sets it named. */
export function nearbySetMemory(): NearbySetMemory {
    return memory ??= new NearbySetMemory(nearbySetMemoryLimits());
}

/** What the memory holds and has answered, for the suites and the load harness's metrics line. */
export function nearbySetMemoryHeld(): NearbySetMemoryHeld {
    return nearbySetMemory().held();
}

/** A fresh memory (a restart, for the suites), with the env's bounds unless given others. */
export function resetNearbySetMemory(limits?: NearbySetMemoryLimits): NearbySetMemory {
    memory = new NearbySetMemory(limits ?? nearbySetMemoryLimits());
    return memory;
}
