/**
 * Home, the screen that isn't the Market (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H3): the rules of
 * the card list, with no React and no network, so the vitest cases prove them (home-cards.test.ts) and the phone's
 * Home (H2) can carry the same module and cases.
 *
 * The node answers the whole screen in one read, `GET /api/home` (apps/server/src/routes/home-answer.ts): a card with
 * nothing to say is not in the answer at all. What is left to the app is what only the member's own layout decides:
 *
 *   - **the order** (§3.1 "Default order", §4.2): the member's own order first, every card they didn't name after it
 *     in the default order, and `community` always last (it carries Edit home);
 *   - **hiding** (§4.1): any card but `needs`, `safety` (it has its own schedule, components/OneWayBack.tsx),
 *     `community`, and `find` in a member's first 30 days on the global node;
 *   - **the two cards with no data of their own** (§3.1): `interests` while no interest is set (or opened from the
 *     Market card's Tune), and `invite` where invites are on, after the member's first Offer;
 *   - **interests reorder, they never filter** (§4.3): starred categories first, the rest after;
 *   - **unknown ids are dropped, never refused**, on both sides (§4.1: a node older or newer than the app).
 *
 * The layout is kept on the account (`home.layout`, H1, apps/server/src/engine/home-preferences.ts) with a copy in this
 * browser (lib/home-cache.ts); the last write wins by `updatedAt`.
 */

/** The catalogue (§3.1), in the default order. The same 17 ids as the node's. */
export const HOME_CARD_IDS = [
    'needs', 'safety', 'find', 'steps', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined',
    'pulse', 'beans', 'notices', 'invite', 'community',
] as const;
export type HomeCardId = typeof HOME_CARD_IDS[number];
const CARD_IDS: ReadonlySet<string> = new Set(HOME_CARD_IDS);
export const isHomeCardId = (id: unknown): id is HomeCardId => typeof id === 'string' && CARD_IDS.has(id);

/** The cards a visitor's Home is made of (§5.3), besides the Join card. */
export const VISITOR_CARDS: readonly HomeCardId[] = ['find', 'market', 'events', 'community'];

/** Cards with no "…": `needs` (missing it costs something), `safety` (its own ✕ and schedule), `community` (Edit home). */
const FIXED: ReadonlySet<HomeCardId> = new Set(['needs', 'safety', 'community']);
/** `find` is pinned for a member's first 30 days on the global node, then it can be hidden (§4.1, §7). */
export const FIND_PINNED_DAYS = 30;
const DAY_MS = 86_400_000;
/** The node refuses a layout list longer than this (H1); the catalogue is 17, so this is only a guard. */
const MAX_LAYOUT_IDS = 32;

/** Cards the node computes data for: the rest (`interests`, `invite`) are drawn from `me` and `features`. */
const DATA_CARDS: ReadonlySet<HomeCardId> = new Set(HOME_CARD_IDS.filter(id => id !== 'interests' && id !== 'invite'));

// ── the answer, as GET /api/home sends it ─────────────────────────────────────────────────────────────────────────────

export type NeedsTarget =
    | { to: 'admin'; section: string }
    | { to: 'deal'; postId: string; txId: string }
    | { to: 'my-deals' }
    | { to: 'decide' }
    | { to: 'chat'; conversationId: string; event?: boolean; thread?: 'group' | 'enterprise' }
    | { to: 'unread-messages' }
    | { to: 'your-groups' };
export interface NeedsItem { kind: 'admin' | 'deal' | 'vote' | 'message' | 'group'; count: number; accent: boolean; label: string; target: NeedsTarget; closesAt?: string }

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
    area: { lat: number; lng: number } | null;
    firstOffer: boolean;
    standing: 'member' | 'suspended';
}

export interface HomeCommunity { key: string; name: string | null; url: string | null; memberCount: number | null; distanceKm: number | null }
export interface HomeFind {
    point: 'request' | 'area' | null;
    communities: HomeCommunity[];
    communityCount: number;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    watches: unknown[] | null;
    knock: null;
    directoryFetchedAt: string | null;
}

