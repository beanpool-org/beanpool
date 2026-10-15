/**
 * Home, the screen that isn't the Market (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H3): the rules of
 * the card list, with no React and no network, so the vitest cases prove them (home-cards.test.ts) and the phone's
 * Home (H2) can carry the same module and cases.
 *
 * The node answers the whole screen in one read, `GET /api/home` (apps/server/src/routes/home-answer.ts): a card with
 * nothing to say is not in the answer at all. What is left to the app is what only the member's own layout decides:
 *
 *   - **the order and which cards** are the member's version-2 list (lib/home-layout.ts, the card frame): `shownFrame`
 *     draws it, `needs` first and `community` last (it carries Add a card and Edit home);
 *   - **the two cards with no data of their own** (§3.1): `interests` while no interest is set (or opened from the
 *     Market card's Tune), and `invite` where invites are on, after the member's first Offer;
 *   - **interests reorder, they never filter** (§4.3): starred categories first, the rest after;
 *   - **unknown ids are dropped, never refused**, on both sides (§4.1: a node older or newer than the app).
 *
 * The layout is kept on the account (`home.layout`, H1, apps/server/src/engine/home-preferences.ts) with a copy in this
 * browser (lib/home-cache.ts); the last write wins by `updatedAt`.
 */

import { readSearchSettings, readSkySettings, skyPlaceFor, skyToday, type SkyToday } from '@beanpool/core';
import { readTourRecord, tourEnded } from '@beanpool/core';
import { FIND_COMMUNITY_WORDS, communitiesNear, findCommunityState, isNearKm, knownCommunityCount, type FindCommunityState } from '@beanpool/core';
import { deviceLocalClock, eventWhenParts, repeatCaption, type RepeatPattern } from '@beanpool/core';
import { STARTER_LAYOUT, cardOnNode, cardOrder, pinnedCards, type HomeCardInstance, type HomeLayoutV2 } from './home-layout';

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
    | { to: 'group'; id: string };
export interface NeedsItem { kind: 'admin' | 'deal' | 'vote' | 'message' | 'group'; count: number; accent: boolean; label: string; target: NeedsTarget; closesAt?: string }

/**
 * A version-1 layout, as the web app before the card frame kept it (on the account and in this browser): read only
 * through lib/home-layout.ts `readLayout` (core's translateV1) and `layoutV1Of`; this app never writes one.
 */
export interface HomeLayout {
    v: 1;
    order: HomeCardId[];
    hidden: HomeCardId[];
    dismissed: Partial<Record<HomeCardId, string>>;
    /** The node stamps every saved layout; null only on a copy that was never saved. */
    updatedAt: string | null;
}

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

export interface HomeCommunity { key: string; name: string | null; url: string | null; memberCount: number | null; distanceKm: number | null }
export interface HomeFind {
    point: 'request' | 'area' | null;
    communities: HomeCommunity[];
    /** Every community listed (the node always sends it; an odd value reads as unknown, never 0: knownCommunityCount). */
    communityCount: number | null;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    watches: unknown[] | null;
    knock: null;
    /** When the node last fetched the directory; null: never, so nothing may be said to be missing (@beanpool/core find-community.ts). */
    directoryFetchedAt: string | null;
}

export interface HomeMarketItem { id: string; type: 'offer' | 'need'; title: string; category: string; credits?: number; photoUrl: string | null; distanceKm?: number | null }
/** A saved search as the node builds it (apps/server routes/home-answer.ts `searchCard`), keyed by its instance id. */
export interface HomeSearchCard { q: string; kind: 'offer' | 'need' | 'any'; category: string | null; km: number | null; items: HomeMarketItem[]; more: boolean }
export interface HomeEventItem {
    id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null;
    /** The host's clock and its zone, and an online event (DESIGN-event-times §4); absent from a node before them. */
    startLocal?: string; tz?: string; online?: boolean;
    /** A repeating event's pattern and last date, for the ↻ caption (DESIGN-event-times §8); absent on a one-off. */
    repeat?: RepeatPattern; repeatUntil?: string;
}

