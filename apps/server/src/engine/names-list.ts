/**
 * The names list (community modes slice 2; scratch/global-node/DESIGN-community-modes-fable.md §4.1, §4.3, §7.1, §7.4,
 * §8 item 2; Marty's answers 2026-10-01): the community's admins keep a list of who its members are, by real name, and
 * confirm a member against an entry. Kept on the node ENCRYPTED on the admins' phones: this server holds sealed text,
 * signed statements and sealed boxes it can't open (schema.sql §22e; @beanpool/core names-list-crypto.ts), and the
 * names open on an admin's phone.
 *
 * ## Who
 *
 * The community's owners and admins whose role acts (node_roles, NODE_ROLE_ACTS): signed with their own key, through the
 * signature middleware (routes/names-list.ts). A moderator, a member and anyone else are refused. Key-holding admins
 * only: the owner password reads no name through this server's routes (design §4.3). It is not what keeps the names from
 * whoever runs the server, who can make any key an admin and re-key any account: the admins' phones are (below).
 *
 * ## The key history, the shares, and what happens when an admin goes
 *
 * The trust model is scratch/global-node/DESIGN-names-list-trust-fable.md, and it lives on the admins' phones
 * (@beanpool/core names-list-trust.ts). This server keeps what they send and checks only what keeps the list tidy and
 * live (design §5); none of it is the defence, because whoever runs this server can change any row:
 *
 * - **The key history** (`names_generations`, {@link addGeneration}): one statement per generation, signed by its maker
 *   (maker, parent, drops), its id the SHA-256 of the signed bytes. A statement lands only off the current one (the
 *   highest number), signed for this community by the maker it names. A statement the requester makes itself, while
 *   some admin holds the current key, must come from such a holder (409 `ask_for_share`); when nobody does, any admin
 *   may make one. A statement put back after a rollback (`replay`) may be anyone's. This server never decides who is
 *   dropped: the phones do. The key itself never reaches it.
 * - **Shares** (`names_shares`, {@link addShare}): an admin's phone sends another admin every key it holds, in one box
 *   sealed to that admin's account key, under a header it signs (its head, the ids in the box, every key it trusts). The
 *   newest per pair. Each is logged (`key_shared`): the phones send them without a tap, to the admins they trust.
 * - **Who holds a key**, as far as this server can tell: whoever made it, and whoever a share to or from names it with.
 *   A liveness hint for the phones, never a reason to trust anyone.
 * - **An admin who stops being one** (their role revoked or changed to moderator, suspended, removed, their account
 *   deleted, or their key replaced after a lost phone) is marked as no longer holding the current key, before anything
 *   else is done here ({@link reconcileHolders}, at the start of every names-list request on a main server), and logged
 *   once. While a holder of the current key is marked, nothing is written (409 `new_key_first`) until an admin who
 *   holds it opens the list: their phone makes the next generation, dropping that admin, and sends it to the admins it
 *   trusts. Nothing is sealed again: what was written before stays under its own key, and a removed admin keeps whatever
 *   they already saw, as with paper.
 * - When nobody who is an admin now holds the current key, any admin's phone may make a new one; what was sealed under
 *   the old key stays locked until a holder comes back, or an admin types it again from the paper copy.
 *
 * ## Confirming
 *
 * A confirmation (design §4.1) is "this key is the person on that entry, confirmed by that admin". One live
 * confirmation per member and per entry. An admin confirms only against an entry they can open, and not themselves
 * unless they are the community's only admin. Where the community asks for two admins (`names_two_admins`, the owner's
 * setting, off by default) and it has two or more, a confirmation waits for a second admin, who must also be able to
 * open the entry. Any admin revokes one. Removing a member or their deleting their account revokes theirs. It is a fact
 * about a member, never a tier, and in this slice it gates nothing.
 *
 * ## The access log
 *
 * Every read of the list and every export, and every change, is logged (who, when) in `names_access_log`, which every
 * owner and admin reads (design §4.4: the watchers are watched). The export is logged when the phone fetches the list
 * to export it (`GET /api/names/entries?for=export`): the PDF is made from that fetch.
 *
 * ## Main server only
 *
 * A standby copies every table as plain rows (engine/replication-manifest.ts) and serves none of this: a read writes
 * the log, which is the main server's. A take-over needs nothing more: the rows are there, and the same admins' phones
 * open them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMember, isVisitorKey } from '@beanpool/engine';
import {
    isNamesEntryCiphertext, isNamesEntryId, NAMES_LIMITS, isNamesCommunityId, readNamesGeneration, readNamesShare, namesStatementId,
    readNamesCopy, NAMES_COPY_MAX_BYTES,
} from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { getNodeRole, assertPlainTablesWritable } from '../config/node-role.js';
import { isNodeOwner, NODE_ROLE_ACTS, type MemberNodeRole } from './node-roles.js';
import { recordDepartedDebt, openDebtOfEntry, debtRecord, startWorkOff, workOffGoesLive, endWorkOff } from './names-debts.js';

export const NAMES_TWO_ADMINS_KEY = 'names_two_admins';

export type NamesAction = 'read' | 'export' | 'add' | 'edit' | 'delete' | 'confirm' | 'second' | 'revoke'
    | 'key_made' | 'key_changed' | 'key_shared' | 'holder_dropped' | 'settings' | 'copy_restored';

/** The log's actor for what the node did itself. */
export const NODE_ACTOR = 'node';

/** A refusal, with the status and code a route answers with. The message is said to an admin as it is. */
export class NamesListError extends Error {
    /** `extra`: more the route answers with, beside `error` and `code` (a stale copy's stored seq). */
    constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
        super(message);
        this.name = 'NamesListError';
    }
}

