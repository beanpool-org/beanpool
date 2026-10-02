/**
 * Home, the screen the app opens on (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H2): the rules, kept pure
 * so they are tested once (utils/__tests__/home-cards.test.ts) and ported to the web app as they are (H3). The screen
 * (app/(tabs)/index.tsx) only loads the answer and draws what this file says.
 *
 * - **The catalogue** is the design's 17 cards (§3.1), in one default order for everyone. A card with nothing to say takes
 *   no space: the node leaves it out of its answer (GET /api/home, apps/server routes/home-answer.ts), and the few rules
 *   that need the phone (a layout's hidden cards, the interests card, the invite card) are here.
 * - **The layout** (§4) is kept on the account (`home.layout`, H1) with a copy on the phone; the newer wins by `updatedAt`.
 *   A member hides, moves and resets cards; nothing is dragged and nothing is typed. `needs` stays at the top and
 *   `community` at the bottom (it carries Edit home): neither can be hidden or moved. Unknown ids are dropped, never
 *   refused, so a node older or newer than the app keeps the rest.
 * - **Interests reorder, they never filter** (§4.3): starred categories first, the rest after, each part in its order.
 * - **Needs you** is the header's own list (utils/needs-you.ts): the phone's own deals and unread messages from its
 *   database (fresher, no request), the node's admin work, votes and group lines from the answer.
 *
 * Slice H2 draws every card but `find`: the global node's Find your community card moves from the Market into Home in
 * H4, with the global First steps words and the 30-day pin (§12). The Market keeps drawing it until then.
 */

import {
    NEEDS_YOU_PRIORITY, buildNeedsYou, closesInWords,
    type NeedsYouConversation, type NeedsYouEntry, type NeedsYouKind, type NeedsYouTarget, type NeedsYouTransaction,
} from './needs-you';

// ── The catalogue ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Every card, in the default order (§3.1 "Default order"). The node's own list is the same (home-preferences.ts). */
export const HOME_CARD_IDS = [
    'needs', 'safety', 'find', 'steps', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups', 'joined',
    'pulse', 'beans', 'notices', 'invite', 'community',
] as const;
export type HomeCardId = typeof HOME_CARD_IDS[number];
const CARD_SET: ReadonlySet<string> = new Set(HOME_CARD_IDS);
export const isHomeCardId = (id: unknown): id is HomeCardId => typeof id === 'string' && CARD_SET.has(id);

/** First and last, always: the one card that costs a member something if missed, and the one that holds Edit home. */
export const FIXED_FIRST: HomeCardId = 'needs';
export const FIXED_LAST: HomeCardId = 'community';
const FIXED: ReadonlySet<HomeCardId> = new Set([FIXED_FIRST, FIXED_LAST]);

/** The cards this build draws (H2): all but `find`, which comes to Home in H4. */
export const HOME_DRAWN: readonly HomeCardId[] = HOME_CARD_IDS.filter(id => id !== 'find');
/** Cards with no data of their own in the answer: drawn from `me` and `features` (routes/home-answer.ts header). */
const NO_DATA: ReadonlySet<HomeCardId> = new Set(['interests', 'invite']);

/** A layout names at most this many ids in each list (the node refuses more, home-preferences.ts MAX_LAYOUT_IDS). */
export const LAYOUT_MAX_IDS = 32;

