/**
 * The database's stamp, and the gate every open passes before anything writes (the 1.4.0 clean-slate cutover,
 * scratch/fable-design/DESIGN-clean-slate-cutover-fable.md §1).
 *
 * The stamp is two things in the file: `PRAGMA user_version` = SCHEMA_STAMP (5), and node_config `schema_release`, the
 * release whose schema steps last ran on it in full (initSchema writes it at the end of a boot that got that far). At
 * open, readSchemaGate says which of three cases the file is, reading only:
 *
 *  1. `fresh`: no table at all. A fresh install: initSchema writes schema.sql and the stamp in one transaction, so a
 *     first boot stopped part way leaves no half-made file that a later boot would refuse.
 *  2. `stamped`: user_version 5 and a schema_release row naming MINIMUM_RELEASE (1.4.1) or later: a database 1.4.1 or
 *     later last started. Opens, and the boot writes its own release.
 *  3. `refused`: anything else (a database last started before 1.4.1: one 1.4.0 stamped, or one from before 1.4.0, which
 *     is unstamped; or one a release newer than this one stamped). One line, and the process stops. Nothing has been
 *     written, so the file is byte for byte as it was. Restore asks the same gate of a backup before it puts anything in
 *     place (services/restore-checks.ts), so a backup this release would refuse at its next start is refused there first.
 *
 * (1.4.0 alone also opened an unstamped database a kept node last started on 1.2.36 or 1.2.37, and stamped it: conversion
 * code, log row CUT1, removed in the release after every kept node had started 1.4.0. 1.4.1 opened a file 1.4.0 last
 * started and added per-item prices' four columns to it: log rows PERITEM-S1 to S4, removed in the release after every
 * kept node had started 1.4.1, which raised the minimum to 1.4.1 with them.)
 *
 * The standing rule from here (§1): a release keeps only the schema steps born since the previous release, the gate's
 * minimum is that previous release, and each step has a log row that is removed in the next release. An operator who
 * skipped releases starts the previous image once; the images stay on ghcr. Rollback is the pre-deploy copy and the
 * previous image tag, never an older image on a database this one has stamped.
 */
import type Database from 'better-sqlite3';
import { getVersion } from '../version.js';

/** `PRAGMA user_version` of a stamped database. 1.2.x left 4 (its search-index rebuild set it); 1.4.0 stamps 5. */
export const SCHEMA_STAMP = 5;

/** The node_config key that holds the release whose schema steps last ran on this file in full. */
export const SCHEMA_RELEASE_KEY = 'schema_release';

/**
 * The oldest release whose database this one opens: the previous release (§1's standing rule, above). Per-item prices'
 * four boot steps (log rows PERITEM-S1 to S4) went once every kept node had started 1.4.1, so a file 1.4.0 last started
 * lacks four columns this release reads and writes on listings and deals. It is refused rather than opened half made.
 */
export const MINIMUM_RELEASE = '1.4.1';

/** What an operator reads when the file was last started before MINIMUM_RELEASE (§1's words). Nothing was written. */
export const REFUSED_TOO_OLD = `This database was last started by a BeanPool older than ${MINIMUM_RELEASE}. This version opens databases from ${MINIMUM_RELEASE} on. `
    + `Start it once on ghcr.io/beanpool-org/beanpool-node:${MINIMUM_RELEASE}, then start this version again. Nothing was changed.`;

/** x.y.z (an optional leading v, anything after a '-' or '+' ignored) as three numbers; null where the text names no release. */
const releaseParts = (release: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(release.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * Whether a stamped `schema_release` names a release older than MINIMUM_RELEASE, part by part (so '1.4.0-previous' is
 * 1.4.0, older, and '1.4.10' is newer than '1.4.9'). Every image stamps a release number: package.json's version on a
 * main build, the tag's on a release (.github/workflows/docker-publish.yml). Per-item's steps were on main before
 * package.json said 1.4.1, so every file stamped 1.4.1 or later has the four columns.
 *
 * Never older: this node's own release (`own`), so a node always opens a file it stamped itself, whatever its version
 * says; '0.0.0', what version.ts answers where it resolved no version, which names no release; and a stamp that is not
 * a release number at all. Those opened before the minimum rose, and still do.
 */
export function olderThanMinimum(release: string, own: string = getVersion()): boolean {
    if (release === own) return false;
    const got = releaseParts(release);
    if (!got || got.every((n) => n === 0)) return false;
    const min = releaseParts(MINIMUM_RELEASE)!;
    for (let i = 0; i < 3; i++) if (got[i] !== min[i]) return got[i] < min[i];
    return false;
}

/** What an operator reads when a newer release has stamped the file (rollback by image, which §1 rules out). Nothing was written. */
export const refusedTooNew = (stamp: number): string =>
    `This database was stamped by a newer BeanPool than this one (stamp ${stamp}; this version reads ${SCHEMA_STAMP}). `
    + 'Start the newer version again, or restore the copy made before it was deployed. Nothing was changed.';

export type SchemaGate =
    | { kind: 'fresh' }
    | { kind: 'stamped'; release: string }
    | { kind: 'refused'; line: string };

/** Which of the three cases this file is (above). Reads only: never writes, never throws on a file SQLite can read. */
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
        if (typeof release === 'string') return olderThanMinimum(release) ? { kind: 'refused', line: REFUSED_TOO_OLD } : { kind: 'stamped', release };
    }
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