export const NAMES_MESSAGES = {
    adminsOnly: 'Only the community’s owners and admins can open the names list.',
    ownerOnly: 'Only an owner can change how the names list works.',
    newKeyFirst: 'Someone stopped being an admin, so the names list needs a new key before anything more is written. '
        + 'Open the names list on the phone of an admin who holds its key: it makes one.',
    noKey: 'You don’t hold the names list’s key yet. An admin who holds it sends it the next time they open the names list, once your phones have checked each other.',
    askForShare: 'Another admin holds the names list’s key, so they make the next one. Their phone sends it to yours the next time they open the names list.',
    stale: 'The names list’s key history moved on since this phone looked. Open the list again.',
    staleKey: 'The names list has a newer key than this phone used. Open the list again and try once more.',
    notBuilt: 'Showing real names to members isn’t built yet. Only the community’s admins can read the names list.',
} as const;

// ── Who ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NamesAdmin {
    pubkey: string;
    callsign: string;
    role: MemberNodeRole;
}

/** The owners and admins whose role acts: the people the names list is for. */
export function namesAdmins(): NamesAdmin[] {
    return db.prepare(
        `SELECT nr.member_pubkey AS pubkey, nr.role AS role, m.callsign AS callsign
         FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
         WHERE (nr.role = 'owner' OR nr.role = 'admin') AND ${NODE_ROLE_ACTS}
         ORDER BY (nr.role = 'owner') DESC, nr.granted_at ASC, nr.member_pubkey ASC`,
    ).all() as NamesAdmin[];
}

function isNamesAdmin(pubkey: string): boolean {
    return namesAdmins().some((a) => a.pubkey === pubkey);
}

/** Throws unless `actor` is an owner or admin here whose role acts. */
export function assertNamesAdmin(actor: string): void {
    if (!isNamesAdmin(actor)) throw new NamesListError(403, 'admins_only', NAMES_MESSAGES.adminsOnly);
}

// ── The log ──────────────────────────────────────────────────────────────────────────────────────────────────────

