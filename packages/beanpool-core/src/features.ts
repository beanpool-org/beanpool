/**
 * How a feature shows to one reader (scratch/global-node/DESIGN-global-showcase-fable.md §4), and the words of the one
 * marker, 🏘️ Local community, and of its sheet (§1, §2). One file for both apps.
 *
 * - **Modes.** `live`: the reader's effective set has it on. `read-only`: the node has it on but this reader not yet
 *   (real data, no writes, the marker on the actions). `preview`: the node has it off and shows it from the sample
 *   community (sample-community.ts), because its `showcase` switch is on. `hidden`: off and not shown, as today: a
 *   local node whose operator turned a feature off meant it.
 * - **The sets.** The node's is `features` from GET /api/community/info; the reader's, `features` from
 *   GET /api/community/me (or /api/home); signed out, the node's. A missing switch counts as on, as the apps read a
 *   node from before it; a missing `showcase` (a server from before it) is today's hiding.
 * - **The marker** never greys, dims, locks or talks tiers; every variant opens the same sheet, which says why the
 *   feature lives in a local community and offers Start a community, Communities near you and How it works.
 */
import { t, word } from './words.js';

export type FeatureMode = 'live' | 'preview' | 'read-only' | 'hidden';

/** The features the marker and the preview cover, each with its sheet line and guide page. */
export type ShowcaseFeature = 'beans' | 'escrow' | 'enterprises' | 'decisions' | 'invites';
export const SHOWCASE_FEATURES: readonly ShowcaseFeature[] = Object.freeze(['beans', 'escrow', 'enterprises', 'decisions', 'invites']);

/** The design's mode table, from three facts: the node shows previews, the node has it on, the reader has it on. */
export function featureMode(f: { showcase: boolean; node: boolean; effective: boolean }): FeatureMode {
    if (f.effective) return 'live';
    if (f.node) return 'read-only';
    return f.showcase ? 'preview' : 'hidden';
}

type FeatureSet = { [k: string]: unknown } | null | undefined;

/**
 * One feature's mode for one reader. `node` is the node's `features`; `reader` the reader's own (absent: signed out,
 * so the node's). The reader's set alone decides `live` (§4, pick 6): a verified member on a node with Beans off is
 * live while the rest stay in preview, with no new screens. Writes stay gated on the server whatever this says.
 */
export function featureModeFor(feature: ShowcaseFeature, node: FeatureSet, reader?: FeatureSet): FeatureMode {
    const nodeOn = node?.[feature] !== false;
    const readerOn = (reader ?? node)?.[feature] !== false;
    return featureMode({ showcase: node?.showcase === true, node: nodeOn, effective: readerOn });
}

/** The marker itself: the pill, and the emoji every line starts with. */
export const LOCAL_COMMUNITY_EMOJI = '🏘️';
export const LOCAL_COMMUNITY_MARK = word('Local community');

/** The sheet every marker variant opens. */
export const LOCAL_COMMUNITY_SHEET = Object.freeze({
    title: word('Why this lives in a local community'),
    /** One line per feature, then the common line. */
    features: Object.freeze({
        beans: word('Beans are a promise between people who can be found again. Here anyone may join with 12 words, so nobody can yet vouch for who\'s who.'),
        escrow: word('A deal holds Beans safely until the job is done.'),
        enterprises: word('An enterprise is kept by people its community knows, and spends from a shared pool.'),
        decisions: word('A vote binds a community where one person has one voice. Here one person could hold several accounts.'),
        invites: word('Someone vouches for each newcomer. Here the door is open, so there are no invites.'),
    } satisfies Record<ShowcaseFeature, string>),
    common: word('In a local community all of this is live today. Here it switches on, feature by feature, once this community can check who\'s who.'),
    start: word('Start a community'),
    nearYou: word('Communities near you'),
    howItWorks: word('How it works'),
    /** The guide page How it works opens, per feature. */
    guide: Object.freeze({
        beans: 'beans-and-the-global-community',
        escrow: 'a-deal-step-by-step',
        enterprises: 'enterprises',
        decisions: 'decisions',
        invites: 'joining',
    } satisfies Record<ShowcaseFeature, string>),
});

