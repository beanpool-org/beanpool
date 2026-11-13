/**
 * Home's card frame (scratch/home/CARD-FRAME-DESIGN-fable.md §2, slice F0): a member's Home is a list of card instances
 * they own, `{ id, type, settings? }`, kept on their account as `home.layout` version 2. This module is the one
 * catalogue: the type registry (ids, names, lines, groups, limits, which node shows a type, settings readers), the
 * layout's shape and bounds, its tolerant reader (version 2, and version 1 through {@link translateV1}), the edits a
 * member makes (add, remove, move), the `cards=` ask, and the newcomer's default. The apps hold each type's body and the
 * node each type's builder; a type either has no body or builder for is **kept and not drawn / not built**, never dropped.
 *
 * - **Unknown types are kept.** An instance whose shape is right is kept whatever its type, settings and all, so an app or
 *   node older than the type carries it through every save (the #1694 trap closed at the root).
 * - **Bounded.** At most {@link HOME_FRAME_LIMITS}.cards instances, ids ≤ 32 characters, types ≤ 24, each `settings` ≤
 *   512 bytes serialised, the whole value ≤ 8 KB, ids unique. {@link checkHomeLayout} refuses a value over any bound
 *   whole (the node's write); {@link readHomeLayout} keeps what it can (a stored value, an answer).
 * - **Never in the list:** `needs` and `community` (always drawn), the per-device Tips record and hint flags.
 * - **How it is drawn** (`view`, scratch/global-node/DESIGN-home-wide-and-content-fable.md D1, slice W0): the columns the
 *   member chose for a wide screen, `view.columns` 'auto' | 1 | 2. Absent until they choose, which is Auto. Read tolerantly
 *   (anything else is Auto, a view that is no object is none), refused on a write when malformed, and kept by every edit
 *   of the list and by Reset: columns are no card. The web reads it; the phone, one column always, carries it.
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */
import { PRICING_CATEGORIES, type PricingCategory } from './pricing-catalog.js';
import { readSkySettings } from './sky.js';
import { isTagId } from './tags/index.js';
import { POST_TAGS_MAX } from './tags/post-tags.js';
import { toolHomeCardTypes } from './tools/index.js';
import { t, word, type WordKey } from './words.js';
import type { CardHue } from './brand-colours.js';

// ── The shape ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One card on a member's Home. `id` equals `type` for a one-of-a-kind card; an instance type's id is `type-xxxx`. */
export interface HomeCardInstance {
    id: string;
    type: string;
    /** The type's own settings, read by its `readSettings` (tolerant). Absent for a type with none. */
    settings?: Record<string, unknown>;
}

/** How many columns a Home stands in on a wide screen (D1): Auto fills the width with up to three; One; Two wide. */
export const HOME_COLUMN_CHOICES = ['auto', 1, 2] as const;
export type HomeColumns = (typeof HOME_COLUMN_CHOICES)[number];

/** How a member's Home is drawn rather than what is on it. Any other key is a newer app's and rides along, as an unknown card does. */
export interface HomeLayoutView {
    columns: HomeColumns;
    [later: string]: unknown;
}

/** A member's Home as kept on their account (version 2). */
export interface HomeLayoutV2 {
    v: 2;
    /** The cards on Home, in the member's order. A card is on Home because it is here, and nowhere else. */
    cards: HomeCardInstance[];
    /** When the member put away a card that comes back on a schedule (only `safety`), by instance id. */
    dismissed: Record<string, string>;
    updatedAt: string | null;
    /** The columns they chose (W0); absent until they choose, which is Auto. Read it through {@link homeColumns}. */
    view?: HomeLayoutView;
}

/** The version-1 layout today's apps send: the catalogue in the member's order with some hidden. Read, never written here. */
export interface HomeLayoutV1 {
    v: 1;
    order: string[];
    hidden: string[];
    dismissed: Record<string, string>;
    updatedAt: string | null;
}

/** The bounds of a stored layout (§2.5). */
export const HOME_FRAME_LIMITS = {
    /** Cards on a Home. */
    cards: 24,
    /** Characters of an instance id. */
    idChars: 32,
    /** Characters of a type id. */
    typeChars: 24,
    /** Bytes of one instance's settings, serialised as JSON (UTF-8). */
    settingsBytes: 512,
    /** Bytes of the whole layout, serialised as JSON (UTF-8). */
    layoutBytes: 8 * 1024,
    /** Characters of a date. An ISO date with a six-digit year and an offset is 35. */
    dateChars: 40,
} as const;

/** The sentences a refused layout is answered with, one per bound (the node's 400s). */
export const HOME_FRAME_MESSAGES = {
    shape: 'A Home layout is { v: 2, cards: [{ id, type, settings? }], dismissed: { card id: date }, updatedAt: date }.',
    tooMany: `A Home names at most ${HOME_FRAME_LIMITS.cards} cards.`,
    idLength: `A card's id is at most ${HOME_FRAME_LIMITS.idChars} characters, and its type at most ${HOME_FRAME_LIMITS.typeChars}.`,
    repeated: 'Each card on a Home has its own id.',
    settingsSize: `A card's settings are at most ${HOME_FRAME_LIMITS.settingsBytes} bytes.`,
    layoutSize: `A Home layout is at most ${HOME_FRAME_LIMITS.layoutBytes / 1024} KB.`,
    date: 'A date in a Home layout is a date and time, as 2026-10-02T15:40:00.000Z.',
    // Marked: the node's answer carries it in the member's language (apps/server member-words.ts).
    view: word("A Home layout's view names its columns: auto, 1 or 2."),
} as const;
export type HomeFrameProblem = keyof typeof HOME_FRAME_MESSAGES;

// ── The registry ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What a Home answer says of the node, as far as which cards it can show goes (routes/home-answer.ts `features`). */
export interface HomeNodeFacts {
    profile?: string | null;
    features: {
        beans?: boolean; escrow?: boolean; enterprises?: boolean; invites?: boolean; decisions?: boolean;
        wordsDoor?: boolean; door?: string | null;
        [other: string]: unknown;
    };
    /** The answer's card bodies, by instance id: a `safety` card the node sent is shown where the door has shut since. */
    cards?: Record<string, unknown>;
    /**
     * What the answer says of the reader (routes/home-answer.ts `me`), as far as which cards it can show goes: `wayBack`
     * `words` when the 12 words are the only way back this server can see (DESIGN-home-default-fable.md §2.5, slice D1), so
     * "Your way back in" is in the catalogue for them however they joined, on a node whose 12-words door is shut too.
     * Absent (a node before D1, or the node's own build, which has no reader here): the door's rule alone.
     */
    me?: { wayBack?: string | null } | null;
}
/** The reader's role on this node as the node said it: null for none, undefined not heard. */
export type HomeReaderRole = 'owner' | 'admin' | 'moderator' | null | undefined;

