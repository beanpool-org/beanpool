/**
 * A database a kept node last started on 1.4.0, for the suites that boot one (not a suite itself). It is the oldest file
 * the gate opens since the cutover's steps went (db/schema-gate.ts; log rows CUT1, CUT2, B10, B11, removed once every
 * kept node had started 1.4.0): a database from before 1.4.0 is refused.
 *
 * __fixtures__/schema-v1.4.0.sql is schema.sql as released in v1.4.0, and the stamp is the one 1.4.0 wrote with it on a
 * fresh install, in the same transaction (db.ts initSchema): user_version 5 and node_config schema_release '1.4.0'. A kept
 * node that crossed to 1.4.0 from 1.2.36 holds the same shape: 1.4.0's test-schema-gate.ts held that crossing to a fresh
 * install's exact tables, columns, indexes and triggers. Reads no db.ts, so a suite can make the file before anything
 * opens it.
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSchemaStamp } from './db/schema-gate.js';

/** The release a kept node's database was last started by, as its stamp names it. */
export const KEPT_NODE_RELEASE = '1.4.0';

/** schema.sql as released in v1.4.0. */
export const KEPT_NODE_SCHEMA = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'schema-v1.4.0.sql'), 'utf8');

/** Makes `d`, an empty file, a database a kept node last started on 1.4.0: v1.4.0's schema and its stamp, in one transaction. */
export function makeKeptNodeDatabase(d: Database.Database): void {
    d.transaction(() => {
        d.exec(KEPT_NODE_SCHEMA);
        writeSchemaStamp(d, KEPT_NODE_RELEASE);
    })();
}
