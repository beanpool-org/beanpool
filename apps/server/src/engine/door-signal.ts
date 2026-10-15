// The door's signal (global two-doors design §4, scratch/global-node/DESIGN-global-two-doors-fable.md): how much work
// a join asks for (door work, @beanpool/core door-work.ts), and the only refusals left at the door for a network.
//
// It replaces the old sign-up limit, 5 an hour and 20 a day per address, which turned a hall on one Wi-Fi away after
// its fifth person. Now joins from one address raise the work in steps instead, and the only refusals are ceilings
// for rates no honest network reaches, with the sign-in door still open beside the 12-words one.
//
// ## The inputs
//
//   - Per address (an IPv4 address, or an IPv6 /64: the limiter's key, client-ip.ts), from `open_joins.ip_hash`, which
//     is the door's keyed hash of it and is kept a day (engine/open-join.ts): joins in the last hour and the last day,
//     both doors, read on the index the old limit used.
//   - Node-wide: 12-words joins on the whole node in the last 10 minutes, counted in memory (`noteWordsJoin`). A restart
//     resets it, which only ever lowers the level. The only input that sees someone who uses a new address per account.
//   - Removed lately from this network: a member removed within a day of joining keeps their row's address hash for 7
//     days instead of 1 (`noteRemovedNewcomer`, design §2.4), and a 12-words join from that network starts at the top of
//     what a network alone reaches. Never a self-deletion. The hash never travels, so a standby or a take-over starts
//     without it, as it starts every limit again.
//
// ## The numbers
//
// `DOOR_NUMBERS`, per profile (the same on both today: the door is only open where the ledger has never moved, and a
// local node opens it only by override). Each can be overridden by a `node_config` row `doorNumbers.<name>`: a whole
// number, or for the step lists the thresholds comma-separated, rising (`doorNumbers.networkSteps` = `10,30,100,200`).
// A value that is not one is logged once and the default kept. The rows are this server's own: neither a standby's copy
// nor the take-over bundle carries them, so after a failover the door runs on the defaults until set again.
//
// The ceilings count each door's own joins: a flood of 12-words accounts from one address never shuts the sign-in door
// there, and the reverse.

import { DOOR_WORK_MAX_LEVEL, type DoorWorkDoor } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeProfile, type NodeProfile } from '../config/node-profile.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `open_joins.provider` for a member who came in through the 12-words door. */
export const WORDS_PROVIDER = 'words';

export interface DoorNumbers {
    /** The Nth join from one address in an hour (both doors, this one included) at which each network step starts. */
    networkSteps: number[];
    /** The Nth 12-words join on the whole node in 10 minutes (this one included) at which each node step starts. */
    nodeSteps: number[];
    /** The sign-in door asks no work of an address's joins in an hour before this one (today's flow, untouched). */
    signInWorkFrom: number;
    /** From there, the sign-in door's level is the network steps less this many: a provider account is its cost. */
    signInDiscount: number;
    /** The lowest level of a 12-words join from a network a newcomer was removed from in the last 7 days. */
    removedNetworkLevel: number;
    /** The ceilings per address, by door: past one, 429 `network_busy`. */
    wordsPerHour: number;
    wordsPerDay: number;
    signInPerHour: number;
    signInPerDay: number;
}

const GLOBAL_NUMBERS: DoorNumbers = {
    networkSteps: [10, 30, 100, 200],
    nodeSteps: [500, 2_000, 5_000],
    signInWorkFrom: 30,
    signInDiscount: 2,
    removedNetworkLevel: 4,
    wordsPerHour: 500,
    wordsPerDay: 2_000,
    signInPerHour: 1_000,
    signInPerDay: 5_000,
};

export const DOOR_NUMBERS: Readonly<Record<NodeProfile, Readonly<DoorNumbers>>> = {
    global: GLOBAL_NUMBERS,
    local: GLOBAL_NUMBERS,
};

export const DOOR_NUMBERS_PREFIX = 'doorNumbers.';
const LISTS = new Set<keyof DoorNumbers>(['networkSteps', 'nodeSteps']);

const warned = new Set<string>();
function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn(message);
}

function parseWhole(raw: string): number | null {
    const v = raw.trim();
    return /^\d{1,9}$/.test(v) ? Number(v) : null;
}

/** Rising whole numbers above 0, as many as the default has: anything else is not a step list. */
function parseSteps(raw: string, length: number): number[] | null {
    const parts = raw.split(',').map(parseWhole);
    if (parts.length !== length || parts.some((p) => p === null || p < 1)) return null;
    const steps = parts as number[];
    return steps.every((s, i) => i === 0 || s > steps[i - 1]) ? steps : null;
}

