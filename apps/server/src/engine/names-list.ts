/**
 * The names list (community modes slice 2; scratch/global-node/DESIGN-community-modes-fable.md §4.1, §4.3, §7.1, §7.4,
 * §8 item 2; Marty's answers 2026-10-01): the community's admins keep a list of who its members are, by real name, and
 * confirm a member against an entry. Kept on the node ENCRYPTED to the admins' keys: this server holds sealed text and
 * keys it can't open (schema.sql §22e; @beanpool/core names-list-crypto.ts), and the names open on an admin's phone.
 *
 * ## Who
 *
 * The community's owners and admins whose role acts (node_roles, NODE_ROLE_ACTS): signed with their own key, through the
 * signature middleware (routes/names-list.ts). A moderator, a member and anyone else are refused. Key-holding admins
 * only: the owner password reads no name through this server's routes (design §4.3). It is not what keeps the names from
 * whoever runs the server, who can make any key an admin and re-key any account: the admins' phones are (below).
 *
 * ## The list key, its generations, and what happens when an admin goes
 *
 * The first admin to open the list makes its key on their phone (generation 1) and wraps it to themselves; every write
 * is sealed under the current generation. An admin made since (by an owner) waits until an admin who holds the key
 * shares it with them, a tap on that admin's phone ({@link shareKey}). The phone offers that tap only for a key it
 * trusts: one its admin checked in person (a QR code or a code shown on the other admin's phone), or one a trusted
 * admin's signed share added; never for a key this server names by a callsign alone, since a re-key here can put an
 * admin's callsign on any key (PR #1411's second deciding review; @beanpool/core names-list-trust.ts).
 *
 * Every wrap is SIGNED by the admin who made it (@beanpool/core names-list-trust.ts), over this community's id, the
 * generation, the holder, a digest of the wrap and, for a new generation, the admins its maker dropped. This server
 * refuses a wrap whose signature isn't the requester's, keeps the signature, and lists every wrap's signed header to
 * every admin ({@link namesState} `records`). It is not what keeps the names safe from this server: an admin's phone
 * uses a wrap only where a key it already trusts signed it, so a row written straight into this database (by whoever
 * runs it, or anyone with the machine) opens nothing, and a key made an admin here (`node_roles`, which the owner
 * password reaches) is trusted by no phone until a trusted admin's signed share adds it.
 *
 * An admin who stops being one (their role revoked or changed to moderator, suspended, removed, their account deleted,
 * or their key replaced after a lost phone) is DROPPED before anything else is done here ({@link reconcileHolders}, at
 * the start of every names-list request on a main server): their wrap is cleared, and, if they held the current key,
 * the list needs a new one. Until an admin who holds it makes one ({@link installKey}: a new generation, wrapped to
 * that admin and to whichever other admins they choose), every write is refused (409 `new_key_first`), so nothing is
 * written after an admin's removal under a key they may still have. The phone that makes the new key then seals the
 * older entries again under it ({@link reEncrypt}), a batch at a time; an older generation's wraps are cleared once no
 * entry is sealed under it (their signed headers stay). A removed admin keeps whatever they already saw, as with paper.
 *
 * If nobody who is still an admin holds the current key (the only key-holder lost their phone), any admin may start a
 * new key; the entries sealed under the old one can't be opened by anyone here any more and are shown as locked: an
 * admin re-types one from the community's paper copy (an edit) or deletes it.
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
 * A standby copies all four tables as plain rows (engine/replication-manifest.ts) and serves none of this: a read writes
 * the log, which is the main server's. A take-over needs nothing more: the rows are there, and the same admins' phones
 * open them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMember, isVisitorKey } from '@beanpool/engine';
import {
    isNamesEntryCiphertext, isNamesEntryId, isWrappedNamesKey, NAMES_LIMITS, isNamesCommunityId, namesWrapDigest, normaliseNamesDrops,
    verifyNamesWrap, type WrappedNamesKey, type NamesKeyRecord,
} from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { getNodeRole, assertPlainTablesWritable } from '../config/node-role.js';
import { isNodeOwner, NODE_ROLE_ACTS, type MemberNodeRole } from './node-roles.js';

export const NAMES_TWO_ADMINS_KEY = 'names_two_admins';

export type NamesAction = 'read' | 'export' | 'add' | 'edit' | 'delete' | 'confirm' | 'second' | 'revoke'
    | 'key_made' | 'key_changed' | 'key_shared' | 're_encrypt' | 'holder_dropped' | 'settings';

/** The log's actor for what the node did itself. */
export const NODE_ACTOR = 'node';

