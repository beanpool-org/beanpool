/**
 * Limits per agent grant, kept by the server (admin MCP design §2): 60 calls a minute and 2,000 a day, answered 429 in
 * words past either; lists of at most 50 rows; at most 2 backups a day. Counted in memory by grant id: a restart starts
 * the counts again, which an assistant cannot cause.
 */

export const AGENT_CALLS_PER_MINUTE = 60;
export const AGENT_CALLS_PER_DAY = 2000;
export const AGENT_BACKUPS_PER_DAY = 2;
export const AGENT_LIST_MAX = 50;

const MINUTE_MS = 60_000;

interface Counts {
    minuteFrom: number;
    minute: number;
    day: string;
    dayCalls: number;
    dayBackups: number;
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
        c = { minuteFrom: now, minute: 0, day, dayCalls: 0, dayBackups: 0 };
        counts.set(grantId, c);
    }
    if (c.day !== day) {
        c.day = day;
        c.dayCalls = 0;
        c.dayBackups = 0;
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
