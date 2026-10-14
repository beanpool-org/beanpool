/**
 * The day budgets of the two ways to look people up where `openMembership` is on (READ_LIMITS, config/writer-limits.ts):
 * each member may ask for the people nearest a point (`nearestPeoplePerDay`) and search people by name
 * (`peopleSearchesPerDay`) so many times each in any 24 hours, so a stranger can't walk the whole community 50 at a time
 * from point after point, nor 20 at a time from two letters after two letters (DESIGN-global-member-privacy-fable.md §3;
 * Marty's call 3, 15 Oct 2026: "a similar limit on name search").
 *
 * Counted in memory per verified key, by the hour, as the gateway's day budget counts writes (gateway-rate-limit.ts): a
 * restart starts every count again, and at most NEAREST_BUDGET_MAX_KEYS keys are held per budget (the quiet ones go first).
 */
import { READ_LIMITS } from './config/writer-limits.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_HOURS = 24;
export const NEAREST_BUDGET_MAX_KEYS = 50_000;

type DayCount = { hours: number[]; counts: number[]; total: number };
type Refusal = { retryAfterSec: number; body: { error: string; code: string; resetsAt: string } };

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
 * A day budget: count one read by `key`, or refuse it. null when it is let in (and counted), else the 429 to answer, with
 * the seconds until the oldest hour counted leaves the day. A refused read isn't counted.
 */
function dayBudget(limitOf: () => number, refusal: (limit: number, when: string) => { error: string; code: string }) {
    const dayCounts = new Map<string, DayCount>();
    /** Make room: keys with nothing left in the day first, then the least used, down to 90%. */
    const shrink = (hour: number): void => {
        for (const [k, entry] of dayCounts) {
            dropPastHours(entry, hour);
            if (entry.total <= 0) dayCounts.delete(k);
        }
        const target = Math.floor(NEAREST_BUDGET_MAX_KEYS * 0.9);
        if (dayCounts.size <= target) return;
        const smallest = [...dayCounts].sort((a, b) => a[1].total - b[1].total);
        for (let i = 0; i < smallest.length && dayCounts.size > target; i++) dayCounts.delete(smallest[i][0]);
    };
    const charge = (key: string, now = Date.now()): Refusal | null => {
        const hour = Math.floor(now / HOUR_MS);
        const limit = limitOf();
        let entry = dayCounts.get(key);
        if (entry) dropPastHours(entry, hour);
        if (entry && entry.total >= limit) {
            const resetsAtMs = (entry.hours[0] + DAY_HOURS) * HOUR_MS;
            return {
                retryAfterSec: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
                body: { ...refusal(limit, inAbout(resetsAtMs, now)), resetsAt: new Date(resetsAtMs).toISOString() },
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
    };
    return { charge, reset: () => dayCounts.clear() };
}

const nearest = dayBudget(() => READ_LIMITS.nearestPeoplePerDay, (limit, when) => ({
    error: `You have looked up the people near a place ${limit} times today, the most one account can in 24 hours. `
        + `You can look again ${when}. Searching by name still works.`,
    code: 'nearest_people_day_budget',
}));

const byName = dayBudget(() => READ_LIMITS.peopleSearchesPerDay, (limit, when) => ({
    error: `You have searched for people by name ${limit} times today, the most one account can in 24 hours. `
        + `You can search again ${when}. The people you have already met are still in your lists.`,
    code: 'people_search_day_budget',
}));

/** Count one nearest-people read by `key` (READ_LIMITS.nearestPeoplePerDay), or the 429 to answer. */
export function chargeNearestPeopleRead(key: string, now = Date.now()): Refusal | null {
    return nearest.charge(key, now);
}

/** Count one search of people by name by `key` (READ_LIMITS.peopleSearchesPerDay), or the 429 to answer. */
export function chargePeopleSearch(key: string, now = Date.now()): Refusal | null {
    return byName.charge(key, now);
}

/** Forget every nearest-people count (tests). */
export function resetNearestPeopleBudget(): void {
    nearest.reset();
}

/** Forget every search-by-name count (tests). */
export function resetPeopleSearchBudget(): void {
    byName.reset();
}