/** The strip across the top of a preview screen: a one-line bold lead per feature, then that feature's own body (≤ 3 lines at 320 px / 1.3×). */
export const LOCAL_COMMUNITY_STRIP = Object.freeze({
    lead: Object.freeze({
        beans: word('An example ledger.'),
        escrow: word('Example deals.'),
        enterprises: word('An example Commons.'),
        decisions: word('An example Decision.'),
        invites: word('An example invitation.'),
    } satisfies Record<ShowcaseFeature, string>),
    body: Object.freeze({
        beans: word('Help earns Beans, getting help spends them, so help can go round, not just back.'),
        escrow: word('A deal holds the Beans until the job is done. Neither side has to go first.'),
        enterprises: word('Neighbours pool Beans for shared enterprises, and vote on what the pool funds.'),
        decisions: word('Members decide together, and a Decision that passes carries itself out.'),
        invites: word('A member vouches for each newcomer, so neighbours know who\'s who.'),
    } satisfies Record<ShowcaseFeature, string>),
    /** The strip collapsed with ✕, remembered per node and feature on the device. One line at 320 px / 1.3×. */
    collapsed: word('🏘️ An example · Why? ›'),
    /** The header over the preview, with the Example chip. */
    header: word('Example Valley · an example member'),
});

/** The one-sentence `line` variant, where a local community differs, and the other fixed words of the design's §1. */
export const LOCAL_COMMUNITY_LINES = Object.freeze({
    price: word('🏘️ In a local community this is a price in Beans ›'),
    poll: word('🏘️ In a local community a Decision binds ›'),
    invites: word('🏘️ A local community grows by invitation: a member vouches for each newcomer ›'),
    profile: word('🏘️ Trust badges and Beans are earned in a local community ›'),
    /** The `action` variant on a listing's deal button. */
    dealAction: word('Request · Beans held safely 🏘️'),
    /** The Market's no-Beans terms, in place of "There are no Beans here…". */
    noBeansTerms: word('No Beans here yet. In a local community the price is in Beans, and the ledger remembers who helped whom.'),
    /** Home's first step and the Your Beans preview card. */
    firstStep: word('See how Beans work ›'),
    yourBeansCard: word('In a local community, help earns Beans and getting help spends them.'),
    yourBeansLink: word('See an example ledger ›'),
});

/** Where Start a community leads when the node names nowhere else (node_config `startCommunityUrl`). */
export const START_COMMUNITY_URL_DEFAULT = 'https://beanpool.org/#run-a-node';

/**
 * What a member must have before they post, by whether the node has Beans on (its `features.beans`, server
 * getProfileSwitches().beans). The Offer-first rule and the profile photo guard a community's credit: where Beans are
 * off (the global node) there is none, so a newcomer's first post may be a Need, with no profile photo and no listing
 * photo (rehearsal 2026-10-14 B4; global review M2, S6). The node and both apps read this one rule.
 */
export type PostRules = {
    /** A Need waits until the member has listed an Offer (CONTRIBUTION_REQUIRED). */
    offerFirst: boolean;
    /** A post, poll or event waits until the member has a profile photo. */
    profilePhoto: boolean;
    /** A Need carries at least one photo (an Offer always does). */
    needPhoto: boolean;
};

export function postRulesFor(beansOn: boolean): PostRules {
    return { offerFirst: beansOn, profilePhoto: beansOn, needPhoto: beansOn };
}

/**
 * Sign-up's photo step with no picture picked yet (rehearsal 14 Oct S9): Next works either way, never a gate (memory
 * onboarding-no-hard-gates), and this says what the node will ask for, by the rule above.
 */
export function photoStepNote(beansOn: boolean): string {
    return postRulesFor(beansOn).profilePhoto
        ? t('This community asks for a profile picture before you post. You can add one later from your profile.')
        : t('A picture is optional here. You can add one later from your profile.');
}
