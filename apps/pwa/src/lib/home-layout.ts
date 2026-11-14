/**
 * Home's card frame on the web (scratch/home/CARD-FRAME-DESIGN-fable.md §1, §2, slice F3): a member's Home is a list of
 * card instances they own, `{ id, type, settings? }`, kept on their account as `home.layout` version 2, with a copy in
 * this browser (lib/home-cache.ts); the newer wins by `updatedAt`. The catalogue is core's registry (@beanpool/core
 * home-frame.ts), one list of types, names, lines and rules for both apps and the node. These are the phone's rules
 * (apps/native utils/home-cards.ts, F2, fixed through two review rounds: scratch/reviews/opus-1699*.md), said again here
 * so this file stays pure and the vitest cases prove them (home-layout.test.ts):
 *
 * - **Add, remove, move, reset**; nothing is dragged. `needs` stays at the top and `community` at the bottom (it carries
 *   Add a card and Arrange): neither is in the list. A card of a type this build doesn't know is kept through every
 *   save, byte for byte, never drawn and never asked for.
 * - **Which copy wins** ({@link pickLayout}): a version-1 account copy never wins over this browser's on a tie, an empty
 *   one never at all, and with no copy here an empty one is unknown (the newcomer's list, marked as this browser's only).
 * - **What is asked** ({@link cardsToAsk}): core's catalogue order then id, filtered by {@link cardOnNode} once an answer
 *   has said what this node shows.
 *
 * An edit's date is this browser's clock, but always after the layout it was made from (the web's own rule, kept from
 * version 1): a browser whose clock runs slow would otherwise stamp an edit before its base and the node would keep the base.
 */

import {
    HOME_CARD_GROUPS, HOME_CARD_TYPES, HOME_FRAME_LIMITS, addCard as frameAddCard, cardsToAsk as frameCardsToAsk, defaultHomeLayout,
    homeCardType, readHomeLayout as frameReadHomeLayout, readSearchSettings, removeCard as frameRemoveCard, resetHomeLayout, starterCards, t, word,
    newInstanceId, readChatSettings,
    knockStillAnswerable, reorderIds, arrivingCards, keepArrivedCard, type LearnHomeOpens,
    type HomeAddRefusal, type HomeCardGroup, type HomeCardInstance, type HomeLayoutV2,
} from '@beanpool/core';
import { drawnToolCardTypes } from '../tools/cards';

export type { HomeCardInstance, HomeLayoutV2 };

/** A card type's id, as core's registry names it (`beans`, `search`, …), or a newer app's that this build doesn't know. */
export type HomeCardType = string;

/** First and last, always: the one card that costs a member something if missed, and the one that holds Arrange. */
export const FIXED_FIRST = 'needs';
export const FIXED_LAST = 'community';
const FIXED: ReadonlySet<string> = new Set([FIXED_FIRST, FIXED_LAST]);

/**
 * The types this build has a body for (pages/HomePage.tsx). A type in the registry but not here is listed nowhere and
 * drawn nowhere; a type in neither is a newer app's, kept and not drawn. With them every tool's card (`tool-<id>`) that
 * this build has a web half for (tools/cards.ts): Home's default branch draws it from the tool's manifest.
 */
export const HOME_DRAWN: ReadonlySet<string> = new Set([
    'needs', 'safety', 'find', 'start', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'shop', 'events', 'market', 'asked', 'learn', 'search', 'decide', 'groups', 'chat',
    'joined', 'pulse', 'sky', 'beans', 'notices', 'invite', 'tools', 'community',
    ...drawnToolCardTypes(),
]);

/**
 * The doors the Learn card may open beyond a page and Learn (core learnHomeLines): To check and the form are slice K4's
 * views, not in LearnPage yet, so "N to check ›" and "Add the first thing…" are not drawn, and Home doesn't send
 * `lands=learn` (the node sends `toCheck` only to an app that does). K4 turns each on with its view. The phone's is the same.
 */
export const LEARN_OPENS: LearnHomeOpens = {};

/** Find your community is pinned for a member's first 30 days on the global node, then it can be removed (§4.1, §7). */
export const FIND_PINNED_DAYS = 30;
const DAY_MS = 86_400_000;

/** What these rules read of the node's answer (lib/home-cards.ts HomeAnswer). */
export interface FrameAnswer {
    profile: string;
    features: { [k: string]: unknown };
    /** `wayBack` (slice D1): core's catalogue keeps Your way back in for a member whose 12 words are the only way back. */
    me?: { joinedAt: string | null; wayBack?: string | null } | null;
    cards?: { [k: string]: unknown };
}

