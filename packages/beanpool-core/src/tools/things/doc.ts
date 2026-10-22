/**
 * The Tool shed's one document (scratch/tools/DESIGN-tool-template-fable.md §1.2, §3.1, slice T1.1):
 * what you own and might lend, and who has them. Plain JSON with `v` at the top, at most 64 KB,
 * kept on the phone, and with a private copy on the node when 'node-copy' is on.
 *
 * Photos are refs to files on the phone (or IndexedDB blobs on web), never bytes here.
 */

export const THINGS_DOC_VERSION = 1;
/** The most items the document keeps, which keeps it under its byte bound. */
export const THINGS_MAX_ITEMS = 100;
export const THINGS_NAME_CHARS = 80;
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
    /** Current borrower details when lent out. */
    lentTo?: ThingLentTo;
    createdAt: string;
    updatedAt: string;
    gone?: boolean;
    [key: string]: unknown;
}

export interface ThingsDoc {
    v: number;
    things: Thing[];
    [key: string]: unknown;
}

export const emptyThingsDoc = (): ThingsDoc => ({ v: THINGS_DOC_VERSION, things: [] });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readLentTo(raw: unknown, ours: boolean): ThingLentTo | undefined {
    if (!isPlainObject(raw) || typeof raw.name !== 'string' || typeof raw.since !== 'string') return undefined;
    const name = ours ? [...raw.name].slice(0, THINGS_NAME_CHARS).join('') : raw.name;
    const since = raw.since;
    const backAround = typeof raw.backAround === 'string' ? raw.backAround : undefined;
    return {
        ...raw,
        name,
        since,
        ...(backAround !== undefined ? { backAround } : {}),
    };
}

/** One item, its unknown keys kept; held to this build's bounds only when `ours` (this build's version or older). */
function readThing(raw: unknown, ours: boolean): Thing | null {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    const name = ours ? [...raw.name].slice(0, THINGS_NAME_CHARS).join('') : raw.name;
    const category = typeof raw.category === 'string' ? (ours ? [...raw.category].slice(0, 40).join('') : raw.category) : undefined;
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
    const lentTo = readLentTo(raw.lentTo, ours);
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
    const gone = raw.gone === true ? true : undefined;

    return {
        ...raw,
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
        ...(lentTo !== undefined ? { lentTo } : {}),
        createdAt,
        updatedAt,
        ...(gone !== undefined ? { gone } : {}),
    };
}

/**
 * Any stored value as this build's document: tolerant, never throws, empty() for anything unreadable.
 * This build's version and older are held to its bounds. A newer version (from a newer app on another
 * device) is read for what this build knows and kept whole, every key at the top and on each item and
 * every item past this build's bound, so writing it back loses nothing; the bounds of a newer version
 * are the newer app's.
 */
export function readThingsDoc(raw: unknown): ThingsDoc {
    if (!isPlainObject(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) {
        return emptyThingsDoc();
    }
    const ours = raw.v <= THINGS_DOC_VERSION;
    const rawThings = Array.isArray(raw.things) ? raw.things : [];
    const things = rawThings
        .map((t) => readThing(t, ours))
        .filter((t): t is Thing => t !== null);

    return {
        ...raw,
        v: Math.max(raw.v, THINGS_DOC_VERSION),
        things: ours ? things.slice(0, THINGS_MAX_ITEMS) : things,
    };
}
