/**
 * The mailbox between communities, the sending side (messages across communities X2: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.2, §3.3, §11 row X2; DESIGN-cross-community-chat-fable.md §2.4 "Send"). The receiving
 * side, the kinds and the caps are engine/relay-mail.ts.
 *
 * A member's device seals and signs an item (the relay envelope, @beanpool/core relay-envelope.ts) and posts it to its own
 * community's server: `POST /api/mail/send { items }`, member-signed. This server checks that the member wrote it (the
 * envelope is theirs, signed, its payload the one signed), that it names this server as their home and another community
 * as the recipient's, its kind and size; then writes an **outbox row** and forwards it at once to
 * `https://<recipient home>/api/relay/mail`, in a request it signs (engine/node-key.ts ownNodeRequestHeaders), one
 * request per home. The outbox row keeps no words: the sealed item only while it is `queued` (the other server has not
 * taken it), and goes at the first 2xx: `sent`, or `failed` for an item that 2xx's own answer refuses (wrong home, not for
 * here, stale ...), so its sender sees Not delivered. A forward that fails is tried again with backoff (RETRY_BACKOFF_MS) for
 * OUTBOX_QUEUE_MS, then `failed`. A receipt from the recipient's device (engine/relay-mail.ts applyReceipt) makes it
 * `delivered`; one `sent` and never confirmed within the 30 days the other server holds mail is `expired`. The member's
 * device reads each row's state in its fetch (`GET /api/mail`, paged by time and id: outboxStatesFor). A row goes
 * OUTBOX_KEPT_MS after its last change.
 *
 * Receipts go out the same way: the recipient's device signs one (kind `receipt`, its payload the ids it has) and sends it
 * through this route to the sender's home.
 *
 * The forward goes through the SSRF-safe fetcher (engine/pulse-resolver.ts: public addresses only, after every lookup; no
 * redirect, so the body goes nowhere else), within FORWARD_TIMEOUT_MS. Suites hand it a fetch of their own
 * (__useRelayTransportForTests, double-locked as the key fetch's hook is).
 */
import fs from 'node:fs';
import {
    readRelayEnvelope, relayEnvelopeVerifies, relayPayloadHash, word, type RelayEnvelope,
} from '@beanpool/core';
import { db } from '../db/db.js';
import { isOwnNodeHome, ownNodeHome, ownNodeRequestHeaders } from './node-key.js';
import { assertFolderFloorSpace } from './photo-upload-budget.js';
import { ssrfSafeFetch } from './pulse-resolver.js';
import {
    MAIL_HELD_DAYS, MAIL_ITEM_MAX_AGE_MS, MAIL_ITEM_MAX_AHEAD_MS, RELAY_BLOBS_PER_REQUEST, RELAY_HANDLED_KINDS, RELAY_ITEMS_PER_REQUEST,
    RELAY_MAIL_PATH, outsideMessagesOn, readReceiptPayload, relayBlobFile, relayMailDir, relayPayloadMaxChars, removeRelayBlob, writeRelayBlob,
} from './relay-mail.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60_000;
/** How long a forward is tried again before the row is `failed`. */
export const OUTBOX_QUEUE_MS = DAY_MS;
/** The waits between tries: a minute, five, fifteen, an hour, then every two hours until OUTBOX_QUEUE_MS. */
export const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 2 * 60 * 60_000] as const;
/** A row goes this long after its last change, and a `sent` one never confirmed is `expired` then. */
export const OUTBOX_KEPT_MS = MAIL_HELD_DAYS * DAY_MS;
/** Items one member here may send out in any 24 hours. */
export const OUTBOX_PER_MEMBER_DAY = 500;
export const FORWARD_TIMEOUT_MS = 10_000;
const ANSWER_MAX_BYTES = 64 * 1024;
/** Rows forwarded on one turn of the timer. */
const RETRY_BATCH = 64;

export type OutboxState = 'queued' | 'sent' | 'delivered' | 'failed' | 'expired';

export const OUTSIDE_OFF_ERROR = word("This community doesn't take messages from other communities.");
export const NO_HOME_ERROR = word("This community's server knows none of its own names yet, so it can't send to another community.");
export const OUTBOX_RATE_ERROR = word("You've sent a lot to other communities today. Try again tomorrow.");

export class OutboxError extends Error {
    constructor(readonly status: 400 | 403 | 413 | 429 | 503, readonly code: string, message: string) {
        super(message);
        this.name = 'OutboxError';
    }
}

