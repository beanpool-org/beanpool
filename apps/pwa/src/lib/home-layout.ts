/**
 * Home's card frame on the web (scratch/home/CARD-FRAME-DESIGN-fable.md §1, §2, slice F3): a member's Home is a list of
 * card instances they own, `{ id, type, settings? }`, kept on their account as `home.layout` version 2, with a copy in
 * this browser (lib/home-cache.ts); the newer wins by `updatedAt`. The catalogue is core's registry (@beanpool/core
 * home-frame.ts), one list of types, names, lines and rules for both apps and the node. These are the phone's rules
 * (apps/native utils/home-cards.ts, F2, fixed through two review rounds: scratch/reviews/opus-1699*.md), said again here
 * so this file stays pure and the vitest cases prove them (home-layout.test.ts):
 *
 * - **Add, remove, move, reset**; nothing is dragged. `needs` stays at the top and `community` at the bottom (it carries
 *   Add a card and Edit home): neither is in the list. A card of a type this build doesn't know is kept through every
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
    homeCardType, readHomeLayout as frameReadHomeLayout, readSearchSettings, removeCard as frameRemoveCard,
    type HomeAddRefusal, type HomeCardGroup, type HomeCardInstance, type HomeLayoutV2,
} from '@beanpool/core';

export type { HomeCardInstance, HomeLayoutV2 };

/** A card type's id, as core's registry names it (`beans`, `search`, …), or a newer app's that this build doesn't know. */
export type HomeCardType = string;

/** First and last, always: the one card that costs a member something if missed, and the one that holds Edit home. */
export const FIXED_FIRST = 'needs';
export const FIXED_LAST = 'community';
const FIXED: ReadonlySet<string> = new Set([FIXED_FIRST, FIXED_LAST]);

/**
 * The types this build has a body for (pages/HomePage.tsx). A type in the registry but not here is listed nowhere and
 * drawn nowhere; a type in neither is a newer app's, kept and not drawn.
 */
export const HOME_DRAWN: ReadonlySet<string> = new Set([
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'search', 'decide', 'groups',
    'joined', 'pulse', 'sky', 'beans', 'notices', 'invite', 'community',
]);

/** Find your community is pinned for a member's first 30 days on the global node, then it can be removed (§4.1, §7). */
export const FIND_PINNED_DAYS = 30;
const DAY_MS = 86_400_000;

/** What these rules read of the node's answer (lib/home-cards.ts HomeAnswer). */
export interface FrameAnswer {
    profile: string;
    features: { [k: string]: unknown };
    me?: { joinedAt: string | null } | null;
    cards?: { [k: string]: unknown };
}

/** The reader's role on this node as the node said it: null for none, undefined not heard. */
export type HomeRole = 'owner' | 'admin' | 'moderator' | null | undefined;

// ── Names ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A type's name: its caption, its row in the picker and Edit home. Fixed words, never a member's. */
export function cardName(type: HomeCardType, profile?: string): string {
    const t = homeCardType(type);
    if (!t) return type;
    return profile === 'global' && t.globalName ? t.globalName : t.name;
}

/** The most of a saved search's words its screen-reader name carries; longer ones end in "…". */
export const CARD_WORDS_MAX = 24;

/**
 * One card's name for the screen reader: its "…" and Edit home's labels, and the "added" and "removed" lines. A saved
 * search is named by its words, in quotes and bounded, and its kind when it isn't Both (`"eggs"`, `"eggs" (Needs)`), so
 * two of them never sound alike (review of #1699, finding 4; review of #1716); every other card by its type's name.
 * Never the caption: a caption is fixed words, never a member's.
 */
export function cardLabelName(c: Pick<HomeCardInstance, 'type' | 'settings'>, profile?: string): string {
    const words = searchWords(c);
    if (!words) return cardName(c.type, profile);
    const kind = searchKindWord(c);
    return kind ? `"${words}" (${kind})` : `"${words}"`;
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
    return kind === 'offer' ? 'Offers' : kind === 'need' ? 'Needs' : null;
}

