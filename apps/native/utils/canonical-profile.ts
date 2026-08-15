import AsyncStorage from '@react-native-async-storage/async-storage';

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

const KEY = 'beanpool_canonical_profile';

export interface CanonicalProfile {
    avatar?: string | null;
    bio?: string;
    contactValue?: string | null;
    contactVisibility?: string;
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

// Merge-save: only the keys explicitly provided are overwritten, so a bio-only
// edit never wipes the stored avatar (and vice-versa). Pass `avatar: null` only
// to deliberately clear it.
export async function saveCanonicalProfile(partial: CanonicalProfile): Promise<void> {
    try {
        const existing = (await getCanonicalProfile()) || {};
        const merged: CanonicalProfile = { ...existing };
        if (partial.avatar !== undefined) merged.avatar = partial.avatar;
        if (partial.bio !== undefined) merged.bio = partial.bio;
        if (partial.contactValue !== undefined) merged.contactValue = partial.contactValue;
        if (partial.contactVisibility !== undefined) merged.contactVisibility = partial.contactVisibility;
        await AsyncStorage.setItem(KEY, JSON.stringify(merged));
    } catch {
        // Non-fatal: canonical is a convenience mirror, not the source of truth.
    }
}