// ── The forward ─────────────────────────────────────────────────────────────────────────────

/**
 * What a forward got back: the other server's status (0 when it could not be reached) and, on a 2xx, its answer when it
 * could be read: `{ items: [{ itemId, received: true } | { itemId, refused }] }`, one per item in the order sent
 * (engine/relay-mail.ts receiveRelayItems).
 */
type Transport = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; body?: unknown }>;

async function postOverTls(url: string, init: { headers: Record<string, string>; body: string }): Promise<{ status: number; body?: unknown }> {
    const res = await ssrfSafeFetch(url, {
        method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
        timeoutMs: FORWARD_TIMEOUT_MS, maxBytes: ANSWER_MAX_BYTES, maxRedirects: 0, allowedContentTypes: ['application/json'],
    });
    if (res.status < 200 || res.status >= 300) return { status: res.status };
    try {
        return { status: res.status, body: await res.json() };
    } catch {
        return { status: res.status };   // taken, its answer unread: the items count as sent
    }
}

/**
 * Whether the other server refused the item at `index` of a request inside its 2xx (wrong home, not for here, stale ...):
 * its answer at that place names the same item and says `refused`. The answers are read by place, not by id, because one
 * request may carry two members' items that share an id; answers that don't line up with the items count as none.
 */
function refusedInAnswer(body: unknown, index: number, itemId: string, sent: number): string | null {
    const answers = (body as { items?: unknown } | null | undefined)?.items;
    if (!Array.isArray(answers) || answers.length !== sent) return null;
    const a = answers[index] as { itemId?: unknown; refused?: unknown } | null;
    if (a?.itemId !== itemId || typeof a.refused !== 'string') return null;
    return /^[a-z-]{1,40}$/.test(a.refused) ? a.refused : 'refused';   // its words go to the log: core's reasons only
}

let transport: Transport = postOverTls;

/**
 * Tests: forward with `fetch` instead of over TLS (a suite's other server is in its own process); null puts the real one
 * back. Refuses to run unless BEANPOOL_SSRF_TEST_HOOK=1, which nothing in production sets.
 */
export function __useRelayTransportForTests(fetch: Transport | null): void {
    if (process.env.BEANPOOL_SSRF_TEST_HOOK !== '1') throw new Error('The relay transport hook is disabled (BEANPOOL_SSRF_TEST_HOOK is not 1)');
    transport = fetch ?? postOverTls;
}

/**
 * One request this server signs to another community's server (a complaint: engine/relay-complaint.ts), through the same
 * transport as the forwards (and the suites' hook): its status, 0 when it could not be reached.
 */
export async function forwardSigned(url: string, body: string): Promise<number> {
    try {
        const headers = await ownNodeRequestHeaders({ method: 'POST', url, body });
        return (await transport(url, { headers, body })).status;
    } catch (e) {
        logger.warn('SYS', `A request to another community's server could not be made (${e instanceof Error ? e.message.slice(0, 120) : String(e)}).`);
        return 0;
    }
}

interface OutboxRow {
    sender_key: string;
    item_id: string;
    kind: string;
    recipient_home: string;
    item: string | null;
    attempts: number;
    created_at: number;
}

/** The item as it travels, from its row (and a blob's file), or null when it can't be had any more. */
function travellingItem(r: OutboxRow): { envelope: RelayEnvelope; payload: string } | null {
    try {
        const stored = JSON.parse(r.item ?? 'null') as { envelope: RelayEnvelope; payload?: string } | null;
        if (!stored?.envelope) return null;
        const payload = r.kind === 'dm-blob' ? fs.readFileSync(relayBlobFile('out', r.sender_key, r.item_id), 'utf8') : stored.payload;
        return typeof payload === 'string' ? { envelope: stored.envelope, payload } : null;
    } catch {
        return null;
    }
}

function settle(r: OutboxRow, state: OutboxState, now: number): void {
    db.prepare(`UPDATE relay_outbox SET state = ?, item = NULL, next_try_at = NULL, attempts = attempts + 1, updated_at = ?
                WHERE sender_key = ? AND item_id = ? AND state = 'queued'`).run(state, now, r.sender_key, r.item_id);
    if (r.kind === 'dm-blob') removeRelayBlob(relayBlobFile('out', r.sender_key, r.item_id));
}