/** A refusal, with the status and code a route answers with. The message is said to an admin as it is. */
export class NamesListError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'NamesListError';
    }
}

export const NAMES_MESSAGES = {
    adminsOnly: 'Only the community’s owners and admins can open the names list.',
    ownerOnly: 'Only an owner can change how the names list works.',
    newKeyFirst: 'Someone stopped being an admin, so the names list needs a new key before anything more is written. '
        + 'Open the names list on the phone of an admin who holds its key: it makes one.',
    noKey: 'You don’t hold the names list’s key yet. Ask an admin who holds it to open the names list: their phone shares it with you.',
    askForShare: 'Another admin holds the names list’s key. Ask them to open the names list: their phone shares it with you.',
    staleGeneration: 'The names list has a newer key than this phone used. Open the list again and try once more.',
    dropsChanged: 'Who holds the names list’s key changed since your phone looked. Open the list again and try once more.',
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

// ── The key ──────────────────────────────────────────────────────────────────────────────────────────────────────

let communityIdCache: string | null = null;

/**
 * This community's id (genesis.json `communityId`, the same on a standby and after a take-over): what every wrap's
 * signature is bound to, so a wrap signed for one community never counts in another.
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

/** The current generation: the newest a wrap or an entry names, or 0 before the list has a key. */
export function currentGeneration(): number {
    const row = db.prepare(
        `SELECT MAX(g) AS g FROM (SELECT MAX(generation) AS g FROM names_list_keys UNION ALL SELECT MAX(key_generation) FROM names_entries)`,
    ).get() as { g: number | null };
    return row.g ?? 0;
}

/** Whether a holder of the current key was dropped since it was made: the next write needs a new key. */
export function newKeyNeeded(generation = currentGeneration()): boolean {
    if (generation === 0) return false;
    return !!db.prepare('SELECT 1 FROM names_list_keys WHERE generation = ? AND dropped_at IS NOT NULL LIMIT 1').get(generation);
}

/** Who holds a live wrap of `generation`. */
function holdersOf(generation: number): Set<string> {
    const rows = db.prepare('SELECT holder_pubkey FROM names_list_keys WHERE generation = ? AND dropped_at IS NULL').all(generation) as { holder_pubkey: string }[];
    return new Set(rows.map((r) => r.holder_pubkey));
}

function holds(actor: string, generation: number): boolean {
    return !!db.prepare('SELECT 1 FROM names_list_keys WHERE holder_pubkey = ? AND generation = ? AND dropped_at IS NULL').get(actor, generation);
}

/** The wrap itself cleared; the signed header (wrapped_by, wrap_digest, drops, signature) stays, for the phones' trace. */
const CLEAR_WRAP = `wrapped_key = NULL, wrap_iv = NULL, wrap_tag = NULL, ephemeral_pubkey = NULL, kdf_params = NULL,
    dropped_at = COALESCE(dropped_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const DROP_HOLDER_SQL = `UPDATE names_list_keys SET ${CLEAR_WRAP} WHERE holder_pubkey = ? AND dropped_at IS NULL`;

/** The holders dropped from `generation`: whom the maker of the next one must name as dropped, in its signed wrap. */
export function droppedHoldersOf(generation: number): string[] {
    return (db.prepare('SELECT holder_pubkey FROM names_list_keys WHERE generation = ? AND dropped_at IS NOT NULL ORDER BY holder_pubkey')
        .all(generation) as { holder_pubkey: string }[]).map((r) => r.holder_pubkey);
}

/**
 * Drops every holder who is no owner or admin here now (see the header): their wraps cleared, a new key needed where
 * they held the current one, and a log line each. On a main server, at the start of every names-list request, so
 * nothing is read or written here before it. A standby writes none of these rows and does nothing. Returns who went.
 */
export function reconcileHolders(): string[] {
    if (getNodeRole() === 'backup') return [];
    const stale = db.prepare(
        `SELECT DISTINCT k.holder_pubkey AS pubkey FROM names_list_keys k
         WHERE k.dropped_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
             WHERE nr.member_pubkey = k.holder_pubkey AND (nr.role = 'owner' OR nr.role = 'admin') AND ${NODE_ROLE_ACTS})`,
    ).all() as { pubkey: string }[];
    if (stale.length === 0) return [];
    db.transaction(() => {
        for (const { pubkey } of stale) {
            db.prepare(DROP_HOLDER_SQL).run(pubkey);
            log(NODE_ACTOR, 'holder_dropped', null, pubkey);
        }
    })();
    return stale.map((s) => s.pubkey);
}

/**
 * The spent wraps, cleared (their signed headers stay): an older generation's once no entry is sealed under it. A dropped
 * row below the current generation was cleared when it was dropped.
 */
function tidyGenerations(generation: number): void {
    db.prepare(`UPDATE names_list_keys SET ${CLEAR_WRAP} WHERE generation < ? AND wrapped_key IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM names_entries e WHERE e.key_generation = names_list_keys.generation)`).run(generation);
}

export interface WrapIn extends WrappedNamesKey {
    holder: string;
    wrapDigest: string;
    drops: string[];
    signature: string;
}

/**
 * The wraps in a request, each checked as the phones check it: in the list's form, and signed by the requester (`actor`)
 * for this community, this generation and its holder. A wrap that isn't is refused before anything is kept.
 */
function readWraps(raw: unknown, what: string, actor: string, generation: number): WrapIn[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new NamesListError(400, 'bad_wraps', `${what} needs at least one wrapped key.`);
    if (raw.length > 50) throw new NamesListError(400, 'bad_wraps', 'At most 50 wrapped keys at once.');
    const communityId = namesCommunityId();
    const seen = new Set<string>();
    return raw.map((w) => {
        const holder = typeof (w as { holder?: unknown })?.holder === 'string' ? (w as { holder: string }).holder.toLowerCase() : '';
        if (!/^[0-9a-f]{64}$/.test(holder) || !isWrappedNamesKey(w)) throw new NamesListError(400, 'bad_wraps', 'A wrapped key is not in the names list’s form.');
        if (seen.has(holder)) throw new NamesListError(400, 'bad_wraps', 'Each admin gets one wrapped key.');
        seen.add(holder);
        let drops: string[];
        try { drops = normaliseNamesDrops((w as { drops?: unknown }).drops); } catch (e) { throw new NamesListError(400, 'bad_wraps', (e as Error).message); }
        const wrap = { wrappedKey: w.wrappedKey, wrapIv: w.wrapIv, wrapTag: w.wrapTag, ephemeralPubkey: w.ephemeralPubkey, kdfParams: w.kdfParams };
        const wrapDigest = namesWrapDigest(wrap);
        const sig = (w as { signature?: unknown }).signature;
        const signature = typeof sig === 'string' ? sig.toLowerCase() : '';
        if (!verifyNamesWrap({ communityId, generation, holder, wrappedBy: actor, wrapDigest, drops }, signature)) {
            throw new NamesListError(400, 'bad_signature', 'Every wrapped key is signed by the admin who sends it, for this community, this key and this admin. This one isn’t.');
        }
        return { holder, ...wrap, wrapDigest, drops, signature };
    });
}

function writeWraps(wraps: WrapIn[], generation: number, by: string): void {
    const insert = db.prepare(
        `INSERT INTO names_list_keys (holder_pubkey, generation, wrapped_key, wrap_iv, wrap_tag, ephemeral_pubkey, kdf_params, wrapped_by, wrap_digest, drops, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const w of wraps) {
        insert.run(w.holder, generation, w.wrappedKey, w.wrapIv, w.wrapTag, w.ephemeralPubkey, w.kdfParams, by, w.wrapDigest, w.drops.join(' '), w.signature);
    }
}