export interface HomeCards {
    needs?: { items: NeedsItem[] };
    safety?: { words: true; signInLinked: false };
    find?: HomeFind;
    steps?: { joinedAt: string | null; firstOffer: boolean; firstPost: boolean; photo: boolean; interests: boolean; invited: boolean | null; area: boolean; knocked: null };
    deals?: { open: number; waiting: number; waitingOnMe: { txId: string; postId: string; title: string } | null };
    /** `lifecycle` 'bounded': the one kept is a project (§3.1); absent from an older node. */
    enterprise?: { id: string; name: string; requests: number; others: number; lifecycle?: 'ongoing' | 'bounded' };
    events?: { items: HomeEventItem[]; radiusKm: number | null };
    market?: { items: HomeMarketItem[]; total14d: number; more: boolean; examples?: true };
    decide?: { open: number; soonestClosesAt: string | null; polls: number; pollsMore: boolean };
    groups?: { items: { id: string; kind: 'group' | 'enterprise' | 'event'; name: string; unread: number; muted: boolean }[]; total: number };
    joined?: { count7d: number; radiusKm: number | null; names?: { callsign: string; avatarUrl: string | null }[] };
    pulse?: { items: { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null }[] };
    beans?: { balance: number; room: number; tier: string; activated: boolean; frozen: boolean };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    /** `place`: the community's own, to two decimals (a member's answer on a local community that has one). */
    community?: { name: string | null; members: number; tradesThisMonth?: number; communities?: number; place?: { lat: number; lng: number } };
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
            // Worked out in this browser; drawn only where a place is known (CARD-FRAME §4).
            case 'sky':
                return skyOf(answer, { settings }, now) !== null;
            default:
                return !!answer.cards[type as keyof HomeCards];
        }
    };
    const base = shownLayout(answer, layout, opts);
    const pins = pinnedCards(answer, now);
    let shown = cardOrder(base, pins).filter(c => cardOnNode(c.type, frameOf(answer)) && has(c));
    // A Home never saved folds its cards behind Getting started while it is up (§1): Skip or Done brings them.
    if (!base?.updatedAt && shown.some(c => c.type === 'start')) {
        shown = shown.filter(c => c.type === 'start' || c.type === 'needs' || c.type === 'community' || pins.includes(c.id));
    }
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
    key: 'firstOffer' | 'photo' | 'interests' | 'invite' | 'firstPost' | 'ask';
    done: boolean;
    text: string;
    /** A line the web app can never tick: it keeps no card on its own. */
    untracked?: true;
    /** A link to another community's own page. */
    href?: string;
}

/**
 * The lines First steps draws on the web (§3.1, §7). Local: a first Offer, a photo, interests (the chips' taps count at
 * once), and an invite once there is an Offer. Global: a first post, and "Ask X to let you in" where the nearest
 * community is within reach (@beanpool/core's NEAR_COMMUNITY_KM, 250 km: the radius the global node's listings use and
 * every "near you" on both apps, so a community 9,000 km away is never suggested, #1517). The web leaves out "Set your area" (it can't set the account's area), and can't tick the ask: a knock is kept on
 * the community knocked on, so it is a suggestion, never a step that holds the card.
 */
export function stepLines(answer: HomeAnswer, interests: readonly string[]): StepLine[] {
    const s = answer.cards.steps;
    if (!s) return [];
    if (answer.profile === 'global') {
        const nearest = answer.cards.find?.communities[0];
        const km = nearest?.distanceKm;
        const near = isNearKm(km) ? nearest : undefined;
        return [
            { key: 'firstPost', done: s.firstPost, text: 'Post something free or for swap' },
            ...(near?.url ? [{ key: 'ask' as const, done: false, text: `Ask ${near.name ?? 'a community'} to let you in`, untracked: true as const, href: near.url }] : []),
        ];
    }
    return [
        { key: 'firstOffer', done: s.firstOffer, text: 'Post your first Offer' },
        { key: 'photo', done: s.photo, text: 'Add a photo to your profile' },
        { key: 'interests', done: s.interests || interests.length > 0, text: 'Pick a few things you like' },
        ...(s.invited !== null && (s.firstOffer || answer.me?.firstOffer) ? [{ key: 'invite' as const, done: s.invited, text: 'Invite someone' }] : []),
    ];
}

/**
 * Whether First steps has something to say here (§6.1 "a card with nothing to say disappears", §3.1 "member < 14 days
 * or any line undone"): the member is new, a line the web can tick is undone, or the new-account limits apply. The node
 * keeps sending the card while the account's area is unset, which the web can't set, so the web decides by its own lines.
 */
export function stepsSaySomething(answer: HomeAnswer, interests: readonly string[], now: number = Date.now()): boolean {
    const s = answer.cards.steps;
    if (!s) return false;
    const joined = Date.parse(s.joinedAt ?? answer.me?.joinedAt ?? '');
    if (Number.isFinite(joined) && now - joined < STEPS_NEW_DAYS * DAY_MS) return true;
    if (stepLines(answer, interests).some(l => !l.done && !l.untracked)) return true;
    return probationSentence(answer.me?.probation) !== null;
}