/** The picker's groups, in their order: For you · Around you · Getting started. */
export type HomeCardGroup = 'you' | 'around' | 'start';
export const HOME_CARD_GROUPS: readonly { id: HomeCardGroup; name: WordKey }[] = [
    { id: 'you', name: word('For you') },
    { id: 'around', name: word('Around you') },
    { id: 'start', name: word('Getting started') },
];

export interface HomeCardType {
    id: string;
    /** The card's hue (S1): brand accent sage for frame cards, a type-specific hue for others. */
    hue: CardHue;
    /** Its caption, its row in the picker and its band in Arrange. Fixed words, never member text: shown through t(). */
    name: WordKey;
    /** On the worldwide community, where it says something else ("Near you"). */
    globalName?: WordKey;
    /** One line of what it shows, in the picker. */
    line: WordKey;
    group: HomeCardGroup;
    /** Absent: one of a kind (its id is its type). Present: up to `max` instances. */
    multiple?: { max: number };
    /** Always drawn and never in the list: `needs` first, `community` last. */
    fixed?: true;
    /**
     * `node`: the instance id goes in `cards=` and the node builds its body. `none`: drawn from the answer's header, the
     * device or bundled data, never asked for.
     */
    asks: 'node' | 'none';
    /** Whether a node of this kind can show it to this reader (today's `cardOnNode`, per type). */
    onNode(answer: HomeNodeFacts, role?: HomeReaderRole): boolean;
    /** The type's settings from whatever is stored: tolerant, the default for anything odd. Absent: the type has none. */
    readSettings?(raw: unknown): Record<string, unknown>;
    /**
     * For a type that asks the node: whether an instance with these settings (as `readSettings` reads them) has anything for
     * the node to build. A chat card with no chat picked is drawn as "Pick a chat" and never asked. Absent: always.
     */
    asksWith?(settings: Record<string, unknown>): boolean;
    /**
     * A card that arrives on a Home its member already arranged (DESIGN-local-knowledge-amend-fable.md §3.6, Marty's pick 2,
     * 11 Nov 2026): drawn once, after the member's own cards, while their saved list neither holds it nor carries the stamp
     * `new:<id>` in `dismissed`; Remove, a move or "Keep on Home" writes the stamp in the member's own next save, and nothing
     * is written by itself. The mark only: the rule that reads it is slice K7's, with the `learn` card. No card has it yet.
     */
    arrives?: true;
}

/** The distances a saved search can be bounded to, in km. */
export const HOME_SEARCH_KMS = [1, 2, 5, 10, 25] as const;
/** The longest words a saved search keeps. */
export const HOME_SEARCH_MAX_CHARS = 40;
export type HomeSearchKind = 'offer' | 'need' | 'any';
/**
 * A saved search. `tags`: the tag ids the app resolved its words to when it was saved (DESIGN-owner-seeding-tags-fable.md
 * §4.7), at most POST_TAGS_MAX, which the node asks with the words, so a listing tagged lemon is found from "limón".
 */
export type HomeSearchSettings = { q: string; kind: HomeSearchKind; category?: string; km?: (typeof HOME_SEARCH_KMS)[number]; tags?: string[] };

const CATEGORY_IDS: ReadonlySet<string> = new Set(PRICING_CATEGORIES.map((c) => c.id));
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A saved search's settings, tolerant: words cut to 40 characters, an unknown kind is `any`, an unknown category or distance is none,
 *  a tag this library does not know is left out (an app newer than the node), and none past POST_TAGS_MAX is kept. */
export function readSearchSettings(raw: unknown): HomeSearchSettings {
    const s = isPlainObject(raw) ? raw : {};
    const q = typeof s.q === 'string' ? s.q.trim().slice(0, HOME_SEARCH_MAX_CHARS) : '';
    const kind: HomeSearchKind = s.kind === 'offer' || s.kind === 'need' ? s.kind : 'any';
    const out: HomeSearchSettings = { q, kind };
    if (typeof s.category === 'string' && CATEGORY_IDS.has(s.category)) out.category = s.category;
    if (typeof s.km === 'number' && (HOME_SEARCH_KMS as readonly number[]).includes(s.km)) out.km = s.km as HomeSearchSettings['km'];
    if (Array.isArray(s.tags)) {
        const tags = [...new Set(s.tags.filter((id): id is string => typeof id === 'string' && isTagId(id)))].slice(0, POST_TAGS_MAX);
        if (tags.length > 0) out.tags = tags;
    }
    return out;
}

// ── A chosen chat (scratch/fable-design/DESIGN-home-chosen-chat-fable.md, slice C0) ──────────────────────────────────

/** What a chat card can pin: a direct chat, a group's chat, an event's chat or an enterprise's discussion. */
export const HOME_CHAT_KINDS = ['dm', 'group', 'event', 'enterprise'] as const;
export type HomeChatKind = (typeof HOME_CHAT_KINDS)[number];
/** The longest conversation id a chat card keeps, and the longest name it keeps for the chat. */
export const HOME_CHAT_ID_CHARS = 64;
export const HOME_CHAT_NAME_CHARS = 60;
/** A chat picked: its id, its kind, and its name as it was when the member picked it (the card's words until the node answers). */
export type HomeChatSettings = { conversationId: string; kind: HomeChatKind; name: string };

/**
 * A chat card's settings, tolerant: a chat is picked when the id is text of 1 to 64 characters and the kind is one of the
 * four. Anything else is none picked (`{}`): the apps draw "Pick a chat", and {@link cardsToAsk} never asks the node for
 * it. The name is cut to 60 characters, '' when there is none.
 */
export function readChatSettings(raw: unknown): HomeChatSettings | Record<string, never> {
    const s = isPlainObject(raw) ? raw : {};
    const id = s.conversationId;
    if (typeof id !== 'string' || id.length === 0 || id.length > HOME_CHAT_ID_CHARS) return {};
    if (!(HOME_CHAT_KINDS as readonly unknown[]).includes(s.kind)) return {};
    const name = typeof s.name === 'string' ? Array.from(s.name.trim()).slice(0, HOME_CHAT_NAME_CHARS).join('') : '';
    return { conversationId: id, kind: s.kind as HomeChatKind, name };
}

