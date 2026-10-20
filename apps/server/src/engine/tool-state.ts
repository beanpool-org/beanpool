/**
 * The tool store (slice S2 of scratch/tools/DESIGN-shops-and-tools-fable.md, §9.3 to §9.5; the tool template's one store,
 * scratch/tools/DESIGN-tool-template-fable.md §1.6): each tool's private copy of its owner's document, kept by the
 * community so a second phone, or the same phone after a take-over, gets it back. Marty, 19 Oct 2026 (answer 3): the copy
 * is on by default with a toggle to turn it off, on global too, and private photos stay on the phone. The apps switch it
 * on in the template's T0.4; until then nothing writes here.
 *
 * - One row per owner and tool (member_tool_state): the owner is a member, or an enterprise for its tools, which only its
 *   keepers read and write (routes/tools.ts). The owner comes from the signature, or the enterprise from the path, never
 *   from the body.
 * - The document is the device's, written whole, last writer wins: a JSON object with its own `v`, which the node never
 *   reads. At most TOOL_STATE_MAX_BYTES as stored; over it the write is refused with a sentence, never cut short.
 * - The tool's id is 1 to 24 of a-z, 0-9 and '-' (the template's ids are at most 16, §1.2); `community:` is kept for the
 *   runtime plugins a community may add later (template §5), refused here in a sentence of its own.
 * - Private: no list, search, Home answer to another member, pooled count or admin screen reads it. The community's
 *   operator could read the database, as for everything on it; the apps say so once, under the toggle.
 *
 * ## A standby holds every copy
 *
 * A plain table (engine/replication-manifest.ts): its rows travel verbatim, watermarked on `updated_at`, and a delete
 * travels as a tombstone keyed `<owner>|<tool>`. A standby deletes a row stamped no later than a tombstone for it and
 * keeps one stamped after (engine/sync.ts), so each write here is stamped after the row it replaces and after the tool's
 * tombstone (stampFor), and each tombstone no earlier than the row it deletes: a delete never comes back, and a copy
 * written again after it stays, in either order of arrival, even within one millisecond.
 *
 * ## What one owner can make this node keep
 *
 * At most TOOL_STATE_TOOLS_MAX different tools, counting those deleted within the tombstones' 30 days, so at most that many
 * rows of 64 KB and that many tombstones, whatever they send. Each write is also one of the signer's day of signed writes
 * (the gateway's day budget, config/writer-limits.ts signedWritesPerDay), or the enterprise's for a keeper's. A delete
 * of a tool with no copy writes nothing.
 */
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';

/** The most a tool's document may take as stored, as UTF-8 (the schema's CHECK on member_tool_state.body). */
export const TOOL_STATE_MAX_BYTES = 65_536;

/**
 * The most different tools one owner keeps copies of, counting those deleted within the tombstones' 30 days. The
 * catalogue has thirteen (DESIGN-shops-and-tools-fable.md §7); this is far past anyone's use, and it bounds the rows and
 * the tombstones one owner can make.
 */
export const TOOL_STATE_TOOLS_MAX = 32;

/** A tool's id as the store keeps it. */
export const TOOL_ID = /^[a-z0-9-]{1,24}$/;

/** The prefix kept for a community's runtime plugins (DESIGN-tool-template-fable.md §5): no built-in tool takes it. */
export const RESERVED_TOOL_PREFIX = 'community:';

export class ToolStateRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'ToolStateRefusal';
    }
}

export interface ToolState {
    tool: string;
    /** The document as the device last wrote it. */
    doc: Record<string, unknown>;
    /** When this server stored it: what the apps reconcile by (the template's `synced_at`). */
    updatedAt: string;
    /** Its size as stored. */
    bytes: number;
}

const TABLE = 'member_tool_state';
const iso = (ms: number) => new Date(ms).toISOString();
const rowKey = (owner: string, tool: string) => `${owner}|${tool}`;

/** Why `tool` is no tool's id here, in a sentence, or null when it is one. */
export function toolIdRefusal(tool: unknown): ToolStateRefusal | null {
    if (typeof tool === 'string' && tool.startsWith(RESERVED_TOOL_PREFIX)) {
        return new ToolStateRefusal(400, 'tool_reserved', `Tool names starting "${RESERVED_TOOL_PREFIX}" are kept for tools a community adds later.`);
    }
    if (typeof tool !== 'string' || !TOOL_ID.test(tool)) {
        return new ToolStateRefusal(400, 'bad_tool', "A tool's name is 1 to 24 lower-case letters, digits and hyphens.");
    }
    return null;
}

function assertToolId(tool: string): void {
    const refusal = toolIdRefusal(tool);
    if (refusal) throw refusal;
}

/** The owner's copy of this tool's document, or null when none is kept. */
export function readToolState(owner: string, tool: string): ToolState | null {
    assertToolId(tool);
    const row = db.prepare(`SELECT body, updated_at FROM ${TABLE} WHERE public_key = ? AND tool = ?`).get(owner, tool) as
        { body: string; updated_at: string } | undefined;
    if (!row) return null;
    let doc: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(row.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
    } catch { /* only this module writes the body, as JSON: an unreadable one reads as an empty document */ }
    return { tool, doc, updatedAt: row.updated_at, bytes: Buffer.byteLength(row.body, 'utf8') };
}

