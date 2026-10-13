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
 * One object per account, `beanpool_dm_peer_pins:<my key>` → { conversation id lower-cased → pin }. Kept when the account
 * leaves the phone, as its block list is (Marty, 13 Oct, pick 2), and never read for another account's key. Ids are
 * folded, as the held check and the DM guard fold them, so a twin the node writes in other capitals is the same DM here.
 *
 * The storage is passed in. db.ts keeps one copy per account in memory for the app's run ({@link createDmPinBook}): read
 * from storage once, and every change goes through one queue that writes it through.
 */

import { dmPeerPinsStoreKey } from './storage-keys';

export interface PinStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** The other key the node lists for a pinned DM, waiting for the member's word. Nothing is sealed to it until then. */
export interface DmPeerOffer {
    /** The key the node lists instead of the pinned one; null when it lists several others and none is pinned. */
    peer: string | null;
    /** When this phone first saw it listed (ISO). */
    at: string;
    /** What the node says happened (slice 3: a verified re-key date). Only ever wording for the banner. */
    nodeSays?: { rekeyedAt: string };
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
}

/** One account's pins, by conversation id lower-cased. */
export type DmPeerPins = Record<string, DmPeerPin>;

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

/** The phone couldn't read its DM pins: nothing is sealed (fail closed), and the member is told so. */
export const DM_PIN_STORE_UNREAD_TEXT = "This phone couldn't read who this chat is with, so the message wasn't sent. Try again in a moment.";

export class DmPinStoreError extends Error {
    constructor() {
        super(DM_PIN_STORE_UNREAD_TEXT);
        this.name = 'DmPinStoreError';
    }
}

export function isDmPinStoreError(e: unknown): e is DmPinStoreError {
    return e instanceof DmPinStoreError || (e as { name?: unknown } | null)?.name === 'DmPinStoreError';
}

function pinOf(raw: unknown): DmPeerPin | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const peer = pinKeyOf(r.peer);
    if (!peer) return null;
    const by = r.by === 'member' || r.by === 'handover' ? r.by : 'first-seen';
    const pin: DmPeerPin = { peer, since: typeof r.since === 'string' ? r.since : '', by };
    if (Array.isArray(r.former)) {
        const former = r.former.map(pinKeyOf).filter((k): k is string => !!k && k !== peer);
        if (former.length) pin.former = [...new Set(former)];
    }
    if (r.offered && typeof r.offered === 'object') {
        const o = r.offered as Record<string, unknown>;
        const offered: DmPeerOffer = { peer: pinKeyOf(o.peer), at: typeof o.at === 'string' ? o.at : '' };
        const says = o.nodeSays as Record<string, unknown> | undefined;
        if (says && typeof says.rekeyedAt === 'string') offered.nodeSays = { rekeyedAt: says.rekeyedAt };
        pin.offered = offered;
    }
    return pin;
}

/**
 * One account's pins. Throws DmPinStoreError when the storage can't be read, or holds something that isn't a pin object:
 * sealing then refuses, never "no pin" (which would be first sight again). A single entry that isn't a pin is passed over.
 */
export async function readDmPeerPins(storage: Pick<PinStorage, 'getItem'>, myPubkey: string): Promise<DmPeerPins> {
    let raw: string | null;
    try {
        raw = await storage.getItem(dmPeerPinsStoreKey(myPubkey));
    } catch {
        throw new DmPinStoreError();
    }
    if (raw == null) return Object.create(null);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new DmPinStoreError();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DmPinStoreError();
    const pins: DmPeerPins = Object.create(null);
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const pin = pinOf(value);
        if (pin) setPin(pins, dmPinId(id), pin);
    }
    return pins;
}

/** Write one account's pins. Throws DmPinStoreError when the storage refuses. */
export async function writeDmPeerPins(storage: Pick<PinStorage, 'setItem'>, myPubkey: string, pins: DmPeerPins): Promise<void> {
    try {
        await storage.setItem(dmPeerPinsStoreKey(myPubkey), JSON.stringify(pins));
    } catch {
        throw new DmPinStoreError();
    }
}

/**
 * One account's pins held in memory for the app's run, one copy per account (#1872 review, findings 6 and 7). The copy
 * is read from storage the first time it is asked for, and every change after that goes through one queue per account,
 * which changes that copy and writes it through: a key resolve never re-reads or re-parses the store, and two writers
 * (a sync pass, a first sight, the refresh) can't each write a copy of their own that drops the other's pin.
 *
 * Unreadable store: `read` throws DmPinStoreError and keeps nothing, so the next ask reads again. A write the storage
 * refuses: `update` throws DmPinStoreError and drops the copy, so the next ask reads what storage holds. The copy is the
 * book's own object: callers read it, and change it only inside `update`.
 */
