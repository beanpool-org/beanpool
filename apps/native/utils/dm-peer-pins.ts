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
}

export type DmPinEntry = DmPeerPin | DmUnplacedSight;

/** One account's pins, by conversation id lower-cased. */
export type DmPeerPins = Record<string, DmPinEntry>;

export function isUnplacedSight(e: DmPinEntry | null | undefined): e is DmUnplacedSight {
    return !!e && (e as DmUnplacedSight).unplaced === true;
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

const TRY_KEYS_MAX = 8;

function heardOf(raw: unknown): DmHeard | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const heard: DmHeard = {};
    if (Array.isArray(r.tryKeys)) {
        const keys = [...new Set(r.tryKeys.map(pinKeyOf).filter((k): k is string => !!k))].slice(0, TRY_KEYS_MAX);
        if (keys.length) heard.tryKeys = keys;
    }
    if (typeof r.rekeyedAt === 'string') heard.rekeyedAt = r.rekeyedAt;
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
        return sight;
    }
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
    if (r.checked === true) pin.checked = true;
    const heard = heardOf(r.heard);
    if (heard) pin.heard = heard;
    return pin;
}

/**
 * One account's pins. Throws DmPinStoreError when the storage can't be read, or holds something that isn't a pin object:
 * sealing then refuses, never "no pin" (which would be first sight again). A single entry that isn't a pin is passed over.
 */
export async function readDmPeerPins(storage: Pick<PinStorage, 'getItem'>, myPubkey: string): Promise<DmPeerPins> {
    return (await readStoredPins(storage, myPubkey)).pins;
}

/** As readDmPeerPins, and whether storage held nothing at all for this account (no build with pins has met it yet). */
async function readStoredPins(storage: Pick<PinStorage, 'getItem'>, myPubkey: string): Promise<{ pins: DmPeerPins; absent: boolean }> {
    let raw: string | null;
    try {
        raw = await storage.getItem(dmPeerPinsStoreKey(myPubkey));
    } catch {
        throw new DmPinStoreError();
    }
    if (raw == null) return { pins: Object.create(null), absent: true };
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
    return { pins, absent: false };
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
    /**
     * Run `change` on this account's pins after every change queued before it; written through when it returns true.
     * `fresh`: storage held nothing for this account when the copy was read and nothing has been written since, so this is
     * the first change a build with pins makes for it (the sync's seed from the phone's own rows, design §3.4 amendment).
     */
    update(myPubkey: string, change: (pins: DmPeerPins, state: { fresh: boolean }) => boolean): Promise<boolean>;
    /** Drop every copy: the next ask reads storage again (a fresh app session). */
    forget(): void;
}

export function createDmPinBook(storage: PinStorage): DmPinBook {
    const copies = new Map<string, Promise<DmPeerPins>>();
    const queues = new Map<string, Promise<unknown>>();
    const absent = new Set<string>();
    function read(myPubkey: string): Promise<DmPeerPins> {
        const key = dmPeerPinsStoreKey(myPubkey);
        const held = copies.get(key);
        if (held) return held;
        const loading = readStoredPins(storage, myPubkey).then((r) => {
            if (r.absent) absent.add(key); else absent.delete(key);
            return r.pins;
        });
        copies.set(key, loading);
        loading.catch(() => { if (copies.get(key) === loading) copies.delete(key); });
        return loading;
    }
    function update(myPubkey: string, change: (pins: DmPeerPins, state: { fresh: boolean }) => boolean): Promise<boolean> {
        const key = dmPeerPinsStoreKey(myPubkey);
        const turn = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const copy = read(myPubkey);
            const pins = await copy;
            if (!change(pins, { fresh: absent.has(key) })) return false;
            try {
                await writeDmPeerPins(storage, myPubkey, pins);
                absent.delete(key);
            } catch (e) {
                if (copies.get(key) === copy) copies.delete(key);
                throw e;
            }
            return true;
        });
        queues.set(key, turn);
        return turn;
    }
    return { read, update, forget: () => { copies.clear(); queues.clear(); absent.clear(); } };
}

