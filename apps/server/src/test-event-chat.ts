/**
 * Events slice 4 — event chat (docs/events-on-the-map.md §2.1, §2.2, §4 row 4).
 *
 *  1. The chat is created with the event: one `event_thread` conversation whose id IS the post id, named
 *     after the event, with the acting member as its first participant (the keeper, not the enterprise).
 *  2. Membership mirrors the RSVP: Going adds, Interested and "not going" remove, the host never leaves.
 *  3. Read: host or Going only — re-checked against the RSVP, not the participants mirror. A keeper of an
 *     enterprise host and a convenor of a group host read without an RSVP.
 *  4. Post: the same set, plaintext-v1 like the enterprise thread, 2000-character cap, frozen members
 *     refused, clientId idempotent, no push per message, broadcast only to the people in the chat.
 *  5. Host removal replaces the text with "removed by the host" and marks the row removed.
 *  6. Read-only when the event ends or is cancelled: reads still work, posts are refused.
 *  7. Gone 30 days after the end, for everyone.
 *  8. The routes map each refusal onto a status (401 / 403 / 404 / 409 / 410).
 *  9. The generic messaging routes refuse to write an event chat and refuse to read one for anyone but the
 *     host and Going.
 * 10. The chat appears in the Talk list with the event's title and an unread count.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createTreasury, adminAssignTreasuryOperator, createPost,
    getConversationsByMember, getUnreadCounts, markConversationRead,
} from './state-engine.js';
import { createPost as createPostEngine, removePost, rsvpEvent } from './engine/posts.js';
import {
    getEventThread, postEventThreadMessage, removeEventThreadMessage,
    ensureEventThread, canReadEventThread, loadEventForThread,
    EVENT_THREAD_NOTICE, EVENT_THREAD_MESSAGE_MAX,
} from './engine/event-thread.js';
import { sendMessage, editMessage, toggleMessageReaction } from './engine/messaging.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';
import { createMessagingRoutes } from './routes/messaging.js';

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
const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const broadcasts: any[] = [];
const pushes: any[] = [];
const capture = (event: any, recipients?: string[]) => { broadcasts.push({ event, recipients }); };
const cb = {
    broadcast: capture,
    dispatchPushNotification: (...args: any[]) => { pushes.push(args); },
    registerVisitor: () => { },
};

function newEvent(author: string, extra: Record<string, unknown> = {}) {
    return createPostEngine(capture, 'event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', author,
        -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(24), eventPlaceName: 'The old bowls club', eventPrivateNote: 'Gate code 1234', ...extra } as any)!;
}

/** Move an event into the past without going through the validation that forbids it. */
function endEvent(id: string, endedAgoMs = HOUR): void {
    const end = new Date(Date.now() - endedAgoMs).toISOString();
    const start = new Date(Date.now() - endedAgoMs - 2 * HOUR).toISOString();
    db.prepare(`UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?`).run(start, end, id);
}

function isParticipant(convId: string, pubkey: string): boolean {
    return !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?')
        .get(convId, pubkey);
}

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}

const routeCtx = (id: string, actor: string | undefined, body?: any, query: Record<string, string> = {}): any => ({
    params: { id }, requestBody: body ?? {}, state: actor ? { actor } : {}, query,
    get: () => '', set: () => { }, headers: {},
});

