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
export const LOCAL_COMMUNITY_MARK = 'Local community';

/** The sheet every marker variant opens. */
export const LOCAL_COMMUNITY_SHEET = Object.freeze({
    title: 'Why this lives in a local community',
    /** One line per feature, then the common line. */
    features: Object.freeze({
        beans: 'Beans are a promise between people who can be found again. Here anyone may join with 12 words, so nobody can yet vouch for who\'s who.',
        escrow: 'A deal holds Beans safely until the job is done.',
        enterprises: 'An enterprise is kept by people its community knows, and spends from a shared pool.',
        decisions: 'A vote binds a community where one person has one voice. Here one person could hold several accounts.',
        invites: 'Someone vouches for each newcomer. Here the door is open, so there are no invites.',
    } satisfies Record<ShowcaseFeature, string>),
    common: 'In a local community all of this is live today. Here it switches on, feature by feature, once this community can check who\'s who.',
    start: 'Start a community',
    nearYou: 'Communities near you',
    howItWorks: 'How it works',
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
        beans: 'An example ledger.',
        escrow: 'Example deals.',
        enterprises: 'An example Commons.',
        decisions: 'An example Decision.',
        invites: 'An example invitation.',
    } satisfies Record<ShowcaseFeature, string>),
    body: Object.freeze({
        beans: 'Help earns Beans, getting help spends them, so help can go round, not just back.',
        escrow: 'A deal holds the Beans until the job is done. Neither side has to go first.',
        enterprises: 'Neighbours pool Beans for shared enterprises, and vote on what the pool funds.',
        decisions: 'One member, one vote. A Decision that passes carries itself out.',
        invites: 'A member vouches for each newcomer, so neighbours know who\'s who.',
    } satisfies Record<ShowcaseFeature, string>),
    /** The strip collapsed with ✕, remembered per node and feature on the device. One line at 320 px / 1.3×. */
    collapsed: '🏘️ An example · Why? ›',
    /** The header over the preview, with the Example chip. */
    header: 'Example Valley · an example member',
});

/** The one-sentence `line` variant, where a local community differs, and the other fixed words of the design's §1. */
export const LOCAL_COMMUNITY_LINES = Object.freeze({
    price: '🏘️ In a local community this is a price in Beans ›',
    poll: '🏘️ In a local community a Decision binds ›',
    invites: '🏘️ A local community grows by invitation: a member vouches for each newcomer ›',
    profile: '🏘️ Trust badges and Beans are earned in a local community ›',
    /** The `action` variant on a listing's deal button. */
    dealAction: 'Request · Beans held safely 🏘️',
    /** The Market's no-Beans terms, in place of "There are no Beans here…". */
    noBeansTerms: 'No Beans here yet. In a local community the price is in Beans, and the ledger remembers who helped whom.',
    /** Home's first step and the Your Beans preview card. */
    firstStep: 'See how Beans work ›',
    yourBeansCard: 'In a local community, help earns Beans and getting help spends them.',
    yourBeansLink: 'See an example ledger ›',
});

/** Where Start a community leads when the node names nowhere else (node_config `startCommunityUrl`). */
export const START_COMMUNITY_URL_DEFAULT = 'https://beanpool.org/#run-a-node';
