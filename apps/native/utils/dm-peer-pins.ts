/**
 * Who each direct message is sealed to, as this phone decided it: the peer key pin (DESIGN-dm-peer-key-pin, slice 1).
 *
 * The node says who is in a DM, and the phone keeps that answer only in SQLite rows the node's own listing can clear: one
 * sync that leaves a DM out prunes it, and the next that lists it again with someone else in it wrote fresh rows, so the
 * next line went to whoever the node chose (#1863 review, T5). Now the phone keeps, per DM, the key it first sealed to
 * there, outside SQLite, where no writer of the conversation rows reaches: a wipe-and-fetch, a prune and a sync that
 * lists nothing all leave it alone. A line is sealed to the pinned key or to nobody.
 *
 * A pin is written only at first sight (the first clean two-party DM the phone meets under that id: the node's word, as
 * starting a DM from a post is today), by the member (slice 2's "Continue with the new key"), or by a handover the old
 * key signed (slice 4). Never by a sync, a push, a route or the prune. When the node lists the DM without the pinned key,
 * the other key is only `offered`: sends stop until the member decides, and a listing with the pinned key again clears it.
 *
 * One value per account and community file (§3.4 amendment 6), `beanpool_dm_peer_pins:<my key>:<file>` → { pins:
 * { conversation id lower-cased → pin } }; its presence is the record that the update's seed of that file ran (amendment
 * 5). Per file, so one community's node can neither grow another's value nor reach a pin or mark of another's; and every
 * way a node grows it is capped ({@link DM_PINS_MAX_BYTES}, {@link DM_PIN_ID_MAX}, {@link FORMER_MAX}, tryKeys, the
 * re-key date): at a cap the phone refuses a new entry, never drops one. Kept when the account leaves the phone, as its
 * block list is (Marty, 13 Oct, pick 2), and never read for another account's key. Ids are folded, as the held check and
 * the DM guard fold them, so a twin the node writes in other capitals is the same DM here.
 *
 * The storage is passed in. db.ts keeps one copy per (account, file) in memory for the app's run ({@link createDmPinBook}):
 * read from storage once, and every change goes through one queue that writes it through.
 */

import { dmPeerPinsStoreKey, dmPeerPinsSetAsideStoreKey } from './storage-keys';

export interface PinStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    /** Only the member's reset ({@link DmPinBook.reset}) removes a value. */
    removeItem?(key: string): Promise<void>;
}

/** The other key the node lists for a pinned DM, waiting for the member's word. Nothing is sealed to it until then. */
export interface DmPeerOffer {
    /** The key the node lists instead of the pinned one; null when it lists several others and none is pinned. */
    peer: string | null;
    /** When this phone first saw it listed (ISO). */
    at: string;
    /** What the node says happened (slice 3: a verified re-key date). Only ever wording for the banner. */
    nodeSays?: { rekeyedAt: string };
    /**
     * Offered by first sight on this thread's own lines (§3.4 amendment, rules 3-4: a restored phone, or a DM the update
     * met with two keys in its rows), not by a sync against a pin: the banner opens with the restored-phone sentence.
     */
    firstSight?: true;
}

export interface DmPeerPin {
    /** The key this DM's lines are sealed to, lower-case hex. */
    peer: string;
    /** When it was pinned (ISO). */
    since: string;
    by: 'first-seen' | 'member' | 'handover';
    /** Keys pinned here before, newest first: old lines still open under them (pick 3). */
    former?: string[];
    offered?: DmPeerOffer;
    /**
     * A first-seen pin's verdict (design §3.4 amendment): true once the thread's own lines placed it (history decides the
     * pin) or this phone sealed a line to it. Until then it was taken with no line to check, on the node's or the rows'
     * word, and the next send or screen check judges it on the thread's lines before anything is sealed to it.
     */
    checked?: boolean;
    /** What the node's listing says about the key it lists now: see {@link DmHeard}. */
    heard?: DmHeard;
}

/**
 * What the listing last said about the key it lists for a DM, kept for the history rule: `tryKeys`, the keys it names as
 * that key's former ones (#1871 formerKeys), only tell the rule which keys to try a line under, never proof of anything;
 * `rekeyedAt`, the date a succession statement verified against that key gives (wording for the banner, pick 4).
 */
export interface DmHeard {
    tryKeys?: string[];
    rekeyedAt?: string;
}

/**
 * First sight found lines it couldn't place (rule 5 of the §3.4 amendment): no key is pinned and every send is refused
 * as not locked. Kept, so a prune and a relist can't make this DM first sight again and take the listed key (the R5 stop
 * is durable): only a later judgement that places every line under a key the listing doesn't name, with the listed key
 * offered (a pause the member decides on), replaces it. `listed` and `heard`: what the listing said; `stale`: it has said
 * something since the last judgement, so the next send or screen check judges again (#1871 formerKeys arriving, P15).
 */