/** A stamp of this table: its row's, or its tombstone's, or null. */
function stampOf(sql: string, ...args: unknown[]): string | null {
    return (db.prepare(sql).get(...args) as { at: string | null } | undefined)?.at ?? null;
}

/**
 * The stamp for this tool's copy written now: `now`, or a millisecond past the row it replaces and the tool's tombstone
 * when either is at or after `now`, so a standby holding them takes the new row and every write moves the stamp on.
 */
function stampFor(owner: string, tool: string, now: number): string {
    let at = now;
    const row = stampOf(`SELECT updated_at AS at FROM ${TABLE} WHERE public_key = ? AND tool = ?`, owner, tool);
    const tomb = stampOf('SELECT deleted_at AS at FROM tombstones WHERE table_name = ? AND row_key = ?', TABLE, rowKey(owner, tool));
    for (const t of [row, tomb]) {
        const ms = t === null ? NaN : Date.parse(t);
        if (Number.isFinite(ms) && ms >= at) at = ms + 1;
    }
    return iso(at);
}

/** The different tools `owner` holds a copy of, or deleted one of within the tombstones' 30 days. */
function toolsHeld(owner: string): number {
    return (db.prepare(`
        SELECT COUNT(*) AS n FROM (
            SELECT tool FROM ${TABLE} WHERE public_key = ?
            UNION
            SELECT substr(row_key, length(?) + 2) FROM tombstones WHERE table_name = ? AND row_key >= ? || '|' AND row_key < ? || '}'
        )`).get(owner, owner, TABLE, owner, owner) as { n: number }).n;
}

/** Is this tool one of them: a copy kept, or one deleted within the 30 days? */
function holdsTool(owner: string, tool: string): boolean {
    return !!db.prepare(`SELECT 1 FROM ${TABLE} WHERE public_key = ? AND tool = ?`).get(owner, tool)
        || stampOf('SELECT deleted_at AS at FROM tombstones WHERE table_name = ? AND row_key = ?', TABLE, rowKey(owner, tool)) !== null;
}

/**
 * Keeps `doc` as `owner`'s copy of this tool's document, in place of any before it. Refused, before anything is
 * written: a bad tool id, a document that is no JSON object or is over TOOL_STATE_MAX_BYTES, or a new tool past
 * TOOL_STATE_TOOLS_MAX. On a standby, StandbyLedgerError (config/node-role.ts).
 */
export function writeToolState(owner: string, tool: string, doc: unknown, now: number = Date.now()): ToolState {
    assertPlainTablesWritable();
    assertToolId(tool);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new ToolStateRefusal(400, 'bad_tool_doc', "Send the tool's document as doc, a JSON object.");
    }
    const body = JSON.stringify(doc);
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > TOOL_STATE_MAX_BYTES) {
        throw new ToolStateRefusal(413, 'tool_doc_too_large',
            `This tool's copy would be ${Math.ceil(bytes / 1024)} KB, and the community keeps at most ${TOOL_STATE_MAX_BYTES / 1024} KB for each tool. Take something out of it, then try again.`);
    }
    return db.transaction((): ToolState => {
        if (!holdsTool(owner, tool) && toolsHeld(owner) >= TOOL_STATE_TOOLS_MAX) {
            throw new ToolStateRefusal(409, 'tool_copies_max',
                `The community keeps copies of at most ${TOOL_STATE_TOOLS_MAX} different tools for one account, counting any deleted in the last 30 days.`);
        }
        const updatedAt = stampFor(owner, tool, now);
        db.prepare(`INSERT INTO ${TABLE} (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT (public_key, tool) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`)
            .run(owner, tool, body, updatedAt);
        return { tool, doc: doc as Record<string, unknown>, updatedAt, bytes };
    })();
}

/** Deletes these rows, each with its tombstone stamped no earlier than the row, so a standby deletes it too. */
function deleteRows(owner: string, rows: { tool: string; updated_at: string }[], now: number): number {
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE public_key = ? AND tool = ?`);
    const tomb = db.prepare('INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES (?, ?, ?)');
    const nowIso = iso(now);
    let gone = 0;
    for (const r of rows) {
        gone += del.run(owner, r.tool).changes;
        tomb.run(TABLE, rowKey(owner, r.tool), r.updated_at > nowIso ? r.updated_at : nowIso);
    }
    return gone;
}

/**
 * Deletes `owner`'s copy of this tool, with a tombstone. False, and nothing written, when there is none. On a standby,
 * StandbyLedgerError.
 */
export function deleteToolState(owner: string, tool: string, now: number = Date.now()): boolean {
    assertPlainTablesWritable();
    assertToolId(tool);
    return db.transaction(() => {
        const rows = db.prepare(`SELECT tool, updated_at FROM ${TABLE} WHERE public_key = ? AND tool = ?`).all(owner, tool) as { tool: string; updated_at: string }[];
        return deleteRows(owner, rows, now) > 0;
    })();
}

/**
 * Every copy `owner` keeps, deleted with a tombstone each: their account closed by a removal or deleted by its owner
 * (state-engine.ts adminPruneUser, purgeMemberSelf), when nobody can read them again. Their phone keeps its own. Returns
 * how many went. Inside the caller's transaction.
 */
export function dropToolStateOf(owner: string, now: number = Date.now()): number {
    const rows = db.prepare(`SELECT tool, updated_at FROM ${TABLE} WHERE public_key = ?`).all(owner) as { tool: string; updated_at: string }[];
    return deleteRows(owner, rows, now);
}