/** The reader's role on this node as the node said it: null for none, undefined not heard. */
export type HomeRole = 'owner' | 'admin' | 'moderator' | null | undefined;

// ── Names ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A type's name: its caption, its row in the picker and its band in Arrange. Fixed words, never a member's: core's word() keys, in
 * the member's language (the phone's utils/home-cards.ts cardName).
 */
/**
 * Welcome's caption (DESIGN-home-default-fable.md §2.3, §5.1): the `start` card's name on the web, on the card, in Add a card
 * and in Arrange. "Getting started" stays the picker group's name. Core's catalogue still says "Getting started" until the
 * phone's slice D2 takes the new caption with its own body (its tests pick the card by that name).
 */
export const WELCOME_WORDS_CAPTION = { caption: word('Welcome') } as const;

export function cardName(type: HomeCardType, profile?: string): string {
    if (type === 'start') return t(WELCOME_WORDS_CAPTION.caption);
    const entry = homeCardType(type);
    if (!entry) return type;
    return profile === 'global' && entry.globalName ? t(entry.globalName) : t(entry.name);
}

/** The most of a saved search's words its screen-reader name carries; longer ones end in "…". */
export const CARD_WORDS_MAX = 24;

/**
 * One card's name for the screen reader: its "…", Arrange's arrows, and the "added" and "removed" lines. A saved
 * search is named by its words, in quotes and bounded, and its kind when it isn't Both (`"eggs"`, `"eggs" (Needs)`), so
 * two of them never sound alike (review of #1699, finding 4; review of #1716); every other card by its type's name.
 * Never the caption: a caption is fixed words, never a member's.
 */
export function cardLabelName(c: Pick<HomeCardInstance, 'type' | 'settings'>, profile?: string): string {
    const words = searchWords(c);
    if (!words) return cardName(c.type, profile);
    const kind = searchKindWord(c);
    return kind ? t('"{words}" ({kind})', { words, kind }) : t('"{words}"', { words });
}

/** A saved search's words, bounded (CARD_WORDS_MAX, then "…"); null for any other card or a search with none. */
function searchWords(c: Pick<HomeCardInstance, 'type' | 'settings'>): string | null {
    if (c.type !== 'search') return null;
    const q = readSearchSettings(c.settings).q.trim().replace(/\s+/g, ' ');
    return q ? (q.length > CARD_WORDS_MAX ? `${q.slice(0, CARD_WORDS_MAX).trimEnd()}…` : q) : null;
}

/** A saved search's kind as its names say it: "Offers" or "Needs" (the sheet's chips), nothing for Both. */
function searchKindWord(c: Pick<HomeCardInstance, 'type' | 'settings'>): string | null {
    const kind = readSearchSettings(c.settings).kind;
    return kind === 'offer' ? t('Offers') : kind === 'need' ? t('Needs') : null;
}

/**
 * One card's name on its band in Arrange: a saved search by its words, and its kind when it isn't Both (`eggs`, `Needs · eggs`),
 * so two searches are two rows even with the same words; else its name.
 */
export function cardRowName(c: Pick<HomeCardInstance, 'type' | 'settings'>, profile?: string): string {
    const words = searchWords(c);
    if (!words) return cardName(c.type, profile);
    const kind = searchKindWord(c);
    // The kind leads, so a long search's row cut at two lines (320dp × 1.3) still shows it (#1716 confirmation, finding 4).
    return kind ? t('{kind} · {words}', { kind, words }) : words;
}

// ── Reading, and which copy wins ──────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A layout from anywhere, read by core (tolerant): version 2 keeps every well-formed instance; version 1 via translateV1. */
export const readLayout = (raw: unknown): HomeLayoutV2 | null => frameReadHomeLayout(raw);

const dateOf = (l: HomeLayoutV2 | null) => (l?.updatedAt ? Date.parse(l.updatedAt) : -Infinity);

/**
 * The account's copy or this browser's, the newer by `updatedAt`. `push`: this browser's is newer, so it is sent (an
 * edit made offline, or one whose save failed). On a tie the account's stands.
 */
export function pickLayout(account: HomeLayoutV2 | null, local: HomeLayoutV2 | null): { layout: HomeLayoutV2 | null; push: boolean } {
    if (!local) return { layout: account, push: false };
    if (!account) return { layout: local, push: true };
    if (dateOf(local) > dateOf(account)) return { layout: local, push: true };
    return { layout: account, push: false };
}

