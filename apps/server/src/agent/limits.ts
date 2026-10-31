/**
 * Limits per agent grant, kept by the server (admin MCP design §2): 60 calls a minute and 2,000 a day, answered 429 in
 * words past either; lists of at most 50 rows; at most 2 backups a day; at most the owners' "Assistant posts a day" made
 * by an owner's assistant (agent/owner-posts.ts), and 200 photos fetched or uploaded for it (agent/owner-photos.ts). Counted in memory by grant id: a restart starts the counts again, which
 * an assistant cannot cause.
 */
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';

export const AGENT_CALLS_PER_MINUTE = 60;
export const AGENT_CALLS_PER_DAY = 2000;
export const AGENT_BACKUPS_PER_DAY = 2;
export const AGENT_LIST_MAX = 50;
/**
 * Offers, Needs, events and enterprise listings one owner's assistant may make in a UTC day (on top of the calls above): an
 * owners' setting, "Assistant posts a day" (Marty, 30 Oct: 100 by default, up to 1,000 for seeding a community), kept in
 * this server's local config, read on every post, so a change takes effect at once.
 */
export const AGENT_POSTS_PER_DAY_DEFAULT = 100;
export const AGENT_POSTS_PER_DAY_MIN = 1;
export const AGENT_POSTS_PER_DAY_MAX = 1000;
/** Edits of its own posts one owner's assistant may make in a UTC day (design §2.8: update_post, agent/owner-posts.ts). */
export const AGENT_EDITS_PER_DAY = 200;
/** remove_all_i_made, once a UTC day per grant (design §2.8); the owner's own "Remove its posts" in Settings is not held to it. */
export const AGENT_REMOVE_ALLS_PER_DAY = 1;
/**
 * Photos one owner's assistant may have this server fetch (photo_urls) or take as an upload (POST /mcp/photos) in a UTC day,
 * the two together (design §2.8: 200 photo fetches; slice S4, agent/owner-photos.ts). Each one tried counts, whether or not
 * it gave a photo: the work was done.
 */
export const AGENT_PHOTOS_PER_DAY = 200;

/** Whether a value is a day's number the owners may set: a whole number from 1 to 1,000. */
export function isAgentPostsPerDay(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= AGENT_POSTS_PER_DAY_MIN && v <= AGENT_POSTS_PER_DAY_MAX;
}

/** The owners' "Assistant posts a day" now (a stored value out of range reads as the default). */
export function agentPostsPerDay(): number {
    const v = getLocalConfig().agentPostsPerDay;
    return isAgentPostsPerDay(v) ? v : AGENT_POSTS_PER_DAY_DEFAULT;
}

export function setAgentPostsPerDay(n: number): void {
    if (!isAgentPostsPerDay(n)) throw new Error(`Assistant posts a day is a whole number from ${AGENT_POSTS_PER_DAY_MIN} to ${AGENT_POSTS_PER_DAY_MAX}`);
    updateLocalConfig({ agentPostsPerDay: n });
}

const MINUTE_MS = 60_000;

interface Counts {
    minuteFrom: number;
    minute: number;
    day: string;
    dayCalls: number;
    dayBackups: number;
    dayCreates: number;
    dayEdits: number;
    dayRemoveAlls: number;
    dayPhotos: number;
}

const counts = new Map<string, Counts>();
/** Every grant's calls today together, for the owners' daily line (design §8): kept when a grant is revoked. */
let nodeDay = '';
let nodeDayCalls = 0;

function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
}

function countsOf(grantId: string, now: number): Counts {
    let c = counts.get(grantId);
    const day = utcDay(now);
    if (!c) {
        c = { minuteFrom: now, minute: 0, day, dayCalls: 0, dayBackups: 0, dayCreates: 0, dayEdits: 0, dayRemoveAlls: 0, dayPhotos: 0 };
        counts.set(grantId, c);
    }
    if (c.day !== day) {
        c.day = day;
        c.dayCalls = 0;
        c.dayBackups = 0;
        c.dayCreates = 0;
        c.dayEdits = 0;
        c.dayRemoveAlls = 0;
        c.dayPhotos = 0;
    }
    if (now - c.minuteFrom >= MINUTE_MS) {
        c.minuteFrom = now;
        c.minute = 0;
    }
    return c;
}

export type Admission = { ok: true } | { ok: false; error: string; retryAfterSeconds: number };

