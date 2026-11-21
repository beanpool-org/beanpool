/**
 * The rest of the phone on a node with Beans off (the worldwide community). G8 (market-global.ts) took Beans off the
 * Market and a post's page; this covers everywhere else a Beans figure or a price was drawn: Your deals, a chat's post
 * header, the Talk sort (and a Beans sort left over from before), profiles, Settings' pricing guide, the Commons header, the create-group form, profile setup's
 * "how it works", and a group's post form. There, a Beans figure is always 0 and means nothing to a newcomer.
 *
 * The rule is `beansOn`'s (node-profile.ts): only a node that says outright `features.beans === false` has no Beans,
 * and a node that says nothing trades in them, so every local community is unchanged. Screens call `beansOn` itself.
 * The helpers below restate it rather than import it, so this file loads nothing of the phone's at runtime (node-profile.ts
 * brings the phone's storage with it; core's words layer is pure); the test holds the two to the same answer.
 */

import { parseHundredths, t } from '@beanpool/core';
import type { NodeFeatures } from './node-profile';
import type { DecisionTouch, DecisionEffect } from './db';

function beansShown(features: NodeFeatures | null | undefined): boolean {
    return features?.beans !== false;
}

/*
 * A group's post form (app/group-post.tsx). With Beans off it has no price field, and the price never holds a post
 * back: the post goes up at 0 Beans and a total price, which is all the server takes there. With Beans on, or on a
 * node that says nothing, the typed price is read as every typed amount is (core parseHundredths): whole hundredths of
 * a Bean, the language's decimal mark, at most two decimals, never a float.
 */

/** The price (whole hundredths of a Bean, the node's `price_c`) and its unit the post goes up with. */
export function groupPostPrice(field: string, priceType: string, features: NodeFeatures | null | undefined): { price_c: number; price_type: string } {
    if (!beansShown(features)) return { price_c: 0, price_type: 'fixed' };
    const read = parseHundredths(field);
    return { price_c: read.ok ? read.value : 0, price_type: priceType };
}

/** Tapping Post marks the price field: empty, or not an amount of Beans 0 or more with at most two decimals (parseHundredths). */
export function groupPostPriceInvalid(field: string, features: NodeFeatures | null | undefined): boolean {
    return beansShown(features) && !parseHundredths(field).ok;
}

/** What the alert says when a required field is missing. */
export function groupPostMissingFields(features: NodeFeatures | null | undefined): string {
    return beansShown(features) ? t('Please provide a title, category, and price/credits.') : t('Please provide a title and category.');
}

/*
 * Talk's sort (app/(tabs)/chats.tsx). With Beans off there is no "Beans: High / Low" chip, so a Beans sort picked
 * earlier (before the node's profile arrived, or on another community) would sort by a chip nobody can see and light
 * the options badge with nothing selected to explain it. It goes back to Recent. With Beans on, the pick stands.
 */

/** The sort Talk keeps. */
export function talkSort<S extends string>(sortBy: S, features: NodeFeatures | null | undefined): S | 'recent' {
    return !beansShown(features) && (sortBy === 'credits_desc' || sortBy === 'credits_asc') ? 'recent' : sortBy;
}

/*
 * Proposing a community Decision (components/ProposeDecisionModal.tsx).
 * Where Beans are off, the Commons has nothing to grant or write off (decisions-engine.ts:440),
 * so the pool touch is omitted, credit and enterprise-keeper actions are dropped, and the
 * title placeholder carries a neutral example. Removing a member is never offered: since
 * removal by vote S3 that vote opens only when an admin pauses someone.
 */

/** The decision touches offered on this node. */
export function decisionTouchesFor(features: NodeFeatures | null | undefined): DecisionTouch[] {
    return beansShown(features) ? ['member', 'pool'] : ['member'];
}

/** The decision effects offered for a touch on this node. */
export function decisionEffectsFor(touch: DecisionTouch, features: NodeFeatures | null | undefined): DecisionEffect[] {
    if (touch === 'pool') {
        return beansShown(features) ? ['grant_enterprise', 'grant_hardship', 'write_off_deficit'] : [];
    }
    if (beansShown(features)) {
        return [
            'suspend_member',
            'unsuspend_member',
            'reinstate_member',
            'freeze_credit',
            'unfreeze_credit',
            'remove_lead_keeper',
        ];
    }
    return [
        'suspend_member',
        'unsuspend_member',
        'reinstate_member',
    ];
}

/** The proposal title placeholder, in the member's language. */
export function proposeTitlePlaceholder(features: NodeFeatures | null | undefined): string {
    return beansShown(features)
        ? t('e.g. Grant 200 beans to the Tool Library')
        : t('e.g. Community proposal');
}
