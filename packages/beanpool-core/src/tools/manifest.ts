/**
 * The tool template's contract (scratch/tools/DESIGN-tool-template-fable.md §1.2, slice T0.1): what one tool is, as core
 * holds it. A tool is one manifest here (pure data and pure functions) plus a thin screen half in each app
 * (apps/native/tools/<id>/, apps/pwa/src/tools/<id>/). The Tools screen, the shelves, Home, the shop and the size check
 * read the manifest; the screens are the only platform code, and they reach the app only through the host (host.ts).
 *
 * Pure: no I/O, no React, no Node built-ins (the barrel is bundled for the phone, barrel-is-universal.test.ts). Nothing
 * here holds a class instance, so a manifest can later be JSON beside a sandboxed script (§5): a door kept open, not built.
 */
import type { ShowcaseFeature } from '../features.js';
import type { HomeNodeFacts } from '../home-frame.js';
import type { ShopCategory } from '../shops.js';
import type { PluralWord, WordKey } from '../words.js';

/** A tool's id: the store key (the node's member_tool_state.tool ≤ 24), the route param and the Home card type's tail. */
export type ToolId = string;
/**
 * 2 to 16 lowercase letters and hyphens, a letter at each end and never two hyphens together (each word between them is
 * a word of the id's names in code). `community:` and other prefixes stay free for runtime plugins (§5).
 */
export const TOOL_ID_PATTERN = /^(?=.{2,16}$)[a-z]+(?:-[a-z]+)*$/;

/** The three shelves of the Tools screen (round 2 §7): what you have, how you deal, how it's going. */
export type ToolShelf = 'stock' | 'trade' | 'books';
export const TOOL_SHELVES: readonly ToolShelf[] = ['stock', 'trade', 'books'];

/** Whose tool it is: a member's, an enterprise's (opened from its console with the enterprise as owner), or either. */
export type ToolOwner = 'member' | 'enterprise' | 'both';

/** What a tool may ask of the app. Each grants one host function (host.ts TOOL_PERMISSION_GRANTS) and no more. */
export const TOOL_PERMISSIONS = [
    'photos',        // pick a photo, kept on the device
    'camera',        // take a photo, kept on the device
    'place',         // the community's place, the member's rough area or the device's (sky.ts's rule); never sent
    'reminders',     // phone-local notifications from the manifest's due()
    'offer-door',    // open the Offer composer prefilled; the member taps Post
    'need-door',     // the same for a Need
    'event-door',    // the same for an event
    'deals',         // read the owner's deals on posts the tool listed
    'pricing-guide', // the node's pricing hint
    'posts',         // pause and resume the Offers the tool listed
    'node-copy',     // the private copy on the node (member_tool_state); the member's toggle, on by default
] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

/** The template's bounds, refused by toolManifestProblems (check.ts) and the size check (scripts/tools/budgets.json). */
export const TOOL_LIMITS = {
    /** Characters of an id: `tool-<id>` must fit Home's 24-character type (home-frame.ts HOME_FRAME_LIMITS.typeChars). */
    idChars: 16,
    /**
     * Bytes of a stored document, serialised as JSON (UTF-8), of a tool that names no bound of its own: what the node
     * keeps of it, and of every tool on a node from before a tool could name more (its answers' `max`).
     */
    docBytes: 65_536,
    /** The most a tool may name as its own bound (`doc.maxBytes`): the node's CHECK on member_tool_state.body. */
    docBytesMax: 131_072,
    /** Lines on the tool's Home card. */
    homeLines: 2,
    /** Reminders due() may return at once. */
    due: 10,
    /** Example rows in the empty state's "I'm starting out" door. */
    examples: 3,
} as const;

/**
 * One sentence with its values, drawn as t(key, values); a sentence with a count is a wordn('{n} thing', '{n} things')
 * pair with its count `n`, drawn as tn(n, key.one, key.other, values), so every language gets the form it needs.
 * toolLineText (line.ts) draws either. Fixed words, never member text in `key`.
 */
export interface ToolLine {
    key: WordKey | PluralWord;
    /** The count a wordn() pair is chosen by, written as its {n}: given with a pair, and only with one. */
    n?: number;
    values?: Record<string, string | number>;
    /** A screen of the tool this line opens (the manifest's `screens`). */
    screen?: string;
}

