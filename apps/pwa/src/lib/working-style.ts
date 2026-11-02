import { archetypeIsNewer, archetypeToCarry, parseArchetype, publicArchetype, type QuizResult } from '@beanpool/core';
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
        try { localStorage.setItem(storeKey(publicKey), JSON.stringify(result)); } catch { /* private mode: the row still has it */ }
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

/**
 * Adopt `row` into this browser's copy when it is newer than the current browser copy.
 * Older never overwrites newer, and a tie changes nothing. An old millisecond stamp read
 * here is reduced to a date before it goes anywhere.
 */
export function adoptWorkingStyle(publicKey: string, row: string | null | undefined): boolean {
    if (!publicKey || !row) return false;
    const current = readWorkingStyle(publicKey);
    if (!archetypeIsNewer(row, current)) return false;
    if (!accountEpochHolds()) return false;
    const parsed = parseArchetype(row);
    if (!parsed) return false;
    try {
        localStorage.setItem(storeKey(publicKey), JSON.stringify(parsed));
        return true;
    } catch {
        return false;
    }
}

/**
 * At web open, adopt the community's row into the browser copy when the row is newer.
 * Safe to run on every open. Older never overwrites newer; a tie changes nothing.
 */
export async function reconcileWorkingStyleAtOpen(publicKey: string): Promise<boolean> {
    if (!publicKey) return false;
    try {
        const profile = await getMemberProfile(publicKey, publicKey);
        if (profile?.archetype) {
            return adoptWorkingStyle(publicKey, profile.archetype);
        }
    } catch {
        // Offline or not a member: what is in localStorage stands.
    }
    return false;
}

