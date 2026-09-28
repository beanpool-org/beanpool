import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The vault's database (key vault design §1.1), SQLite through Node's own `node:sqlite`: no native module to audit
 * next to the copies. Loaded with `require` so a bundler or test runner never has to resolve it.
 *
 * - `secure_delete = ON`: SQLite overwrites what it deletes with zeros, in the table and its indexes.
 * - `auto_vacuum = FULL`: freed pages leave the file at each commit, so no page of a deleted copy stays behind.
 * - `journal_mode = TRUNCATE`: the rollback journal, which holds a page's old content during a write, is cut to
 *   nothing at each commit. (On V3's image it and the database sit on the encrypted data partition as well.)
 * - `temp_store = MEMORY`: sorts and VACUUM's working copy never touch the disk.
 *
 * What is never stored (§1.1): callsigns, emails, addresses, community lists, raw `sub`s, tokens, a copy of what a
 * release handed out. A row holds two HMACs, an envelope the API can't open and a day. `holds.requester_key` is a
 * restoring device's throwaway key, never a member's.
 */

const require = createRequire(import.meta.url);

export const DB_FILE = 'vault.db';

export interface CopyRow {
    id: string;
    sub_index: Uint8Array;
    pk_index: Uint8Array;
    envelope: Uint8Array;
    updated_day: string;
}

export interface HoldRow {
    id: string;
    copy_id: string;
    requester_key: string;
    provider: string;
    opened_at: number;
    release_at: number;
    cancelled_at: number | null;
    released_at: number | null;
}

/**
 * A deletion record (§1.7): `{pk_index, sub_index, day}`, plus the random id of the copy that went. The id is what
 * makes a record name one copy: a member who disconnects, connects again and disconnects on the same day leaves two
 * records, and a restore applies each to the copy it was for and to no later one.
 */
export interface DeletionRow {
    copy_id: string;
    pk_index: Uint8Array;
    sub_index: Uint8Array;
    day: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS copies (
    id TEXT PRIMARY KEY,
    sub_index BLOB NOT NULL UNIQUE,
    pk_index BLOB NOT NULL,
    envelope BLOB NOT NULL,
    updated_day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS copies_pk_index ON copies (pk_index);
CREATE TABLE IF NOT EXISTS holds (
    id TEXT PRIMARY KEY,
    copy_id TEXT NOT NULL,
    requester_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    release_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    released_at INTEGER
);
CREATE INDEX IF NOT EXISTS holds_copy_id ON holds (copy_id);
CREATE TABLE IF NOT EXISTS deletions (
    copy_id TEXT PRIMARY KEY,
    pk_index BLOB NOT NULL,
    sub_index BLOB NOT NULL,
    day TEXT NOT NULL
);
`;

/** A hold ends when it is cancelled or collected; it is deleted 7 days after (§1.1). */
export const HOLD_KEEP_AFTER_END_MS = 7 * 24 * 60 * 60 * 1000;

export class VaultDb {
    private constructor(readonly db: DatabaseSync, readonly file: string) {}

    /** `name` other than the vault's own file: a restore being built beside it. */
    static open(dir: string, name = DB_FILE): VaultDb {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
        const file = path.join(dir, name);
        const db = new Database(file);
        // auto_vacuum must be set before the first table exists; on an existing file it is already set.
        db.exec('PRAGMA auto_vacuum = FULL; PRAGMA secure_delete = ON; PRAGMA journal_mode = TRUNCATE; PRAGMA temp_store = MEMORY;');
        db.exec(SCHEMA);
        return new VaultDb(db, file);
    }

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    // ─── copies ────────────────────────────────────────────────────────────────────────────

    copyBySub(subIndex: Uint8Array): CopyRow | undefined {
        return this.db.prepare('SELECT * FROM copies WHERE sub_index = ?').get(subIndex) as CopyRow | undefined;
    }

    copyById(id: string): CopyRow | undefined {
        return this.db.prepare('SELECT * FROM copies WHERE id = ?').get(id) as CopyRow | undefined;
    }

    copiesByPk(pkIndex: Uint8Array): CopyRow[] {
        return this.db.prepare('SELECT * FROM copies WHERE pk_index = ? ORDER BY id').all(pkIndex) as unknown as CopyRow[];
    }

    /** Up to `limit` rows after `afterId`, in id order: for walking every envelope (a re-wrap). */
    copiesAfter(afterId: string, limit: number): CopyRow[] {
        return this.db.prepare('SELECT * FROM copies WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as unknown as CopyRow[];
    }

    countCopies(): number {
        return Number((this.db.prepare('SELECT COUNT(*) AS n FROM copies').get() as { n: number }).n);
    }

    insertCopy(row: CopyRow): void {
        this.db.prepare('INSERT INTO copies (id, sub_index, pk_index, envelope, updated_day) VALUES (?, ?, ?, ?, ?)')
            .run(row.id, row.sub_index, row.pk_index, row.envelope, row.updated_day);
    }

    updateEnvelope(id: string, envelope: Uint8Array, day?: string): void {
        if (day) this.db.prepare('UPDATE copies SET envelope = ?, updated_day = ? WHERE id = ?').run(envelope, day, id);
        else this.db.prepare('UPDATE copies SET envelope = ? WHERE id = ?').run(envelope, id);
    }

    /** The copy, its holds, and a deletion record so an older backup drops it again (§1.7). */
    deleteCopy(row: CopyRow, day: string): void {
        this.db.prepare('DELETE FROM holds WHERE copy_id = ?').run(row.id);
        this.db.prepare('DELETE FROM copies WHERE id = ?').run(row.id);
        this.db.prepare('INSERT OR IGNORE INTO deletions (copy_id, pk_index, sub_index, day) VALUES (?, ?, ?, ?)').run(row.id, row.pk_index, row.sub_index, day);
    }

    // ─── holds ─────────────────────────────────────────────────────────────────────────────

    insertHold(h: HoldRow): void {
        this.db.prepare('INSERT INTO holds (id, copy_id, requester_key, provider, opened_at, release_at, cancelled_at, released_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)')
            .run(h.id, h.copy_id, h.requester_key, h.provider, h.opened_at, h.release_at);
    }

    holdById(id: string): HoldRow | undefined {
        return this.db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow | undefined;
    }

    /** The hold still open on a copy: neither cancelled nor collected. */
    openHoldForCopy(copyId: string): HoldRow | undefined {
        return this.db.prepare('SELECT * FROM holds WHERE copy_id = ? AND cancelled_at IS NULL AND released_at IS NULL ORDER BY opened_at DESC LIMIT 1')
            .get(copyId) as HoldRow | undefined;
    }

    setHoldReleaseAt(id: string, at: number): void {
        this.db.prepare('UPDATE holds SET release_at = ? WHERE id = ?').run(at, id);
    }

    cancelHold(id: string, at: number): void {
        this.db.prepare('UPDATE holds SET cancelled_at = ? WHERE id = ?').run(at, id);
    }

    markReleased(id: string, at: number): void {
        this.db.prepare('UPDATE holds SET released_at = ? WHERE id = ?').run(at, id);
    }

    /**
     * Holds that ended 7 days ago go (§1.1). A hold nobody collected ends 7 days after it became collectable: the
     * device that asked has had a week, and its throwaway key means nothing to anyone else.
     */
    pruneHolds(now: number): number {
        const before = now - HOLD_KEEP_AFTER_END_MS;
        return Number(this.db.prepare(`DELETE FROM holds WHERE (cancelled_at IS NOT NULL AND cancelled_at < ?)
            OR (released_at IS NOT NULL AND released_at < ?) OR (released_at IS NULL AND cancelled_at IS NULL AND release_at < ?)`)
            .run(before, before, before).changes);
    }

    // ─── deletion records ──────────────────────────────────────────────────────────────────

    allDeletions(): DeletionRow[] {
        return this.db.prepare('SELECT * FROM deletions ORDER BY day, copy_id').all() as unknown as DeletionRow[];
    }

    hasDeletion(d: Pick<DeletionRow, 'copy_id'>): boolean {
        return !!this.db.prepare('SELECT 1 FROM deletions WHERE copy_id = ?').get(d.copy_id);
    }

    /**
     * Apply a deletion recorded in a newer backup: the copy it names goes (a later copy for the same sign-in account,
     * which it doesn't name, stays), and the record is kept.
     */
    applyDeletion(d: DeletionRow): boolean {
        const row = this.copyById(d.copy_id);
        if (row) {
            this.db.prepare('DELETE FROM holds WHERE copy_id = ?').run(row.id);
            this.db.prepare('DELETE FROM copies WHERE id = ?').run(row.id);
        }
        this.db.prepare('INSERT OR IGNORE INTO deletions (copy_id, pk_index, sub_index, day) VALUES (?, ?, ?, ?)').run(d.copy_id, d.pk_index, d.sub_index, d.day);
        return !!row;
    }

    /** Deletion records are kept as long as backups are (30 days). */
    pruneDeletions(beforeDay: string): number {
        return Number(this.db.prepare('DELETE FROM deletions WHERE day < ?').run(beforeDay).changes);
    }
}
