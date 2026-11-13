/**
 * Two facts a member's Home answer carries about the reader alone (scratch/fable-design/DESIGN-home-default-fable.md §2.3,
 * §2.5, §5.3, slice D1), each read for the verified signer's own key and never for a key anyone names:
 *
 * - **wayBack** — `covered` when a sign-in's copy of the account is linked here (a current-generation `sso` share in
 *   recovery_shares, the row a link writes; engine/recovery-shares.ts), else `words`: the 12 words are the only way back
 *   this server can see. What the account HAS, not how it joined (the safety card read the open-joins door before). A
 *   copy for the community's admins (VR3) is not counted: telling whether this server can open it means opening the
 *   seal, which a Home read never does; "I still have my 12 words" is not counted either, it is a say-so, not a way back
 *   (engine/home-preferences.ts `words_kept`).
 * - **invitedBy** — the name and key of whoever's invite the member used (members.invited_by), while that person is an
 *   active member here: none for the genesis owner, an open-door join, a visitor's row, or an inviter pruned since. The
 *   member's own fact, so it is in their answer whatever the "Invited by" switch says to others, and in no one else's.
 *
 * The new-account limits keep reading their own rule (engine/probation.ts probationRuleSet), untouched by either.
 */
import { isMemberKeySpelling } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getCurrentGeneration } from './recovery-shares.js';

export type WayBack = 'words' | 'covered';

/** Whether a sign-in's copy of this member's key is linked here, in the current generation. Their own read only. */
export function wayBackOf(publicKey: string): WayBack {
    const generation = getCurrentGeneration(publicKey);
    if (generation === 0) return 'words';
    const row = db.prepare("SELECT EXISTS(SELECT 1 FROM recovery_shares WHERE owner_pubkey = ? AND generation = ? AND holder_type = 'sso') AS linked")
        .get(publicKey, generation) as { linked: number };
    return row.linked ? 'covered' : 'words';
}

export interface InvitedBy { key: string; name: string | null }

/** Whose invite this member used, while they are an active member here; null otherwise. Their own read only. */
export function invitedByOf(publicKey: string): InvitedBy | null {
    const row = db.prepare(`SELECT i.public_key AS key, i.callsign AS name FROM members m
            JOIN members i ON i.public_key = m.invited_by
            WHERE m.public_key = ? AND i.public_key <> m.public_key AND COALESCE(i.is_visitor, 0) = 0 AND COALESCE(i.status, 'active') = 'active'`)
        .get(publicKey) as { key: string; name: string | null } | undefined;
    if (!row || !isMemberKeySpelling(row.key)) return null;
    return { key: row.key, name: row.name ?? null };
}
