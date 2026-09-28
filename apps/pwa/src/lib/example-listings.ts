/**
 * The example cards on a nearly empty Market (Marty, 2026-09-27, board card global-empty-market: "Example cards, plus
 * a few real team listings"). A stranger arriving at the global community before much is posted sees a few cards,
 * each marked Example, that show what people post there. The one rule: never a fake listing that looks like a real
 * person's. So the cards come from the fixed words below, drawn by the app, with no name, face, place, photo or
 * price; nothing is stored or sent, and a card can't be opened, messaged, traded, reported, shared or searched. They
 * never enter the Market's posts, so nothing counts them and the Map never pins them.
 *
 * The node says whether to draw them (`features.exampleListings`, apps/server/src/config/node-profile.ts): on for the
 * global profile, off for a local community. A node that says nothing (older than the switch) gets none. The phone
 * has the same words and rule (apps/native/utils/example-listings.ts).
 */

import type { CommunityInfo } from './api';

/**
 * The examples go once this many real listings are in view. Six fills a phone's screen (a card is about a quarter of
 * it) and two rows of the three-column grid, so from there the Market no longer looks empty to a newcomer and the
 * real listings speak for themselves; below it, four examples still help more than they crowd.
 */
export const EXAMPLES_UNTIL = 6;

export interface ExampleListing {
    key: string;
    type: 'offer' | 'need';
    emoji: string;
    title: string;
    description: string;
}

/** An offer, a need, a skill and a lend: everyday things that make sense anywhere, in plain words. */
export const EXAMPLE_LISTINGS: readonly ExampleListing[] = [
    { key: 'seedlings', type: 'offer', emoji: '🌱', title: 'Vegetable seedlings to give away', description: 'More than I can plant. Free to anyone who will grow them.' },
    { key: 'couch', type: 'need', emoji: '🛋️', title: 'Help moving a couch', description: 'Two people for half an hour, to carry it down the stairs.' },
    { key: 'mending', type: 'offer', emoji: '✂️', title: 'I can mend clothes', description: 'Buttons, hems and small holes. Happy to show you how, too.' },
    { key: 'drill', type: 'need', emoji: '🔧', title: 'Borrow a drill for an afternoon', description: 'To put up two shelves. I will bring it back the same day.' },
];

export const EXAMPLE_BADGE = 'Example';
export const EXAMPLES_HEADING = 'Examples of what people post';
export const EXAMPLES_NOTE = 'Made up to show how it works: these are not real listings. They go once there are enough real ones.';

/** Whether this node asks for the example cards. Only a node that says so outright: unknown is off. */
export function exampleListingsOn(info: CommunityInfo | null | undefined): boolean {
    return info?.features?.exampleListings === true;
}

/**
 * Whether the Market draws the examples: the node asks for them, the viewer hasn't narrowed the list (a search or a
 * filter: an example never answers one), the Market has loaded without an error, and fewer than EXAMPLES_UNTIL real
 * listings are in view.
 */
export function showExampleListings(state: { on: boolean; narrowed: boolean; failed: boolean; realInView: number }): boolean {
    return state.on && !state.narrowed && !state.failed && state.realInView < EXAMPLES_UNTIL;
}

/** What a screen reader says for a card: that it is an example before anything else. */
export function exampleLabel(example: ExampleListing): string {
    return `Example, not a real listing. ${example.type === 'offer' ? 'Offer' : 'Need'}: ${example.title}. ${example.description}`;
}
