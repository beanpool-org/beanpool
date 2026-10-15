/**
 * The day budget of the nearest-people read where `openMembership` is on (READ_LIMITS.nearestPeoplePerDay, config/
 * writer-limits.ts): each member may ask for the people nearest a point so many times in any 24 hours, so a stranger
 * can't walk the whole community 50 at a time from point after point (DESIGN-global-member-privacy-fable.md §3).
 *
 * Counted in memory per verified key, by the hour, as the gateway's day budget counts writes (gateway-rate-limit.ts): a
 * restart starts every count again, and at most NEAREST_BUDGET_MAX_KEYS keys are held (the quiet ones go first).
 */
import { READ_LIMITS } from './config/writer-limits.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;
export const NEAREST_BUDGET_MAX_KEYS = 50_000;

type DayCount = { hours: number[]; counts: number[]; total: number };
const dayCounts = new Map<string, DayCount>();

function dropPastHours(entry: DayCount, hour: number): void {
    let gone = 0;
    while (gone < entry.hours.length && entry.hours[gone] <= hour - DAY_HOURS) entry.total -= entry.counts[gone++];
    if (gone) { entry.hours.splice(0, gone); entry.counts.splice(0, gone); }
}

/** "in about 3 hours", from now to when the budget lets up. */
function inAbout(atMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((atMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * Count one nearest-people read by `key`, or refuse it: null when it is let in (and counted), else the 429 to answer,
 * with the seconds until the oldest hour counted leaves the day. A refused read isn't counted.
 */
export function chargeNearestPeopleRead(key: string, now = Date.now()): { retryAfterSec: number; body: { error: string; code: string; resetsAt: string } } | null {
    const hour = Math.floor(now / HOUR_MS);
    const limit = READ_LIMITS.nearestPeoplePerDay;
    let entry = dayCounts.get(key);
    if (entry) dropPastHours(entry, hour);
    if (entry && entry.total >= limit) {
        const resetsAtMs = (entry.hours[0] + DAY_HOURS) * HOUR_MS;
        return {
            retryAfterSec: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
            body: {
                error: `You have looked up the people near a place ${limit} times today, the most one account can in 24 hours. `
                    + `You can look again ${inAbout(resetsAtMs, now)}. Searching by name still works.`,
                code: 'nearest_people_day_budget',
                resetsAt: new Date(resetsAtMs).toISOString(),
            },
        };
    }
    if (!entry) {
        if (dayCounts.size >= NEAREST_BUDGET_MAX_KEYS) shrink(hour);
        entry = { hours: [], counts: [], total: 0 };
        dayCounts.set(key, entry);
    }
    const last = entry.hours.length - 1;
    if (last >= 0 && entry.hours[last] === hour) entry.counts[last]++;
    else { entry.hours.push(hour); entry.counts.push(1); }
    entry.total++;
    return null;
}

/** Make room: keys with nothing left in the day first, then the least used, down to 90%. */
function shrink(hour: number): void {
    for (const [k, entry] of dayCounts) {
        dropPastHours(entry, hour);
        if (entry.total <= 0) dayCounts.delete(k);
    }
    const target = Math.floor(NEAREST_BUDGET_MAX_KEYS * 0.9);
    if (dayCounts.size <= target) return;
    const smallest = [...dayCounts].sort((a, b) => a[1].total - b[1].total);
    for (let i = 0; i < smallest.length && dayCounts.size > target; i++) dayCounts.delete(smallest[i][0]);
}

/** Forget every count (tests). */
export function resetNearestPeopleBudget(): void {
    dayCounts.clear();
}
