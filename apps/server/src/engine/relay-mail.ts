/**
 * The mailbox between communities, the receiving side (messages across communities X2: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.3, §3.5, §3.7, §7, §11 row X2; DESIGN-cross-community-chat-fable.md §2.4, §2.5;
 * DESIGN-forums-messaging-joint-fable.md §3.1). The sending side is engine/relay-outbox.ts; the routes, routes/relay.ts.
 *
 * Another community's server brings items for members here in a request it signed (engine/node-signature.ts, X1):
 * `POST /api/relay/mail { items: RelayItem[] }`. Four kinds are this slice's:
 *
 *   dm-line    a sealed direct line           held for its recipient until their device confirms it, then deleted
 *   dm-blob    a sealed photo or voice part   held the same way, its bytes a file of its own (<data>/relay-mail/in/)
 *   dm-delete  a sealed "delete for everyone" held the same way: the recipient's device applies it
 *   receipt    "my device has these"          never held: the outbox row of each item it names goes `delivered`
 *
 * Every other kind (group items, a call signal, a complaint) is answered 202 and dropped until the slice that owns it.
 *
 * **202 and drop.** Whether an item is held or dropped is never in the answer: an item for a key that is no member here,
 * for a member who blocked its sender, past a member's caps, of another kind, a replay, or with the owner's switch off
 * (`outsideMessages`), each is answered `{ itemId, received: true }` exactly as one held is, so no server can learn who is
 * a member here. What the answer does say depends on nothing about the members: a request that is not one (400), an item
 * too large for its kind (413, the whole request, nothing stored), an envelope that fails its checks (`refused`, with
 * core's reason: its form, the home rule, not for here, a changed payload, a bad signature; or `stale`), the caps on a
 * sending server, a sender key and this server (429, counted over every item that passed its checks, held or not), and a
 * full mailbox or disk (503).
 *
 * **Held, then deleted.** The recipient's device fetches what waits (`GET /api/mail`, oldest first, 50 at a time; a blob's
 * bytes by `GET /api/mail/blob/:itemId`) and confirms what it has written (`POST /api/mail/confirm`), which deletes the rows
 * and their files. Nothing is held past MAIL_HELD_DAYS. A replay dies on its sender and id (relay_mail_seen, MAIL_SEEN_MS),
 * and an item older than MAIL_ITEM_MAX_AGE_MS by its sender's clock, or dated more than MAIL_ITEM_MAX_AHEAD_MS ahead, is
 * stale, so none outlives the ids kept against it.
 *
 * **Never copied.** The three tables are `local` (engine/replication-manifest.ts), and every snapshot and backup file is
 * made without them (forgetRelayMailInCopy, from services/address-retention.ts). The files are never in the image store.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    checkRelayItem, word, type RelayEnvelope, type RelayItem, type RelayItemDrop, type RelayItemKind,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { WRITER_LIMITS } from '../config/writer-limits.js';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { hasBlocked } from './member-blocks.js';
import { isOwnNodeHome } from './node-key.js';
import { assertFolderFloorSpace, StorageNearlyFullError } from './photo-upload-budget.js';
import { logger } from '../logger.js';

// ── What crosses, and how big ───────────────────────────────────────────────────────────────

/** The path another community's server brings items to (engine/node-signature.ts NODE_SIGNED_PATHS). */
export const RELAY_MAIL_PATH = '/api/relay/mail';
/** The kinds this slice handles; every other kind is answered 202 and dropped. */
export const RELAY_HANDLED_KINDS: readonly RelayItemKind[] = ['dm-line', 'dm-blob', 'dm-delete', 'receipt'];
/** The kinds held for a member until their device has them. */
const HELD_KINDS: ReadonlySet<string> = new Set(['dm-line', 'dm-blob', 'dm-delete']);
/** The most items one request carries, either way, and the most blobs among them (one: the request cap is 2 MB). */
export const RELAY_ITEMS_PER_REQUEST = 16;
export const RELAY_BLOBS_PER_REQUEST = 1;
/** A line or a delete, in characters as it travels: a direct line's own limit (config/writer-limits.ts dmLineChars). */
export const RELAY_LINE_MAX_CHARS = WRITER_LIMITS.dmLineChars;
/**
 * A blob, in characters as it travels: room over the largest sealed part a chat line carries today, a voice message's
 * 1,150,000 characters (@beanpool/core VOICE_SEALED_MAX_BYTES; a photo's is 786,432, config/writer-limits.ts
 * GROUP_PHOTO_MAX_BYTES), with the blob's own few fields around it; a request with one is still under the 2 MB body cap.
 */
