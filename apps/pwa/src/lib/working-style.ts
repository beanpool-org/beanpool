import { archetypeIsAfter, archetypeIsNewer, archetypeToCarry, newestArchetype, parseArchetype, publicArchetype, type QuizResult } from '@beanpool/core';
import { accountEpochHolds } from './account-epoch';
import { checkMembership, getMemberProfile, updateMemberProfile } from './api';

/**
 * The member's working style in this browser (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1): the same
 * copy the phone keeps, beside the account. A browser is in one community, so the copy's job here is to show the newest
 * result and to carry it to that community at a Save; the phone carries it on to the others.
 *
 * It goes with the account: every sign-out and delete clears localStorage (lib/device-prefs.ts clearAccountStorage), and it
 * isn't one of the keys that survive. Keyed by the account as well, so it is never read for another key. Leaving a
 * community keeps it: it is the account's. There is no central copy: nothing here reaches any address but this community's.
 */

const storeKey = (publicKey: string) => `bp_working_style_${publicKey}`;

/** The day (UTC) the member removed their working style, while this browser's community is still to be told; else absent. */
const removedKey = (publicKey: string) => `bp_working_style_removed_${publicKey}`;

/** This browser's copy of the member's result, or null. */
export function readWorkingStyle(publicKey: string): string | null {
    try {
        return localStorage.getItem(storeKey(publicKey));
    } catch {
        return null;
    }
}

/**
 * The quiz is done: its result is this browser's now. Not after a sign-out in another tab (lib/account-epoch.ts). Answers
 * the public form, for the page to show until it reads the row again.
 */
export function keepQuizResult(publicKey: string, result: QuizResult): string {
    if (accountEpochHolds()) {
        try {
            localStorage.setItem(storeKey(publicKey), JSON.stringify(result));
            // A retake stands over a removal still waiting to reach the community.
            localStorage.removeItem(removedKey(publicKey));
        } catch { /* private mode: the row still has it */ }
    }
    return publicArchetype(result);
}

/**
 * Publish a quiz result to this community, in its public form, once the community says this key is a member: a browser
 * looking around as a guest keeps the result and sends it nowhere. Answers what the community answered, or null for no
 * publish. Throws what a refused or failed request throws, as the screens expect.
 */
export async function publishQuizResult(publicKey: string, result: QuizResult): Promise<Awaited<ReturnType<typeof updateMemberProfile>> | null> {
    const { isMember } = await checkMembership(publicKey);
    if (isMember !== true) return null;
    return updateMemberProfile(publicKey, { archetype: publicArchetype(result) });
}

/** What a Save carries of the working style, given the row the community holds: this browser's copy when it is newer. */
export function workingStyleToCarry(publicKey: string, row: string | null | undefined): string | null {
    return archetypeToCarry(readWorkingStyle(publicKey), row);
}

/** The day a removal waits to reach the community, or null. */
function removalWaiting(publicKey: string): string | null {
    try {
        return localStorage.getItem(removedKey(publicKey));
    } catch {
        return null;
    }
}

/**
 * The working style to show as the member's own: the community's row or this browser's copy, whichever is newer. While a
 * removal waits to reach the community, its row is a result the member took off, and shows nothing unless it was taken after.
 */
export function shownWorkingStyle(publicKey: string, row: string | null | undefined): string | null {
    const removedOn = removalWaiting(publicKey);
    const community = removedOn && row && !archetypeIsAfter(row, removedOn) ? null : row;
    return newestArchetype(community ?? null, readWorkingStyle(publicKey));
}

/**
 * Remove my working style (DESIGN-archetype-across-fable.md §3, S3): this browser's copy goes, and the community is told
 * with a null. A browser is in one community, so the removal waits here (a marker beside the copy) until the community has
 * it: `deliverRemoval` sends it at once, and again whenever the profile row is read, until the community has said so. A
 * browser looking around as a guest sends nothing. Never throws.
 */
export async function removeWorkingStyle(publicKey: string): Promise<void> {
    if (!accountEpochHolds()) return;
    try {
        localStorage.removeItem(storeKey(publicKey));
        localStorage.setItem(removedKey(publicKey), new Date().toISOString().slice(0, 10));
    } catch { /* private mode: the row below is still told */ }
    await deliverRemoval(publicKey, undefined);
}

/**
 * Tell the community of a waiting removal, given the row it holds (undefined to ask it). A community that holds none, or one
 * taken after the removal, needs nothing sent, and the removal stops waiting; one that can't be reached keeps it waiting.
 * Answers whether a removal still waits.
 */
export async function deliverRemoval(publicKey: string, row: string | null | undefined): Promise<boolean> {
    const removedOn = removalWaiting(publicKey);
    if (!removedOn || !accountEpochHolds()) return false;
    try {
        const { isMember } = await checkMembership(publicKey);
        if (isMember === false) { localStorage.removeItem(removedKey(publicKey)); return false; }
        if (isMember !== true) return true;
        const held = row === undefined ? (await getMemberProfile(publicKey, publicKey))?.archetype ?? null : row;
        if (held && !archetypeIsAfter(held, removedOn)) await updateMemberProfile(publicKey, { archetype: null });
        localStorage.removeItem(removedKey(publicKey));
        return false;
    } catch {
        return true;
    }
}

/**
 * Adopt `row` into this browser's copy when it is newer than the current browser copy.
 * Older never overwrites newer, and a tie changes nothing. An old millisecond stamp read
 * here is reduced to a date before it goes anywhere.
 */
export function adoptWorkingStyle(publicKey: string, row: string | null | undefined): boolean {
    if (!publicKey || !row) return false;
    // While a removal waits, the row is the result the member took off: only one taken after it is adopted.
    const removedOn = removalWaiting(publicKey);
    if (removedOn && !archetypeIsAfter(row, removedOn)) return false;
    const current = readWorkingStyle(publicKey);
    if (!archetypeIsNewer(row, current)) return false;
    if (!accountEpochHolds()) return false;
    const parsed = parseArchetype(row);
    if (!parsed) return false;
    try {
        const sanitized = { ...parsed };
        delete (sanitized as any).updatedAt;
        localStorage.setItem(storeKey(publicKey), JSON.stringify(sanitized));
        return true;
    } catch {
        return false;
    }
}