/** The numbers the door runs on here: the profile's defaults with this server's `node_config` overrides. Read per request. */
export function doorNumbers(profile: NodeProfile = getNodeProfile()): DoorNumbers {
    const numbers: DoorNumbers = { ...DOOR_NUMBERS[profile], networkSteps: [...DOOR_NUMBERS[profile].networkSteps], nodeSteps: [...DOOR_NUMBERS[profile].nodeSteps] };
    const rows = db.prepare('SELECT key, value FROM node_config WHERE substr(key, 1, ?) = ?')
        .all(DOOR_NUMBERS_PREFIX.length, DOOR_NUMBERS_PREFIX) as { key: string; value: unknown }[];
    for (const { key, value } of rows) {
        const name = key.slice(DOOR_NUMBERS_PREFIX.length) as keyof DoorNumbers;
        if (!(name in numbers)) {
            warnOnce(`⚠️  node_config ${key} is not one of the door's numbers, so it is ignored. They are: ${Object.keys(numbers).join(', ')}.`);
            continue;
        }
        const raw = String(value);
        if (LISTS.has(name)) {
            const steps = parseSteps(raw, (numbers[name] as number[]).length);
            if (steps) (numbers as any)[name] = steps;
            else warnOnce(`⚠️  node_config ${key}=${JSON.stringify(raw)} is not ${(numbers[name] as number[]).length} rising whole numbers, so the default is kept.`);
        } else {
            const n = parseWhole(raw);
            if (n !== null) (numbers as any)[name] = n;
            else warnOnce(`⚠️  node_config ${key}=${JSON.stringify(raw)} is not a whole number, so the default is kept.`);
        }
    }
    return numbers;
}

// ── Node-wide: 12-words joins in the last 10 minutes, in memory ──────────────────────────────

const NODE_WINDOW_MINUTES = 10;
/** Joins per minute (minutes since the epoch), the last ten minutes' only. */
const wordsJoinsByMinute = new Map<number, number>();

function pruneMinutes(nowMinute: number): void {
    for (const minute of wordsJoinsByMinute.keys()) if (minute <= nowMinute - NODE_WINDOW_MINUTES) wordsJoinsByMinute.delete(minute);
}

/** One more 12-words join on this node (after it is written). */
export function noteWordsJoin(now = Date.now(), count = 1): void {
    const minute = Math.floor(now / MINUTE_MS);
    pruneMinutes(minute);
    wordsJoinsByMinute.set(minute, (wordsJoinsByMinute.get(minute) ?? 0) + count);
}

/** 12-words joins on this node in the last 10 minutes (since this process started). */
export function wordsJoinsLately(now = Date.now()): number {
    const minute = Math.floor(now / MINUTE_MS);
    pruneMinutes(minute);
    let total = 0;
    for (const n of wordsJoinsByMinute.values()) total += n;
    return total;
}

export function _resetWordsJoinsForTests(): void {
    wordsJoinsByMinute.clear();
}

// ── Per address ─────────────────────────────────────────────────────────────────────────────

export interface AddressJoins {
    /** Both doors, last hour: the network steps. */
    hour: number;
    wordsHour: number;
    wordsDay: number;
    signInHour: number;
    signInDay: number;
}

