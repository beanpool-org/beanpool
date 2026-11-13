/**
 * Home, the screen that isn't the Market (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H3): the rules of
 * the card list, with no React and no network, so the vitest cases prove them (home-cards.test.ts) and the phone's
 * Home (H2) can carry the same module and cases.
 *
 * The node answers the whole screen in one read, `GET /api/home` (apps/server/src/routes/home-answer.ts): a card with
 * nothing to say is not in the answer at all. What is left to the app is what only the member's own layout decides:
 *
 *   - **the order and which cards** are the member's version-2 list (lib/home-layout.ts, the card frame): `shownFrame`
 *     draws it, `needs` first and `community` last (it carries Add a card and Arrange);
 *   - **the two cards with no data of their own** (§3.1): `interests` while no interest is set (or opened from the
 *     Market card's Tune), and `invite` where invites are on, after the member's first Offer;
 *   - **interests reorder, they never filter** (§4.3): starred categories first, the rest after;
 *   - **unknown ids are dropped, never refused**, on both sides (§4.1: a node older or newer than the app).
 *
 * The layout is kept on the account (`home.layout`, H1, apps/server/src/engine/home-preferences.ts) with a copy in this
 * browser (lib/home-cache.ts); the last write wins by `updatedAt`.
 */

import type { CircleCard, CircleDemand, ShownFromLine } from '@beanpool/core';
import { copyFromLine, eventCopyOf, freePriceWords, formatHundredths } from '@beanpool/core';
import { readSearchSettings, readSkySettings, skyPlaceFor, skyToday, type SkyToday } from '@beanpool/core';
import { readTourRecord, tourEnded } from '@beanpool/core';
import { FIND_COMMUNITY_WORDS, communitiesNear, communityPromiseLines, findCommunityState, isNearKm, knownCommunityCount, notAnsweringLately, t, type FindCommunityState } from '@beanpool/core';
import { formatCount, formatDate, formatNumber, tn, word, type WordKey } from '@beanpool/core';
import { deviceLocalClock, eventWhenParts, repeatCaption, type RepeatPattern } from '@beanpool/core';
import { STARTER_LAYOUT, cardOnNode, cardOrder, pinnedCards, type HomeCardInstance, type HomeLayoutV2 } from './home-layout';
import { formatRelativeTime } from './pulse';
import { tierWords } from './trust-tier';
import { VISITOR_WORDS } from './visitor-lobby';
import type { ShopHomeCard } from './shop';
import { HOME_CHAT_KINDS, readChatSettings, homeChatPicked, type HomeChatCard, type HomeChatKind, type HomeChatLine } from '@beanpool/core';
import { checkDmThread, dmLineShownText, encodePlaintext, type DmLineView, type DmThreadLine } from './e2e-crypto';
import { dmKeyContext } from './dm-lock';
import { openLine } from './group-chat-crypto';
import { groupTombstoneText } from './group-chat-lines';
import { groupLineView, isSealedGroupLine, GROUP_LINE_FORMER_MEMBER, GROUP_LINE_UNVERIFIED_TEXT } from './group-line-display';
import { chatAuthorWords, chatLineWords } from './chat-line-words';
export { tierWords };
export type { HomeLayoutV2 };

/** The catalogue (§3.1, and Tips: scratch/home/TIPS-DESIGN-fable.md), in the default order. The same 18 ids as the node's. */
export const HOME_CARD_IDS = [
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups',
    'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
] as const;
export type HomeCardId = typeof HOME_CARD_IDS[number];
const CARD_IDS: ReadonlySet<string> = new Set(HOME_CARD_IDS);
export const isHomeCardId = (id: unknown): id is HomeCardId => typeof id === 'string' && CARD_IDS.has(id);

/**
 * Said on the page once the member's notices are marked seen (lib/api.ts markNoticesSeen: an alert put away, or Home's
 * own "Mark as read"): Home reads again, so "From your community" goes with the alert.
 */
export const NOTICES_SEEN_EVENT = 'beanpool:notices-seen';

/** The cards a visitor's Home is made of (§5.3), besides the Join card. */
export const VISITOR_CARDS: readonly HomeCardId[] = ['find', 'market', 'events', 'community'];

const DAY_MS = 86_400_000;

// ── the answer, as GET /api/home sends it ─────────────────────────────────────────────────────────────────────────────

export type NeedsTarget =
    | { to: 'admin'; section: string }
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean; thread?: 'group' | 'enterprise' }
    | { to: 'unread-messages' }
    | { to: 'your-groups' }
    /** An enterprise's own screen, for its keepers' vote; sent only to an app that asks with `lands=enterprise` (lib/api.ts getHome). */
    | { to: 'enterprise'; id: string }
    /** A chat group's info, for its members' vote; sent only to an app that asks with `lands=group` (lib/api.ts getHome). */
    | { to: 'group'; id: string }
    /**
     * The member's open invitation to a group (its info, with Join), or to several (Commons, where each shows invited);
     * sent only to an app that asks with `lands=invite` (lib/api.ts getHome).
     */
    | { to: 'invite'; id: string }
    | { to: 'invites' }
    | { to: 'people' }
    | { to: 'shop'; id: string }
    | { to: 'shop-mine' };
/** `knock`: requests to join (front doors S1), only to an app that asks with lands=people (lib/api.ts getHome); People → Invites lists them (S2). */
export interface NeedsItem { kind: 'admin' | 'knock' | 'ask' | 'deal' | 'vote' | 'invite' | 'message' | 'group'; count: number; accent: boolean; label: string; target: NeedsTarget; closesAt?: string }

export interface HomeProbation {
    onProbation: boolean;
    rules?: 'words' | 'ordinary';
    ageEndsAt: string | null;
    keptPosts: number;
    keptPostsNeeded: number;
    limits?: { posts?: { limit: number }; photos?: { limit: number }; new_dm_recipients?: { limit: number } };
    endsWhen?: { hours: number; keptPosts: number };
}

export interface HomeMe {
    joinedAt: string | null;
    isKeeper: boolean;
    probation: HomeProbation | null;
    interests: string[];
    /** When `interests` last changed on the node; null when it keeps none, absent from a node before the stamp. */
    interestsUpdatedAt?: string | null;
    area: { lat: number; lng: number } | null;
    firstOffer: boolean;
    standing: 'member' | 'suspended';
    /** The account's tour record (DESIGN-getting-started-fable.md §2): Getting started is drawn only while it hasn't ended. */
    tour?: unknown;
}

export interface HomeCommunity {
    key: string; name: string | null; url: string | null; memberCount: number | null; distanceKm: number | null;
    /** Its last push to the directory (front doors S13); absent from an older global node. */
    lastSeenAt?: string | null;
    /** How quickly it answers requests to join (Lounge L1, entry S1: 'week' | 'slow' | 'none' | null). */
    answers?: 'week' | 'slow' | 'none' | null;
    /** The listing promise its push carried: an object, null for none, left out by an older global node (core communityPromiseLines reads it). */
    promise?: unknown;
    /** Whether it takes requests to join. */
    acceptingKnocks?: boolean | null;
    /** The day it says it closes (YYYY-MM-DD). */
    closingOn?: string | null;
}
export interface HomeFind {
    point: 'request' | 'area' | null;
    communities: HomeCommunity[];
    /** Every community listed (the node always sends it; an odd value reads as unknown, never 0: knownCommunityCount). */
    communityCount: number | null;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    watches: (Record<string, unknown> & { wouldHelp?: boolean })[] | null;
    knock: null;
    /** When the node last fetched the directory; null: never, so nothing may be said to be missing (@beanpool/core find-community.ts). */
    directoryFetchedAt: string | null;
    /** How many are waiting around here (place circle): each null below 3. Absent from an older node. */
    demand?: CircleDemand | null;
    /** The reader's own place circle. */
    circle?: (CircleCard & { id: string }) | null;
}