/** Whether a chat card's settings (as {@link readChatSettings} reads them) pick a chat. */
export const homeChatPicked = (s: Record<string, unknown>): s is HomeChatSettings => typeof s.conversationId === 'string';

/**
 * One line of a pinned chat in the Home answer, oldest first, as the chat's own read serves it to this member. The node
 * opens nothing. A line it stores readable (a system line, or `plaintext-v1`: an event's or an enterprise's chat, a group
 * not locked, a removal's notice) comes as its words, cut. A sealed line (a direct message, a locked group line) comes as
 * its bytes exactly as stored, for the device to open with the key it holds, only while ciphertext, nonce and metadata
 * come to 512 characters at most; past that, `text` is `🔒 Message` and no bytes travel.
 *
 * In a direct chat only a line the device opens is anyone's words (core dmLineKind): a readable line there in a member's
 * name is shown as not encrypted, a removed one as deleted, unless `metadata` marks it the community admins' message.
 */
export interface HomeChatLine {
    id: string;
    /** The author's key as stored ('SYSTEM' for the node's own line): the device says "You" for its own. */
    author: string;
    /** The author's name, cut; null for the node's own line. */
    who: string | null;
    /** When the node says it was written. */
    at: string;
    /** As stored: 'text', 'image', 'system', 'removed', or a newer kind. */
    type: string;
    /** A system line's kind, for the apps to word it as the chat does; null for any other line. */
    systemType: string | null;
    /** A readable line's words, cut; `🔒 Message` for a sealed line too long to carry. Absent when `sealed` is carried. */
    text?: string;
    /** A readable line's metadata as stored while it is 512 characters at most (who removed it, the admins' mark), else null. */
    metadata?: string | null;
    /** A sealed line as stored, for the device to open. */
    sealed?: { ciphertext: string; nonce: string; metadata: string | null };
}

/**
 * Why a pinned chat shows nothing: the member isn't in it now, or it isn't there for them ('left', also for an id they
 * were never in); its event was hidden from them ('hidden'); a request they haven't accepted ('request'). Never a name
 * or a line with it.
 */
export type HomeChatGone = 'left' | 'hidden' | 'request';

/**
 * A chat card's body in the Home answer, keyed by its instance id: the chat as the member reads it now (its kind, name,
 * unread count, whether they muted it, and its last lines), or `gone` alone.
 */
export type HomeChatCard =
    | {
        kind: HomeChatKind; name: string | null; unread: number; muted: boolean; lines: HomeChatLine[];
        /**
         * A direct chat's other person, by their key (slice C3): what the web, which keeps no list of conversations, builds
         * the chat's key context from, so the member's own lines open too when the other person wrote none of the last
         * three. The node tells a participant this already (the conversations list). Absent on a group's, from an older node.
         */
        peer?: string;
    }
    | { gone: HomeChatGone };

/**
 * What the Decide card shows (CARD-FRAME §4, "My votes"). `counts`, the default and today's card: the few soonest-closing
 * open Decisions, the first open poll, and the polls line. `open`: more of the open Decisions (up to
 * {@link HOME_DECIDE_ROWS}.open), the poll and the polls line as in `counts`. `mine`: only the open Decisions the member
 * voted in or proposed, nothing of polls.
 */
export const HOME_DECIDE_SHOWS = ['counts', 'open', 'mine'] as const;
export type HomeDecideShow = (typeof HOME_DECIDE_SHOWS)[number];
export type HomeDecideSettings = { show: HomeDecideShow };
/** How many Decision rows the node sends for each choice, and the most an app draws. */
export const HOME_DECIDE_ROWS: Readonly<Record<HomeDecideShow, number>> = { counts: 3, open: 5, mine: 5 };
export const HOME_DECIDE_ROWS_MAX = Math.max(...Object.values(HOME_DECIDE_ROWS));

/**
 * The Decide card's choices as the settings sheet offers them on both apps (one text, so the phone and the web never
 * drift): the chip and a line under the chosen one saying what it shows. word() keys: shown through t().
 */
export const HOME_DECIDE_CHOICES: ReadonlyArray<{ show: HomeDecideShow; label: WordKey; note: WordKey }> = [
    { show: 'counts', label: word('Summary'), note: word('The Decisions closing soonest, and the first poll.') },
    { show: 'open', label: word('All open'), note: word('Up to five open Decisions, and the first poll.') },
    { show: 'mine', label: word('My votes'), note: word('Open Decisions you voted in or proposed.') },
];

/** The Decide card's settings, tolerant: anything but `open` or `mine` is `counts` (today's card, the default). */
export function readDecideSettings(raw: unknown): HomeDecideSettings {
    const show = isPlainObject(raw) ? raw.show : undefined;
    return { show: show === 'open' || show === 'mine' ? show : 'counts' };
}

/**
 * A Your tools card (slice home-tools-card): the tool IDs the member chose to keep on Home.
 */
export type HomeToolsSettings = { tools: string[] };

/** A Your tools card's settings, tolerant: an array of unique tool id strings (at most 12), [] for anything odd. */
export function readToolsSettings(raw: unknown): HomeToolsSettings {
    const s = isPlainObject(raw) ? raw : {};
    const tools = Array.isArray(s.tools)
        ? [...new Set(s.tools.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= HOME_FRAME_LIMITS.idChars).map(id => id.trim()))].slice(0, 12)
        : [];
    return { tools };
}

/**
 * Whether the reader can invite here: invites are on, and where only admins invite the node has said they are an owner
 * or admin (apps/native utils/home-cards.ts `invitesForReader`, the same rule). A role not heard yet counts as no.
 */
export function homeInvitesForReader(features: HomeNodeFacts['features'], role: HomeReaderRole): boolean {
    if (features.invites !== true) return false;
    if (features.door !== 'admins') return true;
    return role === 'owner' || role === 'admin';
}

const everywhere = () => true;
const notGlobal = (a: HomeNodeFacts) => a.profile !== 'global';

