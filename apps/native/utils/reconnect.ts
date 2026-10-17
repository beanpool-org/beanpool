/**
 * Reconnect on the "This community doesn't recognise you" screen, and its saved-community picker: ask first, then move
 * (DESIGN-global-entry-fable.md §C.2, decision 4, Damo's case §1).
 *
 * The screen used to write the address as the phone's community, swap the database, and only then ask whether it knew
 * the key. A "stranger" answer came too late: the phone now sat on that community, nodes.ts' auto-migration put it in the
 * saved list unmarked, and the old standing rule read "global in the list, not a guest" as "member", so every door to the
 * global community went away. Now the community is asked (the membership probe, signed by the key) and told about
 * (its profile) BEFORE anything moves, and the phone moves only for an answer that lets it in:
 * - a member: switched, as before;
 * - a stranger the phone chose to visit as a guest (Settings' Add & Connect, People's Join pill: nodes.ts markGuestNode):
 *   switched, as before (the guest flag's one job);
 * - a stranger otherwise, or a closed account: NOTHING is written (the community in use, its database, the saved list
 *   and the guest marks stay exactly as they were) and the screen draws that community's page (utils/mismatch-plan.ts)
 *   with the phone still where it was;
 * - no answer: nothing is written, and the screen says it couldn't reach it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { assertPlainNodeAddress } from './node-url';
import { membershipAnswerOf } from './membership-answer';
import { communitySwitched } from './community-switch';
import type { NodeProfile } from './node-profile';

export type ReconnectAnswer =
    /** A member there: the phone switched to it. */
    | { kind: 'member' }
    /** A stranger there that the phone had chosen to visit as a guest: the phone switched to it. */
    | { kind: 'guest' }
    /** A stranger there: nothing moved. What the community is, for its page. */
    | { kind: 'stranger'; profile: NodeProfile | null; reachable: boolean }
    /** It closed this key's account: nothing moved. */
    | { kind: 'closed'; profile: NodeProfile | null; reachable: boolean }
    /** No answer: nothing moved. */
    | { kind: 'unreachable' };

export interface ReconnectDeps {
    probe(url: string, identity: { publicKey: string; privateKey: string }, signal?: AbortSignal): Promise<Response>;
    isGuestNode(url: string): Promise<boolean>;
    fetchProfile(url: string): Promise<NodeProfile | null>;
    cachedProfile(url: string): Promise<NodeProfile | null>;
    /** Make `url` the phone's community: its own database, the anchor, the update screen told. */
    switchTo(url: string): Promise<void>;
}

/** The phone's community becomes `url`, as Settings and the BeanPool sheet switch: each community has its own database. */
export async function switchPhoneTo(url: string): Promise<void> {
    assertPlainNodeAddress(url);
    const { closeDB, initDB } = await import('./db');
    await closeDB();
    await AsyncStorage.setItem('beanpool_anchor_url', url);
    await initDB();
    // The update screen asks the community now in use (utils/community-switch.ts).
    communitySwitched();
}

async function defaultDeps(): Promise<ReconnectDeps> {
    const [{ fetchMembership }, nodes, profiles] = await Promise.all([
        import('./membership-probe'), import('./nodes'), import('./node-profile'),
    ]);
    return {
        probe: fetchMembership,
        isGuestNode: nodes.isGuestNode,
        fetchProfile: (url) => profiles.fetchNodeProfile(url),
        cachedProfile: profiles.getCachedNodeProfile,
        switchTo: switchPhoneTo,
    };
}

const PROBE_TIMEOUT_MS = 8_000;

/** What the community is, asked fresh, else this phone's copy. */
async function profileOf(url: string, deps: ReconnectDeps): Promise<{ profile: NodeProfile | null; reachable: boolean }> {
    const fresh = await deps.fetchProfile(url).catch(() => null);
    if (fresh) return { profile: fresh, reachable: true };
    return { profile: await deps.cachedProfile(url).catch(() => null), reachable: false };
}

/**
 * Ask `url` about this key, and switch the phone to it only when it lets the key in (a member, or a chosen guest visit).
 * Throws node-url.ts UnsafeNodeAddressError, before anything is asked or moved, for an address that isn't plain.
 */
export async function askBeforeSwitch(
    url: string, identity: { publicKey: string; privateKey: string }, injected?: Partial<ReconnectDeps>,
): Promise<ReconnectAnswer> {
    assertPlainNodeAddress(url);
    const keys: (keyof ReconnectDeps)[] = ['probe', 'isGuestNode', 'fetchProfile', 'cachedProfile', 'switchTo'];
    const deps: ReconnectDeps = keys.every(k => injected?.[k]) ? injected as ReconnectDeps : { ...(await defaultDeps()), ...injected };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let answer;
    try {
        answer = await membershipAnswerOf(await deps.probe(url, identity, controller.signal));
    } catch {
        answer = null;
    } finally {
        clearTimeout(timer);
    }
    if (!answer) return { kind: 'unreachable' };
    if (answer.kind === 'member') {
        await deps.switchTo(url);
        return { kind: 'member' };
    }
    if (answer.kind === 'stranger' && await deps.isGuestNode(url).catch(() => false)) {
        await deps.switchTo(url);
        return { kind: 'guest' };
    }
    return { kind: answer.kind === 'closed' ? 'closed' : 'stranger', ...(await profileOf(url, deps)) };
}
