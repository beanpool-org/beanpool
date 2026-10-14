/**
 * For suites that play a main server sending its standby a copy it made up (a ledger that doesn't conserve, a copy as an
 * older version sent it, a delta of chosen rows): a payload as one copy of one page, as routes/backup.ts `sync-copy`
 * serves one (engine/copy-pages.ts), for the suite to sign with the main server's own key (state-engine.ts
 * signSyncPayload) and answer the standby's `POST /api/local/admin/sync-copy` with. Not a server path.
 *
 * The page carries the payload's fields as they are, and what a copy's opening and last page add: its id and number, the
 * rows it holds of each category and plain table (counted here, the photos the payload names as left out included), and
 * the rows it sent (the same, without those photos). No table hashes: a payload of the export has none.
 */

import crypto from 'node:crypto';

export function asOnePageCopy(payload: Record<string, unknown>, since: string | null = null): Record<string, unknown> {
    const { signature: _signature, publicKey: _publicKey, ...rest } = payload;
    const sent: Record<string, unknown> = {};
    for (const [key, rows] of Object.entries(rest)) {
        // The keepers travel in the opening page as a whole set, never counted; the photos left out are a list of keys.
        if (!Array.isArray(rows) || key === 'treasuryOperators' || key === 'photosOmitted') continue;
        sent[key] = rows.length;
    }
    if (rest.plainTables && typeof rest.plainTables === 'object') {
        const plain: Record<string, number> = {};
        for (const [table, rows] of Object.entries(rest.plainTables as Record<string, unknown>)) if (Array.isArray(rows)) plain[table] = rows.length;
        sent.plainTables = plain;
    }
    const omitted = Array.isArray(rest.photosOmitted) ? rest.photosOmitted.length : 0;
    if (omitted > 0 && typeof sent.photos !== 'number') sent.photos = 0;
    const counted: Record<string, unknown> = { ...sent };
    if (omitted > 0) counted.photos = (typeof counted.photos === 'number' ? counted.photos : 0) + omitted;
    return {
        copyId: crypto.randomUUID(), n: 0, nodeId: rest.nodeId, since, ...rest,
        rowCounts: counted, pageBytes: 8 * 1024 * 1024, pageRows: 25_000, last: true, pages: 1, rowsSent: sent,
    };
}
