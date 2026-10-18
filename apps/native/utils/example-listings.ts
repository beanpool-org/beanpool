/**
 * The example cards on a nearly empty Market (Marty, 2026-09-27, board card global-empty-market: "Example cards, plus
 * a few real team listings"). A stranger arriving at the global community before much is posted sees a few cards,
 * each marked Example, that show what people post there. The one rule: never a fake listing that looks like a real
 * person's. So the cards come from the fixed words below, drawn by the app, with no name, face, place, photo or
 * price; nothing is stored or sent, and a card can't be opened, messaged, traded, reported, shared or searched. They
 * are never in the Market's list data or the phone's posts, so nothing counts them and the map never pins them.
 *
 * The node says whether to draw them (`features.exampleListings`, apps/server/src/config/node-profile.ts): on for the
 * global profile, off for a local community. A node that says nothing (older than the switch) gets none. The web app
 * has the same words and rule (apps/pwa/src/lib/example-listings.ts).
 */

import { t, word, type WordKey } from '@beanpool/core';
import type { NodeFeatures } from './node-profile';

/**
 * The examples go once this many real listings are in view. Six fills a phone's screen (a card is about a quarter of
 * it) and two rows of the web app's three-column grid, so from there the Market no longer looks empty to a newcomer
 * and the real listings speak for themselves; below it, four examples still help more than they crowd.
 */
export const EXAMPLES_UNTIL = 6;

/** The words are word() keys: the cards and their screen-reader line show them through t(), in the member's language. */
export interface ExampleListing {
    key: string;
    type: 'offer' | 'need';
    emoji: string;
    title: WordKey;
    description: WordKey;
}

/**
 * An offer, a need, a skill and a lend: everyday things that make sense anywhere, in plain words. Emoji old enough
 * for Android 8 (API 26), so none draws as an empty box.
 */
export const EXAMPLE_LISTINGS: readonly ExampleListing[] = [
    { key: 'seedlings', type: 'offer', emoji: '🌱', title: word('Vegetable seedlings to give away'), description: word('More than I can plant. Free to anyone who will grow them.') },
    { key: 'couch', type: 'need', emoji: '🛋️', title: word('Help moving a couch'), description: word('Two people for half an hour, to carry it down the stairs.') },
    { key: 'mending', type: 'offer', emoji: '✂️', title: word('I can mend clothes'), description: word('Buttons, hems and small holes. Happy to show you how, too.') },
    { key: 'drill', type: 'need', emoji: '🔧', title: word('Borrow a drill for an afternoon'), description: word('To put up two shelves. I will bring it back the same day.') },
];

export const EXAMPLE_BADGE = word('Example');
export const EXAMPLES_HEADING = word('Examples of what people post');
export const EXAMPLES_NOTE = word('Made up to show how it works: these are not real listings. They go once there are enough real ones.');

/** Whether this node asks for the example cards. Only a node that says so outright: unknown is off. */
export function exampleListingsOn(features: NodeFeatures | null | undefined): boolean {
    return features?.exampleListings === true;
}

/**
 * Whether the Market draws the examples: the node asks for them, the member hasn't narrowed the list (a search or a
 * filter: an example never answers one), the first sync has landed, and fewer than EXAMPLES_UNTIL real listings are
 * in view.
 */
export function showExampleListings(state: { on: boolean; narrowed: boolean; loaded: boolean; realInView: number }): boolean {
    return state.on && !state.narrowed && state.loaded && state.realInView < EXAMPLES_UNTIL;
}

/** What a screen reader says for a card, in the member's language: that it is an example before anything else. */
export function exampleLabel(example: ExampleListing): string {
    const values = { title: t(example.title), description: t(example.description) };
    return example.type === 'offer'
        ? t('Example, not a real listing. Offer: {title}. {description}', values)
        : t('Example, not a real listing. Need: {title}. {description}', values);
}

/**
 * The accessibility props of one card: one element read as text, never a button, and nothing that responds to a
 * tap. The component spreads exactly these and adds no handler of its own.
 */
export function exampleCardA11y(example: ExampleListing): { accessible: true; accessibilityRole: 'text'; accessibilityLabel: string } {
    return { accessible: true, accessibilityRole: 'text', accessibilityLabel: exampleLabel(example) };
}
