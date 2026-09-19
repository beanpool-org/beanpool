/**
 * "Check your 12 words" records (sealed-keys.md §7, slice 7). See schema.sql §22c.
 *
 * An owner's app checks the words on the device and sends only a signed statement that it did. This module keeps
 * the latest one per member and lists the current owners with theirs. Nothing here decides anything: no route, role
 * or action looks at these rows except to show them.
 */

import { db } from '../db/db.js';

/** The one statement an owner's app may make. Anything else in the body is refused, so nothing else is stored. */
export const OWNER_WORDS_ATTESTATION = 'owner-12-words-checked';

export interface OwnerWordsCheckRecord {
    memberPubkey: string;
    checkedAt: number;
    signature: string;
    signedPayload: string;
}

export function recordOwnerWordsCheck(rec: OwnerWordsCheckRecord): void {
    db.prepare(
        `INSERT INTO owner_words_checks (member_pubkey, checked_at, signature, signed_payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(member_pubkey) DO UPDATE SET
             checked_at = excluded.checked_at, signature = excluded.signature, signed_payload = excluded.signed_payload`,
    ).run(rec.memberPubkey, rec.checkedAt, rec.signature, rec.signedPayload);
}

export function getOwnerWordsCheckedAt(pubkey: string): number | null {
    const row = db.prepare('SELECT checked_at FROM owner_words_checks WHERE member_pubkey = ?').get(pubkey) as
        { checked_at: number } | undefined;
    return row ? Number(row.checked_at) : null;
}

export interface OwnerWordsStatus {
    pubkey: string;
    callsign: string;
    /** ms since epoch of the owner's last signed statement, or null: not checked yet. */
    wordsCheckedAt: number | null;
}

/** Every current, active owner, oldest grant first, with their last check. */
export function listOwnerWordsStatus(): OwnerWordsStatus[] {
    const rows = db.prepare(
        `SELECT nr.member_pubkey AS pubkey, m.callsign AS callsign, owc.checked_at AS checked_at
         FROM node_roles nr
         JOIN members m ON nr.member_pubkey = m.public_key
         LEFT JOIN owner_words_checks owc ON owc.member_pubkey = nr.member_pubkey
         WHERE nr.role = 'owner' AND m.status = 'active'
         ORDER BY nr.granted_at ASC, nr.rowid ASC`,
    ).all() as { pubkey: string; callsign: string; checked_at: number | null }[];
    return rows.map((r) => ({
        pubkey: r.pubkey,
        callsign: r.callsign,
        wordsCheckedAt: r.checked_at == null ? null : Number(r.checked_at),
    }));
}