function tryLater(r: OutboxRow, now: number): void {
    const wait = RETRY_BACKOFF_MS[Math.min(r.attempts, RETRY_BACKOFF_MS.length - 1)];
    db.prepare(`UPDATE relay_outbox SET attempts = attempts + 1, next_try_at = ?, updated_at = ? WHERE sender_key = ? AND item_id = ? AND state = 'queued'`)
        .run(now + wait, now, r.sender_key, r.item_id);
}

/** One request to `home` with these queued rows (at most RELAY_ITEMS_PER_REQUEST, one blob), and each row's state after it. */
async function forwardTo(home: string, rows: OutboxRow[], now: number): Promise<void> {
    const sendable = rows.map((r) => ({ r, item: travellingItem(r) }));
    for (const { r, item } of sendable) if (!item) settle(r, 'failed', now);
    const going = sendable.filter((s) => s.item);
    if (!going.length) return;
    const body = JSON.stringify({ items: going.map((s) => s.item) });
    const url = `https://${home}${RELAY_MAIL_PATH}`;
    let status = 0;
    let answer: unknown;
    try {
        const headers = await ownNodeRequestHeaders({ method: 'POST', url, body });
        ({ status, body: answer } = await transport(url, { headers, body }));
    } catch (e) {
        logger.warn('SYS', `Mail to another community: ${home} could not be reached (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); `
            + `${going.length} item(s) wait to be tried again.`);
    }
    const at = Date.now();
    const refusals = new Map<string, number>();
    going.forEach(({ r }, i) => {
        // Taken (2xx): sent, unless its own answer inside says refused, which is as final as a 400 and the sender must see
        // it (Not delivered). Never to be taken: a request it refuses as not one, or too large. Anything else is tried again.
        if (status >= 200 && status < 300) {
            const refused = refusedInAnswer(answer, i, r.item_id, going.length);
            if (refused) refusals.set(refused, (refusals.get(refused) ?? 0) + 1);
            settle(r, refused ? 'failed' : 'sent', at);
        } else if (status === 400 || status === 413) settle(r, 'failed', at);
        else if (at - r.created_at >= OUTBOX_QUEUE_MS) settle(r, 'failed', at);
        else tryLater(r, at);
    });
    if (refusals.size) {
        logger.warn('SYS', `Mail to another community: ${home} took the request and refused ${[...refusals].map(([why, n]) => `${n} as ${why}`).join(', ')}; `
            + 'their senders see Not delivered.');
    }
}

/**
 * Forward these rows, one request per home and per RELAY_ITEMS_PER_REQUEST, a blob on its own. The homes at once, each
 * home's requests one after another: a member's send to several homes waits for the slowest one (FORWARD_TIMEOUT_MS at
 * most a request), never for their sum.
 */
async function forwardRows(rows: OutboxRow[], now: number): Promise<void> {
    const byHome = new Map<string, OutboxRow[]>();
    for (const r of rows) byHome.set(r.recipient_home, [...(byHome.get(r.recipient_home) ?? []), r]);
    await Promise.all([...byHome].map(async ([home, list]) => {
        const blobs = list.filter((r) => r.kind === 'dm-blob');
        const small = list.filter((r) => r.kind !== 'dm-blob');
        const batches: OutboxRow[][] = [];
        for (let i = 0; i < small.length; i += RELAY_ITEMS_PER_REQUEST) batches.push(small.slice(i, i + RELAY_ITEMS_PER_REQUEST));
        for (const b of blobs) batches.push([b]);
        for (const batch of batches) await forwardTo(home, batch, now);
    }));
}

let retrying = false;

/** The minute timer's turn (https-server.ts): queued rows that are due are forwarded again; old rows are settled or go. */
export async function retryRelayOutbox(now = Date.now()): Promise<number> {
    if (retrying) return 0;
    retrying = true;
    try {
        const due = db.prepare(`SELECT sender_key, item_id, kind, recipient_home, item, attempts, created_at FROM relay_outbox
                                WHERE state = 'queued' AND next_try_at <= ? ORDER BY next_try_at LIMIT ?`).all(now, RETRY_BATCH) as OutboxRow[];
        if (due.length && outsideMessagesOn()) await forwardRows(due, now);
        return due.length;
    } finally {
        retrying = false;
    }
}

