/**
 * Door work: the small piece of work a phone or a browser does before the open door makes it a member (global node
 * design §3, scratch/global-node/DESIGN-global-two-doors-fable.md). One definition for the node that issues and checks
 * it and for the apps that solve it.
 *
 * Pure JavaScript (@noble/hashes, no `node:` import), so the phone bundles it (see __tests__/barrel-is-universal.test.ts).
 * Nothing here talks to anyone: the node issues a challenge, the app solves it, the node checks it, and no server of
 * ours or anyone else's is involved, so it works the same on a stranger's node.
 *
 * ## What it is for, and what it is not
 *
 * It is NOT what keeps fake accounts out: any work an old phone finishes in seconds, a rented server finishes in a
 * fraction of one (design §3.6). It replaces "too many people joined from your network, come back tomorrow" with a
 * few seconds of the phone's time, it is backpressure when the whole node is flooded, and the node does nothing
 * expensive for a join until the client has done this.
 *
 * ## A challenge (stateless: the node stores nothing when it issues one)
 *
 *   v1.<level>.<expires>.<random>.<mac>
 *   mac = HMAC-SHA-256(workKey, "beanpool-door-work/v1|<level>|<expires>|<random>|<joining key>|<door>")
 *
 * `level` 0 to 5, `expires` in milliseconds since the epoch, `random` 16 random bytes, `mac` 32 bytes, both base64url.
 * `workKey` is the node's own, made at boot and kept in memory (never a file, never in the database), so a restart or a
 * take-over turns every outstanding challenge into one that fails the mac, and the app fetches a new one. Bound to the
 * key that asked (64 lower-case hex characters) and to the door (`words` or `sign-in`), so work done for one key or one
 * door can't be spent on another.
 *
 * ## The puzzle
 *
 * {@link DOOR_WORK_PARTS} parts. For part `i`, the smallest counter such that
 *
 *   SHA-256( SHA-256(challenge) (32 bytes) | i (1 byte) | counter (8 bytes, big-endian) | 65,536 zero bytes )
 *
 * starts with `bits = 7 + level` zero bits. The counter sits in the first 64-byte block, so every try hashes the whole
 * 64 KB again (no saved midstate skips it); on a phone that is ONE call into the platform's native SHA-256 a try, which
 * is what makes it bearable on Hermes, whose JavaScript is far too slow for a JavaScript-only puzzle. Eight parts rather
 * than one because one hash puzzle's time is all over the place; eight smaller ones average out, and give a true
 * progress count. The solver takes the smallest counter for each part, so a solution is deterministic and the shared
 * vectors (door-work-vectors.ts) hold every runtime to the same bytes.
 *
 * The node checks a solution with 8 hashes and stops at the first part that fails ({@link checkDoorWorkSolution}).
 */

import { Buffer } from 'buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const DOOR_WORK_VERSION = 'v1';
/** The puzzle's parts: each is solved on its own, and the whole is checked part by part. */
export const DOOR_WORK_PARTS = 8;
/** The zero bytes after the counter, so one try is one long native hash. */
export const DOOR_WORK_PAD_BYTES = 65_536;
/** Leading zero bits a part needs at level 0 (about 128 tries a part). Each level adds one: double the work. */
export const DOOR_WORK_BASE_BITS = 7;
export const DOOR_WORK_MAX_LEVEL = 5;
/** How long a challenge is good for: the sign-in nonce's lifetime. */
export const DOOR_WORK_TTL_MS = 10 * 60_000;

const HASH_BYTES = 32;
const PART_AT = HASH_BYTES;
const COUNTER_AT = PART_AT + 1;
const PREFIX_BYTES = COUNTER_AT + 8;
/** The bytes hashed for one try: the challenge's hash, the part, the counter, the zeros. */
export const DOOR_WORK_MESSAGE_BYTES = PREFIX_BYTES + DOOR_WORK_PAD_BYTES;

export const DOOR_WORK_DOORS = ['words', 'sign-in'] as const;
/** Which door the work is for: the 12-words door, or a sign-in with Google, Apple or Facebook. */
export type DoorWorkDoor = typeof DOOR_WORK_DOORS[number];

export function isDoorWorkDoor(value: unknown): value is DoorWorkDoor {
    return value === 'words' || value === 'sign-in';
}

const MAC_DOMAIN = 'beanpool-door-work/v1';
const RANDOM_BYTES = 16;

/** A one-try hash: native SHA-256 on the node (`node:crypto`), the phone (`expo-crypto`) and the browser (WebCrypto). */
export type DoorWorkDigestSync = (bytes: Uint8Array) => Uint8Array;
/** The same, for a platform whose native hash answers with a promise (WebCrypto, `expo-crypto`'s `digest`). */
export type DoorWorkDigest = (bytes: Uint8Array) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;

/** SHA-256 in JavaScript: right everywhere, fast only where there is a JIT. The default, and the reference. */
export const doorWorkSha256: DoorWorkDigestSync = (bytes) => sha256(bytes);