export interface HomeMarketItem {
    id: string; type: 'offer' | 'need'; title: string; category: string; price_c?: number; photoUrl: string | null; distanceKm?: number | null; bannerUrl?: string | null;
    /** A member's copy on the global community (@beanpool/core eventCopyOf): where it is from, and its price there in words. */
    shownCopy?: boolean; shownFrom?: ShownFromLine; shownPrice?: string;
    /** An Offer priced for each one (core per-item.ts): only on such a row, so every other row and an older node's read as they did. */
    priceType?: string; unitsLeft?: number; lot?: { units: number; price_c: number } | null;
    /** An owner's or admin's live pin (DESIGN-pinning-fable.md §2.2): the row leads its card with 📌. Absent from an older node. */
    pinned?: boolean;
}
/**
 * One row of "Asked near you" (apps/server routes/home-answer.ts NeedItem): a neighbour's open Need, with the Market card's own
 * fields for the row. `credits` only where Beans are on; `priceType` only when the post has one.
 */
export interface HomeNeedItem { id: string; title: string; category: string; price_c?: number; priceType?: string; createdAt: string; photoUrl: string | null }
/** A saved search as the node builds it (apps/server routes/home-answer.ts `searchCard`), keyed by its instance id. */
export interface HomeSearchCard { q: string; kind: 'offer' | 'need' | 'any'; category: string | null; km: number | null; items: HomeMarketItem[]; more: boolean }
export interface HomeEventItem {
    id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null;
    /** The host's clock and its zone, and an online event (DESIGN-event-times §4); absent from a node before them. */
    startLocal?: string; tz?: string; online?: boolean;
    /** A repeating event's pattern and last date, for the ↻ caption (DESIGN-event-times §8); absent on a one-off. */
    repeat?: RepeatPattern; repeatUntil?: string;
    /** A member's copy on the global community (@beanpool/core eventCopyOf): where it is from stands for its place. */
    shownCopy?: boolean; shownFrom?: ShownFromLine;
    /** A live pin (HomeMarketItem.pinned): the event leads Coming up, whatever its date. */
    pinned?: boolean;
}

export interface DealItem {
    txId: string;
    postId: string;
    title: string;
    with: string | null;
    waitsOnMe: boolean;
    at: string | null;
}

export interface EnterpriseLine {
    /** Whole hundredths of a Bean: + in, − out. */
    amount_c: number;
    at: string;
    kind: 'member' | 'deal' | 'commons' | 'other';
    who: string | null;
}

export interface DecideItem {
    id: string;
    title: string;
    closesAt: string;
    voted: boolean;
}

export interface GroupLastLine {
    who: string | null;
    at: string;
    text: string;
    locked?: {
        ciphertext: string;
        nonce: string;
        metadata: string | null;
    };
}

export interface MonthFigures {
    trades: number;
    /** Whole hundredths of a Bean. */
    in_c: number;
    out_c: number;
    more?: boolean;
}

export interface HomeCards {
    [k: string]: unknown;
    needs?: { items: NeedsItem[] };
    safety?: { words: true; signInLinked: false };
    find?: HomeFind;
    steps?: {
        joinedAt: string | null; firstOffer: boolean;
        /** Whether the member has posted a Need here (cold-start N1); absent from a node before it: that node has no such line. */
        firstNeed?: boolean;
        firstPost: boolean; photo: boolean; interests: boolean;
        invited: boolean | null; area: boolean; knocked: null; saidHello?: boolean; watch?: boolean; sawLedger?: boolean;
    };
    deals?: { open: number; waiting: number; waitingOnMe: { txId: string; postId: string; title: string } | null; items?: DealItem[] };
    /** `lifecycle` 'bounded': the one kept is a project (§3.1); absent from an older node. */
    enterprise?: {
        id: string;
        name: string;
        requests: number;
        others: number;
        lifecycle?: 'ongoing' | 'bounded';
        keepers?: number;
        balance_c?: number;
        month?: MonthFigures;
        latest?: EnterpriseLine | null;
    };
    /** "Your shop and tools": the member's own shop, or none yet. */
    shop?: ShopHomeCard;
    events?: { items: HomeEventItem[]; radiusKm: number | null };
    market?: { items: HomeMarketItem[]; total14d: number; more: boolean; examples?: true };
    /** "Asked near you" (cold-start N1): the open Needs of neighbours, the member's stars first; absent while there is none to show. */
    asked?: { items: HomeNeedItem[] };
    decide?: {
        open: number;
        soonestClosesAt: string | null;
        polls: number;
        pollsMore: boolean;
        items?: DecideItem[];
        poll?: { id: string; title: string; closesAt: string; pinned?: boolean } | null;
    };
    groups?: { items: { id: string; kind: 'group' | 'enterprise' | 'event'; name: string; unread: number; muted: boolean; last?: GroupLastLine | null }[]; total: number };
    joined?: { count7d: number; radiusKm: number | null; names?: { callsign: string; avatarUrl: string | null }[] };
    pulse?: { items: { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null; publishedAt?: string | null }[] };
    beans?: { balance_c: number; room_c: number; tier: string; activated: boolean; frozen: boolean; month?: MonthFigures & { fees_c: number; more: boolean } };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    /** `place`: the community's own, to two decimals (a member's answer on a local community that has one). */
    community?: {
        name: string | null;
        members: number;
        listings?: number;
        tradesThisMonth?: number;
        communities?: number;
        place?: { lat: number; lng: number };
        /** A member's three figures are null when they are zero: not written (home-answer.ts communityCard, §2.7). */
        joined7d?: number | null;
        eventsSoon?: number | null;
        /** The Commons pot, whole hundredths of a Bean (home-answer.ts memberFigures). */
        commonsPot_c?: number | null;
    };
}

export interface HomeFeatures {
    beans?: boolean; escrow?: boolean; enterprises?: boolean; openJoin?: boolean; knocks?: boolean; guestListingsOnly?: boolean;
    exampleListings?: boolean; decisions?: boolean; invites?: boolean; wordsDoor?: boolean; probation?: boolean;
    /** Present, and true, only where the node previews what it switched off (the global showcase). */
    showcase?: boolean;
    [k: string]: unknown;
}

export interface HomeAnswer {
    generatedAt: string;
    profile: 'local' | 'global' | string;
    features: HomeFeatures;
    /** Who decides a removal, to a member only, beside `features` (server config/features-for.ts): read through core shapeFeaturesOf. */
    removalDecider?: 'automatic' | 'everyone' | 'jury';
    welcome?: true;
    me: HomeMe | null;
    /** The account's layout as the node keeps it: version 2, or version 1 from a node before the card frame (lib/home-layout.ts). */
    layout?: unknown;
    cards: HomeCards;
}

// ── what is shown ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShownOptions {
    now?: number;
    /** The interests card was opened from the Market card's Tune: shown even with interests set. */
    interestsOpen?: boolean;
    /** The interests the page holds now (a tap saves in the background; the card follows the tap, not the answer). */
    interests?: string[];
    /** The Tips card has a tip to show (@beanpool/core home-tips.ts, from the browser's record); absent: none. */
    tipsUp?: boolean;
    /** The tour ended in this browser (Done or Skip) before the account's answer says so; absent: the answer's word. */
    tourOver?: boolean;
    /** Context for whether a knock is open, so Find stays pinned past its first 30 days (Lounge L1). */
    hasOpenKnock?: boolean;
    hasOpenWatch?: boolean;
    knocks?: readonly { sentAt?: unknown; cancelledAt?: string }[];
}