/** Queued past OUTBOX_QUEUE_MS: failed. Sent and never confirmed past OUTBOX_KEPT_MS: expired. Settled past it: gone. */
export function sweepRelayOutbox(now = Date.now()): { failed: number; expired: number; gone: number } {
    const stale = db.prepare(`SELECT sender_key, item_id, kind, recipient_home, item, attempts, created_at FROM relay_outbox
                              WHERE state = 'queued' AND created_at < ?`).all(now - OUTBOX_QUEUE_MS) as OutboxRow[];
    for (const r of stale) settle(r, 'failed', now);
    const expired = db.prepare(`UPDATE relay_outbox SET state = 'expired', updated_at = ? WHERE state = 'sent' AND updated_at < ?`)
        .run(now, now - OUTBOX_KEPT_MS).changes;
    const gone = db.prepare(`DELETE FROM relay_outbox WHERE state IN ('delivered', 'failed', 'expired') AND updated_at < ?`)
        .run(now - OUTBOX_KEPT_MS).changes;
    return { failed: stale.length, expired, gone };
}

// ── A member sends ──────────────────────────────────────────────────────────────────────────

export interface SentState { itemId: string; state: OutboxState }

/** Why `raw` is not an item `member` may send from here, or the item. */
function itemProblem(raw: unknown, member: string, home: string, now: number): { item: { envelope: RelayEnvelope; payload: string } } | { problem: string; status?: 413 } {
    const o = raw as { envelope?: unknown; payload?: unknown } | null;
    const env = readRelayEnvelope(o?.envelope);
    if (!env || typeof o?.payload !== 'string') return { problem: 'Each item is { envelope, payload }, the envelope signed by its sender.' };
    if (!RELAY_HANDLED_KINDS.includes(env.kind)) return { problem: `This server sends only ${RELAY_HANDLED_KINDS.join(', ')} items.` };
    const max = relayPayloadMaxChars(env.kind)!;
    if (o.payload.length > max) return { problem: `A ${env.kind} item carries at most ${max} characters.`, status: 413 };
    if (env.senderKey !== member) return { problem: 'An item you send names you as its sender.' };
    if (env.senderHome !== home) return { problem: `An item sent from here names this community's server as its sender's home (${home}).` };
    if (!/^[0-9a-f]{64}$/.test(env.recipient) || env.recipient === member) return { problem: 'An item goes to one other person, named by their key.' };
    if (isOwnNodeHome(env.recipientHome)) return { problem: 'That person is in this community: write to them here.' };
    if (relayPayloadHash(o.payload) !== env.payloadHash) return { problem: 'The payload is not the one the envelope names.' };
    if (env.at < now - MAIL_ITEM_MAX_AGE_MS || env.at > now + MAIL_ITEM_MAX_AHEAD_MS) return { problem: 'The item\'s time is too far from this server\'s clock.' };
    if (env.kind === 'receipt' && !readReceiptPayload(o.payload)) return { problem: 'A receipt\'s payload is {"v":1,"items":[ids]}.' };
    if (!relayEnvelopeVerifies(env)) return { problem: 'The envelope is not signed by its sender.' };
    return { item: { envelope: env, payload: o.payload } };
}

/**
 * `member`'s items, checked, written to the outbox and forwarded now; each item's state after the first try. Throws
 * OutboxError, having stored nothing, when the switch is off, the request is not one, or an item is not theirs to send.
 * An item already in the outbox (the device sent it again) keeps its row and answers its state.
 */