/**
 * Arrange's words, one set for both apps (DESIGN-home-layout-fable.md §3.2, §3.7), shown through t(). Both apps say
 * `barDrag` and `openedDrag`, which promise the hold-and-drag they have (DESIGN-home-arrange-in-place-fable.md §2.9; the
 * phone's drag is slice A4). `bar` and `opened`, the arrows-only lines from before the drag, are drawn by neither now.
 */
export const ARRANGE_WORDS = {
    name: word('Arrange'),
    more: word('Arrange ›'),
    link: word('Arrange: move the cards on Home'),
    bar: word("Arrange Home: use the arrows. Done when you're happy."),
    barDrag: word("Arrange Home: hold a card to drag it, or use the arrows. Done when you're happy."),
    opened: word('Arrange Home. Use the arrows on each card.'),
    openedDrag: word('Arrange Home. Hold a card to drag it, or use the arrows on each card.'),
    stays: word('Stays here'),
    done: word('Done arranging Home'),
} as const;

/** What the live line says after a move: where the card now stands among the cards that move. */
export const arrangeMovedLine = (card: string, n: number, m: number) => t('{card} moved to {n} of {m}', { card, n, m });

/**
 * Every card type, in the catalogue's order (the order `cards=` names them in). Unknown features count as on, as the
 * apps read a node's features; the worldwide community has no Beans, deals, enterprise, Decide or invites (§1.2).
 */
export const HOME_CARD_TYPES: readonly HomeCardType[] = [
    { id: 'needs', hue: 'sage', name: word('Needs you'), line: word('Things waiting on you, first.'), group: 'you', fixed: true, asks: 'node', onNode: everywhere },
    {
        id: 'safety', hue: 'sage', name: word('Your way back in'), line: word('A reminder to keep your 12 words safe.'), group: 'start', asks: 'node',
        // Where the 12-words door is open, where the node sent the 12-words door's own card, and for every member whose 12
        // words are the only way back (`me.wayBack`, §2.5): an invited member on an invite-only local community among them
        // (review of #3114, finding 1: `wordsDoor: false` kept the card out for all of them).
        onNode: (a) => a.features.wordsDoor !== false || !!a.cards?.safety || a.me?.wayBack === 'words',
    },
    { id: 'find', hue: 'sage', name: word('Find your community'), line: word('Communities near you, to join.'), group: 'start', asks: 'node', onNode: (a) => a.profile === 'global' },
    // Welcome (DESIGN-home-default-fable.md §2.3), first in the default list: drawn by the apps while `welcomeDrawn` says.
    // It hides nothing. Its caption becomes "Welcome" with its body (slice D2) and the words' drafts (D4).
    { id: 'start', hue: 'sky', name: word('Getting started'), line: word('A one-minute look at the other tabs.'), group: 'start', asks: 'none', onNode: everywhere },
    { id: 'steps', hue: 'sky', name: word('First steps'), globalName: word('Your first week'), line: word('Things to do in your first weeks.'), group: 'start', asks: 'node', onNode: everywhere },
    { id: 'tips', hue: 'indigo', name: word('Tips'), line: word('One tip at a time on how things work.'), group: 'start', asks: 'none', onNode: everywhere },
    { id: 'interests', hue: 'pink', name: word('What are you into?'), line: word('Star what you like to see it first.'), group: 'start', asks: 'none', onNode: everywhere },
    { id: 'deals', hue: 'teal', name: word('Your deals'), line: word('Open deals and ones waiting on you.'), group: 'you', asks: 'node', onNode: (a) => notGlobal(a) && a.features.escrow !== false },
    {
        id: 'enterprise', hue: 'clay', name: word('Your enterprise'), line: word('Requests for the enterprise you keep.'), group: 'you', asks: 'node',
        onNode: (a) => notGlobal(a) && a.features.enterprises !== false,
    },
    // The member's own shop and their tools (DESIGN-shops-and-tools-fable.md §8, slice S4′): on every node, since a shop is
    // no enterprise and works where Beans are off. Built by the node from the member's own shop row.
    { id: 'shop', hue: 'clay', name: word('Your shop and tools'), line: word('Your shop, and things you can do on your own.'), group: 'you', asks: 'node', onNode: everywhere },
    { id: 'events', hue: 'violet', name: word('Coming up'), line: word('Events coming up soon.'), group: 'around', asks: 'node', onNode: everywhere },
    { id: 'market', hue: 'orange', name: word('New in the Market'), globalName: word('Near you'), line: word('The newest listings near you.'), group: 'around', asks: 'node', onNode: everywhere },
    // What neighbours are asking for, the Needs a member can answer with nothing (DESIGN-cold-start-trades-fable.md §2.4, slice
    // N1): real open Needs only, the member's stars first, and no body while there are none. On every node, since the worldwide
    // community has Needs too (it gets the card, not the push).
    { id: 'asked', hue: 'orange', name: word('Asked near you'), line: word('Things neighbours are asking for, what you star first.'), group: 'around', asks: 'node', onNode: everywhere },
    {
        id: 'search', hue: 'orange', name: word('A saved search'), line: word('Listings that match words you choose, near you.'), group: 'around',
        multiple: { max: 5 }, asks: 'node', onNode: everywhere, readSettings: readSearchSettings,
    },
    {
        id: 'decide', hue: 'plum', name: word('Decide'), line: word('Open Decisions and polls.'), group: 'you', asks: 'node',
        onNode: (a) => notGlobal(a) && a.features.decisions !== false, readSettings: readDecideSettings,
    },
    { id: 'groups', hue: 'rose', name: word('Your groups'), line: word("What's new in your groups."), group: 'you', asks: 'node', onNode: everywhere },
    // A chat the member picked, its last lines opened on the device (DESIGN-home-chosen-chat-fable.md §1): on every node,
    // since every node has chats. Asked only once a chat is picked; the node answers only a chat the member is in now.
    {
        id: 'chat', hue: 'sage', name: word('A chat'), line: word('The last lines of one chat you choose.'), group: 'you',
        multiple: { max: 3 }, asks: 'node', onNode: everywhere, readSettings: readChatSettings, asksWith: homeChatPicked,
    },
    { id: 'joined', hue: 'lime', name: word('Who joined'), line: word('People who joined this week.'), group: 'around', asks: 'node', onNode: everywhere },
    { id: 'pulse', hue: 'blue', name: word('The Pulse'), line: word('Links your neighbours shared.'), group: 'around', asks: 'node', onNode: everywhere },
    // Worked out on the device (sky.ts) from the community's place or the member's, which every node can have: never asked.
    {
        id: 'sky', hue: 'yellow', name: word('Sun and moon'), line: word('Sunrise, sunset and the moon tonight.'), group: 'around', asks: 'none', onNode: everywhere,
        readSettings: readSkySettings,
    },
    { id: 'beans', hue: 'green', name: word('Your Beans'), line: word('Your balance and room to spend.'), group: 'you', asks: 'node', onNode: (a) => notGlobal(a) && a.features.beans !== false },
    { id: 'notices', hue: 'sand', name: word('From your community'), line: word("Notices from your community's admins."), group: 'you', asks: 'node', onNode: everywhere },
    {
        id: 'invite', hue: 'green', name: word('Grow your community'), line: word('Ways to invite people you know.'), group: 'start', asks: 'none',
        onNode: (a, role) => notGlobal(a) && homeInvitesForReader(a.features, role),
    },
    // The member's tools card (slice home-tools-card): tools the member chose to keep on Home.
    {
        id: 'tools', hue: 'sand', name: word('Your tools'), line: word('A card you fill with the tools you use.'),
        group: 'you', asks: 'none', onNode: everywhere, readSettings: readToolsSettings,
    },
    // Each tool's card, worked out on the device from its document (tools/index.ts): one spread, so a tool needs no line here.
    ...toolHomeCardTypes(),
    { id: 'community', hue: 'sage', name: word('Your community'), line: word('Your community at a glance.'), group: 'you', fixed: true, asks: 'node', onNode: everywhere },
];