export const RELAY_BLOB_MAX_CHARS = 1_200_000;
/** A receipt names at most one fetch's worth of items, as `{"v":1,"items":[ids]}`. */
export const RELAY_RECEIPT_IDS_MAX = 50;
export const RELAY_RECEIPT_MAX_CHARS = 4 * 1024;

/** The most a payload of `kind` may be, in characters; a kind this slice doesn't handle has only core's limit. */
export function relayPayloadMaxChars(kind: string): number | null {
    if (kind === 'dm-blob') return RELAY_BLOB_MAX_CHARS;
    if (kind === 'dm-line' || kind === 'dm-delete') return RELAY_LINE_MAX_CHARS;
    if (kind === 'receipt') return RELAY_RECEIPT_MAX_CHARS;
    return null;
}

// ── How long, how many ──────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;
export const MAIL_HELD_DAYS = 30;
/** An item older than this by its sender's clock is stale, and one dated further ahead than MAIL_ITEM_MAX_AHEAD_MS too. */
export const MAIL_ITEM_MAX_AGE_MS = 7 * DAY_MS;
export const MAIL_ITEM_MAX_AHEAD_MS = DAY_MS;
/** Ids seen are kept past any item that could still be fresh: a replay is either seen or stale. */
export const MAIL_SEEN_MS = MAIL_ITEM_MAX_AGE_MS + MAIL_ITEM_MAX_AHEAD_MS;

/** Waiting for one member here (design §3.3): past either, a new item for them is dropped (202), the held ones kept. */
export const MAIL_PER_MEMBER_ITEMS = 200;
export const MAIL_PER_MEMBER_BYTES = 20 * 1024 * 1024;
/** Waiting for everyone here together; past it, and past the free-disk floor photos keep (2 GB), 503 `mailbox_full`. */
export const MAIL_SERVER_BYTES = 500 * 1024 * 1024;
/** Items taken from one sending server (design 30 Oct §2.5), from one sender key, and from every server together. */
export const MAIL_PER_ORIGIN_HOUR = 300;
export const MAIL_PER_ORIGIN_DAY = 2_000;
export const MAIL_PER_SENDER_DAY = 200;
export const MAIL_SERVER_DAY = 20_000;
/** What one fetch gives. */
export const MAIL_FETCH_PAGE = 50;
export const MAIL_RETRY_AFTER_SEC = 3_600;

export const MAILBOX_FULL_ERROR = word("That community can't take more messages right now.");
export const MAIL_RATE_ERROR = word("That community isn't taking more messages from here right now.");

// ── The owner's switch ──────────────────────────────────────────────────────────────────────

/** Whether this community takes messages from other communities, and lets its members send to them. */
export function outsideMessagesOn(): boolean {
    return getProfileSwitches().outsideMessages;
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────

const dataDir = () => process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
/** Where held and queued blobs are kept: never the image store, so never among a backup's objects. */
export function relayMailDir(): string {
    return path.join(dataDir(), 'relay-mail');
}
/** A blob's file. Item ids are letters, digits, - and _ only (core relay-envelope.ts), so one is always a plain name. */
export function relayBlobFile(side: 'in' | 'out', senderKey: string, itemId: string): string {
    return path.join(relayMailDir(), side, `${senderKey}-${itemId}`);
}
export function writeRelayBlob(file: string, payload: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, payload, { mode: 0o600 });
}
export function removeRelayBlob(file: string): void {
    try { fs.rmSync(file, { force: true }); } catch { /* the sweep tries again */ }
}

// ── Receiving ───────────────────────────────────────────────────────────────────────────────

export type ReceivedItem = { itemId: string | null; received: true } | { itemId: string | null; refused: RelayItemDrop | 'stale' };

export type ReceiveAnswer =
    | { status: 202; body: { items: ReceivedItem[] } }
    | { status: 400 | 413 | 429 | 503; body: { error: string; code: string }; retryAfterSec?: number };

const idOf = (item: unknown): string | null => {
    const id = (item as { envelope?: { itemId?: unknown } } | null)?.envelope?.itemId;
    return typeof id === 'string' && id.length <= 64 ? id : null;
};
const kindOf = (item: unknown): unknown => (item as { envelope?: { kind?: unknown } } | null)?.envelope?.kind;
const payloadLength = (item: unknown): number => {
    const p = (item as { payload?: unknown } | null)?.payload;
    return typeof p === 'string' ? p.length : 0;
};

const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