/** Joins from this address, by door and window. A row whose address hash was cleared is no longer any address's. */
export function addressJoins(ipHash: string, now = Date.now()): AddressJoins {
    const hourAgo = new Date(now - HOUR_MS).toISOString();
    const row = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN joined_at >= @hourAgo THEN 1 ELSE 0 END), 0) AS hour,
               COALESCE(SUM(CASE WHEN provider = @words AND joined_at >= @hourAgo THEN 1 ELSE 0 END), 0) AS wordsHour,
               COALESCE(SUM(CASE WHEN provider = @words THEN 1 ELSE 0 END), 0) AS wordsDay,
               COALESCE(SUM(CASE WHEN provider != @words AND joined_at >= @hourAgo THEN 1 ELSE 0 END), 0) AS signInHour,
               COALESCE(SUM(CASE WHEN provider != @words THEN 1 ELSE 0 END), 0) AS signInDay
        FROM open_joins
        WHERE ip_hash = @ipHash AND joined_at >= @dayAgo
    `).get({ ipHash, hourAgo, dayAgo: new Date(now - DAY_MS).toISOString(), words: WORDS_PROVIDER }) as AddressJoins;
    return row;
}

/** Whether a newcomer was removed from this network lately (`noteRemovedNewcomer`): its hash is still kept for that. */
export function removedLatelyFrom(ipHash: string, now = Date.now()): boolean {
    return !!db.prepare('SELECT 1 FROM open_joins WHERE ip_hash = ? AND ip_kept_until > ? LIMIT 1').get(ipHash, new Date(now).toISOString());
}

function stepsReached(count: number, steps: readonly number[]): number {
    let reached = 0;
    for (const s of steps) if (count >= s) reached++;
    return reached;
}

export interface DoorLevel {
    /** The work level a join asks for here now, or null for none (the sign-in door at ordinary rates). */
    level: number | null;
    networkSteps: number;
    nodeSteps: number;
    removedNetwork: boolean;
    joinsThisHour: number;
}

/**
 * What a join from this address asks for now, and why (design §4.2). The join being asked for counts: the 10th join
 * from an address in an hour is the first at network step 1 ("the first 9 do level 0, the next 20 level 1"), and the
 * 30th the first the sign-in door asks work of.
 */
export function doorLevel(door: DoorWorkDoor, ipHash: string, now = Date.now(), numbers: DoorNumbers = doorNumbers()): DoorLevel {
    const joins = addressJoins(ipHash, now);
    const nth = joins.hour + 1;
    const networkSteps = stepsReached(nth, numbers.networkSteps);
    if (door === 'sign-in') {
        // No node steps and no memory of removals: a provider account is the cost there.
        const level = nth < numbers.signInWorkFrom ? null : clamp(networkSteps - numbers.signInDiscount);
        return { level, networkSteps, nodeSteps: 0, removedNetwork: false, joinsThisHour: joins.hour };
    }
    const nodeSteps = stepsReached(wordsJoinsLately(now) + 1, numbers.nodeSteps);
    const removedNetwork = removedLatelyFrom(ipHash, now);
    let level = networkSteps + nodeSteps;
    if (removedNetwork) level = Math.max(level, numbers.removedNetworkLevel);
    return { level: clamp(level), networkSteps, nodeSteps, removedNetwork, joinsThisHour: joins.hour };
}

function clamp(level: number): number {
    return Math.max(0, Math.min(DOOR_WORK_MAX_LEVEL, level));
}

export interface DoorCeiling {
    door: DoorWorkDoor;
    /** The window that is full; when both are, the one with the longer wait. */
    window: 'hour' | 'day';
    limit: number;
    /** Until one more join from this address fits under this door's ceiling. */
    retryAfterSeconds: number;
}

/**
 * Whether this address has reached the door's ceiling (design §4.3), and when one more join fits. These are the only
 * refusals left for a network, and each counts only its own door's joins.
 */
export function doorCeilingReached(door: DoorWorkDoor, ipHash: string, now = Date.now(), numbers: DoorNumbers = doorNumbers()): DoorCeiling | null {
    const joins = addressJoins(ipHash, now);
    const [hour, day, perHour, perDay] = door === 'words'
        ? [joins.wordsHour, joins.wordsDay, numbers.wordsPerHour, numbers.wordsPerDay]
        : [joins.signInHour, joins.signInDay, numbers.signInPerHour, numbers.signInPerDay];
    let ceiling: DoorCeiling | null = null;
    for (const [window, count, limit, ms] of [['hour', hour, perHour, HOUR_MS], ['day', day, perDay, DAY_MS]] as const) {
        if (count < limit) continue;
        const wait = waitForRoom(door, ipHash, now, ms, count - limit);
        if (!ceiling || wait > ceiling.retryAfterSeconds) ceiling = { door, window, limit, retryAfterSeconds: wait };
    }
    return ceiling;
}

/** Seconds until the join at `offset` (oldest first) in the window leaves it, freeing room for one more. At least 1. */
function waitForRoom(door: DoorWorkDoor, ipHash: string, now: number, windowMs: number, offset: number): number {
    const row = db.prepare(`
        SELECT joined_at FROM open_joins
        WHERE ip_hash = ? AND joined_at >= ? AND ${door === 'words' ? 'provider = ?' : 'provider != ?'}
        ORDER BY joined_at ASC LIMIT 1 OFFSET ?
    `).get(ipHash, new Date(now - windowMs).toISOString(), WORDS_PROVIDER, offset) as { joined_at: string } | undefined;
    const leaves = row ? Date.parse(row.joined_at) + windowMs : now + windowMs;
    return Math.max(1, Math.ceil((leaves - now) / 1000));
}

// ── A removed newcomer's network (design §2.4) ───────────────────────────────────────────────

/** A member removed within this long of joining has their network remembered... */
export const REMOVED_NEWCOMER_WITHIN_MS = DAY_MS;
/** ...for this long after they joined, instead of a day. Within the 7 days the privacy policy allows for any address. */
export const REMOVED_NEWCOMER_KEEP_MS = 7 * DAY_MS;

/**
 * A member the community removed (adminPruneUser, never a self-deletion): when they joined through the open door less
 * than a day ago, keep their row's address hash for 7 days from the join instead of 1, so a 12-words join from that
 * network meanwhile starts at the top work level (`doorLevel`). Local only: `ip_kept_until` never travels, nor does the
 * hash, and stamping no `updated_at` keeps the row out of the next copy. Nothing happens when the hash is already gone.
 */
export function noteRemovedNewcomer(publicKey: string, now = Date.now()): boolean {
    const row = db.prepare('SELECT joined_at FROM open_joins WHERE member_pubkey = ? AND ip_hash IS NOT NULL').get(publicKey) as { joined_at: string } | undefined;
    const joined = row ? Date.parse(row.joined_at) : NaN;
    if (!Number.isFinite(joined) || now - joined > REMOVED_NEWCOMER_WITHIN_MS) return false;
    db.prepare('UPDATE open_joins SET ip_kept_until = ? WHERE member_pubkey = ?')
        .run(new Date(joined + REMOVED_NEWCOMER_KEEP_MS).toISOString(), publicKey);
    return true;
}