const TYPES: ReadonlyMap<string, HomeCardType> = new Map(HOME_CARD_TYPES.map((t) => [t.id, t]));
const RANK: ReadonlyMap<string, number> = new Map(HOME_CARD_TYPES.map((t, i) => [t.id, i]));
/** Each tool's card type (tools/index.ts): a member's own choice, kept by Reset. */
const TOOL_CARD_TYPES: ReadonlySet<string> = new Set(toolHomeCardTypes().map((t) => t.id));

/** The registry's entry for a type, or undefined for one this build doesn't know (kept, not drawn, not built). */
export const homeCardType = (type: string): HomeCardType | undefined => TYPES.get(type);

/**
 * The hue a saved search takes from its category (DESIGN-home-look-fable.md §2.2, slice 2): each category's tile colour
 * (brand-colours `tile`), as the nearest card hue. Labour is yellow, not amber: amber on Home means "waiting on you" and is
 * never a default. Typed on the category ids, so a category added to the catalogue without a hue here fails the compiler.
 */
export const HOME_CATEGORY_HUES: Readonly<Record<PricingCategory, CardHue>> = {
    food: 'orange', services: 'blue', labour: 'yellow', tools: 'sand', goods: 'sand', garden: 'lime', housing: 'clay',
    transport: 'sky', education: 'indigo', arts: 'pink', health: 'teal', care: 'rose', animals: 'green', tech: 'sky',
    energy: 'yellow', mindset: 'plum', general: 'sage',
};

/** The hue a chat card takes from the kind of chat it shows: a direct chat sage, a group rose, an event's violet, an enterprise's clay. */
export const HOME_CHAT_KIND_HUES: Readonly<Record<HomeChatKind, CardHue>> = { dm: 'sage', group: 'rose', event: 'violet', enterprise: 'clay' };

/**
 * A card's hue: the type's hue from the catalogue (S1); a saved search with a category takes the category's, and a chat card
 * with a chat picked takes its kind's (S2). A search with no category keeps orange, a chat with none picked keeps sage.
 * Sage for an unknown type or instance.
 */
export const homeCardHue = (instance?: Pick<HomeCardInstance, 'type'> & { settings?: unknown } | null): CardHue => {
    if (!instance?.type) return 'sage';
    if (instance.type === 'search') {
        const category = readSearchSettings(instance.settings).category;
        if (category) return HOME_CATEGORY_HUES[category as PricingCategory];
    } else if (instance.type === 'chat') {
        const chat = readChatSettings(instance.settings);
        if ('kind' in chat) return HOME_CHAT_KIND_HUES[chat.kind];
    }
    return TYPES.get(instance.type)?.hue ?? 'sage';
};

/** The types always drawn and never in a member's list. */
export const HOME_FIXED_TYPES: readonly string[] = HOME_CARD_TYPES.filter((t) => t.fixed).map((t) => t.id);

/** The catalogue of version 1 (the eighteen one-of-a-kind ids today's apps know), in its default order. */
export const HOME_V1_CARD_IDS: readonly string[] = [
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups',
    'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
];

/**
 * The default list (scratch/fable-design/DESIGN-home-default-fable.md §2.2, Marty's picks of 13 Nov 2026): a newcomer's
 * Home from the first second, the community first and the chores second, in the phone's order (the web packs the same
 * order into its columns). Fifteen of the 24, which leaves nine for the member's own. Each is drawn only while it has
 * something to say, by the rule it already follows (§2.1 rule 3), so a newcomer sees about six to ten on day one and the
 * rest arrive in their places as they have something:
 *
 * | Card | Drawn when |
 * |---|---|
 * | `start` (Welcome) | Until the tour is taken or Not now, seven days at most ({@link welcomeDrawn}) |
 * | `safety` (Your way back in) | On its schedule only, for an account with no second way back (the node's `me.wayBack`), on any node, its 12-words door shut or not (the web since D3, the phone since D2 and D2b, both reading core's gate with `me`) |
 * | `market` (New in the Market) | A listing exists, or the community's examples |
 * | `steps` (First steps) | A line is left, in the first 30 days (first-steps.ts `FIRST_STEPS_DAYS`) |
 * | `interests` (What are you into?) | Until the first star |
 * | `events` (Coming up) | An event is coming |
 * | `beans` (Your Beans) | Beans are on here |
 * | `asked` (Asked near you) | A neighbour has an open Need |
 * | `deals` (Your deals) | An open deal |
 * | `groups` (Your groups) | In a group |
 * | `decide` (Decide) | A Decision or poll is open |
 * | `notices` (From your community) | An unseen notice |
 * | `joined` (Who joined) | Someone joined this week |
 * | `tips` (Tips) | One a day until all are seen |
 * | `sky` (Sun and moon) | The community has a place |
 *
 * Needs you stays fixed first and the community card fixed last; on the worldwide community Find your community stays
 * pinned under Needs you, and the cards it has no feature for (Your Beans, Your deals, Decide) are never asked for.
 */