function assertWholeNumber(v: unknown, field: string): number {
    if (!Number.isSafeInteger(v) || (v as number) < 1) throw new NamesListError(400, 'bad_generation', `'${field}' must be a whole number from 1.`);
    return v as number;
}

/** How far past the current generation a new key may be numbered (see {@link installKey}). */
export const NAMES_GENERATION_LEAP = 1000;

/**
 * The list's first key, or a new one (see the header). `generation` must be newer than the current one: usually the next,
 * but a phone that already took a newer generation than this server now has (a server put back to an older copy) numbers
 * its key past what it took, so it never goes back (@beanpool/core names-list-trust.ts `newest`), at most
 * {@link NAMES_GENERATION_LEAP} ahead. The maker must be among the holders, and every holder must be an owner or admin
 * here. Where an admin still holds the current key, only such an admin may make the next: anyone else is asked to wait
 * for a share. The maker's own wrap names, signed, every holder dropped from the current generation (the reason for a
 * new key), so every phone stops trusting them, except the maker itself (an admin who was the only holder, out and made
 * an admin again, starts a new key); no other wrap names any.
 */
export function installKey(actor: string, body: { generation?: unknown; wraps?: unknown }): { generation: number } {
    assertPlainTablesWritable();
    const current = currentGeneration();
    const generation = assertWholeNumber(body.generation, 'generation');
    if (generation <= current || generation > current + NAMES_GENERATION_LEAP) throw new NamesListError(409, 'stale_generation', NAMES_MESSAGES.staleGeneration);
    const wraps = readWraps(body.wraps, 'A new key', actor, generation);
    const admins = new Set(namesAdmins().map((a) => a.pubkey));
    const own = wraps.find((w) => w.holder === actor);
    if (!own) throw new NamesListError(400, 'bad_wraps', 'Whoever makes the key holds it too: wrap it to yourself.');
    if (wraps.some((w) => !admins.has(w.holder))) throw new NamesListError(400, 'not_admin', 'The key is only for the community’s owners and admins.');
    if (current > 0) {
        const holders = holdersOf(current);
        if (holders.size > 0 && !holders.has(actor)) throw new NamesListError(409, 'ask_for_share', NAMES_MESSAGES.askForShare);
    }
    if (wraps.some((w) => w !== own && w.drops.length > 0)) throw new NamesListError(400, 'bad_wraps', 'Only the maker’s own wrap names who was dropped.');
    // Its maker is never among those it must name: a maker naming itself drops nobody (the phones' walk ignores it).
    const mustDrop = current > 0 ? droppedHoldersOf(current).filter((k) => k !== actor) : [];
    if (mustDrop.some((k) => !own.drops.includes(k))) {
        throw new NamesListError(409, 'drops_changed', NAMES_MESSAGES.dropsChanged);
    }
    db.transaction(() => {
        writeWraps(wraps, generation, actor);
        tidyGenerations(generation);
        log(actor, current === 0 ? 'key_made' : 'key_changed');
        for (const w of wraps) if (w.holder !== actor) log(actor, 'key_shared', null, w.holder);
    })();
    return { generation };
}