export interface HomeMarketItem { id: string; type: 'offer' | 'need'; title: string; category: string; credits?: number; photoUrl: string | null; distanceKm?: number | null }
export interface HomeEventItem { id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null }

export interface HomeCards {
    needs?: { items: NeedsItem[] };
    safety?: { words: true; signInLinked: false };
    find?: HomeFind;
    steps?: { joinedAt: string | null; firstOffer: boolean; firstPost: boolean; photo: boolean; interests: boolean; invited: boolean | null; area: boolean; knocked: null };
    deals?: { open: number; waiting: number; waitingOnMe: { txId: string; postId: string; title: string } | null };
    enterprise?: { id: string; name: string; requests: number; others: number };
    events?: { items: HomeEventItem[]; radiusKm: number | null };
    market?: { items: HomeMarketItem[]; total14d: number; more: boolean; examples?: true };
    decide?: { open: number; soonestClosesAt: string | null; polls: number; pollsMore: boolean };
    groups?: { items: { id: string; kind: 'group' | 'enterprise' | 'event'; name: string; unread: number; muted: boolean }[]; total: number };
    joined?: { count7d: number; radiusKm: number | null; names?: { callsign: string; avatarUrl: string | null }[] };
    pulse?: { items: { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null }[] };
    beans?: { balance: number; room: number; tier: string; activated: boolean; frozen: boolean };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    community?: { name: string | null; members: number; tradesThisMonth?: number; communities?: number };
}

export interface HomeFeatures {
    beans?: boolean; escrow?: boolean; enterprises?: boolean; openJoin?: boolean; knocks?: boolean; guestListingsOnly?: boolean;
    exampleListings?: boolean; decisions?: boolean; invites?: boolean; wordsDoor?: boolean; probation?: boolean;
    [k: string]: unknown;
}

export interface HomeAnswer {
    generatedAt: string;
    profile: 'local' | 'global' | string;
    features: HomeFeatures;
    welcome?: true;
    me: HomeMe | null;
    layout: HomeLayout | null;
    cards: HomeCards;
}

// ── the layout ────────────────────────────────────────────────────────────────────────────────────────────────────────

function knownIds(list: unknown): HomeCardId[] {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(isHomeCardId))].slice(0, MAX_LAYOUT_IDS);
}

const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/**
 * A layout from anywhere (the node's answer, this browser's copy, a phone's save), made one this app can use: unknown
 * and repeated ids dropped, `needs` and `community` never hidden, a date that isn't one taken as none. Null for anything
 * that isn't a version-1 layout.
 */
export function normalizeLayout(raw: unknown): HomeLayout | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.v !== undefined && r.v !== 1) return null;
    const dismissed: Partial<Record<HomeCardId, string>> = {};
    if (r.dismissed && typeof r.dismissed === 'object' && !Array.isArray(r.dismissed)) {
        for (const [id, at] of Object.entries(r.dismissed as Record<string, unknown>)) {
            if (isHomeCardId(id) && id !== 'needs' && id !== 'community' && isIso(at)) dismissed[id] = at;
        }
    }
    return {
        v: 1,
        order: knownIds(r.order),
        hidden: knownIds(r.hidden).filter(id => id !== 'needs' && id !== 'community'),
        dismissed,
        updatedAt: isIso(r.updatedAt) ? r.updatedAt : null,
    };
}

/** The layout that wins: the later `updatedAt` (§4.2 "last write wins"); a dated one over an undated one; ties to `a`. */
export function newerLayout(a: HomeLayout | null, b: HomeLayout | null): HomeLayout | null {
    if (!a) return b;
    if (!b) return a;
    const at = a.updatedAt ? Date.parse(a.updatedAt) : -Infinity;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : -Infinity;
    return bt > at ? b : a;
}

/** Every card in the member's order: theirs first, the rest in the default order, `community` last whatever was stored. */
export function effectiveOrder(layout: HomeLayout | null): HomeCardId[] {
    const order = [...new Set([...(layout?.order ?? []), ...HOME_CARD_IDS])].filter(id => id !== 'community');
    return [...order, 'community'];
}