export const HOME_DEFAULT_LIST: readonly string[] = [
    'start', 'safety', 'market', 'steps', 'interests', 'events', 'beans', 'asked', 'deals', 'groups', 'decide', 'notices', 'joined', 'tips', 'sky',
];

/**
 * The default list less Welcome (§3 "Restore default?"): what Reset to defaults puts back, and what a Home with no saved
 * layout holds once the tour has ended. Welcome is a newcomer's, never a reset's.
 */
export const HOME_STARTER_SET: readonly string[] = HOME_DEFAULT_LIST.filter((id) => id !== 'start');

/** The default list less Welcome, as card instances. */
export const starterCards = (): HomeCardInstance[] => HOME_STARTER_SET.map((id) => ({ id, type: id }));

/**
 * A newcomer's Home (§2.2): the default list, Welcome on top, between the fixed Needs you and Your community (and under a
 * pinned Find your community on global). Nothing waits behind the tour: every card is there from the first second.
 */
export function defaultCards(_profile: 'local' | 'global' | string = 'local'): HomeCardInstance[] {
    return HOME_DEFAULT_LIST.map((id) => ({ id, type: id }));
}

/** How long Welcome stays at most, in days after joining (§2.3 "It leaves"). */
export const WELCOME_DAYS = 7;

/**
 * Whether Welcome is drawn (§2.3): until the tour is done, Not now (a skip), or seven days after joining, whichever comes
 * first. `tourOver` is the account's record saying done or skipped (tour.ts `tourEnded`); a join date the node didn't send
 * or can't be read leaves the card to the tour alone, never hides it.
 */
export function welcomeDrawn(tourOver: boolean, joinedAt: string | null | undefined, now: number = Date.now()): boolean {
    if (tourOver) return false;
    const joined = typeof joinedAt === 'string' ? Date.parse(joinedAt) : NaN;
    return !Number.isFinite(joined) || now - joined < WELCOME_DAYS * 86_400_000;
}

/**
 * A card the member made rather than took from the catalogue (§3 "Restore default?"): a saved search, a chat, Your tools,
 * a tool's card, or a type this build doesn't know (a newer app's, kept whatever it is). Reset keeps these, after the defaults.
 */
export function isOwnCard(card: Pick<HomeCardInstance, 'type'>): boolean {
    const t = TYPES.get(card.type);
    return !t || !!t.multiple || card.type === 'tools' || TOOL_CARD_TYPES.has(card.type);
}

/**
 * Reset to defaults (§3): the default list less Welcome, then the cards the member made ({@link isOwnCard}) in their order,
 * at most 24. The schedule's dismissals (Your way back in) and the view are kept: neither is a card. `now` stamps `updatedAt`.
 */
export function resetHomeLayout(layout: HomeLayoutV2 | null, now: number = Date.now()): HomeLayoutV2 {
    const defaults = starterCards();
    const have = new Set(defaults.map((c) => c.id));
    const own = (layout?.cards ?? []).filter((c) => isOwnCard(c) && !have.has(c.id));
    const cards = [...defaults, ...own].slice(0, HOME_FRAME_LIMITS.cards);
    const view = layout?.view ? { view: layout.view } : {};
    return { v: 2, cards, dismissed: { ...(layout?.dismissed ?? {}) }, updatedAt: new Date(now).toISOString(), ...view };
}

/** A newcomer's whole layout, never edited (`updatedAt` null). */
export const defaultHomeLayout = (profile?: string): HomeLayoutV2 => ({ v: 2, cards: defaultCards(profile), dismissed: {}, updatedAt: null });

// ── Reading and checking ──────────────────────────────────────────────────────────────────────────────────────────

