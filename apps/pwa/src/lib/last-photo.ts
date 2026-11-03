import { communityHostOf, lastPhotoOffer, photoCanTravel, type LastPhoto } from '@beanpool/core';

/**
 * "The picture I used last", kept by this browser so joining another community can OFFER it (Profile S3,
 * scratch/fable-design/DESIGN-per-community-profile-fable.md §3-§4; Marty, 29 Oct 2026). The phone keeps the same
 * (apps/native/utils/canonical-profile.ts getLastPhoto) and both ask core's one rule (lastPhotoOffer).
 *
 * Nothing shows it as the member's photo and nothing publishes it unasked: the Re-run Setup wizard (components/ProfileSetup.tsx) shows it as a
 * tickbox that starts off, only while the community the browser talks to holds no photo for the member. It lives in
 * localStorage, so signing out or deleting the account (lib/device-prefs.ts clearAccountStorage) takes it away with the
 * rest of the account's storage.
 */
const KEY = 'bp_last_photo';

/** An address's origin, or null when it is not an address. */
function originOf(address: string | null | undefined): string | null {
    if (!address) return null;
    try { return new URL(address).origin; } catch { return null; }
}

/** Remember `avatar` as the picture used last, set in the community at `from`. Anything that cannot travel is not kept. */
export function rememberLastPhoto(avatar: string | null | undefined, from: string | null): void {
    if (!photoCanTravel(avatar)) return;
    try {
        const kept: LastPhoto = { avatar: avatar.trim(), from: originOf(from) };
        localStorage.setItem(KEY, JSON.stringify(kept));
    } catch { /* private mode or no room: the offer is a courtesy */ }
}

/** The picture used last, or null when none is kept or what is kept cannot be read. */
export function readLastPhoto(): LastPhoto | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const kept = JSON.parse(raw) as Partial<LastPhoto> | null;
        if (!kept || !photoCanTravel(kept.avatar)) return null;
        return { avatar: kept.avatar, from: typeof kept.from === 'string' ? kept.from : null };
    } catch {
        return null;
    }
}

/** What to offer in the community at `here`, which holds `hereAvatar` for the member now; null when nothing is offered. */
export function lastPhotoToOffer(here: string, hereAvatar: string | null | undefined): LastPhoto | null {
    const last = readLastPhoto();
    const hereOrigin = originOf(here);
    return lastPhotoOffer({ last, hereAvatar, setHere: hereOrigin !== null && hereOrigin === originOf(last?.from) });
}

/** The words for where the photo came from: the community's host, or null when that is not known. */
export function lastPhotoFrom(offer: LastPhoto): string | null {
    return communityHostOf(offer.from);
}