export interface DmUnplacedSight {
    unplaced: true;
    since: string;
    listed: string | null;
    heard?: DmHeard;
    stale?: boolean;
    /**
     * The update kept lines of this DM to judge it on, and couldn't keep them for later runs (their write failed, or the
     * store couldn't be read: §3.4 amendment 4). Refused like rule 5; judged only on the lines the update held (that run's
     * copy, or a stored one), and any such judgement replaces the mark. With none, it is final: never judged on the
     * database, which the node has written since.
     */
    heldLost?: true;
}

export type DmPinEntry = DmPeerPin | DmUnplacedSight;

/** One account's pins, by conversation id lower-cased. */
export type DmPeerPins = Record<string, DmPinEntry>;

export function isUnplacedSight(e: DmPinEntry | null | undefined): e is DmUnplacedSight {
    return !!e && (e as DmUnplacedSight).unplaced === true;
}

/** A DM the update kept lines of that later runs can't read: {@link DmUnplacedSight.heldLost}. */
export function isHeldLostSight(e: DmPinEntry | null | undefined): e is DmUnplacedSight {
    return isUnplacedSight(e) && e.heldLost === true;
}

const KEY_HEX = /^[0-9a-f]{64}$/;

/** A public key as a pin keeps it: lower-case hex, 32 bytes. Null for anything else. */
export function pinKeyOf(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const k = raw.trim().toLowerCase();
    return KEY_HEX.test(k) ? k : null;
}

/** The id a pin is kept under: the conversation id lower-cased (one DM in any capitals). */
export function dmPinId(conversationId: string): string {
    return conversationId.toLowerCase();
}

/**
 * The longest id, after folding, that may have an entry (§3.4 amendment 6 §1): honest ids are 36-character UUIDs. A DM
 * under a longer one gets no entry of any kind (no pin, no held lines, no mark) and is sealed to nobody.
 */
export const DM_PIN_ID_MAX = 64;

/** True when this conversation id may have an entry: {@link DM_PIN_ID_MAX}. */
export function isPinnableId(conversationId: string): boolean {
    return dmPinId(conversationId).length <= DM_PIN_ID_MAX;
}

/**
 * The most one file's pins value may take as UTF-8, at every write (§3.4 amendment 6 §1): Android's store reads a value
 * through a window of about 2 MiB, so a bigger one is written and then never read again. The held lines' cap's twin.
 */
export const DM_PINS_MAX_BYTES = 1024 * 1024;

/** Keys kept in a pin's `former`, newest first (§3.4 amendment 6 §1): the oldest goes at the member's Continue. */
export const FORMER_MAX = 4;

/**
 * The phone couldn't read who one community's chats are with: nothing is sealed (fail closed), and the member is told so,
 * and where the way out is (§3.4 amendment 6 §3: the member's reset, never the phone's on its own).
 */
export const DM_PIN_STORE_UNREAD_TEXT = "This phone couldn't read who this community's chats are with, so nothing was sent. Try again; if it keeps failing, Settings → Account → Chat memory can reset this community's, which re-checks every chat here from the start.";

/** What a DM line shows in its place while the pins can't be read: it may be anyone's, so none is shown (never "update your app"). */
export const DM_PINS_UNREAD_LINE = "Can't be shown until this phone can read who this chat is with.";

export class DmPinStoreError extends Error {
    constructor() {
        super(DM_PIN_STORE_UNREAD_TEXT);
        this.name = 'DmPinStoreError';
    }
}

export function isDmPinStoreError(e: unknown): e is DmPinStoreError {
    return e instanceof DmPinStoreError || (e as { name?: unknown } | null)?.name === 'DmPinStoreError';
}

/** The one line under the box when a DM with nothing kept can't be pinned because its community's pins value is full. */
export const DM_PINS_FULL_TEXT = "This community lists more chats than this phone can keep track of, so a new chat here can't send. Your other chats here still can.";

/**
 * A file's pins value is at its cap ({@link DM_PINS_MAX_BYTES}, §3.4 amendment 6 §2): a write still over it is refused as
 * a failed write is (the copy dropped, the next ask reads again), and a DM with nothing kept there is sealed to nobody.
 */
export class DmPinsFullError extends Error {
    constructor() {
        super(DM_PINS_FULL_TEXT);
        this.name = 'DmPinsFullError';
    }
}

export function isDmPinsFullError(e: unknown): e is DmPinsFullError {
    return e instanceof DmPinsFullError || (e as { name?: unknown } | null)?.name === 'DmPinsFullError';
}

const TRY_KEYS_MAX = 8;

/**
 * A re-key date as a pin keeps it (§3.4 amendment 6 §1): the instant the node's string parses to, as 24 characters of
 * ISO, never the node's string itself. Nothing for a date that doesn't parse.
 */
