import { getMemberProfile } from './db';
import { getCanonicalAvatar } from './canonical-profile';
import { BeanPoolIdentity } from './identity';

/**
 * Does this member have a usable avatar? Mirrors the publish path: the node's
 * copy (local SQLite `members.avatar_url`) first, then the canonical,
 * node-independent copy. Async because both are lookups.
 */
export async function hasUsableAvatar(pubkey: string): Promise<boolean> {
    try {
        const p = await getMemberProfile(pubkey);
        if (p?.avatar_url) return true;
    } catch {}
    return !!(await getCanonicalAvatar());
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
