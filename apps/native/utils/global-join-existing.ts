/**
 * Joining the global community from an account this phone already has (Marty, on the board, 2026-10-01: "Yes, before
 * launch"). The door's client half is utils/global-join.ts, written for a new phone's first screen; this is the same
 * door for a member who is past it: a guest of the global community (People → Invites), or a member of a local
 * community adding the global one (the BeanPool sheet, Settings → Advanced). The screen is app/join-global.tsx.
 *
 * ## The same door, with the key already on the phone
 *
 * Sign in (`signInAtDoor`), choose the name (`checkNameAtDoor`), join (`submitJoin`), exactly as G7, V5's ticket and
 * its backstop included. Every request is signed by the key the phone holds ({@link accountKeyForDoor}): global gets a
 * member with the same key, and the one-sign-in-account, one-member rule and the per-network limits hold as for anyone
 * (apps/server routes/open-join.ts). Nothing here makes, writes, replaces or takes off a key, and nothing writes the
 * join wizard's record (`commitJoinKey`, `keepJoinedIdentity`, `releaseJoinKey` are the new phone's, never called
 * here): one identity per device, and a join that is refused leaves the phone exactly as it was. A join signed by a
 * key the door didn't make is never counted for taking off (global-join.ts `countJoinOut`).
 *
 * ## The other communities are not touched
 *
 * Nothing is sent to them, and the phone's list keeps them as they were. Once in, the phone switches to the global
 * community, as an invite join to a second community does (join-another-community.ts), and adds it to the list.
 *
 * ## The recovery copy (one sign-in, two jobs, as at the first screen)
 *
 * The door's sign-in also links that sign-in to the account, as it does for a new member (design §11, D1 follow-up:
 * "everyone, once, then the 12 words"). It is a copy of THIS phone's key, and of the 12 words only when the phone
 * holds words that make that key (keeper-enrolment.ts `sealSsoShares`): the same 12 words the member already has,
 * never new ones and never words the phone doesn't hold.
 * - A build with the key vault: the copy goes to the vault once the door has let the member in. The vault keeps one
 *   copy per sign-in account, for every community: the same sign-in already linked is refreshed in place (same key);
 *   another one is a second way back; a sign-in that protected a different BeanPool account protects this one now,
 *   and that account's devices are told (the vault's rule, as at Settings' connect), which the member is told too.
 * - A build without one: the copy rides in the join and the global community keeps it, as each community keeps its
 *   own. A sign-in linked at the member's local community stays there, untouched.
 * If the copy can't be made or kept, the join still stands: the 12 words are the key, and Settings offers the connect.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadIdentity } from './identity';
import { getSavedNodes, isGuestNode } from './nodes';
import { GLOBAL_NODE_URL } from './node-profile';
import { doorMessage, joinedUnderNodeName, type DoorAnswer, type JoinKey } from './global-join';
import { signInCopiesAt } from './vault-config';
import { signInReplacedNote } from './no-words-copy';
import { SSO_PROVIDER_NAMES } from './sso-providers';
import type { KeeperEnrolmentResult } from './keeper-enrolment';
import type { JoinDeps } from './join-another-community';

/**
 * The key the door's sign-in and join are signed by: the account this phone holds, as it is. Null when the phone
 * holds none (the first screen's door is the way in then). Never makes, writes or replaces a key.
 */
export async function accountKeyForDoor(): Promise<JoinKey | null> {
    const identity = await loadIdentity();
    return identity ? { identity, createdHere: false } : null;
}

/** Whether `url` is the global community's address (the door is the global community's alone). */
export function isGlobalCommunity(url: string | null | undefined): boolean {
    return !!url && url.trim().replace(/\/+$/, '').toLowerCase() === GLOBAL_NODE_URL;
}

/**
 * What the phone knows of its own standing in the global community: not in its list (`none`), a guest there
 * (`guest`), a member (`member`), or it can't say yet (`unknown`: still asking, or no answer).
 */
export type GlobalStanding = 'none' | 'guest' | 'member' | 'unknown';

/**
 * Whether an existing account is offered the door: only once the global community has said, this app start, that its
 * door is open (utils/global-door-offer.ts, the check that shows "Explore BeanPool worldwide"), and only to a phone
 * with an account that isn't known to be a member there. Unknown standing offers nothing yet, so a member never sees
 * the offer flash up while the phone asks. A member the phone took for a guest who taps it anyway is told so by the
 * door (`already_member`), and simply lands in the global community.
 */
export function doorOfferedToAccount(input: { doorOpen: boolean; hasAccount: boolean; standing: GlobalStanding }): boolean {
    return input.doorOpen && input.hasAccount && (input.standing === 'none' || input.standing === 'guest');
}

/**
 * The phone's standing in the global community from what it keeps, with no network: `none` when neither its list nor
 * the community in use is the global one, `guest` when the phone marked it a guest visit (Settings' Add & Connect, which
 * asks the node), else `member`. For a screen that has no live answer of its own (Settings); the BeanPool sheet asks
 * each community and reads its rows instead.
 */
