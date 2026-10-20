/**
 * The tool's one document (docs/tools-template.md step 3): its shape, its empty value and `read`, the one migration
 * function. Plain JSON with `v` at the top, at most 64 KB, kept on the phone with a private copy on the node. Photos are
 * refs to files on the phone, never bytes in here. When the shape changes: raise SCAFFOLD_DOC_VERSION, teach read() the
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

function readItem(raw: unknown): ScaffoldItem | null {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.addedAt !== 'string') return null;
    return { id: raw.id, name: [...raw.name].slice(0, SCAFFOLD_NAME_CHARS).join(''), addedAt: raw.addedAt };
}

/**
 * Any stored value as this build's document: tolerant, never throws, empty() for anything unreadable. A newer version
 * (from a newer app on another device) is read for what this build knows and every key is kept, so writing it back
 * loses nothing.
 */
export function readScaffoldDoc(raw: unknown): ScaffoldDoc {
    if (!isPlainObject(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) return emptyScaffoldDoc();
    const items = (Array.isArray(raw.items) ? raw.items : []).map(readItem).filter((i): i is ScaffoldItem => i !== null);
    return { ...raw, v: Math.max(raw.v, SCAFFOLD_DOC_VERSION), items: items.slice(0, SCAFFOLD_MAX_ITEMS) };
}