/** Each card's name: its caption, its line in Edit home, and the screen reader's words for its menu. */
export const HOME_CARD_NAMES: Record<HomeCardId, string> = {
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

// ── The answer, as GET /api/home sends it (apps/server routes/home-answer.ts HomeAnswer) ────────────────────────────

export interface HomeNeedsItem extends NeedsYouEntry { closesAt?: string }

export interface HomeMarketItem { id: string; type: 'offer' | 'need'; title: string; category: string; credits?: number; photoUrl: string | null; distanceKm?: number | null }
export interface HomeEventItem { id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null }
export interface HomePulseItem { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null }

export interface HomeCards {
    needs?: { items: HomeNeedsItem[] };
    safety?: { words: true; signInLinked: false };
    find?: unknown;
    steps?: { joinedAt: string | null; firstOffer: boolean; firstPost: boolean; photo: boolean; interests: boolean; invited: boolean | null; area: boolean; knocked: null };
    deals?: { open: number; waiting: number; waitingOnMe: { txId: string; postId: string; title: string } | null };
    enterprise?: { id: string; name: string; requests: number; others: number };
    events?: { items: HomeEventItem[]; radiusKm: number | null };
    market?: { items: HomeMarketItem[]; total14d: number; more: boolean; examples?: true };
    decide?: { open: number; soonestClosesAt: string | null; polls: number; pollsMore: boolean };
    groups?: { items: { id: string; kind: 'group' | 'enterprise' | 'event'; name: string; unread: number; muted: boolean }[]; total: number };
    joined?: { count7d: number; radiusKm: number | null; names?: { callsign: string; avatarUrl: string | null }[] };
    pulse?: { items: HomePulseItem[] };
    beans?: { balance: number; room: number; tier: string; activated: boolean; frozen: boolean };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    community?: { name: string | null; members: number; tradesThisMonth?: number; communities?: number };
}

export interface HomeMe {
    joinedAt: string | null;
    isKeeper: boolean;
    probation: unknown;
    interests: string[];
    area: { lat: number; lng: number } | null;
    firstOffer: boolean;
    standing: 'member' | 'suspended';
}

export interface HomeLayout {
    v: 1;
    order: HomeCardId[];
    hidden: HomeCardId[];
    dismissed: Partial<Record<HomeCardId, string>>;
    /** null: a layout with no date (the oldest there is). */
    updatedAt: string | null;
}

export interface HomeAnswer {
    generatedAt: string;
    profile: string;
    features: { beans?: boolean; escrow?: boolean; enterprises?: boolean; invites?: boolean; exampleListings?: boolean; decisions?: boolean; [k: string]: unknown };
    welcome?: true;
    me: HomeMe | null;
    layout: HomeLayout | null;
    cards: HomeCards;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

/** Known ids, each once, at most {@link LAYOUT_MAX_IDS}. */
function cardIds(raw: unknown): HomeCardId[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(isHomeCardId))].slice(0, LAYOUT_MAX_IDS);
}

/**
 * A layout as the node or the phone's copy holds it, read tolerantly: unknown ids and repeats dropped, `needs` and
 * `community` never hidden or dismissed, a bad date read as none. Null for anything that isn't a version-1 layout.
 */
export function readHomeLayout(raw: unknown): HomeLayout | null {
    if (!isObj(raw) || (raw.v !== undefined && raw.v !== 1)) return null;
    const dismissed: Partial<Record<HomeCardId, string>> = {};
    if (isObj(raw.dismissed)) {
        for (const [id, at] of Object.entries(raw.dismissed)) {
            if (isHomeCardId(id) && !FIXED.has(id) && isIso(at)) dismissed[id] = at;
        }
    }
    return {
        v: 1,
        order: cardIds(raw.order),
        hidden: cardIds(raw.hidden).filter(id => !FIXED.has(id)),
        dismissed,
        updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : null,
    };
}

/** An answer read tolerantly: anything that isn't one is null, and the screen keeps what it had. */
export function readHomeAnswer(raw: unknown): HomeAnswer | null {
    if (!isObj(raw) || !isObj(raw.cards) || typeof raw.profile !== 'string') return null;
    const me = isObj(raw.me) ? raw.me as unknown as HomeMe : null;
    return {
        generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
        profile: raw.profile,
        features: isObj(raw.features) ? raw.features as HomeAnswer['features'] : {},
        ...(raw.welcome === true ? { welcome: true as const } : {}),
        me: me ? { ...me, interests: Array.isArray(me.interests) ? me.interests.filter((c): c is string => typeof c === 'string') : [] } : null,
        layout: readHomeLayout(raw.layout),
        cards: raw.cards as HomeCards,
    };
}

