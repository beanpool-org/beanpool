/**
 * One move of the phone's community at a time (addresses S5; the leftover race of S4's review, scratch/lanes/followups/
 * addresses-s5-must-include.md), and the ONE writer of the phone's community address (`beanpool_anchor_url`).
 *
 * Every member move (the community sheet's switch, a notice, a link, the hall, a guest visit, Settings' Switch and Add &
 * Connect, joining another community, Leave and Delete, the update screen's switch and leave, a claim, a door, a restore,
 * a re-key, a wipe) writes the address only through `writeCommunityAddress` below, inside `whileCommunityMoves`; so does the
 * address check's own move (address-verify.ts: a second record's copy and rows, the record write, the move, the rows
 * following). utils/__tests__/community-address-writer.test.ts reads the app's source and fails on any other write of it.
 *
 * Why: a move closes the community's copy first and waits there for the sync lock (db.ts closeDB) before it writes the
 * new address. A check that read the address in that wait read the OLD one and could follow, or remove a second record's
 * copy, for a community the member was leaving (after a Leave: back into the community just left, at its new address).
 * Now each move holds the lock from before it closes the copy until the next copy is open, the check's writing steps wait
 * for it to finish, then read the address again (the member moved: nothing goes, nothing moves), and a move tapped while
 * the check writes waits a moment for it (local writes only: the check holds the lock for no network ask).
 *
 * Not re-entrant by itself: a step that already holds the lock and moves the phone passes the `held` it was given
 * (address-verify.ts moveTo, reconnect.ts switchPhoneTo), so it never waits for itself.
 */

import { assertPlainNodeAddress } from './node-url';

/** The phone's community address. Read anywhere; written only by {@link writeCommunityAddress}. */
const ANCHOR_KEY = 'beanpool_anchor_url';

declare const heldMark: unique symbol;

/** Proof that the caller holds the lock: passed on to a move made inside it. Only `whileCommunityMoves` makes one. */
export interface CommunityMoveHeld {
    readonly [heldMark]: true;
}

const HELD = Object.freeze({}) as CommunityMoveHeld;

let tail: Promise<void> = Promise.resolve();
/** A move is running now (its task started and has not settled). */
let moving = false;

/** `task` runs once every move started before it has finished, and no other starts until it has. Its result, or its throw. */
export function whileCommunityMoves<T>(task: (held: CommunityMoveHeld) => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
        moving = true;
        try {
            return await task(HELD);
        } finally {
            moving = false;
        }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
}

/** Whether a move holds the lock now (a test reads it at the moment the address is written). */
export function communityMoveUnderWay(): boolean {
    return moving;
}

/** The storage the address lives in: the app's, or a test's (a move that only writes, or only takes it off, hands what it uses). */
export interface CommunityAddressStorage {
    setItem?(key: string, value: string): Promise<void>;
    removeItem?(key: string): Promise<void>;
}

/**
 * THE one write of the phone's community address: `url`, or none (null). Only inside a move: `held` is the proof
 * `whileCommunityMoves` gave, and a write made with none, or after its move ended, throws before anything is written.
 * The caller closes and opens the copies around it (inside the same move) and says so after (community-switch.ts).
 */
export async function writeCommunityAddress(held: CommunityMoveHeld, url: string | null, storage?: CommunityAddressStorage): Promise<void> {
    if (held !== HELD || !moving) throw new Error('The community address is written only inside a community move (community-move-lock.ts).');
    // Only a plain host[:port] becomes the phone's community (node-url.ts): each caller checks first, and this is the write's own.
    if (url !== null) assertPlainNodeAddress(url);
    // Loaded here, so the code (and tests) that only take the lock never load the app's storage.
    const store = storage ?? (await import('@react-native-async-storage/async-storage')).default;
    if (url === null) {
        if (!store.removeItem) throw new Error('This storage cannot take the community address off.');
        await store.removeItem(ANCHOR_KEY);
    } else {
        if (!store.setItem) throw new Error('This storage cannot write the community address.');
        await store.setItem(ANCHOR_KEY, url);
    }
}

/** A move that is the write alone (no copy to close or open): the lock taken for it, then the one write. */
export function moveCommunityAddress(url: string | null, storage?: CommunityAddressStorage): Promise<void> {
    return whileCommunityMoves((held) => writeCommunityAddress(held, url, storage));
}
