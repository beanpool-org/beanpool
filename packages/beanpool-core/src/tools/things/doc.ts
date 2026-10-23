/**
 * The Tool shed's one document (scratch/tools/DESIGN-tool-template-fable.md §1.2, §3.1, slice T1.1):
 * what you own and might lend, and who has them. Plain JSON with `v` at the top, at most 128 KB,
 * kept on the phone, and with a private copy on the node when 'node-copy' is on.
 *
 * Photos are refs to files on the phone (or IndexedDB blobs on web), never bytes here.
 */

export const THINGS_DOC_VERSION = 1;
/**
 * The most the document takes, as JSON (UTF-8): its one bound, by size alone (Marty, 23 Oct 2026: "could we double it to
 * 128KB? and yes go by size"), so there is no count of things. A typical thing is about 240 bytes, so some 550 fit; at
 * every field's cap one is about 1.2 KB (about 3.9 KB in emoji), so some 110 do (33). Past it the write is refused, never cut,
 * and the screens say how many more fit (shed.ts shedRoom). A deleted thing takes none of it: a Delete keeps nothing
 * (shed.ts removeThing). A node from before it keeps 64 KB, and says so (toolDocMaxBytes).
 */
export const THINGS_DOC_BYTES = 131_072;
export const THINGS_NAME_CHARS = 80;
export const THINGS_CATEGORY_CHARS = 40;
export const THINGS_REPLACEMENT_VALUE_CHARS = 40;
export const THINGS_LEND_TERMS_CHARS = 300;
export const THINGS_OWNER_NOTE_CHARS = 500;

export type ThingCondition = 'good' | 'fair' | 'needs_care';

export interface ThingLentTo {
    name: string;
    since: string;
    backAround?: string;
    [key: string]: unknown;
}

export interface Thing {
    id: string;
    /** In the owner's own words (<= 80 chars). */
    name: string;
    category?: string;
    condition?: ThingCondition | string;
    /** In the lender's words (<= 40 chars). */
    replacementValue?: string;
    /** Conditions of lending (<= 300 chars). */
    lendTerms?: string;
    /** Maximum loan period in days (1..365). */
    lendMaxDays?: number;
    /** Private note for the owner (<= 500 chars). */
    ownerNote?: string;
    /** Local photo reference / filename, never raw bytes. */
    photo?: string;
    /** Offer post id when listed in the shop. */
    postId?: string;
    /**
     * The Offer taken out of the shop (paused, not ended), so listing the thing again puts the same Offer back
     * (DESIGN-tool-library-fable.md §2.4: list "or resumes a paused one"). Never set beside `postId`.
     */
    pausedPostId?: string;
    /** Current borrower details when lent out. */
    lentTo?: ThingLentTo;
    createdAt: string;
    updatedAt: string;
    /**
     * Deleted, by a build that kept a tombstone (#2373's) or a newer version's. This build never writes one (a Delete takes
     * the thing out), drops one of its own version or older on read (readThingsDoc), and keeps a newer version's as it was.
     */
    gone?: boolean;
    [key: string]: unknown;
}

declare const unreadThing: unique symbol;
/**
 * An item of a newer version's list that this build can't read (not an object, or no string id and name), kept as it was
 * and where it was, so writing the document back loses nothing. This build never makes one; {@link isThing} tells a
 * Thing from it, and nothing shows, counts or edits it.
 */
export type UnreadThing = { readonly [unreadThing]: true };

export interface ThingsDoc {
    v: number;
    /** This build's things; on a newer version, also the items it can't read, each in its place (readThingsDoc). */
    things: (Thing | UnreadThing)[];
    [key: string]: unknown;
}

export const emptyThingsDoc = (): ThingsDoc => ({ v: THINGS_DOC_VERSION, things: [] });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether an item of the list is one this build reads, not a newer version's {@link UnreadThing}. */
export const isThing = (t: unknown): t is Thing => isPlainObject(t) && typeof t.id === 'string' && typeof t.name === 'string';

/** A thing the member still has (not `gone`): what every count counts. */
export const isLiveThing = (t: unknown): t is Thing => isThing(t) && t.gone !== true;

/**
 * Whether a thing's `lentTo` is one this build reads (an object with a string name and since). A newer version keeps a
 * `lentTo` this build can't read as it was, so the counts, lines and reminders ask this, never `lentTo != null`.
 */
export const isLentTo = (v: unknown): v is ThingLentTo => isPlainObject(v) && typeof v.name === 'string' && typeof v.since === 'string';

function readLentTo(raw: unknown, ours: boolean): ThingLentTo | undefined {
    if (!isLentTo(raw)) return undefined;
    const name = ours ? [...raw.name].slice(0, THINGS_NAME_CHARS).join('') : raw.name;
    const since = raw.since;
    const backAround = typeof raw.backAround === 'string' ? raw.backAround : undefined;
    const {
        name: _name,
        since: _since,
        backAround: _backAround,
        ...unknownKeys
    } = raw;
    return {
        ...(ours ? unknownKeys : raw),
        name,
        since,
        ...(backAround !== undefined ? { backAround } : {}),
    };
}