// ── The layout: which copy wins, and the member's edits ───────────────────────────────────────────────────────────

const stamp = (l: HomeLayout | null) => (l?.updatedAt ? Date.parse(l.updatedAt) : -Infinity);

/**
 * The account's copy or the phone's, the newer by `updatedAt` (§4.2; the node keeps the newer too, home-preferences.ts).
 * `push`: the phone's copy is newer than the account's, so it is sent (an edit made offline, or one whose save failed).
 */
export function pickLayout(account: HomeLayout | null, phone: HomeLayout | null): { layout: HomeLayout | null; push: boolean } {
    if (!phone) return { layout: account, push: false };
    if (!account) return { layout: phone, push: true };
    return stamp(phone) > stamp(account) ? { layout: phone, push: true } : { layout: account, push: false };
}

/** The member's order: `needs` first, the cards they placed, the rest in the default order, `community` last. */
export function cardOrder(layout: HomeLayout | null): HomeCardId[] {
    const placed = (layout?.order ?? []).filter(id => !FIXED.has(id));
    const rest = HOME_CARD_IDS.filter(id => !FIXED.has(id) && !placed.includes(id));
    return [FIXED_FIRST, ...placed, ...rest, FIXED_LAST];
}

/** Whether a card can be hidden: everything but `needs` and `community` (§4.1). */
export const canHideCard = (id: HomeCardId): boolean => !FIXED.has(id);
/** Whether a card can be moved: the same cards; `needs` stays first and `community` last. */
export const canMoveCard = (id: HomeCardId): boolean => !FIXED.has(id);

const emptyLayout = (): HomeLayout => ({ v: 1, order: [], hidden: [], dismissed: {}, updatedAt: null });

export function isHidden(layout: HomeLayout | null, id: HomeCardId): boolean {
    return canHideCard(id) && !!layout?.hidden.includes(id);
}

/** Hidden: it goes from Home and comes back from Edit home (§4.1 "Add = un-hide"). Null when it can't be. */
export function hideCard(layout: HomeLayout | null, id: HomeCardId, now: number): HomeLayout | null {
    if (!canHideCard(id)) return null;
    const l = layout ?? emptyLayout();
    if (l.hidden.includes(id)) return null;
    return { ...l, hidden: [...l.hidden, id], updatedAt: new Date(now).toISOString() };
}

export function showCard(layout: HomeLayout | null, id: HomeCardId, now: number): HomeLayout | null {
    if (!layout?.hidden.includes(id)) return null;
    return { ...layout, hidden: layout.hidden.filter(h => h !== id), updatedAt: new Date(now).toISOString() };
}

/**
 * Up or down past the card next to it in `among` (the cards on screen, for the "…" menu; every card Edit home lists,
 * there), so a move always shows. The whole order is kept, so a card not in `among` keeps its place. Null when it can't
 * move that way.
 */
export function moveCard(layout: HomeLayout | null, id: HomeCardId, dir: 'up' | 'down', among: readonly HomeCardId[], now: number): HomeLayout | null {
    if (!canMoveCard(id)) return null;
    const movable = among.filter(canMoveCard);
    const at = movable.indexOf(id);
    const other = at < 0 ? undefined : movable[dir === 'up' ? at - 1 : at + 1];
    if (!other) return null;
    const order = cardOrder(layout).filter(canMoveCard);
    const i = order.indexOf(id);
    const j = order.indexOf(other);
    [order[i], order[j]] = [order[j], order[i]];
    return { ...(layout ?? emptyLayout()), order, updatedAt: new Date(now).toISOString() };
}

/** Back to the default order with nothing hidden (§4.1). A schedule's dismissal (the `safety` card) is not a layout choice: kept. */
export function resetLayout(layout: HomeLayout | null, now: number): HomeLayout {
    return { v: 1, order: [], hidden: [], dismissed: { ...(layout?.dismissed ?? {}) }, updatedAt: new Date(now).toISOString() };
}

