import { archetypeIsNewer, archetypeToCarry, parseArchetype, publicArchetype, type QuizResult } from '@beanpool/core';
import { getCanonicalProfile, saveCanonicalProfile } from './canonical-profile';
import { buildSignedHeaders } from './crypto';
import { fetchMembership } from './membership-probe';
import { plainOriginOf } from './node-url';
import { clearGuestNode, getDatabaseFilenameForNode, getSavedNodes, isGuestNode } from './nodes';
import { clearWaitingArchetype, keepCarriedArchetype, keepWaitingArchetype, waitingArchetype, waitingEntry } from './pending-profile-sync';

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

export { clearWaitingArchetype, keepWaitingArchetype };

/**
 * Adopt a newer archetype row into the device copy and mark every other saved community
 * so the phone carries it on at their next sync (scratch/fable-design/DESIGN-archetype-across-fable.md §3 S2).
 */
export async function adoptNewerRowIntoDevice(publicKey: string, rowArchetype: string, openCommunity?: string | null): Promise<void> {
    await saveCanonicalProfile({ archetype: rowArchetype });
    const parsed = parseArchetype(rowArchetype);
    if (!parsed) return;
    const publicForm = publicArchetype(parsed);
    for (const node of await getSavedNodes()) {
        if (await onGuestVisit(node.url)) continue;
        if (openCommunity && plainOriginOf(node.url) === plainOriginOf(openCommunity)) continue;
        await keepCarriedArchetype(node.url, publicKey, publicForm);
    }
}

/**
 * First run across saved communities (scratch/fable-design/DESIGN-archetype-across-fable.md §3, slice S2):
 * - Reads each saved community's local members row for this key, plus the device copy.
 * - Orders results (including old millisecond stamps), adopting the newest into the device copy.
 * - Marks each older community's pending entry with core's publicArchetype (reducing any millisecond stamp to a date).
 * It reads the phone and asks no community, so it leaves guest marks alone: a row is no answer (healGuestMark).
 * Safe to run twice; a tie changes nothing.
 */
export async function firstRunWorkingStyle(explicitKey?: string): Promise<void> {
    let publicKey = explicitKey;
    if (!publicKey) {
        const { loadIdentity } = await import('./identity');
        const identity = await loadIdentity().catch(() => null);
        publicKey = identity?.publicKey;
    }
    if (!publicKey) return;

    const nodes = await getSavedNodes();
    if (nodes.length === 0) return;

    let newestRaw: string | null = null;
    let newestParsed: QuizResult | null = null;
    let newestOrigin: string | null = null;

    const deviceCopy = (await getCanonicalProfile())?.archetype ?? null;
    if (deviceCopy) {
        const parsed = parseArchetype(deviceCopy);
        if (parsed) {
            newestRaw = deviceCopy;
            newestParsed = parsed;
        }
    }

    const rowsByCommunity = new Map<string, string | null>();

    for (const node of nodes) {
        const filename = getDatabaseFilenameForNode(node.url);
        let handle: any = null;
        try {
            const SQLite = await import('expo-sqlite');
            handle = await SQLite.openDatabaseAsync(filename, { useNewConnection: true });
            await handle.execAsync('PRAGMA busy_timeout = 30000;');
            const row = await handle.getFirstAsync(
                'SELECT archetype FROM members WHERE public_key = ?',
                [publicKey]
            ) as { archetype?: string | null } | null;

            if (row) {
                const arch = row.archetype ?? null;
                rowsByCommunity.set(node.url, arch);
                if (arch && archetypeIsNewer(arch, newestRaw)) {
                    const parsed = parseArchetype(arch);
                    if (parsed) {
                        newestRaw = arch;
                        newestParsed = parsed;
                        newestOrigin = node.url;
                    }
                }
            }
        } catch {
            // Database not created or unreadable
        } finally {
            await handle?.closeAsync().catch(() => {});
        }
    }

    if (!newestParsed || !newestRaw) return;

    // Adopt into canonical profile if newer
    if (archetypeIsNewer(newestRaw, deviceCopy)) {
        await saveCanonicalProfile({ archetype: newestRaw });
    }

    // Mark older communities: publicArchetype cuts any millisecond stamp to a date
    const publicForm = publicArchetype(newestParsed);
    for (const node of nodes) {
        if (await onGuestVisit(node.url)) continue;
        if (newestOrigin && plainOriginOf(node.url) === plainOriginOf(newestOrigin)) continue;
        const row = rowsByCommunity.get(node.url);
        if (row === undefined) continue; // No row of theirs on the phone: only looked at
        if (archetypeIsNewer(newestRaw, row)) {
            await keepCarriedArchetype(node.url, publicKey, publicForm);
        }
    }
}

/** Whether the phone is only visiting `community`: no answer counts as a visit, so nothing goes on a guess. */
export const onGuestVisit = (community: string): Promise<boolean> => isGuestNode(community).catch(() => true);

