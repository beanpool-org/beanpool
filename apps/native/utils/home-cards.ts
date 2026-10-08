/**
 * Home, the screen the app opens on (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H2): the rules, kept pure
 * so they are tested once (utils/__tests__/home-cards.test.ts) and ported to the web app as they are (H3). The screen
 * (app/(tabs)/index.tsx) only loads the answer and draws what this file says.
 *
 * - **The catalogue** is core's registry (@beanpool/core home-frame.ts, scratch/home/CARD-FRAME-DESIGN-fable.md §2.2):
 *   one list of types, names, lines and rules for both apps and the node. A card with nothing to say takes no space: the
 *   node leaves it out of its answer (GET /api/home, apps/server routes/home-answer.ts), and the few rules that need the
 *   phone (the interests card, the invite card) are here.
 * - **The layout** (CARD-FRAME §2) is a list of card instances the member owns, kept on the account (`home.layout`
 *   version 2) with a copy on the phone; the newer wins by `updatedAt`. A member adds (the picker), removes, moves and
 *   resets cards; nothing is dragged. `needs` stays at the top and `community` at the bottom (it carries Add a card and
 *   Edit home): neither is in the list. A card of a type this build doesn't know is kept through every save, never drawn.
 * - **Interests reorder, they never filter** (§4.3): starred categories first, the rest after, each part in its order.
 * - **Needs you** is the header's own list (utils/needs-you.ts): the phone's own deals and unread messages from its
 *   database (fresher, no request), the node's admin work, votes and group lines from the answer.
 *
 * - **The global flavour** (slice H4, §3.1, §7, §13 Q4 and Q5): Find your community is a Home card on the global node
 *   (the Market no longer draws it), pinned at the top and impossible to hide or move for the member's first 30 days,
 *   then a card like any other; First steps there says the global words and the new-account limits (`me.probation`);
 *   Who joined is a count by area, never a name; "Near you" lists the nearest first. A local community's Home is H2's.
 */

import {
    HOME_CARD_GROUPS, HOME_CARD_TYPES, HOME_FRAME_LIMITS, addCard as frameAddCard, cardsToAsk as frameCardsToAsk, defaultHomeLayout,
    homeCardType, readHomeLayout as frameReadHomeLayout, readSearchSettings, removeCard as frameRemoveCard,
    type HomeAddRefusal, type HomeCardGroup, type HomeCardInstance, type HomeLayoutV2,
} from '@beanpool/core';
import {
    NEEDS_YOU_PRIORITY, buildNeedsYou, closesInWords,
    type NeedsYouConversation, type NeedsYouEntry, type NeedsYouKind, type NeedsYouTarget, type NeedsYouTransaction,
} from './needs-you';

// ── The catalogue: core's registry (@beanpool/core home-frame.ts, design CARD-FRAME §2.2) ──────────────────────────

/**
 * A card type's id, as core's registry names it (`beans`, `search`, …). A list may hold a type this build doesn't know
 * (a newer app's): it is kept through every save and not drawn.
 */
export type HomeCardId = string;
export type { HomeCardInstance };

/** First and last, always: the one card that costs a member something if missed, and the one that holds Edit home. */
export const FIXED_FIRST: HomeCardId = 'needs';
export const FIXED_LAST: HomeCardId = 'community';
const FIXED: ReadonlySet<HomeCardId> = new Set([FIXED_FIRST, FIXED_LAST]);

/**
 * The types this build has a body for (app/(tabs)/index.tsx `card`). A type in the registry but not here is listed
 * nowhere and drawn nowhere; a type in neither is a newer app's, kept and not drawn.
 */
export const HOME_DRAWN: ReadonlySet<HomeCardId> = new Set([
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'search', 'decide', 'groups',
    'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
]);

/** Find your community is pinned for a member's first 30 days on the global node, then it can be removed (§4.1, §7, §13 Q5). */
export const FIND_PINNED_DAYS = 30;
const DAY_MS = 86_400_000;

/** A type's name: its caption, its row in the picker and Edit home, and the screen reader's words for its menu. */
export function cardName(type: HomeCardId, profile?: string): string {
    const t = homeCardType(type);
    if (!t) return type;
    return profile === 'global' && t.globalName ? t.globalName : t.name;
}

/** The most of a saved search's words its screen-reader name carries; longer ones end in "…". */
export const CARD_WORDS_MAX = 24;

/**
 * One card's name for the screen reader: its "…" and Edit home's labels, and the "added" and "removed" lines. A saved
 * search is named by its words, in quotes and bounded (`"eggs"`), so two of them never sound alike (CARD-FRAME §1.3;
 * review of #1699, finding 4); every other card by its type's name. Never the caption: a caption is fixed words, never a
 * member's.
 */