/** UTF-8 bytes of a string, without TextEncoder (pure, every runtime). */
function utf8Bytes(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

/** A date as a layout keeps it (UTC ISO), or null for anything that isn't text naming a real moment. */
export function homeLayoutDate(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > HOME_FRAME_LIMITS.dateChars) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Why one instance isn't one, or null when it is (shape and bounds only; its type is never checked). */
function instanceProblem(raw: unknown): HomeFrameProblem | null {
    if (!isPlainObject(raw)) return 'shape';
    if (typeof raw.id !== 'string' || typeof raw.type !== 'string' || raw.id.length === 0 || raw.type.length === 0) return 'shape';
    if (raw.id.length > HOME_FRAME_LIMITS.idChars || raw.type.length > HOME_FRAME_LIMITS.typeChars) return 'idLength';
    if (raw.settings !== undefined) {
        if (!isPlainObject(raw.settings)) return 'shape';
        if (utf8Bytes(JSON.stringify(raw.settings)) > HOME_FRAME_LIMITS.settingsBytes) return 'settingsSize';
    }
    return null;
}

/** An instance as kept: its own object (unknown fields and all), so a type this build doesn't know survives byte for byte. */
const keptInstance = (raw: Record<string, unknown>): HomeCardInstance => raw as unknown as HomeCardInstance;

const isHomeColumns = (v: unknown): v is HomeColumns => (HOME_COLUMN_CHOICES as readonly unknown[]).includes(v);

/** The columns the member chose for a wide screen: Auto when they never chose, or for a choice this build doesn't know. */
export function homeColumns(layout: Pick<HomeLayoutV2, 'view'> | null | undefined): HomeColumns {
    const columns = layout?.view?.columns;
    return isHomeColumns(columns) ? columns : 'auto';
}

/**
 * A version-2 layout checked strictly, as the node takes a member's write: shape and bounds, never the type. Every bound
 * refuses the whole value with its problem, and so does a `view` that is no object or whose `columns` isn't 'auto', 1 or
 * 2 (its other keys, a newer app's, are kept). `updatedAt` is left as sent (null when absent); the caller stamps it.
 */
/** As long as any date the node keeps (an ISO string): the size of a stamp still to come. */
const KEPT_DATE_STAND_IN = new Date(0).toISOString();

export function checkHomeLayout(value: unknown): { ok: true; layout: HomeLayoutV2 } | { ok: false; problem: HomeFrameProblem } {
    if (!isPlainObject(value) || value.v !== 2 || !Array.isArray(value.cards)) return { ok: false, problem: 'shape' };
    let size: number;
    try {
        size = utf8Bytes(JSON.stringify(value));
    } catch {
        return { ok: false, problem: 'shape' };
    }
    if (size > HOME_FRAME_LIMITS.layoutBytes) return { ok: false, problem: 'layoutSize' };
    if (value.cards.length > HOME_FRAME_LIMITS.cards) return { ok: false, problem: 'tooMany' };
    const ids = new Set<string>();
    const cards: HomeCardInstance[] = [];
    for (const raw of value.cards) {
        const problem = instanceProblem(raw);
        if (problem) return { ok: false, problem };
        const card = raw as Record<string, unknown>;
        if (ids.has(card.id as string)) return { ok: false, problem: 'repeated' };
        ids.add(card.id as string);
        cards.push(keptInstance(card));
    }
    const dismissed: Record<string, string> = {};
    if (value.dismissed !== undefined) {
        if (!isPlainObject(value.dismissed)) return { ok: false, problem: 'shape' };
        const entries = Object.entries(value.dismissed);
        if (entries.length > HOME_FRAME_LIMITS.cards) return { ok: false, problem: 'tooMany' };
        for (const [id, at] of entries) {
            if (id.length === 0 || id.length > HOME_FRAME_LIMITS.idChars) return { ok: false, problem: 'idLength' };
            const when = homeLayoutDate(at);
            if (when === null) return { ok: false, problem: 'date' };
            dismissed[id] = when;
        }
    }
    let updatedAt: string | null = null;
    if (value.updatedAt !== undefined && value.updatedAt !== null) {
        updatedAt = homeLayoutDate(value.updatedAt);
        if (updatedAt === null) return { ok: false, problem: 'date' };
    }
    const layout: HomeLayoutV2 = { v: 2, cards, dismissed, updatedAt };
    if (value.view !== undefined) {
        const view = value.view;
        if (!isPlainObject(view) || !isHomeColumns(view.columns)) return { ok: false, problem: 'view' };
        layout.view = { ...view, columns: view.columns };
    }
    // The bound is on what is KEPT: dates come back as 24-character ISO strings and the caller stamps a missing updatedAt, so a
    // body just under the bound as sent could be stored over it and refuse its own read-back (review of #1697, finding 1).
    if (utf8Bytes(JSON.stringify({ ...layout, updatedAt: updatedAt ?? KEPT_DATE_STAND_IN })) > HOME_FRAME_LIMITS.layoutBytes) {
        return { ok: false, problem: 'layoutSize' };
    }
    return { ok: true, layout };
}

/**
 * A version-1 layout as a version-2 one (§2.6): the member's order, then the rest of the version-1 catalogue in its
 * default order (version 1 placed an unnamed card there), with hidden cards and the always-drawn two left out, each a
 * one-of-a-kind instance. `dismissed` and `updatedAt` kept. Not written back by this: a version-1 app on another device
 * still reads the row it knows until the member edits.
 */
export function translateV1(v1: Pick<HomeLayoutV1, 'order' | 'hidden'> & Partial<Pick<HomeLayoutV1, 'dismissed' | 'updatedAt'>>): HomeLayoutV2 {
    const ok = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= HOME_FRAME_LIMITS.typeChars;
    const hidden = new Set((Array.isArray(v1.hidden) ? v1.hidden : []).filter(ok));
    const seen = new Set<string>();
    const cards: HomeCardInstance[] = [];
    for (const id of [...(Array.isArray(v1.order) ? v1.order : []).filter(ok), ...HOME_V1_CARD_IDS]) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (hidden.has(id) || HOME_FIXED_TYPES.includes(id)) continue;
        if (cards.length < HOME_FRAME_LIMITS.cards) cards.push({ id, type: id });
    }
    const dismissed: Record<string, string> = {};
    for (const [id, at] of Object.entries(isPlainObject(v1.dismissed) ? v1.dismissed : {})) {
        const when = homeLayoutDate(at);
        if (when !== null && id.length <= HOME_FRAME_LIMITS.idChars) dismissed[id] = when;
    }
    return { v: 2, cards, dismissed, updatedAt: homeLayoutDate(v1.updatedAt) };
}

/**
 * Any stored or answered layout, read tolerantly: version 2 keeps every instance whose shape is right, known type or not
 * (a malformed one, a repeated id or one past the 24th is dropped, never the whole), and a `view` that is an object, its
 * `columns` Auto unless it is one of the choices; version 1 reads through {@link translateV1} (it has no view); anything
 * else is null (the default Home).
 */
export function readHomeLayout(value: unknown): HomeLayoutV2 | null {
    if (!isPlainObject(value)) return null;
    if (value.v === 1 || (value.v === undefined && (Array.isArray(value.order) || Array.isArray(value.hidden)))) {
        return translateV1({
            order: Array.isArray(value.order) ? value.order : [],
            hidden: Array.isArray(value.hidden) ? value.hidden : [],
            dismissed: isPlainObject(value.dismissed) ? (value.dismissed as Record<string, string>) : {},
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        });
    }
    if (value.v !== 2 || !Array.isArray(value.cards)) return null;
    const ids = new Set<string>();
    const cards: HomeCardInstance[] = [];
    for (const raw of value.cards) {
        if (cards.length >= HOME_FRAME_LIMITS.cards) break;
        if (instanceProblem(raw)) continue;
        const card = raw as Record<string, unknown>;
        if (ids.has(card.id as string)) continue;
        ids.add(card.id as string);
        cards.push(keptInstance(card));
    }
    const dismissed: Record<string, string> = {};
    if (isPlainObject(value.dismissed)) {
        for (const [id, at] of Object.entries(value.dismissed)) {
            const when = homeLayoutDate(at);
            if (when !== null && id.length > 0 && id.length <= HOME_FRAME_LIMITS.idChars) dismissed[id] = when;
        }
    }
    const read: HomeLayoutV2 = { v: 2, cards, dismissed, updatedAt: homeLayoutDate(value.updatedAt) };
    if (isPlainObject(value.view)) {
        const columns = value.view.columns;
        read.view = { ...value.view, columns: isHomeColumns(columns) ? columns : 'auto' };
    }
    return read;
}

// ── Editing ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a card couldn't be added: an unknown type, a one-of-a-kind already there, the type's limit, or a full Home. */
export type HomeAddRefusal = 'unknown' | 'fixed' | 'on-home' | 'type-full' | 'home-full';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new instance id for a type that comes in many: `type-xxxx`, four base32 characters, not already in the list. */
export function newInstanceId(type: string, taken: ReadonlySet<string>, random: () => number = Math.random): string {
    for (;;) {
        let tail = '';
        for (let i = 0; i < 4; i++) tail += BASE32[Math.floor(random() * 32) % 32];
        const id = `${type}-${tail}`;
        if (!taken.has(id)) return id;
    }
}