/** The `safety` card was put away: when, on the account too (§3.1 "dismissal in home.layout"). */
export function dismissSafety(layout: HomeLayout | null, now: number): HomeLayout {
    const l = layout ?? emptyLayout();
    const at = new Date(now).toISOString();
    return { ...l, dismissed: { ...l.dismissed, safety: at }, updatedAt: at };
}

// ── What is asked, and what is drawn ───────────────────────────────────────────────────────────────────────────────

/**
 * Whether a node of this profile can ever show the card in this build: the money cards only where Beans, escrow and
 * enterprises are on (the node builds them only then, routes/home-answer.ts), the invite card only where invites are,
 * and First steps not on the global node, whose words come in H4. Unknown counts as on, as utils/node-profile.ts reads a
 * node's features (kept here so this file stays pure). Home draws only these whatever an answer holds, and Edit home
 * offers only these: "Nothing to show now" is said of a card that could show, never of one that can't.
 */
export function cardOnNode(id: HomeCardId, answer: Pick<HomeAnswer, 'profile' | 'features'>): boolean {
    if (!HOME_DRAWN.includes(id)) return false;
    const f = answer.features;
    switch (id) {
        case 'steps': return answer.profile !== 'global';
        case 'beans': return f.beans !== false;
        case 'deals': return f.escrow !== false;
        case 'enterprise': return f.enterprises !== false;
        case 'invite': return answer.profile !== 'global' && f.invites === true;
        default: return true;
    }
}

/**
 * Whether the reader tailors this Home: a member (the answer has a `me`). A visitor's answer (a key with no account on
 * the global node gets the public cards, routes/home.ts) has no "…", no Edit home and no hint, and the phone never
 * sends a layout for it: the node keeps a Home only for its members (design §2 (c): nothing a visitor could write with).
 */
export const canTailor = (answer: Pick<HomeAnswer, 'me'> | null | undefined): boolean => !!answer?.me;

/**
 * The cards to ask the node for (`cards=`), in the catalogue's order so the address is the same each time and a repeat
 * read can be a 304: what this build draws and the answer carries, minus the member's hidden cards (never `needs` or
 * `community`). Never decided by what the last answer said of the node (its profile): a list built on a stale answer
 * would leave out a card the node now has (measured on the emulator: First steps went missing after a switch).
 */
export function cardsToAsk(layout: HomeLayout | null): HomeCardId[] {
    return HOME_DRAWN.filter(id => !NO_DATA.has(id) && !isHidden(layout, id));
}

/** The member's starred categories: the account's, else the phone's own (the Market's For You stars, `bp_fav_categories`). */
export function effectiveInterests(accountInterests: readonly string[] | null | undefined, phone: readonly string[] | null | undefined): string[] {
    const pick = accountInterests && accountInterests.length ? accountInterests : phone ?? [];
    return [...new Set(pick.filter((c): c is string => typeof c === 'string' && c.length > 0))];
}

/** Starred categories first, the rest after, each part in the order it came (§4.3). `normalise` maps an old word to its id. */
export function starredFirst<T>(items: readonly T[], categoryOf: (t: T) => string, interests: readonly string[], normalise: (c: string) => string = c => c): T[] {
    if (!interests.length) return [...items];
    const starred = new Set(interests);
    const isStarred = (t: T) => starred.has(normalise(categoryOf(t) ?? ''));
    return [...items.filter(isStarred), ...items.filter(t => !isStarred(t))];
}

/** What the phone knows beside the answer, for the shown-when rules that are the phone's. */
export interface HomeDrawContext {
    /** The member's interests as the phone has them now (a tap shows before the save lands). */
    interests: readonly string[];
    /** The interests card was opened from the Market card's "Tune". */
    tuneOpen: boolean;
    /** The `safety` card's schedule says it is up (components/OneWayBackCard.tsx reports it). */
    safetyUp: boolean;
    /** Lines in Needs you once the phone's own are merged in ({@link mergeNeeds}); absent: the answer's alone. */
    needs?: number;
}

