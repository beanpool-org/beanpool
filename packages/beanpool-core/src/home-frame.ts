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
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */
import { PRICING_CATEGORIES } from './pricing-catalog.js';
import { readSkySettings } from './sky.js';

// ── The shape ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One card on a member's Home. `id` equals `type` for a one-of-a-kind card; an instance type's id is `type-xxxx`. */
export interface HomeCardInstance {
    id: string;
    type: string;
    /** The type's own settings, read by its `readSettings` (tolerant). Absent for a type with none. */
    settings?: Record<string, unknown>;
}

/** A member's Home as kept on their account (version 2). */
export interface HomeLayoutV2 {
    v: 2;
    /** The cards on Home, in the member's order. A card is on Home because it is here, and nowhere else. */
    cards: HomeCardInstance[];
    /** When the member put away a card that comes back on a schedule (only `safety`), by instance id. */
    dismissed: Record<string, string>;
    updatedAt: string | null;
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
}
/** The reader's role on this node as the node said it: null for none, undefined not heard. */
export type HomeReaderRole = 'owner' | 'admin' | 'moderator' | null | undefined;

/** The picker's groups, in their order: For you · Around you · Getting started. */
export type HomeCardGroup = 'you' | 'around' | 'start';
export const HOME_CARD_GROUPS: readonly { id: HomeCardGroup; name: string }[] = [
    { id: 'you', name: 'For you' },
    { id: 'around', name: 'Around you' },
    { id: 'start', name: 'Getting started' },
];

export interface HomeCardType {
    id: string;
    /** Its caption, its row in the picker and Edit home. Fixed words, never member text. */
    name: string;
    /** On the worldwide community, where it says something else ("Near you"). */
    globalName?: string;
    /** One line of what it shows, in the picker. */
    line: string;
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
}

/** The distances a saved search can be bounded to, in km. */
export const HOME_SEARCH_KMS = [1, 2, 5, 10, 25] as const;
/** The longest words a saved search keeps. */
export const HOME_SEARCH_MAX_CHARS = 40;
export type HomeSearchKind = 'offer' | 'need' | 'any';
export type HomeSearchSettings = { q: string; kind: HomeSearchKind; category?: string; km?: (typeof HOME_SEARCH_KMS)[number] };