/** Shares the current key with admins who don't hold it yet (an admin made since, or one a new key left out). */
export function shareKey(actor: string, body: { generation?: unknown; wraps?: unknown }): { shared: string[] } {
    assertPlainTablesWritable();
    const current = currentGeneration();
    const generation = assertWholeNumber(body.generation, 'generation');
    if (generation !== current) throw new NamesListError(409, 'stale_generation', NAMES_MESSAGES.staleGeneration);
    if (newKeyNeeded(current)) throw new NamesListError(409, 'new_key_first', NAMES_MESSAGES.newKeyFirst);
    if (!holds(actor, current)) throw new NamesListError(403, 'no_key', NAMES_MESSAGES.noKey);
    const wraps = readWraps(body.wraps, 'Sharing the key', actor, current);
    const admins = new Set(namesAdmins().map((a) => a.pubkey));
    const holders = holdersOf(current);
    for (const w of wraps) {
        if (w.drops.length > 0) throw new NamesListError(400, 'bad_wraps', 'A share names nobody as dropped: only a new key does.');
        if (!admins.has(w.holder)) throw new NamesListError(400, 'not_admin', 'The key is only for the community’s owners and admins.');
        if (holders.has(w.holder)) throw new NamesListError(409, 'already_holds', 'That admin holds the key already.');
    }
    db.transaction(() => {
        // A holder dropped from an older generation and an admin again: a fresh row of this one.
        writeWraps(wraps, current, actor);
        for (const w of wraps) log(actor, 'key_shared', null, w.holder);
    })();
    return { shared: wraps.map((w) => w.holder) };
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Throws unless a write may be sealed under `keyGeneration` by `actor` now. */
function assertMayWrite(actor: string, keyGeneration: unknown): number {
    const current = currentGeneration();
    if (current === 0) throw new NamesListError(409, 'no_list_key', 'The names list has no key yet. Open it on your phone: it makes one.');
    if (newKeyNeeded(current)) throw new NamesListError(409, 'new_key_first', NAMES_MESSAGES.newKeyFirst);
    const generation = assertWholeNumber(keyGeneration, 'keyGeneration');
    if (generation !== current) throw new NamesListError(409, 'stale_generation', NAMES_MESSAGES.staleGeneration);
    if (!holds(actor, current)) throw new NamesListError(403, 'no_key', NAMES_MESSAGES.noKey);
    return current;
}

function assertCiphertext(v: unknown): string {
    if (!isNamesEntryCiphertext(v)) {
        throw new NamesListError(400, 'not_sealed', 'An entry must be sealed on an admin’s phone before it is sent. This server never takes a name it could read.');
    }
    return v;
}

interface EntryRow { id: string; ciphertext: string; key_generation: number; created_by: string; created_at: string; updated_by: string | null; updated_at: string }

function entryRow(id: string): EntryRow | undefined {
    return db.prepare('SELECT * FROM names_entries WHERE id = ?').get(id) as EntryRow | undefined;
}

function requireEntry(id: unknown): EntryRow {
    if (!isNamesEntryId(id)) throw new NamesListError(400, 'bad_entry_id', 'An entry id is 32 hexadecimal characters.');
    const row = entryRow(id);
    if (!row) throw new NamesListError(404, 'no_entry', 'There is no such entry in the names list.');
    return row;
}

export function addEntry(actor: string, body: { id?: unknown; ciphertext?: unknown; keyGeneration?: unknown }): { id: string } {
    assertPlainTablesWritable();
    const generation = assertMayWrite(actor, body.keyGeneration);
    if (!isNamesEntryId(body.id)) throw new NamesListError(400, 'bad_entry_id', 'An entry id is 32 hexadecimal characters.');
    const ciphertext = assertCiphertext(body.ciphertext);
    const id = body.id;
    if (entryRow(id)) throw new NamesListError(409, 'entry_exists', 'There is already an entry with that id.');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM names_entries').get() as { c: number }).c;
    if (count >= NAMES_LIMITS.entries) throw new NamesListError(409, 'list_full', `The names list holds at most ${NAMES_LIMITS.entries} entries.`);
    db.transaction(() => {
        db.prepare('INSERT INTO names_entries (id, ciphertext, key_generation, created_by, updated_by) VALUES (?, ?, ?, ?, ?)')
            .run(id, ciphertext, generation, actor, actor);
        log(actor, 'add', id);
    })();
    return { id };
}

/** An edit, sealed under the current key. A locked entry (sealed under a key nobody here holds) may be typed again this way. */
export function editEntry(actor: string, id: unknown, body: { ciphertext?: unknown; keyGeneration?: unknown }): { id: string } {
    assertPlainTablesWritable();
    const generation = assertMayWrite(actor, body.keyGeneration);
    const row = requireEntry(id);
    const ciphertext = assertCiphertext(body.ciphertext);
    db.transaction(() => {
        db.prepare('UPDATE names_entries SET ciphertext = ?, key_generation = ?, updated_by = ? WHERE id = ?').run(ciphertext, generation, actor, row.id);
        tidyGenerations(generation);
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
        tidyGenerations(currentGeneration());
        log(actor, 'delete', row.id);
    })();
    return { id: row.id };
}

/** Seals older entries again under the current key, a batch at a time, after a new key. The phone opened each one. */
export function reEncrypt(actor: string, body: { generation?: unknown; entries?: unknown }): { done: number; left: number } {
    assertPlainTablesWritable();
    const generation = assertWholeNumber(body.generation, 'generation');
    const current = currentGeneration();
    if (generation !== current) throw new NamesListError(409, 'stale_generation', NAMES_MESSAGES.staleGeneration);
    if (newKeyNeeded(current)) throw new NamesListError(409, 'new_key_first', NAMES_MESSAGES.newKeyFirst);
    if (!holds(actor, current)) throw new NamesListError(403, 'no_key', NAMES_MESSAGES.noKey);
    const raw = body.entries;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > NAMES_LIMITS.batch) {
        throw new NamesListError(400, 'bad_batch', `Send between 1 and ${NAMES_LIMITS.batch} entries at a time.`);
    }
    const batch = raw.map((e) => {
        const row = requireEntry((e as { id?: unknown })?.id);
        if (row.key_generation >= current) throw new NamesListError(409, 'already_current', 'That entry is sealed under the current key already.');
        if (!holds(actor, row.key_generation)) throw new NamesListError(403, 'no_key', 'You don’t hold the key that entry was sealed under.');
        return { id: row.id, ciphertext: assertCiphertext((e as { ciphertext?: unknown }).ciphertext) };
    });
    if (new Set(batch.map((b) => b.id)).size !== batch.length) throw new NamesListError(400, 'bad_batch', 'Each entry once.');
    db.transaction(() => {
        const update = db.prepare('UPDATE names_entries SET ciphertext = ?, key_generation = ?, updated_by = ? WHERE id = ?');
        for (const b of batch) update.run(b.ciphertext, current, actor, b.id);
        tidyGenerations(current);
        log(actor, 're_encrypt');
    })();
    const left = (db.prepare('SELECT COUNT(*) AS c FROM names_entries WHERE key_generation < ?').get(current) as { c: number }).c;
    return { done: batch.length, left };
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

export function confirmMember(actor: string, body: { memberPubkey?: unknown; entryId?: unknown }): { id: string; status: ConfirmationStatus } {
    assertPlainTablesWritable();
    const member = typeof body.memberPubkey === 'string' ? body.memberPubkey.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(member)) throw new NamesListError(400, 'bad_member', "'memberPubkey' is a member's key, 64 hexadecimal characters.");
    const entry = requireEntry(body.entryId);
    assertConfirmable(member);
    if (!holds(actor, entry.key_generation)) throw new NamesListError(403, 'no_key', 'You can’t open that entry, so you can’t confirm anyone against it.');
    const admins = namesAdmins();
    if (member === actor && admins.length > 1) {
        throw new NamesListError(403, 'self_confirm', 'Another admin confirms you. An admin confirms themselves only where they are the community’s only admin.');
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
    })();
    return { id, status: needsSecond ? 'awaiting_second' : 'confirmed' };
}

