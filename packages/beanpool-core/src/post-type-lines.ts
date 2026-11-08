/**
 * The one short line under each choice where a member picks what kind of post to make: the phone's chooser sheet
 * (components/NewPostTypeSheet.tsx, from utils/compose-options.ts) and its new-listing toggle, and the web's toggle on the
 * Map's New Post form. One table, so the two apps say the same plain thing (Marty, 9 Nov, after a member could not tell
 * whether a free harvest invitation was a Need or an Offer: "should it have been a need or an offer? ... its confusing?").
 *
 * An Offer is what you give or do; a Need is what you are looking for. Neither line mentions a price: free is a price of 0
 * (listing-price.ts), not a third kind of post.
 */
import { word } from './words.js';

export const POST_TYPE_LINES = {
    offer: word("Something you'll give or do for others"),
    need: word("Something you're looking for"),
    poll: word('Ask a question with 2–4 options in the feed'),
    event: word('A gathering with a time and a place'),
} as const;

/** The kinds of post a member can start. */
export type PostTypeLineKind = keyof typeof POST_TYPE_LINES;