function heldBytes(where = '1 = 1', ...args: unknown[]): number {
    return (db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM relay_mail WHERE ${where}`).get(...args) as { n: number }).n;
}

/**
 * What this server makes of the items a sending server (`origin`, the home its request was verified as) brought, in the
 * order of the file's header. Stores what it holds; answers alike for held and dropped.
 */
export function receiveRelayItems(origin: string, items: unknown, now = Date.now()): ReceiveAnswer {
    if (!Array.isArray(items) || items.length > RELAY_ITEMS_PER_REQUEST) {
        return { status: 400, body: { error: `items is a list of at most ${RELAY_ITEMS_PER_REQUEST} relay items.`, code: 'bad_items' } };
    }
    if (items.filter((i) => kindOf(i) === 'dm-blob').length > RELAY_BLOBS_PER_REQUEST) {
        return { status: 400, body: { error: `A request carries at most ${RELAY_BLOBS_PER_REQUEST} blob.`, code: 'bad_items' } };
    }
    // Sizes first, before any signature: a payload over its kind's limit refuses the whole request, and nothing is stored.
    for (const item of items) {
        const max = typeof kindOf(item) === 'string' ? relayPayloadMaxChars(kindOf(item) as string) : null;
        if (max !== null && payloadLength(item) > max) {
            return { status: 413, body: { error: `A ${String(kindOf(item))} item carries at most ${max} characters.`, code: 'too_large' } };
        }
    }
    // The owner's switch off: every item answered as received, none looked at further.
    if (!outsideMessagesOn()) return { status: 202, body: { items: items.map((i) => ({ itemId: idOf(i), received: true as const })) } };

    const answers: ReceivedItem[] = [];
    const fresh: RelayItem[] = [];
    for (const raw of items) {
        const verdict = checkRelayItem(raw, { signedBy: origin, isHere: isOwnNodeHome });
        if (!verdict.ok) { answers.push({ itemId: idOf(raw), refused: verdict.reason }); continue; }
        const env = verdict.item.envelope;
        if (env.at < now - MAIL_ITEM_MAX_AGE_MS || env.at > now + MAIL_ITEM_MAX_AHEAD_MS) {
            answers.push({ itemId: env.itemId, refused: 'stale' });
            continue;
        }
        answers.push({ itemId: env.itemId, received: true });
        if (!fresh.some((f) => f.envelope.senderKey === env.senderKey && f.envelope.itemId === env.itemId)) fresh.push(verdict.item);
    }
    const isNew = (i: RelayItem) => !db.prepare('SELECT 1 FROM relay_mail_seen WHERE sender_key = ? AND item_id = ?').get(i.envelope.senderKey, i.envelope.itemId);
    const newItems = fresh.filter(isNew);

    // The caps on who brings how much, over every new item that passed its checks, whoever it is for.
    if (newItems.length) {
        const overOrigin = count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE sender_home = ? AND seen_at > ?', origin, now - 60 * 60_000) + newItems.length > MAIL_PER_ORIGIN_HOUR
            || count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE sender_home = ? AND seen_at > ?', origin, now - DAY_MS) + newItems.length > MAIL_PER_ORIGIN_DAY;
        const senders = new Map<string, number>();
        for (const i of newItems) senders.set(i.envelope.senderKey, (senders.get(i.envelope.senderKey) ?? 0) + 1);
        const overSender = [...senders].some(([key, n]) =>
            count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE sender_key = ? AND seen_at > ?', key, now - DAY_MS) + n > MAIL_PER_SENDER_DAY);
        const overServer = count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE seen_at > ?', now - DAY_MS) + newItems.length > MAIL_SERVER_DAY;
        if (overOrigin || overSender || overServer) {
            return { status: 429, body: { error: MAIL_RATE_ERROR, code: 'rate_limited' }, retryAfterSec: MAIL_RETRY_AFTER_SEC };
        }
        const incoming = newItems.reduce((sum, i) => sum + (HELD_KINDS.has(i.envelope.kind) ? i.payload.length : 0), 0);
        let floorOk = true;
        try {
            if (incoming > 0) assertFolderFloorSpace(dataDir());
        } catch (e) {
            if (!(e instanceof StorageNearlyFullError)) throw e;
            floorOk = false;
        }
        if (!floorOk || heldBytes() + incoming > MAIL_SERVER_BYTES) {
            return { status: 503, body: { error: MAILBOX_FULL_ERROR, code: 'mailbox_full' }, retryAfterSec: MAIL_RETRY_AFTER_SEC };
        }
    }

    // Each new item, then nothing more said: how many were held is no one's to read in the answer, nor in the log.
    for (const item of newItems) takeItem(origin, item, now);
    return { status: 202, body: { items: answers } };
}

/** One new item: its id spent, then held, applied (a receipt) or dropped. True when it was held. */
function takeItem(origin: string, item: RelayItem, now: number): boolean {
    const env = item.envelope;
    const spent = db.prepare('INSERT OR IGNORE INTO relay_mail_seen (sender_key, item_id, sender_home, seen_at) VALUES (?, ?, ?, ?)')
        .run(env.senderKey, env.itemId, origin, now).changes === 1;
    if (!spent) return false;
    if (env.kind === 'receipt') {
        applyReceipt(env, item.payload, now);
        return false;
    }
    if (!HELD_KINDS.has(env.kind) || !mayHoldFor(env, item.payload.length)) return false;
    const blob = env.kind === 'dm-blob';
    const file = blob ? relayBlobFile('in', env.senderKey, env.itemId) : null;
    try {
        if (file) writeRelayBlob(file, item.payload);
        const stored = db.prepare(`INSERT OR IGNORE INTO relay_mail (sender_key, item_id, kind, recipient, sender_home, envelope, payload, bytes, received_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(env.senderKey, env.itemId, env.kind, env.recipient, env.senderHome, JSON.stringify(env), blob ? null : item.payload, item.payload.length, now).changes === 1;
        if (!stored && file) removeRelayBlob(file);
        return stored;
    } catch (e) {
        if (file) removeRelayBlob(file);
        logger.warn('SYS', `Mail from another community: an item could not be held (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        return false;
    }
}

/** Whether an item may wait here for its recipient: a member here who reads as one, who has not blocked its sender, within their caps. */
function mayHoldFor(env: RelayEnvelope, bytes: number): boolean {
    const to = env.recipient;
    if (!/^[0-9a-f]{64}$/.test(to) || to === env.senderKey) return false;
    if (!isNodeMember(to) || !readsAsMember(to)) return false;
    if (hasBlocked(to, env.senderKey)) return false;
    // One recipient, one item id: their device confirms and fetches by it.
    if (db.prepare('SELECT 1 FROM relay_mail WHERE recipient = ? AND item_id = ?').get(to, env.itemId)) return false;
    if (count('SELECT COUNT(*) AS n FROM relay_mail WHERE recipient = ?', to) >= MAIL_PER_MEMBER_ITEMS) return false;
    return heldBytes('recipient = ?', to) + bytes <= MAIL_PER_MEMBER_BYTES;
}

// ── Receipts ────────────────────────────────────────────────────────────────────────────────

const ITEM_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;

/** A receipt's payload, `{"v":1,"items":[ids]}`, as its ids, or null. In the clear: its sender's server sent those ids itself. */
export function readReceiptPayload(payload: string): string[] | null {
    let o: unknown;
    try { o = JSON.parse(payload); } catch { return null; }
    const ids = (o as { v?: unknown; items?: unknown } | null)?.items;
    if ((o as { v?: unknown } | null)?.v !== 1 || !Array.isArray(ids) || ids.length === 0 || ids.length > RELAY_RECEIPT_IDS_MAX) return null;
    if (!ids.every((id) => typeof id === 'string' && ITEM_ID.test(id))) return null;
    return [...new Set(ids as string[])];
}

/**
 * A receipt from a recipient's device (it signed the envelope; its home brought it): each item it names that a member here
 * sent THAT recipient, at THAT home, goes `delivered`, and a sealed copy still queued goes. Nobody else's outbox row moves.
 */
function applyReceipt(env: RelayEnvelope, payload: string, now: number): void {
    const ids = readReceiptPayload(payload);
    if (!ids || !/^[0-9a-f]{64}$/.test(env.recipient)) return;
    const marks = `(${ids.map(() => '?').join(', ')})`;
    const rows = db.prepare(`SELECT item_id, kind, state FROM relay_outbox
                             WHERE sender_key = ? AND recipient = ? AND recipient_home = ? AND kind != 'receipt'
                               AND state IN ('queued', 'sent', 'expired') AND item_id IN ${marks}`)
        .all(env.recipient, env.senderKey, env.senderHome, ...ids) as Array<{ item_id: string; kind: string; state: string }>;
    const mark = db.prepare(`UPDATE relay_outbox SET state = 'delivered', item = NULL, next_try_at = NULL, updated_at = ?
                             WHERE sender_key = ? AND item_id = ?`);
    for (const r of rows) {
        mark.run(now, env.recipient, r.item_id);
        if (r.kind === 'dm-blob' && r.state === 'queued') removeRelayBlob(relayBlobFile('out', env.recipient, r.item_id));
    }
}

// ── The recipient's device: fetch, a blob, confirm ──────────────────────────────────────────

export interface HeldItem {
    kind: string;
    envelope: RelayEnvelope;
    /** The sealed payload as it came; null for a blob, whose bytes are fetched on their own. */
    payload: string | null;
    bytes: number;
    receivedAt: number;
}

/** What waits for `member`, oldest first, MAIL_FETCH_PAGE at a time, and whether there is more. */
export function heldMailFor(member: string): { items: HeldItem[]; more: boolean } {
    const rows = db.prepare(`SELECT kind, envelope, payload, bytes, received_at FROM relay_mail WHERE recipient = ?
                             ORDER BY received_at, item_id LIMIT ?`).all(member, MAIL_FETCH_PAGE + 1) as Array<{
        kind: string; envelope: string; payload: string | null; bytes: number; received_at: number;
    }>;
    return {
        items: rows.slice(0, MAIL_FETCH_PAGE).map((r) => ({
            kind: r.kind, envelope: JSON.parse(r.envelope) as RelayEnvelope, payload: r.payload, bytes: r.bytes, receivedAt: r.received_at,
        })),
        more: rows.length > MAIL_FETCH_PAGE,
    };
}

/** A blob held for `member`, by its id, or null when none is (theirs, not yet confirmed). */
export function heldBlobFor(member: string, itemId: string): string | null {
    if (!ITEM_ID.test(itemId)) return null;
    const row = db.prepare("SELECT sender_key FROM relay_mail WHERE recipient = ? AND item_id = ? AND kind = 'dm-blob'").get(member, itemId) as { sender_key: string } | undefined;
    if (!row) return null;
    try {
        return fs.readFileSync(relayBlobFile('in', row.sender_key, itemId), 'utf8');
    } catch {
        return null;
    }
}

/** The member's device has these: the rows and their files go. The ids stay seen, so a replay is dropped. */
export function confirmMail(member: string, itemIds: string[]): number {
    const ids = [...new Set(itemIds.filter((id) => typeof id === 'string' && ITEM_ID.test(id)))];
    if (!ids.length) return 0;
    const marks = `(${ids.map(() => '?').join(', ')})`;
    const gone = db.transaction(() => {
        const rows = db.prepare(`SELECT sender_key, item_id, kind FROM relay_mail WHERE recipient = ? AND item_id IN ${marks}`)
            .all(member, ...ids) as Array<{ sender_key: string; item_id: string; kind: string }>;
        db.prepare(`DELETE FROM relay_mail WHERE recipient = ? AND item_id IN ${marks}`).run(member, ...ids);
        return rows;
    })();
    for (const r of gone) if (r.kind === 'dm-blob') removeRelayBlob(relayBlobFile('in', r.sender_key, r.item_id));
    return gone.length;
}

// ── Hygiene ─────────────────────────────────────────────────────────────────────────────────

/**
 * The mailbox's sweep (the minute timer, https-server.ts): mail held past MAIL_HELD_DAYS, or for a key that is no longer a
 * member here, goes with its file; ids seen past MAIL_SEEN_MS go.
 */
export function sweepRelayMail(now = Date.now()): { expired: number; gone: number; seen: number } {
    const drop = (rows: Array<{ sender_key: string; item_id: string; kind: string }>) => {
        const del = db.prepare('DELETE FROM relay_mail WHERE sender_key = ? AND item_id = ?');
        for (const r of rows) {
            del.run(r.sender_key, r.item_id);
            if (r.kind === 'dm-blob') removeRelayBlob(relayBlobFile('in', r.sender_key, r.item_id));
        }
        return rows.length;
    };
    const expired = drop(db.prepare('SELECT sender_key, item_id, kind FROM relay_mail WHERE received_at < ? LIMIT 1000')
        .all(now - MAIL_HELD_DAYS * DAY_MS) as Array<{ sender_key: string; item_id: string; kind: string }>);
    let gone = 0;
    const recipients = db.prepare('SELECT DISTINCT recipient FROM relay_mail').all() as Array<{ recipient: string }>;
    for (const { recipient } of recipients) {
        if (isNodeMember(recipient)) continue;
        gone += drop(db.prepare('SELECT sender_key, item_id, kind FROM relay_mail WHERE recipient = ?').all(recipient) as Array<{ sender_key: string; item_id: string; kind: string }>);
    }
    const seen = db.prepare('DELETE FROM relay_mail_seen WHERE seen_at < ?').run(now - MAIL_SEEN_MS).changes;
    return { expired, gone, seen };
}