// A 64-bit hash (cyrb53's mixing, both halves kept) as 16 hex characters: a print, not a secret.
function hash64(s: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * A layout's list (its cards, dismissals and the columns chosen, not its date) as a short print: read as core reads any
 * layout, then as JSON with every object's keys sorted, so the list this browser sent and the node's answer of it print
 * alike. A columns change is an edit (W0); a layout that never chose prints as it did before there were columns.
 */
export function layoutPrint(l: HomeLayoutV2): string {
    const read = readLayout(l) ?? l;
    const view = read.view ? { view: read.view } : {};
    return hash64(JSON.stringify({ cards: read.cards, dismissed: read.dismissed ?? {}, ...view }, (_k, v: unknown) => (
        isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v
    )));
}

/** Whether two layouts hold the same list, whatever their dates. */
export const sameList = (a: HomeLayoutV2, b: HomeLayoutV2): boolean => layoutPrint(a) === layoutPrint(b);

/**
 * Whether `find` is pinned for this member: on the global node, in their first 30 days (or while their join date is unknown),
 * and past them for as long as a knock or place watch is open: the pin follows the wait too, so day 31 does not hide the card
 * that says what became of it (Lounge L1, DESIGN-global-lounge-fable.md §0.3, §6 L1).
 */
export function findPinned(
    answer: Pick<FrameAnswer, 'profile' | 'me' | 'cards'>,
    now: number,
    ctx?: { hasOpenKnock?: boolean; hasOpenWatch?: boolean; knocks?: readonly { sentAt?: unknown; cancelledAt?: string; [key: string]: unknown }[] } | boolean,
): boolean {
    if (answer.profile !== 'global') return false;
    const joined = answer.me?.joinedAt ? Date.parse(answer.me.joinedAt) : NaN;
    if (!Number.isFinite(joined) || now - joined < FIND_PINNED_DAYS * DAY_MS) return true;
    const hasOpenKnock = typeof ctx === 'boolean'
        ? ctx
        : Boolean(ctx?.hasOpenKnock ?? (ctx?.knocks ? ctx.knocks.some(k => !k.cancelledAt && knockStillAnswerable(k, now)) : false));
    const findCard = answer.cards?.find as { watches?: unknown[] | null } | undefined;
    const hasOpenWatch = typeof ctx === 'object' && typeof ctx?.hasOpenWatch === 'boolean'
        ? ctx.hasOpenWatch
        : Boolean(findCard?.watches && findCard.watches.length > 0);
    return hasOpenKnock || hasOpenWatch;
}

/** The cards pinned for this reader now: they can't be removed or moved, and stand at the top (only `find` has a pin). */
export function pinnedCards(
    answer: Pick<FrameAnswer, 'profile' | 'me' | 'cards'> | null | undefined,
    now: number,
    ctx?: { hasOpenKnock?: boolean; hasOpenWatch?: boolean; knocks?: readonly { sentAt?: unknown; cancelledAt?: string; [key: string]: unknown }[] } | boolean,
): string[] {
    return answer && findPinned(answer, now, ctx) ? ['find'] : [];
}

/** The pins to ask by: the answer's; with none yet, `find` counts as pinned, so it is asked until an answer says. */
export function askPinned(
    answer: Pick<FrameAnswer, 'profile' | 'me' | 'cards'> | null | undefined,
    now: number,
    ctx?: { hasOpenKnock?: boolean; hasOpenWatch?: boolean; knocks?: readonly { sentAt?: unknown; cancelledAt?: string; [key: string]: unknown }[] } | boolean,
): string[] {
    return answer ? pinnedCards(answer, now, ctx) : ['find'];
}

/** The starter set as a Home never saved (DESIGN-getting-started-fable.md §1): after the tour, for a visitor, after Reset. */
export const STARTER_LAYOUT: HomeLayoutV2 = { v: 2, cards: starterCards(), dismissed: {}, updatedAt: null };

/** The list a layout holds: the member's, or the newcomer's while there is none. */
export const listOf = (layout: HomeLayoutV2 | null): HomeCardInstance[] => layout?.cards ?? defaultHomeLayout().cards;

/**
 * The cards that arrive on this Home (core `arrivingCards`, DESIGN-local-knowledge-amend-fable.md §3.6, slice K7) that this
 * build draws: drawn once, after the member's own cards, until Keep on Home, Remove or a move writes their stamp.
 */
export const arrivingOn = (layout: HomeLayoutV2 | null): HomeCardInstance[] => arrivingCards(layout).filter(c => HOME_DRAWN.has(c.type));
/** Whether this card is drawn as arriving: on Home, not yet on the member's list. */
export const isArrivingCard = (layout: HomeLayoutV2 | null, id: string): boolean => arrivingOn(layout).some(c => c.id === id);

/**
 * The cards in the member's order, drawn defensively (review of #1697, note c: only core's `addCard` keeps the limits, so
 * a stored list may hold anything): `needs` first, the list's cards of a type this build draws (a one-of-a-kind type
 * once, an instance type up to its limit, the fixed two never from the list), `community` last. A pinned `find` stands
 * right under `needs` (and under "Your way back in" while that one leads), whatever the list says.
 */
export function cardOrder(layout: HomeLayoutV2 | null, pinned: readonly string[] = []): HomeCardInstance[] {
    const count = new Map<string, number>();
    const placed: HomeCardInstance[] = [];
    for (const c of [...listOf(layout), ...arrivingOn(layout)]) {
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
export const canRemoveCard = (type: HomeCardType, pinned: readonly string[] = []): boolean => !FIXED.has(type) && !pinned.includes(type);
/** Whether a card can be moved: the same cards; `needs` stays first, a pinned card under it, and `community` last. */
export const canMoveCard = canRemoveCard;

/**
 * The cards Arrange folds, in `order` (DESIGN-home-layout-fable.md §3.2): whatever is drawn now, and every other card on
 * the list that this node can show, so a card with nothing to say can still be moved, set up or removed.
 */
export function arrangeCards(
    order: readonly HomeCardInstance[], drawn: readonly Pick<HomeCardInstance, 'id'>[], onNode: (type: HomeCardType) => boolean, pinned: readonly string[] = [],
): HomeCardInstance[] {
    return order.filter(c => drawn.some(d => d.id === c.id) || (canMoveCard(c.type, pinned) && onNode(c.type)));
}

/** A card's one line when it is folded: the catalogue's. */
export const cardLine = (type: HomeCardType): string => {
    const entry = homeCardType(type);
    return entry ? t(entry.line) : '';
};

// ── The member's edits ────────────────────────────────────────────────────────────────────────────────────────────

/** An edit's moment: this browser's clock, but always after the layout it was made from. */
const editAt = (base: HomeLayoutV2 | null, now: number): number => Math.max(now, base?.updatedAt ? Date.parse(base.updatedAt) + 1 : -Infinity);
const iso = (at: number) => new Date(at).toISOString();

/**
 * A card added (§1.3): first, under Needs you and a pinned card; its settings through its type's reader. Refused (with
 * core's reason) when it can't be: one already there, the type's limit, a full Home, a type this build can't draw.
 */
export function addCard(
    layout: HomeLayoutV2 | null, type: HomeCardType, now: number, opts: { settings?: unknown; pinned?: readonly string[]; random?: () => number } = {},
): { ok: true; layout: HomeLayoutV2; id: string } | { ok: false; refused: HomeAddRefusal } {
    if (!HOME_DRAWN.has(type)) return { ok: false, refused: 'unknown' };
    return frameAddCard(layout ?? defaultHomeLayout(), type, { settings: opts.settings, pinned: opts.pinned, now: editAt(layout, now), random: opts.random });
}

/**
 * A card taken off Home: the instance goes, its settings and any dismissal with it (§1.3). A card drawn as arriving leaves
 * only its stamp (core `removeCard`), so it never arrives again. Null when it can't be.
 */
export function removeCard(layout: HomeLayoutV2 | null, id: string, now: number, pinned: readonly string[] = []): HomeLayoutV2 | null {
    const card = listOf(layout).find(c => c.id === id) ?? arrivingOn(layout).find(c => c.id === id);
    if (!card || !canRemoveCard(card.type, pinned)) return null;
    return frameRemoveCard(layout, id, editAt(layout, now));
}

/** "Keep on Home" on a card drawn as arriving: last on the list, its stamp written, in one save. Null when it isn't arriving. */
export function keepCard(layout: HomeLayoutV2 | null, id: string, now: number): HomeLayoutV2 | null {
    return isArrivingCard(layout, id) ? keepArrivedCard(layout, id, editAt(layout, now)) : null;
}

/** The cards Arrange moves: those of `among` that move and stand on the list, and those drawn as arriving (slice K7). */
const movableOf = <T extends Pick<HomeCardInstance, 'id' | 'type'>>(layout: HomeLayoutV2 | null, among: readonly T[], pinned: readonly string[]): T[] => {
    const list = listOf(layout);
    return among.filter(c => canMoveCard(c.type, pinned) && (list.some(l => l.id === c.id) || isArrivingCard(layout, c.id)));
};

/**
 * A move that reaches a card drawn as arriving keeps it first (core `keepArrivedCard`: on the list, its stamp written), so the
 * move has a place on the list for it and writes its stamp, as core's own move does (review of #3154). `reached` is the card
 * moved and every card whose place the move changes; each arriving one among them is kept, with any drawn before it, in the
 * order Home draws them, so the list holds them in the order shown. Null when the move reaches none.
 */
function keepReached(layout: HomeLayoutV2 | null, id: string, movable: readonly Pick<HomeCardInstance, 'id'>[], reached: readonly string[], now: number): HomeLayoutV2 | null {
    const drawn = arrivingOn(layout).filter(c => c.id === id || movable.some(m => m.id === c.id));
    const last = drawn.reduce((upTo, c, k) => (reached.includes(c.id) ? k : upTo), -1);
    let kept: HomeLayoutV2 | null = null;
    for (const c of drawn.slice(0, last + 1)) kept = keepArrivedCard(kept ?? layout, c.id, editAt(layout, now));
    return kept;
}

/** A card's settings changed in place (Settings… → Save): it keeps its place. Null when it isn't there or has none. */
export function changeCardSettings(layout: HomeLayoutV2 | null, id: string, settings: unknown, now: number): HomeLayoutV2 | null {
    const list = listOf(layout);
    const i = list.findIndex(c => c.id === id);
    const reader = i < 0 ? undefined : homeCardType(list[i].type)?.readSettings;
    if (!reader) return null;
    const cards = [...list];
    const next = reader(settings);
    // A chat card picked again for another chat takes a new id in the same place (DESIGN-home-chosen-chat-fable.md §2, the
    // phone's rule): the node's answer is keyed by the card's id and names no chat, so a kept answer for the old id is never
    // drawn as the new chat's lines, offline or before the node answers.
    const repicked = list[i].type === 'chat' && readChatSettings(list[i].settings).conversationId !== (next as { conversationId?: unknown }).conversationId;
    const newId = repicked ? newInstanceId('chat', new Set(list.map(c => c.id))) : list[i].id;
    cards[i] = { ...cards[i], id: newId, settings: next };
    return { ...(layout ?? defaultHomeLayout()), cards, updatedAt: iso(editAt(layout, now)) };
}

/**
 * Up or down past the card next to it in `among` (every card Arrange folds), so a move always shows. Every other card keeps its place in the list. Null when it can't move that way;
 * a card drawn as arriving is kept first (on the list, stamped), whether it is the one moved or the one passed, so even a move
 * of it that can't go further saves that.
 */
export function moveCard(
    layout: HomeLayoutV2 | null, id: string, dir: 'up' | 'down', among: readonly Pick<HomeCardInstance, 'id' | 'type'>[], now: number,
    pinned: readonly string[] = [],
): HomeLayoutV2 | null {
    const movable = movableOf(layout, among, pinned);
    const from = movable.findIndex(c => c.id === id);
    const other = from < 0 ? undefined : movable[dir === 'up' ? from - 1 : from + 1];
    const kept = keepReached(layout, id, movable, other ? [id, other.id] : [id], now);
    const base = kept ?? layout;
    const cards = [...listOf(base)];
    const i = cards.findIndex(c => c.id === id);
    const j = other ? cards.findIndex(c => c.id === other.id) : -1;
    if (i < 0 || j < 0) return kept;
    [cards[i], cards[j]] = [cards[j], cards[i]];
    return { ...(base ?? defaultHomeLayout()), cards, updatedAt: iso(editAt(layout, now)) };
}

/**
 * `items` with the movable card `id` brought to place `to` among the movable ones (a drag's live preview and its drop).
 * Every card that can't move, and every slot it stands in, stays where it is.
 */
export function reorderAmong<T extends Pick<HomeCardInstance, 'id' | 'type'>>(items: readonly T[], id: string, to: number, pinned: readonly string[] = []): T[] {
    return reorderIds(items, items.filter(c => canMoveCard(c.type, pinned)).map(c => c.id), id, to);
}

/**
 * A drag's drop (L3): the card to place `to` among the movable cards of `among` (every card Arrange folds), saved as the
 * same list an arrow makes, in the slots those cards already hold. Null when it would not move. `to` counts the cards drawn
 * as arriving too, as the drag's preview does; each one the drop moves is kept first (on the list, stamped).
 */
export function moveCardTo(
    layout: HomeLayoutV2 | null, id: string, to: number, among: readonly Pick<HomeCardInstance, 'id' | 'type'>[], now: number,
    pinned: readonly string[] = [],
): HomeLayoutV2 | null {
    const movable = movableOf(layout, among, pinned);
    const placed = reorderAmong(movable, id, to, pinned);
    const kept = keepReached(layout, id, movable, [id, ...movable.filter((c, k) => placed[k].id !== c.id).map(c => c.id)], now);
    if (placed.every((c, k) => c.id === movable[k].id)) return kept;
    const base = kept ?? layout;
    const list = listOf(base);
    // The cards now on the list, before and after: an arriving card the drop doesn't reach stays drawn after them, unmoved.
    const onList = (c: Pick<HomeCardInstance, 'id'>) => list.some(l => l.id === c.id);
    const from = movable.filter(onList);
    const order = placed.filter(onList);
    const slots = from.map(c => list.findIndex(l => l.id === c.id)).sort((x, y) => x - y);
    const cards = [...list];
    slots.forEach((slot, k) => { cards[slot] = list.find(l => l.id === order[k].id)!; });
    return { ...(base ?? defaultHomeLayout()), cards, updatedAt: iso(editAt(layout, now)) };
}

/**
 * Reset to defaults (core `resetHomeLayout`, DESIGN-home-default-fable.md §3): the default list less Welcome, then the
 * cards the member made (saved searches, chats, Your tools, tool cards, and a newer app's types) in their order. A
 * schedule's dismissal (the `safety` card) and the columns chosen (W0) are kept: neither is a card.
 */
export const resetLayout = (layout: HomeLayoutV2 | null, now: number): HomeLayoutV2 => resetHomeLayout(layout, editAt(layout, now));

/**
 * Reset's Undo (DESIGN-home-default-fable.md §3, "Home is back to how it started. Undo"): the list as it was before the
 * reset, stamped after the reset's own write so it wins on the account and in this browser alike.
 */
export const undoResetLayout = (before: HomeLayoutV2, current: HomeLayoutV2 | null, now: number): HomeLayoutV2 =>
    ({ ...before, updatedAt: iso(editAt(current, now)) });

/** Said once Reset has put the default list back, with Undo beside it. */
export const RESET_DONE_LINE = word('Home is back to how it started.');

/** The `safety` card was put away: when, on the account too. */
export function dismissSafety(layout: HomeLayoutV2 | null, now: number): HomeLayoutV2 {
    const l = layout ?? defaultHomeLayout();
    const at = iso(editAt(layout, now));
    return { ...l, dismissed: { ...l.dismissed, safety: at }, updatedAt: at };
}

/** These two are word() keys: Home shows them through t(). */
/** The one-time hint (§1.3), as the web says it: its cards can be dragged (DESIGN-home-arrange-in-place-fable.md §2.9). The phone's own line says "hold a card to arrange" until its drag lands. */
export const HOME_HINT_LINE = word('This is your Home. Add a card at the bottom. Hold a card to drag it, or use the arrows.');
/** A saved search's body before the node has answered for these words: added or changed offline (CARD-FRAME §2.4). */
export const SEARCH_OFFLINE_LINE = word('Shows when your community answers');

/** A saved search's first line: the words and the distance ("eggs · within 5 km"); just the words with no point. */
export function searchFirstLine(q: string, km: number | null): string {
    const words = q.trim().replace(/\s+/g, ' ') || t('Every listing');
    // "within 5 km", or nothing where the node had no point (it ignored the distance). The phone's sentences.
    return km ? t('{words} · within {km} km', { words, km }) : words;
}

/** A search that finds nothing says so in its own words: "No eggs within 5 km right now". */
export function searchEmptyLine(q: string, km: number | null): string {
    const words = q.trim().replace(/\s+/g, ' ');
    if (words) return km ? t('No {words} within {km} km right now', { words, km }) : t('No {words} right now', { words });
    return km ? t('No listings within {km} km right now', { km }) : t('No listings right now');
}

// ── The picker (§1.2) ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PickerRow {
    type: HomeCardType;
    name: string;
    line: string;
    /** `add`: an Add button; `on-home`: a one-of-a-kind already there; `full`: an instance type at its limit, or a full Home. */
    state: 'add' | 'on-home' | 'full';
    /** "2 of 5 on Home", for an instance type with one there. */
    count: string | null;
    /** A type's own state line ("All tips seen"). */
    status: string | null;
    hasSettings: boolean;
}

export interface PickerGroup { id: HomeCardGroup; name: string; rows: PickerRow[] }

/**
 * Whether a node of this kind can show the card to this reader: core's one rule (`onNode`, per type), and only for a
 * type this build draws. Home draws only these, the picker lists only these, and cardsToAsk asks only these.
 */
export function cardOnNode(type: HomeCardType, answer: Pick<FrameAnswer, 'profile' | 'features' | 'cards' | 'me'>, role?: HomeRole): boolean {
    const t = homeCardType(type);
    // `me` too: Your way back in is on any node for a member whose 12 words are the only way back (review of #3114, finding 1).
    return !!t && HOME_DRAWN.has(type) && t.onNode({ profile: answer.profile, features: answer.features, cards: answer.cards, me: answer.me }, role);
}

/**
 * The picker's groups (For you · Around you · Getting started), each type this node can show and this build can draw,
 * in the catalogue's order. Never a type that isn't here, never one shown as locked. A pinned `find` is on Home already
 * and not listed. `full`: Home holds 24 cards, so every Add goes.
 */
export function pickerGroups(
    answer: Pick<FrameAnswer, 'profile' | 'features' | 'cards' | 'me'>, layout: HomeLayoutV2 | null, role: HomeRole,
    pinned: readonly string[] = [], status: Partial<Record<string, string>> = {},
): { groups: PickerGroup[]; full: boolean } {
    const list = listOf(layout);
    const full = list.length >= HOME_FRAME_LIMITS.cards;
    const groups = HOME_CARD_GROUPS.map(g => ({ id: g.id, name: t(g.name), rows: [] as PickerRow[] }));
    for (const entry of HOME_CARD_TYPES) {
        if (entry.fixed || !HOME_DRAWN.has(entry.id) || pinned.includes(entry.id) || !cardOnNode(entry.id, answer, role)) continue;
        const n = list.filter(c => c.type === entry.id).length;
        const max = entry.multiple?.max ?? 1;
        const state: PickerRow['state'] = !entry.multiple && n > 0 ? 'on-home' : n >= max ? 'full' : 'add';
        groups.find(g => g.id === entry.group)!.rows.push({
            type: entry.id,
            name: cardName(entry.id, answer.profile),
            line: t(entry.line),
            state: full && state === 'add' ? 'full' : state,
            count: entry.multiple && n > 0 ? t('{n} of {max} on Home', { n: Math.min(n, max), max }) : null,
            status: status[entry.id] ?? null,
            hasSettings: !!entry.readSettings && entry.id !== 'tools',
        });
    }
    return { groups: groups.filter(g => g.rows.length > 0), full };
}

/** What the live line says when a card is added or removed (§1.3), in the member's language (the phone's words). */
export const addedLine = (name: string) => t('{card} added to Home', { card: name });
export const removedLine = (name: string) => t('{card} removed. Add a card brings it back.', { card: name });

// ── What is asked ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The instance ids to ask the node for (`cards=`), core's rule: catalogue order then id, so a move never changes the
 * address and a repeat read can be a 304; the fixed two, every instance in the list the node builds, and a pinned card
 * whatever the list says. A type this build doesn't know is never asked. With an answer in hand, a type this node
 * doesn't show ({@link cardOnNode}) is never asked either (review of #1699, finding 5); Find your community is asked as
 * before, so a local member's address stays what their first read's was.
 */
export function cardsToAsk(
    layout: HomeLayoutV2 | null, pinned: readonly string[] = [], answer?: Pick<FrameAnswer, 'profile' | 'features' | 'cards' | 'me'> | null,
): string[] {
    // A Home never saved is the default list (DESIGN-home-default-fable.md §2.2), asked in the one first read. Before the node
    // has answered, the app can't tell which of them it shows: the node builds none it doesn't (routes/home-answer.ts
    // `shownHere`), and once an answer is in hand only those it shows are asked (review of #1699, finding 5).
    const base = layout ?? defaultHomeLayout();
    return frameCardsToAsk(base, pinned).filter(id => {
        const type = base.cards.find(l => l.id === id)?.type ?? id;
        return HOME_DRAWN.has(type) && (!answer || type === 'find' || cardOnNode(type, answer));
    });
}

// ── The columns on a wide screen (DESIGN-home-wide-and-content-fable.md D1, slice W2) ─────────────────────────────

/** A column is never narrower than the phone's floor, which every card's body is proven at (320 dp × 1.3)… */
export const HOME_COLUMN_MIN = 320;
/**
 * …nor wider than 576 px (D1): the old one column's box (`max-w-xl`), not its cards, which were 544 px inside the box's
 * 16 px gutters, as the App.tsx banners above Home still are. So one column on a page over 576 px (a 577–687 px window,
 * or 833–943 px with the sidebar) is up to 32 px wider than before (review of #2411).
 */
export const HOME_COLUMN_MAX = 576;
export const HOME_COLUMN_GAP = 16;

/**
 * How many columns the cards stand in on a page `width` px wide inside its gutters: as many as fit at 320 px or more,
 * up to `most` (Auto is three), so two from 656 px and three from 992 px. The page's width, never the window's: the
 * sidebar takes 256 px of it from 768 px. Not measured yet, or measured as nothing: one, as a phone draws it.
 */
export function columnsFor(width: number, most = 3): number {
    if (!Number.isFinite(width)) return 1;
    return Math.max(1, Math.min(most, Math.floor((width + HOME_COLUMN_GAP) / (HOME_COLUMN_MIN + HOME_COLUMN_GAP))));
}

/** The widest the grid of `cols` columns is drawn, gaps included: what the notes and the Join card above it line up with. */
export const gridWidth = (cols: number) => cols * HOME_COLUMN_MAX + (cols - 1) * HOME_COLUMN_GAP;

// ── Packing by height (DESIGN-home-layout-fable.md §3.1, slice L1) ───────────────────────────────────

// The packing itself, and where a carried card lands, are core's (home-place.ts): both apps place by the same rules.
export { HOME_PACK_ROW_GAP, HOME_PACK_ROW_HEIGHT, packHome, placeLifted, placedBoxes, reorderIds, type PackableCard, type PackedCard, type PlaceBox, type PlaceItem } from '@beanpool/core';

/**
 * What Home keeps of one card's height. `packHome` places a card by the cards before it only, so a card's own height can't
 * move it; the one way round is the page itself: a taller page brings the scrollbar, the scrollbar narrows every card, a
 * card crossing `wide` changes height, and the page changes back. `settleHeights` is what stops that going round.
 */
export interface PackHeight {
    height: number;
    /** The last time this card reported a new height, landed or refused. */
    at: number;
    rising: boolean;
    /** Turns from growing to shrinking or back, each within `HOME_PACK_FLIP_MS` of the last change. */
    flips: number;
}

/** Quicker than a person opens and closes a card; the loop itself turned every 33 ms in Chromium (PR #2748). */
export const HOME_PACK_FLIP_MS = 250;
/** Turns before a card counts as going round. */
export const HOME_PACK_MAX_FLIPS = 4;

/**
 * The heights to pack from, given heights just measured. Returns `was` itself when nothing changed, so React renders
 * nothing. Growing always lands, since a stale short height overlaps the next card. A card past `HOME_PACK_MAX_FLIPS`
 * stops shrinking until it has been still for `HOME_PACK_FLIP_MS`: the taller height holds, the grid's height stops
 * changing, and the scrollbar with it. The worst left behind is a small gap, never an overlap and never a flicker.
 */
export function settleHeights(was: Readonly<Record<string, PackHeight>>, seen: Readonly<Record<string, number>>, now: number): Readonly<Record<string, PackHeight>> {
    let next: Record<string, PackHeight> | null = null;
    for (const [id, height] of Object.entries(seen)) {
        if (!(height > 0)) continue;
        const had = was[id];
        if (had?.height === height) continue;
        const rising = !had || height > had.height;
        const quick = !!had && now - had.at < HOME_PACK_FLIP_MS;
        const flips = !quick ? 0 : had.flips + (rising === had.rising ? 0 : 1);
        next ??= { ...was };
        // A refused shrink changes nothing on the screen; it only keeps the clock on the card, which has not been still.
        next[id] = !rising && flips > HOME_PACK_MAX_FLIPS ? { ...had, at: now } : { height, at: now, rising, flips };
    }
    return next ?? was;
}
