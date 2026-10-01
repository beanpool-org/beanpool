/**
 * The node's half of door work (@beanpool/core door-work.ts; global two-doors design §3): issuing a challenge and
 * checking a solution.
 *
 * ## The work key
 *
 * 32 random bytes made when this process starts, kept in memory only: no file, nothing in the database, nothing a
 * standby copies or a take-over carries. A restart or a take-over makes every outstanding challenge fail its mac, and
 * the app fetches a new one by itself (`work_invalid`). Issuing stores nothing.
 *
 * ## Checking (before the sign-in is verified, and before anything is written)
 *
 * The mac (this node's, for the key that signed the request, at this door), the expiry, not spent before, then at most 8
 * hashes of 64 KB with `node:crypto`, stopping at the first part that fails: junk costs one hash, less than checking the
 * request's signature. A solution that checks is spent at once, kept in memory until its challenge would have expired
 * anyway (as a key vault ticket is, sso.ts): a challenge names one key and a key joins once, so the set makes "once"
 * literal rather than adding a protection, and a second submit gets a clean refusal.
 *
 * The refusals, each 400 with its code, and the same for an app: fetch a new challenge and solve again, by itself.
 *   - `work_required`: none was sent where one is needed.
 *   - `work_invalid`: not a challenge, not this node's (another key, the other door, changed, or made before a restart),
 *     or counters that do not solve it.
 *   - `work_expired`: past its ten minutes.
 *   - `work_spent`: already used for a join here.
 */
import crypto from 'node:crypto';
import {
    DOOR_WORK_PAD_BYTES,
    DOOR_WORK_PARTS,
    DOOR_WORK_TTL_MS,
    checkDoorWorkChallenge,
    checkDoorWorkSolution,
    doorWorkBits,
    makeDoorWorkChallenge,
    type DoorWorkDoor,
} from '@beanpool/core';

const workKey = new Uint8Array(crypto.randomBytes(32));

/** Native SHA-256: one 64 KB try costs tens of microseconds here, where JavaScript would cost a millisecond. */
export const nodeSha256 = (bytes: Uint8Array): Uint8Array => crypto.createHash('sha256').update(bytes).digest();

/** What `POST /api/join/work` answers with: the challenge, and what an app needs to show progress and plan its time. */
export interface IssuedDoorWork {
    challenge: string;
    level: number;
    parts: number;
    bits: number;
    size: number;
    expiresInSeconds: number;
}

/** A challenge for `key` at the `door` at `level`. Stores nothing. */
export function issueDoorWork(key: string, door: DoorWorkDoor, level: number, now = Date.now()): IssuedDoorWork {
    return {
        challenge: makeDoorWorkChallenge({ workKey, level, key, door, now }),
        level,
        parts: DOOR_WORK_PARTS,
        bits: doorWorkBits(level),
        size: DOOR_WORK_PAD_BYTES,
        expiresInSeconds: DOOR_WORK_TTL_MS / 1000,
    };
}

export type DoorWorkRefusal = 'work_required' | 'work_invalid' | 'work_expired' | 'work_spent';

export type DoorWorkCheck = { ok: true; level: number; hashes: number } | { ok: false; code: DoorWorkRefusal; hashes: number };

/** Spent challenges by their mac, until they expire. Bounded: past the cap the oldest go (each names a key that has joined). */
const spent = new Map<string, number>();
const MAX_SPENT = 50_000;

function sweepSpent(now: number): void {
    for (const [mac, expires] of spent) if (expires < now) spent.delete(mac);
    while (spent.size >= MAX_SPENT) {
        const oldest = spent.keys().next().value;
        if (oldest === undefined) break;
        spent.delete(oldest);
    }
}

/**
 * Check the work a join carries (`{ challenge, counters }`) for the key that signed it at this door, and spend it when
 * it checks. Never throws.
 */
export function checkDoorWork(work: unknown, key: string, door: DoorWorkDoor, now = Date.now()): DoorWorkCheck {
    if (!work || typeof work !== 'object') return { ok: false, code: 'work_required', hashes: 0 };
    const { challenge, counters } = work as { challenge?: unknown; counters?: unknown };
    const issued = checkDoorWorkChallenge(challenge, { workKey, key, door, now });
    if (!issued.ok) return { ok: false, code: issued.reason === 'expired' ? 'work_expired' : 'work_invalid', hashes: 0 };
    if (spent.has(issued.challenge.mac)) return { ok: false, code: 'work_spent', hashes: 0 };
    const solved = checkDoorWorkSolution(challenge as string, counters, nodeSha256);
    if (!solved.ok) return { ok: false, code: 'work_invalid', hashes: solved.hashes };
    if (spent.size >= MAX_SPENT) sweepSpent(now);
    spent.set(issued.challenge.mac, issued.challenge.expires);
    return { ok: true, level: issued.challenge.level, hashes: solved.hashes };
}

export function _clearSpentDoorWorkForTests(): void {
    spent.clear();
}
