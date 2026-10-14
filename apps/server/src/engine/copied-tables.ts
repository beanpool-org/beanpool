/**
 * The tables a standby copies from its main server, emptied: how a whole copy starts (design scratch/global-node/DESIGN-
 * paged-copies-fable.md §4.2). The stager builds each whole copy in a new staging database (services/stager.ts), and this
 * takes out what that database's own start seeded in them (a standby seeds none, but the Commons account every start
 * makes is the copy's to bring), so the copy is all it holds. Nothing empties a standby's live database: a copy that is
 * refused leaves it as it was.
 *
 * Suites that play a main server and a new standby in one process use it to start the standby's copy from nothing.
 */

import type Database from 'better-sqlite3';
import { TABLES } from './replication-manifest.js';

/** Every row of every table the replication manifest says a standby copies, deleted in one transaction. How many went. */
export function emptyCopiedTables(conn: Database.Database): number {
    const has = (table: string) => (conn.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?)').get(table) as { n: number }).n > 0;
    const copied = Object.entries(TABLES)
        .filter(([, e]) => e.kind === 'replicated' || e.kind === 'replicated-except')
        .map(([t]) => t)
        .filter(has);
    let n = 0;
    conn.transaction(() => {
        // The tombstones last: a delete here that writes one (a trigger) leaves none behind.
        for (const t of copied.filter((t) => t !== 'tombstones')) n += conn.prepare(`DELETE FROM "${t}"`).run().changes;
        if (copied.includes('tombstones')) n += conn.prepare('DELETE FROM tombstones').run().changes;
    })();
    return n;
}
