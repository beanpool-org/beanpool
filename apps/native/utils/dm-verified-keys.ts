/**
 * Verified once (scratch/fable-design/DESIGN-s7-blocks-verified-everywhere-fable.md §3; Marty, 21 Nov 2026: "Yes, all four").
 *
 * The member's "Mark as verified" is of a key, not of a place or a chat: one small value per account, outside every
 * community's file, `beanpool_dm_verified_keys:<my key>` → `{ keys: { <key>: <date> } }`. A DM in any community is verified
 * exactly when the key its pin is sealed to is on this list ({@link isVerifiedPin}, the one reader). Signal's model then
 * applies in that chat only: a verified chat waits for the member when its own community lists another key; any other
 * follows the listing with a notice (utils/dm-peer-pins.ts).
 *
 * The wall: three writers, all the member's own taps (Mark as verified, Continue on the verified card, Remove
 * verification, through utils/db.ts). No server can read, write or remove the list: no listing, sync, push, carry between
 * addresses or community reset touches it, so one community's word can't mark, unmark or pause a chat in another.
 *
 * Read once per run into memory, per account. Cap {@link DM_VERIFIED_KEYS_MAX}: a Mark past it is refused with a sentence.
 * Kept when the account leaves the phone and never read for another account, as the pins and the block list are.
 *
 * Can't be read: {@link DM_VERIFIED_UNREADABLE}, never kept, so the next ask reads again. Until then no chat follows a
 * key change by itself (every pin holds as verified for a move; sends to the key already pinned carry on), no screen
 * shows Verified ✓ ({@link showsVerifiedMark}), and every writer refuses ({@link DmVerifiedStoreError}).
 *
 * Day zero (§5, question 1): a mark an older build kept on a pin, inside a community's file, is simply not read.
 *
 * The storage is passed in (db.ts hands it AsyncStorage).
 */

import { t, word } from '@beanpool/core';
import { dmVerifiedKeysStoreKey } from './storage-keys';

export interface VerifiedKeysStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** The most keys the list holds: the 1,001st Mark is refused ({@link DmVerifiedFullError}). */
export const DM_VERIFIED_KEYS_MAX = 1000;

/**
 * The member's verified keys as one read found them. Which keys are on it is held apart ({@link KEYS}), so nothing but
 * {@link isVerifiedPin} can ask. `readable` false: the list couldn't be read ({@link DM_VERIFIED_UNREADABLE}).
 */
export interface DmVerifiedKeys {
    readonly readable: boolean;
}

/** Each readable list's keys. Read in exactly one place: {@link isVerifiedPin}. */
const KEYS = new WeakMap<DmVerifiedKeys, ReadonlySet<string>>();

/** The list that couldn't be read: every pin holds as verified for a move, and no ✓ shows. */
export const DM_VERIFIED_UNREADABLE: DmVerifiedKeys = Object.freeze({ readable: false });

const KEY_HEX = /^[0-9a-f]{64}$/;

function keyOf(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const k = raw.trim().toLowerCase();
    return KEY_HEX.test(k) ? k : null;
}

/** A readable list holding `keys` (anything that isn't a 64-hex key left out). */
export function dmVerifiedKeysOf(keys: Iterable<string>): DmVerifiedKeys {
    const list: DmVerifiedKeys = Object.freeze({ readable: true });
    KEYS.set(list, new Set([...keys].map(keyOf).filter((k): k is string => !!k)));
    return list;
}

/**
 * THE one reader (§3.2): true when the key `pin` is sealed to is on the member's list. A list that couldn't be read (or
 * none handed in) answers true, fail closed: no chat follows a key change by itself until the list reads. That answer is
 * for moves and pauses only; a screen asks {@link showsVerifiedMark}, which never shows a ✓ the list didn't say.
 */
export function isVerifiedPin(pin: { readonly peer: string } | null | undefined, verified: DmVerifiedKeys | null | undefined): boolean {
    if (!pin) return false;
    const keys = verified ? KEYS.get(verified) : undefined;
    if (!keys) return true;
    return keys.has(pin.peer.toLowerCase());
}

/** What a screen shows: Verified ✓ only when the list was read and holds the pin's key. */
export function showsVerifiedMark(pin: { readonly peer: string } | null | undefined, verified: DmVerifiedKeys | null | undefined): boolean {
    return !!verified?.readable && isVerifiedPin(pin, verified);
}

const VERIFIED_WORDS = {
    unread: word("This phone couldn't read who you marked as verified, so for now no chat moves to a new key and nothing can be marked or removed. Try again in a moment."),
    full: word("This phone can't keep any more people marked as verified. Remove verification from someone you no longer need, then try again."),
} as const;
/** The sentences a screen shows for the two refusals, put through t() where shown (words:check reads `t(X.key)`). */
export const DM_VERIFIED_WORDS = VERIFIED_WORDS;

/** The list can't be read or written: nothing was marked, removed or continued. */
export class DmVerifiedStoreError extends Error {
    constructor() {
        super(t(VERIFIED_WORDS.unread));
        this.name = 'DmVerifiedStoreError';
    }
}

