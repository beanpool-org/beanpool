/**
 * Day caps by address, for writes by people with no member's key here: a new push token or leave statement of a key with
 * no row (state-engine.ts STRANGER_PUSH_RULES, STRANGER_LEAVE_RULES), a price report without a member's key
 * (db/pricing-guide-db.ts PRICE_REPORT_RULES). Anyone can make a key, and an address costs little (an IPv6 /48 is 65,536
 * /64s), so what such writes store is bounded per address and for the node, a day at a time (design
 * scratch/global-node/DESIGN-replica-flood-bounds-opus.md §6.1). None of these rows travel to a standby
 * (engine/replication-manifest.ts RowRule); this bounds what they cost the main server.
 *
 * Counted over `writes_by_address` (schema.sql 11c): one row per write taken, its address as a keyed hash the caller makes
 * (engine/open-join.ts writeAddressHash), deleted once a day old.
 */
import { db } from './db.js';

/** What `writes_by_address.kind` names. */
export type WriteKind = 'push_token' | 'push_leave' | 'price_report';

export interface DayCaps {
    /** Writes of this kind from one address in any 24 hours. */
    perAddressPerDay: number;
    /** Writes of this kind on this node in any 24 hours, from every address together. */
    perNodePerDay: number;
}

/**
 * One more write of `kind` from the address `ipHash` (null: this server's own code, counted toward the node's day only):
 * null when it may be made, and then recorded; 'rate_limited' past the address's day, 'busy' past the node's. The day-old
 * records go first. Called inside the writer's own transaction, just before its write.
 */
export function admitByAddress(kind: WriteKind, ipHash: string | null, caps: DayCaps): 'rate_limited' | 'busy' | null {
    db.prepare(`DELETE FROM writes_by_address WHERE made_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`).run();
    if (ipHash !== null) {
        const fromAddress = (db.prepare('SELECT COUNT(*) AS n FROM writes_by_address WHERE kind = ? AND ip_hash = ?').get(kind, ipHash) as { n: number }).n;
        if (fromAddress >= caps.perAddressPerDay) return 'rate_limited';
    }
    const today = (db.prepare('SELECT COUNT(*) AS n FROM writes_by_address WHERE kind = ?').get(kind) as { n: number }).n;
    if (today >= caps.perNodePerDay) return 'busy';
    db.prepare(`INSERT INTO writes_by_address (kind, ip_hash, made_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(kind, ipHash);
    return null;
}
