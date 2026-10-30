import { getMemberProfile } from './db';
import { BeanPoolIdentity } from './identity';
import { t } from '@beanpool/core';

/**
 * Does this member have a usable avatar IN THIS COMMUNITY? Its own row (local SQLite `members.avatar_url`, in the copy
 * the phone has open) and nothing else: a photo chosen in another community does not count, so a fresh community asks
 * for one (Profile S2, Marty 29 Oct: the photo of a listing is that community's). Async because it is a lookup.
 */
export async function hasUsableAvatar(pubkey: string): Promise<boolean> {
    try {
        const p = await getMemberProfile(pubkey);
        return !!p?.avatar_url;
    } catch {
        return false;
    }
}

/** A callsign counts once it's the 2+ chars the wizard requires. */
export function hasCallsign(identity: BeanPoolIdentity | null | undefined): boolean {
    return !!identity?.callsign && identity.callsign.trim().length >= 2;
}

export interface ProfileStatus {
    complete: boolean;
    missingName: boolean;
    missingAvatar: boolean;
}

/**
 * The one predicate the "you need a profile to list/accept" gates share. A name
 * AND an avatar are the only mandatory bits; everything else (bio, contact,
 * visibility) is optional and lives further into the setup wizard.
 */
export async function getProfileStatus(identity: BeanPoolIdentity | null | undefined): Promise<ProfileStatus> {
    if (!identity) return { complete: false, missingName: true, missingAvatar: true };
    const missingName = !hasCallsign(identity);
    const missingAvatar = !(await hasUsableAvatar(identity.publicKey));
    return { complete: !missingName && !missingAvatar, missingName, missingAvatar };
}

/** "a name and a photo" / "a name" / "a photo" — for gate copy. */
export function describeMissing(status: ProfileStatus): string {
    if (status.missingName && status.missingAvatar) return 'a name and a photo';
    if (status.missingName) return 'a name';
    return 'a photo';
}

/** Why accepting waits for the profile, in the member's language: one whole sentence for each thing missing. */
export function acceptNeedsProfileLine(status: ProfileStatus): string {
    if (status.missingName && status.missingAvatar) {
        return t("Your community likes to know who they're dealing with, so you need a name and a photo before you can accept. It only takes a moment.");
    }
    if (status.missingName) {
        return t("Your community likes to know who they're dealing with, so you need a name before you can accept. It only takes a moment.");
    }
    return t("Your community likes to know who they're dealing with, so you need a photo before you can accept. It only takes a moment.");
}