export function cardLabelName(c: Pick<HomeCardInstance, 'type' | 'settings'>, profile?: string): string {
    if (c.type === 'search') {
        const q = readSearchSettings(c.settings).q.trim().replace(/\s+/g, ' ');
        if (q) return `"${q.length > CARD_WORDS_MAX ? `${q.slice(0, CARD_WORDS_MAX).trimEnd()}…` : q}"`;
    }
    return cardName(c.type, profile);
}

// ── The answer, as GET /api/home sends it (apps/server routes/home-answer.ts HomeAnswer) ────────────────────────────

export interface HomeNeedsItem extends NeedsYouEntry { closesAt?: string }

export interface HomeMarketItem { id: string; type: 'offer' | 'need'; title: string; category: string; credits?: number; photoUrl: string | null; distanceKm?: number | null }
export interface HomeEventItem { id: string; title: string; startsAt: string; endsAt: string | null; place: string | null; rsvp: 'going' | 'interested' | null; distanceKm?: number | null }
export interface HomePulseItem { id: string; title: string | null; thumbnailUrl: string | null; platform: string; callsign: string; category: string; url: string | null }

/**
 * Find your community's body: GET /api/global/home's, assembled in-process (apps/server routes/global-directory.ts
 * `landingCardFor`). Its rows are other people's publications: the screen reads them through
 * utils/community-directory.ts `readGlobalHome`, which checks each one, before anything of them is drawn.
 */
export interface HomeFind {
    point: 'request' | 'area' | null;
    communities: unknown[];
    communityCount: number;
    nearbyPosts: { radiusKm: number; count: number; more: boolean } | null;
    watches: unknown[] | null;
    knock: null;
    directoryFetchedAt: string | null;
}

/** The member's own new-account limits as the node sends them (`me.probation`, apps/server engine/probation.ts ProbationSummary). */
export interface HomeProbation {
    onProbation: boolean;
    rules?: 'words' | 'ordinary';
    limits?: { posts?: { limit: number }; photos?: { limit: number }; new_dm_recipients?: { limit: number } };
    endsWhen?: { hours: number; keptPosts: number };
}

