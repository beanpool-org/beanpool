/**
 * A member's community copy: "Your community's admins can bring you back", community-held placement (vault rethink VR3;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3, Marty's picks of 27 Oct).
 *
 * The member's app seals their key, and their 12 words when it has them, under 32 random bytes it makes for this copy
 * (@beanpool/core sealSeedToCopyKey), and sends the copy and that key here, signed by the member's own key. This server
 * keeps both, together, under its recovery seal (services/recovery-seal-key.ts), as it keeps every copy: never in the
 * clear, and never at all when it has no seal key to lock them with. It opens them only for a bring-back an admin
 * confirmed with the member's new phone in front of them (engine/bring-back.ts), and then only to seal them to that
 * phone's throwaway key.
 *
 * Who can open it, said plainly: this server, so the people who run it; nobody else. The words the member reads say so.
 *
 * Only where the community keeps copies itself (config/recovery-copies.ts `server`), and never where anyone can walk in
 * (door `open`, the global community): the bring-back rests on an admin who has checked the person in person. A copy
 * made before the rule moved stays the member's until they remove it (design §5.3), and still brings them back.
 *
 * One row per member, replaced by a new turn-on. Removed by the member, by deleting their account
 * (state-engine.ts purgeMemberSelf) and by a re-key (engine/member-wizards.ts completeRekey), which replaces the key the
 * copy holds. A plain table: a standby holds the wrapped rows, and a deletion reaches it as a tombstone.
 */

import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { recoveryCopies } from '../config/recovery-copies.js';
import { getDoor } from '../config/door.js';
import { KEEPER_ALG_COPY_KEY, isKeySealedCopy, word } from '@beanpool/core';
import {
    openRecoveryFields,
    requireRecoverySealKey,
    sealRecoveryFields,
    shareRowAad,
} from '../services/recovery-seal-key.js';

/** The holder type the wrap's AAD names: a community copy can never be opened as a sign-in copy's row, or the reverse. */
const HOLDER = 'community';

/** A community copy as the app sends it, and as a bring-back hands it out. */
export interface CommunityCopy {
    copy: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string };
    /** The 32 bytes that open {@link copy}, base64. */
    copyKey: string;
}

export class CommunityCopyRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

/** Where the community path is not offered: a rule other than "this server", or a door anyone can walk through. */
export const COMMUNITY_COPY_NOT_OFFERED = word("This community doesn't keep copies for its admins to bring members back, so nothing was kept.");
const BAD_COPY = 'That is not a community copy this server can keep.';

/**
 * Whether this community offers its members the community path now: it keeps copies itself (`server`), and its door is
 * not open to anyone (an admin must have seen the person: never the global community).
 */
export function communityCopiesOffered(): boolean {
    return recoveryCopies() === 'server' && getDoor() !== 'open';
}