/** Whether the tour has ended for this reader: the account says so, or this browser just ended it. */
export const tourOverFor = (answer: Pick<HomeAnswer, 'me'>, opts: Pick<ShownOptions, 'tourOver'> = {}): boolean =>
    !!opts.tourOver || tourEnded(readTourRecord(answer.me?.tour));

/**
 * The Home a reader sees when none is saved: Getting started alone (core's default, null here) for a member whose tour
 * hasn't ended; the starter set once it has (DESIGN-getting-started-fable.md §1).
 */
export function shownLayout(answer: Pick<HomeAnswer, 'me'> | null | undefined, layout: HomeLayoutV2 | null, opts: Pick<ShownOptions, 'tourOver'> = {}): HomeLayoutV2 | null {
    if (layout || !answer) return layout;
    return !answer.me || tourOverFor(answer, opts) ? STARTER_LAYOUT : null;
}

/**
 * The cards to draw on the card frame, top to bottom (CARD-FRAME §1): the member's list in their order
 * (lib/home-layout.ts cardOrder: `needs` first, `community` last, a pinned `find` under `needs`), each only where this
 * node shows it (`cardOnNode`) and when it has something to say (§3.1 "shown when"); a saved search always (its listings
 * come with slice F4). A visitor (`welcome`) gets only the visitors' cards, in the catalogue's order. The interests card
 * opened from the Market card's Tune shows under the Market card even when it isn't on the list. A card left out takes
 * no space.
 */
/** An answer as lib/home-layout.ts reads it (profile, features, cards). */
export const frameOf = (a: HomeAnswer) => ({
    profile: String(a.profile), features: a.features as unknown as { [k: string]: unknown }, cards: a.cards as unknown as { [k: string]: unknown }, me: a.me,
});

export function shownFrame(answer: HomeAnswer, layout: HomeLayoutV2 | null, opts: ShownOptions = {}): HomeCardInstance[] {
    const now = opts.now ?? Date.now();
    if (answer.welcome || !answer.me) {
        return HOME_CARD_IDS.filter(id => VISITOR_CARDS.includes(id) && !!answer.cards[id as keyof HomeCards]).map(id => ({ id, type: id }));
    }
    const me = answer.me;
    const has = ({ type, settings }: HomeCardInstance): boolean => {
        switch (type) {
            case 'interests': {
                if (me.standing !== 'member') return false;
                const set = opts.interests ?? me.interests;
                return !!opts.interestsOpen || set.length === 0;
            }
            case 'invite':
                return me.standing === 'member' && answer.features.invites !== false && me.firstOffer;
            case 'steps':
                return !!answer.cards.steps && stepsSaySomething(answer, opts.interests ?? me.interests, now);
            case 'tips':
                return !!opts.tipsUp;
            // A member's only. On a saved list it is drawn whenever it is there: Done or Skip takes it off
            // (endTourLayout), and a member who puts it back from Add a card gets it (the picker offers it to whoever
            // wants it, design §1). A Home never saved shows it until the tour ends (shownLayout).
            case 'start':
                return me.standing === 'member';
            case 'search':
                return true;
            // A chosen chat: always drawn, as "Pick a chat", its lines, waiting for the node, or gone with Remove; the
            // frame never drops one by itself (DESIGN-home-chosen-chat-fable.md §2).
            case 'chat':
                return true;
            // Real open Needs only: drawn while the node sent a row, never an empty box (cold-start N2).
            case 'asked':
                return Array.isArray(answer.cards.asked?.items) && answer.cards.asked!.items.length > 0;
            // Worked out in this browser; drawn only where a place is known (CARD-FRAME §4).
            case 'sky':
                return skyOf(answer, { settings }, now) !== null;
            // A Your tools card (home-tools-card) or a tool's card: worked out on this device (asks: 'none').
            case 'tools':
                return me.standing === 'member';
            default:
                return type.startsWith('tool-') ? !!answer.me : !!answer.cards[type as keyof HomeCards];
        }
    };
    const base = shownLayout(answer, layout, opts);
    const pins = pinnedCards(answer, now, opts);
    // Nothing folds behind Welcome on a Home never saved: the default list is there from the first second (DESIGN-home-default §2.2).
    const shown = cardOrder(base, pins).filter(c => cardOnNode(c.type, frameOf(answer)) && has(c));
    if (opts.interestsOpen && me.standing === 'member' && !shown.some(c => c.type === 'interests')) {
        const market = shown.findIndex(c => c.type === 'market');
        shown.splice(market >= 0 ? market + 1 : shown.length - 1, 0, { id: 'interests', type: 'interests' });
    }
    return shown;
}

// ── First steps ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A member is new for this long: First steps stays while they are, even with every line done (the node's own rule). */
export const STEPS_NEW_DAYS = 14;

export interface StepLine {
    key: 'firstOffer' | 'photo' | 'interests' | 'firstNeed' | 'invite' | 'firstPost' | 'ask' | 'name' | 'area' | 'sawLedger' | 'saidHello' | 'watch';
    done: boolean;
    text: string;
    /** A line the web app can never tick: it keeps no card on its own. */
    untracked?: true;
    /** A link to another community's own page. */
    href?: string;
}

/**
 * The lines First steps draws on the web (§3.1, §7; global L3 §3.2). Local: a first Offer, a photo, interests (the chips' taps count at
 * once), and an invite once there is an Offer. Global: the first-week card with the seven steps of §3.2.
 */
export function stepLines(answer: HomeAnswer, interests: readonly string[]): StepLine[] {
    const s = answer.cards.steps;
    if (!s) return [];
    if (answer.profile === 'global') {
        return [
            { key: 'name', done: true, text: t('Choose a name') },
            { key: 'area', done: !!s.area, text: t('Say roughly where you are') },
            { key: 'photo', done: !!s.photo, text: t('Add a picture (a preset counts)') },
            { key: 'sawLedger', done: !!s.sawLedger, text: t('Look at an example Ledger') },
            { key: 'firstPost', done: !!s.firstPost, text: t('Post something free or for swap') },
            { key: 'saidHello', done: !!s.saidHello, text: t('Say hello to someone near you') },
            { key: 'watch', done: !!s.watch, text: t("Tell me when a community starts here, or say you'd help start one") },
        ];
    }
    return [
        { key: 'firstOffer', done: s.firstOffer, text: t('Post your first Offer') },
        { key: 'photo', done: s.photo, text: t('Add a photo to your profile') },
        { key: 'interests', done: s.interests || interests.length > 0, text: t('Pick a few things you like') },
        // After the first Offer (a Need needs one where Beans are on): asking for one thing a neighbour could do (cold-start N2). A
        // node from before the fact (`firstNeed` absent) has no such line and keeps the card up for nothing else, so none is drawn for it.
        ...(s.firstOffer && typeof s.firstNeed === 'boolean'
            ? [{ key: 'firstNeed' as const, done: s.firstNeed, text: t("Ask for one thing you'd pay a neighbour for") }] : []),
        ...(s.invited !== null && (s.firstOffer || answer.me?.firstOffer) ? [{ key: 'invite' as const, done: s.invited, text: t('Invite someone') }] : []),
    ];
}

/**
 * Whether First steps has something to say here (§6.1 "a card with nothing to say disappears", §3.1 "member < 14 days
 * or any line undone", §3.2 & §6 "the card ends after 14 days or all done" on global): the member is new, a line the web can tick is undone, or the new-account limits apply.
 */
export function stepsSaySomething(answer: HomeAnswer, interests: readonly string[], now: number = Date.now()): boolean {
    const s = answer.cards.steps;
    if (!s) return false;
    const joined = Date.parse(s.joinedAt ?? answer.me?.joinedAt ?? '');
    const young = Number.isFinite(joined) && now - joined < STEPS_NEW_DAYS * DAY_MS;
    const lines = stepLines(answer, interests);
    if (answer.profile === 'global') {
        return young && lines.some(l => !l.done);
    }
    if (young) return true;
    if (lines.some(l => !l.done && !l.untracked)) return true;
    return probationSentence(answer.me?.probation) !== null;
}