/**
 * A link to the tabs' first screen that means the Market's deals (`/` or `/(tabs)` with `tab=deals` or `dealsTab`, as
 * the map's "My deals" sends: app/(tabs)/map.tsx is not changed here): Home passes it on to the Market. Null otherwise.
 */
export function marketForward(params: { tab?: string | string[]; dealsTab?: string | string[] }): { tab: 'deals'; dealsTab?: string } | null {
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
    const tab = one(params.tab);
    const dealsTab = one(params.dealsTab);
    if (tab !== 'deals' && !dealsTab) return null;
    return dealsTab ? { tab: 'deals', dealsTab } : { tab: 'deals' };
}

/** The First steps lines of a local community (§3.1), with what is done. */
export interface StepLine { id: 'offer' | 'photo' | 'interests' | 'invite'; text: string; done: boolean }

export function stepLines(steps: NonNullable<HomeCards['steps']>, interestsSet: boolean): StepLine[] {
    const lines: StepLine[] = [
        { id: 'offer', text: 'Post your first Offer', done: steps.firstOffer },
        { id: 'photo', text: 'Add a photo to your profile', done: steps.photo },
        { id: 'interests', text: 'Pick a few things you like', done: steps.interests || interestsSet },
    ];
    // After the first Offer, where invites are on (null: no such step here).
    if (steps.invited !== null && steps.firstOffer) lines.push({ id: 'invite', text: 'Invite someone', done: steps.invited });
    return lines;
}

/**
 * The cards to draw, top to bottom (§3.2): the member's order, each card only while it has something to say, a hidden
 * card never (but `needs` and `community`). Not `find` (H4).
 */
export function cardsToDraw(answer: HomeAnswer, layout: HomeLayout | null, ctx: HomeDrawContext): HomeCardId[] {
    const c = answer.cards;
    const global = answer.profile === 'global';
    const shows = (id: HomeCardId): boolean => {
        if (!cardOnNode(id, answer)) return false;
        if (isHidden(layout, id)) return false;
        switch (id) {
            case 'needs': return ctx.needs !== undefined ? ctx.needs > 0 : !!c.needs?.items?.length;
            case 'safety': return ctx.safetyUp;
            case 'steps': return !global && !!c.steps && stepLines(c.steps, ctx.interests.length > 0).some(l => !l.done);
            case 'interests': return !!answer.me && (ctx.interests.length === 0 || ctx.tuneOpen);
            case 'invite': return !global && answer.features.invites === true && !!answer.me?.firstOffer;
            case 'market': return !!c.market && (c.market.items.length > 0 || !!c.market.examples);
            case 'decide': return !!c.decide && decideLines(c.decide, answer.features, 0).length > 0;
            case 'community': return true;
            default: return c[id as keyof HomeCards] !== undefined;
        }
    };
    return cardOrder(layout).filter(shows);
}

/**
 * The community's word on the account's way back, from an answer that asked for `safety` and was answered as the
 * account's own (a `me`): `cards.safety` present is a 12-words member with no sign-in, absent is not. Null when the answer
 * can't say (not asked, or a visitor's answer), and the "one way back" card asks for itself as before.
 */
export function safetyWord(answer: HomeAnswer, asked: readonly string[]): { words: boolean; joinedAt: number | null } | null {
    if (!answer.me || !asked.includes('safety')) return null;
    const joined = answer.me.joinedAt ? Date.parse(answer.me.joinedAt) : NaN;
    return { words: !!answer.cards.safety, joinedAt: Number.isFinite(joined) ? joined : null };
}

// ── Needs you: the phone's own lines, and the node's ──────────────────────────────────────────────────────────────

/** What the phone's database says needs the member: deals and unread messages. `null` input: that kind didn't load. */
export interface LocalNeeds { entries: NeedsYouEntry[]; kinds: ReadonlySet<NeedsYouKind> }