/**
 * A guest mark on `community` goes when the community says the key is a member, and on nothing less: a row is no answer.
 * The phone writes one on a visit (Re-run Setup, after the 404) and a community open to reads lists its visitors', so a
 * row standing in for the answer sent a guest to /node-mismatch and their block list to a community they aren't in. Only
 * a community marked is asked. Never throws.
 */
export async function healGuestMark(community: string, publicKey: string): Promise<void> {
    const plain = community.replace(/\/+$/, '');
    // Marked as the visit wrote the address, with or without its trailing slash.
    const spellings = [...new Set([community, plain, `${plain}/`])];
    const marks = await Promise.all(spellings.map(onGuestVisit));
    if (!marks.includes(true) || (await saysMember(community, publicKey)) !== true) return;
    for (const url of spellings) await clearGuestNode(url);
}

/** How long a community is given to answer: as long as the delete's own ask (delete-here.ts). */
const MEMBERSHIP_TIMEOUT_MS = 8000;

/** The key a publish is signed with. */
type Signer = { publicKey: string; privateKey: string };

/**
 * The quiz is done: its result is the device's now, and it waits for every other community saved on the phone. Not for
 * a guest visit: the member isn't in that one, and a community they join later gets the result at their first publish
 * there (archetypeToSend: the device's copy is newer than an empty row). What waited there from before goes, or it would
 * go ahead of this result.
 */
export async function keepQuizResult(result: QuizResult, publicKey: string, openCommunity: string | null): Promise<void> {
    await saveCanonicalProfile({ archetype: JSON.stringify(result) });
    const archetype = publicArchetype(result);
    for (const node of await getSavedNodes()) {
        if (await onGuestVisit(node.url)) {
            const older = await waitingArchetype(node.url, publicKey);
            if (older) await clearWaitingArchetype(node.url, older);
            continue;
        }
        if (plainOriginOf(node.url) === plainOriginOf(openCommunity)) continue;
        await keepWaitingArchetype(node.url, publicKey, archetype);
    }
}

/**
 * What of the working style a publish to `community` may carry: what waits there, or the device copy when it is newer
 * than the community's row. Null for nothing, which is what a member who never took the quiz always gets. `row` is the
 * phone's copy of that row: with nothing to carry over it, no community is asked anything.
 *
 * Only to a community that has just said this key is a member. The phone's saved list holds addresses it merely looked
 * at, and a row it holds may be older than a removal, so neither proves it. A plain no: what waited there goes, and a
 * later join carries the result.
 *
 * Never over a newer result: that is judged against what the community holds now, because a second device may have put a
 * newer one there since the phone last synced. A result waiting there that it has overtaken goes. On a tie a retake made
 * on this device is sent; a result carried from another community's row is not, and goes (keepCarriedArchetype): the row
 * stands. No answer to either question sends nothing, and the next publish asks again.
 */
export async function archetypeToSend(community: string, identity: Signer, row: string | null | undefined): Promise<string | null> {
    const { publicKey } = identity;
    const waiting = await waitingEntry(community, publicKey);
    const deviceCopy = (await getCanonicalProfile())?.archetype;
    if (!waiting && !archetypeToCarry(deviceCopy, row)) return null;
    if (await onGuestVisit(community)) return null;
    const member = await saysMember(community, publicKey);
    if (member === false && waiting) await clearWaitingArchetype(community, waiting.archetype);
    if (member !== true) return null;
    const held = await heldThere(community, identity);
    if (held === undefined) return null;
    if (!waiting) return archetypeToCarry(deviceCopy, held);
    const stands = waiting.carried ? !archetypeIsNewer(waiting.archetype, held) : archetypeIsNewer(held, waiting.archetype);
    if (stands) {
        await clearWaitingArchetype(community, waiting.archetype);
        return null;
    }
    return waiting.archetype;
}

/** `ask`, given up on at MEMBERSHIP_TIMEOUT_MS. Undefined for no answer. Never throws. */
async function answerOf<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMBERSHIP_TIMEOUT_MS);
    try {
        return await ask(controller.signal);
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** What `community` says of the key, asked as every probe asks (membership-probe.ts): null for no answer. */
async function saysMember(community: string, publicKey: string): Promise<boolean | null> {
    const answer = await answerOf(async (signal) => {
        const res = await fetchMembership(community, publicKey, signal);
        return res.ok ? (await res.json()) as { isMember?: unknown; isRecovering?: unknown } : undefined;
    });
    if (answer?.isMember === true || answer?.isRecovering === true) return true;
    return answer?.isMember === false ? false : null;
}

/** The working style `community` holds for the key now: null for none, undefined for no answer. */
async function heldThere(community: string, identity: Signer): Promise<string | null | undefined> {
    const target = `${community.replace(/\/+$/, '')}/api/profile/${identity.publicKey}`;
    return answerOf(async (signal) => {
        const headers = await buildSignedHeaders('GET', target, '', identity.privateKey, identity.publicKey);
        const res = await fetch(target, { headers: { ...headers, Accept: 'application/json' }, signal });
        if (!res.ok) return undefined;
        const profile = (await res.json()) as { archetype?: unknown };
        return typeof profile?.archetype === 'string' ? profile.archetype : null;
    });
}
