/**
 * Members' locked contact lists (scratch/fable-design/DESIGN-private-contacts-fable.md §4.3, §4.4, slice C1): each member
 * may keep ONE locked copy of their own contacts list here, made on their device under a key only their account's secret
 * makes (@beanpool/core contacts-crypto.ts). This server never opens or changes one, and can't: it keeps the header's
 * numbers and the rest as sent, and answers it to its owner alone. No route names an owner: every request is the
 * signer's own copy, so another member, an admin and an owner of the node all get the same 404.
 *
 * What a save checks only keeps it tidy; the device's own checks are the defence (it opens the box with the member's key):
 *   - the header in its one form, signed by the owner it names (strict RFC 8032), the owner the signer;
 *   - the locked bytes a whole number of 16 KiB steps (400 `bad_copy`), at most 512 KiB (413 `copy_too_big`), and the
 *     digest the header names (400 `bad_copy`);
 *   - a number newer than the one kept (409 `stale_copy` with the kept number: the device fetches, merges, saves again);
 *     the identical copy again is `exists`;
 *   - at most {@link CONTACT_COPIES_PER_HOUR} saves an hour per member (429 `too_many_saves`);
 *   - the node's budget: a member's FIRST copy is refused once the copies here fill it (409 `node_full`); a member who has
 *     one keeps saving.
 * A save writes no log line: a save reveals nothing.
 *
 * Where it goes: one row per member in `contact_copies`, a plain table (engine/replication-manifest.ts): a standby keeps
 * the main server's rows and writes none itself (config/node-role.ts assertPlainTablesWritable); every delete leaves a
 * tombstone, so a standby deletes its copy too. The row goes with the member (removed, account deleted, a re-key), on
 * the owner's own DELETE, and with every other row when the owners switch the community's copies off
 * (config/contact-copies.ts). Slice C6 keeps a re-keyed member's old copy for a year instead (§6.2): its seam is
 * {@link dropContactCopyOf}'s call in engine/key-move.ts.
 */
import { CONTACTS_COPY_MAX_BYTES, readContactsCopy, word, type ContactsCopyWire } from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { keepsContactCopies } from '../config/contact-copies.js';

/** Saves an hour per member (design §4.4): the 13th is refused. */
export const CONTACT_COPIES_PER_HOUR = 12;
const SAVE_WINDOW_MS = 60 * 60 * 1000;
const saves = new Map<string, number[]>();

/** The most the copies here may hold together, in padded bytes (design §4.3): 1 GiB. */
export const CONTACT_COPIES_BUDGET_BYTES = 1024 * 1024 * 1024;
let budgetBytes = CONTACT_COPIES_BUDGET_BYTES;
/** A suite's smaller budget, so "full" is reached with a few copies; null puts the default back. */
export function setContactCopiesBudgetForTests(bytes: number | null): void {
    budgetBytes = bytes ?? CONTACT_COPIES_BUDGET_BYTES;
}

/** The sentences a member's app reads (design §3.6, §4.3). */
export const CONTACT_COPY_WORDS = {
    off: word("This community doesn't keep contact lists. Your list stays on your phone and at your other communities."),
    none: word('This community keeps no copy of your contacts list.'),
    notYours: word('Each member saves only their own contacts list.'),
    tooBig: word('Your contacts list is too big to keep a copy here.'),
    stale: word('This community already keeps a newer copy of your contacts list.'),
    tooMany: word('Your contacts list was saved here too often in the last hour. It is kept on your phone; try again later.'),
    full: word("This community's server has no room for more contact lists. Your list stays on your phone and at your other communities."),
};

/** A refusal: the status, a code the app reads, the sentence, and anything it carries (`seq` with `stale_copy`). */
export class ContactCopyError extends Error {
    constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 429, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
        super(message);
        this.name = 'ContactCopyError';
    }
}

interface CopyRow { owner_pubkey: string; seq: number; padded_size: number; saved_at: string; nonce: string; sealed: string; digest: string; header: string; signature: string }

function rowOf(owner: string): CopyRow | undefined {
    return db.prepare('SELECT * FROM contact_copies WHERE owner_pubkey = ?').get(owner) as CopyRow | undefined;
}

function assertKept(): void {
    if (!keepsContactCopies()) throw new ContactCopyError(404, 'contacts_off', CONTACT_COPY_WORDS.off);
}

/** The signer's own copy, as their device sent it. 404 `no_copy` when there is none: the same answer for every member. */
export function readContactCopyOf(actor: string): ContactsCopyWire {
    assertKept();
    const r = rowOf(actor);
    if (!r) throw new ContactCopyError(404, 'no_copy', CONTACT_COPY_WORDS.none);
    return { header: r.header, signature: r.signature, nonce: r.nonce, sealed: r.sealed };
}

