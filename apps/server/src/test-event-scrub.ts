/**
 * Events slice 6 — moderation hook and the 30-day scrub (docs/events-on-the-map.md §2.2, §2.5, §4 row 6;
 * decisions 21, 27, 30).
 *
 *  1. The scrub takes the RSVPs, the chat messages, the chat membership and the note for people going, and
 *     KEEPS the post row — inactive, status 'completed'. Posts are never hard-deleted.
 *  2. The window is thirty days from the end: an event that ended 29 days ago is untouched, one that ended
 *     31 days ago is scrubbed. Future events, events with no end and non-event posts are never touched.
 *  3. It is idempotent and it rides the pulse scheduler tick, so an event nobody opens again is still
 *     scrubbed on time.
 *  4. Moderation: an admin acting on a report removes the event, turns the chat read-only and tells
 *     everyone marked Going — on the existing `marketplace` category, all the way out to Expo.
 *  5. Replica consistency: every delete the scrub makes travels as a tombstone, so a backup drops the same
 *     rows instead of keeping the last copy of a private chat. After import the state hash matches the
 *     primary and the replica-consistency audit says the tables match.
 *
 * And the two findings from the slice 4 review:
 *
 *  6. The generic message read honours the event chat's 30-day window: past it both routes answer 410, so
 *     a host or a Going member cannot read through the side door what the chat route has closed.
 *  7. POST .../chat/message is throttled per signed member (the chat bucket, not the per-IP auth limiter);
 *     the chat read is not.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, exportSyncState, importRemoteState, setNodeRole,
    submitReport, actionReport, adminDeletePost as adminDeletePostStateful,
} from './state-engine.js';
import {
    createPost as createPostEngine, rsvpEvent, adminDeletePost, scrubEndedEvents,
    EVENT_SCRUB_AFTER_END_MS, EVENT_CANCELLED_PUSH_TITLE, eventPushBody,
} from './engine/posts.js';
import { getEventThread, postEventThreadMessage } from './engine/event-thread.js';
import { chatRateLimit, resetChatRateLimit, CHAT_LINES_PER_MINUTE } from './chat-rate-limit.js';
import { runPulseSchedulerTick } from './engine/pulse-resolver.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { getStateHash, getReplicaConsistency } from '@beanpool/engine';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
function assertThrows(fn: () => unknown, match: RegExp, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ FAIL: ${msg} (nothing thrown)`);
    } catch (e: any) {
        if (match.test(e?.message ?? '')) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ FAIL: ${msg} (got "${e?.message}")`);
    }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const broadcasts: any[] = [];
const capture = (event: any) => { broadcasts.push(event); };
const cb = { broadcast: capture, dispatchPushNotification: () => { }, registerVisitor: () => { } };

interface PushCall { targets: string[]; actor: string; title: string; body: string; data: any; category: string }
let pushes: PushCall[] = [];
const pushSpy = (targets: string[], actor: string, title: string, body: string, data: any, category: any) => {
    pushes.push({ targets, actor, title, body, data, category });
};

function newEvent(author: string, extra: Record<string, unknown> = {}) {
    return createPostEngine(capture, 'event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', author,
        -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(24), eventPlaceName: 'The old bowls club', eventPrivateNote: 'Gate code 1234', ...extra } as any)!;
}

/** Move an event into the past without going through the validation that forbids it. */
function endEvent(id: string, endedAgoMs: number): void {
    const end = new Date(Date.now() - endedAgoMs).toISOString();
    const start = new Date(Date.now() - endedAgoMs - 2 * HOUR).toISOString();
    db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?`).run(start, end, id);
}

const count = (sql: string, ...params: any[]): number =>
    Number((db.prepare(sql).get(...params) as any).c) || 0;
const rsvpCount = (postId: string) => count('SELECT COUNT(*) c FROM event_rsvps WHERE post_id = ?', postId);
const msgCount = (convId: string) => count('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?', convId);
const partCount = (convId: string) => count('SELECT COUNT(*) c FROM conversation_participants WHERE conversation_id = ?', convId);
const postRow = (id: string) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as any;
const hasTombstone = (table: string, rowKey: string) =>
    !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, rowKey);

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}

const routeCtx = (id: string, actor: string | undefined, body?: any): any => ({
    params: { id }, requestBody: body ?? {}, state: actor ? { actor } : {}, query: {},
    get: () => '', set: () => { }, headers: {}, ip: '203.0.113.7',
});
const msgCtx = (convId: string, actor: string | undefined): any => ({
    params: { conversationId: convId }, state: actor ? { actor } : {}, query: {},
    get: () => '', set: () => { }, headers: {}, ip: '203.0.113.7',
});

async function main(): Promise<void> {
    initStateEngine();
    const p2pNode = await startP2P(4046, 4047);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4047/p2p/${nodeId}`, 'mirror', 'self-test-peer');

    // A stand-in for the per-IP auth limiter https-server passes. Section 7 shows chat lines no longer reach it.
    let chatBudget = Number.POSITIVE_INFINITY;
    let rateLimitCalls = 0;
    const deps = {
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        enforceReadAuth: true,
        rateLimit: (ctx: any) => {
            rateLimitCalls++;
            if (chatBudget <= 0) {
                ctx.status = 429;
                ctx.body = { error: 'Too many attempts. Try again in 42s' };
                return false;
            }
            chatBudget--;
            return true;
        },
    } as any;
    const market = createMarketplaceRoutes(deps);
    const messaging = createMessagingRoutes(deps);

    const host = makeMember('Host');
    const goer = makeMember('Goer');
    const maybe = makeMember('Maybe');
    const admin = makeMember('Admin');

    // ── 1. What the scrub takes and what it keeps ────────────────────────────────────────────
    console.log('\n--- 1. The scrub ---');
    const ev = newEvent(host);
    rsvpEvent(capture, ev.id, goer, 'going');
    rsvpEvent(capture, ev.id, maybe, 'interested');
    const kept = postEventThreadMessage(cb, ev.id, goer, 'Bringing a thermos');
    postEventThreadMessage(cb, ev.id, host, 'See you there');
    assert(rsvpCount(ev.id) === 2 && msgCount(ev.id) === 2 && partCount(ev.id) >= 2,
        'before the scrub the event has its RSVPs, its chat and its members');

    endEvent(ev.id, 31 * DAY);
    assert(scrubEndedEvents() === 1, 'an event that ended 31 days ago is scrubbed');

    assert(rsvpCount(ev.id) === 0, 'the scrub deletes every RSVP');
    assert(msgCount(ev.id) === 0, 'the scrub deletes every chat message');
    assert(partCount(ev.id) === 0, 'the scrub deletes the chat membership');
    const scrubbedRow = postRow(ev.id);
    assert(!!scrubbedRow, 'the post row is KEPT — a post is never hard-deleted');
    assert(scrubbedRow.event_private_note === null, 'the note for people going is nulled');
    assert(scrubbedRow.active === 0 && scrubbedRow.status === 'completed',
        "the row is left inactive with status 'completed'");
    assert(scrubbedRow.title === 'Working bee' && scrubbedRow.event_start_at !== null,
        'the public shape of the post — title, description, dates, pin — is untouched');
    assert(!!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(ev.id),
        'the empty conversation row stays: a replica has no tombstone handler for one');

    assert(hasTombstone('event_rsvps', `${ev.id}|${goer}`) && hasTombstone('event_rsvps', `${ev.id}|${maybe}`),
        'each deleted RSVP leaves a tombstone so a replica drops it too');
    assert(hasTombstone('messages', kept.id), 'each deleted message leaves a tombstone');
    assert(hasTombstone('conversation_participants', `${ev.id}|${goer}`),
        'each deleted membership row leaves a tombstone');

    assertThrows(() => getEventThread(ev.id, host), /no longer available/,
        'and the chat is gone for the host as well as for everyone who was going');

    // ── 2. The window, and what is never touched ─────────────────────────────────────────────
    console.log('\n--- 2. The 30-day window ---');
    assert(EVENT_SCRUB_AFTER_END_MS === 30 * DAY, 'the scrub window is thirty days');

    const recent = newEvent(host);
    rsvpEvent(capture, recent.id, goer, 'going');
    postEventThreadMessage(cb, recent.id, goer, 'Was a good one');
    endEvent(recent.id, 29 * DAY);
    const upcoming = newEvent(host);
    rsvpEvent(capture, upcoming.id, goer, 'going');
    const openEnded = newEvent(host);
    rsvpEvent(capture, openEnded.id, maybe, 'interested');
    // An end is never null through createPost — it defaults to start + 2 hours — but a row imported from
    // an older node or hand-edited could be, and a NULL end must not read as "ended long ago".
    db.prepare('UPDATE posts SET event_end_at = NULL WHERE id = ?').run(openEnded.id);
    const offer = createPostEngine(capture, 'offer', 'other', 'Spare tomatoes', 'Free', 5, 'fixed', host,
        undefined, undefined, [], false)!;
    db.prepare(`UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 400 * DAY).toISOString(), new Date(Date.now() - 400 * DAY).toISOString(), offer.id);

    assert(scrubEndedEvents() === 0, 'nothing else is due, so a second sweep scrubs nothing');
    assert(rsvpCount(recent.id) === 1 && msgCount(recent.id) === 1 && postRow(recent.id).event_private_note === 'Gate code 1234',
        'an event that ended 29 days ago keeps its RSVPs, its chat and its note');
    assert(rsvpCount(upcoming.id) === 1 && postRow(upcoming.id).active === 1, 'an upcoming event is untouched');
    assert(rsvpCount(openEnded.id) === 1, 'an event with no end time is never scrubbed');
    assert(postRow(offer.id).active === 1 && postRow(offer.id).status === 'active',
        'an old ordinary listing is not an event and is not touched');

    // Idempotent: the scrubbed event is already 'completed', so it is never picked up again.
    const stampBefore = postRow(ev.id).updated_at;
    assert(scrubEndedEvents() === 0, 'the scrub is idempotent — a scrubbed event is not scrubbed twice');
    assert(postRow(ev.id).updated_at === stampBefore, 'and its updated_at does not churn on every tick');

    // A cancelled event is scrubbed on the same clock, and keeps its CANCELLED badge.
    const cancelledEv = newEvent(host);
    rsvpEvent(capture, cancelledEv.id, goer, 'going');
    db.prepare(`UPDATE posts SET active = 0, status = 'cancelled', event_state = 'cancelled' WHERE id = ?`).run(cancelledEv.id);
    endEvent(cancelledEv.id, 31 * DAY);
    assert(scrubEndedEvents() === 1, 'a cancelled event is scrubbed thirty days after it would have ended');
    assert(rsvpCount(cancelledEv.id) === 0, 'and its RSVPs go with it');
    assert(postRow(cancelledEv.id).event_state === 'cancelled',
        'the card still reads CANCELLED: the badge is event_state, which the scrub does not touch');

    // ── 3. The scheduler tick runs it ────────────────────────────────────────────────────────
    console.log('\n--- 3. The scheduler ---');
    const swept = newEvent(host);
    rsvpEvent(capture, swept.id, goer, 'going');
    postEventThreadMessage(cb, swept.id, goer, 'See you');
    endEvent(swept.id, 45 * DAY);
    await runPulseSchedulerTick();
    assert(rsvpCount(swept.id) === 0 && msgCount(swept.id) === 0 && postRow(swept.id).status === 'completed',
        'the pulse scheduler tick scrubs an event nobody ever opened again (§2.2)');

    // ── 4. The moderation hook ───────────────────────────────────────────────────────────────
    console.log('\n--- 4. Admin removal ---');
    const reported = newEvent(host);
    rsvpEvent(capture, reported.id, goer, 'going');
    rsvpEvent(capture, reported.id, maybe, 'interested');
    postEventThreadMessage(cb, reported.id, goer, 'Is this for real?');

    pushes = [];
    assert(adminDeletePost(capture, reported.id, undefined, undefined, pushSpy) === true,
        'an admin removes a reported event');
    const removedRow = postRow(reported.id);
    assert(removedRow.active === 0 && removedRow.status === 'cancelled' && removedRow.event_state === 'cancelled',
        "admin removal cancels the event: active 0, status and event_state 'cancelled'");
    const removedThread = getEventThread(reported.id, goer);
    assert(removedThread.readOnly && !removedThread.canPost && /cancelled/i.test(removedThread.readOnlyReason || ''),
        'the chat is read-only the moment the removal commits (§2.5)');
    assertThrows(() => postEventThreadMessage(cb, reported.id, goer, 'hello?'), /cancelled/,
        'and nobody can post to it any more');
    assert(removedThread.messages.length === 1,
        'the chat is still READABLE to the people who were going — the scrub takes it, not the removal');

    assert(pushes.length === 1, 'removing a reported event sends exactly one push batch');
    assert(pushes[0]?.targets.join() === goer, 'to the member marked Going');
    assert(!pushes[0]?.targets.includes(maybe), 'never to a member who was only Interested');
    assert(pushes[0]?.actor === 'SYSTEM',
        'the actor is SYSTEM: an admin is not in the Going list, so nobody is dropped as the cause');
    assert(pushes[0]?.title === EVENT_CANCELLED_PUSH_TITLE && pushes[0]?.body === eventPushBody('cancelled', 'Working bee'),
        'it is the cancellation message, naming the event');
    assert(pushes[0]?.category === 'marketplace', 'on the existing marketplace category (decision 27)');
    assert(pushes[0]?.data?.screen === 'post' && pushes[0]?.data?.postId === reported.id,
        'with the payload the phone routes to /post/:id');
    assert(rsvpCount(reported.id) === 2, 'the RSVPs survive the removal and go with the 30-day scrub');

    pushes = [];
    const plainOffer = createPostEngine(capture, 'offer', 'other', 'Jam jars', 'Free', 1, 'fixed', host,
        undefined, undefined, [], false)!;
    assert(adminDeletePost(capture, plainOffer.id, undefined, undefined, pushSpy) === true, 'an offer can still be removed');
    assert(pushes.length === 0, 'and removing a non-event sends no event notification');
    assert(adminDeletePost(capture, crypto.randomUUID(), undefined, undefined, pushSpy) === false,
        'removing an id that is not a post is still false');

    // The whole way through: report → admin actions it → Expo. This is the path §2.5 describes.
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    (globalThis as any).fetch = async (url: any, init: any) => {
        if (String(url).includes('exp.host')) {
            sent.push(...JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({}) } as any;
        }
        return realFetch(url, init);
    };
    try {
        db.prepare(`INSERT OR REPLACE INTO push_tokens (public_key, token, platform) VALUES (?, ?, 'android')`)
            .run(goer, 'ExponentPushToken[goer]');
        const wired = newEvent(host);
        rsvpEvent(capture, wired.id, goer, 'going');
        const report = submitReport(admin, host, 'This gathering is not real', wired.id)!;
        sent.length = 0;
        assert(actionReport(report.id, true) === true, 'the admin actions the report with "delete post"');
        await new Promise(r => setImmediate(r));
        assert(postRow(wired.id).event_state === 'cancelled', 'the reported event is cancelled through the wired route');
        assert(sent.length === 1 && sent[0]?.to === 'ExponentPushToken[goer]',
            'and the member marked Going is pushed to');
        assert(sent[0]?.channelId === 'marketplace' && sent[0]?.title === EVENT_CANCELLED_PUSH_TITLE,
            'on the marketplace Android channel, so no app in the store needs an update');

        // A reported listing that is not an event still sends nothing on this path.
        const offerReported = createPostEngine(capture, 'offer', 'other', 'Dodgy', 'Nope', 1, 'fixed', host,
            undefined, undefined, [], false)!;
        const report2 = submitReport(admin, host, 'Spam', offerReported.id)!;
        sent.length = 0;
        actionReport(report2.id, true);
        await new Promise(r => setImmediate(r));
        assert(sent.length === 0, 'an actioned report on an offer pushes nobody');

        // The state-engine wrapper carries the dispatcher too, not just the engine call above.
        const direct = newEvent(host);
        rsvpEvent(capture, direct.id, goer, 'going');
        sent.length = 0;
        assert(adminDeletePostStateful(direct.id) === true, 'the state-engine adminDeletePost wrapper removes an event');
        await new Promise(r => setImmediate(r));
        assert(sent.length === 1, 'and it is wired to the push dispatcher');
    } finally {
        (globalThis as any).fetch = realFetch;
    }

    // ── 5. Replica consistency ───────────────────────────────────────────────────────────────
    console.log('\n--- 5. A replica applies the same scrub ---');
    const syncEv = newEvent(host, { eventPrivateNote: 'Back gate, code 4321' });
    rsvpEvent(capture, syncEv.id, goer, 'going');
    rsvpEvent(capture, syncEv.id, maybe, 'interested');
    const syncMsgA = postEventThreadMessage(cb, syncEv.id, goer, 'Who is bringing the urn?');
    const syncMsgB = postEventThreadMessage(cb, syncEv.id, host, 'I am');
    // What a replica holds the moment before the primary scrubs.
    const replicaRsvps = db.prepare('SELECT * FROM event_rsvps WHERE post_id = ?').all(syncEv.id) as any[];
    const replicaMsgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(syncEv.id) as any[];
    const replicaParts = db.prepare('SELECT * FROM conversation_participants WHERE conversation_id = ?').all(syncEv.id) as any[];

    endEvent(syncEv.id, 31 * DAY);
    assert(scrubEndedEvents() === 1, 'the primary scrubs the event');
    const primaryHash = getStateHash(db);
    const payload = await exportSyncState(nodeId);
    assert(!(payload.messages ?? []).some(m => m.id === syncMsgA.id || m.id === syncMsgB.id),
        'the snapshot no longer carries the scrubbed chat');
    assert(!(payload.eventRsvps ?? []).some((r: any) => r.postId === syncEv.id),
        'nor the RSVPs');
    assert((payload.tombstones ?? []).some(t => t.tableName === 'messages' && t.rowKey === syncMsgA.id)
        && (payload.tombstones ?? []).some(t => t.tableName === 'conversation_participants' && t.rowKey === `${syncEv.id}|${goer}`)
        && (payload.tombstones ?? []).some(t => t.tableName === 'event_rsvps' && t.rowKey === `${syncEv.id}|${goer}`),
        'the scrub exports one tombstone per deleted row, in all three tables');
    assert((payload.posts ?? []).some(p => p.id === syncEv.id && !p.eventPrivateNote),
        'the post row still travels, with the note gone');

    // Roll this database back to the pre-scrub state: that is a backup that has not applied the scrub yet.
    db.prepare(`DELETE FROM tombstones WHERE row_key = ? OR row_key = ? OR row_key LIKE ?`)
        .run(syncMsgA.id, syncMsgB.id, `${syncEv.id}|%`);
    for (const r of replicaRsvps) {
        db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(r.post_id, r.member_pubkey, r.status, r.signature, r.updated_at);
    }
    for (const m of replicaMsgs) {
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(m.id, m.conversation_id, m.author_pubkey, m.ciphertext, m.nonce, m.type, m.timestamp, m.updated_at);
    }
    for (const p of replicaParts) {
        // With the primary's updated_at, which is what a replica now stores — the import carries it so a
        // tombstone can be compared against it.
        db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key, last_read_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run(p.conversation_id, p.public_key, p.last_read_at, p.updated_at);
    }
    db.prepare(`UPDATE posts SET event_private_note = ?, active = 1, status = 'active', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`)
        .run('Back gate, code 4321', syncEv.id);
    assert(getStateHash(db) !== primaryHash, 'a replica that has not applied the scrub reads as diverged');

    setNodeRole('backup');
    await importRemoteState(payload as any);
    assert(rsvpCount(syncEv.id) === 0, 'importing the snapshot deletes the RSVPs on the replica');
    assert(msgCount(syncEv.id) === 0, 'and the chat messages — a backup does not keep the last copy of a scrubbed chat');
    assert(partCount(syncEv.id) === 0, 'and the chat membership');
    const replicaPost = postRow(syncEv.id);
    assert(!!replicaPost && replicaPost.event_private_note === null && replicaPost.active === 0 && replicaPost.status === 'completed',
        'the replica keeps the post row, inactive and with the note gone');
    assert(getStateHash(db) === primaryHash, 'after import the replica state hash matches the primary');

    const consistency = getReplicaConsistency(db, payload as any, 0);
    const table = (n: string) => consistency.tables.find(t => t.name === n);
    assert(table('posts')?.match === true, 'the replica-consistency audit matches on posts');
    assert(table('event_rsvps')?.match === true, 'and on event_rsvps');
    assert(table('messages')?.match === true, 'and on messages');
    assert(table('conversation_participants')?.match === true,
        'and on conversation_participants, which the audit now counts');
    // Leaving a chat has to reach a replica too, or the guest list the audit above compares is fiction —
    // and a re-join has to survive the tombstone that the leaving wrote.
    const churn = newEvent(host);
    rsvpEvent(capture, churn.id, goer, 'going');
    assert(partCount(churn.id) === 2, 'Going puts a member in the chat beside the host');
    rsvpEvent(capture, churn.id, goer, 'interested');
    assert(partCount(churn.id) === 1, 'switching to Interested takes them out of it');
    assert(hasTombstone('conversation_participants', `${churn.id}|${goer}`),
        'and leaves a tombstone, so a backup drops the membership row as well');
    const leftAt = (db.prepare(`SELECT deleted_at FROM tombstones WHERE table_name = 'conversation_participants' AND row_key = ?`)
        .get(`${churn.id}|${goer}`) as any).deleted_at as string;
    rsvpEvent(capture, churn.id, goer, 'going');
    const rejoinedAt = (db.prepare('SELECT updated_at FROM conversation_participants WHERE conversation_id = ? AND public_key = ?')
        .get(churn.id, goer) as any).updated_at as string;
    assert(rejoinedAt > leftAt, 'a re-join is stamped strictly after the tombstone it has to beat');

    const rejoinPayload = await exportSyncState(nodeId);
    db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').run(churn.id, goer);
    db.prepare(`DELETE FROM tombstones WHERE table_name = 'conversation_participants' AND row_key = ?`).run(`${churn.id}|${goer}`);
    setNodeRole('backup');
    await importRemoteState(rejoinPayload as any);
    assert(partCount(churn.id) === 2,
        'a replica importing the leaving and the re-join together keeps the member in the chat');
    setNodeRole('primary');

    // ── 6. The generic message read honours the 30-day window (slice 4 review) ───────────────
    console.log('\n--- 6. The side door ---');
    const windowEv = newEvent(host);
    rsvpEvent(capture, windowEv.id, goer, 'going');
    postEventThreadMessage(cb, windowEv.id, goer, 'Still on?');

    endEvent(windowEv.id, 29 * DAY);
    let ctx: any = await dispatch(messaging, 'GET', `/api/messages/${windowEv.id}`, msgCtx(windowEv.id, goer));
    assert(Array.isArray(ctx.body?.messages), 'inside the window a member going still reads the chat generically');
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${windowEv.id}/chat`, routeCtx(windowEv.id, goer));
    assert(ctx.body?.messages?.length === 1, 'and through the event chat route');

    endEvent(windowEv.id, 31 * DAY);
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${windowEv.id}/chat`, routeCtx(windowEv.id, goer));
    assert(ctx.status === 410, 'past the window the event chat route answers 410');
    ctx = await dispatch(messaging, 'GET', `/api/messages/${windowEv.id}`, msgCtx(windowEv.id, goer));
    assert(ctx.status === 410, 'and the generic message route answers 410 too, instead of serving the chat');
    assert(!Array.isArray(ctx.body?.messages) && !ctx.body?.conversation,
        'the 410 carries no messages and no conversation metadata');
    ctx = await dispatch(messaging, 'GET', `/api/messages/${windowEv.id}`, msgCtx(windowEv.id, host));
    assert(ctx.status === 410, 'not even for the host');
    // A member who was never in the chat is still refused by the generic participant check that runs
    // ahead of all this, so the window never becomes a way to learn that an event existed.
    ctx = await dispatch(messaging, 'GET', `/api/messages/${windowEv.id}`, msgCtx(windowEv.id, maybe));
    assert(ctx.status === 403, 'a member who was never in the chat is still refused outright');

    // ── 7. The chat/message route is throttled (slice 4 review) ─────────────────────────────
    // Per signed member, in the chat bucket — not the per-IP auth limiter, which also guards recovery and pairing
    // for everyone behind the same NAT (0919 follow-up).
    console.log('\n--- 7. The throttle ---');
    const chatty = newEvent(host);
    rsvpEvent(capture, chatty.id, goer, 'going');
    const callsBefore = rateLimitCalls;
    chatBudget = 0; // were the auth limiter still consulted, every line would be refused
    resetChatRateLimit();
    for (let i = 0; i < CHAT_LINES_PER_MINUTE - 2; i++) chatRateLimit({} as any, goer); // two lines left this minute
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${chatty.id}/chat/message`, routeCtx(chatty.id, goer, { text: 'one' }));
    assert(ctx.status === 201, 'a message inside the budget is posted');
    assert(rateLimitCalls === callsBefore, 'the chat/message route does not consult the per-IP auth limiter');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${chatty.id}/chat/message`, routeCtx(chatty.id, goer, { text: 'two' }));
    assert(ctx.status === 201, 'and so is the second');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${chatty.id}/chat/message`, routeCtx(chatty.id, goer, { text: 'three' }));
    assert(ctx.status === 429, 'the message past the budget of that member is refused with 429');
    assert(msgCount(chatty.id) === 2, 'and nothing is written for it');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${chatty.id}/chat/message`, routeCtx(chatty.id, host, { text: 'host line' }));
    assert(ctx.status === 201, 'another member in the same chat, same IP, has their own budget');

    // An unsigned request is refused by the auth check before any write.
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${chatty.id}/chat/message`, routeCtx(chatty.id, undefined, { text: 'four' }));
    assert(ctx.status === 401 && msgCount(chatty.id) === 3, 'an unsigned request is refused (401) and writes nothing');
    resetChatRateLimit();

    // Reading is not throttled: a member scrolling a chat is not a flood.
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${chatty.id}/chat`, routeCtx(chatty.id, goer));
    assert(ctx.status !== 429 && ctx.body?.messages?.length === 3, 'the chat read is not throttled');

    await p2pNode.stop();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