/** The entry kept under this id: own entries only, so an id the node chose ("__proto__", "constructor") is never a pin. */
function ownPin(pins: DmPeerPins, id: string): DmPinEntry | undefined {
    return Object.prototype.hasOwnProperty.call(pins, id) ? pins[id] : undefined;
}

/** Keep `pin` under `id` as an own entry, whatever the id (a plain assignment of "__proto__" would set a prototype). */
function setPin(pins: DmPeerPins, id: string, pin: DmPinEntry): void {
    Object.defineProperty(pins, id, { value: pin, enumerable: true, writable: true, configurable: true });
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
    if (!key || ownPin(pins, id)) return false;
    const pin: DmPeerPin = { peer: key, since: now, by: 'first-seen' };
    if (checked) pin.checked = true;
    if (heard) pin.heard = heard;
    setPin(pins, id, pin);
    return true;
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
    const held = ownPin(pins, id);
    if (held && !isUnplacedSight(held) && (held.checked || held.by !== 'first-seen')) return false;
    if (verdict.rule === 1) {
        if (held || !listed) return false;
        return pinAtFirstSight(pins, id, listed, now, heard);
    }
    if (verdict.rule === 5) {
        if (isUnplacedSight(held) && !held.stale) return false;
        const sight: DmUnplacedSight = { unplaced: true, since: isUnplacedSight(held) ? held.since : now, listed };
        if (heard) sight.heard = heard;
        setPin(pins, id, sight);
        return true;
    }
    if (isUnplacedSight(held) && !verdict.offer) {
        if (!held.stale) return false;
        delete held.stale;
        return true;
    }
    const pin: DmPeerPin = { peer: verdict.pin, since: now, by: 'first-seen', checked: true };
    if (verdict.offer && listed !== verdict.pin) {
        pin.offered = { peer: listed, at: now };
        if (heard?.rekeyedAt) pin.offered.nodeSays = { rekeyedAt: heard.rekeyedAt };
    }
    setPin(pins, id, pin);
    return true;
}

/** A send seals to an unchecked first-seen pin: it is this phone's from now on (§3.6, "the first key this phone sealed to"). */
export function settleFirstSight(pins: DmPeerPins, conversationId: string): boolean {
    const pin = dmPinFor(pins, conversationId);
    if (!pin || pin.checked || pin.by !== 'first-seen' || pin.offered) return false;
    pin.checked = true;
    return true;
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
    const named = listings.map((others) => [...new Set(others.map(pinKeyOf).filter((k): k is string => !!k))]);
    const one = named.length > 0 && named.every((o) => o.length === 1) && new Set(named.map((o) => o[0])).size === 1 ? named[0][0] : null;
    const entry = ownPin(pins, id);
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

function applyDmListingsTo(pin: DmPeerPin, named: string[][], now: string, heard?: DmHeard): boolean {
    const without = named.find((o) => o.length > 0 && !o.includes(pin.peer));
    if (!without) {
        if (!pin.offered || named.some((o) => !o.includes(pin.peer))) return false;
        delete pin.offered;
        return true;
    }
    const peer = without.length === 1 ? without[0] : null;
    const rekeyedAt = peer && named.length === 1 ? heard?.rekeyedAt : undefined;
    if (pin.offered && pin.offered.peer === peer && pin.offered.nodeSays?.rekeyedAt === rekeyedAt) return false;
    pin.offered = { peer, at: pin.offered?.peer === peer ? pin.offered.at : now };
    if (rekeyedAt) pin.offered.nodeSays = { rekeyedAt };
    return true;
}

/** The keys a thread's old lines may open under: the pinned one, then the ones before it. */
export function dmOpenPeers(pin: DmPeerPin): string[] {
    return [pin.peer, ...(pin.former ?? []).filter((k) => k !== pin.peer)];
}
