/**
 * A database a kept node last started on 1.4.1, for the suites that boot one (not a suite itself), and one a node last
 * started on 1.4.0, which the gate refuses. Every kept node has started 1.4.1, and the boot steps born with it for
 * per-item prices went (log rows PERITEM-S1 to S4, as the cutover's CUT1, CUT2, B10 and B11 went before them): db.ts no
 * longer adds those four columns to a file made before them, and the gate's minimum rose to 1.4.1 with them
 * (db/schema-gate.ts MINIMUM_RELEASE), so a file 1.4.0 last started is refused, at boot and at restore.
 *
 * __fixtures__/schema-v1.4.1.sql is schema.sql as released in v1.4.1, and the stamp is the one 1.4.1 wrote with it on a
 * fresh install, in the same transaction (db.ts initSchema): user_version 5 and node_config schema_release '1.4.1'. A kept
 * node that crossed to 1.4.1 from 1.4.0 holds the same shape: 1.4.1's test-schema-gate.ts held that crossing to a fresh
 * install's exact tables, columns, indexes and triggers. __fixtures__/schema-v1.4.0.sql is v1.4.0's, stamped as 1.4.0
 * stamped it. Reads no db.ts, so a suite can make the file before anything opens it.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSchemaStamp } from './db/schema-gate.js';

const fixture = (name: string): string => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8');

/** The release a kept node's database was last started by, as its stamp names it. */
export const KEPT_NODE_RELEASE = '1.4.1';

/** schema.sql as released in v1.4.1. */
export const KEPT_NODE_SCHEMA = fixture('schema-v1.4.1.sql');

/** The release before KEPT_NODE_RELEASE, whose database the gate refuses (below its MINIMUM_RELEASE). */
export const TOO_OLD_RELEASE = '1.4.0';

/** schema.sql as released in v1.4.0: without per-item prices' four columns. */
export const TOO_OLD_SCHEMA = fixture('schema-v1.4.0.sql');

/** Makes `d`, an empty file, a database a kept node last started on 1.4.1: v1.4.1's schema and its stamp, in one transaction. */
export function makeKeptNodeDatabase(d: Database.Database): void {
    d.transaction(() => {
        d.exec(KEPT_NODE_SCHEMA);
        writeSchemaStamp(d, KEPT_NODE_RELEASE);
    })();
}

/** Makes `d`, an empty file, a database a node last started on 1.4.0: v1.4.0's schema and its stamp, in one transaction. */
export function makeTooOldDatabase(d: Database.Database): void {
    d.transaction(() => {
        d.exec(TOO_OLD_SCHEMA);
        writeSchemaStamp(d, TOO_OLD_RELEASE);
    })();
}
