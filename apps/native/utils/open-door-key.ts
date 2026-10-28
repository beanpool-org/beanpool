/**
 * Another community's open door on a phone with no account (DESIGN-account-without-global-fable.md §2.3, slice S2): the key
 * rule every door shares (utils/door-key.ts), at the door's own address. A self-hoster may run a node with the global
 * profile, its own open door, listed nowhere of ours. Its link (`beanpool://join-open-door?node=…`, utils/open-door.ts)
 * opens the door screen (app/join-open-door.tsx) on a new phone, and the join there makes the account: nothing of ours is
 * asked, no global community and no registrar. The server is unchanged: the door checks the joining key's own signature
 * and needs no member (apps/server routes/open-join.ts).
 *
 * - A phone with an account joins with it, as since P5 (utils/global-join-existing.ts): {@link openDoorKeyForThisPhone}
 *   reads it as the phone's own (`createdHere` false), nothing is written to the phone for it, and it never comes off.
 * - A phone with none joins with a key made for it in memory (identity.ts `draftIdentity`), which the door's work and its
 *   sign-in are signed by. It is written to the phone, with the wizard's record (flow `global`, step `globalJoin`, at the
 *   door's address), only once Join is tapped and just before the join is sent ({@link commitOpenDoorKey}), and each join
 *   it signs is counted out at that door (global-join.ts). A lost answer keeps the key and the record: the next launch comes
 *   back to this door (onboarding-state.ts `doorResumeUrl`), where the node answers `already_member` once the join landed.
 * - It comes off the phone again only when no join it signed can have landed: the join's own refusal for good, or the
 *   member leaving the door, with every join it signed refused ({@link releaseOpenDoorKey}).
 * - Once in, the wizard's record moves on to Your Photo at that address ({@link finishOpenDoorJoin}), and the welcome screen
 *   resumes it: Your Photo, Safety Backup with the 12 words, How it Works, then Home. As the global community's door does
 *   at its own address (app/welcome.tsx `finishGlobalJoin`).
 * - A key this door made that an invite join took over since (its redeem never finished) never comes off, but its words
 *   are still the member's new ones: the door finishes its join the same way ({@link openDoorKeyIsNew}).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    commitDoorKey, keepJoinedIdentity, keyForThisPhone, madeByTheDoor, openDoorAt, releaseDoorKey, type JoinKey,
} from './door-key';
import type { BeanPoolIdentity } from './identity';
import type { KeeperEnrolmentResult } from './keeper-enrolment';
import { doorJoinOut, getPendingOnboarding, keyMadeForThisJoin, setPendingOnboarding } from './onboarding-state';
import { communitySwitched } from './community-switch';
import { assertPlainNodeAddress } from './node-url';
import { addSavedNode, clearGuestNode } from './nodes';
import { startOneWayBack } from './one-way-back';

/**
 * The key the door at `url` joins with: the phone's own account when it has one (never a second), else the key this door
 * made (`held`, or the stored one its record names after a restart), else a new one in memory, not yet saved.
 */
export function openDoorKeyForThisPhone(url: string, held: JoinKey | null = null): Promise<JoinKey> {
    return keyForThisPhone(openDoorAt(url), held);
}

/**
 * Join tapped with a key this door made: the key and the wizard's record go onto the phone, just before the join is sent
 * (door-key.ts `commitDoorKey`). Returns the identity the join is signed by, under the name typed. Never for the phone's
 * own account, which the door writes nothing for.
 */
export function commitOpenDoorKey(url: string, key: JoinKey, callsign: string): Promise<BeanPoolIdentity> {
    return commitDoorKey(openDoorAt(url), key, callsign);
}

/**
 * The join's own refusal for good, or the member leaving the door: the key this door made comes off the phone, with its
 * record, only while the door's join is still at the door (the record has not moved on to the wizard) and every join it
 * signed was refused (`joinsOut` 0, door-key.ts `releaseDoorKey`). A key a join may have put on the node stays, and so
 * does its record. The phone's own account, and a key another join has taken over, never come off. Returns whether a key
 * came off.
 */
export async function releaseOpenDoorKey(url: string, key: JoinKey): Promise<boolean> {
    const record = await getPendingOnboarding();
    if (!doorJoinOut(record) || !madeByTheDoor(record, key.identity.publicKey, openDoorAt(url))) return false;
    return releaseDoorKey(openDoorAt(url), key);
}

/**
 * Whether a join by `publicKey` at the door at `url` is the member's new account there, so that once in it goes on to Your
 * Photo and Safety Backup with the 12 words ({@link finishOpenDoorJoin}), never to the account's profile step: this door's
 * join is still at the door (`doorJoinOut`, at this address), and its record says the key's words are this join's
 * (onboarding-state.ts `keyMadeForThisJoin`). That is a key this door made: still its own (`freshKey`), or taken over since
 * by an invite join whose redeem never finished, which leaves `newKey` in the mark's place (door-key.ts `adoptJoinKey`).
 * Without this the door read such a key as the phone's account: its finish never moved the record on, and every launch
 * came back to the door, the words never shown (PR #2564 review). Read from the saved record, at the answer. False for the
 * phone's own account, which the door writes no record for.
 */
export async function openDoorKeyIsNew(url: string, publicKey: string): Promise<boolean> {
    const record = await getPendingOnboarding();
    return !!record && doorJoinOut(record) && record.anchorUrl === url && keyMadeForThisJoin(record, publicKey);
}

/**
 * In, with a key this door made: the phone is this community's from here (its anchor and its saved list, under its own
 * name when the door knew it), and the wizard's record moves on to Your Photo at its address, which the welcome screen
 * resumes: Your Photo, Safety Backup with the 12 words (they are the member's new ones: `newKey`), How it Works, then Home.
 * In by 12 words: the one-way-back card starts, at this community (utils/one-way-back.ts).
 *
 * `joined` carries the name the node kept (global-join.ts `joinedUnderNodeName`): the phone must hold the node's. Returns the
 * identity the phone holds.
 */
export async function finishOpenDoorJoin(
    url: string,
    joined: BeanPoolIdentity,
    { enrolment, way, communityName }: { enrolment: KeeperEnrolmentResult | null; way: 'words' | 'sign-in'; communityName: string | null },
): Promise<BeanPoolIdentity> {
    // On the phone first, under the name the node kept: the record below means nothing without it.
    const identity = await keepJoinedIdentity(joined);
    if (way === 'words') await startOneWayBack(identity.publicKey, url);
    // The door's address came through doorNodeAt on the screen; this is the write's own check.
    assertPlainNodeAddress(url);
    await AsyncStorage.setItem('beanpool_anchor_url', url);
    // The update screen asks the community now in use (utils/community-switch.ts).
    communitySwitched();
    await addSavedNode(url, communityName ?? undefined).catch(() => {});
    await clearGuestNode(url);
    await setPendingOnboarding({
        step: 'profileSetup',
        flow: 'global',
        inviteCode: '',
        anchorUrl: url,
        callsign: identity.callsign,
        redeemed: true,
        joinEnrolment: enrolment,
        newKey: identity.publicKey,
        ...(way === 'words' ? { joinDoor: 'words' as const } : {}),
        ...(communityName ? { communityName } : {}),
    });
    return identity;
}
