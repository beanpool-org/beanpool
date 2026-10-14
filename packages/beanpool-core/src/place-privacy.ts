/**
 * What a member sees of other people's places where anyone can join in a minute (`features.openMembership`, the global
 * node; scratch/global-node/DESIGN-global-member-privacy-fable.md §4, Marty's call 1, 15 Oct 2026). The node serves a
 * listing's place to about a kilometre to every member but its author (and an enterprise's keepers), and an event's
 * exact spot to its host and the people let in (the engine's exactPlacesFor). These are the words both apps show for
 * it, and the one test of when to show them, so the phone and the web app say the same thing at the same time.
 */
import { word } from './words.js';

/** Under a listing whose place this member reads to about a kilometre. `{name}` is the author's name. */
export const ROUGH_PLACE_LINE = word('Shown to about 1 km. Ask {name} for the spot when you arrange to meet.');

/** Under an event's typed place name, where anyone can join: the place name goes to everyone who can see the event. */
export const PLACE_NAME_HELPER = word('Shown to everyone who can see the event. Put the exact address in the note below.');

/** The same field, when what was typed looks like a street address (looksLikeStreetAddress). */
export const PLACE_NAME_ADDRESS_NUDGE = word('This looks like a street address. Everyone who can see the event will read it, so it is safer in the note below.');

/** The fields of a post the test reads, as both apps hold them. */
export interface PlaceShownPost {
    authorPublicKey?: string | null;
    type?: string | null;
    lat?: number | null;
    lng?: number | null;
    /** An event's host reads its RSVPs (the node sends them to the host alone). */
    eventRsvps?: unknown;
    myRsvp?: string | null;
    /** false while the host hasn't let this member in yet; absent where the host doesn't let people in. */
    myLetIn?: boolean | null;
}

/**
 * Whether this member reads the post's place to about a kilometre, so the listing says so (ROUGH_PLACE_LINE): only where
 * the node says `openMembership`, only for a post with a place, never for their own, and for an event never for its host
 * or someone Going whom the host let in (or Going where the host doesn't let people in), who have the spot. A keeper
 * reads their enterprise's listings exactly too; the apps can't always tell, and then say the line, which is the
 * careful way to be wrong.
 */
export function placeShownRoughly(post: PlaceShownPost, me: string | null | undefined, openMembership: boolean): boolean {
    if (!openMembership) return false;
    if (typeof post.lat !== 'number' || typeof post.lng !== 'number') return false;
    if (me && post.authorPublicKey === me) return false;
    if (post.type === 'event') {
        if (post.eventRsvps !== undefined) return false;
        if (post.myRsvp === 'going' && post.myLetIn !== false) return false;
    }
    return true;
}

/** Words for the kinds of street, as people type them (English; another language's typed address isn't caught). */
const STREET_WORDS = 'st|street|rd|road|ave|avenue|av|ln|lane|dr|drive|ct|court|cres|crescent|pl|place|tce|terrace|pde|parade|hwy|highway|blvd|boulevard|cl|close|way|grove|gr';

/**
 * Whether a typed place name looks like a street address: a house number, then a street name with a kind of street
 * ("12 Example St", "4/21 Station Road", "Unit 3, 9 Hill Cres"). A gentle nudge, never a refusal: "Bangalow Hall", "the
 * old bowls club" and "Shed 2" don't match.
 */
export function looksLikeStreetAddress(typed: string): boolean {
    return new RegExp(`(^|[\\s,])\\d+[a-z]?(\\s*[/-]\\s*\\d+[a-z]?)?\\s+([a-z'’.-]+\\s+){1,3}(${STREET_WORDS})\\b\\.?`, 'i').test(typed);
}
