/**
 * The mailbox between communities, the receiving side (messages across communities X2: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.3, §3.5, §3.7, §7, §11 row X2; DESIGN-cross-community-chat-fable.md §2.4, §2.5;
 * DESIGN-forums-messaging-joint-fable.md §3.1). The sending side is engine/relay-outbox.ts; the routes, routes/relay.ts.
 *
 * Another community's server brings items for members here in a request it signed (engine/node-signature.ts, X1):
 * `POST /api/relay/mail { items: RelayItem[] }`. Four kinds are this slice's:
 *
 *   dm-line    a sealed direct line           held for its recipient until their devices confirm it, then deleted
 *   dm-blob    a sealed photo or voice part   held the same way, its bytes a file of its own (<data>/relay-mail/in/)
 *   dm-delete  a sealed "delete for everyone" held the same way: each of the recipient's devices applies it
 *   receipt    "my device has these"          never held: the outbox row of each item it names goes `delivered`
 *
 * Every other kind (group items, a call signal, a complaint) is answered 202 and dropped until the slice that owns it.
 *
 * **202 and drop.** Whether an item is held or dropped is never in the answer: an item for a key that is no member here,
 * for a member who blocked its sender, past a member's caps, past a stranger's (a sender the member has never written to:
 * 5 a day to them, 50 a day across this server), of another kind, a replay, or with the owner's switch off
 * (`outsideMessages`), each is answered `{ itemId, received: true }` exactly as one held is, so no server can learn who is
 * a member here, nor whom they write to. What the answer does say depends on nothing about the members: a request that is
 * not one (400), an item too large for its kind (413, the whole request, nothing stored), an envelope that fails its
 * checks (`refused`, with core's reason: its form, the home rule, not for here, a changed payload, a bad signature; or
 * `stale`), the caps on a sending server and on this server (429, counted over every item that passed its checks, held or
 * not), and a full mailbox or disk (503).
 *
 * **Held, then deleted, once every device has it** (X2b: scratch/fable-design/decisions/DECISION-outside-door.md). Each of
 * the recipient's devices names itself (`device`, a random id its app keeps, @beanpool/core outside-devices.ts), fetches what
 * it has not confirmed (`GET /api/mail?device=`, oldest first, 50 at a time; a blob's bytes by `GET /api/mail/blob/:itemId`)
 * and confirms what it has written or dropped (`POST /api/mail/confirm { ids, device }`). An item's row and file go once a
 * device has confirmed it and every device listed has (one device: at once). A fetch lists its device (relay_mail_devices,
 * MAIL_DEVICES_MAX a member); Sign Out forgets it (`POST /api/mail/device/forget`), and so do MAIL_DEVICE_LAPSE_MS unseen:
 * it comes back as new and gets what is still held. A member's caps count only the items no device has confirmed; those a
 * device has get the same allowance again, the oldest going past it, so a device left idle never stops new mail. The server
 * learns how many devices fetch a member's mail and when each last asked; nothing of doors, requests or accepts. Nothing is
 * held past MAIL_HELD_DAYS. A replay dies on its sender and id (relay_mail_seen, MAIL_SEEN_MS),
 * and an item older than MAIL_ITEM_MAX_AGE_MS by its sender's clock, or dated more than MAIL_ITEM_MAX_AHEAD_MS ahead, is
 * stale, so none outlives the ids kept against it.
 *
 * **Never copied.** The five tables are `local` (engine/replication-manifest.ts), and every snapshot and backup file is
 * made without them (forgetRelayMailInCopy, from services/address-retention.ts). The files are never in the image store.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    OUTSIDE_DEVICE_ID, checkRelayItem, word, type RelayEnvelope, type RelayItem, type RelayItemDrop, type RelayItemKind,
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

/**
 * Waiting for one member here (design §3.3), counting the items no device of theirs has confirmed: past either, a new item
 * for them is dropped (202), the held ones kept. The items a device has confirmed and another not yet have the same
 * allowance again, the oldest going past it (settleMailFor).
 */