export async function sendRelayItems(member: string, items: unknown, now = Date.now()): Promise<SentState[]> {
    if (!outsideMessagesOn()) throw new OutboxError(403, 'outside_messages_off', OUTSIDE_OFF_ERROR);
    const home = ownNodeHome();
    if (!home) throw new OutboxError(503, 'no_home', NO_HOME_ERROR);
    if (!Array.isArray(items) || items.length === 0 || items.length > RELAY_ITEMS_PER_REQUEST) {
        throw new OutboxError(400, 'bad_items', `items is a list of 1 to ${RELAY_ITEMS_PER_REQUEST} relay items.`);
    }
    const checked: Array<{ envelope: RelayEnvelope; payload: string }> = [];
    for (const raw of items) {
        const c = itemProblem(raw, member, home, now);
        if ('problem' in c) throw new OutboxError(c.status ?? 400, c.status === 413 ? 'too_large' : 'bad_item', c.problem);
        if (!checked.some((x) => x.envelope.itemId === c.item.envelope.itemId)) checked.push(c.item);
    }
    if (checked.filter((c) => c.envelope.kind === 'dm-blob').length > RELAY_BLOBS_PER_REQUEST) {
        throw new OutboxError(400, 'bad_items', `A request carries at most ${RELAY_BLOBS_PER_REQUEST} blob.`);
    }
    const existing = new Map((db.prepare(`SELECT item_id, state FROM relay_outbox WHERE sender_key = ? AND item_id IN (${checked.map(() => '?').join(', ')})`)
        .all(member, ...checked.map((c) => c.envelope.itemId)) as Array<{ item_id: string; state: OutboxState }>).map((r) => [r.item_id, r.state]));
    const fresh = checked.filter((c) => !existing.has(c.envelope.itemId));
    const sentToday = (db.prepare('SELECT COUNT(*) AS n FROM relay_outbox WHERE sender_key = ? AND created_at > ?').get(member, now - DAY_MS) as { n: number }).n;
    if (sentToday + fresh.length > OUTBOX_PER_MEMBER_DAY) throw new OutboxError(429, 'rate_limited', OUTBOX_RATE_ERROR);
    if (fresh.some((c) => c.envelope.kind === 'dm-blob')) assertFolderFloorSpace(relayMailDir());

    // ON CONFLICT, not OR IGNORE: a send of the same item at the same moment is skipped, and nothing else is ever quietly lost
    // (OR IGNORE also skips a row its CHECKs refuse, and the item would vanish with a 200).
    const insert = db.prepare(`INSERT INTO relay_outbox (sender_key, item_id, kind, recipient, recipient_home, state, item, attempts, next_try_at, created_at, updated_at)
                               VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?) ON CONFLICT (sender_key, item_id) DO NOTHING`);
    for (const c of fresh) {
        const e = c.envelope;
        const blob = e.kind === 'dm-blob';
        if (blob) writeRelayBlob(relayBlobFile('out', member, e.itemId), c.payload);
        insert.run(member, e.itemId, e.kind, e.recipient, e.recipientHome, JSON.stringify(blob ? { envelope: e } : { envelope: e, payload: c.payload }), now, now, now);
    }
    const rows = fresh.length
        ? db.prepare(`SELECT sender_key, item_id, kind, recipient_home, item, attempts, created_at FROM relay_outbox
                      WHERE sender_key = ? AND state = 'queued' AND item_id IN (${fresh.map(() => '?').join(', ')})`)
            .all(member, ...fresh.map((c) => c.envelope.itemId)) as OutboxRow[]
        : [];
    await forwardRows(rows, now);
    return statesOf(member, checked.map((c) => c.envelope.itemId));
}

function statesOf(member: string, ids: string[]): SentState[] {
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT item_id, state FROM relay_outbox WHERE sender_key = ? AND item_id IN (${ids.map(() => '?').join(', ')})`)
        .all(member, ...ids) as Array<{ item_id: string; state: OutboxState }>;
    const of = new Map(rows.map((r) => [r.item_id, r.state]));
    return ids.filter((id) => of.has(id)).map((id) => ({ itemId: id, state: of.get(id)! }));
}

/** Ticks one fetch gives. */
export const OUTBOX_TICKS_PAGE = 200;

export interface OutboxTick { itemId: string; kind: string; recipient: string; recipientHome: string; state: OutboxState; at: number }

/**
 * What became of `member`'s items, oldest change first, OUTBOX_TICKS_PAGE at a time, after the cursor (`since`, `sinceId`):
 * the last tick the device has, by its `at` and `itemId`. Many rows change at one moment (a forward's batch, the sweep), so
 * the cursor is the pair, never the time alone, and `more` says whether a full page ends before the last. A time with no
 * id reads from the start of that moment: a tick read twice is harmless, one skipped is lost.
 */
export function outboxStatesFor(member: string, since = 0, sinceId = ''): { ticks: OutboxTick[]; more: boolean } {
    const rows = db.prepare(`SELECT item_id, kind, recipient, recipient_home, state, updated_at FROM relay_outbox
                             WHERE sender_key = ? AND kind != 'receipt' AND (updated_at > ? OR (updated_at = ? AND item_id > ?))
                             ORDER BY updated_at, item_id LIMIT ?`)
        .all(member, since, since, sinceId, OUTBOX_TICKS_PAGE + 1) as Array<{
            item_id: string; kind: string; recipient: string; recipient_home: string; state: OutboxState; updated_at: number;
        }>;
    return {
        ticks: rows.slice(0, OUTBOX_TICKS_PAGE).map((r) => ({
            itemId: r.item_id, kind: r.kind, recipient: r.recipient, recipientHome: r.recipient_home, state: r.state, at: r.updated_at,
        })),
        more: rows.length > OUTBOX_TICKS_PAGE,
    };
}