export interface DmPinBook {
    /** This account's pins (read from storage the first time). */
    read(myPubkey: string): Promise<DmPeerPins>;
    /** Run `change` on this account's pins after every change queued before it; written through when it returns true. */
    update(myPubkey: string, change: (pins: DmPeerPins) => boolean): Promise<boolean>;
    /** Drop every copy: the next ask reads storage again (a fresh app session). */
    forget(): void;
}

export function createDmPinBook(storage: PinStorage): DmPinBook {
    const copies = new Map<string, Promise<DmPeerPins>>();
    const queues = new Map<string, Promise<unknown>>();
    function read(myPubkey: string): Promise<DmPeerPins> {
        const key = dmPeerPinsStoreKey(myPubkey);
        const held = copies.get(key);
        if (held) return held;
        const loading = readDmPeerPins(storage, myPubkey);
        copies.set(key, loading);
        loading.catch(() => { if (copies.get(key) === loading) copies.delete(key); });
        return loading;
    }
    function update(myPubkey: string, change: (pins: DmPeerPins) => boolean): Promise<boolean> {
        const key = dmPeerPinsStoreKey(myPubkey);
        const turn = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const copy = read(myPubkey);
            const pins = await copy;
            if (!change(pins)) return false;
            try {
                await writeDmPeerPins(storage, myPubkey, pins);
            } catch (e) {
                if (copies.get(key) === copy) copies.delete(key);
                throw e;
            }
            return true;
        });
        queues.set(key, turn);
        return turn;
    }
    return { read, update, forget: () => { copies.clear(); queues.clear(); } };
}

/** The pin kept under this id: own entries only, so an id the node chose ("__proto__", "constructor") is never a pin. */
function ownPin(pins: DmPeerPins, id: string): DmPeerPin | undefined {
    return Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : undefined;
}

/** Keep `pin` under `id` as an own entry, whatever the id (a plain assignment of "__proto__" would set a prototype). */
function setPin(pins: DmPeerPins, id: string, pin: DmPeerPin): void {
    Object.defineProperty(pins, id, { value: pin, enumerable: true, writable: true, configurable: true });
}

export function dmPinFor(pins: DmPeerPins, conversationId: string): DmPeerPin | null {
    return ownPin(pins, dmPinId(conversationId)) ?? null;
}

/** First sight: pin `peer` for this DM if nothing is pinned yet. True when it wrote one. */
export function pinAtFirstSight(pins: DmPeerPins, conversationId: string, peer: string, now: string): boolean {
    const id = dmPinId(conversationId);
    const key = pinKeyOf(peer);
    if (!key || ownPin(pins, id)) return false;
    setPin(pins, id, { peer: key, since: now, by: 'first-seen' });
    return true;
}

/**
 * What the node's listings of one DM in this pass say about its pin. `listings` holds, for each listing of the id in any
 * capitals, the other keys it names (mine left out). With a pin: any listing without the pinned key offers its other key
 * (sends stop); every listing naming the pinned key clears an offer (a node that was briefly wrong). Without a pin: every
 * listing naming the same one other key pins it at first sight; listings that disagree, or name several, pin nothing.
 * The pinned key itself never moves here. True when the pins changed.
 */
export function applyDmListings(pins: DmPeerPins, conversationId: string, listings: ReadonlyArray<ReadonlyArray<string>>, now: string): boolean {
    const id = dmPinId(conversationId);
    const named = listings.map((others) => [...new Set(others.map(pinKeyOf).filter((k): k is string => !!k))]);
    const pin = ownPin(pins, id);
    if (!pin) {
        if (!named.length || named.some((o) => o.length !== 1) || new Set(named.map((o) => o[0])).size !== 1) return false;
        return pinAtFirstSight(pins, id, named[0][0], now);
    }
    const without = named.find((o) => o.length > 0 && !o.includes(pin.peer));
    if (!without) {
        if (!pin.offered || named.some((o) => !o.includes(pin.peer))) return false;
        delete pin.offered;
        return true;
    }
    const peer = without.length === 1 ? without[0] : null;
    if (pin.offered && pin.offered.peer === peer) return false;
    pin.offered = { peer, at: now };
    return true;
}

/** The keys a thread's old lines may open under: the pinned one, then the ones before it. */
export function dmOpenPeers(pin: DmPeerPin): string[] {
    return [pin.peer, ...(pin.former ?? []).filter((k) => k !== pin.peer)];
}