export async function globalStandingOnPhone(): Promise<GlobalStanding> {
    try {
        const [nodes, anchor] = await Promise.all([getSavedNodes(), AsyncStorage.getItem('beanpool_anchor_url')]);
        if (!nodes.some(n => isGlobalCommunity(n.url)) && !isGlobalCommunity(anchor)) return 'none';
        return (await isGuestNode(GLOBAL_NODE_URL)) ? 'guest' : 'member';
    } catch {
        return 'unknown';
    }
}

/** What the door's screen says for an answer that isn't `joined`, for an account the phone already holds. */
export const ACCOUNT_DOOR_MESSAGES = {
    /**
     * 409 `already_joined`: this sign-in account joined the global community with another BeanPool account. The first
     * screen's "Restore it" would replace the account on this phone, so it is never offered here.
     */
    otherAccount: 'This sign-in already joined the global community with a different BeanPool account. '
        + 'To join as the account on this phone, use a different sign-in.',
    /** The phone holds no account (it was signed out while this screen was open). */
    noAccount: 'This phone has no BeanPool account now, so nothing was sent. Go back and start again from the first screen.',
} as const;

export function accountDoorMessage(answer: Exclude<DoorAnswer, { kind: 'joined' }>): string {
    return answer.kind === 'already_joined' ? ACCOUNT_DOOR_MESSAGES.otherAccount : doorMessage(answer);
}

/** The data layer an entry into the global community uses (join-another-community.ts's, without the redeem). */
export type EnterDeps = Pick<JoinDeps, 'closeDB' | 'initDB' | 'addSavedNode' | 'clearGuestNode' | 'requestSync'>;

async function defaultEnterDeps(): Promise<EnterDeps> {
    // Loaded when used, as join-another-community.ts does: db.ts and pillar-sync pull in the whole data layer.
    const db = await import('./db');
    const nodes = await import('./nodes');
    const sync = await import('../services/pillar-sync');
    return {
        closeDB: db.closeDB,
        initDB: db.initDB,
        addSavedNode: nodes.addSavedNode,
        clearGuestNode: nodes.clearGuestNode,
        requestSync: sync.requestSync,
    };
}

/**
 * In: the phone switches to the global community, as an invite join to a second community does, and keeps it in its
 * list. No longer a guest there, if it was. The account and every other community in the list are left as they were.
 */
export async function enterGlobalCommunity(injected?: EnterDeps): Promise<void> {
    const deps = injected ?? await defaultEnterDeps();
    // In the list and no guest's first, so a switch that fails below still leaves it one tap away in the BeanPool sheet.
    await deps.clearGuestNode(GLOBAL_NODE_URL).catch(() => {});
    await deps.addSavedNode(GLOBAL_NODE_URL, 'Global community').catch(() => {});
    await deps.closeDB();
    await AsyncStorage.setItem('beanpool_anchor_url', GLOBAL_NODE_URL);
    await deps.initDB();
    deps.requestSync().catch(() => {});
}

export interface JoinedGlobal {
    /** The name the global community kept (it makes a taken one unique), for the profile step that follows. */
    name: string;
    title: string;
    body: string;
}

/**
 * The door let this account in (`answer` is `joined`): the name the node kept, the phone switched to the global
 * community, and what the member is told before the profile step (name and photo there, as after any second
 * community). `typed` is the name sent with the join. Writes nothing of the account.
 *
 * `stillWanted` is asked once the name is in, just before the phone switches: a screen the member has left by then
 * switches nothing (null). They are in all the same, and the door says so (`already_member`) the next time.
 */
export async function finishJoinFromAccount(
    answer: Extract<DoorAnswer, { kind: 'joined' }>, key: JoinKey, typed: string,
    options: { stillWanted?: () => boolean; deps?: EnterDeps } = {},
): Promise<JoinedGlobal | null> {
    const kept = await joinedUnderNodeName(GLOBAL_NODE_URL, answer, { ...key.identity, callsign: typed.trim() || key.identity.callsign });
    if (options.stillWanted && !options.stillWanted()) return null;
    await enterGlobalCommunity(options.deps);
    return { name: kept.callsign, ...joinedGlobalNotice(answer.enrolment) };
}

/** "You're in": what came with the member, and what their sign-in now does for the account. */
export function joinedGlobalNotice(enrolment: KeeperEnrolmentResult | null): { title: string; body: string } {
    const came = 'Your key and your 12 words are the same as before, and nothing changed in your other communities: '
        + 'your posts, chats and trades stay in each one.';
    const provider = enrolment?.enrolledSso?.[0] as keyof typeof SSO_PROVIDER_NAMES | undefined;
    const name = provider && SSO_PROVIDER_NAMES[provider];
    if (!enrolment || !name) return { title: "You're in the global community", body: came };
    const linked = signInCopiesAt() === 'vault'
        ? `Your ${name} sign-in is now also a way back into your account, in every community.`
        : `Your ${name} sign-in is now also a way back into your account here.`;
    const replaced = enrolment.replaced ? `\n\n${signInReplacedNote(name)}` : '';
    return { title: "You're in the global community", body: `${came}\n\n${linked}${replaced}` };
}
