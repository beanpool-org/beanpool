/**
 * A member's Home, kept on their account: which cards they moved, hid or dismissed (`home.layout`) and the categories they
 * starred (`interests`). Two keys of member_preferences (design: scratch/global-node/DESIGN-home-dashboard-fable.md §4.2,
 * §4.3; slice H1), saved through setMemberPreferences and served by getMemberPreferences to their owner alone.
 *
 * - **Unknown ids are dropped, never refused.** A phone newer than the node knows cards and categories the node doesn't, and
 *   one older doesn't know the node's newest: either way the rest of what it sent is kept. Repeats are dropped too.
 * - **Bounded before anything is dropped.** More than 32 ids in a list of the layout (or 32 dismissals), or more than 17
 *   interests, is refused whole, with a sentence; so is any shape that isn't the one below, or a date that isn't one.
 * - **`needs` and `community` can't be hidden or dismissed** (the card that costs a member something if missed, and the one
 *   that holds Edit home), so either is dropped from `hidden` and `dismissed`. `find`'s first 30 days on the global node are
 *   the Home route's to honour: it is stored like any other card.
 * - **The last write wins by `updatedAt`.** A layout older than the one kept leaves it in place (a phone that edited
 *   offline, then reached the node after the web app had saved a newer one). A date in the future is held to the node's
 *   now, so a phone whose clock runs ahead can't outlast every later layout; one sent without a date is stamped now.
 * - **Read through the same checks.** A stored value is parsed and checked again on every read: the setter once stored any
 *   key it was given, a standby holds whatever its main server held, and the catalogue may shrink. A value that isn't a
 *   layout or a list is served as nothing.
 * - **Interests carry the node's own stamp** (`interestsUpdatedAt`, a third row beside them, never taken from a body): when
 *   the list last changed here. An app compares it with the stamp its own unsaved change was made on, so an older list
 *   kept in one browser never overwrites a newer one set on another device (PR #1479's review). A save of the same list
 *   leaves it; interests stored before the stamp read as stamped at 1970-01-01.
 *
 * Privacy: a layout says what someone cares about. It is never on the members list, a profile, or any read but its owner's.
 * The rows travel to a standby inside the member's row, as every preference does (replication-manifest.ts).
 */
import { PRICING_CATEGORIES } from '@beanpool/core';
import { db } from '../db/db.js';

export const HOME_LAYOUT_PREF_KEY = 'home.layout';
export const INTERESTS_PREF_KEY = 'interests';
/** When the interests last changed, stamped by the node beside them. Not a key an app may send. */
export const INTERESTS_STAMP_PREF_KEY = 'interests.updatedAt';
/** The preference keys this module owns, as the apps send and read them (and as they are stored). */
export const HOME_PREFERENCE_KEYS: readonly string[] = [HOME_LAYOUT_PREF_KEY, INTERESTS_PREF_KEY];

/** Every card Home can show, in the design's default order (§3.1). A member can't make a card; the catalogue is the catalogue. */
export const HOME_CARD_IDS = [
    'needs', 'safety', 'find', 'steps', 'tips', 'interests', 'deals', 'enterprise', 'events', 'market', 'decide', 'groups',
    'joined', 'pulse', 'beans', 'notices', 'invite', 'community',
] as const;
export type HomeCardId = (typeof HOME_CARD_IDS)[number];

/** The cards a member can't hide (or dismiss): `needs`, and `community`, which carries Edit home. */
export const UNHIDEABLE_HOME_CARDS: readonly HomeCardId[] = ['needs', 'community'];

/** The category ids a member can star: the 17 the Market and the composer use. */
export const INTEREST_IDS: readonly string[] = PRICING_CATEGORIES.map((c) => c.id);

/** The most ids a list of the layout (order, hidden) or its dismissals may carry, counted before anything is dropped. */
export const MAX_LAYOUT_IDS = 32;
/** The most interests a member may send, counted before anything is dropped: one of each category. */
export const MAX_INTERESTS = INTEREST_IDS.length;

/** A member's Home layout as it is stored and served. */
export interface HomeLayout {
    v: 1;
    /** Cards in the member's order; a card not named keeps its place in the default order after these. */
    order: HomeCardId[];
    hidden: HomeCardId[];
    /** When the member dismissed a card that comes back on a schedule (the `safety` card), by card. */
    dismissed: Partial<Record<HomeCardId, string>>;
    updatedAt: string;
}

export const HOME_LAYOUT_SHAPE_MESSAGE =
    'A Home layout is { v: 1, order: [card ids], hidden: [card ids], dismissed: { card id: date }, updatedAt: date }.';
export const HOME_LAYOUT_TOO_MANY_MESSAGE = `A Home layout names at most ${MAX_LAYOUT_IDS} cards in each list.`;
export const HOME_LAYOUT_DATE_MESSAGE = 'A date in a Home layout is a date and time, as 2026-10-02T15:40:00.000Z.';
export const INTERESTS_SHAPE_MESSAGE = 'Interests are a list of category ids, such as ["food", "garden"].';
export const INTERESTS_TOO_MANY_MESSAGE = `Interests name at most ${MAX_INTERESTS} categories, one of each.`;
export const HOME_MEMBERS_ONLY_MESSAGE = 'Only a member of this community keeps a Home here.';

