import AsyncStorage from '@react-native-async-storage/async-storage';
import { communityHostOf, lastPhotoOffer as offerRule } from '@beanpool/core';
import { getLastPhoto } from './canonical-profile';
import { getSavedNodes } from './nodes';
import { plainOriginOf } from './node-url';

/**
 * Joining a community offers the photo the member used last, and never applies it (Profile S3,
 * scratch/fable-design/DESIGN-per-community-profile-fable.md §4; Marty, 29 Oct 2026: "offer last photo", off).
 *
 * The wizard that follows a join (app/profile-setup.tsx) shows a tickbox, off, "Use the photo from <community>?" when
 * this community holds no photo for the member and they have used one elsewhere. Ticking it makes that photo the
 * member's pick in THIS session, which is the only thing a publish sends (utils/avatar-value.ts); left off, nothing of
 * the last photo is shown here or sent here. The rule itself is core's, the same one the web asks.
 */
export interface PhotoOffer {
    /** A `data:` or `bundled://` value: what the pick becomes when the box is ticked. */
    avatar: string;
    /** The community the photo was set in, by the name the phone keeps for it, else its host; null when not known. */
    from: string | null;
}

/**
 * The offer for the community the phone is on, given what that community's row holds for the member (`rowAvatar`).
 * Null when nothing is offered, and when anything at all goes wrong: an offer is a courtesy, never a gate.
 */
export async function loadLastPhotoOffer(rowAvatar: string | null | undefined): Promise<PhotoOffer | null> {
    try {
        const last = await getLastPhoto();
        if (!last) return null;
        const here = await AsyncStorage.getItem('beanpool_anchor_url');
        const hereOrigin = plainOriginOf(here);
        const fromOrigin = plainOriginOf(last.from);
        const offer = offerRule({
            last,
            hereAvatar: rowAvatar,
            setHere: hereOrigin !== null && hereOrigin === fromOrigin,
        });
        if (!offer) return null;
        return { avatar: offer.avatar, from: await communityNameFor(offer.from) };
    } catch {
        return null;
    }
}

/**
 * The name the phone keeps for the community at `address` (its saved alias), else its host, else null. An address that
 * is not a plain community address (node-url.ts) is never turned into a name to show.
 */
async function communityNameFor(address: string | null): Promise<string | null> {
    const origin = plainOriginOf(address);
    if (!origin) return null;
    try {
        const saved = (await getSavedNodes()).find(n => plainOriginOf(n.url) === origin);
        const alias = saved?.alias?.trim();
        if (alias) return alias;
    } catch { /* fall through to the host */ }
    return communityHostOf(origin);
}