export const MAIL_PER_MEMBER_ITEMS = 200;
export const MAIL_PER_MEMBER_BYTES = 20 * 1024 * 1024;
/** The devices a member's mail waits for (X2b); past it, the one unseen longest is forgotten. */
export const MAIL_DEVICES_MAX = 5;
/** A device unseen this long is forgotten: it no longer holds an item, and comes back as new. */
export const MAIL_DEVICE_LAPSE_MS = 7 * DAY_MS;
/** Waiting for everyone here together; past it, and past the free-disk floor photos keep (2 GB), 503 `mailbox_full`. */
export const MAIL_SERVER_BYTES = 500 * 1024 * 1024;
/** Items taken from one sending server (design 30 Oct §2.5), and from every server together: past either, 429. */
export const MAIL_PER_ORIGIN_HOUR = 300;
export const MAIL_PER_ORIGIN_DAY = 2_000;
export const MAIL_SERVER_DAY = 20_000;
/**
 * Items held from a sender a member here has never written to (design §3.7, "unchanged" from 30 Oct §2.5: "per unknown
 * sender key, not yet accepted by that recipient"): in any 24 hours, this many for that member, and this many across this
 * server. Past either, dropped and answered as held (whether a sender is known to a member is the member's). The server's
 * only sign of acceptance is the member's own reply: an outbox row from them to that key (hasWrittenTo).
 */
export const MAIL_STRANGER_PER_RECIPIENT_DAY = 5;
export const MAIL_STRANGER_SERVER_DAY = 50;
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

