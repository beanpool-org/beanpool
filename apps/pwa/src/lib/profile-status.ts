import { getMemberProfile } from './api';
import { resolveAvatarUrl } from './avatar';
import type { BeanPoolIdentity } from './identity';

export interface ProfileStatus {
    complete: boolean;
    missingName: boolean;
    missingAvatar: boolean;
}

/** A callsign counts once it's the 2+ chars the wizard requires. */
export function hasCallsign(identity: BeanPoolIdentity | null | undefined): boolean {
    return !!identity?.callsign && identity.callsign.trim().length >= 2;
}

/**
 * The shared "can this member list/accept yet?" predicate. A name AND an avatar
 * are the only mandatory bits (bio/contact/visibility stay optional). The avatar
 * is read live from the node — this app has no local avatar store.
 */
export async function getProfileStatus(identity: BeanPoolIdentity | null | undefined): Promise<ProfileStatus> {
    if (!identity) return { complete: false, missingName: true, missingAvatar: true };
    const missingName = !hasCallsign(identity);
    let missingAvatar = true;
    try {
        const profile = await getMemberProfile(identity.publicKey, identity.publicKey);
        missingAvatar = !resolveAvatarUrl(profile?.avatar ?? null);
    } catch {
        missingAvatar = true;
    }
    return { complete: !missingName && !missingAvatar, missingName, missingAvatar };
}

/** "a name and a photo" / "a name" / "a photo" — for gate copy. */
export function describeMissing(status: ProfileStatus): string {
    if (status.missingName && status.missingAvatar) return 'a name and a photo';
    if (status.missingName) return 'a name';
    return 'a photo';
}
