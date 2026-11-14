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
 * tombstone, so a standby deletes its copy too. The row goes with the member (removed, account deleted), on the owner's
 * own DELETE, and with every other row when the owners switch the community's copies off (config/contact-copies.ts).
 *
 * **After a re-key** (design §6.2, slice C6): the old key's copy can't be opened by the new key, nor by anyone but whoever
 * finds the old 12 words. So it isn't deleted: the re-key moves it to `contact_copies_former` under the new key, with the
 * old key beside it and a last day a year on (engine/key-move.ts, inside the re-key's transaction), and the member's phone
 * opens it there with the old words and merges it into the new list. At most one per member: a second re-key keeps the
 * newest copy (the old key's own current one, or else the former one it held, moved with its year as it was). The member's
 * key now reads it (GET /api/contacts/former, {@link readFormerContactCopyOf}) and deletes it
 * ({@link deleteFormerContactCopy}); nobody else does, admins and owners included. After its last day it is no longer
 * served, and {@link forgetExpiredFormerCopies} deletes it, with a tombstone, on the main server's hourly sweep. It goes,
 * like the current copy, with the member and with the owners' switch, and it counts toward the node's budget.
 */
import { CONTACTS_COPY_MAX_BYTES, readContactsCopy, word, type ContactsCopyWire } from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { assertPlainTablesWritable, getNodeRole } from '../config/node-role.js';
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
    noFormer: word('This community keeps no copy of a contacts list locked with an old key of yours.'),
};

/** How long a re-keyed member's old copy is kept (design §6.2): a year. */
export const CONTACT_FORMER_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

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

/** How many padded bytes the copies here hold together, a re-keyed member's former copies included. */
export function contactCopiesBytes(): number {
    return (db.prepare(`SELECT (SELECT COALESCE(SUM(padded_size), 0) FROM contact_copies)
                             + (SELECT COALESCE(SUM(padded_size), 0) FROM contact_copies_former) AS n`).get() as { n: number }).n;
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
    return { deleted: deletePlainRows('contact_copies', 'owner_pubkey = ?', actor) > 0 };
}

/**
 * The copies of a key that stopped being a member here (removed, account deleted): its current copy and a former one,
 * each with a tombstone so a standby drops them too. Returns how many rows went (0 to 2).
 */
export function dropContactCopyOf(pubkey: string): number {
    return deletePlainRows('contact_copies', 'owner_pubkey = ?', pubkey) + deletePlainRows('contact_copies_former', 'owner_pubkey = ?', pubkey);
}

/** Every copy here, former ones too, each with a tombstone: the owners switched the community's copies off (config/contact-copies.ts). */
export function dropEveryContactCopy(): number {
    return deletePlainRows('contact_copies', '1 = 1') + deletePlainRows('contact_copies_former', '1 = 1');
}

// ── After a re-key: the former copy (design §6.2, slice C6) ───────────────────────────────────────────────────────

/** What GET /api/contacts/former answers: the old key's copy as it was sent, the key it is locked with, and its last day. */
export interface FormerContactCopy extends ContactsCopyWire {
    formerKey: string;
    keptUntil: string;
}

/**
 * The signer's former copy: the list their key before a re-key locked, kept until its last day. 404 `no_former` when there
 * is none, or its year is over: the same answer for every member. Where the community keeps no lists, 404 `contacts_off`.
 */
export function readFormerContactCopyOf(actor: string, now = Date.now()): FormerContactCopy {
    assertKept();
    const r = db.prepare('SELECT former_pubkey, header, signature, nonce, sealed, kept_until FROM contact_copies_former WHERE owner_pubkey = ?').get(actor) as
        { former_pubkey: string; header: string; signature: string; nonce: string; sealed: string; kept_until: string } | undefined;
    if (!r || !(Date.parse(r.kept_until) > now)) throw new ContactCopyError(404, 'no_former', CONTACT_COPY_WORDS.noFormer);
    return { header: r.header, signature: r.signature, nonce: r.nonce, sealed: r.sealed, formerKey: r.former_pubkey, keptUntil: r.kept_until };
}

/** The signer's former copy removed ("Delete it"), with a tombstone. Whether there was one. Answers where copies are off too. */
export function deleteFormerContactCopy(actor: string): { deleted: boolean } {
    assertPlainTablesWritable();
    return { deleted: deletePlainRows('contact_copies_former', 'owner_pubkey = ?', actor) > 0 };
}

/**
 * The former copies past their last day deleted, each with a tombstone. On the main server only: a standby's are its main
 * server's, and their tombstones come in its copy (a standby serves none past its day meanwhile). Returns how many went.
 */
export function forgetExpiredFormerCopies(now = Date.now()): number {
    if (getNodeRole() !== 'primary') return 0;
    return deletePlainRows('contact_copies_former', 'kept_until < ?', new Date(now).toISOString());
}

let formerSweep: NodeJS.Timeout | null = null;
/** The hourly sweep of former copies past their year (https-server.ts, with the other tidying timers). */
export function startForgettingFormerCopies(everyMs = 60 * 60 * 1000): void {
    if (formerSweep) return;
    formerSweep = setInterval(() => {
        try { forgetExpiredFormerCopies(); } catch (e) { console.warn('[Contacts] Old contact lists past their year were not cleared:', (e as Error)?.message || e); }
    }, everyMs);
    formerSweep.unref?.();
}

/** Forget the hourly counts (a suite between its parts). */
export function resetContactCopySavesForTests(): void {
    saves.clear();
}