function b64Bytes(v: unknown, bytes: number | null, max = 4096): string | null {
    if (typeof v !== 'string' || !v || v.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
    const n = Buffer.from(v, 'base64').length;
    return bytes === null || n === bytes ? v : null;
}

/** The app's copy, checked for shape (never opened: this server can't, without the key beside it, and doesn't try). */
export function parseCommunityCopy(raw: unknown): CommunityCopy {
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const c = (body.copy && typeof body.copy === 'object' ? body.copy : {}) as Record<string, unknown>;
    const encryptedShare = b64Bytes(c.encryptedShare, 32);
    const shareIv = b64Bytes(c.shareIv, 24);
    const shareTag = b64Bytes(c.shareTag, 16);
    const copyKey = b64Bytes(body.copyKey, 32);
    const kdfParams = typeof c.kdfParams === 'string' && c.kdfParams.length <= 4096 ? c.kdfParams : null;
    if (!encryptedShare || !shareIv || !shareTag || !copyKey || !kdfParams || !isKeySealedCopy(kdfParams)) {
        throw new CommunityCopyRefusal(400, 'bad_copy', BAD_COPY);
    }
    return { copy: { encryptedShare, shareIv, shareTag, kdfParams }, copyKey };
}

/**
 * Keep the member's community copy, replacing any earlier one. Refused unless the community offers the path
 * ({@link communityCopiesOffered}), and refused, with nothing stored, when this server has no seal key to lock it with
 * (RecoverySealKeyMissing, thrown before anything is written). Returns since when it is kept.
 */
export function putCommunityCopy(ownerPubkey: string, input: CommunityCopy, now = Date.now()): { since: string } {
    if (!communityCopiesOffered()) throw new CommunityCopyRefusal(409, 'not_offered', COMMUNITY_COPY_NOT_OFFERED);
    assertPlainTablesWritable();
    requireRecoverySealKey();
    // The copy and its key go into ONE wrap: the stored row never holds either in the clear, and the key never sits
    // beside the copy outside the seal. `alg` names the inner scheme, so the stored kdf_params says what the row is.
    const wrapped = sealRecoveryFields({
        encryptedShare: input.copy.encryptedShare,
        shareIv: input.copy.shareIv,
        shareTag: input.copy.shareTag,
        kdfParams: JSON.stringify({ alg: KEEPER_ALG_COPY_KEY, copy: input.copy.kdfParams, key: input.copyKey }),
    }, shareRowAad(ownerPubkey, HOLDER));
    const at = new Date(now).toISOString();
    db.prepare(`
        INSERT INTO community_copies (owner_pubkey, copy_ct, copy_iv, copy_tag, kdf_params, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_pubkey) DO UPDATE SET copy_ct = excluded.copy_ct, copy_iv = excluded.copy_iv,
            copy_tag = excluded.copy_tag, kdf_params = excluded.kdf_params, created_at = excluded.created_at
    `).run(ownerPubkey, wrapped.encryptedShare, wrapped.shareIv, wrapped.shareTag, wrapped.kdfParams, at);
    return { since: at };
}

/** Whether this server keeps a community copy for the member, and since when. Opens nothing. */
export function communityCopyStatus(ownerPubkey: string): { kept: boolean; since: string | null } {
    const row = db.prepare('SELECT created_at FROM community_copies WHERE owner_pubkey = ?').get(ownerPubkey) as { created_at: string } | undefined;
    return { kept: !!row, since: row?.created_at ?? null };
}

export function hasCommunityCopy(ownerPubkey: string): boolean {
    return !!db.prepare('SELECT 1 FROM community_copies WHERE owner_pubkey = ?').get(ownerPubkey);
}

/**
 * The member's copy and its key, opened from the seal: for a bring-back's release only (engine/bring-back.ts), which
 * seals them to the new phone at once. Null when there is none. Throws RecoverySealKeyMissing or
 * RecoverySealUnopenable when this server cannot open it.
 */
export function openCommunityCopy(ownerPubkey: string): CommunityCopy | null {
    const row = db.prepare('SELECT copy_ct, copy_iv, copy_tag, kdf_params FROM community_copies WHERE owner_pubkey = ?')
        .get(ownerPubkey) as { copy_ct: string; copy_iv: string; copy_tag: string; kdf_params: string } | undefined;
    if (!row) return null;
    const f = openRecoveryFields(
        { encryptedShare: row.copy_ct, shareIv: row.copy_iv, shareTag: row.copy_tag, kdfParams: row.kdf_params },
        shareRowAad(ownerPubkey, HOLDER),
    );
    const inner = JSON.parse(f.kdfParams ?? '{}') as { alg?: unknown; copy?: unknown; key?: unknown };
    if (inner.alg !== KEEPER_ALG_COPY_KEY || typeof inner.copy !== 'string' || typeof inner.key !== 'string') {
        throw new CommunityCopyRefusal(500, 'bad_copy', BAD_COPY);
    }
    return { copy: { encryptedShare: f.encryptedShare, shareIv: f.shareIv, shareTag: f.shareTag, kdfParams: inner.copy }, copyKey: inner.key };
}

/** Remove the member's community copy (with a tombstone, so a standby drops it too). Returns how many went: 0 or 1. */
export function deleteCommunityCopy(ownerPubkey: string): number {
    return deletePlainRows('community_copies', 'owner_pubkey = ?', ownerPubkey);
}