/**
 * A card added to Home (§1.3): first, after any leading cards in `pinned` (a pinned Find your community stays on top).
 * A one-of-a-kind type already there, an instance type at its limit, a Home at 24, a fixed or unknown type: refused,
 * the layout unchanged. `settings` go through the type's reader. `now` stamps `updatedAt`.
 */
export function addCard(
    layout: HomeLayoutV2 | null,
    type: string,
    opts: { settings?: unknown; pinned?: readonly string[]; now?: number; random?: () => number } = {},
): { ok: true; layout: HomeLayoutV2; id: string } | { ok: false; refused: HomeAddRefusal } {
    const base = layout ?? defaultHomeLayout();
    const t = TYPES.get(type);
    if (!t) return { ok: false, refused: 'unknown' };
    if (t.fixed) return { ok: false, refused: 'fixed' };
    const sameType = base.cards.filter((c) => c.type === type).length;
    if (!t.multiple && sameType > 0) return { ok: false, refused: 'on-home' };
    if (t.multiple && sameType >= t.multiple.max) return { ok: false, refused: 'type-full' };
    if (base.cards.length >= HOME_FRAME_LIMITS.cards) return { ok: false, refused: 'home-full' };
    const id = t.multiple ? newInstanceId(type, new Set(base.cards.map((c) => c.id)), opts.random) : type;
    const card: HomeCardInstance = t.readSettings ? { id, type, settings: t.readSettings(opts.settings) } : { id, type };
    const pinned = new Set(opts.pinned ?? []);
    let at = 0;
    while (at < base.cards.length && pinned.has(base.cards[at].id)) at++;
    const cards = [...base.cards.slice(0, at), card, ...base.cards.slice(at)];
    return { ok: true, id, layout: { ...base, cards, updatedAt: new Date(opts.now ?? Date.now()).toISOString() } };
}

/** A card taken off Home: the instance goes, its settings and any dismissal with it. Unchanged when it isn't there. */
export function removeCard(layout: HomeLayoutV2 | null, id: string, now: number = Date.now()): HomeLayoutV2 {
    const base = layout ?? defaultHomeLayout();
    if (!base.cards.some((c) => c.id === id)) return base;
    const { [id]: _gone, ...dismissed } = base.dismissed;
    return { ...base, cards: base.cards.filter((c) => c.id !== id), dismissed, updatedAt: new Date(now).toISOString() };
}

/** A card moved one place up (-1) or down (+1) in the list. Unchanged at an end or when it isn't there. */
export function moveCard(layout: HomeLayoutV2 | null, id: string, delta: -1 | 1, now: number = Date.now()): HomeLayoutV2 {
    const base = layout ?? defaultHomeLayout();
    const from = base.cards.findIndex((c) => c.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= base.cards.length) return base;
    const cards = [...base.cards];
    [cards[from], cards[to]] = [cards[to], cards[from]];
    return { ...base, cards, updatedAt: new Date(now).toISOString() };
}

/**
 * Home as the tour leaves it (DESIGN-home-default-fable.md §2.3), in one layout write: Welcome goes and nothing is added,
 * since the cards are already there. A Home never saved is the default list less Welcome; a Home the member arranged is
 * kept as it was, less the card.
 */
export function endTourLayout(layout: HomeLayoutV2 | null, opts: { now?: number } = {}): HomeLayoutV2 {
    const base = layout ?? defaultHomeLayout();
    const { start: _gone, ...dismissed } = base.dismissed;
    return { ...base, cards: base.cards.filter((c) => c.type !== 'start'), dismissed, updatedAt: new Date(opts.now ?? Date.now()).toISOString() };
}

/**
 * The columns chosen on a wide screen (D1), dated now so the last write wins as for a move. Unchanged when it
 * is already the choice (no view is Auto). A newer app's other keys in the view are kept.
 */
export function setHomeColumns(layout: HomeLayoutV2 | null, columns: HomeColumns, now: number = Date.now()): HomeLayoutV2 {
    const base = layout ?? defaultHomeLayout();
    if (homeColumns(base) === columns) return base;
    return { ...base, view: { ...base.view, columns }, updatedAt: new Date(now).toISOString() };
}

/** The card's settings through its type's reader, or undefined for a type with none (or one this build doesn't know). */
export function cardSettings(card: HomeCardInstance): Record<string, unknown> | undefined {
    const reader = TYPES.get(card.type)?.readSettings;
    return reader ? reader(card.settings) : undefined;
}

// ── Asking ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Catalogue order, then id: a move in the list never changes it. Unknown types last (never asked anyway). */
export function compareForAsk(a: Pick<HomeCardInstance, 'id' | 'type'>, b: Pick<HomeCardInstance, 'id' | 'type'>): number {
    const ra = RANK.get(a.type) ?? Number.MAX_SAFE_INTEGER;
    const rb = RANK.get(b.type) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The instance ids to ask the node for (`cards=`), in catalogue order then id, so the same set is the same address
 * whatever the member's order and a repeat read can be a 304: the fixed two, every instance in the list whose type this
 * build knows and the node builds (`asks: 'node'`) and whose settings give it something to build (`asksWith`: a chat
 * card with no chat picked is not), and any `pinned` type (asked for whatever the list says). An unknown type is never
 * asked: this build couldn't draw its body.
 */
export function cardsToAsk(layout: HomeLayoutV2 | null, pinned: readonly string[] = []): string[] {
    const cards = layout?.cards ?? defaultCards();
    const want = new Map<string, Pick<HomeCardInstance, 'id' | 'type'>>();
    const add = (c: Pick<HomeCardInstance, 'id' | 'type' | 'settings'>) => {
        const t = TYPES.get(c.type);
        if (t?.asks !== 'node' || want.has(c.id)) return;
        if (t.asksWith && !t.asksWith(t.readSettings ? t.readSettings(c.settings) : {})) return;
        want.set(c.id, c);
    };
    for (const id of HOME_FIXED_TYPES) add({ id, type: id });
    for (const id of pinned) add({ id, type: id });
    for (const c of cards) add(c);
    return [...want.values()].sort(compareForAsk).map((c) => c.id);
}
