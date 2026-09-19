/**
 * The silent open check's records (sealed-keys.md §7, slice 6). See schema.sql §22d.
 *
 * An owner's app, on seeing a new take-over lock, opens its own stanza, throws the key away, and reports whether it
 * could. This module stores the latest report per owner. The list of who can unlock the community reads it (the
 * owners' list joins this table); nothing else does, and nothing is allowed or refused because of it.
 */

import { db } from '../db/db.js';

export interface OwnerLockOpenRecord {
    memberPubkey: string;
    envelopeId: string;
    opened: boolean;
    checkedAt: number;
    signature: string;
    signedPayload: string;
}

/** The silent open check (§7): the owner's device's latest report on a lock. Replaces the member's previous one. */
export function recordOwnerLockOpen(rec: OwnerLockOpenRecord): void {
    db.prepare(
        `INSERT INTO owner_lock_opens (member_pubkey, envelope_id, opened, checked_at, signature, signed_payload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_pubkey) DO UPDATE SET
             envelope_id = excluded.envelope_id, opened = excluded.opened, checked_at = excluded.checked_at,
             signature = excluded.signature, signed_payload = excluded.signed_payload`,
    ).run(rec.memberPubkey, rec.envelopeId, rec.opened ? 1 : 0, rec.checkedAt, rec.signature, rec.signedPayload);
}