export function localNeeds(me: string, now: number, transactions: NeedsYouTransaction[] | null, conversations: NeedsYouConversation[] | null): LocalNeeds {
    const kinds = new Set<NeedsYouKind>();
    if (transactions) kinds.add('deal');
    if (conversations) kinds.add('message');
    const entries = buildNeedsYou({ me, now, transactions, conversations, decisions: null, groupChats: null, admin: null });
    return { entries, kinds };
}

const SERVER_CLOSES = /closes (?:within the hour|in \d+ (?:hours?|days?))/;

/** The node words a vote's closing from hours and days only; the phone says it in the member's own time ("tonight"). */
export function voteLabelHere(item: HomeNeedsItem, now: number): string {
    if (item.kind !== 'vote' || !item.closesAt || !Number.isFinite(Date.parse(item.closesAt))) return item.label;
    return item.label.replace(SERVER_CLOSES, closesInWords(item.closesAt, now));
}

const sameDeal = (a: NeedsYouTarget, b: NeedsYouTarget) => a.to === 'deal' && b.to === 'deal' && a.txId === b.txId;

/**
 * One list, as the header shows it, highest first:
 * - the node's admin work, votes and group lines;
 * - unread messages from the phone's own database when it could be read (it knows at once what was read here), else
 *   the node's line;
 * - a deal waiting from the phone's database when it has one, else the node's: the phone's copy of the trades can lag
 *   the node's until the next sync (measured on the emulator: a request made to the member showed in the answer, not yet
 *   on the phone), and a deal is the line that costs a member something if missed.
 */