/** One item, its unknown keys kept; held to this build's bounds only when `ours` (this build's version or older). */
function readThing(raw: unknown, ours: boolean): Thing | null {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    const name = ours ? [...raw.name].slice(0, THINGS_NAME_CHARS).join('') : raw.name;
    const category = typeof raw.category === 'string' ? (ours ? [...raw.category].slice(0, THINGS_CATEGORY_CHARS).join('') : raw.category) : undefined;
    const condition = typeof raw.condition === 'string' ? raw.condition : undefined;
    const replacementValue = typeof raw.replacementValue === 'string'
        ? (ours ? [...raw.replacementValue].slice(0, THINGS_REPLACEMENT_VALUE_CHARS).join('') : raw.replacementValue)
        : undefined;
    const lendTerms = typeof raw.lendTerms === 'string'
        ? (ours ? [...raw.lendTerms].slice(0, THINGS_LEND_TERMS_CHARS).join('') : raw.lendTerms)
        : undefined;
    const lendMaxDays = typeof raw.lendMaxDays === 'number' && Number.isInteger(raw.lendMaxDays) && raw.lendMaxDays >= 1 && raw.lendMaxDays <= 365
        ? raw.lendMaxDays
        : undefined;
    const ownerNote = typeof raw.ownerNote === 'string'
        ? (ours ? [...raw.ownerNote].slice(0, THINGS_OWNER_NOTE_CHARS).join('') : raw.ownerNote)
        : undefined;
    const photo = typeof raw.photo === 'string' ? raw.photo : undefined;
    const postId = typeof raw.postId === 'string' ? raw.postId : undefined;
    const pausedPostId = typeof raw.pausedPostId === 'string' ? raw.pausedPostId : undefined;
    const lentTo = readLentTo(raw.lentTo, ours);
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
    const gone = raw.gone === true ? true : undefined;

    const {
        id: _id,
        name: _name,
        category: _cat,
        condition: _cond,
        replacementValue: _rep,
        lendTerms: _terms,
        lendMaxDays: _lmd,
        ownerNote: _note,
        photo: _photo,
        postId: _post,
        pausedPostId: _paused,
        lentTo: _lent,
        createdAt: _ca,
        updatedAt: _ua,
        gone: _gone,
        ...unknownKeys
    } = raw;

    return {
        ...(ours ? unknownKeys : raw),
        id: raw.id,
        name,
        ...(category !== undefined ? { category } : {}),
        ...(condition !== undefined ? { condition } : {}),
        ...(replacementValue !== undefined ? { replacementValue } : {}),
        ...(lendTerms !== undefined ? { lendTerms } : {}),
        ...(lendMaxDays !== undefined ? { lendMaxDays } : {}),
        ...(ownerNote !== undefined ? { ownerNote } : {}),
        ...(photo !== undefined ? { photo } : {}),
        ...(postId !== undefined ? { postId } : {}),
        ...(pausedPostId !== undefined ? { pausedPostId } : {}),
        ...(lentTo !== undefined ? { lentTo } : {}),
        createdAt,
        updatedAt,
        ...(gone !== undefined ? { gone } : {}),
    };
}

/**
 * Any stored value as this build's document: tolerant, never throws, empty() for anything unreadable.
 * This build's version and older are held to its fields' bounds. A newer version (from a newer app on another
 * device) is read for what this build knows and kept whole, every key at the top and on each item, every
 * field past this build's bound, and every item this build can't read (an {@link UnreadThing}, left as it
 * was in its place), so writing it back loses nothing; the bounds of a newer version are the newer app's.
 * Every thing is kept, however many: the document's one bound is its size (THINGS_DOC_BYTES). A thing an earlier build
 * kept as a tombstone (`gone`) is dropped from this build's version and older, so the next write gives its room back:
 * nothing reads one (the sync is of the whole document), and its thing is never shown or counted either way.
 */
export function readThingsDoc(raw: unknown): ThingsDoc {
    if (!isPlainObject(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) {
        return emptyThingsDoc();
    }
    const ours = raw.v <= THINGS_DOC_VERSION;
    const rawThings = Array.isArray(raw.things) ? raw.things : [];
    // This build's version and older drop what can't be read, and what is gone; a newer version's list keeps both, as
    // they were, in their places.
    const things = rawThings.flatMap((t): (Thing | UnreadThing)[] => {
        const read = readThing(t, ours);
        if (read) return ours && read.gone ? [] : [read];
        return ours ? [] : [t as UnreadThing];
    });
    return {
        ...raw,
        v: Math.max(raw.v, THINGS_DOC_VERSION),
        things,
    };
}
