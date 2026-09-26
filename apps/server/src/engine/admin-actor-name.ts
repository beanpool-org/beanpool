// How a member-facing line names the admin who acted.

import { db } from '../db/db.js';

export const COMMUNITY_ADMIN = 'a community admin';

const KEY_LIKE = /^[0-9a-f]{64}$/i;

/**
 * The words a member reads for "who did this": the admin's callsign when they acted from their own signed-in
 * key, otherwise "a community admin". Never a key and never the 'owner:password' marker — the audit columns
 * keep the signer; a push, a chat line or a ledger memo never does.
 */
export function adminActorName(signer: string | null | undefined): string {
    if (typeof signer !== 'string' || !KEY_LIKE.test(signer.trim())) return COMMUNITY_ADMIN;
    // The member's own row, in the one spelling keys are kept in (engine/member-key.ts). Not a case-blind match, which
    // could answer with a row a door stored under that key in capitals before that rule, named by whoever made it.
    const row = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(signer.trim().toLowerCase()) as { callsign?: string | null } | undefined;
    const callsign = row?.callsign?.trim();
    if (!callsign || KEY_LIKE.test(callsign)) return COMMUNITY_ADMIN;
    return callsign;
}
