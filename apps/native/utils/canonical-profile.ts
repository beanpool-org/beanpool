import AsyncStorage from '@react-native-async-storage/async-storage';
import { CANONICAL_PROFILE_STORE_KEY } from './storage-keys';

// The user's ONE profile, stored once per device and independent of which node
// is currently active. A phone holds a single identity used across every
// community, so the avatar/bio/contact belong to the person, not the node —
// but each node keeps its own `members` row, and a freshly-joined node starts
// with no avatar. This canonical copy lets us re-publish the same picture to
// every node the user joins, so their profile looks identical everywhere and
// the marketplace "set a profile photo" gate never fires on a node they've
// already set a photo on elsewhere.
//
// Values are portable: the avatar is a data: URI or a `bundled://<id>`
// reference (never a device-local file path), so it re-uploads cleanly to any
// node.
//
// It is the person's, so it goes when their account leaves the phone
// (identity.ts `wipeIdentityScopedStorage`): left behind, the next account on
// the phone would publish this photo, bio and contact as its own.

const KEY = CANONICAL_PROFILE_STORE_KEY;

export interface CanonicalProfile {
    avatar?: string | null;
    /** The community (its address) the photo was last set in: only to name it when the photo is offered on joining another. */
    avatarFrom?: string | null;
    bio?: string;
    contactValue?: string | null;
    contactVisibility?: string;
    archetype?: string | null;
}

export async function getCanonicalProfile(): Promise<CanonicalProfile | null> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as CanonicalProfile) : null;
    } catch {
        return null;
    }
}

export async function getCanonicalAvatar(): Promise<string | null> {
    const p = await getCanonicalProfile();
    return p?.avatar || null;
}

/**
 * "The picture I used last", and the community it was set in. Profile S3: the one thing this store is for. It is
 * OFFERED, as a tickbox that starts off, when the member joins a community that holds no photo for them
 * (utils/last-photo-offer.ts); no screen shows it as this community's photo (the offer row shows it small, beside the tickbox) and no publish sends
 * it unasked.
 */
export async function getLastPhoto(): Promise<{ avatar: string; from: string | null } | null> {
    const p = await getCanonicalProfile();
    return p?.avatar ? { avatar: p.avatar, from: p.avatarFrom ?? null } : null;
}

// Merge-save: only the keys explicitly provided are overwritten, so a bio-only
// edit never wipes the stored avatar (and vice-versa). Pass `avatar: null` only
// to deliberately clear it.
export async function saveCanonicalProfile(partial: CanonicalProfile): Promise<void> {
    try {
        const existing = (await getCanonicalProfile()) || {};
        const merged: CanonicalProfile = { ...existing };
        if (partial.avatar !== undefined) merged.avatar = partial.avatar;
        if (partial.avatarFrom !== undefined) merged.avatarFrom = partial.avatarFrom;
        if (partial.bio !== undefined) merged.bio = partial.bio;
        if (partial.contactValue !== undefined) merged.contactValue = partial.contactValue;
        if (partial.contactVisibility !== undefined) merged.contactVisibility = partial.contactVisibility;
        if (partial.archetype !== undefined) merged.archetype = partial.archetype;
        await AsyncStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
        // Non-fatal: canonical is a convenience mirror, not the source of truth.
    }
}