/** Leading zero bits a part needs at `level`. */
export function doorWorkBits(level: number): number {
    return DOOR_WORK_BASE_BITS + level;
}

/** About how many tries a whole solution takes at `level`, on average: for a progress estimate, nothing more. */
export function doorWorkExpectedTries(level: number): number {
    return DOOR_WORK_PARTS * 2 ** doorWorkBits(level);
}

function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function macOf(workKey: Uint8Array, level: number, expires: number, random: string, key: string, door: DoorWorkDoor): string {
    return b64url(hmac(sha256, workKey, utf8ToBytes(`${MAC_DOMAIN}|${level}|${expires}|${random}|${key}|${door}`)));
}

const KEY_RE = /^[0-9a-f]{64}$/;
const CHALLENGE_RE = /^v1\.([0-5])\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface DoorWorkChallengeParts {
    level: number;
    /** Milliseconds since the epoch. */
    expires: number;
    random: string;
    mac: string;
}

/** A challenge's parts, or null when it is not one (any other shape, a level past the cap). Checks no mac. */
export function parseDoorWorkChallenge(challenge: unknown): DoorWorkChallengeParts | null {
    if (typeof challenge !== 'string') return null;
    const m = CHALLENGE_RE.exec(challenge);
    if (!m) return null;
    const expires = Number(m[2]);
    if (!Number.isSafeInteger(expires)) return null;
    return { level: Number(m[1]), expires, random: m[3], mac: m[4] };
}

export interface MakeDoorWorkChallenge {
    /** The node's own key for its challenges (32 random bytes made at boot, kept in memory). */
    workKey: Uint8Array;
    level: number;
    /** The joining key, as the member table spells it: 64 lower-case hex characters. */
    key: string;
    door: DoorWorkDoor;
    now?: number;
    /** 16 bytes; random unless a test fixes them. */
    random?: Uint8Array;
}

/** A new challenge for `key` at the `door`, valid {@link DOOR_WORK_TTL_MS}. The node keeps nothing. */
export function makeDoorWorkChallenge(o: MakeDoorWorkChallenge): string {
    if (!Number.isInteger(o.level) || o.level < 0 || o.level > DOOR_WORK_MAX_LEVEL) throw new Error(`door work: no level ${o.level}`);
    if (!KEY_RE.test(o.key)) throw new Error('door work: the key must be 64 lower-case hex characters');
    if (!isDoorWorkDoor(o.door)) throw new Error(`door work: no door ${String(o.door)}`);
    const random = o.random ?? randomBytes(RANDOM_BYTES);
    if (random.length !== RANDOM_BYTES) throw new Error(`door work: random must be ${RANDOM_BYTES} bytes`);
    const expires = (o.now ?? Date.now()) + DOOR_WORK_TTL_MS;
    const r = b64url(random);
    return `${DOOR_WORK_VERSION}.${o.level}.${expires}.${r}.${macOf(o.workKey, o.level, expires, r, o.key, o.door)}`;
}

/**
 * Why a challenge is refused: not one at all (`malformed`); not this node's for this key at this door (`forged`: made
 * with another work key, which includes one made before this node restarted, for another key, for the other door, or
 * changed since, its level included); or past its time (`expired`).
 */
export type DoorWorkChallengeRefusal = 'malformed' | 'forged' | 'expired';

export type DoorWorkChallengeCheck =
    | { ok: true; challenge: DoorWorkChallengeParts }
    | { ok: false; reason: DoorWorkChallengeRefusal };

/** Whether this node issued `challenge` to `key` for the `door`, and it is still good. The puzzle is not checked here. */
export function checkDoorWorkChallenge(
    challenge: unknown,
    o: { workKey: Uint8Array; key: string; door: DoorWorkDoor; now?: number },
): DoorWorkChallengeCheck {
    const parts = parseDoorWorkChallenge(challenge);
    if (!parts) return { ok: false, reason: 'malformed' };
    const want = macOf(o.workKey, parts.level, parts.expires, parts.random, o.key, o.door);
    if (!sameText(want, parts.mac)) return { ok: false, reason: 'forged' };
    // A mac this node made names an expiry it set itself, so only the clock is left to check.
    if ((o.now ?? Date.now()) > parts.expires) return { ok: false, reason: 'expired' };
    return { ok: true, challenge: parts };
}

/** Equal strings, compared in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * The bytes one try hashes, with the challenge's hash in place and the part and counter zero: made once per solution
 * and reused for every try ({@link setDoorWorkTry}), so a phone allocates 64 KB once, not once a try.
 */
export function doorWorkMessage(challenge: string): Uint8Array {
    const message = new Uint8Array(DOOR_WORK_MESSAGE_BYTES);
    message.set(sha256(utf8ToBytes(challenge)), 0);
    return message;
}