// ── interests ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Starred categories first, the rest after, each part in the order it came: interests reorder, never filter (§4.3). */
export function starredFirst<T>(items: readonly T[], categoryOf: (t: T) => string, interests: readonly string[]): T[] {
    if (!interests.length) return [...items];
    const starred = new Set(interests);
    const isStarred = (t: T) => starred.has(String(categoryOf(t) ?? '').trim().toLowerCase());
    return [...items.filter(isStarred), ...items.filter(t => !isStarred(t))];
}

/** A chip tapped: on if it was off, off if it was on; the order they were chosen in kept. */
export function toggleInterest(interests: readonly string[], id: string): string[] {
    return interests.includes(id) ? interests.filter(i => i !== id) : [...interests, id];
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CARD_TITLES: Record<HomeCardId, string> = {
    needs: 'Needs you',
    safety: 'Your way back in',
    find: 'Find your community',
    steps: 'First steps',
    tips: 'Tips',
    interests: 'What are you into?',
    deals: 'Your deals',
    enterprise: 'Your enterprise',
    events: 'Coming up',
    market: 'New in the Market',
    decide: 'Decide',
    groups: 'Your groups',
    joined: 'Who joined',
    pulse: 'The Pulse',
    beans: 'Your Beans',
    notices: 'From your community',
    invite: 'Grow your community',
    community: 'Your community',
};

/**
 * A card's title on this node: the Market card is "Near you" where listings come nearest first (global, §3.1); a
 * visitor's are the lobby's words (§9 (c)): "Near you" for the communities, "What people post" for the listings.
 */
export function cardTitle(id: HomeCardId, answer: Pick<HomeAnswer, 'profile'> & Partial<Pick<HomeAnswer, 'welcome' | 'me' | 'cards'>>): string {
    const visitor = !!answer.welcome || answer.me === null;
    // The one you keep is a project: "Your project" (group decisions §3.1). A node too old to say: "Your enterprise".
    if (id === 'enterprise' && answer.cards?.enterprise?.lifecycle === 'bounded') return 'Your project';
    if (visitor && id === 'find') return 'Near you';
    if (visitor && id === 'market') return 'What people post';
    // "Coming up" says how near only when the node measured from a point (the card adds "· within 50 km").
    if (id === 'market' && answer.profile === 'global') return 'Near you';
    return CARD_TITLES[id];
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/**
 * A "Coming up" line's time (DESIGN-event-times §4): the place's clock, "FRI 16 OCT · 20:50", with its zone named only when
 * it is not the reader's own ("FRI 17 OCT · 20:50 · Lagos time"); an online event in the reader's own time, "FRI 16 OCT ·
 * 10:50 your time". A node that sends no clock gives the reader's own, as the cards do.
 */
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

/** "Sat 3 Oct", in the member's own time. */
export function dayLabel(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * When a vote closes, in the member's own time (the node words it in hours only, §5.2): "closes tonight" when it closes
 * later today after 6 pm, "closes today", "closes tomorrow", or "closes Fri" within a week; "closes 12 Oct" after.
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

/** "12 Beans · room to spend 200 · Resident"; a new member's "0 Beans · nothing to repay". Their own balance only (§3.1). */
export function beansLines(b: NonNullable<HomeCards['beans']>): { line: string; note: string | null } {
    const n = Math.round(b.balance * 100) / 100;
    if (!b.activated && n === 0) {
        return { line: '0 Beans · nothing to repay', note: 'Your credit opens with a first trade.' };
    }
    const balance = `${n.toLocaleString('en')} ${Math.abs(n) === 1 ? 'Bean' : 'Beans'}`;
    const room = b.frozen ? 'spending paused' : `room to spend ${Math.round(b.room).toLocaleString('en')}`;
    return { line: `${balance} · ${room}`, note: b.tier || null };
}

/** "2 open · waiting on you: Mend clothes". */
export function dealsLine(d: NonNullable<HomeCards['deals']>): string {
    const open = `${d.open} open`;
    if (d.waitingOnMe) return `${open} · waiting on you: ${d.waitingOnMe.title}`;
    return d.waiting > 0 ? `${open} · ${d.waiting} waiting on you` : open;
}

/** "1 Decision closes Fri · 2 polls open". */
export function decideLine(d: NonNullable<HomeCards['decide']>, now: number = Date.now()): string {
    const parts: string[] = [];
    if (d.open > 0) {
        const when = d.soonestClosesAt ? ` ${closesWords(d.soonestClosesAt, now)}` : '';
        parts.push(d.open === 1 ? `1 Decision${when}` : `${d.open} Decisions open, the first${when}`);
    }
    if (d.polls > 0) parts.push(`${d.polls}${d.pollsMore ? '+' : ''} ${d.polls === 1 && !d.pollsMore ? 'poll' : 'polls'} open`);
    return parts.join(' · ');
}

/** Local: "Ana, Kofi and 3 more joined this week." Global: "14 people within 50 km joined this week." (no names, §13 Q4) */
export function joinedLine(j: NonNullable<HomeCards['joined']>): string {
    if (j.names && j.names.length) {
        const names = j.names.slice(0, 2).map(n => n.callsign);
        const rest = j.count7d - names.length;
        const who = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.length === 2 ? `${names[0]} and ${names[1]}` : names[0];
        return `${who} joined this week.`;
    }
    const people = plural(j.count7d, 'person', 'people');
    const where = j.radiusKm ? ` within ${j.radiusKm} km` : '';
    return `${people}${where} joined this week.`;
}

/** "81 members · 23 trades this month"; global: "2,310 members · 38 communities listed". */
export function communityLine(c: NonNullable<HomeCards['community']>, profile: string): string {
    const parts = [plural(c.members, 'member', 'members')];
    if (profile === 'global' && typeof c.communities === 'number') parts.push(`${plural(c.communities, 'community', 'communities')} listed`);
    if (typeof c.tradesThisMonth === 'number') parts.push(`${plural(c.tradesThisMonth, 'trade', 'trades')} this month`);
    return parts.join(' · ');
}

/** The community card's name: the community's own, or the global node's "The worldwide community". */
export function communityName(c: NonNullable<HomeCards['community']>, profile: string): string {
    if (profile === 'global') return 'The worldwide community';
    return c.name || 'Your community';
}

/** "12 km away · 40 members", whatever of that is known (as the phone's find card says it). */
export function communityFacts(c: Pick<HomeCommunity, 'distanceKm' | 'memberCount'>): string {
    const parts: string[] = [];
    if (c.distanceKm !== null && c.distanceKm !== undefined) {
        parts.push(c.distanceKm < 1 ? 'Less than 1 km away' : `${c.distanceKm < 10 ? c.distanceKm.toFixed(1) : Math.round(c.distanceKm).toLocaleString('en')} km away`);
    }
    if (c.memberCount !== null && c.memberCount !== undefined) parts.push(plural(c.memberCount, 'member', 'members'));
    return parts.join(' · ');
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
                ? 'The community nearest you. Ask to join, and trade with your neighbours there.'
                : 'The communities nearest you, closest first. Ask one to let you in, and trade with your neighbours there.';
        case 'far':
            return `${FIND_COMMUNITY_WORDS.noneNear} ${FIND_COMMUNITY_WORDS.farLead(f.communities.length)}`;
        case 'none':
            return FIND_COMMUNITY_WORDS.noneNear;
        case 'not_loaded':
            return FIND_COMMUNITY_WORDS.notLoaded;
        case 'no_point': {
            const n = knownCommunityCount(f.communityCount);
            const see = 'Share your area, or type your town, to see the nearest.';
            return n === null ? see : `${n.toLocaleString('en')} communit${n === 1 ? 'y is' : 'ies are'} listed. ${see}`;
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
    const { count, more, radiusKm } = f.nearbyPosts;
    return `${count.toLocaleString('en')}${more ? '+' : ''} ${count === 1 && !more ? 'listing' : 'listings'} within ${radiusKm} km`;
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
    const span = hours % 24 === 0 ? plural(hours / 24, 'day', 'days') : plural(hours, 'hour', 'hours');
    return `For your first ${span}: ${plural(posts, 'post', 'posts')} and ${plural(chats, 'new chat', 'new chats')} a day.`;
}

/** A listing's distance on a card: whole km, "under 1 km" below one (the place is the area's centre for visitors). */
export function distanceText(km: number | null | undefined): string | null {
    if (km === null || km === undefined || !Number.isFinite(km)) return null;
    return km < 1 ? 'under 1 km' : `${Math.round(km).toLocaleString('en')} km`;
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

// ── Sun and moon ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Edit home's line for a sun and moon card with no place to work from. */
export const SKY_NO_PLACE_LINE = 'Nothing to show now: no place is known.';

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