/**
 * What GET /api/me/unread says of the signer's copy here (design §4.4): its number, so a phone's rounds learn whether this
 * community is behind or ahead with no extra request; null with none, or where the community keeps none.
 */
export function contactCopySeqOf(actor: string): { seq: number } | null {
    if (!keepsContactCopies()) return null;
    const r = db.prepare('SELECT seq FROM contact_copies WHERE owner_pubkey = ?').get(actor) as { seq: number } | undefined;
    return r ? { seq: r.seq } : null;
}

/** Counts a save toward the signer's hourly cap; throws 429 `too_many_saves` past it. */
function chargeSave(actor: string, now = Date.now()): void {
    const recent = (saves.get(actor) ?? []).filter((t) => now - t < SAVE_WINDOW_MS);
    if (recent.length >= CONTACT_COPIES_PER_HOUR) {
        saves.set(actor, recent);
        throw new ContactCopyError(429, 'too_many_saves', CONTACT_COPY_WORDS.tooMany);
    }
    recent.push(now);
    saves.set(actor, recent);
}

/** How many padded bytes the copies here hold together. */
export function contactCopiesBytes(): number {
    return (db.prepare('SELECT COALESCE(SUM(padded_size), 0) AS n FROM contact_copies').get() as { n: number }).n;
}

/**
 * The signer's copy (`{ header, signature, nonce, sealed }`) saved over their last: `exists` for the identical header (a
 * retry), refused for a number not newer than the one kept. Every refusal is thrown before anything is written.
 */
export function saveContactCopy(actor: string, body: Record<string, unknown>): { seq: number; exists: boolean } {
    assertPlainTablesWritable();
    assertKept();
    chargeSave(actor);
    // The size first, before anything decodes the bytes.
    const sealed = body.sealed;
    if (typeof sealed === 'string' && Buffer.byteLength(sealed, 'base64') - 16 > CONTACTS_COPY_MAX_BYTES) {
        throw new ContactCopyError(413, 'copy_too_big', CONTACT_COPY_WORDS.tooBig);
    }
    const read = readContactsCopy(body);
    if (!read.ok) {
        if (read.reason === 'too_big') throw new ContactCopyError(413, 'copy_too_big', CONTACT_COPY_WORDS.tooBig);
        throw new ContactCopyError(400, 'bad_copy', 'That isn’t a contacts copy signed by the key that sent it, in whole 16 KiB steps.', { reason: read.reason });
    }
    const c = read.copy;
    if (c.owner !== actor) throw new ContactCopyError(403, 'not_yours', CONTACT_COPY_WORDS.notYours);
    return db.transaction(() => {
        const kept = rowOf(actor);
        if (kept && kept.header === c.header) return { seq: kept.seq, exists: true };
        if (kept && c.seq <= kept.seq) throw new ContactCopyError(409, 'stale_copy', CONTACT_COPY_WORDS.stale, { seq: kept.seq });
        // A first copy past the node's budget is refused; a member who has one keeps saving (design §4.3).
        if (!kept && contactCopiesBytes() + c.paddedSize > budgetBytes) throw new ContactCopyError(409, 'node_full', CONTACT_COPY_WORDS.full);
        db.prepare(
            `INSERT INTO contact_copies (owner_pubkey, seq, padded_size, saved_at, nonce, sealed, digest, header, signature)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_pubkey) DO UPDATE SET seq = excluded.seq, padded_size = excluded.padded_size, saved_at = excluded.saved_at,
                 nonce = excluded.nonce, sealed = excluded.sealed, digest = excluded.digest, header = excluded.header, signature = excluded.signature`,
        ).run(actor, c.seq, c.paddedSize, c.savedAt, c.nonce, c.sealed, c.digest, c.header, c.signature);
        return { seq: c.seq, exists: false };
    })();
}

/** The signer's own copy removed (leaving a community; the member's own choice), with a tombstone. Whether there was one. */
export function deleteContactCopy(actor: string): { deleted: boolean } {
    assertPlainTablesWritable();
    return { deleted: dropContactCopyOf(actor) > 0 };
}

/**
 * The copy of a key that stopped being a member here (removed, account deleted, replaced by a re-key), with a tombstone
 * so a standby drops it too. Returns how many rows went (0 or 1).
 */
export function dropContactCopyOf(pubkey: string): number {
    return deletePlainRows('contact_copies', 'owner_pubkey = ?', pubkey);
}

/** Every copy here, each with a tombstone: the owners switched the community's copies off (config/contact-copies.ts). */
export function dropEveryContactCopy(): number {
    return deletePlainRows('contact_copies', '1 = 1');
}

/** Forget the hourly counts (a suite between its parts). */
export function resetContactCopySavesForTests(): void {
    saves.clear();
}
