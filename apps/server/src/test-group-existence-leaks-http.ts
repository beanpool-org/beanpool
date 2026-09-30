/**
 * Nothing tells someone outside an invite-only group that it, or anything in it, exists — over real HTTP, through the
 * signature middleware (pre-launch small leaks, 2026-09-30).
 *
 * #970 and #983 closed the group's own routes, its slug, and request/accept on its posts (test-group-existence-leaks
 * calls the routers directly). Measured over HTTP on main before this, the siblings still answered a caller who can't
 * see a group's post (engine/post-sight.ts: getPosts' rule) differently from an id nobody has:
 *   - a poll's vote: "UNAUTHORIZED: Must be an active convenor or member of the group to vote in this poll";
 *   - an event's RSVP: "UNAUTHORIZED: Must be an active convenor or member of the group to RSVP to this event";
 *   - a poll's close: "Only the author can close a poll";
 *   - the event's chat (read, post, remove): 403 "Only the host and people going…", where an unknown id is 404;
 *   - GET /api/messages/:eventId, mark-read and mute on the event's chat: 403 "not a participant", not 404;
 *   - taking the post down: 403 "Not authorized to act on behalf of this identity", not 404 "Post not found";
 *   - a direct post not addressed to the caller, on request and accept: "This direct post is not addressed to you";
 *   - a visitor's row sending to the group's chat (its id is the group's): the gate's 403 not_a_member, where an id
 *     nobody has got through the gate to the engine's 400 "Member not found".
 *
 * 1. The sweep: an outsider (a member of this node in no group), a member of another group, a removed member and a
 *    visitor's row each get, from every route that takes the hidden group's id or slug, one of its posts' ids or its
 *    chat's id, exactly the answer (status and body) an id nobody has gets. So does an invitee from every route that
 *    takes one of its posts' ids (an invitee may see the group's card: that is the invite's landing).
 * 2. Nothing those callers were refused was written.
 * 3. Controls: the group's members get what they got before — a member votes, RSVPs, reads and mutes the event's
 *    chat; an observer, who sees the posts, still hears why it may not vote or RSVP; a member who isn't going is told
 *    the chat is for the host and people going; only the author closes a poll; the target of a direct post trades on
 *    it; a public post is still someone else's to take down; and a visitor still writes in its own direct conversation,
 *    under an old id of it too.
 * 4. The time POST /api/messages/send takes, with 50k chat lines: the same for the hidden group's chat id, its event's
 *    chat id and someone else's old DM id as for an id nobody has.
 * 5. Out of the group while Going (the director, 2026-09-30, from #1333's review): a member removed by a convenor, and one
 *    who left, each answered as an outsider is (and as for an id nobody has) by the event's chat, its private note, the
 *    chat's write routes, react, edit and delete on a real line of it, the reminder and the RSVP; the event is gone from their "Your events", their chat list, the
 *    chat's live lines, reminders and change pushes. Their RSVP stays recorded, and a member invited back is Going
 *    again. An account the community closed is refused every request, a real id's as an unknown one's. A member still
 *    in the group reads the chat and its note, and gets all of it.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-group-existence-leaks-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'GroupLeaksHttp123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, createPost, createGroup, joinGroup, inviteGroupMember, removeGroupMember, seedGenesisMember,
    rsvpEvent, createConversation, sendMessage, adminPruneUser,
} from './state-engine.js';
import { postEventThreadMessage } from './engine/event-thread.js';
import { dueEventReminders } from './engine/event-reminders.js';
import { eventGoingPubkeys } from './engine/posts.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { lockedDm } from './dm-test-payload.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Id = { pk: string; key: crypto.KeyObject; name: string };
type Res = { status: number; text: string; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), key: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(id.pk, name, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    transfer('genesis', id.pk, 100, `seed ${name}`, 'direct', true);
    // An offer on the books, so the covenant is never what refuses a trade below.
    createPost('offer', 'other', `${name}'s offer`, 'on the books', 5, 'fixed', id.pk);
    return id;
}

async function call(method: string, path: string, id: Id | null, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.key).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: json };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 160)}`;

async function main(): Promise<void> {
    console.log("Nothing tells someone outside an invite-only group that it, or anything in it, exists (over HTTP)\n");
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const founder = keypair('FounderGL');
    seedGenesisMember(founder.pk, founder.name);
    const convenor = makeMember('ConvenorGL');
    const member = makeMember('MemberGL');
    const observer = makeMember('ObserverGL');
    const bystander = makeMember('BystanderGL');   // a member of the group who isn't going to its event
    const outsider = makeMember('OutsiderGL');
    const otherGroupie = makeMember('OtherGroupieGL');
    const removed = makeMember('RemovedGL');
    const invitee = makeMember('InviteeGL');
    const pollster = makeMember('PollsterGL');

    // The hidden group, and everyone's place in it.
    const hidden = createGroup({ name: 'Quiet Circle GL', description: 'Nobody outside knows', joinPolicy: 'invite_only', createdBy: convenor.pk } as any);
    for (const [who, role] of [[member, 'member'], [observer, 'observer'], [bystander, 'member'], [removed, 'member']] as const) {
        inviteGroupMember(hidden.id, convenor.pk, who.pk, role);
        joinGroup(hidden.id, who.pk);
    }
    removeGroupMember(hidden.id, convenor.pk, removed.pk);
    inviteGroupMember(hidden.id, convenor.pk, invitee.pk, 'member');
    // Another group, open, that the other groupie leads.
    createGroup({ name: 'Open Garden GL', joinPolicy: 'open', createdBy: otherGroupie.pk } as any);

    // The hidden group's posts: an offer, an event with the member going, two polls; and a direct offer and poll to the member.
    const inGroup = { audienceScope: 'group', targetGroupId: hidden.id } as any;
    const offer = createPost('offer', 'other', 'Circle offer', 'for the circle', 5, 'fixed', convenor.pk, undefined, undefined, [], false, undefined, false, inGroup)!;
    const event = createPost('event', 'community', 'Circle meet', 'in the hall', 0, 'fixed', convenor.pk, -28.55, 153.5, [], false, undefined, false,
        { ...inGroup, eventStartAt: inHours(24), eventPlaceName: 'The hall' })!;
    rsvpEvent(event.id, member.pk, 'going');
    const poll = createPost('poll', 'community', 'Circle poll', '', 0, 'fixed', convenor.pk, undefined, undefined, [], false, undefined, false,
        { ...inGroup, pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] })!;
    // One active poll per author: the second is the bystander's, the direct one the pollster's.
    const poll2 = createPost('poll', 'community', 'Circle poll two', '', 0, 'fixed', bystander.pk, undefined, undefined, [], false, undefined, false,
        { ...inGroup, pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] })!;
    const direct = createPost('offer', 'other', 'Just for Member', 'for you', 5, 'fixed', convenor.pk, undefined, undefined, [], false, undefined, false,
        { audienceScope: 'direct', targetPubkey: member.pk } as any)!;
    const directPoll = createPost('poll', 'community', 'Just for Member, a poll', '', 0, 'fixed', pollster.pk, undefined, undefined, [], false, undefined, false,
        { audienceScope: 'direct', targetPubkey: member.pk, pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] } as any)!;
    const publicOffer = createPost('offer', 'other', 'Everyone can see this', 'public', 5, 'fixed', convenor.pk)!;
    const publicEvent = createPost('event', 'community', 'Open day', 'everyone', 0, 'fixed', convenor.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(30), eventPlaceName: 'The park' } as any)!;
    const chatLine = (db.prepare('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1').get(hidden.id) as any)?.id ?? crypto.randomUUID();
    assert(!!offer && !!event && !!poll && !!poll2 && !!direct && !!directPoll && !!publicOffer && !!publicEvent,
        'setup: the hidden group has an offer, an event, two polls; a direct offer and poll; a public offer and event');

    // A visitor's row: a member writes to it, which is how one comes to be; one of its lines names an old id of the DM.
    const vera = keypair('VeraGL');
    const veraDm = createConversation('dm', [member.pk, vera.pk], member.pk)!;
    const oldDmId = crypto.randomUUID();
    const first = lockedDm();
    sendMessage(veraDm.id, member.pk, first.ciphertext, first.nonce, 'text', undefined, JSON.stringify({ originalConversationId: oldDmId }));
    // Someone else's DM, also folded from an old id.
    const otherDm = createConversation('dm', [member.pk, outsider.pk], member.pk)!;
    const othersOldId = crypto.randomUUID();
    const second = lockedDm();
    sendMessage(otherDm.id, member.pk, second.ciphertext, second.nonce, 'text', undefined, JSON.stringify({ originalConversationId: othersOldId }));
    assert((db.prepare('SELECT is_visitor FROM members WHERE public_key = ?').get(vera.pk) as any)?.is_visitor === 1,
        "setup: Vera's row is a visitor's, made by the member's DM");

    // --- 1. The sweep ---
    const real = {
        G: hidden.id, S: hidden.slug, P: offer.id, E: event.id, Q: poll.id, D: direct.id, DQ: directPoll.id,
        OLD: othersOldId,
    };
    const ghost = {
        G: crypto.randomUUID(), S: `quiet-nothing-gl-${crypto.randomBytes(3).toString('hex')}`, P: crypto.randomUUID(),
        E: crypto.randomUUID(), Q: crypto.randomUUID(), D: crypto.randomUUID(), DQ: crypto.randomUUID(), OLD: crypto.randomUUID(),
    };
    type Ids = typeof real;
    const fill = (s: string, ids: Ids, me: Id) => s
        .replace(/\{G\}/g, ids.G).replace(/\{S\}/g, ids.S).replace(/\{P\}/g, ids.P).replace(/\{E\}/g, ids.E)
        .replace(/\{DQ\}/g, ids.DQ).replace(/\{Q\}/g, ids.Q).replace(/\{D\}/g, ids.D).replace(/\{OLD\}/g, ids.OLD)
        .replace(/\{K\}/g, convenor.pk).replace(/\{ME\}/g, me.pk).replace(/\{LINE\}/g, chatLine);
    const fillBody = (b: unknown, ids: Ids, me: Id) => b === undefined ? undefined : JSON.parse(fill(JSON.stringify(b), ids, me));
    /** The answer with each id put back as its name, so an answer that echoes the id it was asked about compares equal. */
    const norm = (r: Res, ids: Ids) => {
        let t = r.text;
        for (const k of Object.keys(ids) as (keyof Ids)[]) t = t.split(ids[k]).join(`<${k}>`);
        return `${r.status} ${t}`;
    };

    const GROUP_ROUTES: [string, string, unknown?][] = [
        ['GET', '/api/groups/{G}'],
        ['GET', '/api/groups/{S}'],
        ['POST', '/api/groups/{G}/join', {}],
        ['GET', '/api/groups/{G}/members'],
        ['POST', '/api/groups/{G}/members', { targetPubkey: '{ME}' }],
        ['POST', '/api/groups/{G}/members', { targetPubkey: '{ME}', action: 'approve' }],
        ['PATCH', '/api/groups/{G}/members/{K}', { role: 'member' }],
        ['DELETE', '/api/groups/{G}/members/{ME}'],
        ['POST', '/api/groups/{G}/lead', { targetPubkey: '{ME}' }],
        ['PATCH', '/api/groups/{G}', { description: 'mine now' }],
        ['PATCH', '/api/groups/{G}', { joinPolicy: 'open' }],
        ['GET', '/api/groups/{G}/chat'],
        ['POST', '/api/groups/{G}/chat/message', { text: 'hello?' }],
        ['POST', '/api/groups/{G}/chat/remove', { messageId: '{LINE}' }],
        ['GET', '/api/groups/{G}/succession'],
        ['POST', '/api/groups/{G}/succession/propose', { candidatePubkey: '{ME}' }],
        ['POST', `/api/groups/{G}/succession/${crypto.randomUUID()}/vote`, { choice: 'yes' }],
        ['DELETE', '/api/groups/{G}/posts/{P}'],
        // The group's chat is a conversation whose id is the group's.
        ['GET', '/api/messages/{G}'],
        ['POST', '/api/messages/send', { conversationId: '{G}', authorPubkey: '{ME}', ...lockedDm() }],
        ['POST', '/api/messages/mark-read', { conversationId: '{G}' }],
        ['POST', '/api/messages/mute', { conversationId: '{G}', duration: '8h' }],
        // Posting into it.
        ['POST', '/api/marketplace/posts', { type: 'offer', category: 'other', title: 'Into the circle', description: 'x', credits: 5,
            priceType: 'fixed', authorPublicKey: '{ME}', audienceScope: 'group', targetGroupId: '{G}' }],
        ['GET', '/api/marketplace/posts?targetGroupId={G}'],
    ];
    const POST_ROUTES: [string, string, unknown?][] = [
        ['GET', '/api/marketplace/posts?id={P}'],
        ['GET', '/api/marketplace/posts?id={E}'],
        ['POST', '/api/marketplace/posts/request', { postId: '{P}', buyerPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/accept', { postId: '{P}', buyerPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/remove', { id: '{P}', authorPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/remove', { id: '{E}', authorPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/update', { id: '{P}', authorPublicKey: '{ME}', title: 'mine now' }],
        ['POST', '/api/marketplace/posts/pause', { postId: '{P}', authorPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/resume', { postId: '{P}', authorPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/{Q}/vote', { optionId: 'a' }],
        ['POST', '/api/marketplace/polls/vote', { postId: '{Q}', optionId: 'a' }],
        ['POST', '/api/marketplace/posts/{Q}/close', {}],
        ['POST', '/api/marketplace/polls/close', { postId: '{Q}' }],
        ['POST', '/api/marketplace/posts/{E}/rsvp', { status: 'going' }],
        ['POST', '/api/marketplace/posts/{E}/rsvp', { status: null }],
        ['PUT', '/api/events/{E}/reminder', { offsets: [60] }],
        ['GET', '/api/marketplace/posts/{E}/chat'],
        ['POST', '/api/marketplace/posts/{E}/chat/message', { text: 'hello?' }],
        ['POST', '/api/marketplace/posts/{E}/chat/remove', { messageId: crypto.randomUUID() }],
        // The event's chat is a conversation whose id is the event's.
        ['GET', '/api/messages/{E}'],
        ['POST', '/api/messages/send', { conversationId: '{E}', authorPubkey: '{ME}', ...lockedDm() }],
        ['POST', '/api/messages/mark-read', { conversationId: '{E}' }],
        ['POST', '/api/messages/mute', { conversationId: '{E}', duration: '8h' }],
        // A direct post and poll to someone else.
        ['POST', '/api/marketplace/posts/request', { postId: '{D}', buyerPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/accept', { postId: '{D}', buyerPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/remove', { id: '{D}', authorPublicKey: '{ME}' }],
        ['POST', '/api/marketplace/posts/{DQ}/vote', { optionId: 'a' }],
        ['POST', '/api/marketplace/posts/{DQ}/close', {}],
    ];
    // Someone else's DM under an old id: a visitor's row is refused it as it is refused an id nobody has.
    const VISITOR_ROUTES: [string, string, unknown?][] = [
        ['POST', '/api/messages/send', { conversationId: '{OLD}', authorPubkey: '{ME}', ...lockedDm() }],
    ];

    const writesBefore = {
        rsvps: (db.prepare('SELECT COUNT(*) AS c FROM event_rsvps WHERE post_id = ?').get(event.id) as any).c,
        votes: (db.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE post_id IN (?, ?)').get(poll.id, directPoll.id) as any).c,
        trades: (db.prepare('SELECT COUNT(*) AS c FROM marketplace_transactions WHERE post_id IN (?, ?)').get(offer.id, direct.id) as any).c,
        groupLines: (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (?, ?)').get(hidden.id, event.id) as any).c,
        members: (db.prepare("SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND status != 'removed'").get(hidden.id) as any).c,
        posts: (db.prepare("SELECT COUNT(*) AS c FROM posts WHERE target_group_id = ?").get(hidden.id) as any).c,
        pollOpen: (db.prepare("SELECT status FROM posts WHERE id = ?").get(poll.id) as any).status,
    };

    const vera_: Id = vera;
    const sweeps: [string, Id, [string, string, unknown?][]][] = [
        ['an outsider', outsider, [...GROUP_ROUTES, ...POST_ROUTES]],
        ['a member of another group', otherGroupie, [...GROUP_ROUTES, ...POST_ROUTES]],
        ['a removed member', removed, [...GROUP_ROUTES, ...POST_ROUTES]],
        // An invitee may open the group's card (the invite's landing), so only its posts are swept for them.
        ['an invitee', invitee, POST_ROUTES],
        ["a visitor's row", vera_, [...GROUP_ROUTES, ...POST_ROUTES, ...VISITOR_ROUTES]],
    ];
    for (const [who, id, routes] of sweeps) {
        const differ: string[] = [];
        for (const [method, path, body] of routes) {
            const a = await call(method, fill(path, real, id), id, fillBody(body, real, id));
            const b = await call(method, fill(path, ghost, id), id, fillBody(body, ghost, id));
            if (norm(a, real) !== norm(b, ghost)) differ.push(`${method} ${path}: ${show(a)}  |  an id nobody has: ${show(b)}`);
        }
        assert(differ.length === 0,
            `${who}: every route (${routes.length}) answers the hidden group, its posts and its chat exactly as an id nobody has`
            + (differ.length ? `; ${differ.length} did not:\n    ${differ.join('\n    ')}` : ''));
    }

    // Each fix on its own, so a failure names the route.
    {
        const vote = await call('POST', `/api/marketplace/posts/${poll.id}/vote`, outsider, { optionId: 'a' });
        assert(vote.status === 400 && vote.body?.error === 'Poll not found', `vote: an outsider hears "Poll not found" (${show(vote)})`);
        const rsvp = await call('POST', `/api/marketplace/posts/${event.id}/rsvp`, otherGroupie, { status: 'going' });
        assert(rsvp.status === 400 && rsvp.body?.error === 'Event not found', `RSVP: a member of another group hears "Event not found" (${show(rsvp)})`);
        const close = await call('POST', `/api/marketplace/posts/${poll.id}/close`, removed, {});
        assert(close.status === 400 && close.body?.error === 'Poll not found', `close: a removed member hears "Poll not found" (${show(close)})`);
        const chat = await call('GET', `/api/marketplace/posts/${event.id}/chat`, invitee);
        assert(chat.status === 404 && chat.body?.error === 'Event not found', `event chat: an invitee hears 404 "Event not found" (${show(chat)})`);
        const conv = await call('GET', `/api/messages/${event.id}`, outsider);
        assert(conv.status === 404 && conv.body?.error === 'Conversation not found', `GET /api/messages/:eventId: an outsider hears 404 (${show(conv)})`);
        const take = await call('POST', '/api/marketplace/posts/remove', outsider, { id: offer.id, authorPublicKey: outsider.pk });
        assert(take.status === 404 && take.body?.error === 'Post not found', `remove: an outsider hears 404 "Post not found" (${show(take)})`);
        const req = await call('POST', '/api/marketplace/posts/request', outsider, { postId: direct.id, buyerPublicKey: outsider.pk });
        assert(req.status === 400 && req.body?.error === 'Post not found', `request: someone a direct post isn't for hears "Post not found" (${show(req)})`);
        const send = await call('POST', '/api/messages/send', vera, { conversationId: hidden.id, authorPubkey: vera.pk, ...lockedDm() });
        const sendGhost = await call('POST', '/api/messages/send', vera, { conversationId: crypto.randomUUID(), authorPubkey: vera.pk, ...lockedDm() });
        assert(send.status === 403 && send.body?.code === 'not_a_member' && send.text === sendGhost.text && sendGhost.status === 403,
            `send: a visitor's row hears the gate's not_a_member for the group's chat and for an id nobody has (${show(send)} | ${show(sendGhost)})`);
    }

    // --- 2. Nothing the sweep was refused was written ---
    {
        const after = {
            rsvps: (db.prepare('SELECT COUNT(*) AS c FROM event_rsvps WHERE post_id = ?').get(event.id) as any).c,
            votes: (db.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE post_id IN (?, ?)').get(poll.id, directPoll.id) as any).c,
            trades: (db.prepare('SELECT COUNT(*) AS c FROM marketplace_transactions WHERE post_id IN (?, ?)').get(offer.id, direct.id) as any).c,
            groupLines: (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (?, ?)').get(hidden.id, event.id) as any).c,
            members: (db.prepare("SELECT COUNT(*) AS c FROM group_members WHERE group_id = ? AND status != 'removed'").get(hidden.id) as any).c,
            posts: (db.prepare("SELECT COUNT(*) AS c FROM posts WHERE target_group_id = ?").get(hidden.id) as any).c,
            pollOpen: (db.prepare("SELECT status FROM posts WHERE id = ?").get(poll.id) as any).status,
        };
        assert(JSON.stringify(after) === JSON.stringify(writesBefore),
            `nothing refused was written: RSVPs, votes, trades, chat lines, the group's rows and posts, the poll still open (${JSON.stringify(writesBefore)} → ${JSON.stringify(after)})`);
    }

    // --- 3. Controls: the group's own people, and everyone else's own things ---
    {
        const vote = await call('POST', `/api/marketplace/posts/${poll.id}/vote`, member, { optionId: 'a' });
        assert(vote.status === 200 && vote.body?.success === true, `a member votes in the group's poll (${show(vote)})`);
        const obsVote = await call('POST', `/api/marketplace/posts/${poll.id}/vote`, observer, { optionId: 'a' });
        assert(obsVote.status === 400 && obsVote.body?.error === 'UNAUTHORIZED: Must be an active convenor or member of the group to vote in this poll',
            `an observer, who sees the poll, is still told why it may not vote (${show(obsVote)})`);
        const obsRsvp = await call('POST', `/api/marketplace/posts/${event.id}/rsvp`, observer, { status: 'going' });
        assert(obsRsvp.status === 400 && obsRsvp.body?.error === 'UNAUTHORIZED: Must be an active convenor or member of the group to RSVP to this event',
            `an observer is still told why it may not RSVP (${show(obsRsvp)})`);
        const rsvp = await call('POST', `/api/marketplace/posts/${event.id}/rsvp`, bystander, { status: 'interested' });
        assert(rsvp.status === 200 && rsvp.body?.success === true, `a member RSVPs to the group's event (${show(rsvp)})`);
        const notGoing = await call('GET', `/api/marketplace/posts/${event.id}/chat`, bystander);
        assert(notGoing.status === 403 && notGoing.body?.error === 'Only the host and people going can open this event chat',
            `a member who isn't going is told the chat is for the host and people going (${show(notGoing)})`);
        const notGoingConv = await call('GET', `/api/messages/${event.id}`, bystander);
        assert(notGoingConv.status === 403, `and GET /api/messages/:eventId still refuses them 403, not 404 (${show(notGoingConv)})`);
        const going = await call('GET', `/api/marketplace/posts/${event.id}/chat`, member);
        assert(going.status === 200 && going.body?.title === 'Circle meet', `a member going reads the event's chat (${show(going)})`);
        const line = await call('POST', `/api/marketplace/posts/${event.id}/chat/message`, member, { text: 'See you there' });
        assert(line.status === 201 || line.status === 200, `and writes in it (${show(line)})`);
        const conv = await call('GET', `/api/messages/${event.id}`, member);
        assert(conv.status === 200 && Array.isArray(conv.body?.messages), `and reads it as a conversation (${show(conv)})`);
        const read = await call('POST', '/api/messages/mark-read', member, { conversationId: event.id });
        assert(read.status === 200 && read.body?.success === true, `and marks it read (${show(read)})`);
        const mute = await call('POST', '/api/messages/mute', member, { conversationId: event.id, duration: '8h' });
        assert(mute.status === 200 && mute.body?.success === true, `and mutes it (${show(mute)})`);
        const hostRemoves = await call('POST', `/api/marketplace/posts/${event.id}/chat/remove`, convenor, { messageId: line.body?.message?.id });
        assert(hostRemoves.status === 200, `the host removes a line from it (${show(hostRemoves)})`);
        const memberRemoves = await call('POST', `/api/marketplace/posts/${event.id}/chat/remove`, bystander, { messageId: line.body?.message?.id });
        assert(memberRemoves.status === 403 && memberRemoves.body?.error === 'Only the host can remove messages from this event chat',
            `a member who isn't the host is told only the host removes lines (${show(memberRemoves)})`);
        const memberCloses = await call('POST', `/api/marketplace/posts/${poll2.id}/close`, member, {});
        assert(memberCloses.status === 400 && memberCloses.body?.error === 'Only the author can close a poll',
            `a member closing the group's poll is told only its author can (${show(memberCloses)})`);
        const authorCloses = await call('POST', `/api/marketplace/posts/${poll2.id}/close`, bystander, {});
        assert(authorCloses.status === 200 && authorCloses.body?.success === true, `its author closes it (${show(authorCloses)})`);
        const memberTakes = await call('POST', '/api/marketplace/posts/remove', member, { id: offer.id, authorPublicKey: member.pk });
        assert(memberTakes.status === 403 && memberTakes.body?.error === 'Not authorized to act on behalf of this identity',
            `a member who can see the group's offer is told it isn't theirs to take down (${show(memberTakes)})`);
        const publicTake = await call('POST', '/api/marketplace/posts/remove', outsider, { id: publicOffer.id, authorPublicKey: outsider.pk });
        assert(publicTake.status === 403 && publicTake.body?.error === 'Not authorized to act on behalf of this identity',
            `a public offer is still someone else's to an outsider (${show(publicTake)})`);
        const publicChat = await call('GET', `/api/marketplace/posts/${publicEvent.id}/chat`, outsider);
        assert(publicChat.status === 403 && publicChat.body?.error === 'Only the host and people going can open this event chat',
            `a public event's chat still tells an outsider who it is for (${show(publicChat)})`);
        const directReq = await call('POST', '/api/marketplace/posts/request', member, { postId: direct.id, buyerPublicKey: member.pk });
        assert(directReq.status === 200 && directReq.body?.success === true, `the member a direct offer is for requests it (${show(directReq)})`);
        const directVote = await call('POST', `/api/marketplace/posts/${directPoll.id}/vote`, member, { optionId: 'b' });
        assert(directVote.status === 200 && directVote.body?.success === true, `and votes in the direct poll (${show(directVote)})`);
        const reqOwn = await call('POST', '/api/marketplace/posts/request', member, { postId: offer.id, buyerPublicKey: member.pk });
        assert(reqOwn.status === 200 && reqOwn.body?.success === true, `a member requests the group's offer (${show(reqOwn)})`);
    }

    // A visitor still writes in its own direct conversation, and under an old id of it (chat consolidation).
    {
        const reply = await call('POST', '/api/messages/send', vera, { conversationId: veraDm.id, authorPubkey: vera.pk, ...lockedDm() });
        assert(reply.status === 200 && reply.body?.success === true, `a visitor's row replies in its own DM (${show(reply)})`);
        const viaOld = await call('POST', '/api/messages/send', vera, { conversationId: oldDmId, authorPubkey: vera.pk, ...lockedDm() });
        assert(viaOld.status === 200 && viaOld.body?.message?.conversationId === veraDm.id,
            `and under an old id of it, which lands in the DM it became (${show(viaOld)})`);
    }

    // --- 5. Out of the group while Going: the RSVP stays, and gives nothing ---
    {
        const supper = createPost('event', 'community', 'Circle supper', 'at the hall', 0, 'fixed', convenor.pk, -28.55, 153.5, [], false, undefined, false,
            { ...inGroup, eventStartAt: inHours(24), eventPlaceName: 'The hall', eventPrivateNote: 'Gate 1234' })!;
        const stayer = makeMember('StayerGL');    // still in the group
        const ousted = makeMember('OustedGL');    // a convenor removes them: the row stays 'removed', so it sticks
        const leaver = makeMember('LeaverGL');    // leaves: the row goes
        const closed = makeMember('ClosedGL');    // the community closes their account (a prune)
        for (const who of [stayer, ousted, leaver, closed]) {
            inviteGroupMember(hidden.id, convenor.pk, who.pk, 'member');
            joinGroup(hidden.id, who.pk);
            rsvpEvent(supper.id, who.pk, 'going');
        }
        const readsNote = (r: Res) => r.status === 200 && r.body?.privateNote === 'Gate 1234';
        for (const who of [stayer, ousted, leaver, closed]) {
            const r = await call('GET', `/api/marketplace/posts/${supper.id}/chat`, who);
            const rem = await call('PUT', `/api/events/${supper.id}/reminder`, who, { offsets: [120] });
            assert(readsNote(r) && rem.status === 200, `setup: ${who.name}, Going as a member, reads the chat and its note and sets a reminder (${show(r)} | ${show(rem)})`);
        }
        const said = await call('POST', `/api/marketplace/posts/${supper.id}/chat/message`, stayer, { text: 'Bring a plate' });
        const lineId = said.body?.message?.id as string;
        assert(!!lineId, `setup: a line in the chat (${show(said)})`);
        // A line each of the two about to be out writes while Going: the one line id they hold that is surely real.
        const lineOf = new Map<string, string>();
        for (const who of [ousted, leaver]) {
            const own = await call('POST', `/api/marketplace/posts/${supper.id}/chat/message`, who, { text: `${who.name} is coming` });
            lineOf.set(who.pk, own.body?.message?.id);
            assert(!!own.body?.message?.id, `setup: ${who.name} writes a line while Going (${show(own)})`);
        }

        removeGroupMember(hidden.id, convenor.pk, ousted.pk);
        removeGroupMember(hidden.id, leaver.pk, leaver.pk);
        adminPruneUser(closed.pk, 'owner:password');
        const status = (pk: string) => (db.prepare('SELECT status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(hidden.id, pk) as any)?.status ?? null;
        assert(status(ousted.pk) === 'removed' && status(leaver.pk) === null && status(stayer.pk) === 'active',
            `setup: one removed (row kept), one left (row gone), one still in (${status(ousted.pk)}, ${status(leaver.pk)}, ${status(stayer.pk)})`);

        // What an RSVP hands out beyond the routes (before the routes below, whose refused writes must change nothing).
        const E = supper.id;
        const mine = async (who: Id) => ((await call('GET', '/api/events/mine', who)).body?.events ?? []).map((e: any) => e.postId) as string[];
        const chats = async (who: Id) => ((await call('GET', `/api/messages/conversations/${who.pk}`, who)).body?.conversations ?? []).map((c: any) => c.id) as string[];
        for (const who of [ousted, leaver]) {
            assert(!(await mine(who)).includes(E), `${who.name}: the event is gone from "Your events"`);
            assert(!(await chats(who)).includes(E), `${who.name}: and its chat from their chat list`);
        }
        assert((await mine(stayer)).includes(E) && (await chats(stayer)).includes(E), 'a member still in the group has it in "Your events" and the chat in their list');
        const going = eventGoingPubkeys(E);
        assert(going.includes(stayer.pk) && !going.includes(ousted.pk) && !going.includes(leaver.pk),
            `a change push for the event goes to the member still in, not to the two who are out (${going.length} Going)`);
        const due = dueEventReminders(Date.parse(supper.eventStartAt!) - 120 * 60_000 + 30_000).filter(d => d.postId === E).map(d => d.memberPubkey);
        assert(due.includes(stayer.pk) && !due.includes(ousted.pk) && !due.includes(leaver.pk),
            `the 2-hour reminder is due for the member still in, not for the two who are out (${due.length} due)`);
        let heard: string[] = [];
        postEventThreadMessage({ broadcast: (_e: any, r?: string[]) => { heard = r ?? []; }, dispatchPushNotification: () => {} }, E, stayer.pk, 'See you all');
        const seats = (db.prepare('SELECT public_key FROM conversation_participants WHERE conversation_id = ?').all(E) as any[]).map(r => r.public_key);
        assert(seats.includes(ousted.pk) && heard.includes(stayer.pk) && !heard.includes(ousted.pk) && !heard.includes(leaver.pk),
            `a new line goes live to the member still in, not to the two who are out, whose seats in the mirror are kept (${heard.length} hear it)`);

        const ghostE = crypto.randomUUID();
        const EVENT_ROUTES: [string, string, unknown?][] = [
            ['GET', '/api/marketplace/posts/{E}/chat'],
            ['POST', '/api/marketplace/posts/{E}/chat/message', { text: 'still here?' }],
            ['POST', '/api/marketplace/posts/{E}/chat/remove', { messageId: lineId }],
            ['GET', '/api/messages/{E}'],
            ['POST', '/api/messages/send', { conversationId: '{E}', authorPubkey: '{ME}', ...lockedDm() }],
            ['POST', '/api/messages/mark-read', { conversationId: '{E}' }],
            ['POST', '/api/messages/mute', { conversationId: '{E}', duration: '8h' }],
            ['PUT', '/api/events/{E}/reminder', { offsets: [60] }],
            ['POST', '/api/marketplace/posts/{E}/rsvp', { status: 'interested' }],
            ['POST', '/api/marketplace/posts/{E}/rsvp', { status: null }],
            ['GET', '/api/marketplace/posts?id={E}'],
            // A line of the chat, by its id (#1333 review): {L} is a line the member still in wrote, {WHO_L} the one the
            // member out of the group wrote while Going; for the unknown event, an id nobody has.
            ['POST', '/api/messages/react', { messageId: '{L}', authorPubkey: '{ME}', emoji: '👍' }],
            ['POST', '/api/messages/react', { messageId: '{WHO_L}', authorPubkey: '{ME}', emoji: '👍' }],
            ['POST', '/api/messages/edit', { messageId: '{L}', ciphertext: 'changed', nonce: 'plaintext-v1' }],
            ['POST', '/api/messages/edit', { messageId: '{WHO_L}', ciphertext: 'changed', nonce: 'plaintext-v1' }],
            ['POST', '/api/messages/delete', { messageId: '{L}' }],
            ['POST', '/api/messages/delete', { messageId: '{WHO_L}' }],
        ];
        const ghostLine = crypto.randomUUID();
        // `who` is the member out of the group whose line {WHO_L} names: an outsider tries the same line.
        const at = (path: string, e: string, me: Id, who: Id = me) => path.replace(/\{E\}/g, e).replace(/\{ME\}/g, me.pk)
            .replace(/\{L\}/g, e === E ? lineId : ghostLine).replace(/\{WHO_L\}/g, e === E ? (lineOf.get(who.pk) ?? lineId) : ghostLine);
        const bodyAt = (b: unknown, e: string, me: Id, who: Id = me) => b === undefined ? undefined : JSON.parse(at(JSON.stringify(b), e, me, who));
        const as = (r: Res, e: string, me: Id) => `${r.status} ${r.text.split(e).join('<E>').split(me.pk).join('<ME>')}`;
        for (const who of [ousted, leaver]) {
            const differ: string[] = [];
            for (const [method, path, body] of EVENT_ROUTES) {
                const mine = await call(method, at(path, E, who), who, bodyAt(body, E, who));
                const outsiders = await call(method, at(path, E, outsider, who), outsider, bodyAt(body, E, outsider, who));
                const nobodys = await call(method, at(path, ghostE, who), who, bodyAt(body, ghostE, who));
                if (as(mine, E, who) !== as(outsiders, E, outsider) || as(mine, E, who) !== as(nobodys, ghostE, who)) {
                    differ.push(`${method} ${path}: ${show(mine)}  |  an outsider: ${show(outsiders)}  |  an id nobody has: ${show(nobodys)}`);
                }
            }
            assert(differ.length === 0,
                `${who.name}, out of the group while Going: every event chat route (${EVENT_ROUTES.length}) answers as it answers an outsider and an id nobody has`
                + (differ.length ? `; ${differ.length} did not:\n    ${differ.join('\n    ')}` : ''));
        }
        {
            const differ: string[] = [];
            for (const [method, path, body] of EVENT_ROUTES) {
                const mine = await call(method, at(path, E, closed), closed, bodyAt(body, E, closed));
                const nobodys = await call(method, at(path, ghostE, closed), closed, bodyAt(body, ghostE, closed));
                if (mine.status !== 403 || mine.body?.code !== 'account_closed' || mine.text !== nobodys.text) differ.push(`${method} ${path}: ${show(mine)} | ${show(nobodys)}`);
            }
            assert(differ.length === 0, `a closed account is refused every event chat route, a real id's as an unknown one's (account_closed)`
                + (differ.length ? `:\n    ${differ.join('\n    ')}` : ''));
        }

        {
            const outs = [ousted.pk, leaver.pk];
            const lines = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND author_pubkey IN (?, ?)').get(E, ...outs) as any).c;
            const mutes = (db.prepare('SELECT COUNT(*) AS c FROM chat_mutes WHERE conversation_id = ? AND member_pubkey IN (?, ?)').get(E, ...outs) as any).c;
            const offsets = (db.prepare('SELECT reminder_offsets AS o FROM event_rsvps WHERE post_id = ? AND member_pubkey IN (?, ?)').all(E, ...outs) as any[]).map(r => r.o);
            // The lines react, edit and delete were tried on: as they were written, no reaction, no edit, not taken down.
            const touched = (db.prepare(`SELECT id, type, edited_at, metadata FROM messages WHERE id IN (?, ?, ?)`)
                .all(lineId, lineOf.get(ousted.pk), lineOf.get(leaver.pk)) as any[])
                .filter(m => m.type === 'removed' || m.edited_at || (m.metadata && /reactions/.test(m.metadata))).length;
            assert(lines === 2 && mutes === 0 && offsets.every(o => o === '[120]') && touched === 0,
                `nothing they were refused was written: only the line each wrote while Going, no mute, their reminders as they set them, `
                + `no line reacted to, edited or taken down (${lines}, ${mutes}, ${offsets.join(' ')}, ${touched})`);
        }
        // The RSVP stays recorded, and a member invited back is Going again without tapping it.
        const rsvp = (pk: string) => (db.prepare('SELECT status FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(E, pk) as any)?.status;
        assert(rsvp(ousted.pk) === 'going' && rsvp(leaver.pk) === 'going', `their RSVPs are still recorded (${rsvp(ousted.pk)}, ${rsvp(leaver.pk)})`);
        const stays = await call('GET', `/api/marketplace/posts/${E}/chat`, stayer);
        assert(readsNote(stays), `the member still in reads the chat and its note (${show(stays)})`);
        // A member still in the group, who sees the event chat, keeps the event chat's own refusal on its lines.
        {
            const react = await call('POST', '/api/messages/react', stayer, { messageId: lineId, authorPubkey: stayer.pk, emoji: '👍' });
            const edit = await call('POST', '/api/messages/edit', stayer, { messageId: lineId, ciphertext: 'changed', nonce: 'plaintext-v1' });
            const del = await call('POST', '/api/messages/delete', stayer, { messageId: lineId });
            assert(react.status === 403 && react.body?.error === 'Reactions are not part of an event chat'
                && edit.status === 403 && edit.body?.error === 'Messages in an event chat cannot be edited'
                && del.status === 403 && del.body?.error === 'Messages in an event chat cannot be deleted',
                `the member still in hears why a line of the event chat takes no reaction, edit or delete (${show(react)} | ${show(edit)} | ${show(del)})`);
        }
        inviteGroupMember(hidden.id, convenor.pk, ousted.pk, 'member');
        joinGroup(hidden.id, ousted.pk);
        const back = await call('GET', `/api/marketplace/posts/${E}/chat`, ousted);
        assert(readsNote(back) && (await mine(ousted)).includes(E), `invited back, the removed member is Going again: the chat, its note, "Your events" (${show(back)})`);
    }

    // --- 4. Nor does the time an answer takes, on a node with a full messages table (#1333 review) ---
    // POST /api/messages/send answered the hidden group's chat id at once (the group chat's own refusal, and the visitor
    // gate's "a conversation, not a DM of yours"), while an id nobody has went on to look for an old id of a folded DM:
    // a scan of every line with metadata, 35 ms against 2.4 at 100k lines. The old id is looked up in an index now.
    {
        const filler = createConversation('dm', [convenor.pk, pollster.pk], convenor.pk)!;
        const insert = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, metadata, timestamp)
            VALUES (?, ?, ?, 'ct', 'nc', 'text', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
        const LINES = 50_000;
        db.transaction(() => {
            for (let i = 0; i < LINES; i++) {
                const meta = i % 50 === 0
                    ? { originalConversationId: crypto.randomUUID() }
                    : { replyTo: crypto.randomUUID(), reactions: [{ emoji: '👍', pubkey: convenor.pk }] };
                insert.run(crypto.randomUUID(), filler.id, convenor.pk, JSON.stringify(meta));
            }
        })();
        const lines = (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE metadata IS NOT NULL').get() as any).c;
        assert(lines >= LINES, `setup: ${lines} lines with metadata`);

        const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
        const timed = async (id: Id, conversationId: string) => {
            const body = { conversationId, authorPubkey: id.pk, ...lockedDm() };
            const t0 = process.hrtime.bigint();
            const r = await call('POST', '/api/messages/send', id, body);
            return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r };
        };
        // Medians of alternating calls, and of each pair's difference, so a slow moment on the runner lands on both.
        // The bound is far above the index's cost (well under a millisecond) and far below the scan's (about 15 ms here
        // at 50k lines on a laptop, more on a CI runner).
        const BOUND_MS = 3;
        const SAMPLES = 21;
        const cases: [string, Id, string, string][] = [
            ['an outsider', outsider, 'the group chat id', hidden.id],
            ['an outsider', outsider, 'the event chat id', event.id],
            ['a member of another group', otherGroupie, 'the group chat id', hidden.id],
            ['a member of another group', otherGroupie, 'the event chat id', event.id],
            ["a visitor's row", vera, 'the group chat id', hidden.id],
            ["a visitor's row", vera, 'the event chat id', event.id],
            ["a visitor's row", vera, "someone else's old DM id", othersOldId],
        ];
        for (const [who, id, what, realId] of cases) {
            await timed(id, realId); await timed(id, crypto.randomUUID());   // warm both paths
            const real: number[] = [], none: number[] = [], diff: number[] = [];
            let same = true;
            for (let i = 0; i < SAMPLES; i++) {
                const a = await timed(id, realId);
                const b = await timed(id, crypto.randomUUID());
                real.push(a.ms); none.push(b.ms); diff.push(b.ms - a.ms);
                if (a.r.status !== b.r.status || a.r.text !== b.r.text) same = false;
            }
            const d = median(diff);
            assert(same && Math.abs(d) < BOUND_MS,
                `send, ${who}, ${what}: the same answer, in the same time as an id nobody has `
                + `(median ${median(real).toFixed(2)} ms vs ${median(none).toFixed(2)} ms; pairs differ by ${d.toFixed(2)} ms, bound ${BOUND_MS} ms)`);
        }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('✗ FAIL: suite crashed', err);
    process.exit(1);
});