function log(actor: string, action: NamesAction, entryId: string | null = null, subject: string | null = null): void {
    db.prepare('INSERT INTO names_access_log (id, actor_pubkey, action, entry_id, subject_pubkey) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, entryId, subject);
}

export interface NamesLogLine {
    id: string;
    actor: string;
    actorCallsign: string | null;
    action: NamesAction;
    entryId: string | null;
    subject: string | null;
    subjectCallsign: string | null;
    at: string;
}

/** The access log, newest first. Reading it is not itself logged: it names no one but admins and keys. */
export function readNamesLog(limit: number, offset: number): { log: NamesLogLine[]; total: number } {
    const rows = db.prepare(
        `SELECT l.id, l.actor_pubkey AS actor, a.callsign AS actorCallsign, l.action, l.entry_id AS entryId,
                l.subject_pubkey AS subject, s.callsign AS subjectCallsign, l.at
         FROM names_access_log l
         LEFT JOIN members a ON a.public_key = l.actor_pubkey
         LEFT JOIN members s ON s.public_key = l.subject_pubkey
         ORDER BY l.at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as NamesLogLine[];
    const total = (db.prepare('SELECT COUNT(*) AS c FROM names_access_log').get() as { c: number }).c;
    return { log: rows, total };
}

// ── The key history ──────────────────────────────────────────────────────────────────────────────────────────────

let communityIdCache: string | null = null;

/**
 * This community's id (genesis.json `communityId`, the same on a standby and after a take-over): what every statement
 * and share header is bound to, so one signed for one community never counts in another.
 */
export function namesCommunityId(): string {
    if (communityIdCache) return communityIdCache;
    try {
        const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const id = JSON.parse(fs.readFileSync(path.join(dir, 'genesis.json'), 'utf8'))?.communityId;
        if (isNamesCommunityId(id)) {
            communityIdCache = id;
            return id;
        }
    } catch { /* said below */ }
    throw new NamesListError(503, 'no_community_id', 'This server has no community id yet (its genesis.json), so the names list’s keys can’t be checked. Restart the server.');
}

interface GenerationRow { id: string; n: number; parent_id: string | null; maker: string; drops: string; statement: string; signature: string; created_at: string }

/** The current generation: the one with the highest number, or null before the list has one. */
export function currentGeneration(): GenerationRow | null {
    return (db.prepare('SELECT * FROM names_generations ORDER BY n DESC LIMIT 1').get() as GenerationRow | undefined) ?? null;
}

function generationRow(id: unknown): GenerationRow | undefined {
    return typeof id === 'string' ? db.prepare('SELECT * FROM names_generations WHERE id = ?').get(id) as GenerationRow | undefined : undefined;
}

const idsOf = (s: string | null) => (s ? s.split(',').filter(Boolean) : []);

/**
 * Who MAY hold key `keyId` (design Addendum 4, `mayHold`): whoever made it, and whoever a share to or from names it with,
 * less a holder marked as no longer holding it ({@link reconcileHolders}). A box sealed to a key is readable by whoever
 * holds that key, honest phone or not, so this loose count is what the write freeze and `no_key` use. Never trust.
 */
function holdersOf(keyId: string): Set<string> {
    const out = new Set<string>();
    const g = generationRow(keyId);
    if (g) out.add(g.maker);
    const rows = db.prepare(`SELECT from_pubkey, to_pubkey FROM names_shares WHERE instr(',' || key_ids || ',', ',' || ? || ',') > 0`).all(keyId) as { from_pubkey: string; to_pubkey: string }[];
    for (const r of rows) {
        out.add(r.from_pubkey);
        out.add(r.to_pubkey);
    }
    for (const r of db.prepare('SELECT holder_pubkey FROM names_dropped_holders WHERE key_id = ?').all(keyId) as { holder_pubkey: string }[]) out.delete(r.holder_pubkey);
    return out;
}

/**
 * Who holds key `keyId` on their own word (design Addendum 4, `holds`): whoever made it, and whoever's own signed share
 * header lists it, less a holder marked as no longer holding it. A box addressed to a phone proves nothing about that
 * phone: an honest one opens it only from a key it trusts, for a statement on its chain. This count feeds the admins'
 * `keyIds`, `holdersOfCurrent`, `nobodyHoldsKey`, `counts.locked` and `ask_for_share`. A hint for the phones, never trust.
 */
function holdsOf(keyId: string): Set<string> {
    const out = new Set<string>();
    const g = generationRow(keyId);
    if (g) out.add(g.maker);
    const rows = db.prepare(`SELECT from_pubkey FROM names_shares WHERE instr(',' || key_ids || ',', ',' || ? || ',') > 0`).all(keyId) as { from_pubkey: string }[];
    for (const r of rows) out.add(r.from_pubkey);
    for (const r of db.prepare('SELECT holder_pubkey FROM names_dropped_holders WHERE key_id = ?').all(keyId) as { holder_pubkey: string }[]) out.delete(r.holder_pubkey);
    return out;
}

/** The key ids `pubkey` holds on its own word (see {@link holdsOf}): made, or listed in its own share headers. */
function keyIdsHeldBy(pubkey: string): string[] {
    const ids = new Set<string>();
    for (const r of db.prepare('SELECT id FROM names_generations WHERE maker = ?').all(pubkey) as { id: string }[]) ids.add(r.id);
    for (const r of db.prepare('SELECT key_ids FROM names_shares WHERE from_pubkey = ?').all(pubkey) as { key_ids: string }[]) {
        for (const id of idsOf(r.key_ids)) ids.add(id);
    }
    for (const r of db.prepare('SELECT key_id FROM names_dropped_holders WHERE holder_pubkey = ?').all(pubkey) as { key_id: string }[]) ids.delete(r.key_id);
    return [...ids].sort();
}

/** Whether a holder of the current key stopped being an admin since it was made: nothing is written until a new one. */
export function newKeyNeeded(current = currentGeneration()): boolean {
    if (!current) return false;
    return !!db.prepare('SELECT 1 FROM names_dropped_holders WHERE key_id = ? LIMIT 1').get(current.id);
}

/** The holders of key `keyId` marked as no longer holding it. */
export function droppedHoldersOf(keyId: string): string[] {
    return (db.prepare('SELECT holder_pubkey FROM names_dropped_holders WHERE key_id = ? ORDER BY holder_pubkey').all(keyId) as { holder_pubkey: string }[])
        .map((r) => r.holder_pubkey);
}

function markDropped(pubkey: string, keyId: string): boolean {
    const done = db.prepare('INSERT OR IGNORE INTO names_dropped_holders (holder_pubkey, key_id) VALUES (?, ?)').run(pubkey, keyId).changes > 0;
    if (done) log(NODE_ACTOR, 'holder_dropped', null, pubkey);
    return done;
}

/**
 * Marks every holder of the current key who is no owner or admin here now (see the header): the write freeze, and a
 * log line each, once. On a main server, at the start of every names-list request, so nothing is read or written here
 * before it. A standby writes none of these rows and does nothing. Returns who went.
 */
export function reconcileHolders(): string[] {
    if (getNodeRole() === 'backup') return [];
    const current = currentGeneration();
    if (!current) return [];
    const admins = new Set(namesAdmins().map((a) => a.pubkey));
    const gone = [...holdersOf(current.id)].filter((k) => !admins.has(k)).sort();
    if (gone.length === 0) return [];
    db.transaction(() => { for (const k of gone) markDropped(k, current.id); })();
    return gone;
}

function refuse(code: string, message: string): never {
    throw new NamesListError(400, code, message);
}

/**
 * A statement of the list's key history (see the header): `{ statement, signature, replay? }`. `exists` when this server
 * has it already (a retry, or a replay). Never decides who is dropped, and never leaps: a statement numbered past the
 * next is refused like any other that isn't off the current one (409 `stale`).
 */
export function addGeneration(actor: string, body: { statement?: unknown; signature?: unknown; replay?: unknown }): { id: string; n: number; exists: boolean } {
    assertPlainTablesWritable();
    const communityId = namesCommunityId();
    const statement = typeof body.statement === 'string' ? body.statement : '';
    const shape = readNamesGeneration({ statement, signature: '' }, undefined, new Set([namesStatementId(statement)]));
    if (!shape) refuse('bad_statement', 'A key statement is not in the names list’s form.');
    if (shape.communityId !== communityId) refuse('bad_statement', 'That key statement is for another community.');
    const g = readNamesGeneration({ statement, signature: body.signature }, communityId);
    if (!g) refuse('bad_signature', 'Every key statement is signed by the admin it names as its maker. This one isn’t.');
    const existing = generationRow(g.id);
    if (existing) return { id: existing.id, n: existing.n, exists: true };
    const current = currentGeneration();
    if ((g.parentId ?? null) !== (current?.id ?? null) || g.n !== (current ? current.n + 1 : 1)) throw new NamesListError(409, 'stale', NAMES_MESSAGES.stale);
    if (g.maker === actor && body.replay !== true && current) {
        const admins = new Set(namesAdmins().map((a) => a.pubkey));
        // On their own word (Addendum 4): a box addressed to an admin doesn't make them a holder.
        const holders = [...holdsOf(current.id)].filter((k) => admins.has(k));
        if (holders.length > 0 && !holders.includes(actor)) throw new NamesListError(409, 'ask_for_share', NAMES_MESSAGES.askForShare);
    }
    db.transaction(() => {
        db.prepare('INSERT INTO names_generations (id, n, parent_id, maker, drops, statement, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(g.id, g.n, g.parentId, g.maker, g.drops.join(','), g.statement, g.signature);
        log(actor, current ? 'key_changed' : 'key_made');
    })();
    return { id: g.id, n: g.n, exists: false };
}

/**
 * A share (see the header): `{ header, signature, box }`, signed by the requester, to another owner or admin here, with a
 * head and key ids this server has statements for, and the box its header names. Replaces the requester's last share to
 * that admin, and is logged.
 */
export function addShare(actor: string, body: { header?: unknown; signature?: unknown; box?: unknown }): { to: string } {
    assertPlainTablesWritable();
    const communityId = namesCommunityId();
    const s = readNamesShare({ header: body.header, signature: body.signature, box: body.box }, communityId);
    if (!s || s.from !== actor) refuse('bad_signature', 'Every share is signed by the admin who sends it, for this community. This one isn’t.');
    if (!s.box) refuse('bad_box', 'A share carries the box its header names.');
    // A header addressed to its own sender is that admin's claim to hold the keys it names (design Addendum 5): its box is
    // sealed to the sender alone, and it counts in `holdsOf` like any header the sender signs.
    if (!isNamesAdmin(s.to)) throw new NamesListError(400, 'not_admin', 'The keys are only for the community’s owners and admins.');
    if (!generationRow(s.headId) || s.keyIds.some((id) => !generationRow(id))) refuse('unknown_key', 'A share names only keys this server has a statement for.');
    const box = s.box;
    db.transaction(() => {
        db.prepare(
            `INSERT INTO names_shares (from_pubkey, to_pubkey, head_id, key_ids, trusts, sealed_ring, ring_iv, ring_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(from_pubkey, to_pubkey) DO UPDATE SET head_id = excluded.head_id, key_ids = excluded.key_ids, trusts = excluded.trusts,
                 sealed_ring = excluded.sealed_ring, ring_iv = excluded.ring_iv, ring_tag = excluded.ring_tag, ephemeral_pubkey = excluded.ephemeral_pubkey,
                 kdf_params = excluded.kdf_params, box_digest = excluded.box_digest, header = excluded.header, signature = excluded.signature,
                 created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        ).run(s.from, s.to, s.headId, s.keyIds.join(','), s.trusts.join(','), box.sealedRing, box.ringIv, box.ringTag, box.ephemeralPubkey, box.kdfParams,
            s.boxDigest, s.header, s.signature);
        log(actor, 'key_shared', null, s.to);
    })();
    return { to: s.to };
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Throws unless a write may be sealed under `keyId` by `actor` now: no freeze, the current key, and a holder of it. */
function assertMayWrite(actor: string, keyId: unknown): string {
    const current = currentGeneration();
    if (!current) throw new NamesListError(409, 'no_list_key', 'The names list has no key yet. Open it on your phone: it makes one.');
    if (newKeyNeeded(current)) throw new NamesListError(409, 'new_key_first', NAMES_MESSAGES.newKeyFirst);
    if (keyId !== current.id) throw new NamesListError(409, 'stale_key', NAMES_MESSAGES.staleKey);
    if (!holdersOf(current.id).has(actor)) throw new NamesListError(403, 'no_key', NAMES_MESSAGES.noKey);
    return current.id;
}

function assertCiphertext(v: unknown): string {
    if (!isNamesEntryCiphertext(v)) {
        throw new NamesListError(400, 'not_sealed', 'An entry must be sealed on an admin’s phone before it is sent. This server never takes a name it could read.');
    }
    return v;
}

interface EntryRow { id: string; ciphertext: string; key_id: string; created_by: string; created_at: string; updated_by: string | null; updated_at: string }

function entryRow(id: string): EntryRow | undefined {
    return db.prepare('SELECT * FROM names_entries WHERE id = ?').get(id) as EntryRow | undefined;
}

function requireEntry(id: unknown): EntryRow {
    if (!isNamesEntryId(id)) throw new NamesListError(400, 'bad_entry_id', 'An entry id is 32 hexadecimal characters.');
    const row = entryRow(id);
    if (!row) throw new NamesListError(404, 'no_entry', 'There is no such entry in the names list.');
    return row;
}

export function addEntry(actor: string, body: { id?: unknown; ciphertext?: unknown; keyId?: unknown }): { id: string } {
    assertPlainTablesWritable();
    const keyId = assertMayWrite(actor, body.keyId);
    if (!isNamesEntryId(body.id)) throw new NamesListError(400, 'bad_entry_id', 'An entry id is 32 hexadecimal characters.');
    const ciphertext = assertCiphertext(body.ciphertext);
    const id = body.id;
    if (entryRow(id)) throw new NamesListError(409, 'entry_exists', 'There is already an entry with that id.');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM names_entries').get() as { c: number }).c;
    if (count >= NAMES_LIMITS.entries) throw new NamesListError(409, 'list_full', `The names list holds at most ${NAMES_LIMITS.entries} entries.`);
    db.transaction(() => {
        db.prepare('INSERT INTO names_entries (id, ciphertext, key_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)')
            .run(id, ciphertext, keyId, actor, actor);
        log(actor, 'add', id);
    })();
    return { id };
}

/** An edit, sealed under the current key. A locked entry (sealed under a key nobody here holds) may be typed again this way. */
export function editEntry(actor: string, id: unknown, body: { ciphertext?: unknown; keyId?: unknown }): { id: string } {
    assertPlainTablesWritable();
    const keyId = assertMayWrite(actor, body.keyId);
    const row = requireEntry(id);
    const ciphertext = assertCiphertext(body.ciphertext);
    db.transaction(() => {
        db.prepare('UPDATE names_entries SET ciphertext = ?, key_id = ?, updated_by = ? WHERE id = ?').run(ciphertext, keyId, actor, row.id);
        log(actor, 'edit', row.id);
    })();
    return { id: row.id };
}

/** Deletes an entry. Not while a member's confirmation against it stands: revoke that first. */
export function deleteEntry(actor: string, id: unknown): { id: string } {
    assertPlainTablesWritable();
    const row = requireEntry(id);
    if (liveConfirmationOfEntry(row.id)) {
        throw new NamesListError(409, 'entry_confirmed', 'A member is confirmed against this entry. Revoke the confirmation first.');
    }
    db.transaction(() => {
        deletePlainRows('names_entries', 'id = ?', row.id);
        log(actor, 'delete', row.id);
    })();
    return { id: row.id };
}

// ── Confirmations ────────────────────────────────────────────────────────────────────────────────────────────────

interface ConfirmationRow {
    id: string; member_pubkey: string; entry_id: string; confirmed_by: string; confirmed_at: string; needs_second: number;
    seconded_by: string | null; seconded_at: string | null; revoked_by: string | null; revoked_at: string | null;
    revoke_reason: string | null;
}

export type ConfirmationStatus = 'confirmed' | 'awaiting_second' | 'revoked';

export function confirmationStatus(r: Pick<ConfirmationRow, 'needs_second' | 'seconded_at' | 'revoked_at'>): ConfirmationStatus {
    if (r.revoked_at) return 'revoked';
    return r.needs_second && !r.seconded_at ? 'awaiting_second' : 'confirmed';
}

function liveConfirmationOfEntry(entryId: string): ConfirmationRow | undefined {
    return db.prepare('SELECT * FROM confirmations WHERE entry_id = ? AND revoked_at IS NULL').get(entryId) as ConfirmationRow | undefined;
}

function confirmationRow(id: unknown): ConfirmationRow {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw new NamesListError(400, 'bad_confirmation_id', 'A confirmation id is 32 hexadecimal characters.');
    const row = db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as ConfirmationRow | undefined;
    if (!row) throw new NamesListError(404, 'no_confirmation', 'There is no such confirmation.');
    return row;
}

/** The owner's setting: whether a confirmation needs a second admin (where two admins other than the member can give it). */
export function twoAdminsToConfirm(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(NAMES_TWO_ADMINS_KEY) as { value: string } | undefined;
    return row?.value === 'true';
}

/** A member who may be confirmed: an active member's row, not a visitor's, an enterprise's or the system's. */
function assertConfirmable(pubkey: string): void {
    const m = getMember(db, pubkey);
    if (!m || m.status !== 'active' || isVisitorKey(db, pubkey) || m.isTreasury || pubkey === 'SYSTEM') {
        throw new NamesListError(404, 'not_member', 'Only an active member of this community can be confirmed.');
    }
}

export function confirmMember(actor: string, body: { memberPubkey?: unknown; entryId?: unknown }, workOff?: { debtId: string }): { id: string; status: ConfirmationStatus } {
    assertPlainTablesWritable();
    const member = typeof body.memberPubkey === 'string' ? body.memberPubkey.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(member)) throw new NamesListError(400, 'bad_member', "'memberPubkey' is a member's key, 64 hexadecimal characters.");
    const entry = requireEntry(body.entryId);
    assertConfirmable(member);
    if (!holdersOf(entry.key_id).has(actor)) throw new NamesListError(403, 'no_key', 'You can’t open that entry, so you can’t confirm anyone against it.');
    const admins = namesAdmins();
    if (member === actor && admins.length > 1) {
        throw new NamesListError(403, 'self_confirm', 'Another admin confirms you. An admin confirms themselves only where they are the community’s only admin.');
    }
    // A second chance is an admin's decision once the debt is addressed (design §4.2): paid back, worked off or forgiven.
    const debt = openDebtOfEntry(entry.id);
    if (debt && debt.id !== workOff?.debtId) {
        throw new NamesListError(409, 'open_debt', `The person on this entry left owing the Commons ${debt.amount} Beans, and that debt is still open. Settle it first: they pay it back, work it off, or the community forgives it.`, { debtId: debt.id });
    }
    if (liveConfirmationOfEntry(entry.id)) throw new NamesListError(409, 'entry_taken', 'A member is confirmed against this entry already. One person, one entry.');
    if (db.prepare('SELECT 1 FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(member)) {
        throw new NamesListError(409, 'already_confirmed', 'This member is confirmed already. Revoke that confirmation first.');
    }
    // A second admin must be neither the first nor the member: counted without the member, so a community of two admins
    // can still confirm each of them (one confirms the other; nobody else could second it).
    const needsSecond = twoAdminsToConfirm() && admins.filter((a) => a.pubkey !== member).length >= 2 ? 1 : 0;
    const id = crypto.randomBytes(16).toString('hex');
    db.transaction(() => {
        db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, ?)')
            .run(id, member, entry.id, actor, needsSecond);
        log(actor, 'confirm', entry.id, member);
        // Working the debt off (design §4.2 (b)): a known floor of 0, and every Bean above 0 they receive goes to the
        // Commons until the debt is cleared (state-engine.ts sweepRepayment).
        if (workOff) startWorkOff(actor, workOff.debtId, member, !needsSecond);
    })();
    return { id, status: needsSecond ? 'awaiting_second' : 'confirmed' };
}

