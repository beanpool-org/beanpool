/**
 * Share says (scratch/fable-design/DESIGN-share-says-fable.md):
 * Before the member taps Share on a listing or an event, one plain line under the buttons tells them
 * what the link will do, chosen by this community's settings and this member's standing:
 *
 *   - Sharing outside on:
 *       Keep both buttons.
 *       Under Share with members: "This link opens for members only."
 *       Under Share outside: "Anyone can read this listing for 7 days, then ask to join."
 *   - Sharing outside off, any member may invite:
 *       Share with members, "This link opens for members only.", and an "Invite someone" button.
 *   - Sharing outside off, only admins invite, member not an admin:
 *       Share with members, "This link opens for members only, and only admins invite here."
 *   - Sharing outside off, only admins invite, member is owner/admin:
 *       As the second row (Share with members, "This link opens for members only.", "Invite someone").
 *   - Open door (global):
 *       No line: the link already opens for anyone.
 *   - Private preview:
 *       Only the owner's or an admin's invite: same as third row for a member, second row for admin.
 *   - Fallback (settings cannot be read):
 *       Show today's buttons and no line. Never guess.
 */

import { PEEK_WORDS as W } from './peek-ticket.js';
import type { WordKey } from './words.js';

export interface ShareSaysFeatures {
    door?: string | null;
    openJoin?: boolean | null;
    invites?: boolean | null;
    shareOutside?: boolean | null;
    privatePreview?: boolean | null;
}

export type ShareSaysRole = string | null | undefined;

export interface ShareSaysResult {
    /** Plain line under Share with members, or null if no line. */
    membersLine: WordKey | null;
    /** Plain line under Share outside, or null if no line. */
    outsideLine: WordKey | null;
    /** Whether the "Invite someone" button should be shown. */
    showInviteButton: boolean;
    /** Whether the "Share outside" button should be offered (subject to post shareability). */
    showShareOutside: boolean;
}

export function shareSays(features: ShareSaysFeatures | null | undefined, role?: ShareSaysRole): ShareSaysResult {
    // If a community's settings can't be read, show today's buttons and no line. Never guess.
    if (!features || (features.door === undefined && features.shareOutside === undefined && features.openJoin === undefined && features.privatePreview === undefined)) {
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
        return {
            membersLine: W.membersOnlyLine,
            outsideLine: W.shareOutsideLine,
            showInviteButton: false,
            showShareOutside: true,
        };
    }

    // Sharing outside is off
    if (onlyAdmins) {
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