async function main(): Promise<void> {
    initStateEngine();

    const deps = {
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        enforceReadAuth: true,
    } as any;
    const market = createMarketplaceRoutes(deps);
    const messaging = createMessagingRoutes(deps);

    const host = makeMember('Host');
    const goer = makeMember('Goer');
    const maybe = makeMember('Maybe');
    const stranger = makeMember('Stranger');
    const frozen = makeMember('Frozen');
    const keeper = makeMember('Keeper');
    const convenor = makeMember('Convenor');
    const groupie = makeMember('Groupie');
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(frozen);

    // ── 1. The chat is created with the event ────────────────────────────────────────────────
    console.log('\n--- 1. Created with the event ---');
    const ev = newEvent(host);
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(ev.id) as any;
    assert(!!conv && conv.type === 'event_thread', "the event's chat is one event_thread conversation");
    assert(conv.id === ev.id, 'the conversation id IS the post id');
    assert(conv.name === 'Working bee', "the conversation carries the event's title, so the Talk list can show it");
    assert(conv.post_id === null, 'the chat is not post-keyed: an event is not a deal thread');
    assert(isParticipant(ev.id, host), 'the host is the first participant');

    const treasury = createTreasury('Bowls Club Co-op', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(treasury, keeper, 'admin');
    const entEv = createPost('event', 'community', 'Hall working bee', '', 0, 'fixed', treasury, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(30), eventPlaceName: 'The hall', createdBy: keeper })!;
    assert(isParticipant(entEv.id, keeper), 'an enterprise event puts the acting keeper in the chat');
    assert(!isParticipant(entEv.id, treasury), "the enterprise's own pubkey is not a chat participant — it has no inbox");

    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Repair group', ?, ?)`).run(groupId, `repair-${groupId.slice(0, 8)}`, convenor);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'convenor', 'active')`).run(groupId, convenor);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')`).run(groupId, groupie);
    const groupEv = newEvent(groupie, { audienceScope: 'group', targetGroupId: groupId });

    // An event posted before this slice shipped has no chat row until someone opens it.
    const legacy = newEvent(host, { eventStartAt: inHours(26) });
    db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ?').run(legacy.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(legacy.id);
    const revived = ensureEventThread(legacy.id);
    assert(revived.id === legacy.id && isParticipant(legacy.id, host), 'an event created before this slice gets its chat on first open');

    // ── 2. Membership mirrors the RSVP ───────────────────────────────────────────────────────
    console.log('\n--- 2. Membership follows the RSVP ---');
    rsvpEvent(capture, ev.id, goer, 'going');
    assert(isParticipant(ev.id, goer), 'Going puts you in the chat');
    rsvpEvent(capture, ev.id, goer, 'interested');
    assert(!isParticipant(ev.id, goer), 'switching to Interested takes you out of the chat');
    rsvpEvent(capture, ev.id, goer, 'going');
    assert(isParticipant(ev.id, goer), 'Going again puts you back');
    rsvpEvent(capture, ev.id, maybe, 'interested');
    assert(!isParticipant(ev.id, maybe), 'Interested alone never joins the chat');
    rsvpEvent(capture, ev.id, stranger, 'going');
    rsvpEvent(capture, ev.id, stranger, null);
    assert(!isParticipant(ev.id, stranger), '"not going" takes you out of the chat');
    rsvpEvent(capture, ev.id, host, 'interested');
    assert(isParticipant(ev.id, host), 'the host never leaves the chat, whatever they RSVP');
    rsvpEvent(capture, groupEv.id, groupie, 'going');

    // ── 3. Who may read ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Read: host or Going ---');
    const hostView = getEventThread(ev.id, host);
    assert(hostView.isHost && hostView.canPost && !hostView.readOnly, 'the host opens an open chat and may post');
    assert(hostView.privateNote === 'Gate code 1234', 'the private note rides on the read, to be pinned at the top');
    assert(hostView.title === 'Working bee' && hostView.notice === EVENT_THREAD_NOTICE, 'the read carries the title and the node-readable notice');
    const goerView = getEventThread(ev.id, goer);
    assert(goerView.canPost && !goerView.isHost && goerView.privateNote === 'Gate code 1234', 'someone Going reads the chat and the note');
    assertThrows(() => getEventThread(ev.id, maybe), /Only the host and people going/, 'Interested cannot open the chat');
    assertThrows(() => getEventThread(ev.id, stranger), /Only the host and people going/, 'a member with no RSVP cannot open the chat');
    assertThrows(() => getEventThread(ev.id, undefined), /Only the host and people going/, 'a guest cannot open the chat');
    assertThrows(() => getEventThread('not-an-event-id', host), /Event not found/, 'a chat for something that is not an event is a 404');
    assert(!!getEventThread(entEv.id, keeper).isHost, 'a keeper of the enterprise host reads without an RSVP');
    assert(!!getEventThread(groupEv.id, convenor).isHost, 'an active convenor of the group reads without an RSVP');
    assertThrows(() => getEventThread(groupEv.id, stranger), /Only the host and people going/, 'a non-member cannot open a group-only event chat');

    // The participants mirror is not authority: a row left behind by a replica is not a ticket in.
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(ev.id, maybe);
    assert(!canReadEventThread(loadEventForThread(ev.id), maybe), 'a stale participant row without a going RSVP still cannot read');
    assertThrows(() => getEventThread(ev.id, maybe), /Only the host and people going/, 'and the read refuses it');
    db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').run(ev.id, maybe);

    // ── 4. Posting ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Posting ---');
    pushes.length = 0;
    broadcasts.length = 0;
    const msg = postEventThreadMessage(cb, ev.id, goer, '  Bringing a thermos  ');
    assert(decode(msg.ciphertext) === 'Bringing a thermos' && msg.nonce === 'plaintext-v1',
        'a message is stored node-readable as base64 plaintext-v1, trimmed');
    assert(msg.authorCallsign === 'Goer' && msg.type === 'text', 'the message carries the author callsign');
    assert(pushes.length === 0, 'an event chat message pushes no notification, as for the enterprise thread');
    const sent = broadcasts.find(b => b.event?.threadType === 'event_thread');
    assert(!!sent && Array.isArray(sent.recipients) && sent.recipients.includes(goer) && sent.recipients.includes(host) && !sent.recipients.includes(maybe),
        'the live update goes to the people in the chat only');
    assertThrows(() => postEventThreadMessage(cb, ev.id, maybe, 'hi'), /Only the host and people going/, 'Interested cannot post');
    assertThrows(() => postEventThreadMessage(cb, ev.id, stranger, 'hi'), /Only the host and people going/, 'a member with no RSVP cannot post');
    assertThrows(() => postEventThreadMessage(cb, ev.id, goer, '   '), /cannot be empty/, 'an empty message is refused');
    assertThrows(() => postEventThreadMessage(cb, ev.id, goer, 'x'.repeat(EVENT_THREAD_MESSAGE_MAX + 1)), /too long/, 'a message over 2000 characters is refused');
    assert(!!postEventThreadMessage(cb, ev.id, goer, 'x'.repeat(EVENT_THREAD_MESSAGE_MAX)), 'exactly 2000 characters is allowed');
    rsvpEvent(capture, ev.id, frozen, 'going');
    assertThrows(() => postEventThreadMessage(cb, ev.id, frozen, 'hi'), /Frozen members cannot post/, 'a credit-frozen member cannot post');
    const clientId = crypto.randomUUID();
    const first = postEventThreadMessage(cb, ev.id, goer, 'See you there', clientId);
    const again = postEventThreadMessage(cb, ev.id, goer, 'See you there', clientId);
    assert(first.id === clientId && again.id === clientId, 'a retried send with the same clientId returns the same message');
    assert((db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(clientId) as any).c === 1, 'and stores it once');
    assertThrows(() => postEventThreadMessage(cb, ev.id, host, 'mine now', clientId), /already exists/, "another member cannot claim someone else's clientId");
    // The keeper host was never Going: speaking in the chat is what puts them in the Talk list.
    postEventThreadMessage(cb, entEv.id, keeper, 'Bring a broom');
    assert(isParticipant(entEv.id, keeper), 'a host who posts is a participant, so the chat reaches their Talk list');

    // ── 5. Host removal ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Host removal ---');
    assertThrows(() => removeEventThreadMessage(cb, ev.id, msg.id, goer), /Only the host can remove/, 'an attendee cannot remove a message');
    assertThrows(() => removeEventThreadMessage(cb, ev.id, msg.id, stranger), /Only the host can remove/, 'nor can a stranger');
    const removed = removeEventThreadMessage(cb, ev.id, msg.id, host);
    assert(removed.type === 'removed' && decode(removed.ciphertext) === 'removed by the host', 'the host removes a message and the text is replaced');
    const removedRow = db.prepare('SELECT type, metadata FROM messages WHERE id = ?').get(msg.id) as any;
    assert(removedRow.type === 'removed' && JSON.parse(removedRow.metadata).removedBy === host, 'the row records who removed it and when');
    const readBack = getEventThread(ev.id, goer).messages.find(m => m.id === msg.id)!;
    assert(decode(readBack.ciphertext) === 'removed by the host', 'and the removed text is what every other reader gets back');
    assertThrows(() => removeEventThreadMessage(cb, ev.id, 'no-such-message', host), /Message not found/, 'removing a message that is not in this chat is refused');
    assert(!!removeEventThreadMessage(cb, entEv.id, postEventThreadMessage(cb, entEv.id, keeper, 'oops').id, keeper),
        'a keeper is the host of an enterprise event chat for removal too');

    // ── 6. Read-only at the end and on cancel ────────────────────────────────────────────────
    console.log('\n--- 6. Read-only ---');
    const endedEv = newEvent(host, { eventStartAt: inHours(20) });
    rsvpEvent(capture, endedEv.id, goer, 'going');
    postEventThreadMessage(cb, endedEv.id, goer, 'before the end');
    endEvent(endedEv.id);
    const endedView = getEventThread(endedEv.id, goer);
    assert(endedView.readOnly && !endedView.canPost, 'an ended event chat is read-only');
    assert(endedView.readOnlyReason === 'This event has ended. The chat is read-only.', 'and says so in one line');
    assert(endedView.messages.length === 1, 'the messages are still readable after the end');
    assertThrows(() => postEventThreadMessage(cb, endedEv.id, goer, 'after'), /has ended/, 'posting to an ended event chat is refused');
    assertThrows(() => postEventThreadMessage(cb, endedEv.id, host, 'after'), /has ended/, 'including by the host');

    const cancelledEv = newEvent(host, { eventStartAt: inHours(21) });
    rsvpEvent(capture, cancelledEv.id, goer, 'going');
    removePost(capture, cancelledEv.id, host);
    const cancelledView = getEventThread(cancelledEv.id, goer);
    assert(cancelledView.readOnly && cancelledView.eventState === 'cancelled', 'a cancelled event chat is read-only');
    assert(cancelledView.readOnlyReason === 'This event was cancelled. The chat is read-only.', 'and says the event was cancelled');
    assertThrows(() => postEventThreadMessage(cb, cancelledEv.id, goer, 'still on?'), /cancelled/, 'posting to a cancelled event chat is refused');

    // ── 7. Gone 30 days after the end ────────────────────────────────────────────────────────
    console.log('\n--- 7. The 30-day window ---');
    const oldEv = newEvent(host, { eventStartAt: inHours(22) });
    rsvpEvent(capture, oldEv.id, goer, 'going');
    endEvent(oldEv.id, 29 * DAY);
    assert(!!getEventThread(oldEv.id, goer), 'an event that ended 29 days ago still opens');
    endEvent(oldEv.id, 31 * DAY);
    assertThrows(() => getEventThread(oldEv.id, goer), /no longer available/, 'an event that ended 31 days ago does not');
    assertThrows(() => getEventThread(oldEv.id, host), /no longer available/, 'not even for the host');
    assertThrows(() => postEventThreadMessage(cb, oldEv.id, goer, 'hello?'), /no longer available/, 'and nobody can post to it');

    // ── 8. The routes ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Routes ---');
    let ctx: any = await dispatch(market, 'GET', `/api/marketplace/posts/${ev.id}/chat`, routeCtx(ev.id, undefined));
    assert(ctx.status === 401, 'the chat read requires authentication');
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${ev.id}/chat`, routeCtx(ev.id, stranger));
    assert(ctx.status === 403, 'the chat read refuses a member who is not going');
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${ev.id}/chat`, routeCtx(ev.id, goer));
    assert(ctx.body?.messages?.length > 0 && ctx.body.privateNote === 'Gate code 1234', 'the chat read serves messages and the note to someone going');
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${crypto.randomUUID()}/chat`, routeCtx(crypto.randomUUID(), goer));
    assert(ctx.status === 404, 'the chat read of an unknown id is a 404');
    ctx = await dispatch(market, 'GET', `/api/marketplace/posts/${oldEv.id}/chat`, routeCtx(oldEv.id, goer));
    assert(ctx.status === 410, 'the chat read of a scrubbed event is a 410');

    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, undefined, { text: 'hi' }));
    assert(ctx.status === 401, 'posting requires authentication');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, maybe, { text: 'hi' }));
    assert(ctx.status === 403, 'posting refuses someone who is only Interested');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, goer, { text: '  ' }));
    assert(ctx.status === 400, 'posting refuses an empty message');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, goer, { text: 'hi', clientId: 'not-a-uuid' }));
    assert(ctx.status === 400, 'posting refuses a clientId that is not a UUID v4');
    const routeClientId = crypto.randomUUID();
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, goer, { text: 'From the route', clientId: routeClientId }));
    assert(ctx.status === 201 && decode(ctx.body.message.ciphertext) === 'From the route', 'posting through the route stores the message');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/message`, routeCtx(ev.id, host, { text: 'mine', clientId: routeClientId }));
    assert(ctx.status === 409, "reusing another member's clientId is a 409");
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${endedEv.id}/chat/message`, routeCtx(endedEv.id, goer, { text: 'late' }));
    assert(ctx.status === 400, 'posting to an ended event chat is a 400');

    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/remove`, routeCtx(ev.id, goer, { messageId: routeClientId }));
    assert(ctx.status === 403, 'removal refuses anyone but the host');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/remove`, routeCtx(ev.id, host, {}));
    assert(ctx.status === 400, 'removal needs a messageId');
    ctx = await dispatch(market, 'POST', `/api/marketplace/posts/${ev.id}/chat/remove`, routeCtx(ev.id, host, { messageId: routeClientId }));
    assert(ctx.body?.success === true && ctx.body.message.type === 'removed', 'the host removes a message through the route');

    // ── 9. The generic messaging routes ──────────────────────────────────────────────────────
    console.log('\n--- 9. Generic messaging paths ---');
    assertThrows(() => sendMessage(cb, ev.id, goer, Buffer.from('side door').toString('base64'), 'plaintext-v1'),
        /through the event/, 'the generic send route cannot write an event chat');
    assertThrows(() => editMessage(cb, first.id, goer, Buffer.from('edited').toString('base64'), 'plaintext-v1'),
        /cannot be edited/, 'an event chat message cannot be edited');
    assertThrows(() => toggleMessageReaction(cb, first.id, goer, '👍'), /Reactions are not part/, 'an event chat takes no reactions');

    const msgCtx = (convId: string, actor: string | undefined): any => ({
        params: { conversationId: convId }, state: actor ? { actor } : {}, query: {},
        get: () => '', set: () => { }, headers: {},
    });
    ctx = await dispatch(messaging, 'GET', `/api/messages/${ev.id}`, msgCtx(ev.id, goer));
    assert(Array.isArray(ctx.body?.messages), 'someone going reads the chat through the generic message route too');
    assert(!JSON.stringify(ctx.body).includes('Gate code 1234'), 'and the generic route never carries the private note');
    ctx = await dispatch(messaging, 'GET', `/api/messages/${ev.id}`, msgCtx(ev.id, stranger));
    assert(ctx.status === 403, 'a member with no RSVP is refused by the generic message route');
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(ev.id, maybe);
    ctx = await dispatch(messaging, 'GET', `/api/messages/${ev.id}`, msgCtx(ev.id, maybe));
    assert(ctx.status === 403, 'and a stale participant row does not get past it either');
    db.prepare('DELETE FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').run(ev.id, maybe);

    // ── 10. The Talk list ────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. The Talk list ---');
    const convs = getConversationsByMember(goer);
    const listed = convs.find((c: any) => c.id === ev.id);
    assert(!!listed && listed.type === 'event_thread' && listed.name === 'Working bee',
        "the chat is in the attendee's Talk list under the event's title");
    postEventThreadMessage(cb, ev.id, host, 'See you all there');
    const unread = getUnreadCounts(goer);
    assert((unread[ev.id] || 0) > 0, 'with an unread count');
    markConversationRead(goer, ev.id);
    assert((getUnreadCounts(goer)[ev.id] || 0) === 0, 'which clears when they read it');
    rsvpEvent(capture, ev.id, goer, null);
    assert(!getConversationsByMember(goer).some((c: any) => c.id === ev.id), 'and it leaves the Talk list when they stop going');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