/**
 * The unit after a Need's price, in the words the web Market card writes it with (MarketplaceCard `priceUnit`, so no new words):
 * per hour, day, week or month; none for a fixed price (a total) or a kind this build does not know.
 */
export function askedUnit(priceType: string | null | undefined): string {
    if (priceType === 'hourly') return t('/hr', undefined, 'price per hour');
    if (priceType === 'daily') return t('/day', undefined, 'price per day');
    if (priceType === 'weekly') return t('/wk', undefined, 'price per week');
    if (priceType === 'monthly') return t('/mo', undefined, 'price per month');
    return '';
}

/**
 * The second line of an "Asked near you" row ("20 Beans · 2h ago", "20 Beans /hr · 2h ago", "Free · 3d ago"): what the Need pays,
 * with its unit when it is priced by the hour, day, week or month (the Need it opens says the same), where Beans show, then how
 * long ago it was asked. A Need that asks nothing says Free, with no unit; a node that sent no figure, or one without Beans, says
 * no price. Never a price the node did not send. `priceWords`: the page's own wording of an amount of Beans.
 */
export function askedFacts(p: Pick<HomeNeedItem, 'price_c' | 'priceType' | 'createdAt'>, beansOn: boolean, priceWords: (price_c: number) => string): string {
    const price = beansOn && typeof p.price_c === 'number' && Number.isSafeInteger(p.price_c)
        ? (freePriceWords(p.price_c, 'need') ?? [priceWords(p.price_c), askedUnit(p.priceType)].filter(Boolean).join(' '))
        : null;
    return [price, formatRelativeTime(p.createdAt)].filter(Boolean).join(' · ');
}

// ── interests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Starred categories first, the rest after, each part in the order it came: interests reorder, never filter (§4.3). */
export function starredFirst<T>(items: readonly T[], categoryOf: (t: T) => string, interests: readonly string[]): T[] {
    if (!interests.length) return [...items];
    const starred = new Set(interests);
    const isStarred = (t: T) => starred.has(String(categoryOf(t) ?? '').trim().toLowerCase());
    return [...items.filter(isStarred), ...items.filter(t => !isStarred(t))];
}

/** Live pins first, the rest after, each part in the order it came: the node put the pins first, the stars must not move them. */
export function pinnedFirst<T extends { pinned?: boolean }>(items: readonly T[]): T[] {
    return [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)];
}