/** Whether `value` is a counter a solution may hold: a whole number from 0 to 2^53 - 1. */
export function isDoorWorkCounter(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Put part `part` and `counter` (8 bytes, big-endian) into a message from {@link doorWorkMessage}. */
export function setDoorWorkTry(message: Uint8Array, part: number, counter: number): void {
    message[PART_AT] = part;
    const high = Math.floor(counter / 0x1_0000_0000);
    const low = counter >>> 0;
    message[COUNTER_AT] = high >>> 24;
    message[COUNTER_AT + 1] = (high >>> 16) & 0xff;
    message[COUNTER_AT + 2] = (high >>> 8) & 0xff;
    message[COUNTER_AT + 3] = high & 0xff;
    message[COUNTER_AT + 4] = low >>> 24;
    message[COUNTER_AT + 5] = (low >>> 16) & 0xff;
    message[COUNTER_AT + 6] = (low >>> 8) & 0xff;
    message[COUNTER_AT + 7] = low & 0xff;
}

/** Whether a try's hash starts with `bits` zero bits. */
export function meetsDoorWorkBits(digest: Uint8Array, bits: number): boolean {
    const whole = bits >>> 3;
    for (let i = 0; i < whole; i++) if (digest[i] !== 0) return false;
    const rest = bits & 7;
    return rest === 0 || (digest[whole] >>> (8 - rest)) === 0;
}

export interface DoorWorkSolutionCheck {
    ok: boolean;
    /** How many 64 KB hashes the check made: at most {@link DOOR_WORK_PARTS}, and 1 for a solution wrong at its first part. */
    hashes: number;
}

/**
 * Whether `counters` solve `challenge` (its puzzle only: the mac, the key, the door and the time are
 * {@link checkDoorWorkChallenge}'s). Stops at the first part that fails, so junk costs one hash. `digest` is the
 * platform's native SHA-256 where there is one (the node passes `node:crypto`'s).
 */
export function checkDoorWorkSolution(challenge: string, counters: unknown, digest: DoorWorkDigestSync = doorWorkSha256): DoorWorkSolutionCheck {
    const parts = parseDoorWorkChallenge(challenge);
    if (!parts || !Array.isArray(counters) || counters.length !== DOOR_WORK_PARTS || !counters.every(isDoorWorkCounter)) {
        return { ok: false, hashes: 0 };
    }
    const bits = doorWorkBits(parts.level);
    const message = doorWorkMessage(challenge);
    let hashes = 0;
    for (let part = 0; part < DOOR_WORK_PARTS; part++) {
        setDoorWorkTry(message, part, counters[part]);
        hashes++;
        if (!meetsDoorWorkBits(digest(message), bits)) return { ok: false, hashes };
    }
    return { ok: true, hashes };
}

/** Solve a challenge in one go, with a synchronous hash: for a node's tests and a worker thread, never a screen's thread. */
export function solveDoorWorkSync(challenge: string, digest: DoorWorkDigestSync = doorWorkSha256): number[] {
    const parts = parseDoorWorkChallenge(challenge);
    if (!parts) throw new Error('door work: not a challenge');
    const bits = doorWorkBits(parts.level);
    const message = doorWorkMessage(challenge);
    const counters: number[] = [];
    for (let part = 0; part < DOOR_WORK_PARTS; part++) {
        let counter = 0;
        for (; ; counter++) {
            setDoorWorkTry(message, part, counter);
            if (meetsDoorWorkBits(digest(message), bits)) break;
        }
        counters.push(counter);
    }
    return counters;
}

export interface SolveDoorWork {
    /** The platform's SHA-256: `expo-crypto` on the phone, WebCrypto in a browser's worker. */
    digest: DoorWorkDigest;
    /** Hash for about this long, then let the screen breathe (a zero-delay timer). Default 8 ms. */
    sliceMs?: number;
    /** After each part: how many are done, of {@link DOOR_WORK_PARTS}. */
    onPart?: (done: number, of: number) => void;
    /** Asked between tries: true stops the work, and the solve answers null. */
    cancelled?: () => boolean;
}

/**
 * Solve a challenge without holding the screen: hashes in short slices and yields between them, so typing a name
 * stays smooth while the work runs. Null when `cancelled` said stop. Gives the same counters as
 * {@link solveDoorWorkSync}: the smallest for each part.
 */
export async function solveDoorWork(challenge: string, o: SolveDoorWork): Promise<number[] | null> {
    const parts = parseDoorWorkChallenge(challenge);
    if (!parts) throw new Error('door work: not a challenge');
    const bits = doorWorkBits(parts.level);
    const sliceMs = o.sliceMs ?? 8;
    const message = doorWorkMessage(challenge);
    const counters: number[] = [];
    let sliceStart = Date.now();
    for (let part = 0; part < DOOR_WORK_PARTS; part++) {
        let counter = 0;
        for (; ; counter++) {
            if (o.cancelled?.()) return null;
            setDoorWorkTry(message, part, counter);
            const out = await o.digest(message);
            if (meetsDoorWorkBits(out instanceof Uint8Array ? out : new Uint8Array(out), bits)) break;
            if (Date.now() - sliceStart >= sliceMs) {
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                sliceStart = Date.now();
            }
        }
        counters.push(counter);
        o.onPart?.(part + 1, DOOR_WORK_PARTS);
    }
    return counters;
}