export function rekeyDateOf(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function heardOf(raw: unknown): DmHeard | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const heard: DmHeard = {};
    if (Array.isArray(r.tryKeys)) {
        const keys = [...new Set(r.tryKeys.map(pinKeyOf).filter((k): k is string => !!k))].slice(0, TRY_KEYS_MAX);
        if (keys.length) heard.tryKeys = keys;
    }
    const rekeyedAt = rekeyDateOf(r.rekeyedAt);
    if (rekeyedAt) heard.rekeyedAt = rekeyedAt;
    return heard.tryKeys || heard.rekeyedAt ? heard : undefined;
}

function pinOf(raw: unknown): DmPinEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.unplaced === true) {
        const sight: DmUnplacedSight = { unplaced: true, since: typeof r.since === 'string' ? r.since : '', listed: pinKeyOf(r.listed) };
        const heard = heardOf(r.heard);
        if (heard) sight.heard = heard;
        if (r.stale === true) sight.stale = true;
        if (r.heldLost === true) sight.heldLost = true;
        return sight;
    }
    const peer = pinKeyOf(r.peer);
    if (!peer) return null;
    const by = r.by === 'member' || r.by === 'handover' ? r.by : 'first-seen';
    const pin: DmPeerPin = { peer, since: typeof r.since === 'string' ? r.since : '', by };
    if (Array.isArray(r.former)) {
        const former = r.former.map(pinKeyOf).filter((k): k is string => !!k && k !== peer);
        if (former.length) pin.former = [...new Set(former)].slice(0, FORMER_MAX);
    }
    if (r.offered && typeof r.offered === 'object') {
        const o = r.offered as Record<string, unknown>;
        const offered: DmPeerOffer = { peer: pinKeyOf(o.peer), at: typeof o.at === 'string' ? o.at : '' };
        const says = o.nodeSays as Record<string, unknown> | undefined;
        const rekeyedAt = says ? rekeyDateOf(says.rekeyedAt) : undefined;
        if (rekeyedAt) offered.nodeSays = { rekeyedAt };
        if (o.firstSight === true) offered.firstSight = true;
        pin.offered = offered;
    }
    if (r.checked === true) pin.checked = true;
    const heard = heardOf(r.heard);
    if (heard) pin.heard = heard;
    return pin;
}

/**
 * One account's pins in one community file. Throws DmPinStoreError when the storage can't be read, or holds something that
 * isn't a pin object: sealing then refuses, never "no pin" (which would be first sight again). A single entry that isn't
 * a pin, or kept under an id over {@link DM_PIN_ID_MAX}, is passed over. Nothing stored: no pins.
 */
export async function readDmPeerPins(storage: Pick<PinStorage, 'getItem'>, myPubkey: string, file: string): Promise<DmPeerPins> {
    return (await readStoredPins(storage, myPubkey, file)) ?? emptyPins();
}