const CATEGORY_IDS: ReadonlySet<string> = new Set(PRICING_CATEGORIES.map((c) => c.id));
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A saved search's settings, tolerant: words cut to 40 characters, an unknown kind is `any`, an unknown category or distance is none. */
export function readSearchSettings(raw: unknown): HomeSearchSettings {
    const s = isPlainObject(raw) ? raw : {};
    const q = typeof s.q === 'string' ? s.q.trim().slice(0, HOME_SEARCH_MAX_CHARS) : '';
    const kind: HomeSearchKind = s.kind === 'offer' || s.kind === 'need' ? s.kind : 'any';
    const out: HomeSearchSettings = { q, kind };
    if (typeof s.category === 'string' && CATEGORY_IDS.has(s.category)) out.category = s.category;
    if (typeof s.km === 'number' && (HOME_SEARCH_KMS as readonly number[]).includes(s.km)) out.km = s.km as HomeSearchSettings['km'];
    return out;
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
 * Every card type, in the catalogue's order (the order `cards=` names them in). Unknown features count as on, as the
 * apps read a node's features; the worldwide community has no Beans, deals, enterprise, Decide or invites (§1.2).
 */
export const HOME_CARD_TYPES: readonly HomeCardType[] = [
    { id: 'needs', name: 'Needs you', line: 'Things waiting on you, first.', group: 'you', fixed: true, asks: 'node', onNode: everywhere },
    {
        id: 'safety', name: 'Your way back in', line: 'A reminder to keep your 12 words safe.', group: 'start', asks: 'node',
        onNode: (a) => a.features.wordsDoor !== false || !!a.cards?.safety,
    },
    { id: 'find', name: 'Find your community', line: 'Communities near you, to join.', group: 'start', asks: 'node', onNode: (a) => a.profile === 'global' },
    { id: 'steps', name: 'First steps', line: 'Things to do in your first weeks.', group: 'start', asks: 'node', onNode: everywhere },
    { id: 'tips', name: 'Tips', line: 'One tip at a time on how things work.', group: 'start', asks: 'none', onNode: everywhere },
    { id: 'interests', name: 'What are you into?', line: 'Star what you like to see it first.', group: 'start', asks: 'none', onNode: everywhere },
    { id: 'deals', name: 'Your deals', line: 'Open deals and ones waiting on you.', group: 'you', asks: 'node', onNode: (a) => notGlobal(a) && a.features.escrow !== false },
    {
        id: 'enterprise', name: 'Your enterprise', line: 'Requests for the enterprise you keep.', group: 'you', asks: 'node',
        onNode: (a) => notGlobal(a) && a.features.enterprises !== false,
    },
    { id: 'events', name: 'Coming up', line: 'Events coming up soon.', group: 'around', asks: 'node', onNode: everywhere },
    { id: 'market', name: 'New in the Market', globalName: 'Near you', line: 'The newest listings near you.', group: 'around', asks: 'node', onNode: everywhere },
    {
        id: 'search', name: 'A saved search', line: 'Listings that match words you choose, near you.', group: 'around',
        multiple: { max: 5 }, asks: 'node', onNode: everywhere, readSettings: readSearchSettings,
    },
    { id: 'decide', name: 'Decide', line: 'Open Decisions and polls.', group: 'you', asks: 'node', onNode: (a) => notGlobal(a) && a.features.decisions !== false },
    { id: 'groups', name: 'Your groups', line: "What's new in your groups.", group: 'you', asks: 'node', onNode: everywhere },
    { id: 'joined', name: 'Who joined', line: 'People who joined this week.', group: 'around', asks: 'node', onNode: everywhere },
    { id: 'pulse', name: 'The Pulse', line: 'Links your neighbours shared.', group: 'around', asks: 'node', onNode: everywhere },
    // Worked out on the device (sky.ts) from the community's place or the member's, which every node can have: never asked.
    {
        id: 'sky', name: 'Sun and moon', line: 'Sunrise, sunset and the moon tonight.', group: 'around', asks: 'none', onNode: everywhere,
        readSettings: readSkySettings,
    },
    { id: 'beans', name: 'Your Beans', line: 'Your balance and room to spend.', group: 'you', asks: 'node', onNode: (a) => notGlobal(a) && a.features.beans !== false },
    { id: 'notices', name: 'From your community', line: "Notices from your community's admins.", group: 'you', asks: 'node', onNode: everywhere },
    {
        id: 'invite', name: 'Grow your community', line: 'Ways to invite people you know.', group: 'start', asks: 'none',
        onNode: (a, role) => notGlobal(a) && homeInvitesForReader(a.features, role),
    },
    { id: 'community', name: 'Your community', line: 'Your community at a glance.', group: 'you', fixed: true, asks: 'node', onNode: everywhere },
];

const TYPES: ReadonlyMap<string, HomeCardType> = new Map(HOME_CARD_TYPES.map((t) => [t.id, t]));
const RANK: ReadonlyMap<string, number> = new Map(HOME_CARD_TYPES.map((t, i) => [t.id, i]));

/** The registry's entry for a type, or undefined for one this build doesn't know (kept, not drawn, not built). */
export const homeCardType = (type: string): HomeCardType | undefined => TYPES.get(type);

/** The types always drawn and never in a member's list. */
export const HOME_FIXED_TYPES: readonly string[] = HOME_CARD_TYPES.filter((t) => t.fixed).map((t) => t.id);

/** The catalogue of version 1 (the eighteen one-of-a-kind ids today's apps know), in its default order. */
export const HOME_V1_CARD_IDS: readonly string[] = [
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups',
    'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
];

/** The newcomer's five (§3): the same on a local community and on the worldwide one. */
export const HOME_NEWCOMER_FIVE: readonly string[] = ['steps', 'tips', 'market', 'events', 'notices'];
/** Cards that ride along in the default list without counting: each shows only while its own rule says. */
const NEWCOMER_RIDERS: readonly string[] = ['safety', 'interests'];

/**
 * A newcomer's Home: the five, with "Your way back in" (shown only on its schedule) first and "What are you into?" (shown
 * while nothing is starred) after Tips. The same on both profiles: Find your community is pinned on global anyway.
 */
export function defaultCards(_profile: 'local' | 'global' | string = 'local'): HomeCardInstance[] {
    const ids = [NEWCOMER_RIDERS[0], HOME_NEWCOMER_FIVE[0], HOME_NEWCOMER_FIVE[1], NEWCOMER_RIDERS[1], ...HOME_NEWCOMER_FIVE.slice(2)];
    return ids.map((id) => ({ id, type: id }));
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

/**
 * A version-2 layout checked strictly, as the node takes a member's write: shape and bounds, never the type. Every bound
 * refuses the whole value with its problem. `updatedAt` is left as sent (null when absent); the caller stamps it.
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
 * (a malformed one, a repeated id or one past the 24th is dropped, never the whole); version 1 reads through
 * {@link translateV1}; anything else is null (the default Home).
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
    return { v: 2, cards, dismissed, updatedAt: homeLayoutDate(value.updatedAt) };
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
 * build knows and the node builds (`asks: 'node'`), and any `pinned` type (asked for whatever the list says). An unknown
 * type is never asked: this build couldn't draw its body.
 */
export function cardsToAsk(layout: HomeLayoutV2 | null, pinned: readonly string[] = []): string[] {
    const cards = layout?.cards ?? defaultCards();
    const want = new Map<string, Pick<HomeCardInstance, 'id' | 'type'>>();
    const add = (c: Pick<HomeCardInstance, 'id' | 'type'>) => {
        if (TYPES.get(c.type)?.asks === 'node' && !want.has(c.id)) want.set(c.id, c);
    };
    for (const id of HOME_FIXED_TYPES) add({ id, type: id });
    for (const id of pinned) add({ id, type: id });
    for (const c of cards) add(c);
    return [...want.values()].sort(compareForAsk).map((c) => c.id);
}