/** A chip tapped: on if it was off, off if it was on; the order they were chosen in kept. */
export function toggleInterest(interests: readonly string[], id: string): string[] {
    return interests.includes(id) ? interests.filter(i => i !== id) : [...interests, id];
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The cards' titles: word() keys, the same English as core's card names (home-frame.ts), shown through t() (cardTitle). */
export const CARD_TITLES: Record<HomeCardId, WordKey> = {
    needs: word('Needs you'),
    safety: word('Your way back in'),
    find: word('Find your community'),
    steps: word('First steps'),
    tips: word('Tips'),
    interests: word('What are you into?'),
    deals: word('Your deals'),
    enterprise: word('Your enterprise'),
    events: word('Coming up'),
    market: word('New in the Market'),
    decide: word('Decide'),
    groups: word('Your groups'),
    joined: word('Who joined'),
    pulse: word('The Pulse'),
    beans: word('Your Beans'),
    notices: word('From your community'),
    invite: word('Grow your community'),
    community: word('Your community'),
};

/**
 * A card's title on this node, in the member's language: the Market card is "Near you" where listings come nearest first
 * (global, §3.1); a visitor's are the lobby's words (§9 (c)): "Near you" for the communities, "What people post" for the
 * listings.
 */
export function cardTitle(id: HomeCardId, answer: Pick<HomeAnswer, 'profile'> & Partial<Pick<HomeAnswer, 'welcome' | 'me' | 'cards'>>): string {
    const visitor = !!answer.welcome || answer.me === null;
    // The one you keep is a project: "Your project" (group decisions §3.1). A node too old to say: "Your enterprise".
    if (id === 'enterprise' && answer.cards?.enterprise?.lifecycle === 'bounded') return t('Your project');
    if (visitor && id === 'find') return t('Near you');
    if (visitor && id === 'market') return t('What people post');
    // "Coming up" says how near only when the node measured from a point (the card adds "· within 50 km").
    if (id === 'market' && answer.profile === 'global') return t('Near you');
    if (id === 'steps' && answer.profile === 'global') return t('Your first week');
    return t(CARD_TITLES[id]);
}

/** A count as English has always grouped it ("2,310"), and with the language's digits elsewhere (core formatCount). */
const count = (n: number) => formatCount(n);
/** A distance in km: one decimal under 10 ("4.6"), whole above ("12,489"). */
const kmText = (km: number) => (km < 10 ? formatNumber(km, 1) : formatCount(Math.round(km)));

/**
 * A "Coming up" line's time (DESIGN-event-times §4): the place's clock, "FRI 16 OCT · 20:50", with its zone named only when
 * it is not the reader's own ("FRI 17 OCT · 20:50 · Lagos time"); an online event in the reader's own time, "FRI 16 OCT ·
 * 10:50 your time". A node that sends no clock gives the reader's own, as the cards do.
 */
export function homeEventWhere(item: Pick<HomeEventItem, 'place' | 'online' | 'shownCopy' | 'shownFrom'>, visitor: boolean): string | null {
    if (item.online) return t('Online');
    const copy = eventCopyOf(item);
    if (copy) return copy.from ? copyFromLine(copy.from) : null;
    return item.place ?? (visitor ? t(VISITOR_WORDS.placeAfterJoin) : null);
}

export function homeEventWhen(item: Pick<HomeEventItem, 'startsAt' | 'startLocal' | 'tz' | 'online'>): string {
    const start = new Date(item.startsAt);
    if (!Number.isFinite(start.getTime())) return '';
    const parts = eventWhenParts({
        startAt: item.startsAt, startLocal: item.startLocal ?? null, tz: item.tz ?? null, online: item.online === true,
        deviceStart: deviceLocalClock(start),
    });
    if (!parts) return dayLabel(item.startsAt);
    const line = `${parts.first}${parts.sep}${parts.second}`;
    const zone = parts.note ? parts.note.slice(0, parts.note.indexOf(' · ')) : '';
    return zone ? `${line} · ${zone}` : line;
}

/** A "Coming up" line's ↻ caption ("Every Friday"), '' for a one-off. */
export function homeEventRepeats(item: Pick<HomeEventItem, 'repeat' | 'repeatUntil'>): string {
    return repeatCaption(item.repeat ?? null, item.repeatUntil ?? null);
}

/** "Sat 3 Oct", in the member's own time and language (core's date tables). */
export function dayLabel(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return formatDate(d, 'weekday-day-month');
}

/**
 * When a vote closes, in the member's own time (the node words it in hours only, §5.2): "closes tonight" when it closes
 * later today after 6 pm, "closes today", "closes tomorrow", or "closes Fri" within a week; "closes 12 Oct" after.
 * English, as the node writes the Needs-you line this goes into (HomePage needsLine: the node's own words, put right
 * where it said "in 30 hours"); the Decide card's own line says it in the member's language (closesIn).
 */
export function closesWords(closesAt: string, now: number = Date.now()): string {
    const at = new Date(closesAt);
    if (!Number.isFinite(at.getTime())) return '';
    const today = new Date(now);
    const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((dayStart(at) - dayStart(today)) / DAY_MS);
    if (days <= 0) return at.getHours() >= 18 ? 'closes tonight' : 'closes today';
    if (days === 1) return 'closes tomorrow';
    if (days < 7) return `closes ${at.toLocaleDateString('en-GB', { weekday: 'short' })}`;
    return `closes ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** The Decide card's "closes …", in the member's language: the same days as closesWords, the day and date from core's tables. */
export function closesIn(closesAt: string, now: number): string {
    const at = new Date(closesAt);
    if (!Number.isFinite(at.getTime())) return '';
    const today = new Date(now);
    const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((dayStart(at) - dayStart(today)) / DAY_MS);
    if (days <= 0) return at.getHours() >= 18 ? t('closes tonight') : t('closes today');
    if (days === 1) return t('closes tomorrow');
    if (days < 7) return t('closes {day}', { day: formatDate(at, 'weekday') });
    return t('closes {date}', { date: formatDate(at, 'day-month') });
}

/**
 * A figure from whole hundredths, as every figure is written (core formatHundredths): "1,234.50", "−0.50", "12" in English;
 * every other language's digits alone, with its decimal separator.
 */
export function beansFigure(c: number): string {
    return formatHundredths(c);
}

/** "12 Beans", "1 Bean", "12.50 Beans", "1,234.50 Beans": the member's balance in words, from whole hundredths. */
export const beansAmount = (c: number) => tn(c / 100, '{n} Bean', '{n} Beans', { n: beansFigure(c) });

/** "12 Beans · room to spend 200 · Resident"; a new member's "0 Beans · nothing to repay". Their own balance only (§3.1). */
export function beansLines(b: NonNullable<HomeCards['beans']>): { line: string; note: string | null } {
    const n = b.balance_c;
    if (!b.activated && n === 0) {
        return { line: t('0 Beans · nothing to repay'), note: t('Your credit opens with a first trade.') };
    }
    const amount = beansAmount(n);
    const line = b.frozen ? t('{amount} · spending paused', { amount }) : t('{amount} · room to spend {room}', { amount, room: formatHundredths(b.room_c) });
    return { line, note: b.tier ? tierWords(b.tier) : null };
}

/** "2 open · waiting on you: Mend clothes". */
export function dealsLine(d: NonNullable<HomeCards['deals']>): string {
    const open = tn(d.open, '{n} open', '{n} open');
    if (d.waitingOnMe) return t('{open} · waiting on you: {title}', { open, title: d.waitingOnMe.title });
    if (d.waiting === 0) return open;
    // Two counts side by side, as the phone's dealsLine writes them.
    const waiting = tn(d.waiting, '{n} waiting on you', '{n} waiting on you');
    return `${open} · ${waiting}`;
}

/** "1 Decision closes Fri · 2 polls open". */
export function decideLine(d: NonNullable<HomeCards['decide']>, now: number = Date.now()): string {
    const parts: string[] = [];
    if (d.open > 0) {
        const closes = d.soonestClosesAt ? closesIn(d.soonestClosesAt, now) : '';
        parts.push(d.open === 1
            ? (closes ? t('1 Decision {closes}', { closes }) : t('1 Decision'))
            : closes
                ? tn(d.open, '{n} Decision open, the first {closes}', '{n} Decisions open, the first {closes}', { closes })
                : tn(d.open, '{n} Decision open', '{n} Decisions open'));
    }
    if (d.polls > 0) parts.push(d.pollsMore ? t('{n}+ polls open', { n: d.polls }) : tn(d.polls, '{n} poll open', '{n} polls open'));
    return parts.join(' · ');
}

/** Local: "Ana, Kofi and 3 more joined this week." Global: "14 people within 50 km joined this week." (no names, §13 Q4) */
export function joinedLine(j: NonNullable<HomeCards['joined']>): string {
    if (j.names && j.names.length) {
        const names = j.names.slice(0, 2).map(n => n.callsign);
        const rest = j.count7d - names.length;
        if (rest > 0) return tn(rest, '{names} and {n} more joined this week.', '{names} and {n} more joined this week.', { names: names.join(', ') });
        if (names.length === 2) return t('{names} and {last} joined this week.', { names: names[0], last: names[1] });
        return t('{name} joined this week.', { name: names[0] });
    }
    const n = count(j.count7d);
    return j.radiusKm
        ? tn(j.count7d, '{n} person within {km} km joined this week.', '{n} people within {km} km joined this week.', { n, km: j.radiusKm })
        : tn(j.count7d, '{n} person joined this week.', '{n} people joined this week.', { n });
}

/** "81 members · 23 trades this month"; global: "2,310 members · 38 communities listed". */
export function communityLine(c: NonNullable<HomeCards['community']>, profile: string): string {
    const parts = [tn(c.members, '{n} member', '{n} members', { n: count(c.members) })];
    if (profile === 'global' && typeof c.communities === 'number') parts.push(tn(c.communities, '{n} community listed', '{n} communities listed', { n: count(c.communities) }));
    if (typeof c.tradesThisMonth === 'number') parts.push(tn(c.tradesThisMonth, '{n} trade this month', '{n} trades this month', { n: count(c.tradesThisMonth) }));
    return parts.join(' · ');
}

/** The community card's name: the community's own, or the global node's "The global community". */
export function communityName(c: NonNullable<HomeCards['community']>, profile: string): string {
    if (profile === 'global') return t('The global community');
    return c.name || t(CARD_TITLES.community);
}

/** "12 km away · 40 members", whatever of that is known (as the phone's find card says it). */
export function communityFacts(c: Pick<HomeCommunity, 'distanceKm' | 'memberCount'>): string {
    const parts: string[] = [];
    if (c.distanceKm !== null && c.distanceKm !== undefined) {
        parts.push(c.distanceKm < 1 ? t('Less than 1 km away') : t('{distance} km away', { distance: kmText(c.distanceKm) }));
    }
    if (c.memberCount !== null && c.memberCount !== undefined) parts.push(tn(c.memberCount, '{n} member', '{n} members', { n: count(c.memberCount) }));
    return parts.join(' · ');
}

/**
 * "Not answering lately", in the member's language, under a listed community whose last push to the directory is more
 * than 36 h ago (core notAnsweringLately), or null: still listed, still worth a try. The phone's find screen says the
 * same (apps/native/utils/community-directory.ts notAnsweringLine).
 */
export function notAnsweringLine(c: Pick<HomeCommunity, 'lastSeenAt'>, now: number = Date.now()): string | null {
    return notAnsweringLately(c.lastSeenAt, now) ? t(FIND_COMMUNITY_WORDS.notAnswering) : null;
}

/**
 * "Keeps the listing promise · Accepting members · Closing on 3 Dec", in the member's language, whatever of that the
 * directory said under a listed community (core communityPromiseLines), or null. The phone's find screen says the same
 * (apps/native/utils/community-directory.ts promiseLine).
 */
export function promiseLine(c: Pick<HomeCommunity, 'promise' | 'acceptingKnocks' | 'closingOn'>, now: number = Date.now()): string | null {
    const lines = communityPromiseLines(c, now);
    return lines.length ? lines.join(' · ') : null;
}

/**
 * The find card's headline, from what the node said (the phone's findCommunityCardCopy, but for the web's card, which
 * lists the communities themselves right under it, each a link to its own page, so the sentence doesn't name one).
 * Which one is @beanpool/core's findCommunityState: "none" only once the directory has loaded, and "near" only within
 * 250 km. Beside `none` and `far` the card offers Start a community and "Tell me when one starts here" (findOffersStart;
 * the watch is #1955's), as the phone's FindCommunityBody does; never before the list has loaded, never while near.
 */
export function findBody(f: HomeFind): string {
    const state = findCommunityState(f);
    switch (state) {
        case 'near':
            return communitiesNear(f.communities).length === 1
                ? t('The community nearest you. Ask to join, and trade with your neighbours there.')
                : t('The communities nearest you, closest first. Ask one to let you in, and trade with your neighbours there.');
        case 'far':
            return FIND_COMMUNITY_WORDS.farLine(f.communities.length);
        case 'none':
            return t(FIND_COMMUNITY_WORDS.noneNear);
        case 'not_loaded':
            return t(FIND_COMMUNITY_WORDS.notLoaded);
        case 'no_point': {
            const n = knownCommunityCount(f.communityCount);
            if (n === null) return t('Share your area, or type your town, to see the nearest.');
            return tn(n, '{n} community is listed. Share your area, or type your town, to see the nearest.',
                '{n} communities are listed. Share your area, or type your town, to see the nearest.', { n: count(n) });
        }
    }
}

/**
 * The communities the find card lists under its sentence, the first 3: while near, only those within 250 km, so none
 * farther sits under "nearest you" (deciding review of #1935, finding 2); while far, the nearest listed, each with its
 * distance.
 */
export function findListed(f: HomeFind): HomeFind['communities'] {
    return (findCommunityState(f) === 'near' ? communitiesNear(f.communities) : f.communities).slice(0, 3);
}

/** Whether the find card offers Start a community: when nothing listed is near (and the list has loaded). */
export function findOffersStart(f: HomeFind): boolean {
    const state: FindCommunityState = findCommunityState(f);
    return state === 'none' || state === 'far';
}

/** "9 listings within 25 km" (the find card's count, §3.1). */
export function nearbyLine(f: HomeFind): string | null {
    if (!f.nearbyPosts) return null;
    const { count: listings, more, radiusKm } = f.nearbyPosts;
    const values = { n: count(listings), km: radiusKm };
    return more ? t('{n}+ listings within {km} km', values) : tn(listings, '{n} listing within {km} km', '{n} listings within {km} km', values);
}

/**
 * The new-account limits, said before the member meets them (§3.1, §7): "For your first 3 days: 3 posts and 10 new
 * chats a day." From the node's own numbers (`me.probation`); nothing when it sends none.
 */
export function probationSentence(p: HomeProbation | null | undefined): string | null {
    if (!p?.onProbation) return null;
    const hours = p.endsWhen?.hours;
    const posts = p.limits?.posts?.limit;
    const chats = p.limits?.new_dm_recipients?.limit;
    if (!hours || posts === undefined || chats === undefined) return null;
    // The phone's sentence (utils/home-cards.ts probationSentence), each count in its own form.
    return t('For your first {span}: {posts} and {chats} a day.', {
        span: hours % 24 === 0 ? tn(hours / 24, '{n} day', '{n} days') : tn(hours, '{n} hour', '{n} hours'),
        posts: tn(posts, '{n} post', '{n} posts'),
        chats: tn(chats, '{n} new chat', '{n} new chats'),
    });
}

/** A listing's distance on a card: whole km, "under 1 km" below one (the place is the area's centre for visitors). */
export function distanceText(km: number | null | undefined): string | null {
    if (km === null || km === undefined || !Number.isFinite(km)) return null;
    return km < 1 ? t('under 1 km') : t('{km} km', { km: count(Math.round(km)) });
}

/**
 * The node's body for this saved search, when it answers the search the card holds now: its words, kind and category,
 * and its distance where the node used one (with no point it answers km null whatever is kept). A kept answer from
 * before a change in Settings… is no answer for the new search (the card says it shows when the community answers),
 * and an odd body is none.
 */
export function searchCardFor(answer: HomeAnswer | null | undefined, inst: Pick<HomeCardInstance, 'id' | 'settings'>): HomeSearchCard | null {
    const raw = (answer?.cards as Record<string, unknown> | undefined)?.[inst.id] as Partial<HomeSearchCard> | undefined;
    if (!raw || typeof raw !== 'object' || typeof raw.q !== 'string' || !Array.isArray(raw.items)) return null;
    const s = readSearchSettings(inst.settings);
    const card: HomeSearchCard = { q: raw.q, kind: raw.kind ?? 'any', category: raw.category ?? null, km: typeof raw.km === 'number' ? raw.km : null, items: raw.items, more: raw.more === true };
    if (card.q !== s.q || card.kind !== s.kind || card.category !== (s.category ?? null)) return null;
    if (card.km !== null && card.km !== (s.km ?? null)) return null;
    return card;
}

// ── W4 content lines (DESIGN-home-wide-and-content-fable.md §2, slice W4) ─────────────────────────────────────────────

/** "Sourdough · with Ana" */
export function dealTitleLine(d: DealItem): string {
    const title = d.title || t('Deal');
    return d.with ? t('{title} · with {name}', { title, name: d.with }) : title;
}

/** "waiting on you · 2h ago" */
export function dealStatusLine(d: DealItem): string {
    const status = d.waitsOnMe ? t('waiting on you') : t('waiting on them');
    const when = d.at ? formatRelativeTime(d.at) : '';
    return when ? `${status} · ${when}` : status;
}

/** "This month: 5 trades · +120 in · −60 out" */
export function monthSummaryLine(m: MonthFigures): string {
    const trades = tn(m.trades, '{n} trade', '{n} trades');
    if (m.more) {
        return t('This month (partial): {trades} · +{in} in · −{out} out', { trades, in: beansFigure(m.in_c), out: beansFigure(m.out_c) });
    }
    return t('This month: {trades} · +{in} in · −{out} out', { trades, in: beansFigure(m.in_c), out: beansFigure(m.out_c) });
}

/** An enterprise's latest line: "Latest: +12 Beans from Ana · 2h ago" */
export function enterpriseLatestLine(l: EnterpriseLine): string {
    const sign = l.amount_c >= 0 ? '+' : '−';
    const amount = `${sign}${beansFigure(Math.abs(l.amount_c))}`;
    const n = Math.abs(l.amount_c) / 100;
    const when = l.at ? formatRelativeTime(l.at) : '';
    const isOut = l.amount_c < 0;
    if (l.kind === 'member' && l.who) {
        if (isOut) {
            return when
                ? tn(n, 'Latest: {amount} Bean to {who} · {when}', 'Latest: {amount} Beans to {who} · {when}', { amount, who: l.who, when })
                : tn(n, 'Latest: {amount} Bean to {who}', 'Latest: {amount} Beans to {who}', { amount, who: l.who });
        }
        return when
            ? tn(n, 'Latest: {amount} Bean from {who} · {when}', 'Latest: {amount} Beans from {who} · {when}', { amount, who: l.who, when })
            : tn(n, 'Latest: {amount} Bean from {who}', 'Latest: {amount} Beans from {who}', { amount, who: l.who });
    }
    if (l.kind === 'deal') {
        if (isOut) {
            return when
                ? tn(n, 'Latest: {amount} Bean held in trust · {when}', 'Latest: {amount} Beans held in trust · {when}', { amount, when })
                : tn(n, 'Latest: {amount} Bean held in trust', 'Latest: {amount} Beans held in trust', { amount });
        }
        return when
            ? tn(n, 'Latest: {amount} Bean released from trust · {when}', 'Latest: {amount} Beans released from trust · {when}', { amount, when })
            : tn(n, 'Latest: {amount} Bean released from trust', 'Latest: {amount} Beans released from trust', { amount });
    }
    if (l.kind === 'commons') {
        if (isOut) {
            return when
                ? tn(n, 'Latest: {amount} Bean to Commons · {when}', 'Latest: {amount} Beans to Commons · {when}', { amount, when })
                : tn(n, 'Latest: {amount} Bean to Commons', 'Latest: {amount} Beans to Commons', { amount });
        }
        return when
            ? tn(n, 'Latest: {amount} Bean from Commons · {when}', 'Latest: {amount} Beans from Commons · {when}', { amount, when })
            : tn(n, 'Latest: {amount} Bean from Commons', 'Latest: {amount} Beans from Commons', { amount });
    }
    return when
        ? tn(n, 'Latest: {amount} Bean · {when}', 'Latest: {amount} Beans · {when}', { amount, when })
        : tn(n, 'Latest: {amount} Bean', 'Latest: {amount} Beans', { amount });
}

/** A group's last line: "Ana, 2h ago: Who has a ladder?" */
export function groupLastLine(last: GroupLastLine): string {
    const when = last.at ? formatRelativeTime(last.at) : '';
    if (last.who) {
        return when
            ? t('{who}, {when}: {text}', { who: last.who, when, text: last.text })
            : t('{who}: {text}', { who: last.who, text: last.text });
    }
    return when ? `${when}: ${last.text}` : last.text;
}

/** "by River Folk · 3h ago" */
export function pulseByLine(p: { callsign: string; publishedAt?: string | null }): string {
    const when = p.publishedAt ? formatRelativeTime(p.publishedAt) : '';
    return when ? t('by {name} · {when}', { name: p.callsign, when }) : t('by {name}', { name: p.callsign });
}

// ── Sun and moon ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Arrange's line for a sun and moon card with no place to work from. A word() key: shown through t(). */
export const SKY_NO_PLACE_LINE = word('Nothing to show now: no place is known.');

/**
 * The sun and moon card's words (@beanpool/core sky.ts), worked out in this browser with no request: from the
 * community's place in the answer, else the member's area; `place: 'me'` puts the member's first. The browser's own
 * location is never read for it (the phone uses its last known place only where it already has one). Null: no place is
 * known, and the card isn't drawn. Times are this browser's own clock.
 */
export function skyOf(answer: Pick<HomeAnswer, 'me' | 'cards'>, inst: Pick<HomeCardInstance, 'settings'>, now: number = Date.now()): SkyToday | null {
    const place = skyPlaceFor(readSkySettings(inst.settings), { community: answer.cards.community?.place, member: answer.me?.area });
    return place ? skyToday(place, now) : null;
}

/**
 * Whether the "Use the phone app" card is due on Home (front doors S4):
 * shown after the first post or a week (when the one-way-back card already comes back),
 * until dismissed by the member.
 */
export function usePhoneAppCardDue({
    dismissed,
    keptPosts,
    weekOverAt,
    now = Date.now(),
}: {
    dismissed: boolean;
    keptPosts: number;
    weekOverAt: number | null;
    now?: number;
}): boolean {
    if (dismissed) return false;
    if (keptPosts >= 1) return true;
    if (weekOverAt !== null && now >= weekOverAt) return true;
    return false;
}

// ── A chosen chat (scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1–§3, slice C3) ─────────────────────────────

/** The chat card's own words (§2): word() keys, shown through t(). The same English as the phone's card. */
export const CHAT_CARD_WORDS = {
    /** No chat picked (settings that don't read). */
    pick: word('Pick a chat'),
    /** The chat has no line yet. */
    empty: word('Nothing said here yet.'),
    /** The node answered `gone`: the member isn't in it now, or it's a request they haven't accepted. */
    gone: word("You're no longer in this chat."),
    /** A photo's line. */
    photo: word('📷 Photo'),
    /** A sealed line that can't be shown here: too long to carry, or one that didn't open. */
    locked: word('🔒 Message'),
    /** A locked group's line while its key isn't in this browser's memory: the card never asks the node for one (§1). */
    lockedOpen: word('🔒 Message · open to read'),
    /** The settings list: its filter box, and what it says with no chat and after a read that failed. */
    find: word('Find a chat'),
    none: word('No chats yet.'),
    failed: word("Couldn't load your chats. Try again."),
    /** The card's name for the member's own lines. */
    you: word('You'),
} as const;

/** The longest a line's words are on the card once opened here (the node cuts what it sends; this cuts what opens). */
export const CHAT_LINE_CHARS = 200;

/**
 * The node's body for this chat card, when it is one: `gone` alone, or a chat of the kind the card holds now with its
 * lines. A kept answer from before Settings… picked a chat of another kind is no answer for it (drawn as waiting until the
 * node answers), and an odd body is none.
 */
export function chatCardFor(answer: Pick<HomeAnswer, 'cards'> | null | undefined, inst: Pick<HomeCardInstance, 'id' | 'settings'>): HomeChatCard | null {
    const raw = (answer?.cards as Record<string, unknown> | undefined)?.[inst.id] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.gone === 'left' || raw.gone === 'hidden' || raw.gone === 'request') return { gone: raw.gone };
    const s = readChatSettings(inst.settings);
    if (!homeChatPicked(s)) return null;
    if (!(HOME_CHAT_KINDS as readonly unknown[]).includes(raw.kind) || raw.kind !== s.kind || !Array.isArray(raw.lines)) return null;
    const lines = (raw.lines as unknown[]).filter((l): l is HomeChatLine => {
        const r = l as Partial<HomeChatLine> | null;
        return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.author === 'string' && typeof r.at === 'string' && typeof r.type === 'string';
    });
    return {
        kind: raw.kind as HomeChatKind, name: typeof raw.name === 'string' ? raw.name : null,
        unread: typeof raw.unread === 'number' && raw.unread > 0 ? Math.floor(raw.unread) : 0, muted: raw.muted === true, lines,
        ...(typeof raw.peer === 'string' ? { peer: raw.peer } : {}),
    };
}

/** One line of the chat card as it is drawn: who (null for the node's own line or a line that names nobody), when, the words. */
export interface ChatLineShown {
    id: string;
    who: string | null;
    mine: boolean;
    at: string;
    text: string;
}

/**
 * What opens a sealed line on this device, handed in by the page: the member's identity (a DM's key context, dm-lock
 * dmKeyContext, opened by core checkDmThread as Talk opens it), and a locked group's epoch key only when it is already open
 * in this page's memory (group-chat-keys `openedKey`: no read, no wrap opened here). Nothing opened is kept.
 */
export interface ChatOpeners {
    identity: { publicKey: string; privateKey: string } | null;
    /** The epoch key of a group's chat, if this page already opened it (Talk opened that chat in this page's life). */
    groupKey?: (groupId: string, epoch: number) => Uint8Array | undefined;
    /**
     * Whether this browser holds the group's chat locked: its kept record (group-hold `lockedGroupsOrNull`, this browser's
     * IndexedDB, as Talk reads it; unreadable counts as locked) or what this page has seen (`seenLockedInMemory`). Both are
     * local: the node is never asked. `undefined` while the kept record hasn't been read yet.
     */
    groupLocked?: (groupId: string) => boolean | undefined;
}

/** A line the card can't place yet (the kept lock record not read): nobody's, as a chat draws a line it hasn't opened. */
export const CHAT_LINE_PENDING = '…';

type ChatWithLines = Extract<HomeChatCard, { lines: HomeChatLine[] }>;
/** A line the node stores readable (it sends its metadata, null or not); a too-long sealed one comes as `🔒 Message` with none. */
const isReadable = (l: HomeChatLine): boolean => !l.sealed && l.metadata !== undefined;
const isNodeLine = (l: HomeChatLine): boolean => l.type === 'system' || l.author === 'SYSTEM';
const cut = (s: string): string => {
    const chars = Array.from(s);
    return chars.length > CHAT_LINE_CHARS ? `${chars.slice(0, CHAT_LINE_CHARS).join('').trimEnd()}…` : s;
};
const nobodys = (l: HomeChatLine, text: string): ChatLineShown => ({ id: l.id, who: null, mine: false, at: l.at, text });

/**
 * A direct chat's lines as Talk shows them (core checkDmThread, the one rule both apps judge a DM by): a sealed line opened
 * bound to its named sender and id under this member's key context; a readable line in a member's name never anyone's
 * words (unless it is the admin page's message); a deleted one as deleted. The other person is the node's `peer`, else
 * the one other author among the lines; with neither, no sealed line opens.
 */
function dmLinesShown(card: ChatWithLines, conversationId: string, me: ChatOpeners['identity']): ChatLineShown[] {
    const peer = (card as { peer?: unknown }).peer;
    const others = [...new Set(card.lines.filter(l => !isNodeLine(l) && l.author !== me?.publicKey).map(l => l.author))];
    const peerKey = typeof peer === 'string' && peer ? peer : others.length === 1 ? others[0] : null;
    const ctx = me && peerKey ? dmKeyContext({ id: conversationId, type: 'dm', participants: [me.publicKey, peerKey] }, me) : null;
    const thread: DmThreadLine[] = [];
    for (const l of card.lines) {
        if (isNodeLine(l)) continue;
        if (l.sealed) thread.push({ id: l.id, authorPubkey: l.author, ciphertext: l.sealed.ciphertext, nonce: l.sealed.nonce, type: l.type, metadata: l.sealed.metadata, timestamp: l.at });
        else if (isReadable(l)) thread.push({ id: l.id, authorPubkey: l.author, ciphertext: encodePlaintext(l.text ?? '').ciphertext, nonce: 'plaintext-v1', type: l.type, metadata: l.metadata ?? null, timestamp: l.at });
    }
    const views: Map<string, DmLineView> = checkDmThread(thread, ctx ? { myEdPrivHex: ctx.myEdPrivHex, peerEdPubHex: ctx.peerEdPubHex } : null, conversationId);
    return card.lines.map((l): ChatLineShown => {
        if (isNodeLine(l)) return nobodys(l, cut(chatLineWords(l.text ?? '')));
        const v = views.get(l.id);
        // Too long to carry: the node sent `🔒 Message` and no bytes.
        if (!v) return nobodys(l, t(CHAT_CARD_WORDS.locked));
        if (l.type === 'removed') return nobodys(l, chatLineWords(dmLineShownText(v)));
        if (v.mark === 'from-admins') return nobodys(l, cut(v.text ?? ''));
        // Not opened (no key context, or it doesn't open or its named sender didn't sign it): no words and nobody's; a readable
        // line in a member's name, Talk's words for it.
        if (v.text === null) return nobodys(l, v.mark === 'not-encrypted' ? chatLineWords(dmLineShownText(v)) : t(CHAT_CARD_WORDS.locked));
        const mine = !!me && l.author === me.publicKey;
        return { id: l.id, who: mine ? t(CHAT_CARD_WORDS.you) : l.who, mine, at: l.at, text: l.type === 'image' ? t(CHAT_CARD_WORDS.photo) : cut(v.text) };
    });
}

/**
 * A group's, an event's or an enterprise's chat lines: a readable line as its words (a photo as `📷 Photo`), a removed one
 * by who removed it (Talk's words), the node's own as its words. A locked group's sealed line opens only under an epoch
 * key already in this page's memory, by the display rule (group-line-display.ts: the key that opens it is its author,
 * "You" for mine, any other key "A former member"; an edit is tried as one); without one `🔒 Message · open to read`;
 * one that doesn't open, Talk's "couldn't be verified".
 */
function groupLinesShown(card: ChatWithLines, conversationId: string, open: ChatOpeners): ChatLineShown[] {
    const me = open.identity?.publicKey;
    const groupId = conversationId.toLowerCase();
    // A group's chat is locked here when this browser holds it so (its kept record, or what this page has seen), or when
    // any of its lines is sealed: there a readable line in a member's name is nobody's (Talk's groupLineShown), never their
    // words. Until the kept record is read such a line is "…", nobody's, as the phone's card draws a line it hasn't judged:
    // never the node's words in a member's name, and never a warning that goes a moment later. An event's or enterprise's
    // chat is readable.
    const held = card.kind === 'group' ? open.groupLocked?.(groupId) : false;
    const locked = card.kind === 'group' && (held === true || card.lines.some(l => !!l.sealed && isSealedGroupLine({ nonce: l.sealed.nonce, type: l.type })));
    const pending = card.kind === 'group' && !locked && !!open.groupLocked && held === undefined;
    const out: ChatLineShown[] = [];
    for (const l of card.lines) {
        if (l.type === 'removed') {
            out.push(nobodys(l, chatLineWords(groupTombstoneText({ authorPubkey: l.author, metadata: l.metadata ?? l.sealed?.metadata ?? null }))));
        } else if (isNodeLine(l)) {
            out.push(nobodys(l, cut(chatLineWords(l.text ?? ''))));
        } else if (l.sealed && isSealedGroupLine({ nonce: l.sealed.nonce, type: l.type })) {
            const sealed = l.sealed;
            const served = (editedAt: string | null) => ({
                id: l.id, authorPubkey: l.author, authorCallsign: l.who, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: sealed.metadata, editedAt, type: l.type,
            });
            // The node left out the lines from before this member's first epoch (fromEpochOf): none here is hidden for that.
            const ctx = { groupId, fromEpoch: 1, keyFor: (e: number) => open.groupKey?.(groupId, e), open: openLine, roster: [] };
            // The card carries no edit mark: a line that doesn't open as written is tried as an edit (sealed as part 'edit'),
            // as the phone's card does, so a held key never shows an edited line as "couldn't be verified".
            let v = groupLineView(served(null), ctx);
            if (v.unverified) v = groupLineView(served(l.at), ctx);
            if (v.hidden) continue;
            if (v.waitingKey) { out.push(nobodys(l, t(CHAT_CARD_WORDS.lockedOpen))); continue; }
            if (v.unverified || !v.signer) { out.push(nobodys(l, chatLineWords(GROUP_LINE_UNVERIFIED_TEXT))); continue; }
            const mine = !!me && v.signer === me;
            // Named by the key that opened it: mine; the node's name for the author when that key is the author's; any other
            // key (metadata.sender, a line from before a key change) by the display rule, which with no roster here is
            // "A former member", as Talk and the phone name it. Opened words are never drawn with no name.
            const who = mine ? t(CHAT_CARD_WORDS.you) : v.signer === l.author ? l.who : chatAuthorWords(v.name ?? GROUP_LINE_FORMER_MEMBER);
            out.push({ id: l.id, who, mine, at: l.at, text: l.type === 'image' ? t(CHAT_CARD_WORDS.photo) : cut(v.text) });
        } else if (!isReadable(l)) {
            // Sealed some other way, or too long to carry (`🔒 Message`, no bytes).
            out.push(nobodys(l, t(CHAT_CARD_WORDS.locked)));
        } else if (locked) {
            out.push(nobodys(l, chatLineWords(GROUP_LINE_UNVERIFIED_TEXT)));
        } else if (pending) {
            out.push(nobodys(l, CHAT_LINE_PENDING));
        } else {
            const mine = !!me && l.author === me;
            out.push({ id: l.id, who: mine ? t(CHAT_CARD_WORDS.you) : l.who, mine, at: l.at, text: l.type === 'image' ? t(CHAT_CARD_WORDS.photo) : cut(l.text ?? '') });
        }
    }
    return out;
}

/** The chat card's lines, oldest first, opened on this device (§1). Nothing opened is kept anywhere. */
export function chatLinesShown(card: HomeChatCard, conversationId: string, open: ChatOpeners): ChatLineShown[] {
    if (!('lines' in card)) return [];
    return card.kind === 'dm' ? dmLinesShown(card, conversationId, open.identity) : groupLinesShown(card, conversationId, open);
}

/** One line as the card writes it: "Ana, 2h ago: Who has a ladder?", "You, 1h ago: …", the node's own "2h ago: …". */
export function chatLineText(l: ChatLineShown): string {
    return groupLastLine({ who: l.who, at: l.at, text: l.text });
}