/** One file's stored pins, or null when nothing is stored (that file's seed hasn't run: §3.4 amendments 5 and 6). */
async function readStoredPins(storage: Pick<PinStorage, 'getItem'>, myPubkey: string, file: string): Promise<DmPeerPins | null> {
    let raw: string | null;
    try {
        raw = await storage.getItem(dmPeerPinsStoreKey(myPubkey, file));
    } catch {
        throw new DmPinStoreError();
    }
    if (raw == null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new DmPinStoreError();
    }
    const stored = parsed as Record<string, unknown> | null;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new DmPinStoreError();
    if (!stored.pins || typeof stored.pins !== 'object' || Array.isArray(stored.pins)) throw new DmPinStoreError();
    const pins = emptyPins();
    for (const [id, value] of Object.entries(stored.pins as Record<string, unknown>)) {
        const pin = pinOf(value);
        if (pin) setPin(pins, dmPinId(id), pin);
    }
    return pins;
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
 * Write one file's pins. DmPinsFullError, with nothing written, when the value is over {@link DM_PINS_MAX_BYTES} as UTF-8
 * (measured on the string written); DmPinStoreError when the storage refuses.
 */
export async function writeDmPeerPins(storage: Pick<PinStorage, 'setItem'>, myPubkey: string, file: string, pins: DmPeerPins): Promise<void> {
    const value = JSON.stringify({ pins });
    if (value.length > DM_PINS_MAX_BYTES || utf8Bytes(value) > DM_PINS_MAX_BYTES) throw new DmPinsFullError();
    try {
        await storage.setItem(dmPeerPinsStoreKey(myPubkey, file), value);
    } catch {
        throw new DmPinStoreError();
    }
}

/**
 * What a book's copy of one file's pins takes as stored, kept beside it ({@link sizes}): `bytes` is each entry's
 * `"id":{…}` as UTF-8, by id; the value is `{"pins":{` + the entries joined by commas + `}}`. Exact at each read and
 * write, and kept so by every change through this module's functions, so a new entry on the node's word is added only
 * while the value stays under the cap (§3.4 amendment 6 §2). A copy no book holds (a test's own object) has none: no cap.
 */
interface PinsSize { byId: Map<string, number>; total: number }
const sizes = new WeakMap<DmPeerPins, PinsSize>();
const VALUE_FRAME_BYTES = '{"pins":{}}'.length;

function entryBytes(id: string, entry: DmPinEntry): number {
    return utf8Bytes(JSON.stringify(id)) + 1 + utf8Bytes(JSON.stringify(entry));
}

function valueBytes(size: PinsSize): number {
    return VALUE_FRAME_BYTES + size.total + Math.max(0, size.byId.size - 1);
}

/** Measure every entry of a copy the book holds, so its changes are kept to the cap from here. */
function measured(pins: DmPeerPins): DmPeerPins {
    const byId = new Map<string, number>();
    let total = 0;
    for (const id of Object.keys(pins)) {
        const b = entryBytes(id, pins[id]);
        byId.set(id, b);
        total += b;
    }
    sizes.set(pins, { byId, total });
    return pins;
}

/** Re-measure one entry after a change to it (true: it changed). */
function remeasure(pins: DmPeerPins, id: string): void {
    const size = sizes.get(pins);
    if (!size) return;
    size.total -= size.byId.get(id) ?? 0;
    const e = ownPin(pins, id);
    if (e) {
        const b = entryBytes(id, e);
        size.byId.set(id, b);
        size.total += b;
    } else {
        size.byId.delete(id);
    }
}

/** Run a change to the entry under `id` and keep the copy's size: every exported change goes through here. */
function resized(pins: DmPeerPins, id: string, change: () => boolean): boolean {
    const changed = change();
    if (changed) remeasure(pins, id);
    return changed;
}

/** True when a new entry `entry` under `id` keeps this copy within {@link DM_PINS_MAX_BYTES} (a copy with no size: always). */
function roomFor(pins: DmPeerPins, id: string, entry: DmPinEntry): boolean {
    const size = sizes.get(pins);
    if (!size) return true;
    return valueBytes(size) + (size.byId.size > 0 ? 1 : 0) + entryBytes(id, entry) <= DM_PINS_MAX_BYTES;
}

/**
 * True when this file's pins have no room for a first-sight pin of this DM (§3.4 amendment 6 §2): with nothing kept for
 * it, it is sealed to nobody and its send says so ({@link DmPinsFullError}). A key of 64 hex characters stands in for
 * whichever the listing names (all are that long).
 */
export function noRoomForFirstSight(pins: DmPeerPins, conversationId: string): boolean {
    const id = dmPinId(conversationId);
    if (!isPinnableId(id) || ownPin(pins, id)) return false;
    return !roomFor(pins, id, { peer: '0'.repeat(64), since: new Date().toISOString(), by: 'first-seen' });
}

function emptyPins(): DmPeerPins {
    return Object.create(null);
}

/** What the member's reset did with the value it removed (§3.4 amendment 6 §3). */
export type DmPinsReset = 'set-aside' | 'nothing-stored' | 'unreadable-removed';

/**
 * One account's pins in one community file, held in memory for the app's run, one copy per (account, file) (#1872 review,
 * findings 6 and 7; §3.4 amendment 6). The copy is read from storage the first time it is asked for, and every change
 * after that goes through one queue per (account, file), which changes that copy and writes it through: a key resolve
 * never re-reads or re-parses the store, and two writers (a sync pass, a first sight, the refresh) can't each write a copy
 * of their own that drops the other's pin.
 *
 * Every ask names the handle the caller reads or writes (`at`: db.ts passes the community database it holds), and is
 * answered with that handle's file's pins only, once that file is seeded (§3.4 amendment 5): see {@link createDmPinBook}.
 *
 * Unreadable store: `read` throws DmPinStoreError and keeps nothing, so the next ask reads again. A write the storage
 * refuses: `update` throws DmPinStoreError and drops the copy, so the next ask reads what storage holds; a write over the
 * cap the same way, as DmPinsFullError. The copy is the book's own object: callers read it, and change it only inside
 * `update`, through this module's functions (they keep its size).
 */
export interface DmPinBook<H> {
    /** This account's pins in `at`'s file (read from storage the first time), once that file is seeded. */
    read(myPubkey: string, at: H): Promise<DmPeerPins>;
    /** Run `change` on those pins after every change queued before it, once `at`'s file is seeded; written through when it returns true. */
    update(myPubkey: string, at: H, change: (pins: DmPeerPins) => boolean): Promise<boolean>;
    /**
     * The member's reset of one file's pins (Settings → Account → Chat memory, §3.4 amendment 6 §3), never the phone's
     * own: the raw value is copied aside when storage returns it (a corrupt one reads as a string), the value is removed,
     * the copy forgotten, and the next ask seeds the file as at the update, over its own rows and its held lines (which
     * the reset keeps). A value storage can't return is removed and logged, with nothing set aside. In the file's queue.
     */
    reset(myPubkey: string, file: string): Promise<DmPinsReset>;
    /** Drop every copy: the next ask reads storage again (a fresh app session). */
    forget(): void;
}

/**
 * `fileOf`: the community file a handle reads (none: refused, fail closed). `seedFile`: the update's seed of one file,
 * run once per (account, file) at the account's first ask with that file's handle, through the handle it was given, and
 * only while that file has no value stored: what it returns is run on empty pins, and they are written as the file's
 * value (`{ pins: {} }` when they pin nothing: its presence is the record) before that ask (and every ask waiting on the
 * same seed) answers. So every writer of a file's rows, which asks for the pins first, writes after its seed has read
 * them; and a seed whose write is refused (or that throws) records nothing: the ask throws, and the next one seeds again
 * from the same rows. `afterWrite`: run once each write stands, in the same turn, with that file.
 */
export function createDmPinBook<H>(
    storage: PinStorage,
    fileOf: (at: H) => string | null | undefined,
    seedFile?: (myPubkey: string, at: H, file: string) => Promise<(pins: DmPeerPins) => boolean>,
    afterWrite?: (myPubkey: string, pins: DmPeerPins, file: string) => Promise<void>,
): DmPinBook<H> {
    /** By store key: the file's pins as held, null while nothing is stored (not seeded, or reset). */
    const copies = new Map<string, Promise<{ pins: DmPeerPins | null }>>();
    const queues = new Map<string, Promise<unknown>>();
    const seeds = new Map<string, Promise<void>>();
    function load(myPubkey: string, file: string): Promise<{ pins: DmPeerPins | null }> {
        const key = dmPeerPinsStoreKey(myPubkey, file);
        const held = copies.get(key);
        if (held) return held;
        const loading = readStoredPins(storage, myPubkey, file).then((pins) => ({ pins: pins && measured(pins) }));
        copies.set(key, loading);
        loading.catch(() => { if (copies.get(key) === loading) copies.delete(key); });
        return loading;
    }
    function inTurn<T>(key: string, run: () => Promise<T>): Promise<T> {
        const turn = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
        queues.set(key, turn);
        return turn;
    }
    async function writeThrough(myPubkey: string, file: string, copy: Promise<{ pins: DmPeerPins | null }>, pins: DmPeerPins): Promise<void> {
        const key = dmPeerPinsStoreKey(myPubkey, file);
        try {
            await writeDmPeerPins(storage, myPubkey, file, pins);
        } catch (e) {
            if (copies.get(key) === copy) copies.delete(key);
            throw e;
        }
        (await copy).pins = pins;
        // In the same turn, once the write stands (db.ts drops the update's held lines of each DM now pinned).
        await afterWrite?.(myPubkey, pins, file).catch(() => {});
    }
    /** In the file's turn: its pins, seeded first when nothing is stored. */
    async function heldInTurn(myPubkey: string, at: H, file: string): Promise<DmPeerPins> {
        const copy = load(myPubkey, file);
        const held = await copy;
        if (held.pins) return held.pins;
        let seed: ((pins: DmPeerPins) => boolean) | null = null;
        try {
            if (seedFile) seed = await seedFile(myPubkey, at, file);
        } catch {
            throw new DmPinStoreError();
        }
        const pins = measured(emptyPins());
        seed?.(pins);
        await writeThrough(myPubkey, file, copy, pins);
        return pins;
    }
    function seeded(myPubkey: string, at: H): Promise<string> {
        const file = fileOf(at);
        if (!file) return Promise.reject(new DmPinStoreError());
        const key = dmPeerPinsStoreKey(myPubkey, file);
        const running = seeds.get(key);
        if (running) return running.then(() => file);
        const seeding = (async () => {
            if ((await load(myPubkey, file)).pins) return;
            await inTurn(key, () => heldInTurn(myPubkey, at, file));
        })();
        seeds.set(key, seeding);
        seeding.catch(() => { if (seeds.get(key) === seeding) seeds.delete(key); });
        return seeding.then(() => file);
    }
    async function read(myPubkey: string, at: H): Promise<DmPeerPins> {
        const file = await seeded(myPubkey, at);
        const held = await load(myPubkey, file);
        // Reset since the seed: the file's turn seeds it again.
        return held.pins ?? inTurn(dmPeerPinsStoreKey(myPubkey, file), () => heldInTurn(myPubkey, at, file));
    }
    async function update(myPubkey: string, at: H, change: (pins: DmPeerPins) => boolean): Promise<boolean> {
        const file = await seeded(myPubkey, at);
        return inTurn(dmPeerPinsStoreKey(myPubkey, file), async () => {
            const pins = await heldInTurn(myPubkey, at, file);
            if (!change(pins)) return false;
            await writeThrough(myPubkey, file, load(myPubkey, file), pins);
            return true;
        });
    }
    async function reset(myPubkey: string, file: string): Promise<DmPinsReset> {
        const key = dmPeerPinsStoreKey(myPubkey, file);
        return inTurn(key, async () => {
            let raw: string | null = null;
            let readable = true;
            try {
                raw = await storage.getItem(key);
            } catch (e) {
                readable = false;
                console.warn('[DM pins] The chat memory being reset could not be read, so none of it is set aside', e);
            }
            if (raw != null) {
                try {
                    await storage.setItem(dmPeerPinsSetAsideStoreKey(myPubkey, file), raw);
                } catch (e) {
                    console.warn('[DM pins] The chat memory being reset could not be set aside', e);
                }
            }
            if (!storage.removeItem) throw new DmPinStoreError();
            await storage.removeItem(key);
            copies.delete(key);
            seeds.delete(key);
            return !readable ? 'unreadable-removed' : raw != null ? 'set-aside' : 'nothing-stored';
        });
    }
    return { read, update, reset, forget: () => { copies.clear(); queues.clear(); seeds.clear(); } };
}

/** The entry kept under this id: own entries only, so an id the node chose ("__proto__", "constructor") is never a pin. */
function ownPin(pins: DmPeerPins, id: string): DmPinEntry | undefined {
    return Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : undefined;
}

/**
 * Keep `pin` under `id` as an own entry, whatever the id (a plain assignment of "__proto__" would set a prototype). Never
 * under an id over {@link DM_PIN_ID_MAX}: false, nothing kept.
 */
function setPin(pins: DmPeerPins, id: string, pin: DmPinEntry): boolean {
    if (id.length > DM_PIN_ID_MAX) return false;
    Object.defineProperty(pins, id, { value: pin, enumerable: true, writable: true, configurable: true });
    return true;
}

/** The key pinned for this DM, or null: none yet, or first sight found lines it couldn't place ({@link dmSightFor}). */
export function dmPinFor(pins: DmPeerPins, conversationId: string): DmPeerPin | null {
    const e = ownPin(pins, dmPinId(conversationId));
    return e && !isUnplacedSight(e) ? e : null;
}

/** Whatever this phone keeps for the DM: its pin, the rule-5 record, or null (never met). */
export function dmSightFor(pins: DmPeerPins, conversationId: string): DmPinEntry | null {
    return ownPin(pins, dmPinId(conversationId)) ?? null;
}

/**
 * First sight with no line to check: pin `peer` for this DM if this phone keeps nothing for it yet (no pin, and no rule-5
 * record, which a prune can't clear: R5). Unchecked: the history rule judges it before a line is sealed to it. True when
 * it wrote one.
 */
export function pinAtFirstSight(pins: DmPeerPins, conversationId: string, peer: string, now: string, heard?: DmHeard, checked?: boolean): boolean {
    const id = dmPinId(conversationId);
    const key = pinKeyOf(peer);
    if (!key || ownPin(pins, id) || !isPinnableId(id)) return false;
    const pin: DmPeerPin = { peer: key, since: now, by: 'first-seen' };
    if (checked) pin.checked = true;
    if (heard) pin.heard = heard;
    // A new entry on the node's or the rows' word: only while the value stays under its cap (§3.4 amendment 6 §2).
    if (!roomFor(pins, id, pin)) return false;
    return resized(pins, id, () => setPin(pins, id, pin));
}

/**
 * The history rule (design §3.4 amendment, rules 1-5): what the newest encrypted lines of a thread, oldest first, say the
 * pin is. `lines[i]` is the key line i opened under (tried under the listed key, the keys the listing names as its former
 * ones, and the keys the rows name), or null when it opened under none. `listed`: the key the node lists now (null when it
 * lists several, or none). The oldest opening line's key is the pin; the listing only ever offers.
 */
export type SightVerdict =
    | { rule: 1 }
    | { rule: 2 | 3 | 4; pin: string; offer: boolean }
    | { rule: 5 };

export function judgeFirstSight(lines: ReadonlyArray<string | null>, listed: string | null): SightVerdict {
    if (!lines.length) return { rule: 1 };
    if (lines.some((k) => !k)) return { rule: 5 };
    const keys = [...new Set(lines as string[])];
    if (keys.length === 1) {
        if (keys[0] === listed) return { rule: 2, pin: keys[0], offer: false };
        return { rule: 3, pin: keys[0], offer: true };
    }
    if (keys.length === 2 && listed && keys[0] !== listed && keys[1] === listed) {
        // Every line under the older key comes before every line under the listed one.
        const firstListed = lines.indexOf(listed);
        if (lines.slice(firstListed).every((k) => k === listed)) return { rule: 4, pin: keys[0], offer: true };
    }
    return { rule: 5 };
}

/**
 * Write what the history rule decided for one DM (`verdict`, judged against `listed`) over whatever is kept now. Rule 1
 * keeps it all (a thread with no line has nothing to say; a DM with nothing kept is pinned to `listed` unchecked). Rules
 * 2-4 pin the key the lines placed, checked, with `listed` offered when it differs. Rule 5 keeps no pin, only the record.
 * A rule-5 record is replaced only by rule 3 or 4 (a pause the member decides on), never by rule 1 or 2, which would take
 * the listed key with no question after lines were seen that it couldn't place (R5). A pin already checked, or one the
 * member or a handover chose, is never judged again. True when the pins changed.
 */
export function applySightVerdict(pins: DmPeerPins, conversationId: string, verdict: SightVerdict, listed: string | null, heard: DmHeard | undefined, now: string): boolean {
    const id = dmPinId(conversationId);
    if (!isPinnableId(id)) return false;
    // A judgement replaces, so it always applies; rule 1's first-sight pin is a new entry and keeps to the cap (pinAtFirstSight).
    return resized(pins, id, () => judged(pins, id, verdict, listed, heard, now));
}

function judged(pins: DmPeerPins, id: string, verdict: SightVerdict, listed: string | null, heard: DmHeard | undefined, now: string): boolean {
    // A heldLost mark is judged only on the update's held lines (db.ts), and that judgement replaces it as if none were kept.
    const lost = isHeldLostSight(ownPin(pins, id));
    const held = lost ? undefined : ownPin(pins, id);
    if (held && !isUnplacedSight(held) && (held.checked || held.by !== 'first-seen')) return false;
    if (verdict.rule === 1) {
        if (held || lost || !listed) return false;
        const key = pinKeyOf(listed);
        const pin: DmPeerPin | null = key ? { peer: key, since: now, by: 'first-seen', ...(heard ? { heard } : {}) } : null;
        return !!pin && roomFor(pins, id, pin) && setPin(pins, id, pin);
    }
    if (verdict.rule === 5) {
        if (isUnplacedSight(held) && !held.stale) return false;
        const sight: DmUnplacedSight = { unplaced: true, since: isUnplacedSight(held) ? held.since : now, listed };
        if (heard) sight.heard = heard;
        return setPin(pins, id, sight);
    }
    if (isUnplacedSight(held) && !verdict.offer) {
        if (!held.stale) return false;
        delete held.stale;
        return true;
    }
    const pin: DmPeerPin = { peer: verdict.pin, since: now, by: 'first-seen', checked: true };
    if (verdict.offer && listed !== verdict.pin) {
        pin.offered = { peer: listed, at: now, firstSight: true };
        if (heard?.rekeyedAt) pin.offered.nodeSays = { rekeyedAt: heard.rekeyedAt };
    }
    return setPin(pins, id, pin);
}

/**
 * The update's marks (§3.4 amendment 4): each DM in `ids` with nothing kept is refused, as rule 5, until a judgement on
 * the lines the update held replaces the mark ({@link DmUnplacedSight.heldLost}). True when the pins changed.
 */
export function markHeldLost(pins: DmPeerPins, ids: Iterable<string>, now: string): boolean {
    let changed = false;
    for (const conversationId of ids) {
        const id = dmPinId(conversationId);
        if (ownPin(pins, id)) continue;
        if (resized(pins, id, () => setPin(pins, id, { unplaced: true, since: now, listed: null, heldLost: true }))) changed = true;
    }
    return changed;
}

/** A send seals to an unchecked first-seen pin: it is this phone's from now on (§3.6, "the first key this phone sealed to"). */
export function settleFirstSight(pins: DmPeerPins, conversationId: string): boolean {
    const pin = dmPinFor(pins, conversationId);
    if (!pin || pin.checked || pin.by !== 'first-seen' || pin.offered) return false;
    return resized(pins, dmPinId(conversationId), () => (pin.checked = true));
}

/**
 * What the node's listings of one DM in this pass say about its pin. `listings` holds, for each listing of the id in any
 * capitals, the other keys it names (mine left out). With a pin: any listing without the pinned key offers its other key
 * (sends stop); every listing naming the pinned key clears an offer (a node that was briefly wrong). Without a pin: every
 * listing naming the same one other key pins it at first sight; listings that disagree, or name several, pin nothing.
 * The pinned key itself never moves here. True when the pins changed.
 */
export function applyDmListings(pins: DmPeerPins, conversationId: string, listings: ReadonlyArray<ReadonlyArray<string>>, now: string, heard?: DmHeard): boolean {
    const id = dmPinId(conversationId);
    if (!isPinnableId(id)) return false;
    const entry = ownPin(pins, id);
    // A new entry keeps to the cap (pinAtFirstSight); a change to a kept one always applies.
    return entry ? resized(pins, id, () => heardBy(pins, id, entry, listings, now, heard)) : heardBy(pins, id, entry, listings, now, heard);
}

function heardBy(pins: DmPeerPins, id: string, entry: DmPinEntry | undefined, listings: ReadonlyArray<ReadonlyArray<string>>, now: string, heard?: DmHeard): boolean {
    const named = listings.map((others) => [...new Set(others.map(pinKeyOf).filter((k): k is string => !!k))]);
    const one = named.length > 0 && named.every((o) => o.length === 1) && new Set(named.map((o) => o[0])).size === 1 ? named[0][0] : null;
    if (!entry) {
        if (!one) return false;
        return pinAtFirstSight(pins, id, one, now, heard);
    }
    if (isUnplacedSight(entry)) {
        // Rule 5 stands: the listing is only heard, for the next judgement (never a pin from it).
        if (entry.listed === one && sameHeard(entry.heard, heard)) return false;
        entry.listed = one;
        if (heard) entry.heard = heard; else delete entry.heard;
        entry.stale = true;
        return true;
    }
    const pin = entry;
    if (!pin.checked && pin.by === 'first-seen' && one && !sameHeard(pin.heard, heard)) {
        // An unchecked pin keeps what the listing says about the key it lists, for its judgement.
        if (heard) pin.heard = heard; else delete pin.heard;
        applyDmListingsTo(pin, named, now, heard);
        return true;
    }
    return applyDmListingsTo(pin, named, now, heard);
}

function sameHeard(a: DmHeard | undefined, b: DmHeard | undefined): boolean {
    return (a?.rekeyedAt ?? '') === (b?.rekeyedAt ?? '') && (a?.tryKeys ?? []).join() === (b?.tryKeys ?? []).join();
}

/**
 * A first-sight pause (history placed the pin and the listing disagreed, rules 3-4) is the member's to end (design §3.4
 * amendment 2, option H): no listing lifts it, not one naming the pinned key, and not one offering a third key in between
 * (`firstSight` belongs to the pause, so PUPPET → Q → PUPPET keeps it). An existing phone's offer (no `firstSight`) clears
 * when every listing names the pin again: the pin never moved, so that is harmless.
 */
function applyDmListingsTo(pin: DmPeerPin, named: string[][], now: string, heard?: DmHeard): boolean {
    const without = named.find((o) => o.length > 0 && !o.includes(pin.peer));
    if (!without) {
        if (!pin.offered || pin.offered.firstSight || named.some((o) => !o.includes(pin.peer))) return false;
        delete pin.offered;
        return true;
    }
    const peer = without.length === 1 ? without[0] : null;
    const rekeyedAt = peer && named.length === 1 ? rekeyDateOf(heard?.rekeyedAt) : undefined;
    if (pin.offered && pin.offered.peer === peer && pin.offered.nodeSays?.rekeyedAt === rekeyedAt) return false;
    const pause = pin.offered;
    pin.offered = { peer, at: pause?.peer === peer ? pause.at : now };
    if (rekeyedAt) pin.offered.nodeSays = { rekeyedAt };
    if (pause?.firstSight) pin.offered.firstSight = true;
    return true;
}

/**
 * The member's "Continue with the new key" (slice 2, pick 1): the key on offer becomes the pinned key, `by: 'member'`,
 * and the key before it goes first in `former`, so the old lines still open (pick 3). The offer, the first-sight verdict
 * and what the listing said go with it: the member decided. Only the key on offer moves a pin, from a sync or a
 * first-sight pause alike (§3.4 amendment, rules 3-4). Any other key, an offer of several keys (peer null), a pin with no
 * offer, a rule-5 record (no key placed: there is nothing to continue from), or a DM with no pin: nothing changes. True
 * when it changed.
 */
export function acceptOffer(pins: DmPeerPins, conversationId: string, peer: string, now: string): boolean {
    const id = dmPinId(conversationId);
    const key = pinKeyOf(peer);
    const pin = dmPinFor(pins, id);
    if (!key || !pin?.offered || pin.offered.peer !== key) return false;
    // Newest first, the oldest dropped past FORMER_MAX (§3.4 amendment 6): its lines then read "couldn't be verified".
    const former = [...new Set([pin.peer, ...(pin.former ?? [])])].filter((k) => k !== key).slice(0, FORMER_MAX);
    return resized(pins, id, () => setPin(pins, id, { peer: key, since: now, by: 'member', ...(former.length ? { former } : {}) }));
}

/** The keys a thread's old lines may open under: the pinned one, then the ones before it. */
export function dmOpenPeers(pin: DmPeerPin): string[] {
    return [pin.peer, ...(pin.former ?? []).filter((k) => k !== pin.peer)];
}
