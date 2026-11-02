import { archetypeToCarry, publicArchetype, type QuizResult } from '@beanpool/core';
import { getCanonicalProfile, saveCanonicalProfile } from './canonical-profile';
import { fetchMembership } from './membership-probe';
import { plainOriginOf } from './node-url';
import { getSavedNodes, isGuestNode } from './nodes';
import { clearWaitingArchetype, keepWaitingArchetype, waitingArchetype } from './pending-profile-sync';

/**
 * The member's working style: taken once, on the device, and carried to each community by the device
 * (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1). There is no central copy: the result lives in the
 * phone's canonical profile and in each community's own row, and no node ever learns it from another.
 *
 * The canonical `archetype` is "my result", and only the quiz writes it here. A row, which any sync or Save can rewrite,
 * never does: that is how an older row used to overwrite a newer result.
 *
 * What a community is sent is always core's publicArchetype, and only through three lines:
 *   - the quiz, to the community open now (app/public-profile.tsx);
 *   - a Save or a catch-up publish, carrying what waits there or a device copy newer than the row (archetypeToSend);
 *   - the heal at that community's own next sync, carrying only the result (db.ts pushWaitingArchetype).
 */

/** How long a community is given to say who its members are: as long as the delete's own ask (delete-here.ts). */
const MEMBERSHIP_TIMEOUT_MS = 8000;

/**
 * The quiz is done: its result is the device's now, and it waits for every other community saved on the phone. Not for
 * a guest visit: the member isn't in that one, and a community they join later gets the result at the join.
 */
export async function keepQuizResult(result: QuizResult, publicKey: string, openCommunity: string | null): Promise<void> {
    await saveCanonicalProfile({ archetype: JSON.stringify(result) });
    const archetype = publicArchetype(result);
    for (const node of await getSavedNodes()) {
        if (plainOriginOf(node.url) === plainOriginOf(openCommunity)) continue;
        if (await isGuestNode(node.url).catch(() => true)) continue;
        await keepWaitingArchetype(node.url, publicKey, archetype);
    }
}

/**
 * What of the working style a publish to `community` may carry: what waits there, or the device copy when it is newer
 * than `row`, the community's own row (core archetypeToCarry). Null for nothing, which is what a member who never took
 * the quiz always gets.
 *
 * Only to a community that has just said this key is a member. The phone's saved list holds addresses it merely looked
 * at, and a row it holds may be older than a removal, so neither proves it. No answer sends nothing now, and the next
 * publish asks again. A plain no: what waited there goes, and a later join carries the result.
 */
export async function archetypeToSend(community: string, publicKey: string, row: string | null | undefined): Promise<string | null> {
    const waiting = await waitingArchetype(community, publicKey);
    const canonical = await getCanonicalProfile();
    const archetype = waiting ?? archetypeToCarry(canonical?.archetype, row);
    if (!archetype) return null;
    if (await isGuestNode(community).catch(() => true)) return null;
    const member = await saysMember(community, publicKey);
    if (member === false && waiting) await clearWaitingArchetype(community, waiting);
    return member === true ? archetype : null;
}

/** What `community` says of the key, asked as every probe asks (membership-probe.ts): null for no answer. Never throws. */
async function saysMember(community: string, publicKey: string): Promise<boolean | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);
    try {
        const res = await fetchMembership(community, publicKey, controller.signal);
        if (!res.ok) return null;
        const { isMember, isRecovering } = (await res.json()) as { isMember?: unknown; isRecovering?: unknown };
        if (isMember === true || isRecovering === true) return true;
        return isMember === false ? false : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