/** Whether `find` is pinned for this member: on the global node, in their first 30 days (or when their join date is unknown). */
export function findPinned(answer: Pick<HomeAnswer, 'profile' | 'me'>, now: number = Date.now()): boolean {
    if (answer.profile !== 'global') return false;
    const joined = answer.me?.joinedAt ? Date.parse(answer.me.joinedAt) : NaN;
    return !Number.isFinite(joined) || now - joined < FIND_PINNED_DAYS * DAY_MS;
}

/** Whether a member can hide or move this card (has a "…"). */
export function canTailor(id: HomeCardId, answer: Pick<HomeAnswer, 'profile' | 'me'>, now: number = Date.now()): boolean {
    if (FIXED.has(id)) return false;
    if (id === 'find' && findPinned(answer, now)) return false;
    return true;
}

/** The ids hidden by this layout that the member may hide now (a pinned `find` shows whatever the layout says). */
export function hiddenNow(layout: HomeLayout | null, answer: Pick<HomeAnswer, 'profile' | 'me'>, now: number = Date.now()): Set<HomeCardId> {
    return new Set((layout?.hidden ?? []).filter(id => canTailor(id, answer, now)));
}

/**
 * `cards=` for the request: the data cards this layout doesn't hide, or undefined with no layout copy in hand, so the
 * node applies the account's own (a first landing in a new browser still skips a hidden card's work). A `cards=` list is
 * taken as it is (the node re-adds nothing), so a pinned `find` is always asked for, and so is a hidden one while the
 * app has no answer yet to tell whether it is pinned (on a local node it costs nothing: the node has no such card).
 */
export function askedCards(layout: HomeLayout | null, answer: Pick<HomeAnswer, 'profile' | 'me'> | null, now: number = Date.now()): HomeCardId[] | undefined {
    if (!layout) return undefined;
    const hidden = hiddenNow(layout, answer ?? { profile: 'global', me: null }, now);
    return HOME_CARD_IDS.filter(id => DATA_CARDS.has(id) && !hidden.has(id));
}

/** Where a layout keeps nothing yet: the default, stamped `now` once changed. */
export function emptyLayout(): HomeLayout {
    return { v: 1, order: [], hidden: [], dismissed: {}, updatedAt: null };
}

const stamp = (layout: HomeLayout, now: number): HomeLayout => ({ ...layout, updatedAt: new Date(now).toISOString() });

export function hideCard(layout: HomeLayout | null, id: HomeCardId, now: number = Date.now()): HomeLayout {
    const l = layout ?? emptyLayout();
    if (id === 'needs' || id === 'community') return l;
    return stamp({ ...l, hidden: l.hidden.includes(id) ? l.hidden : [...l.hidden, id] }, now);
}

export function showCard(layout: HomeLayout | null, id: HomeCardId, now: number = Date.now()): HomeLayout {
    const l = layout ?? emptyLayout();
    return stamp({ ...l, hidden: l.hidden.filter(h => h !== id) }, now);
}

/** Reset to defaults (§4.1): the default order, nothing hidden; a dismissal stays (it is a schedule, not a choice of cards). */
export function resetLayout(layout: HomeLayout | null, now: number = Date.now()): HomeLayout {
    return stamp({ v: 1, order: [], hidden: [], dismissed: layout?.dismissed ?? {}, updatedAt: null }, now);
}

/**
 * Move a card one place up or down among `among` (the cards that can be moved, in the order shown): it swaps with its
 * neighbour there, so it never crosses `needs`, `safety`, a pinned `find` or `community`. The whole order is written,
 * so the move means the same on every app that reads it.
 */
export function moveCard(layout: HomeLayout | null, id: HomeCardId, direction: 'up' | 'down', among: HomeCardId[], now: number = Date.now()): HomeLayout {
    const l = layout ?? emptyLayout();
    const i = among.indexOf(id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= among.length) return l;
    const other = among[j];
    const order = effectiveOrder(l);
    const a = order.indexOf(id);
    const b = order.indexOf(other);
    [order[a], order[b]] = [order[b], order[a]];
    return stamp({ ...l, order: order.filter(x => x !== 'community') }, now);
}