export interface HomeCards {
    needs?: { items: HomeNeedsItem[] };
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
    pulse?: { items: HomePulseItem[] };
    beans?: { balance: number; room: number; tier: string; activated: boolean; frozen: boolean };
    notices?: { unseen: number; first: { id: string; title: string; line: string } };
    community?: { name: string | null; members: number; tradesThisMonth?: number; communities?: number };
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

/**
 * A member's Home as kept on their account and on the phone: core's version 2 (`{ v: 2, cards: [{ id, type, settings? }],
 * dismissed, updatedAt }`). A card is on Home because it is in `cards`, and nowhere else. Version 1 is read through core's
 * `translateV1` (their order, hidden cards left out) and never written.
 */
export type HomeLayout = HomeLayoutV2;

export interface HomeAnswer {
    generatedAt: string;
    profile: string;
    features: { beans?: boolean; escrow?: boolean; enterprises?: boolean; invites?: boolean; exampleListings?: boolean; decisions?: boolean; wordsDoor?: boolean; [k: string]: unknown };
    welcome?: true;
    me: HomeMe | null;
    layout: HomeLayout | null;
    /**
     * The account's layout came as version 1 (translated): from a node before the frame, or a member who last edited with
     * an older app. `empty`: it named no order and nothing hidden, as a not-yet-updated standby answers a version-2 row
     * (review of #1697, note b), so it says nothing of the member's choice.
     */
    layoutV1?: { empty: boolean };
    cards: HomeCards;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A layout as the node or the phone's copy holds it, read by core (tolerant): version 2 keeps every instance whose shape
 * is right, known type or not, so a newer app's card survives this one's saves; version 1 reads as the member's order with
 * hidden cards left out. Null for anything else (the newcomer's Home).
 */
export const readHomeLayout = (raw: unknown): HomeLayout | null => frameReadHomeLayout(raw);

/** Whether a stored or answered value is a version-1 layout, and whether it named anything. Undefined for any other. */
export function layoutV1Of(raw: unknown): { empty: boolean } | undefined {
    if (!isObj(raw)) return undefined;
    const v1 = raw.v === 1 || (raw.v === undefined && (Array.isArray(raw.order) || Array.isArray(raw.hidden)));
    if (!v1) return undefined;
    const named = (l: unknown) => Array.isArray(l) && l.length > 0;
    return { empty: !named(raw.order) && !named(raw.hidden) };
}

/** An answer read tolerantly: anything that isn't one is null, and the screen keeps what it had. */
export function readHomeAnswer(raw: unknown): HomeAnswer | null {
    if (!isObj(raw) || !isObj(raw.cards) || typeof raw.profile !== 'string') return null;
    const me = isObj(raw.me) ? raw.me as unknown as HomeMe : null;
    // A kept answer (utils/home-store.ts) holds the layout already read, with its version-1 mark beside it.
    const kept = isObj(raw.layoutV1) && typeof raw.layoutV1.empty === 'boolean' ? { empty: raw.layoutV1.empty } : undefined;
    const v1 = layoutV1Of(raw.layout) ?? kept;
    return {
        generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
        profile: raw.profile,
        features: isObj(raw.features) ? raw.features as HomeAnswer['features'] : {},
        ...(raw.welcome === true ? { welcome: true as const } : {}),
        me: me ? { ...me, interests: Array.isArray(me.interests) ? me.interests.filter((c): c is string => typeof c === 'string') : [] } : null,
        layout: readHomeLayout(raw.layout),
        ...(v1 ? { layoutV1: v1 } : {}),
        cards: raw.cards as HomeCards,
    };
}

// ── The layout: which copy wins, and the member's edits ───────────────────────────────────────────────────────────

const stamp = (l: HomeLayout | null) => (l?.updatedAt ? Date.parse(l.updatedAt) : -Infinity);

/**
 * The account's copy or the phone's, the newer by `updatedAt` (§4.2; the node keeps the newer too, home-preferences.ts).
 * `push`: the phone's copy is newer than the account's, so it is sent (an edit made offline, or one whose save failed).
 *
 * A version-1 account copy (`accountV1`) never wins over the phone's on a tie, and an empty one never wins at all: a
 * not-yet-updated standby answers a version-2 row as an empty version-1 layout dated exactly like it (review of #1697,
 * note b), and adopting it would throw away every card the member added. The phone's is drawn and not sent (the node
 * already has it, or can't keep it yet).
 *
 * With no copy on the phone, an empty version-1 account copy is unknown, not "every version-1 card": the newcomer's list
 * is drawn (with the account's dismissal), and an edit made on it is the phone's only. `phoneOnlyOver` marks such a
 * phone list with that empty list's date: a version-2 answer dated at or after it is the account's real list (the
 * primary back from a standby) and wins over the edit, never the reverse (review of #1699, finding 2).
 */
export function pickLayout(
    account: HomeLayout | null, phone: HomeLayout | null, accountV1?: { empty: boolean }, phoneOnlyOver?: string | null,
): { layout: HomeLayout | null; push: boolean } {
    if (!phone) {
        if (accountV1?.empty) return { layout: { ...defaultHomeLayout(), dismissed: account?.dismissed ?? {} }, push: false };
        return { layout: account, push: false };
    }
    if (!account) return { layout: phone, push: true };
    if (phoneOnlyOver != null && !accountV1 && stamp(account) >= (phoneOnlyOver ? Date.parse(phoneOnlyOver) : -Infinity)) {
        return { layout: account, push: false };
    }
    if (stamp(phone) > stamp(account)) return { layout: phone, push: true };
    if (accountV1 && (accountV1.empty || stamp(phone) === stamp(account))) return { layout: phone, push: false };
    return { layout: account, push: false };
}

/**
 * Whether Find your community is pinned for this reader: on the global node, in the member's first 30 days from joining,
 * or while the join date is unknown (the node's own rule, routes/home-answer.ts `cardsToBuild`, and the web app's,
 * apps/pwa lib/home-cards.ts `findPinned`).
 */
export function findPinned(answer: Pick<HomeAnswer, 'profile' | 'me'>, now: number): boolean {
    if (answer.profile !== 'global') return false;
    const joined = answer.me?.joinedAt ? Date.parse(answer.me.joinedAt) : NaN;
    return !Number.isFinite(joined) || now - joined < FIND_PINNED_DAYS * DAY_MS;
}

/** The cards pinned for this reader now: they can't be removed or moved, and stand at the top (only `find` has a pin). */
export function pinnedCards(answer: Pick<HomeAnswer, 'profile' | 'me'> | null | undefined, now: number): HomeCardId[] {
    return answer && findPinned(answer, now) ? ['find'] : [];
}

/** The list a layout holds: the member's, or the newcomer's while there is none. */
export const listOf = (layout: HomeLayout | null): HomeCardInstance[] => layout?.cards ?? defaultHomeLayout().cards;

/**
 * The cards in the member's order, drawn defensively (review of #1697, note c: only core's `addCard` keeps the limits, so
 * a stored list may hold anything): `needs` first, the list's cards of a type this build draws (a one-of-a-kind type
 * once, an instance type up to its limit, the fixed two never from the list), `community` last. A pinned `find` stands
 * right under `needs` (and under "Your way back in" while that one keeps its place there, as the design's global Home
 * draws them, §9 (a)), whatever the list says: "pinned at the top for 30 days" (§0, §7).
 */
export function cardOrder(layout: HomeLayout | null, pinned: readonly HomeCardId[] = []): HomeCardInstance[] {
    const count = new Map<string, number>();
    const placed: HomeCardInstance[] = [];
    for (const c of listOf(layout)) {
        const t = homeCardType(c.type);
        if (!t || t.fixed || !HOME_DRAWN.has(c.type) || pinned.includes(c.type)) continue;
        const n = count.get(c.type) ?? 0;
        if (n >= (t.multiple?.max ?? 1)) continue;
        count.set(c.type, n + 1);
        placed.push(c);
    }
    const order: HomeCardInstance[] = [{ id: FIXED_FIRST, type: FIXED_FIRST }, ...placed, { id: FIXED_LAST, type: FIXED_LAST }];
    if (!pinned.includes('find')) return order;
    const at = order[1]?.type === 'safety' ? 2 : 1;
    return [...order.slice(0, at), { id: 'find', type: 'find' }, ...order.slice(at)];
}

/** Whether a card can be removed: everything but `needs`, `community` and a pinned card (§1.3). */
export const canRemoveCard = (type: HomeCardId, pinned: readonly HomeCardId[] = []): boolean => !FIXED.has(type) && !pinned.includes(type);
/** Whether a card can be moved: the same cards; `needs` stays first, a pinned card under it, and `community` last. */
export const canMoveCard = (type: HomeCardId, pinned: readonly HomeCardId[] = []): boolean => !FIXED.has(type) && !pinned.includes(type);

const at = (now: number) => new Date(now).toISOString();

/**
 * A card added (§1.3): first, under Needs you and a pinned card; its settings through its type's reader. Null when it
 * can't be (one already there, the type's limit, a full Home, a type this build can't draw), with core's reason.
 */
export function addCard(
    layout: HomeLayout | null, type: HomeCardId, now: number, opts: { settings?: unknown; pinned?: readonly HomeCardId[]; random?: () => number } = {},
): { ok: true; layout: HomeLayout; id: string } | { ok: false; refused: HomeAddRefusal } {
    if (!HOME_DRAWN.has(type)) return { ok: false, refused: 'unknown' };
    return frameAddCard(layout ?? defaultHomeLayout(), type, { settings: opts.settings, pinned: opts.pinned, now, random: opts.random });
}

/** A card taken off Home: the instance goes, its settings and any dismissal with it (§1.3). Null when it can't be. */
export function removeCard(layout: HomeLayout | null, id: string, now: number, pinned: readonly HomeCardId[] = []): HomeLayout | null {
    const card = listOf(layout).find(c => c.id === id);
    if (!card || !canRemoveCard(card.type, pinned)) return null;
    return frameRemoveCard(layout ?? defaultHomeLayout(), id, now);
}

/** A card's settings changed in place (Settings… → Save): it keeps its place. Null when it isn't there. */
export function changeCardSettings(layout: HomeLayout | null, id: string, settings: unknown, now: number): HomeLayout | null {
    const list = listOf(layout);
    const i = list.findIndex(c => c.id === id);
    const reader = i < 0 ? undefined : homeCardType(list[i].type)?.readSettings;
    if (!reader) return null;
    const cards = [...list];
    cards[i] = { ...cards[i], settings: reader(settings) };
    return { ...(layout ?? defaultHomeLayout()), cards, updatedAt: at(now) };
}

/**
 * Up or down past the card next to it in `among` (the cards on screen, for the "…" menu; every card Edit home lists,
 * there), so a move always shows. Every other card keeps its place in the list. Null when it can't move that way.
 */
export function moveCard(
    layout: HomeLayout | null, id: string, dir: 'up' | 'down', among: readonly HomeCardInstance[], now: number, pinned: readonly HomeCardId[] = [],
): HomeLayout | null {
    const list = listOf(layout);
    const movable = among.filter(c => canMoveCard(c.type, pinned) && list.some(l => l.id === c.id));
    const from = movable.findIndex(c => c.id === id);
    const other = from < 0 ? undefined : movable[dir === 'up' ? from - 1 : from + 1];
    if (!other) return null;
    const cards = [...list];
    const i = cards.findIndex(c => c.id === id);
    const j = cards.findIndex(c => c.id === other.id);
    [cards[i], cards[j]] = [cards[j], cards[i]];
    return { ...(layout ?? defaultHomeLayout()), cards, updatedAt: at(now) };
}

/**
 * Reset to defaults: the newcomer's list (§1.3). A schedule's dismissal (the `safety` card) is not a layout choice: kept.
 * A card of a type this build doesn't know (a newer app's) is kept too, at the end: Reset is this app's defaults, not a
 * licence to throw away what it can't see.
 */
export function resetLayout(layout: HomeLayout | null, now: number): HomeLayout {
    const unknown = listOf(layout).filter(c => !homeCardType(c.type));
    const cards = [...defaultHomeLayout().cards, ...unknown].slice(0, HOME_FRAME_LIMITS.cards);
    return { v: 2, cards, dismissed: { ...(layout?.dismissed ?? {}) }, updatedAt: at(now) };
}

/** The `safety` card was put away: when, on the account too (§3.1 "dismissal in home.layout"). */
export function dismissSafety(layout: HomeLayout | null, now: number): HomeLayout {
    const l = layout ?? defaultHomeLayout();
    return { ...l, dismissed: { ...l.dismissed, safety: at(now) }, updatedAt: at(now) };
}

/**
 * Whether a member who never edited sees the one-time line "Home now starts with fewer cards. Add a card brings the rest
 * back." (§2.6): neither the account nor the phone holds a layout, and they joined more than a week ago (a newcomer never
 * saw the longer Home, so has nothing to miss).
 */
export function fewerCardsNews(account: HomeLayout | null, phone: HomeLayout | null, me: Pick<HomeMe, 'joinedAt'> | null | undefined, now: number): boolean {
    if (account || phone || !me) return false;
    const joined = me.joinedAt ? Date.parse(me.joinedAt) : NaN;
    return Number.isFinite(joined) && now - joined > 7 * DAY_MS;
}

export const FEWER_CARDS_LINE = 'Home now starts with fewer cards. Add a card brings the rest back.';
/** The one-time hint (§1.3). */
export const HOME_HINT_LINE = 'This is your Home. Add a card at the bottom, or tap … on a card to move or remove it.';
/**
 * A saved search's card in this build: an updated node already builds its listings, and this app draws them from its
 * next update (slice F4), so the line promises nothing this build can't draw (review of #1699, finding 4).
 */
export const SEARCH_WAITING_LINE = 'Its listings show in a coming app update.';
/** Edit home's line while a node before the frame can't keep the member's cards (§2.3). */
export const NOT_ON_ACCOUNT_LINE = "Your community's server needs an update before your cards follow you to other devices.";

// ── The picker (§1.2) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PickerRow {
    type: HomeCardId;
    name: string;
    line: string;
    /** `add`: an Add button; `on-home`: a one-of-a-kind already there; `full`: an instance type at its limit. */
    state: 'add' | 'on-home' | 'full';
    /** "2 of 5 on Home", for an instance type with one there. */
    count: string | null;
    /** A type's own state line ("All tips seen"). */
    status: string | null;
    hasSettings: boolean;
}

export interface PickerGroup { id: HomeCardGroup; name: string; rows: PickerRow[] }

/**
 * The picker's groups (For you · Around you · Getting started), each type this node can show and this build can draw,
 * in the catalogue's order. Never a type that isn't here, never one shown as locked. A pinned `find` is on Home already
 * and not listed. `full`: Home holds 24 cards, so every Add goes.
 */
export function pickerGroups(
    answer: Pick<HomeAnswer, 'profile' | 'features'> & { cards?: HomeCards }, layout: HomeLayout | null, role: HomeRole,
    pinned: readonly HomeCardId[] = [], status: Partial<Record<HomeCardId, string>> = {},
): { groups: PickerGroup[]; full: boolean } {
    const list = listOf(layout);
    const full = list.length >= HOME_FRAME_LIMITS.cards;
    const groups = HOME_CARD_GROUPS.map(g => ({ id: g.id, name: g.name, rows: [] as PickerRow[] }));
    for (const t of HOME_CARD_TYPES) {
        if (t.fixed || !HOME_DRAWN.has(t.id) || pinned.includes(t.id) || !cardOnNode(t.id, answer, role)) continue;
        const n = list.filter(c => c.type === t.id).length;
        const max = t.multiple?.max ?? 1;
        const state: PickerRow['state'] = !t.multiple && n > 0 ? 'on-home' : n >= max ? 'full' : 'add';
        groups.find(g => g.id === t.group)!.rows.push({
            type: t.id,
            name: cardName(t.id, answer.profile),
            line: t.line,
            state: full && state === 'add' ? 'full' : state,
            count: t.multiple && n > 0 ? `${Math.min(n, max)} of ${max} on Home` : null,
            status: status[t.id] ?? null,
            hasSettings: !!t.readSettings,
        });
    }
    return { groups: groups.filter(g => g.rows.length > 0), full };
}

/** What the screen reader hears, and the live line says, when a card is added or removed (§1.3). */
export const addedLine = (name: string) => `${name} added to Home`;
export const removedLine = (name: string) => `${name} removed. Add a card brings it back.`;

// ── What is asked, and what is drawn ───────────────────────────────────────────────────────────────────────────────

/**
 * Whether a node of this kind can show the card to this reader: core's one rule (home-frame.ts `onNode`, per type: no
 * Beans, deals, enterprise, Decide or invites on the worldwide community; Grow your community only where the reader can
 * invite; Find your community only on the global node; "Your way back in" only where the 12-words door is open or the node
 * sent one), and only for a type this build draws. Home draws only these whatever an answer holds, the picker lists only
 * these, and Edit home's "Nothing to show now" is said of a card that could show, never of one that can't.
 */
export function cardOnNode(type: HomeCardId, answer: Pick<HomeAnswer, 'profile' | 'features'> & { cards?: HomeCards }, role?: HomeRole): boolean {
    const t = homeCardType(type);
    return !!t && HOME_DRAWN.has(type) && t.onNode({ profile: answer.profile, features: answer.features, cards: answer.cards as Record<string, unknown> | undefined }, role);
}

/** The reader's role on this node as the node said it (GET /api/node-admin/me, utils/node-admin.ts): null for none, undefined not heard. */
export type HomeRole = 'owner' | 'admin' | 'moderator' | null | undefined;

/**
 * Whether the reader can invite on this node (PR #1483 review 4166559683): invites are on, and where only the community's
 * admins invite (`features.door === 'admins'`, utils/invite-entries.ts `onlyAdminsInvite`) the node has said they are an
 * owner or admin. People → Invites' own rule for a role the node has said (invite-entries.ts `mayInviteHere`, said again
 * here so this file stays pure; a test holds the two together). A role not heard yet counts as no here: Home never asks
 * a member for something they may not be able to do, nor keeps First steps open on it (design §6.3).
 */
export function invitesForReader(features: HomeAnswer['features'], role: HomeRole): boolean {
    if (features.invites !== true) return false;
    if (features.door !== 'admins') return true;
    return role === 'owner' || role === 'admin';
}

/**
 * Whether the reader tailors this Home: a member (the answer has a `me`). A visitor's answer (a key with no account on
 * the global node gets the public cards, routes/home.ts) has no "…", no Add a card, no Edit home and no hint, and the
 * phone never sends a layout for it: the node keeps a Home only for its members (design §2 (c)).
 */
export const canTailor = (answer: Pick<HomeAnswer, 'me'> | null | undefined): boolean => !!answer?.me;

/**
 * The instance ids to ask the node for (`cards=`), core's rule: catalogue order then id, so a move never changes the
 * address and a repeat read can be a 304; the fixed two, every instance in the list the node builds, and a pinned card
 * whatever the list says. A type this build doesn't know is never asked. `pinned`: {@link askPinned}.
 *
 * `answer`: the node's answer in hand, if any. With one, a type this node doesn't show ({@link cardOnNode}: Beans, deals,
 * enterprise or Decide on the global node, a feature switched off) is never asked, so the node builds nothing nobody
 * draws (review of #1699, finding 5). With none yet, every type in the list is asked, and the answer says which stay.
 * Find your community is asked as before (by its pin, and wherever the list names it): the node builds it only where
 * its directory is, and keeping it keeps a local member's address what their first read's was, so a return is a 304.
 */
export function cardsToAsk(
    layout: HomeLayout | null, pinned: readonly HomeCardId[] = [], answer?: Pick<HomeAnswer, 'profile' | 'features'> & { cards?: HomeCards } | null,
): string[] {
    return frameCardsToAsk(layout ?? defaultHomeLayout(), pinned).filter(id => {
        const type = listOf(layout).find(l => l.id === id)?.type ?? id;
        return HOME_DRAWN.has(type) && (!answer || type === 'find' || cardOnNode(type, answer));
    });
}

/**
 * The pins to ask by: the account's, from the answer in hand; with none yet, `find` counts as pinned, so it is asked for
 * until an answer says whether it still is (the web app's rule, apps/pwa lib/home-cards.ts `askedCards`).
 */
export function askPinned(answer: Pick<HomeAnswer, 'profile' | 'me'> | null | undefined, now: number): HomeCardId[] {
    return answer ? pinnedCards(answer, now) : ['find'];
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
    /** The reader's role here, for where only admins invite ({@link invitesForReader}); absent: not heard. */
    role?: HomeRole;
    /** The phone remembers a knock this account sent (utils/knock.ts `rememberedKnocks`); absent: not read yet. */
    knocked?: boolean;
    /** The phone's clock, for the 30-day pin; absent: now. */
    now?: number;
    /** The Tips card has a tip to show (@beanpool/core home-tips.ts, from the device's record); absent: none. */
    tipsUp?: boolean;
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

/**
 * A First steps line (§3.1), with what is done. `suggestion`: a line that never holds the card open (the phone can't
 * tick it: a knock is kept on the community knocked on, not here); it goes once the phone remembers a knock.
 */
export interface StepLine { id: 'offer' | 'photo' | 'interests' | 'invite' | 'post' | 'ask'; text: string; done: boolean; suggestion?: true }

/**
 * `canInvite`: whether the reader can invite here ({@link invitesForReader}). The node sends `invited: false` wherever
 * invites are on, whatever its door (routes/home-answer.ts), so where only admins invite a plain member gets no invite
 * line: First steps finishes on the lines they can do.
 */
export function stepLines(steps: NonNullable<HomeCards['steps']>, interestsSet: boolean, canInvite: boolean = true): StepLine[] {
    const lines: StepLine[] = [
        { id: 'offer', text: 'Post your first Offer', done: steps.firstOffer },
        { id: 'photo', text: 'Add a photo to your profile', done: steps.photo },
        { id: 'interests', text: 'Pick a few things you like', done: steps.interests || interestsSet },
    ];
    // After the first Offer, where invites are on (null: no such step here) and the reader can make one.
    if (steps.invited !== null && steps.firstOffer && canInvite) lines.push({ id: 'invite', text: 'Invite someone', done: steps.invited });
    return lines;
}

/** Whether the answer carries a Find your community body the screen can read (its rows are checked as they are drawn). */
export const isFindCard = (v: unknown): v is HomeFind => isObj(v) && Array.isArray(v.communities);

/**
 * A community near enough to be listed, with an https address to knock on (the find card lists the nearest first, §3.1;
 * Communities near you checks each address in full, utils/community-directory.ts `communityOrigin`).
 */
function communityToAsk(find: HomeFind | undefined): boolean {
    return !!find && isFindCard(find) && find.communities.some(c => isObj(c) && typeof c.url === 'string' && /^https:\/\/[^\s/?#@]+/i.test(c.url));
}

/**
 * The First steps lines of the global node (§3.1, §7; the web app's, apps/pwa lib/home-cards.ts `stepLines`): a first
 * post, free or for swap (Beans are off there), and, while a community near has an address and the phone remembers no
 * knock, a suggestion to ask one to let them in, which never holds the card open. The design's "Set your area" is left
 * out, as on the web: no screen on the phone sets the account's area yet, and every line opens a screen.
 */
export function globalStepLines(steps: NonNullable<HomeCards['steps']>, find: HomeFind | undefined, knocked: boolean): StepLine[] {
    const lines: StepLine[] = [{ id: 'post', text: 'Post something free or for swap', done: steps.firstPost }];
    if (!knocked && communityToAsk(find)) lines.push({ id: 'ask', text: 'Ask a community to let you in', done: false, suggestion: true });
    return lines;
}

/**
 * The new-account limits, said before the member meets them (§3.1, §6.2, §7): "For your first 3 days: 3 posts and 10
 * new chats a day." ("7 days: 2 posts and 3 new chats" for a member who came in by 12 words), from the node's own numbers
 * (`me.probation`, read tolerantly: it comes off the network). Nothing when the node sends none or the limits are over.
 */
export function probationSentence(p: HomeProbation | null | undefined): string | null {
    if (!isObj(p) || p.onProbation !== true) return null;
    const whole = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
    const hours = whole(p.endsWhen?.hours);
    const posts = whole(p.limits?.posts?.limit);
    const chats = whole(p.limits?.new_dm_recipients?.limit);
    if (!hours || posts === null || chats === null) return null;
    const span = hours % 24 === 0 ? plural(hours / 24, 'day', 'days') : plural(hours, 'hour', 'hours');
    return `For your first ${span}: ${plural(posts, 'post', 'posts')} and ${plural(chats, 'new chat', 'new chats')} a day.`;
}

/**
 * First steps as this node says it: a local community's lines (H2's, unchanged), or the global node's lines and the
 * new-account limits. `show`: a line it can tick is undone, or (global) the limits still apply.
 */
export function firstSteps(
    answer: HomeAnswer, ctx: Pick<HomeDrawContext, 'interests' | 'role' | 'knocked'>,
): { lines: StepLine[]; note: string | null; show: boolean } {
    const s = answer.cards.steps;
    if (!s) return { lines: [], note: null, show: false };
    if (answer.profile !== 'global') {
        const lines = stepLines(s, ctx.interests.length > 0, invitesForReader(answer.features, ctx.role));
        return { lines, note: null, show: lines.some(l => !l.done) };
    }
    const lines = globalStepLines(s, answer.cards.find, !!ctx.knocked);
    const note = probationSentence(answer.me?.probation);
    return { lines, note, show: lines.some(l => !l.done && !l.suggestion) || note !== null };
}

/**
 * "Near you" (§3.1): on the global node the nearest first, those with no distance after in the order they came; then
 * starred categories first, each part keeping that order (interests reorder, never filter). Elsewhere what's new, starred
 * first, as H2 drew it. The node orders it so too, but the phone's stars can be newer than its answer.
 */
export function marketInOrder<T extends { category: string; distanceKm?: number | null }>(
    items: readonly T[], interests: readonly string[], profile: string, normalise: (c: string) => string = c => c,
): T[] {
    const near = profile === 'global' ? nearestFirst(items) : [...items];
    return starredFirst(near, i => i.category, interests, normalise);
}

function nearestFirst<T extends { distanceKm?: number | null }>(items: readonly T[]): T[] {
    const far = (t: T) => (typeof t.distanceKm === 'number' && Number.isFinite(t.distanceKm) ? t.distanceKm : Infinity);
    return items.map((t, i) => ({ t, i })).sort((a, b) => (far(a.t) - far(b.t)) || (a.i - b.i)).map(x => x.t);
}

/**
 * The cards to draw, top to bottom (§3.2): the member's list in their order (a pinned `find` at the top, drawn
 * defensively by {@link cardOrder}), each card only while it has something to say. A card's body is keyed by its
 * instance id in the answer (`cards[id]`); a one-of-a-kind card's id is its type.
 */
export function cardsToDraw(answer: HomeAnswer, layout: HomeLayout | null, ctx: HomeDrawContext): HomeCardInstance[] {
    const c = answer.cards as Record<string, unknown> & HomeCards;
    const global = answer.profile === 'global';
    const canInvite = invitesForReader(answer.features, ctx.role);
    const pinned = pinnedCards(answer, ctx.now ?? Date.now());
    const shows = ({ id, type }: HomeCardInstance): boolean => {
        if (!cardOnNode(type, answer, ctx.role)) return false;
        switch (type) {
            case 'needs': return ctx.needs !== undefined ? ctx.needs > 0 : !!c.needs?.items?.length;
            case 'safety': return ctx.safetyUp;
            case 'find': return isFindCard(c.find);
            case 'steps': return firstSteps(answer, ctx).show;
            case 'interests': return !!answer.me && (ctx.interests.length === 0 || ctx.tuneOpen);
            // A member's only, never a visitor's; a suspended member still learns the app.
            case 'tips': return !!answer.me && !!ctx.tipsUp;
            case 'invite': return !global && canInvite && !!answer.me?.firstOffer;
            case 'market': return !!c.market && (c.market.items.length > 0 || !!c.market.examples);
            case 'decide': return !!c.decide && decideLines(c.decide, answer.features, 0).length > 0;
            // A settings card is drawn with no body yet (SEARCH_WAITING_LINE until slice F4 draws its listings): the add took.
            case 'search': return true;
            case 'community': return true;
            default: return c[id] !== undefined;
        }
    };
    return cardOrder(layout, pinned).filter(shows);
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
export function mergeNeeds(
    node: readonly HomeNeedsItem[] | null | undefined, local: LocalNeeds | null, now: number, features?: HomeAnswer['features'] | null,
): NeedsYouEntry[] {
    const phoneHas = (kind: NeedsYouKind) => kind === 'message'
        ? !!local?.kinds.has('message')
        : kind === 'deal' && !!local?.entries.some(e => e.kind === 'deal');
    // A vote lands on Commons → Decide: never on a node without it (the node sends none there; this keeps it so).
    const lands = (i: HomeNeedsItem) => i.target.to !== 'decide' || !features || decideOnNode(features);
    const fromNode = (node ?? []).filter(i => !phoneHas(i.kind) && lands(i))
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
    const title = global ? 'The worldwide community' : (card?.name?.trim() || cardName('community'));
    if (!card) return { title, line: '' };
    if (!global && card.members <= 1) {
        return { title, line: invitesOn ? "1 member. You're first. Invite someone." : "1 member. You're first." };
    }
    const parts = [plural(card.members, 'member', 'members').replace(String(card.members), groupThousands(card.members))];
    if (card.tradesThisMonth !== undefined) parts.push(`${plural(card.tradesThisMonth, 'trade', 'trades')} this month`);
    if (card.communities !== undefined) parts.push(`${groupThousands(card.communities)} ${card.communities === 1 ? 'community' : 'communities'} listed`);
    return { title, line: `${parts.join(' · ')}.` };
}

/**
 * The faces and names Who joined may show: a local community's (the members list shows them to members already); on the
 * global node none, whatever an answer holds (§13 Q4: strangers, probation, harvesting; the node sends none there).
 */
export function joinedNames(card: NonNullable<HomeCards['joined']>, profile: string): { callsign: string; avatarUrl: string | null }[] {
    return profile === 'global' ? [] : (card.names ?? []);
}

/** Who joined (§3.1): faces and names on a local community; on the global node a count by area, no names. */
export function joinedLine(card: NonNullable<HomeCards['joined']>, profile: string = 'local'): string {
    const names = joinedNames(card, profile).map(n => n.callsign).filter(Boolean);
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

/**
 * Whether Commons → Decide is there on this node: formal Decisions on, and the Commons tab shown (utils/node-profile.ts
 * `decisionsOn` and `hiddenTabsFor`, said again here so this file stays pure; a test holds the two together). The global
 * node has neither.
 */
export const decideOnNode = (features: HomeAnswer['features']): boolean => features.decisions !== false && features.beans !== false;
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
    if (card.open > 0 && decideOnNode(features)) {
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
    return cardName('market', profile);
}

/** A card's caption: its type's name (fixed words, never member text); the Market's and the community's depend on the node. */
export function cardCaption(type: HomeCardId, answer: Pick<HomeAnswer, 'profile' | 'cards'>): string {
    if (type === 'community') return communityLines(answer.cards.community, answer.profile, false).title;
    return cardName(type, answer.profile);
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