const CARDS: ReadonlySet<string> = new Set(HOME_CARD_IDS);
const UNHIDEABLE: ReadonlySet<string> = new Set(UNHIDEABLE_HOME_CARDS);
const CATEGORIES: ReadonlySet<string> = new Set(INTEREST_IDS);
/** The longest date text taken: an ISO date with a six-digit year and an offset is 35 characters. */
const MAX_DATE_LENGTH = 40;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A date as the layout keeps it (UTC ISO), or null for anything that isn't text naming a real moment. */
function isoDate(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DATE_LENGTH) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The known ids of `list`, each once, in the order sent. `strict`: a list that isn't one, or an entry that isn't text, throws. */
function knownIds(list: unknown, known: ReadonlySet<string>, strict: { shape: string; max: number; tooMany: string } | null): string[] {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
        if (strict) throw new Error(strict.shape);
        return [];
    }
    if (strict && list.length > strict.max) throw new Error(strict.tooMany);
    const out: string[] = [];
    for (const id of list) {
        if (typeof id !== 'string') {
            if (strict) throw new Error(strict.shape);
            continue;
        }
        if (known.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
}

/**
 * The layout as kept: unknown ids and repeats dropped, `needs` and `community` never hidden or dismissed. `strict` (a
 * member's write) refuses a shape, a size or a date that is wrong; otherwise (a stored value) such parts are dropped and
 * only a value that isn't a version-1 layout at all is null.
 */
function layoutOf(value: unknown, strict: boolean, now: Date): HomeLayout | null {
    const refuse = (message: string): null => {
        if (strict) throw new Error(message);
        return null;
    };
    if (!isPlainObject(value)) return refuse(HOME_LAYOUT_SHAPE_MESSAGE);
    if (value.v !== undefined && value.v !== 1) return refuse(HOME_LAYOUT_SHAPE_MESSAGE);
    const lists = strict ? { shape: HOME_LAYOUT_SHAPE_MESSAGE, max: MAX_LAYOUT_IDS, tooMany: HOME_LAYOUT_TOO_MANY_MESSAGE } : null;
    const order = knownIds(value.order, CARDS, lists) as HomeCardId[];
    const hidden = knownIds(value.hidden, CARDS, lists).filter((id) => !UNHIDEABLE.has(id)) as HomeCardId[];

    const dismissed: Partial<Record<HomeCardId, string>> = {};
    if (value.dismissed !== undefined) {
        if (!isPlainObject(value.dismissed)) {
            if (strict) throw new Error(HOME_LAYOUT_SHAPE_MESSAGE);
        } else {
            const entries = Object.entries(value.dismissed);
            if (strict && entries.length > MAX_LAYOUT_IDS) throw new Error(HOME_LAYOUT_TOO_MANY_MESSAGE);
            for (const [id, at] of entries) {
                // An id the node doesn't know is dropped whatever it holds: a newer app's own kind of entry.
                if (!CARDS.has(id)) continue;
                const when = isoDate(at);
                if (when === null && strict) throw new Error(HOME_LAYOUT_DATE_MESSAGE);
                if (when !== null && !UNHIDEABLE.has(id)) dismissed[id as HomeCardId] = when;
            }
        }
    }

    let updatedAt: string;
    if (value.updatedAt === undefined) {
        updatedAt = strict ? now.toISOString() : new Date(0).toISOString();
    } else {
        const when = isoDate(value.updatedAt);
        if (when === null && strict) throw new Error(HOME_LAYOUT_DATE_MESSAGE);
        updatedAt = when ?? new Date(0).toISOString();
    }
    // A clock ahead of the node's is held to the node's now: its layout would otherwise win over every later one.
    if (strict && Date.parse(updatedAt) > now.getTime()) updatedAt = now.toISOString();
    return { v: 1, order, hidden, dismissed, updatedAt };
}

/** A member's layout, as they sent it, made what is kept. THROWS a sentence for the member on a body it refuses. */
export function parseHomeLayout(value: unknown, now: Date = new Date()): HomeLayout {
    return layoutOf(value, true, now) as HomeLayout;
}

/** A member's interests, as they sent them, made what is kept. THROWS a sentence for the member on a body it refuses. */
export function parseInterests(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error(INTERESTS_SHAPE_MESSAGE);
    return knownIds(value, CATEGORIES, { shape: INTERESTS_SHAPE_MESSAGE, max: MAX_INTERESTS, tooMany: INTERESTS_TOO_MANY_MESSAGE });
}

/** A stored layout through the same checks, or null when it isn't one. */
export function readStoredHomeLayout(stored: string | null | undefined): HomeLayout | null {
    if (typeof stored !== 'string') return null;
    try {
        return layoutOf(JSON.parse(stored), false, new Date());
    } catch {
        return null;
    }
}

/** Stored interests through the same checks, or null when they aren't a list. */
export function readStoredInterests(stored: string | null | undefined): string[] | null {
    if (typeof stored !== 'string') return null;
    try {
        const list = JSON.parse(stored);
        return Array.isArray(list) ? knownIds(list, CATEGORIES, null) : null;
    } catch {
        return null;
    }
}

function storedValue(publicKey: string, key: string): string | undefined {
    return (db.prepare('SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?').get(publicKey, key) as
        { pref_value: string } | undefined)?.pref_value;
}

/** This member's Home layout, or null when they have never saved one (their Home is the default). For their own reads only. */
export function getHomeLayout(publicKey: string): HomeLayout | null {
    return readStoredHomeLayout(storedValue(publicKey, HOME_LAYOUT_PREF_KEY));
}

/** This member's interests, or null when they have never saved any. For their own reads only. */
export function getInterests(publicKey: string): string[] | null {
    return readStoredInterests(storedValue(publicKey, INTERESTS_PREF_KEY));
}

/**
 * When this member's interests last changed here, or null when they have none kept. Interests stored before the node
 * stamped them read as 1970-01-01, a stamp like any other until their next change. For their own reads only.
 */
export function getInterestsUpdatedAt(publicKey: string): string | null {
    if (getInterests(publicKey) === null) return null;
    return isoDate(storedValue(publicKey, INTERESTS_STAMP_PREF_KEY)) ?? new Date(0).toISOString();
}

/**
 * The Home keys of a preferences body, checked and made what is kept, ready for setMemberPreferences to write inside its
 * transaction: `[key, stored value]` for each, the layout left out when the one kept is newer (last write wins). THROWS a
 * sentence for the member on a body it refuses, before anything is written.
 */
export function homePreferenceWrites(publicKey: string, preferences: Record<string, unknown>, now: Date = new Date()): [string, string][] {
    const writes: [string, string][] = [];
    if (Object.prototype.hasOwnProperty.call(preferences, HOME_LAYOUT_PREF_KEY)) {
        const layout = parseHomeLayout(preferences[HOME_LAYOUT_PREF_KEY], now);
        const kept = getHomeLayout(publicKey);
        if (!kept || Date.parse(layout.updatedAt) >= Date.parse(kept.updatedAt)) writes.push([HOME_LAYOUT_PREF_KEY, JSON.stringify(layout)]);
    }
    if (Object.prototype.hasOwnProperty.call(preferences, INTERESTS_PREF_KEY)) {
        const list = parseInterests(preferences[INTERESTS_PREF_KEY]);
        writes.push([INTERESTS_PREF_KEY, JSON.stringify(list)]);
        // Stamped when the list changes, or was never stamped: always later than the stamp before it, so two changes in
        // the same millisecond still differ.
        const kept = getInterests(publicKey);
        const keptAt = isoDate(storedValue(publicKey, INTERESTS_STAMP_PREF_KEY));
        if (!keptAt || !kept || JSON.stringify(kept) !== JSON.stringify(list)) {
            const after = keptAt ? Date.parse(keptAt) + 1 : -Infinity;
            writes.push([INTERESTS_STAMP_PREF_KEY, new Date(Math.max(now.getTime(), after)).toISOString()]);
        }
    }
    return writes;
}

/** A member's Home keys as served: each one saved, through the checks; the interests with the node's stamp for them. */
export type OwnHomePreferences = { 'home.layout'?: HomeLayout; interests?: string[]; interestsUpdatedAt?: string };

/** The Home keys this member has, through the checks, for their own read: a key never saved (or unreadable) is absent. */
export function ownHomePreferences(publicKey: string): OwnHomePreferences {
    const out: OwnHomePreferences = {};
    const layout = getHomeLayout(publicKey);
    if (layout) out[HOME_LAYOUT_PREF_KEY] = layout;
    const interests = getInterests(publicKey);
    if (interests) {
        out[INTERESTS_PREF_KEY] = interests;
        out.interestsUpdatedAt = getInterestsUpdatedAt(publicKey) ?? undefined;
    }
    return out;
}

/**
 * After a save, what is kept of each Home key the body named, for the save's answer: the app learns in the same round trip
 * what the node dropped, and which layout won.
 */
export function homePreferencesNamed(publicKey: string, preferences: unknown): OwnHomePreferences {
    if (!isPlainObject(preferences)) return {};
    const own = ownHomePreferences(publicKey);
    const out: OwnHomePreferences = {};
    if (Object.prototype.hasOwnProperty.call(preferences, HOME_LAYOUT_PREF_KEY) && own['home.layout']) out['home.layout'] = own['home.layout'];
    if (Object.prototype.hasOwnProperty.call(preferences, INTERESTS_PREF_KEY) && own.interests) {
        out.interests = own.interests;
        out.interestsUpdatedAt = own.interestsUpdatedAt;
    }
    return out;
}