// ── what is shown ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShownOptions {
    now?: number;
    /** The interests card was opened from the Market card's Tune: shown even with interests set. */
    interestsOpen?: boolean;
    /** The interests the page holds now (a tap saves in the background; the card follows the tap, not the answer). */
    interests?: string[];
}

/**
 * The cards to draw, top to bottom (§3.1 "shown when", §3.2): the ones the answer holds, plus `interests` and `invite`
 * from `me` and `features`, in the member's order, without the ones they hid. A visitor (`welcome`) gets only the
 * visitors' cards. A card the answer leaves out takes no space.
 */
export function shownCards(answer: HomeAnswer, layout: HomeLayout | null, opts: ShownOptions = {}): HomeCardId[] {
    const now = opts.now ?? Date.now();
    const hidden = hiddenNow(layout, answer, now);
    const has = (id: HomeCardId): boolean => {
        if (answer.welcome || !answer.me) return VISITOR_CARDS.includes(id) && !!answer.cards[id as keyof HomeCards];
        switch (id) {
            case 'interests': {
                // A suspended member can't post, so nothing to tune; anyone else while none is set, or on Tune.
                if (answer.me.standing !== 'member') return false;
                const set = opts.interests ?? answer.me.interests;
                return !!opts.interestsOpen || set.length === 0;
            }
            case 'invite':
                // §3.1 "after the first Offer", where invites are on (a node that says nothing takes them).
                return answer.me.standing === 'member' && answer.features.invites !== false && answer.me.firstOffer;
            default:
                return !!answer.cards[id as keyof HomeCards];
        }
    };
    return effectiveOrder(layout).filter(id => has(id) && (!hidden.has(id) || (id === 'interests' && !!opts.interestsOpen)));
}

/** The cards Edit home lists (§4.1): those that can be tailored and could appear on this node, shown and hidden apart. */
export function editableCards(answer: HomeAnswer, layout: HomeLayout | null, now: number = Date.now()): { shown: HomeCardId[]; hidden: HomeCardId[] } {
    const f = answer.features;
    const global = answer.profile === 'global';
    const possible = (id: HomeCardId): boolean => {
        switch (id) {
            case 'find': return global;
            case 'deals': return f.escrow !== false;
            case 'enterprise': return f.enterprises === true;
            case 'beans': return f.beans !== false;
            case 'invite': return f.invites !== false;
            case 'decide': return true;
            default: return true;
        }
    };
    const hidden = hiddenNow(layout, answer, now);
    const ids = effectiveOrder(layout).filter(id => canTailor(id, answer, now) && possible(id));
    return { shown: ids.filter(id => !hidden.has(id)), hidden: ids.filter(id => hidden.has(id)) };
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
export function cardTitle(id: HomeCardId, answer: Pick<HomeAnswer, 'profile'> & Partial<Pick<HomeAnswer, 'welcome' | 'me'>>): string {
    const visitor = !!answer.welcome || answer.me === null;
    if (visitor && id === 'find') return 'Near you';
    if (visitor && id === 'market') return 'What people post';
    if (id === 'market' && answer.profile === 'global') return 'Near you';
    if (id === 'events' && answer.profile === 'global') return 'Coming up near you';
    return CARD_TITLES[id];
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

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

/** The find card's headline, from what the node said (the phone's findCommunityCardCopy, the same words). */
export function findBody(f: HomeFind): string {
    if (f.communities.length > 0) {
        const nearest = f.communities[0];
        const where = communityFacts({ distanceKm: nearest.distanceKm, memberCount: null }).toLowerCase() || 'near you';
        const more = f.communities.length > 1 ? `, and ${f.communities.length - 1} more nearby` : '';
        return `${nearest.name ?? 'A community'} is ${where}${more}. Ask to join, and trade with your neighbours there.`;
    }
    if (f.point === null) {
        const n = f.communityCount;
        return `${n.toLocaleString('en')} communit${n === 1 ? 'y is' : 'ies are'} listed. Share your area to see the nearest.`;
    }
    return 'No community is listed near you yet. Start one, or ask to be told when one starts here.';
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