/** Count one call to /mcp, or refuse it past the minute's or the day's limit (the refused call is not counted). */
export function admitAgentCall(grantId: string, now = Date.now()): Admission {
    const c = countsOf(grantId, now);
    if (c.dayCalls >= AGENT_CALLS_PER_DAY) {
        const tomorrow = Date.parse(`${c.day}T00:00:00.000Z`) + 24 * 60 * MINUTE_MS;
        return {
            ok: false,
            error: `This assistant has made ${AGENT_CALLS_PER_DAY} calls today, the most a day allows: try again tomorrow (UTC).`,
            retryAfterSeconds: Math.max(1, Math.ceil((tomorrow - now) / 1000)),
        };
    }
    if (c.minute >= AGENT_CALLS_PER_MINUTE) {
        return {
            ok: false,
            error: `This assistant has made ${AGENT_CALLS_PER_MINUTE} calls in a minute, the most a minute allows: wait a moment, then go on.`,
            retryAfterSeconds: Math.max(1, Math.ceil((c.minuteFrom + MINUTE_MS - now) / 1000)),
        };
    }
    c.minute++;
    c.dayCalls++;
    if (nodeDay !== c.day) { nodeDay = c.day; nodeDayCalls = 0; }
    nodeDayCalls++;
    return { ok: true };
}

export function agentCallsToday(grantId: string, now = Date.now()): number {
    return countsOf(grantId, now).dayCalls;
}

export function agentBackupsToday(grantId: string, now = Date.now()): number {
    return countsOf(grantId, now).dayBackups;
}

/** Whether this grant may start another backup today; counts it when it may. */
export function admitAgentBackup(grantId: string, now = Date.now()): boolean {
    const c = countsOf(grantId, now);
    if (c.dayBackups >= AGENT_BACKUPS_PER_DAY) return false;
    c.dayBackups++;
    return true;
}

/** A backup that was admitted but did not start (one was running): not counted after all. */
export function returnAgentBackup(grantId: string, now = Date.now()): void {
    const c = countsOf(grantId, now);
    if (c.dayBackups > 0) c.dayBackups--;
}

export function agentCreatesToday(grantId: string, now = Date.now()): number {
    return countsOf(grantId, now).dayCreates;
}

/** Whether this grant may make another post today; counts it when it may. */
export function admitAgentCreate(grantId: string, now = Date.now()): boolean {
    const c = countsOf(grantId, now);
    if (c.dayCreates >= agentPostsPerDay()) return false;
    c.dayCreates++;
    return true;
}

/** A post that was admitted but not made (refused by the engine, a photo it could not take): not counted after all. */
export function returnAgentCreate(grantId: string, now = Date.now()): void {
    const c = countsOf(grantId, now);
    if (c.dayCreates > 0) c.dayCreates--;
}

export function agentEditsToday(grantId: string, now = Date.now()): number {
    return countsOf(grantId, now).dayEdits;
}

/** Whether this grant may edit another of its posts today; counts it when it may. */
export function admitAgentEdit(grantId: string, now = Date.now()): boolean {
    const c = countsOf(grantId, now);
    if (c.dayEdits >= AGENT_EDITS_PER_DAY) return false;
    c.dayEdits++;
    return true;
}

/** An edit that was admitted but not made: not counted after all. */
export function returnAgentEdit(grantId: string, now = Date.now()): void {
    const c = countsOf(grantId, now);
    if (c.dayEdits > 0) c.dayEdits--;
}

/** Whether this grant may run remove_all_i_made today; counts it when it may (a run that removes nothing still counts). */
export function admitAgentRemoveAll(grantId: string, now = Date.now()): boolean {
    const c = countsOf(grantId, now);
    if (c.dayRemoveAlls >= AGENT_REMOVE_ALLS_PER_DAY) return false;
    c.dayRemoveAlls++;
    return true;
}

export function agentPhotosToday(grantId: string, now = Date.now()): number {
    return countsOf(grantId, now).dayPhotos;
}

/** Whether this grant may have one more photo fetched or uploaded today; counts it when it may. */
export function admitAgentPhoto(grantId: string, now = Date.now()): boolean {
    const c = countsOf(grantId, now);
    if (c.dayPhotos >= AGENT_PHOTOS_PER_DAY) return false;
    c.dayPhotos++;
    return true;
}

/** Calls let in today (UTC) from every assistant, revoked ones included. */
export function agentCallsTodayAll(now = Date.now()): number {
    return nodeDay === utcDay(now) ? nodeDayCalls : 0;
}

/** A revoked grant's counts go with it (the node's day total keeps its calls). */
export function forgetAgentGrant(grantId: string): void {
    counts.delete(grantId);
}

/** For tests. */
export function resetAgentLimits(): void {
    counts.clear();
    nodeDay = '';
    nodeDayCalls = 0;
}
