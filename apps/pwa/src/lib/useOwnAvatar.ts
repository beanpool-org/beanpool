import { useEffect, useState } from 'react';
import { getMemberProfile } from './api';
import { resolveAvatarUrl } from './avatar';
import { PROFILE_SAVED_EVENT } from './profile-saved';

/**
 * The member's own picture, for the sidebar's profile button: read from the node (this app keeps no copy of it, as
 * lib/profile-status.ts reads it), only in the forms resolveAvatarUrl allows, and read again whenever this page saves
 * the profile (PROFILE_SAVED_EVENT). null while it loads, where there is none, and where it can't be read: the initials.
 * `publicKey` null: nothing is asked (no account, or not yet known to be a member here).
 */
export function useOwnAvatar(publicKey: string | null): string | null {
    const [avatar, setAvatar] = useState<string | null>(null);
    useEffect(() => {
        setAvatar(null);
        if (!publicKey) return;
        let live = true;
        // A save soon after the first read: only the last read asked writes, whichever answers first.
        let asked = 0;
        const read = async () => {
            const n = ++asked;
            try {
                const profile = await getMemberProfile(publicKey, publicKey);
                if (live && n === asked) setAvatar(resolveAvatarUrl(profile?.avatar));
            } catch { /* offline, or no profile yet: what is shown stays */ }
        };
        read();
        window.addEventListener(PROFILE_SAVED_EVENT, read);
        return () => {
            live = false;
            window.removeEventListener(PROFILE_SAVED_EVENT, read);
        };
    }, [publicKey]);
    return avatar;
}