/**
 * One card's row name in Edit home: a saved search by its words, and its kind when it isn't Both (`eggs`, `Needs · eggs`),
 * so two searches are two rows even with the same words; else its name.
 */
export function cardRowName(c: Pick<HomeCardInstance, 'type' | 'settings'>, profile?: string): string {
    const words = searchWords(c);
    if (!words) return cardName(c.type, profile);
    const kind = searchKindWord(c);
    // The kind leads, so a long search's row cut at two lines (320dp × 1.3) still shows it (#1716 confirmation, finding 4).
    return kind ? `${kind} · ${words}` : words;
}

// ── Reading, and which copy wins ──────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A layout from anywhere, read by core (tolerant): version 2 keeps every well-formed instance; version 1 via translateV1. */
export const readLayout = (raw: unknown): HomeLayoutV2 | null => frameReadHomeLayout(raw);

/**
 * Whether a stored or answered value is a version-1 layout, and whether it named anything. Undefined for any other.
 * `empty`: it named no order and nothing hidden, as a not-yet-updated standby answers a version-2 row (review of #1697,
 * note b), so it says nothing of the member's choice.
 */
export function layoutV1Of(raw: unknown): { empty: boolean } | undefined {
    if (!isObj(raw)) return undefined;
    const v1 = raw.v === 1 || (raw.v === undefined && (Array.isArray(raw.order) || Array.isArray(raw.hidden)));
    if (!v1) return undefined;
    const named = (l: unknown) => Array.isArray(l) && l.length > 0;
    return { empty: !named(raw.order) && !named(raw.hidden) };
}

const dateOf = (l: HomeLayoutV2 | null) => (l?.updatedAt ? Date.parse(l.updatedAt) : -Infinity);

/**
 * The account's copy or this browser's, the newer by `updatedAt`. `push`: this browser's is newer, so it is sent (an
 * edit made offline, or one whose save failed).
 *
 * A version-1 account copy (`accountV1`) never wins over this browser's on a tie, and an empty one never wins at all: a
 * not-yet-updated standby answers a version-2 row as an empty version-1 layout dated exactly like it (review of #1697,
 * note b). This browser's is drawn and not sent.
 *
 * With no copy here, an empty version-1 account copy is unknown, not "every version-1 card": the newcomer's list is drawn
 * (with the account's dismissal), and an edit made on it is this browser's only. `localOnlyOver` marks such a list with
 * that empty list's date: a version-2 answer dated at or after it is the account's real list (the primary back from a
 * standby) and wins over the edit, never the reverse (review of #1699, finding 2).
 */
