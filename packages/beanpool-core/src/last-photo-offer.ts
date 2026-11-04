/**
 * Joining a community offers the last photo, and never applies it (Profile S3,
 * scratch/fable-design/DESIGN-per-community-profile-fable.md §3-§4; Marty, 29 Oct 2026).
 *
 * A member has one name and one picture PER COMMUNITY. The photo they used last (in whichever community) is kept
 * on the phone, or in the browser, only so it can be OFFERED when they join a community that holds none for them:
 * a tickbox, off. Nothing reads it for display and nothing publishes it unasked. This is the one rule both apps ask,
 * so the phone and the web agree on when the offer shows.
 */

/** The photo a member used last, and the community it was set in (an address; null when that is not known). */
export interface LastPhoto {
    /** A `data:` URI or a `bundled://<id>`: the only two values that mean the same picture in any community. */
    avatar: string;
    from: string | null;
}

/**
 * Can this photo be kept, and offered, for another community? A value that carries the picture itself or names a shipped
 * one: the same allow-list as the phone's isPortableAvatarValue. A node's own picture URL names a place, so it is not.
 */
export function photoCanTravel(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v || v === 'null' || v === 'undefined') return false;
    return /^data:/i.test(v) || v.startsWith('bundled://');
}

/** True when this community's row holds no photo for the member at all (no value, or one that reads as none). */
function holdsNoPhoto(value: unknown): boolean {
    if (typeof value !== 'string') return true;
    const v = value.trim();
    return !v || v === 'null' || v === 'undefined';
}

/**
 * The last photo to OFFER on joining, or null when nothing is offered.
 *
 * Offered only when all hold:
 *  - there is a last photo, and it is one that can travel (a `data:` or `bundled://` value);
 *  - this community holds no photo for the member (`hereAvatar` empty): a photo already here is the truth here;
 *  - the last photo was not set in this very community (`setHere`): there is nothing to carry over from itself.
 *
 * The caller says whether `last.from` is this community (`setHere`), because comparing two addresses is the app's
 * own plain-string reading (the phone's plainOriginOf, the web's origin), not a guess made here.
 */
export function lastPhotoOffer(input: {
    last: LastPhoto | null | undefined;
    /** What this community's row holds for the member now (the node's own picture URL, a value picked here, or nothing). */
    hereAvatar: string | null | undefined;
    /** The photo was set in this community. */
    setHere: boolean;
}): LastPhoto | null {
    const { last, hereAvatar, setHere } = input;
    if (!last || !photoCanTravel(last.avatar)) return null;
    if (!holdsNoPhoto(hereAvatar)) return null;
    if (setHere) return null;
    return { avatar: last.avatar.trim(), from: last.from };
}

/** The host of a community address, to say where a photo came from when no name is known; null if it is not one. */
export function communityHostOf(address: string | null | undefined): string | null {
    if (typeof address !== 'string') return null;
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(address.trim());
    if (!m) return null;
    const host = m[1].replace(/^.*@/, '').toLowerCase();
    return host || null;
}
