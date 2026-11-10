/**
 * The database's stamp, and the gate every open passes before anything writes (the 1.4.0 clean-slate cutover,
 * scratch/fable-design/DESIGN-clean-slate-cutover-fable.md §1).
 *
 * The stamp is two things in the file: `PRAGMA user_version` = SCHEMA_STAMP (5), and node_config `schema_release`, the
 * release whose schema steps last ran on it in full (initSchema writes it at the end of a boot that got that far). At
 * open, readSchemaGate says which of four cases the file is, reading only:
 *
 *  1. `fresh`: no table at all. A fresh install: initSchema writes schema.sql and the stamp in one transaction, so a
 *     first boot stopped part way leaves no half-made file that a later boot would refuse.
 *  2. `stamped`: user_version 5 and a schema_release row. Opens, and the boot writes its own release.
 *  3. `release-1.2.36`: user_version 4 and the 1.2.36 shape (RELEASE_1_2_36_OBJECT, the one object born in 1.2.36). A
 *     database a kept node last started on 1.2.36 or 1.2.37: it opens, the schema steps born since run (db.ts, CUT2),
 *     and the stamp is written once they have.
 *     CONVERSION CODE, log row CUT1, remove in 1.4.1: it recognises an unstamped database and marks it. It goes once the
 *     four kept nodes have started 1.4.0; from then on a database is stamped or it is refused.
 *  4. `refused`: anything else (a database last started before 1.2.36, or by a release newer than this one). One line,
 *     and the process stops. Nothing has been written, so the file is byte for byte as it was.
 *
 * The standing rule from here (§1): a release keeps only the schema steps born since the previous release, the gate's
 * minimum is that previous release, and each step has a log row that is removed in the next release. An operator who
 * skipped releases starts the previous image once; the images stay on ghcr. Rollback is the pre-deploy copy and the
 * previous image tag, never an older image on a database this one has stamped.
 */
import type Database from 'better-sqlite3';

/** `PRAGMA user_version` of a stamped database. 1.2.x left 4 (its search-index rebuild set it); 1.4.0 stamps 5. */
export const SCHEMA_STAMP = 5;

/** The node_config key that holds the release whose schema steps last ran on this file in full. */
export const SCHEMA_RELEASE_KEY = 'schema_release';

/**
 * The one object born in 1.2.36 (schema.sql's partial index for "does this member have a copy held from another node?",
 * routes/home-listings.ts): a user_version 4 file that has it was last started by 1.2.36 or later. Read by gate rule 3
 * only (CUT1), and goes with it in 1.4.1.
 */
export const RELEASE_1_2_36_OBJECT = 'idx_posts_copy_authors';

/** What an operator reads when the file was last started before 1.2.36 (§1's words). Nothing was written. */
export const REFUSED_TOO_OLD = 'This database was last started by a BeanPool older than 1.2.36. BeanPool 1.4.0 opens databases from 1.2.36 on. '
    + 'Start it once on ghcr.io/beanpool-org/beanpool-node:1.2.37, then start this version again. Nothing was changed.';

/** What an operator reads when a newer release has stamped the file (rollback by image, which §1 rules out). Nothing was written. */
export const refusedTooNew = (stamp: number): string =>
    `This database was stamped by a newer BeanPool than this one (stamp ${stamp}; this version reads ${SCHEMA_STAMP}). `
    + 'Start the newer version again, or restore the copy made before it was deployed. Nothing was changed.';

export type SchemaGate =
    | { kind: 'fresh' }
    | { kind: 'stamped'; release: string }
    | { kind: 'release-1.2.36' }
    | { kind: 'refused'; line: string };

/** Which of the four cases this file is (above). Reads only: never writes, never throws on a file SQLite can read. */
export function readSchemaGate(conn: Database.Database): SchemaGate {
    const has = (type: string, name: string) => !!conn.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
    const tables = (conn.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;
    if (tables === 0) return { kind: 'fresh' };
    const stamp = conn.pragma('user_version', { simple: true }) as number;
    if (stamp > SCHEMA_STAMP) return { kind: 'refused', line: refusedTooNew(stamp) };
    if (stamp === SCHEMA_STAMP && has('table', 'node_config')) {
        let release: unknown;
        try {
            release = (conn.prepare('SELECT value FROM node_config WHERE key = ?').get(SCHEMA_RELEASE_KEY) as { value: unknown } | undefined)?.value;
        } catch { /* a node_config no release made (no key or value column): no stamp */ }
        if (typeof release === 'string') return { kind: 'stamped', release };
    }
    // CONVERSION CODE, log row CUT1, remove in 1.4.1: an unstamped database a kept node last started on 1.2.36 or 1.2.37.
    if (stamp === 4 && has('index', RELEASE_1_2_36_OBJECT)) return { kind: 'release-1.2.36' };
    return { kind: 'refused', line: REFUSED_TOO_OLD };
}

/**
 * Writes the stamp: user_version 5 and this release in node_config, in one transaction (the caller's, when it is in one).
 * `PRAGMA user_version` is part of the file's header and is written with the transaction that sets it.
 */
export function writeSchemaStamp(conn: Database.Database, release: string): void {
    const write = () => {
        conn.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SCHEMA_RELEASE_KEY, release);
        conn.pragma(`user_version = ${SCHEMA_STAMP}`);
    };
    if (conn.inTransaction) write();
    else conn.transaction(write)();
}