export interface ToolReminder {
    id: string;
    /** Its row in the tool's Settings. */
    name: WordKey;
    defaultOn: boolean;
}

/** One reminder due at a time, as due() returns it: the host schedules it as a local notification and cancels the rest. */
export interface ToolDue {
    reminder: string;
    at: number;
    key: WordKey;
    values?: Record<string, string>;
    screen?: string;
}

/**
 * The tool's one document: JSON with `v` at its top. `read` is the one migration function: whatever is stored (an older
 * `v`, a newer `v` from a newer app on another device, garbage) becomes this build's shape, never throwing; a newer `v`
 * is read with what this build knows and its unknown keys are kept whole on write, so two app versions sharing one node
 * copy never fight. Methods, not function properties, so a manifest of any document is a ToolManifest.
 */
export interface ToolDoc<D> {
    /** The shape this build writes. */
    version: number;
    empty(): D;
    /** Any stored value to this version: tolerant, never throws; an unreadable value is empty(). */
    read(raw: unknown): D;
    /**
     * Its own bound, at most TOOL_LIMITS.docBytesMax; none is TOOL_LIMITS.docBytes. The node keeps this much of it, and a
     * node that keeps less says so (toolDocMaxBytes). Over it, the tool's own sentence says why, never a silent drop.
     */
    maxBytes?: number;
}

export interface ToolManifest<D = unknown> {
    id: ToolId;
    /** Its name on the Tools screen, its header and its Home card's caption. */
    name: WordKey;
    /** One line of what it keeps, under the name. */
    line: WordKey;
    /** One emoji. No new fonts, ever. */
    icon: string;
    shelf: ToolShelf;
    /**
     * The shop categories whose shelves show it (core SHOP_CATEGORIES, the Market's), or every one: those whose nearest old
     * shop kind showed it (shops.ts SHOP_CATEGORY_KINDS `toolsLike`), for a tool from before categories.
     */
    categories: readonly ShopCategory[] | 'all';
    owner: ToolOwner;
    /** Whether a node of this kind can have it (default: everywhere, global included). */
    onNode?(facts: HomeNodeFacts): boolean;
    permissions: readonly ToolPermission[];
    doc: ToolDoc<D>;
    /** Its screens by name, `main` first; each app's half exports one component per name and the host opens no other. */
    screens: readonly string[];
    /** The Tools row's state line, or null for none. */
    row(doc: D, now: number): ToolLine | null;
    /**
     * Only for a tool that asks for `node-copy`: what its Settings say when switching the copy on finds the document more
     * than the server keeps (`maxBytes`, its answer's `max`), so nothing changed: how to make room, in the tool's own
     * words and never bytes. None: the template's own sentence.
     */
    tooBig?(doc: D, maxBytes: number): ToolLine;
    /**
     * Whether an open that finds the document empty shows the template's two doors first ("I already do this", "I'm
     * starting out"). Omitted or true: it does. False only for a tool whose first screen is worth opening on an empty
     * document, because it shows something other than the member's own records (Your garden's guide): both apps then open
     * its `main` screen straight away, on every open and from every door, with no examples card above it and no Home-card
     * offer inside the tool (the card is still in Home's Add a card). The tool's `examples` are then unused.
     */
    doors?: boolean;
    /** The empty state's "I'm starting out" door: three example rows, and the members' guide page it links to. */
    examples: readonly WordKey[];
    guide?: string;
    /** Only for a tool with something to say on Home. The card is offered once from inside the tool, never added by itself. */
    homeCard?: {
        /** Its line in the picker. */
        line: WordKey;
        /** What the card says now: at most TOOL_LIMITS.homeLines lines, worked out on the device. */
        lines(doc: D, now: number): ToolLine[];
    };
    /** Only for a tool that has something to say at a time (and asks for `reminders`). */
    reminders?: {
        list: readonly ToolReminder[];
        /** Everything due from now on, at most TOOL_LIMITS.due. */
        due(doc: D, now: number): ToolDue[];
    };
    /** Actions that need a node feature, for the 🏘️ marker (never a lock): e.g. { fee: 'beans' }. */
    needs?: Readonly<Record<string, ShowcaseFeature>>;
}