export function secondConfirmation(actor: string, id: unknown): { id: string; status: ConfirmationStatus } {
    assertPlainTablesWritable();
    const row = confirmationRow(id);
    if (row.revoked_at) throw new NamesListError(409, 'revoked', 'That confirmation was revoked.');
    if (!row.needs_second || row.seconded_at) throw new NamesListError(409, 'not_awaiting', 'That confirmation doesn’t need a second admin.');
    if (row.confirmed_by === actor) throw new NamesListError(403, 'same_admin', 'A second admin, not the one who confirmed, confirms it again.');
    if (row.member_pubkey === actor) throw new NamesListError(403, 'self_confirm', 'Another admin confirms you.');
    const entry = entryRow(row.entry_id);
    if (!entry || !holds(actor, entry.key_generation)) throw new NamesListError(403, 'no_key', 'You can’t open that entry, so you can’t confirm anyone against it.');
    db.transaction(() => {
        db.prepare("UPDATE confirmations SET seconded_by = ?, seconded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(actor, row.id);
        log(actor, 'second', row.entry_id, row.member_pubkey);
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
    })();
    return { id: row.id, status: 'revoked' };
}

/**
 * A member leaving: their live confirmation is revoked (`removed` by the community or an admin, `account_deleted` by
 * themselves), and any wrap of the list key they held is dropped (a new key is then needed where it was the current
 * one). Called inside adminPruneUser's and purgeMemberSelf's transactions (state-engine.ts), on a main server.
 */
export function dropNamesListHoldOf(pubkey: string, reason: 'removed' | 'account_deleted'): void {
    db.prepare(`UPDATE confirmations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoke_reason = ?
                WHERE member_pubkey = ? AND revoked_at IS NULL`).run(reason, pubkey);
    if (db.prepare(DROP_HOLDER_SQL).run(pubkey).changes > 0) log(NODE_ACTOR, 'holder_dropped', null, pubkey);
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NamesKeyOut extends WrappedNamesKey {
    generation: number;
    wrappedBy: string;
    signature: string;
    drops: string[];
}

const dropsOf = (s: string | null) => (s ? s.split(' ').filter(Boolean) : []);

/**
 * What the list screen needs first: the key (this admin's own wraps only), every wrap's signed header (`records`, which
 * the phone walks to decide whom it trusts), the community's id the signatures are bound to, who holds the key, who was
 * dropped from it, who waits, the settings. Not logged: no entry.
 */
export function namesState(actor: string) {
    const communityId = namesCommunityId();
    const generation = currentGeneration();
    const holders = holdersOf(generation);
    const admins = namesAdmins();
    const myKeys = (db.prepare(
        `SELECT generation, wrapped_key, wrap_iv, wrap_tag, ephemeral_pubkey, kdf_params, wrapped_by, drops, signature FROM names_list_keys
         WHERE holder_pubkey = ? AND dropped_at IS NULL ORDER BY generation DESC`,
    ).all(actor) as { generation: number; wrapped_key: string; wrap_iv: string; wrap_tag: string; ephemeral_pubkey: string; kdf_params: string; wrapped_by: string; drops: string; signature: string }[])
        .map((r): NamesKeyOut => ({
            generation: r.generation, wrappedKey: r.wrapped_key, wrapIv: r.wrap_iv, wrapTag: r.wrap_tag,
            ephemeralPubkey: r.ephemeral_pubkey, kdfParams: r.kdf_params, wrappedBy: r.wrapped_by, signature: r.signature, drops: dropsOf(r.drops),
        }));
    const records = (db.prepare(
        'SELECT holder_pubkey, generation, wrapped_by, wrap_digest, drops, signature FROM names_list_keys ORDER BY generation ASC, created_at ASC, holder_pubkey ASC',
    ).all() as { holder_pubkey: string; generation: number; wrapped_by: string; wrap_digest: string; drops: string; signature: string }[])
        .map((r): NamesKeyRecord => ({
            communityId, generation: r.generation, holder: r.holder_pubkey, wrappedBy: r.wrapped_by, wrapDigest: r.wrap_digest,
            drops: dropsOf(r.drops), signature: r.signature,
        }));
    const counts = db.prepare(
        `SELECT (SELECT COUNT(*) FROM names_entries) AS entries,
                (SELECT COUNT(*) FROM names_entries WHERE key_generation < ?) AS olderKey,
                (SELECT COUNT(*) FROM names_entries e WHERE NOT EXISTS (
                    SELECT 1 FROM names_list_keys k WHERE k.generation = e.key_generation AND k.dropped_at IS NULL)) AS locked,
                (SELECT COUNT(*) FROM confirmations WHERE revoked_at IS NULL AND (needs_second = 0 OR seconded_at IS NOT NULL)) AS confirmed,
                (SELECT COUNT(*) FROM confirmations WHERE revoked_at IS NULL AND needs_second = 1 AND seconded_at IS NULL) AS awaitingSecond`,
    ).get(generation) as { entries: number; olderKey: number; locked: number; confirmed: number; awaitingSecond: number };
    return {
        communityId,
        generation,
        newKeyNeeded: newKeyNeeded(generation),
        droppedHolders: generation > 0 ? droppedHoldersOf(generation) : [],
        // Nobody who is an admin now holds the current key: any admin may start a new one.
        nobodyHoldsKey: generation > 0 && holders.size === 0,
        myKeys,
        records,
        admins: admins.map((a) => ({ ...a, holdsKey: holders.has(a.pubkey) })),
        settings: { twoAdminsToConfirm: twoAdminsToConfirm(), namesShownToMembers: false },
        counts,
        me: { pubkey: actor, role: admins.find((a) => a.pubkey === actor)?.role ?? null, owner: isNodeOwner(actor) },
        limits: NAMES_LIMITS,
    };
}

/** Every entry, sealed, and every confirmation: one read of the list, logged as a read or an export. */
export function readEntries(actor: string, purpose: 'read' | 'export') {
    const entries = (db.prepare('SELECT * FROM names_entries ORDER BY created_at ASC, id ASC').all() as EntryRow[]).map((r) => ({
        id: r.id, ciphertext: r.ciphertext, keyGeneration: r.key_generation, createdBy: r.created_by, createdAt: r.created_at,
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
    log(actor, purpose);
    return { generation: currentGeneration(), entries, confirmations };
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