export function mergeNeeds(node: readonly HomeNeedsItem[] | null | undefined, local: LocalNeeds | null, now: number): NeedsYouEntry[] {
    const phoneHas = (kind: NeedsYouKind) => kind === 'message'
        ? !!local?.kinds.has('message')
        : kind === 'deal' && !!local?.entries.some(e => e.kind === 'deal');
    const fromNode = (node ?? []).filter(i => !phoneHas(i.kind))
        .map((i): NeedsYouEntry => ({ kind: i.kind, count: i.count, accent: i.accent, label: voteLabelHere(i, now), target: i.target }));
    const fromPhone = (local?.entries ?? []).map(e => {
        // One deal the node names too: its words carry the listing's title.
        const named = e.kind === 'deal' ? (node ?? []).find(i => i.kind === 'deal' && sameDeal(i.target, e.target)) : undefined;
        return named ? { ...e, label: named.label } : e;
    });
    const rank = (k: NeedsYouKind) => NEEDS_YOU_PRIORITY.indexOf(k);
    return [...fromPhone, ...fromNode].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/**
 * Text a member or the node wrote, ended with one stop, so a screen reader's "… Opens the listing." never reads a
 * doubled one ("kept it up.. Opens it.", measured on the emulator).
 */
export function sentence(text: string): string {
    const t = text.trim();
    return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** A line of Needs you in words that say what waits, never by colour alone (§10): the accent has a ▲ too. */
export function needsLineA11y(e: NeedsYouEntry): string {
    return e.accent ? `${sentence(e.label)} Waiting on you.` : e.label;
}

// ── Each card's words ─────────────────────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** 2310 → "2,310"; never the phone's locale (Hermes builds differ). */
export const groupThousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** −35, 12, 12.5: a true minus sign, at most two decimals, none when whole. */
export function formatBeans(n: number): string {
    const r = Math.round(n * 100) / 100;
    const abs = Math.abs(r);
    const text = Number.isInteger(abs) ? groupThousands(abs) : abs.toFixed(2).replace(/0$/, '');
    return r < 0 ? `−${text}` : text;
}

/** Your Beans (§3.1): own balance only. Tiers are merit badges: the word, nothing about what it opens. */
export function beansLines(b: NonNullable<HomeCards['beans']>): { main: string; sub: string | null } {
    if (!b.activated && b.balance === 0) {
        return { main: '0 Beans · nothing to repay', sub: 'Your credit opens with a first trade.' };
    }
    if (b.frozen) {
        return { main: `${formatBeans(b.balance)} Beans`, sub: 'Spending is paused for now. You can still receive and sell.' };
    }
    if (!b.activated) return { main: `${formatBeans(b.balance)} Beans`, sub: 'Your credit opens with a first trade.' };
    return { main: `${formatBeans(b.balance)} Beans · room to spend ${formatBeans(b.room)}`, sub: b.tier || null };
}

/** The community's card (§3.1): its name and totals, public by rule. */
export function communityLines(card: HomeCards['community'] | undefined, profile: string, invitesOn: boolean): { title: string; line: string } {
    const global = profile === 'global';
    const title = global ? 'The worldwide community' : (card?.name?.trim() || HOME_CARD_NAMES.community);
    if (!card) return { title, line: '' };
    if (!global && card.members <= 1) {
        return { title, line: invitesOn ? "1 member. You're first. Invite someone." : "1 member. You're first." };
    }
    const parts = [plural(card.members, 'member', 'members').replace(String(card.members), groupThousands(card.members))];
    if (card.tradesThisMonth !== undefined) parts.push(`${plural(card.tradesThisMonth, 'trade', 'trades')} this month`);
    if (card.communities !== undefined) parts.push(`${groupThousands(card.communities)} ${card.communities === 1 ? 'community' : 'communities'} listed`);
    return { title, line: `${parts.join(' · ')}.` };
}

/** Who joined (§3.1): faces and names on a local community; on the global node a count by area, no names. */
export function joinedLine(card: NonNullable<HomeCards['joined']>): string {
    const names = (card.names ?? []).map(n => n.callsign).filter(Boolean);
    if (names.length) {
        const more = card.count7d - names.length;
        if (more > 0) return `${names.join(', ')} and ${more} more joined this week.`;
        if (names.length === 1) return `${names[0]} joined this week.`;
        return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} joined this week.`;
    }
    const who = card.count7d === 1 ? '1 person' : `${groupThousands(card.count7d)} people`;
    return `${who}${card.radiusKm ? ` within ${card.radiusKm} km` : ''} joined this week.`;
}

export function dealsLine(card: NonNullable<HomeCards['deals']>): string {
    const open = `${card.open} open`;
    if (card.waitingOnMe) return `${open} · waiting on you: ${card.waitingOnMe.title}`;
    return card.waiting > 0 ? `${open} · ${card.waiting} waiting on you` : open;
}

export function enterpriseLine(card: NonNullable<HomeCards['enterprise']>): string {
    const requests = card.requests > 0 ? `${plural(card.requests, 'request', 'requests')} to approve` : 'No requests waiting';
    return card.others > 0 ? `${requests} · and ${card.others} more you keep` : requests;
}

/** A screen a Home line opens, as `router.push` takes it. */
export interface HomeHref { pathname: string; params?: Record<string, string> }

/** Formal Decisions: Commons → Decide (app/(tabs)/projects.tsx). */
export const DECIDE_HREF: HomeHref = { pathname: '/(tabs)/projects', params: { section: 'decide' } };
/** Polls are posts, on every node: the Market's Polls pill (app/(tabs)/market.tsx takes `filter=polls`). Decide never lists them. */
export const POLLS_HREF: HomeHref = { pathname: '/(tabs)/market', params: { filter: 'polls' } };

export interface DecideLine { id: 'decisions' | 'polls'; text: string; a11y: string; href: HomeHref }

/**
 * The Decide card (§3.1), one line per place, each one tap into where its things are listed:
 * - open Decisions → Commons → Decide, only where the node has Decisions and shows Commons (utils/node-profile.ts
 *   `decisionsOn`, `hiddenTabsFor`: the global node has neither);
 * - open polls → the Market's Polls, on every node.
 */
export function decideLines(card: NonNullable<HomeCards['decide']>, features: HomeAnswer['features'], now: number): DecideLine[] {
    const lines: DecideLine[] = [];
    if (card.open > 0 && features.decisions !== false && features.beans !== false) {
        const closes = card.soonestClosesAt ? closesInWords(card.soonestClosesAt, now) : null;
        const when = !closes ? '' : card.open === 1 ? `, ${closes}` : `, the first ${closes}`;
        const text = `${plural(card.open, 'Decision', 'Decisions')} open${when}`;
        lines.push({ id: 'decisions', text, a11y: `${sentence(text)} Opens Decide, in Commons.`, href: DECIDE_HREF });
    }
    if (card.polls > 0) {
        const text = `${card.polls}${card.pollsMore ? '+' : ''} ${card.polls === 1 && !card.pollsMore ? 'poll' : 'polls'} open`;
        lines.push({ id: 'polls', text, a11y: `${sentence(text)} Opens the polls, in the Market.`, href: POLLS_HREF });
    }
    return lines;
}

export function groupLine(g: NonNullable<HomeCards['groups']>['items'][number]): string {
    if (g.muted) return `${g.name} · muted`;
    return `${g.name} · ${g.unread > 0 ? `${g.unread} new` : 'quiet'}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat 3 Oct", in the phone's own time. */
export function eventDay(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function eventLine(e: HomeEventItem): string {
    return `${eventDay(e.startsAt)} · ${e.title}${e.place ? `, ${e.place}` : ''}`;
}

export const RSVP_WORDS: Record<'going' | 'interested', string> = { going: 'Going', interested: 'Interested' };

export function pulseTitle(p: HomePulseItem): string {
    return p.title?.trim() || 'A post from the Pulse';
}

/** The Market card's caption: "Near you" where listings come nearest first (the global node), else what's new. */
export function marketCaption(profile: string): string {
    return profile === 'global' ? 'Near you' : HOME_CARD_NAMES.market;
}

/** A card's caption: most are its name; the Market's and the community's depend on the node. */
export function cardCaption(id: HomeCardId, answer: Pick<HomeAnswer, 'profile' | 'cards'>): string {
    if (id === 'market') return marketCaption(answer.profile);
    if (id === 'community') return communityLines(answer.cards.community, answer.profile, false).title;
    return HOME_CARD_NAMES[id];
}

// ── When Home asks the node again ─────────────────────────────────────────────────────────────────────────────────

/** The doorbells Home cares about (§5.2); any other kind of change leaves it as it is. */
export const HOME_DOORBELLS: ReadonlySet<string> = new Set([
    'new_post', 'transaction_completed', 'decision_vote_cast', 'group_updated', 'profile_updated', 'system_announcement',
]);
/** One read after a burst of doorbells (§5.2: debounced 3 s), never one per bell. */
export const HOME_DOORBELL_SETTLE_MS = 3_000;
/** The backstop, as the header's (NeedsYouIcons SAFETY_POLL_MS), while Home is in front. Never a per-card timer. */
export const HOME_SAFETY_POLL_MS = 120_000;
/** How long the header draws from Home's answer instead of its own reads (§5.2 "fresher than 120 s"). */
export const HOME_FRESH_FOR_HEADER_MS = 120_000;

export function isHomeDoorbell(data: unknown): boolean {
    return isObj(data) && typeof data.type === 'string' && HOME_DOORBELLS.has(data.type);
}

/**
 * A debouncer for the doorbell: each bell pushes the read back to `settleMs` after the last one, so a burst costs one
 * read. Pure over its timer functions, for the tests.
 */
export function createDoorbellDebounce(
    run: () => void,
    settleMs: number = HOME_DOORBELL_SETTLE_MS,
    timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
        set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
): { ring: (data: unknown) => void; cancel: () => void } {
    let timer: unknown = null;
    return {
        ring(data) {
            if (!isHomeDoorbell(data)) return;
            if (timer !== null) timers.clear(timer);
            timer = timers.set(() => { timer = null; run(); }, settleMs);
        },
        cancel() {
            if (timer !== null) timers.clear(timer);
            timer = null;
        },
    };
}