/** The items held for one recipient (the one argument) that no device of theirs has confirmed. */
const NO_DEVICE_HAS = `recipient = ? AND NOT EXISTS (SELECT 1 FROM relay_mail_got g
                       WHERE g.recipient = relay_mail.recipient AND g.item_id = relay_mail.item_id)`;

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
        const overServer = count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE seen_at > ?', now - DAY_MS) + newItems.length > MAIL_SERVER_DAY;
        if (overOrigin || overServer) {
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
    const spent = db.prepare('INSERT INTO relay_mail_seen (sender_key, item_id, sender_home, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING')
        .run(env.senderKey, env.itemId, origin, now).changes === 1;
    if (!spent) return false;
    if (env.kind === 'receipt') {
        applyReceipt(env, item.payload, now);
        return false;
    }
    const hold = HELD_KINDS.has(env.kind) ? mayHoldFor(env, item.payload.length, now) : null;
    if (!hold) return false;
    const blob = env.kind === 'dm-blob';
    const file = blob ? relayBlobFile('in', env.senderKey, env.itemId) : null;
    try {
        if (file) writeRelayBlob(file, item.payload);
        const stored = db.prepare(`INSERT INTO relay_mail (sender_key, item_id, kind, recipient, sender_home, envelope, payload, bytes, received_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING`)
            .run(env.senderKey, env.itemId, env.kind, env.recipient, env.senderHome, JSON.stringify(env), blob ? null : item.payload, item.payload.length, now).changes === 1;
        if (!stored && file) removeRelayBlob(file);
        // Held from a stranger to them: counted against the stranger's caps (MAIL_STRANGER_*), from the id's own row.
        if (stored && hold.stranger) {
            db.prepare('UPDATE relay_mail_seen SET stranger_to = ? WHERE sender_key = ? AND item_id = ?').run(env.recipient, env.senderKey, env.itemId);
        }
        return stored;
    } catch (e) {
        if (file) removeRelayBlob(file);
        logger.warn('SYS', `Mail from another community: an item could not be held (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        return false;
    }
}

/** Whether `member` here has written to `key` (any item but a receipt, in the outbox's 30 days): the sender is no stranger to them. */
function hasWrittenTo(member: string, key: string): boolean {
    return !!db.prepare("SELECT 1 FROM relay_outbox WHERE sender_key = ? AND recipient = ? AND kind != 'receipt' LIMIT 1").get(member, key);
}

/**
 * Whether an item may wait here for its recipient: a member here who reads as one, who has not blocked its sender, within
 * their caps and, when its sender is a stranger to them, within the stranger's (`stranger` then says so); else null.
 */
function mayHoldFor(env: RelayEnvelope, bytes: number, now: number): { stranger: boolean } | null {
    const to = env.recipient;
    if (!/^[0-9a-f]{64}$/.test(to) || to === env.senderKey) return null;
    if (!isNodeMember(to) || !readsAsMember(to)) return null;
    if (hasBlocked(to, env.senderKey)) return null;
    // One recipient, one item id: their device confirms and fetches by it.
    if (db.prepare('SELECT 1 FROM relay_mail WHERE recipient = ? AND item_id = ?').get(to, env.itemId)) return null;
    const stranger = !hasWrittenTo(to, env.senderKey);
    if (stranger) {
        const since = now - DAY_MS;
        if (count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE sender_key = ? AND stranger_to = ? AND seen_at > ?', env.senderKey, to, since) >= MAIL_STRANGER_PER_RECIPIENT_DAY) return null;
        if (count('SELECT COUNT(*) AS n FROM relay_mail_seen WHERE sender_key = ? AND stranger_to IS NOT NULL AND seen_at > ?', env.senderKey, since) >= MAIL_STRANGER_SERVER_DAY) return null;
    }
    // Only the items no device of theirs has confirmed count: one a device has never stops new mail (settleMailFor).
    if (count(`SELECT COUNT(*) AS n FROM relay_mail WHERE ${NO_DEVICE_HAS}`, to) >= MAIL_PER_MEMBER_ITEMS) return null;
    return heldBytes(NO_DEVICE_HAS, to) + bytes <= MAIL_PER_MEMBER_BYTES ? { stranger } : null;
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

// ── The recipient's devices: fetch, a blob, confirm, forget ───────────────────────────────────

export interface HeldItem {
    kind: string;
    envelope: RelayEnvelope;
    /** The sealed payload as it came; null for a blob, whose bytes are fetched on their own. */
    payload: string | null;
    bytes: number;
    receivedAt: number;
}

type HeldRow = { sender_key: string; item_id: string; kind: string; recipient: string };

/** Whether `device` is a device's id as the apps make them (@beanpool/core OUTSIDE_DEVICE_ID). */
export function isMailDevice(device: unknown): device is string {
    return typeof device === 'string' && OUTSIDE_DEVICE_ID.test(device);
}

/** Held rows gone: each row, what its devices confirmed of it, and a blob's file. */
function dropHeld(rows: HeldRow[]): number {
    if (!rows.length) return 0;
    const del = db.prepare('DELETE FROM relay_mail WHERE sender_key = ? AND item_id = ?');
    const delGot = db.prepare('DELETE FROM relay_mail_got WHERE recipient = ? AND item_id = ?');
    db.transaction(() => {
        for (const r of rows) {
            del.run(r.sender_key, r.item_id);
            delGot.run(r.recipient, r.item_id);
        }
    })();
    for (const r of rows) if (r.kind === 'dm-blob') removeRelayBlob(relayBlobFile('in', r.sender_key, r.item_id));
    return rows.length;
}

/**
 * The items held for `member` that are done: each one a device has confirmed and that every device still listed (seen in
 * the last MAIL_DEVICE_LAPSE_MS) has confirmed goes, with its file. Then the items some device has and another not yet keep
 * the member's allowance again (MAIL_PER_MEMBER_ITEMS, MAIL_PER_MEMBER_BYTES), newest first: the oldest past it go.
 */
export function settleMailFor(member: string, now = Date.now()): number {
    const done = db.prepare(`SELECT m.sender_key, m.item_id, m.kind, m.recipient FROM relay_mail m
                             WHERE m.recipient = ?
                               AND EXISTS (SELECT 1 FROM relay_mail_got g WHERE g.recipient = m.recipient AND g.item_id = m.item_id)
                               AND NOT EXISTS (SELECT 1 FROM relay_mail_devices d WHERE d.member = m.recipient AND d.seen_at >= ?
                                   AND NOT EXISTS (SELECT 1 FROM relay_mail_got g WHERE g.recipient = m.recipient
                                                   AND g.item_id = m.item_id AND g.device = d.device))`)
        .all(member, now - MAIL_DEVICE_LAPSE_MS) as HeldRow[];
    let gone = dropHeld(done);
    const had = db.prepare(`SELECT m.sender_key, m.item_id, m.kind, m.recipient, m.bytes FROM relay_mail m
                            WHERE m.recipient = ? AND EXISTS (SELECT 1 FROM relay_mail_got g WHERE g.recipient = m.recipient AND g.item_id = m.item_id)
                            ORDER BY m.received_at DESC, m.item_id DESC`).all(member) as Array<HeldRow & { bytes: number }>;
    let kept = 0, bytes = 0;
    const past: HeldRow[] = [];
    for (const r of had) {
        if (past.length || kept >= MAIL_PER_MEMBER_ITEMS || bytes + r.bytes > MAIL_PER_MEMBER_BYTES) { past.push(r); continue; }
        kept++;
        bytes += r.bytes;
    }
    gone += dropHeld(past);
    return gone;
}

/**
 * `device` asked for `member`'s mail now: listed, or seen again. A new one past MAIL_DEVICES_MAX makes room: the device
 * unseen longest is forgotten (forgetMailDevice), as at its own Sign Out.
 */
export function noteMailDevice(member: string, device: string, now = Date.now()): void {
    db.prepare(`INSERT INTO relay_mail_devices (member, device, seen_at) VALUES (?, ?, ?)
                ON CONFLICT (member, device) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)`).run(member, device, now);
    const past = db.prepare(`SELECT device FROM relay_mail_devices WHERE member = ? AND device != ?
                             ORDER BY seen_at DESC, device DESC LIMIT -1 OFFSET ?`).all(member, device, MAIL_DEVICES_MAX - 1) as Array<{ device: string }>;
    for (const p of past) forgetMailDevice(member, p.device, now);
}

/**
 * `device` is no longer one of `member`'s (its Sign Out, MAIL_DEVICE_LAPSE_MS unseen, room for a new one, or the member
 * gone): no longer listed, what it confirmed forgotten, and what every device left has confirmed goes (settleMailFor).
 * True when it was listed.
 */
export function forgetMailDevice(member: string, device: string, now = Date.now()): boolean {
    const listed = db.transaction(() => {
        db.prepare('DELETE FROM relay_mail_got WHERE recipient = ? AND device = ?').run(member, device);
        return db.prepare('DELETE FROM relay_mail_devices WHERE member = ? AND device = ?').run(member, device).changes === 1;
    })();
    settleMailFor(member, now);
    return listed;
}

/** What waits for `member` that `device` has not confirmed, oldest first, MAIL_FETCH_PAGE at a time, and whether there is more. */
export function heldMailFor(member: string, device: string): { items: HeldItem[]; more: boolean } {
    const rows = db.prepare(`SELECT kind, envelope, payload, bytes, received_at FROM relay_mail m WHERE recipient = ?
                               AND NOT EXISTS (SELECT 1 FROM relay_mail_got g WHERE g.recipient = m.recipient AND g.item_id = m.item_id AND g.device = ?)
                             ORDER BY received_at, item_id LIMIT ?`).all(member, device, MAIL_FETCH_PAGE + 1) as Array<{
        kind: string; envelope: string; payload: string | null; bytes: number; received_at: number;
    }>;
    return {
        items: rows.slice(0, MAIL_FETCH_PAGE).map((r) => ({
            kind: r.kind, envelope: JSON.parse(r.envelope) as RelayEnvelope, payload: r.payload, bytes: r.bytes, receivedAt: r.received_at,
        })),
        more: rows.length > MAIL_FETCH_PAGE,
    };
}

/** A blob held for `member`, by its id, or null when none is (theirs, and not yet gone). */
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

/**
 * `device` of `member`'s has these (written, or dropped: either way it is done with them). Each is marked as that device's,
 * the device seen again, and every item now done goes with its file (settleMailFor). The ids stay seen, so a replay is
 * dropped. Answers how many of them this device had not confirmed before.
 */
export function confirmMail(member: string, device: string, itemIds: string[], now = Date.now()): number {
    const ids = [...new Set(itemIds.filter((id) => typeof id === 'string' && ITEM_ID.test(id)))];
    if (!ids.length) return 0;
    const marks = `(${ids.map(() => '?').join(', ')})`;
    const confirmed = db.transaction(() => {
        const held = db.prepare(`SELECT item_id FROM relay_mail WHERE recipient = ? AND item_id IN ${marks}`).all(member, ...ids) as Array<{ item_id: string }>;
        const mark = db.prepare('INSERT INTO relay_mail_got (recipient, item_id, device) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
        let n = 0;
        for (const h of held) n += mark.run(member, h.item_id, device).changes;
        db.prepare('UPDATE relay_mail_devices SET seen_at = MAX(seen_at, ?) WHERE member = ? AND device = ?').run(now, member, device);
        return n;
    })();
    settleMailFor(member, now);
    return confirmed;
}

// ── Hygiene ─────────────────────────────────────────────────────────────────────────────────

/**
 * The mailbox's sweep (the minute timer, https-server.ts): mail held past MAIL_HELD_DAYS, or for a key that is no longer a
 * member here, goes with its file; a device unseen for MAIL_DEVICE_LAPSE_MS, or a key's that is no longer a member here, is
 * forgotten (and what every device left has goes); ids seen past MAIL_SEEN_MS go.
 */
export function sweepRelayMail(now = Date.now()): { expired: number; gone: number; seen: number; devices: number } {
    const expired = dropHeld(db.prepare('SELECT sender_key, item_id, kind, recipient FROM relay_mail WHERE received_at < ? LIMIT 1000')
        .all(now - MAIL_HELD_DAYS * DAY_MS) as HeldRow[]);
    let gone = 0;
    const recipients = db.prepare('SELECT DISTINCT recipient FROM relay_mail').all() as Array<{ recipient: string }>;
    for (const { recipient } of recipients) {
        if (isNodeMember(recipient)) continue;
        gone += dropHeld(db.prepare('SELECT sender_key, item_id, kind, recipient FROM relay_mail WHERE recipient = ?').all(recipient) as HeldRow[]);
    }
    let devices = 0;
    const members = new Map<string, boolean>();
    for (const d of db.prepare('SELECT member, device, seen_at FROM relay_mail_devices').all() as Array<{ member: string; device: string; seen_at: number }>) {
        if (!members.has(d.member)) members.set(d.member, isNodeMember(d.member));
        if (d.seen_at >= now - MAIL_DEVICE_LAPSE_MS && members.get(d.member)) continue;
        forgetMailDevice(d.member, d.device, now);
        devices++;
    }
    // What a device confirmed of an item that went some other way.
    db.prepare(`DELETE FROM relay_mail_got WHERE NOT EXISTS (SELECT 1 FROM relay_mail m WHERE m.recipient = relay_mail_got.recipient
                AND m.item_id = relay_mail_got.item_id)`).run();
    const seen = db.prepare('DELETE FROM relay_mail_seen WHERE seen_at < ?').run(now - MAIL_SEEN_MS).changes;
    return { expired, gone, seen, devices };
}
