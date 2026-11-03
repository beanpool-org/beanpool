/**
 * Invite and share (Marty, 3 Nov: "one button on a listing that invites a friend and brings them to that listing once they've
 * joined"): the invite a member makes from a listing or an event, handed to the share sheet as
 * `{community}/?invite={code}&post={id}`. The same on both apps (apps/native/components/InviteAndShare.tsx,
 * apps/pwa/src/components/InviteAndShare.tsx).
 *
 * The post id is only ever a place to open once the friend has joined. It gives no read a non-member didn't have: the
 * trampoline and the join screens show what an invite shows today, and read the id for nothing else. It is checked as an id
 * (a path, a query or an address is no id), and one the friend can't see after joining opens nothing, with no error.
 *
 * An invite with no post is the link it always was, byte for byte.
 */
import { isPeekPostId } from './peek-ticket.js';
import { word } from './words.js';

export const INVITE_SHARE_WORDS = {
    button: word('Invite and share'),
    /** Under the button: it makes one invite, and an invite works once. */
    line: word('One invite, for one person: a code works once.'),
    /** In the panel the button opens. */
    panel: word('The person you send it to joins with this invite and lands on this listing.'),
    make: word('Make the invite and share'),
    /** No answer from the community: an offline ticket can't carry the listing, so none is made. */
    offline: word('An invite from here needs a connection, because an offline ticket can’t take someone to this listing. Try again when you’re connected.'),
    /** Where the community gave no words of its own. */
    notMade: word('The invite was not made.'),
};

/** A post id as the node's links carry it, or null: what the node's ids are (UUIDs, `sample-…`), never a path, a query or an address. */
export function landingPostId(value: unknown): string | null {
    return isPeekPostId(value) ? value : null;
}

/**
 * The link the share sheet is handed: the community's address, the invite's code, and the listing. Without a valid listing
 * id it is the plain invite link `{community}/?invite={code}`, byte for byte as the People tab and the Invites page have
 * always made it.
 */
export function inviteAndShareLink(community: string, code: string, postId?: string | null): string {
    const base = `${community}/?invite=${code}`;
    const id = landingPostId(postId);
    return id ? `${base}&post=${encodeURIComponent(id)}` : base;
}

/**
 * The listing an invite link or address carries (`?invite=…&post=…`, or a Play referrer `invite=…&post=…`), or null: no
 * invite, no `post=`, or an id that isn't one. A `post=` with no invite is a shared listing, not this.
 */
export function postIdFromInviteLink(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.split('#')[0];
    if (!/(?:^|[?&])invite=[^&\s]/.test(s)) return null;
    const m = /(?:^|[?&])post=([^&\s]+)/.exec(s);
    if (!m) return null;
    try {
        return landingPostId(decodeURIComponent(m[1]));
    } catch {
        return null;
    }
}
