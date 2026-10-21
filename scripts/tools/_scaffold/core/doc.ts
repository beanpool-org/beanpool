/**
 * The tool's one document (docs/tools-template.md step 3): its shape, its empty value and `read`, the one migration
 * function. Plain JSON with `v` at the top, at most 64 KB, kept on the phone, and with a private copy on the node once the
 * manifest's permissions include 'node-copy' (a copy taken from the node is read through read() too). Photos are refs to
 * files on the phone, never bytes in here. When the shape changes: raise SCAFFOLD_DOC_VERSION, teach read() the
 * old one, and add a stored value of the new version to fixtures.ts (keep every old one).
 */

export const SCAFFOLD_DOC_VERSION = 1;
/** The most items the document keeps, which keeps it under its byte bound. */
export const SCAFFOLD_MAX_ITEMS = 100;
export const SCAFFOLD_NAME_CHARS = 80;

export interface ScaffoldItem {
    id: string;
    /** In the member's own words. */
    name: string;
    addedAt: string;
}

export interface ScaffoldDoc {
    v: number;
    items: ScaffoldItem[];
}

export const emptyScaffoldDoc = (): ScaffoldDoc => ({ v: SCAFFOLD_DOC_VERSION, items: [] });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One item, its unknown keys kept; held to this build's bounds only when `ours` (this build's version or older). */
function readItem(raw: unknown, ours: boolean): ScaffoldItem | null {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.addedAt !== 'string') return null;
    const name = ours ? [...raw.name].slice(0, SCAFFOLD_NAME_CHARS).join('') : raw.name;
    return { ...raw, id: raw.id, name, addedAt: raw.addedAt };
}

/**
 * Any stored value as this build's document: tolerant, never throws, empty() for anything unreadable. This build's
 * version and older are held to its bounds. A newer version (from a newer app on another device) is read for what this
 * build knows and kept whole, every key at the top and on each item and every item past this build's bound, so writing
 * it back loses nothing; the bounds of a newer version are the newer app's.
 */
export function readScaffoldDoc(raw: unknown): ScaffoldDoc {
    if (!isPlainObject(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) return emptyScaffoldDoc();
    const ours = raw.v <= SCAFFOLD_DOC_VERSION;
    const items = (Array.isArray(raw.items) ? raw.items : []).map((i) => readItem(i, ours)).filter((i): i is ScaffoldItem => i !== null);
    return { ...raw, v: Math.max(raw.v, SCAFFOLD_DOC_VERSION), items: ours ? items.slice(0, SCAFFOLD_MAX_ITEMS) : items };
}
