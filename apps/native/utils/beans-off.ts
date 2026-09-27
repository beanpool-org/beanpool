/**
 * The rest of the phone on a node with Beans off (the worldwide community). G8 (market-global.ts) took Beans off the
 * Market and a post's page; this covers everywhere else a Beans figure or a price was drawn: My Deals, a chat's post
 * header, the Talk sort, profiles, Settings' pricing guide, the Commons header, the create-group form, profile setup's
 * "how it works", and a group's post form. There, a Beans figure is always 0 and means nothing to a newcomer.
 *
 * The rule is `beansOn`'s (node-profile.ts): only a node that says outright `features.beans === false` has no Beans,
 * and a node that says nothing trades in them, so every local community is unchanged. Screens call `beansOn` itself.
 * The helpers below restate it rather than import it, so this file loads nothing at runtime (node-profile.ts brings
 * the phone's storage with it); the test holds the two to the same answer.
 */

import type { NodeFeatures } from './node-profile';

function beansShown(features: NodeFeatures | null | undefined): boolean {
    return features?.beans !== false;
}

/*
 * A group's post form (app/group-post.tsx). With Beans off it has no price field, and the price never holds a post
 * back: the post goes up at 0 Beans and a total price, which is all the server takes there. With Beans on, or on a
 * node that says nothing, each of these is exactly what the form did before.
 */

/** The Beans and the price unit the post goes up with. */
export function groupPostPrice(field: string, priceType: string, features: NodeFeatures | null | undefined): { credits: number; price_type: string } {
    return beansShown(features) ? { credits: Number(field) || 0, price_type: priceType } : { credits: 0, price_type: 'fixed' };
}

/** Tapping Post marks the price field: empty, not a number, or below 0. */
export function groupPostPriceInvalid(field: string, features: NodeFeatures | null | undefined): boolean {
    return beansShown(features) && (!field.trim() || isNaN(Number(field)) || Number(field) < 0);
}

/** What the alert says when a required field is missing. */
export function groupPostMissingFields(features: NodeFeatures | null | undefined): string {
    return beansShown(features) ? 'Please provide a title, category, and price/credits.' : 'Please provide a title and category.';
}

/*
 * Profile setup's "How BeanPool works" step (components/OnboardingGuide.tsx). Its first three cards are about Beans:
 * zero is the place to be, a credit line to -2000, the Commons fee over 200, 40 Beans an hour, Beans held in trust.
 * With Beans off they are one card instead, the one the join wizard shows there (app/welcome.tsx).
 */

/** The one card in place of the three about Beans. */
export const NO_BEANS_GUIDE_CARD = {
    title: '🌍 A place to meet',
    text: 'The global community is for meeting people and finding a community near you. There are no Beans here: credit, the Commons and trading in Beans live in local communities, which you join with an invite from a member.',
} as const;

/** The line under the step's title. */
export function howItWorksSubtitle(features: NodeFeatures | null | undefined): string {
    return beansShown(features) ? 'A quick look at this community economy.' : 'A quick look at this community.';
}