/** Confirms a member against the entry of an open debt to work it off (POST /api/names/debts/:id/work-off). */
export function confirmToWorkOff(actor: string, debtId: unknown, body: { memberPubkey?: unknown }): { id: string; status: ConfirmationStatus } {
    const debt = typeof debtId === 'string' ? debtRecord(debtId) : undefined;
    if (!debt) throw new NamesListError(404, 'no_debt', 'There is no such debt record.');
    if (debt.status !== 'open') throw new NamesListError(409, 'not_open', `That debt is ${debt.status} already.`);
    if (debt.repaying_pubkey) throw new NamesListError(409, 'repaying', 'Someone is working that debt off already.');
    return confirmMember(actor, { memberPubkey: body.memberPubkey, entryId: debt.entry_id }, { debtId: debt.id });
}

export function secondConfirmation(actor: string, id: unknown): { id: string; status: ConfirmationStatus } {
    assertPlainTablesWritable();
    const row = confirmationRow(id);
    if (row.revoked_at) throw new NamesListError(409, 'revoked', 'That confirmation was revoked.');
    if (!row.needs_second || row.seconded_at) throw new NamesListError(409, 'not_awaiting', 'That confirmation doesn’t need a second admin.');
    if (row.confirmed_by === actor) throw new NamesListError(403, 'same_admin', 'A second admin, not the one who confirmed, confirms it again.');
    if (row.member_pubkey === actor) throw new NamesListError(403, 'self_confirm', 'Another admin confirms you.');
    const entry = entryRow(row.entry_id);
    if (!entry || !holdersOf(entry.key_id).has(actor)) throw new NamesListError(403, 'no_key', 'You can’t open that entry, so you can’t confirm anyone against it.');
    db.transaction(() => {
        db.prepare("UPDATE confirmations SET seconded_by = ?, seconded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(actor, row.id);
        log(actor, 'second', row.entry_id, row.member_pubkey);
        workOffGoesLive(actor, row.member_pubkey, row.entry_id);
    })();
    return { id: row.id, status: 'confirmed' };
}

export function revokeConfirmation(actor: string, id: unknown): { id: string; status: ConfirmationStatus } {
    assertPlainTablesWritable();
    const row = confirmationRow(id);
    if (row.revoked_at) throw new NamesListError(409, 'revoked', 'That confirmation was revoked already.');
    db.transaction(() => {
        db.prepare("UPDATE confirmations SET revoked_by = ?, revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoke_reason = 'admin' WHERE id = ?")
            .run(actor, row.id);
        log(actor, 'revoke', row.entry_id, row.member_pubkey);
        // A work-off confirmation revoked: the repayment flag and the 0 floor end with it (engine/names-debts.ts).
        endWorkOff(actor, row.member_pubkey, row.entry_id);
    })();
    return { id: row.id, status: 'revoked' };
}

/**
 * A member leaving: their live confirmation is revoked (`removed` by the community or an admin, `account_deleted` by
 * themselves), and, where they held the current key, they are marked as no longer holding it (a new key is then needed
 * before anything is written). Called inside adminPruneUser's and purgeMemberSelf's transactions (state-engine.ts), on a
 * main server, with the balance they had before the Commons settled it.
 */
export function dropNamesListHoldOf(pubkey: string, reason: 'removed' | 'account_deleted', balance = 0): void {
    // Leaving in debt (`balance` before the Commons settled it): a debt record on their entry (engine/names-debts.ts).
    const live = db.prepare('SELECT entry_id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(pubkey) as { entry_id: string } | undefined;
    recordDepartedDebt(pubkey, live?.entry_id ?? null, balance, reason);
    db.prepare(`UPDATE confirmations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoke_reason = ?
                WHERE member_pubkey = ? AND revoked_at IS NULL`).run(reason, pubkey);
    const current = currentGeneration();
    if (current && holdersOf(current.id).has(pubkey)) markDropped(pubkey, current.id);
    dropNamesCopyOf(pubkey);
}

// ── The locked copy ─────────────────────────────────────────────────────────────────────────────────────────────
// Each admin's copy of their own names-list record (scratch/global-node/DESIGN-names-locked-copy-opus.md §4): sealed to
// their member key and signed by it on their phone (@beanpool/core makeNamesCopy). This server never opens or changes
// one; what it checks on a save only keeps it tidy (one row per admin, written by that admin, for this community, newer
// than the last). The phone's own checks are the defence. The address in the header is never checked here: a node
// doesn't know which address its admins' phones use, and none may need ours.

export const NAMES_COPIES_PER_HOUR = 30;
const COPY_WINDOW_MS = 60 * 60 * 1000;
const copySaves = new Map<string, number[]>();

interface CopyRow {
    owner_pubkey: string; seq: number; head_n: number; head_id: string; saved_at: string; sealed_copy: string; copy_iv: string; copy_tag: string;
    ephemeral_pubkey: string; kdf_params: string; box_digest: string; header: string; signature: string;
}

function copyRow(owner: string): CopyRow | undefined {
    return db.prepare('SELECT * FROM names_copies WHERE owner_pubkey = ?').get(owner) as CopyRow | undefined;
}

/** What `GET /api/names/state` says of the requester's own copy: its header's numbers, or null. Never anyone else's. */
export function myNamesCopy(actor: string): { seq: number; headN: number; headId: string | null; savedAt: string; digest: string } | null {
    const r = copyRow(actor);
    return r ? { seq: r.seq, headN: r.head_n, headId: r.head_id === '-' ? null : r.head_id, savedAt: r.saved_at, digest: r.box_digest } : null;
}

/** The requester's own copy, as their phone sent it, for a phone that lost its record: logged (`copy_restored`). */
export function readNamesCopyOf(actor: string): { header: string; signature: string; box: Record<string, string> } {
    const r = copyRow(actor);
    if (!r) throw new NamesListError(404, 'no_copy', 'This server keeps no copy of your names-list record.');
    log(actor, 'copy_restored');
    return {
        header: r.header, signature: r.signature,
        box: { sealedCopy: r.sealed_copy, copyIv: r.copy_iv, copyTag: r.copy_tag, ephemeralPubkey: r.ephemeral_pubkey, kdfParams: r.kdf_params },
    };
}

/** Counts a save toward the requester's hourly cap; throws 429 `too_many_copies` past it. */
function chargeCopySave(actor: string, now = Date.now()): void {
    const recent = (copySaves.get(actor) ?? []).filter((t) => now - t < COPY_WINDOW_MS);
    if (recent.length >= NAMES_COPIES_PER_HOUR) {
        copySaves.set(actor, recent);
        throw new NamesListError(429, 'too_many_copies', 'This phone saved its names-list record too often in the last hour. Try again later.');
    }
    recent.push(now);
    copySaves.set(actor, recent);
}

/**
 * The requester's copy (`{ header, signature, box }`), saved over their last: `exists` for the identical header (a
 * retry), refused for a seq not newer than the one kept. Not logged: a save reveals nothing.
 */
export function saveNamesCopy(actor: string, body: { header?: unknown; signature?: unknown; box?: unknown }): { seq: number; exists: boolean } {
    assertPlainTablesWritable();
    chargeCopySave(actor);
    const sealed = (body.box as { sealedCopy?: unknown } | null | undefined)?.sealedCopy;
    if (typeof sealed === 'string' && Buffer.byteLength(sealed, 'base64') > NAMES_COPY_MAX_BYTES) {
        throw new NamesListError(413, 'copy_too_big', 'Your names-list record is too big to keep a copy on this server.');
    }
    const read = readNamesCopy(body);
    if (!read.ok) throw new NamesListError(400, 'bad_copy', 'That isn’t a copy of a names-list record signed by the key that sent it.');
    const c = read.copy;
    if (c.owner !== actor) throw new NamesListError(403, 'not_yours', 'Each admin saves only their own copy.');
    if (c.communityId !== namesCommunityId()) throw new NamesListError(400, 'other_community', 'That copy is of another community’s names list.');
    const kept = copyRow(actor);
    if (kept && kept.header === c.header) return { seq: kept.seq, exists: true };
    if (kept && c.seq <= kept.seq) {
        throw new NamesListError(409, 'stale_copy', 'This server already keeps a newer copy of your names-list record.', { seq: kept.seq });
    }
    db.prepare(
        `INSERT INTO names_copies (owner_pubkey, seq, head_n, head_id, saved_at, sealed_copy, copy_iv, copy_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_pubkey) DO UPDATE SET seq = excluded.seq, head_n = excluded.head_n, head_id = excluded.head_id, saved_at = excluded.saved_at,
             sealed_copy = excluded.sealed_copy, copy_iv = excluded.copy_iv, copy_tag = excluded.copy_tag, ephemeral_pubkey = excluded.ephemeral_pubkey,
             kdf_params = excluded.kdf_params, box_digest = excluded.box_digest, header = excluded.header, signature = excluded.signature,
             created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(actor, c.seq, c.headN, c.headId ?? '-', c.savedAt, c.box.sealedCopy, c.box.copyIv, c.box.copyTag, c.box.ephemeralPubkey, c.box.kdfParams,
        c.boxDigest, c.header, c.signature);
    return { seq: c.seq, exists: false };
}

/**
 * The copy of a key that stopped being a member here (removed, account deleted, replaced by a re-key), with a tombstone
 * so a standby drops it too. Not on demotion: a re-admitted admin carries on from their record.
 */
export function dropNamesCopyOf(pubkey: string): void {
    deletePlainRows('names_copies', 'owner_pubkey = ?', pubkey);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The name each key goes by, for the words a phone says ("@Ada made a key…"): a member's callsign, or, for a key a
 * re-key replaced, the callsign of the member it moved to. Only words: a phone never trusts a key by its name.
 */
function callsignsFor(keys: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    const name = db.prepare('SELECT callsign FROM members WHERE public_key = ?');
    const next = db.prepare('SELECT new_pubkey FROM rekey_audit_log WHERE old_pubkey = ? ORDER BY id DESC LIMIT 1');
    for (const k of keys) {
        let at: string | undefined = k;
        for (let hop = 0; at && hop < 5; hop++) {
            const m = name.get(at) as { callsign: string } | undefined;
            if (m) { out[k] = m.callsign; break; }
            at = (next.get(at) as { new_pubkey: string } | undefined)?.new_pubkey;
        }
    }
    return out;
}

interface ShareRow {
    from_pubkey: string; to_pubkey: string; head_id: string; key_ids: string; trusts: string; sealed_ring: string; ring_iv: string; ring_tag: string;
    ephemeral_pubkey: string; kdf_params: string; box_digest: string; header: string; signature: string; created_at: string;
}

/**
 * What the list screen needs first (design §5): the community's id the statements are bound to, the current
 * generation, every statement and every share header (the box only of a share to this admin), the admins with the key
 * ids each holds as far as this server can tell, who holds the current key, the write freeze, the settings and counts.
 * Not logged: no entry.
 */
export function namesState(actor: string) {
    const communityId = namesCommunityId();
    const current = currentGeneration();
    const admins = namesAdmins();
    // Holders on their own word (Addendum 4); the loose count (holdersOf) is only for the freeze and `no_key`.
    const holders = current ? holdsOf(current.id) : new Set<string>();
    const adminKeys = new Set(admins.map((a) => a.pubkey));
    const generations = (db.prepare('SELECT * FROM names_generations ORDER BY n ASC').all() as GenerationRow[]).map((g) => ({
        statement: g.statement, signature: g.signature, id: g.id, n: g.n, parentId: g.parent_id, maker: g.maker, drops: idsOf(g.drops), createdAt: g.created_at,
    }));
    const shares = (db.prepare('SELECT * FROM names_shares ORDER BY created_at ASC, from_pubkey ASC, to_pubkey ASC').all() as ShareRow[]).map((r) => ({
        header: r.header, signature: r.signature, from: r.from_pubkey, to: r.to_pubkey, headId: r.head_id, keyIds: idsOf(r.key_ids), trusts: idsOf(r.trusts),
        boxDigest: r.box_digest, createdAt: r.created_at,
        ...(r.to_pubkey === actor
            ? { box: { sealedRing: r.sealed_ring, ringIv: r.ring_iv, ringTag: r.ring_tag, ephemeralPubkey: r.ephemeral_pubkey, kdfParams: r.kdf_params } }
            : {}),
    }));
    const byKey = Object.fromEntries((db.prepare('SELECT key_id AS k, COUNT(*) AS c FROM names_entries GROUP BY key_id').all() as { k: string; c: number }[]).map((r) => [r.k, r.c]));
    const heldByAdmin = new Map(admins.map((a) => [a.pubkey, keyIdsHeldBy(a.pubkey)] as const));
    const heldByAny = new Set([...heldByAdmin.values()].flat());
    const counts = db.prepare(
        `SELECT (SELECT COUNT(*) FROM names_entries) AS entries,
                (SELECT COUNT(*) FROM confirmations WHERE revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL)) AS confirmed,
                (SELECT COUNT(*) FROM confirmations WHERE revoked_at IS NULL AND needs_second = 1 AND seconded_at IS NULL) AS awaitingSecond`,
    ).get() as { entries: number; confirmed: number; awaitingSecond: number };
    const holdersOfCurrent = [...holders].filter((k) => adminKeys.has(k)).sort();
    const named = new Set<string>([...adminKeys]);
    for (const g of generations) { named.add(g.maker); for (const d of g.drops) named.add(d); }
    for (const s of shares) { named.add(s.from); named.add(s.to); for (const t of s.trusts) named.add(t); }
    return {
        communityId,
        current: current ? { id: current.id, n: current.n } : null,
        generations,
        shares,
        admins: admins.map((a) => ({ ...a, keyIds: heldByAdmin.get(a.pubkey) ?? [], holdsCurrent: holders.has(a.pubkey) })),
        holdersOfCurrent,
        droppedHolders: current ? droppedHoldersOf(current.id) : [],
        callsigns: callsignsFor(named),
        // Nobody who is an admin now holds the current key: any admin's phone may make a new one.
        nobodyHoldsKey: !!current && holdersOfCurrent.length === 0,
        newKeyNeeded: newKeyNeeded(current),
        settings: { twoAdminsToConfirm: twoAdminsToConfirm(), namesShownToMembers: false },
        counts: {
            ...counts, byKey,
            // Entries sealed under a key no admin here holds, as far as this server can tell.
            locked: Object.entries(byKey).filter(([k]) => !heldByAny.has(k)).reduce((n, [, c]) => n + c, 0),
        },
        me: { pubkey: actor, role: admins.find((a) => a.pubkey === actor)?.role ?? null, owner: isNodeOwner(actor) },
        // The requester's own locked copy (design §3): the phone saves a new one when this is behind its own.
        myCopy: myNamesCopy(actor),
        limits: NAMES_LIMITS,
    };
}

/** Every entry, sealed, and every confirmation: one read of the list, logged as a read or an export. */
export function readEntries(actor: string, purpose: 'read' | 'export') {
    const entries = (db.prepare('SELECT * FROM names_entries ORDER BY created_at ASC, id ASC').all() as EntryRow[]).map((r) => ({
        id: r.id, ciphertext: r.ciphertext, keyId: r.key_id, createdBy: r.created_by, createdAt: r.created_at,
        updatedBy: r.updated_by, updatedAt: r.updated_at,
    }));
    const confirmations = (db.prepare(
        `SELECT c.*, m.callsign AS callsign FROM confirmations c LEFT JOIN members m ON m.public_key = c.member_pubkey
         ORDER BY c.confirmed_at ASC, c.id ASC`,
    ).all() as (ConfirmationRow & { callsign: string | null })[]).map((r) => ({
        id: r.id, memberPubkey: r.member_pubkey, callsign: r.callsign, entryId: r.entry_id, confirmedBy: r.confirmed_by,
        confirmedAt: r.confirmed_at, needsSecond: !!r.needs_second, secondedBy: r.seconded_by, secondedAt: r.seconded_at,
        revokedBy: r.revoked_by, revokedAt: r.revoked_at, revokeReason: r.revoke_reason, status: confirmationStatus(r),
    }));
    // The ids an admin deleted (the log's `delete` lines, newest 10,000): a phone counts an id it saw that is neither here
    // nor deleted as lost (design Addendum 4).
    const deleted = (db.prepare(`SELECT entry_id AS id FROM names_access_log WHERE action = 'delete' AND entry_id IS NOT NULL
         ORDER BY at DESC, rowid DESC LIMIT 10000`).all() as { id: string }[]).map((r) => r.id);
    log(actor, purpose);
    return { current: currentGeneration()?.id ?? null, entries, confirmations, deleted };
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The owner's two settings: whether a confirmation needs a second admin (stored as node_config `names_two_admins`, one
 * of the community's settings, config/community-settings.ts), and whether members see real names, which stays off: it
 * isn't built (only admins hold the key), and turning it on is refused rather than pretended.
 */
export function setNamesSettings(actor: string, body: { twoAdminsToConfirm?: unknown; namesShownToMembers?: unknown }): { twoAdminsToConfirm: boolean; namesShownToMembers: false } {
    assertPlainTablesWritable();
    if (!isNodeOwner(actor)) throw new NamesListError(403, 'owner_only', NAMES_MESSAGES.ownerOnly);
    const { twoAdminsToConfirm: two, namesShownToMembers: shown } = body;
    if (two !== undefined && typeof two !== 'boolean') throw new NamesListError(400, 'bad_setting', "'twoAdminsToConfirm' is true or false.");
    if (shown !== undefined && typeof shown !== 'boolean') throw new NamesListError(400, 'bad_setting', "'namesShownToMembers' is true or false.");
    if (shown === true) throw new NamesListError(409, 'not_built', NAMES_MESSAGES.notBuilt);
    if (two === undefined && shown === undefined) throw new NamesListError(400, 'bad_setting', 'Name a setting to change.');
    db.transaction(() => {
        if (two === true) {
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(NAMES_TWO_ADMINS_KEY, 'true');
        } else if (two === false) {
            db.prepare('DELETE FROM node_config WHERE key = ?').run(NAMES_TWO_ADMINS_KEY);
        }
        log(actor, 'settings');
    })();
    return { twoAdminsToConfirm: twoAdminsToConfirm(), namesShownToMembers: false };
}