export function isDmVerifiedStoreError(e: unknown): e is DmVerifiedStoreError {
    return e instanceof DmVerifiedStoreError || (e as { name?: unknown } | null)?.name === 'DmVerifiedStoreError';
}

/** The list holds {@link DM_VERIFIED_KEYS_MAX} keys: the Mark is refused, nothing written. */
export class DmVerifiedFullError extends Error {
    constructor() {
        super(t(VERIFIED_WORDS.full));
        this.name = 'DmVerifiedFullError';
    }
}

export function isDmVerifiedFullError(e: unknown): e is DmVerifiedFullError {
    return e instanceof DmVerifiedFullError || (e as { name?: unknown } | null)?.name === 'DmVerifiedFullError';
}

/** The stored value read as key → date. Throws DmVerifiedStoreError for anything that isn't the list. Nothing stored: empty. */
function storedKeysOf(raw: string | null): Map<string, string> {
    const keys = new Map<string, string>();
    if (raw == null) return keys;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new DmVerifiedStoreError();
    }
    const stored = parsed as Record<string, unknown> | null;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new DmVerifiedStoreError();
    const map = stored.keys as Record<string, unknown> | null | undefined;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new DmVerifiedStoreError();
    for (const [raw, at] of Object.entries(map)) {
        const key = keyOf(raw);
        if (key) keys.set(key, typeof at === 'string' ? at : '');
    }
    return keys;
}

function snapshot(keys: ReadonlyMap<string, string>): DmVerifiedKeys {
    return dmVerifiedKeysOf(keys.keys());
}

/** What a writer did. */
export type DmVerifiedChange = 'added' | 'already' | 'removed' | 'absent';

/**
 * One account's list, held in memory for the app's run. `read` never throws: a list that can't be read is
 * {@link DM_VERIFIED_UNREADABLE} and nothing is kept, so the next ask reads again. `add` and `remove` are the member's
 * taps only (utils/db.ts): one queue per account, read, changed and written through; they throw DmVerifiedStoreError
 * when the list can't be read or written (nothing changes), and `add` DmVerifiedFullError at the cap.
 */
export interface DmVerifiedBook {
    read(myPubkey: string): Promise<DmVerifiedKeys>;
    add(myPubkey: string, key: string, now?: string): Promise<DmVerifiedChange>;
    remove(myPubkey: string, key: string): Promise<DmVerifiedChange>;
    /** Drop every copy: the next ask reads storage again. */
    forget(): void;
}

export function createDmVerifiedBook(storage: VerifiedKeysStorage): DmVerifiedBook {
    const copies = new Map<string, Promise<Map<string, string>>>();
    const queues = new Map<string, Promise<unknown>>();
    function load(myPubkey: string): Promise<Map<string, string>> {
        const storeKey = dmVerifiedKeysStoreKey(myPubkey);
        const held = copies.get(storeKey);
        if (held) return held;
        const loading = (async () => {
            let raw: string | null;
            try {
                raw = await storage.getItem(storeKey);
            } catch {
                throw new DmVerifiedStoreError();
            }
            return storedKeysOf(raw);
        })();
        copies.set(storeKey, loading);
        loading.catch(() => { if (copies.get(storeKey) === loading) copies.delete(storeKey); });
        return loading;
    }
    function inTurn<T>(myPubkey: string, run: () => Promise<T>): Promise<T> {
        const storeKey = dmVerifiedKeysStoreKey(myPubkey);
        const turn = (queues.get(storeKey) ?? Promise.resolve()).catch(() => {}).then(run);
        queues.set(storeKey, turn);
        return turn;
    }
    /** Write `next` as the list; only once it stands does the held copy become it. */
    async function writeThrough(myPubkey: string, next: Map<string, string>): Promise<void> {
        const storeKey = dmVerifiedKeysStoreKey(myPubkey);
        const value = JSON.stringify({ keys: Object.fromEntries(next) });
        try {
            await storage.setItem(storeKey, value);
        } catch {
            copies.delete(storeKey);
            throw new DmVerifiedStoreError();
        }
        copies.set(storeKey, Promise.resolve(next));
    }
    async function read(myPubkey: string): Promise<DmVerifiedKeys> {
        try {
            return snapshot(await load(myPubkey));
        } catch {
            return DM_VERIFIED_UNREADABLE;
        }
    }
    function add(myPubkey: string, key: string, now?: string): Promise<DmVerifiedChange> {
        const k = keyOf(key);
        return inTurn(myPubkey, async () => {
            if (!k) return 'absent';
            const held = await load(myPubkey);
            if (held.has(k)) return 'already';
            if (held.size >= DM_VERIFIED_KEYS_MAX) throw new DmVerifiedFullError();
            const next = new Map(held);
            next.set(k, now ?? new Date().toISOString());
            await writeThrough(myPubkey, next);
            return 'added';
        });
    }
    function remove(myPubkey: string, key: string): Promise<DmVerifiedChange> {
        const k = keyOf(key);
        return inTurn(myPubkey, async () => {
            const held = await load(myPubkey);
            if (!k || !held.has(k)) return 'absent';
            const next = new Map(held);
            next.delete(k);
            await writeThrough(myPubkey, next);
            return 'removed';
        });
    }
    return { read, add, remove, forget: () => { copies.clear(); queues.clear(); } };
}
