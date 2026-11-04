/**
 * Copy on request (Profile S4, scratch/fable-design/DESIGN-per-community-profile-fable.md §3-§4; Marty, 28-29 Oct 2026).
 *
 * A member has one name and one picture PER COMMUNITY. Nothing moves from one community to another by itself: the member
 * asks, on a screen that says which community gets what ("Use this name and photo in another community…"), and only what
 * they ticked goes. This is the one rule both apps ask, so the phone and the web agree on what a copy carries:
 *
 *  - the name, if the name box was ticked, exactly as the source community holds it;
 *  - the photo, if the photo box was ticked and the photo can travel (a `data:` or `bundled://` value);
 *  - nothing else, ever: not the bio, not the contact, not the working style.
 */
import { photoCanTravel, type LastPhoto } from './last-photo-offer.js';

/** What the member ticked. Both off: nothing is sent. */
export interface ProfileCopyChoice {
    name: boolean;
    photo: boolean;
}

/** What the community the copy is made FROM holds for the member: its name, and its photo as a value that can travel. */
export interface ProfileCopySource {
    callsign: string | null | undefined;
    /** A `data:` or `bundled://` value, or anything else (a node's own picture URL, nothing), which cannot be copied. */
    photo: string | null | undefined;
}

/** The fields of a profile update a copy sends: a field left out is not part of the copy. */
export interface ProfileCopySend {
    callsign?: string;
    avatar?: string;
}

/** A name worth copying: something is there, and it is not a sentinel string a store once held for "none". */
function nameToCopy(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v && v !== 'null' && v !== 'undefined' ? v : null;
}

/**
 * What a copy sends: exactly what was ticked and exists, and nothing else. Null when there is nothing to send (neither box
 * ticked, or a ticked box with nothing behind it): the caller then keeps and sends nothing.
 *
 * A ticked box with nothing behind it (a photo that cannot travel, a name that is empty) adds nothing and does not stand in for
 * the other: ticking the photo never sends the name, and a name-only copy never carries a photo.
 */
export function profileCopySend(source: ProfileCopySource, choice: ProfileCopyChoice): ProfileCopySend | null {
    const send: ProfileCopySend = {};
    if (choice.name) {
        const callsign = nameToCopy(source.callsign);
        if (callsign) send.callsign = callsign;
    }
    if (choice.photo && photoCanTravel(source.photo)) send.avatar = source.photo.trim();
    return send.callsign !== undefined || send.avatar !== undefined ? send : null;
}

/**
 * The photo a browser keeps from another community, to copy into the one it is on, when the member asks. Unlike the offer
 * on joining (lastPhotoOffer: only while this community holds none) this is the member's own request, so it stands even when
 * this community already holds a photo for them: they asked to replace it. It is nothing when there is no last photo, when it
 * cannot travel, or when it was set in this very community (`setHere`): there is nothing to copy from itself.
 */
export function photoToCopyHere(input: { last: LastPhoto | null | undefined; setHere: boolean }): LastPhoto | null {
    const { last, setHere } = input;
    if (!last || !photoCanTravel(last.avatar) || setHere) return null;
    return { avatar: last.avatar.trim(), from: last.from };
}
