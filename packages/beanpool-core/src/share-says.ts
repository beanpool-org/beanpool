/**
 * Share says (scratch/fable-design/DESIGN-share-says-fable.md; one flow with Invite and share, 3 Nov):
 * Before the member taps Share on a listing or an event, one plain line under the buttons tells them
 * what the link will do, chosen by this community's settings and this member's standing. There is ONE invite
 * action: **Invite and share** (packages/beanpool-core invite-and-share.ts). `showInviteButton` is its gate on both apps;
 * the old separate "Invite someone" button is gone, and must never show beside it.
 *
 *   - Sharing outside on:
 *       Keep both buttons.
 *       Under Share with members: "This link opens for members only."
 *       Under Share outside: "Anyone can read this listing for 7 days, then ask to join." Where joining is paused
 *       (features.knocks off, or not said) it stops at "...for 7 days."; for an event it says "event".
 *       Invite and share shows where this member may invite (below).
 *   - Sharing outside off, any member may invite:
 *       Share with members, "This link opens for members only.", and Invite and share.
 *   - Sharing outside off, only admins invite, member not an admin:
 *       Share with members, "This link opens for members only, and only admins invite here." No invite action
 *       (the seam for "Ask an admin", #2775).
 *   - Sharing outside off, only admins invite, member is owner/admin:
 *       As the second row (Share with members, "This link opens for members only.", Invite and share).
 *   - Open door (global):
 *       No line: the link already opens for anyone. No invite action.
 *   - Private preview:
 *       Only the owner's or an admin's invite: same as third row for a member, second row for admin.
 *   - Invites off (features.invites false) with a members' door: no invite action, and no line about who may invite.
 *   - Fallback (settings cannot be read, or the member's role is still loading or failed where it matters):
 *       Show today's buttons, no line and no invite action. Never guess.
 */

import { PEEK_WORDS as W } from './peek-ticket.js';
import type { WordKey } from './words.js';

export interface ShareSaysFeatures {
    door?: string | null;
    openJoin?: boolean | null;
    invites?: boolean | null;
    shareOutside?: boolean | null;
    privatePreview?: boolean | null;
    /** Asking to join (a knock) is on. Joining paused: false. */
    knocks?: boolean | null;
}

/** The member's role here: a role, null (the node said none), or undefined (not known yet, or the node did not answer). */
export type ShareSaysRole = string | null | undefined;

/** What is being shared: the words differ for an event. */
export type ShareSaysKind = 'listing' | 'event';

export interface ShareSaysResult {
    /** Plain line under Share with members, or null if no line. */
    membersLine: WordKey | null;
    /** Plain line under Share outside, or null if no line. */
    outsideLine: WordKey | null;
    /** Whether Invite and share (the one invite action) may be shown: this member may invite here, and their role is known where it matters. */
    showInviteButton: boolean;
    /** Whether the "Share outside" button should be offered (subject to post shareability). */
    showShareOutside: boolean;
}

const NOTHING: ShareSaysResult = { membersLine: null, outsideLine: null, showInviteButton: false, showShareOutside: false };

export function shareSays(features: ShareSaysFeatures | null | undefined, role?: ShareSaysRole, kind: ShareSaysKind = 'listing'): ShareSaysResult {
    // If a community's settings can't be read, show today's buttons and no line. Never guess.
    if (!features || (features.door == null && features.shareOutside == null && features.openJoin == null && features.privatePreview == null)) {
        return {
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        };
    }

    const isOpenDoor = features.door === 'open' || (features.openJoin === true && features.invites === false);
    if (isOpenDoor) {
        return {
            membersLine: null,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        };
    }

    const isPrivate = features.privatePreview === true;
    const isSharingOutsideOn = features.shareOutside === true && !isPrivate;
    const isAdmin = role === 'owner' || role === 'admin';
    const onlyAdmins = features.door === 'admins' || isPrivate;

    if (isSharingOutsideOn) {
        // Only what the community allows: "ask to join" only where joining is on.
        const asks = features.knocks === true;
        const outsideLine = kind === 'event'
            ? (asks ? W.shareOutsideEventLine : W.shareOutsideEventNoKnockLine)
            : (asks ? W.shareOutsideLine : W.shareOutsideNoKnockLine);
        return {
            membersLine: W.membersOnlyLine,
            outsideLine,
            // Where only admins invite the role must be known: not heard yet is no invite action, as in the rows below.
            showInviteButton: features.invites !== false && (!onlyAdmins || isAdmin),
            showShareOutside: true,
        };
    }

    // Sharing outside is off. Where invites are off nobody invites: no button, and no line about who may.
    if (features.invites === false) return NOTHING;

    if (onlyAdmins) {
        // Whether this member is an admin is not known yet (or the node did not answer): today's buttons, no line.
        if (role === undefined) return NOTHING;
        if (isAdmin) {
            return {
                membersLine: W.membersOnlyLine,
                outsideLine: null,
                showInviteButton: true,
                showShareOutside: false,
            };
        }
        return {
            membersLine: W.adminsOnlyLine,
            outsideLine: null,
            showInviteButton: false,
            showShareOutside: false,
        };
    }

    // Any member may invite
    return {
        membersLine: W.membersOnlyLine,
        outsideLine: null,
        showInviteButton: true,
        showShareOutside: false,
    };
}