export function pickLayout(
    account: HomeLayoutV2 | null, local: HomeLayoutV2 | null, accountV1?: { empty: boolean }, localOnlyOver?: string | null,
): { layout: HomeLayoutV2 | null; push: boolean } {
    if (!local) {
        if (accountV1?.empty) return { layout: { ...defaultHomeLayout(), dismissed: account?.dismissed ?? {} }, push: false };
        return { layout: account, push: false };
    }
    if (!account) return { layout: local, push: true };
    if (localOnlyOver != null && !accountV1 && dateOf(account) >= (localOnlyOver ? Date.parse(localOnlyOver) : -Infinity)) {
        return { layout: account, push: false };
    }
    if (dateOf(local) > dateOf(account)) return { layout: local, push: true };
    if (accountV1 && (accountV1.empty || dateOf(local) === dateOf(account))) return { layout: local, push: false };
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
 * A layout's list (its cards and dismissals, not its date) as a short print: read as core reads any layout, then as JSON
 * with every object's keys sorted, so the list this browser sent and the node's answer of it print alike.
 */
export function layoutPrint(l: HomeLayoutV2): string {
    const read = readLayout(l) ?? l;
    return hash64(JSON.stringify({ cards: read.cards, dismissed: read.dismissed ?? {} }, (_k, v: unknown) => (
        isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v
    )));
}

/** Whether two layouts hold the same list, whatever their dates. */
export const sameList = (a: HomeLayoutV2, b: HomeLayoutV2): boolean => layoutPrint(a) === layoutPrint(b);

/** The most marked edits this browser remembers having sent (the latest ones). */
export const MARK_SENT_MAX = 8;

/** A marked edit this browser sent: its date and its list's {@link layoutPrint}. One kept by an older build has no print. */
export interface MarkSent {
    at: string;
    print?: string;
}

/**
 * Whether a version-2 account answer is this browser's own save of an edit made on the unknown list, one it sent while
 * marked (`sent`): dated exactly as sent, or the same list dated at or before it. The node holds a date ahead of its own
 * clock to its now, so a browser whose clock runs ahead gets its save back dated earlier than it sent it, never later
 * (review of #1715, finding 1). Then the account's list is known, and it is this browser's: the mark goes and the dates
 * decide as usual, so a newer edit made while that save was out wins and is sent. Without this, a read that overtook the
 * save's answer carried the save back as "the account's real list" and the newer edit was lost unsent (review of #1701
 * confirmation, finding 2). Another device's list matches only if it is this same list, and then nothing is lost.
 */
export function ownMarkedSave(account: HomeLayoutV2 | null, accountV1: { empty: boolean } | undefined, sent: readonly MarkSent[]): boolean {
    if (!account?.updatedAt || accountV1) return false;
    const at = Date.parse(account.updatedAt);
    let print: string | undefined;
    return sent.some(s => s.at === account.updatedAt || (!!s.print && at <= Date.parse(s.at) && s.print === (print ??= layoutPrint(account))));
}

/** `sent` with one more marked edit sent, the latest {@link MARK_SENT_MAX} kept. */
export function rememberMarkSent(sent: readonly MarkSent[], l: HomeLayoutV2): MarkSent[] {
    if (!l.updatedAt) return [...sent];
    return [...sent.filter(s => s.at !== l.updatedAt), { at: l.updatedAt, print: layoutPrint(l) }].slice(-MARK_SENT_MAX);
}

/** The marked edits sent, as kept: a date alone (an older build's) or with its print; anything else is dropped. */
export function readMarkSent(raw: unknown): MarkSent[] {
    if (!Array.isArray(raw)) return [];
    const out: MarkSent[] = [];
    for (const x of raw) {
        if (typeof x === 'string') {
            if (x.length <= 40) out.push({ at: x });
        } else if (isObj(x) && typeof x.at === 'string' && x.at.length <= 40) {
            out.push(typeof x.print === 'string' && /^[0-9a-f]{16}$/.test(x.print) ? { at: x.at, print: x.print } : { at: x.at });
        }
    }
    return out.slice(-MARK_SENT_MAX);
}

/** Whether `find` is pinned for this member: on the global node, in their first 30 days (or while their join date is unknown). */
export function findPinned(answer: Pick<FrameAnswer, 'profile' | 'me'>, now: number): boolean {
    if (answer.profile !== 'global') return false;
    const joined = answer.me?.joinedAt ? Date.parse(answer.me.joinedAt) : NaN;
    return !Number.isFinite(joined) || now - joined < FIND_PINNED_DAYS * DAY_MS;
}

/** The cards pinned for this reader now: they can't be removed or moved, and stand at the top (only `find` has a pin). */
export function pinnedCards(answer: Pick<FrameAnswer, 'profile' | 'me'> | null | undefined, now: number): string[] {
    return answer && findPinned(answer, now) ? ['find'] : [];
}

/** The pins to ask by: the answer's; with none yet, `find` counts as pinned, so it is asked until an answer says. */
export function askPinned(answer: Pick<FrameAnswer, 'profile' | 'me'> | null | undefined, now: number): string[] {
    return answer ? pinnedCards(answer, now) : ['find'];
}

/** The list a layout holds: the member's, or the newcomer's while there is none. */
export const listOf = (layout: HomeLayoutV2 | null): HomeCardInstance[] => layout?.cards ?? defaultHomeLayout().cards;

/**
 * The cards in the member's order, drawn defensively (review of #1697, note c: only core's `addCard` keeps the limits, so
 * a stored list may hold anything): `needs` first, the list's cards of a type this build draws (a one-of-a-kind type
 * once, an instance type up to its limit, the fixed two never from the list), `community` last. A pinned `find` stands
 * right under `needs` (and under "Your way back in" while that one leads), whatever the list says.
 */
export function cardOrder(layout: HomeLayoutV2 | null, pinned: readonly string[] = []): HomeCardInstance[] {
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
export const canRemoveCard = (type: HomeCardType, pinned: readonly string[] = []): boolean => !FIXED.has(type) && !pinned.includes(type);
/** Whether a card can be moved: the same cards; `needs` stays first, a pinned card under it, and `community` last. */
export const canMoveCard = canRemoveCard;

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

/** A card taken off Home: the instance goes, its settings and any dismissal with it (§1.3). Null when it can't be. */
export function removeCard(layout: HomeLayoutV2 | null, id: string, now: number, pinned: readonly string[] = []): HomeLayoutV2 | null {
    const card = listOf(layout).find(c => c.id === id);
    if (!card || !canRemoveCard(card.type, pinned)) return null;
    return frameRemoveCard(layout ?? defaultHomeLayout(), id, editAt(layout, now));
}

/** A card's settings changed in place (Settings… → Save): it keeps its place. Null when it isn't there or has none. */
export function changeCardSettings(layout: HomeLayoutV2 | null, id: string, settings: unknown, now: number): HomeLayoutV2 | null {
    const list = listOf(layout);
    const i = list.findIndex(c => c.id === id);
    const reader = i < 0 ? undefined : homeCardType(list[i].type)?.readSettings;
    if (!reader) return null;
    const cards = [...list];
    cards[i] = { ...cards[i], settings: reader(settings) };
    return { ...(layout ?? defaultHomeLayout()), cards, updatedAt: iso(editAt(layout, now)) };
}

/**
 * Up or down past the card next to it in `among` (the cards on screen, for the "…" menu; every card Edit home lists,
 * there), so a move always shows. Every other card keeps its place in the list. Null when it can't move that way.
 */
export function moveCard(
    layout: HomeLayoutV2 | null, id: string, dir: 'up' | 'down', among: readonly Pick<HomeCardInstance, 'id' | 'type'>[], now: number,
    pinned: readonly string[] = [],
): HomeLayoutV2 | null {
    const list = listOf(layout);
    const movable = among.filter(c => canMoveCard(c.type, pinned) && list.some(l => l.id === c.id));
    const from = movable.findIndex(c => c.id === id);
    const other = from < 0 ? undefined : movable[dir === 'up' ? from - 1 : from + 1];
    if (!other) return null;
    const cards = [...list];
    const i = cards.findIndex(c => c.id === id);
    const j = cards.findIndex(c => c.id === other.id);
    [cards[i], cards[j]] = [cards[j], cards[i]];
    return { ...(layout ?? defaultHomeLayout()), cards, updatedAt: iso(editAt(layout, now)) };
}

/**
 * Reset to defaults: the newcomer's list (§1.3). A schedule's dismissal (the `safety` card) is kept, and so is a card of
 * a type this build doesn't know, at the end: Reset is this app's defaults, not a licence to throw away what it can't see.
 */
export function resetLayout(layout: HomeLayoutV2 | null, now: number): HomeLayoutV2 {
    const unknown = listOf(layout).filter(c => !homeCardType(c.type));
    const cards = [...defaultHomeLayout().cards, ...unknown].slice(0, HOME_FRAME_LIMITS.cards);
    return { v: 2, cards, dismissed: { ...(layout?.dismissed ?? {}) }, updatedAt: iso(editAt(layout, now)) };
}

/** The `safety` card was put away: when, on the account too. */
export function dismissSafety(layout: HomeLayoutV2 | null, now: number): HomeLayoutV2 {
    const l = layout ?? defaultHomeLayout();
    const at = iso(editAt(layout, now));
    return { ...l, dismissed: { ...l.dismissed, safety: at }, updatedAt: at };
}

/**
 * Whether a member who never edited sees the one-time line {@link FEWER_CARDS_LINE} (§2.6): neither the account nor this
 * browser holds a layout, and they joined more than a week ago (a newcomer never saw the longer Home).
 */
export function fewerCardsNews(account: HomeLayoutV2 | null, local: HomeLayoutV2 | null, me: { joinedAt: string | null } | null | undefined, now: number): boolean {
    if (account || local || !me) return false;
    const joined = me.joinedAt ? Date.parse(me.joinedAt) : NaN;
    return Number.isFinite(joined) && now - joined > 7 * DAY_MS;
}

export const FEWER_CARDS_LINE = 'Home now starts with fewer cards. Add a card brings the rest back.';
/** The one-time hint (§1.3). */
export const HOME_HINT_LINE = 'This is your Home. Add a card at the bottom, or tap … on a card to move or remove it.';
/** A saved search's body before the node has answered for these words: added or changed offline (CARD-FRAME §2.4). */
export const SEARCH_OFFLINE_LINE = 'Shows when your community answers';

/** "within 5 km", or nothing where the node had no point (it ignored the distance). */
const within = (km: number | null): string => (km ? `within ${km} km` : '');

/** A saved search's first line: the words and the distance ("eggs · within 5 km"); just the words with no point. */
export function searchFirstLine(q: string, km: number | null): string {
    return [q.trim().replace(/\s+/g, ' ') || 'Every listing', within(km)].filter(Boolean).join(' · ');
}

/** A search that finds nothing says so in its own words: "No eggs within 5 km right now". */
export function searchEmptyLine(q: string, km: number | null): string {
    const words = q.trim().replace(/\s+/g, ' ');
    return ['No', words || 'listings', within(km), 'right now'].filter(Boolean).join(' ');
}
/** Edit home's line while a node before the frame can't keep the member's cards (§2.3). */
export const NOT_ON_ACCOUNT_LINE = "Your community's server needs an update before your cards follow you to other devices.";

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
export function cardOnNode(type: HomeCardType, answer: Pick<FrameAnswer, 'profile' | 'features' | 'cards'>, role?: HomeRole): boolean {
    const t = homeCardType(type);
    return !!t && HOME_DRAWN.has(type) && t.onNode({ profile: answer.profile, features: answer.features, cards: answer.cards }, role);
}

/**
 * The picker's groups (For you · Around you · Getting started), each type this node can show and this build can draw,
 * in the catalogue's order. Never a type that isn't here, never one shown as locked. A pinned `find` is on Home already
 * and not listed. `full`: Home holds 24 cards, so every Add goes.
 */
export function pickerGroups(
    answer: Pick<FrameAnswer, 'profile' | 'features' | 'cards'>, layout: HomeLayoutV2 | null, role: HomeRole,
    pinned: readonly string[] = [], status: Partial<Record<string, string>> = {},
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

/** What the live line says when a card is added or removed (§1.3). */
export const addedLine = (name: string) => `${name} added to Home`;
export const removedLine = (name: string) => `${name} removed. Add a card brings it back.`;

// ── What is asked ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The instance ids to ask the node for (`cards=`), core's rule: catalogue order then id, so a move never changes the
 * address and a repeat read can be a 304; the fixed two, every instance in the list the node builds, and a pinned card
 * whatever the list says. A type this build doesn't know is never asked. With an answer in hand, a type this node
 * doesn't show ({@link cardOnNode}) is never asked either (review of #1699, finding 5); Find your community is asked as
 * before, so a local member's address stays what their first read's was.
 */
export function cardsToAsk(
    layout: HomeLayoutV2 | null, pinned: readonly string[] = [], answer?: Pick<FrameAnswer, 'profile' | 'features' | 'cards'> | null,
): string[] {
    return frameCardsToAsk(layout ?? defaultHomeLayout(), pinned).filter(id => {
        const type = listOf(layout).find(l => l.id === id)?.type ?? id;
        return HOME_DRAWN.has(type) && (!answer || type === 'find' || cardOnNode(type, answer));
    });
}
