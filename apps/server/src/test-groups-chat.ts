/**
 * Groups redesign slice 1 — every Commons group owns a chat (scratch/groups-design/decisions.md 2, 3, 6, 7, 11,
 * 12, 13; groups-review.md §3.2, §3.6).
 *
 *  1. Creating a group creates its chat: one 'group_thread' conversation whose id IS the group id, named after
 *     the group, with the convenor in it. Category order and the Social Circle default.
 *  2. Membership follows the group: joining (open, approved, invitation accepted) puts you in; a pending request
 *     or an open invitation does not; leaving and removal take you out at once and write a tombstone.
 *  3. Who reads and who posts, re-checked against group_members every time — through the group chat routes AND
 *     the ordinary messaging routes every store app uses: member and convenor read and post; an observer reads
 *     only; an outsider, a removed member, someone who left, a pending request, an invitee and a node admin who
 *     is not a member are refused. An invite-only group answers an outsider 404, as if it did not exist.
 *  4. The ordinary send route (old store apps) posts, edits and reacts under the same rules (chat parity,
 *     2026-09-23 — slice 1 refused edits and reactions here; the full matrix is test-chat-parity).
 *  5. System lines: joined, left, removed, role changed, event and poll posted to the group. Membership lines
 *     never count as unread.
 *  6. Pushes: every other member by default, never the author, never someone removed; a mute (8h / 1w / always)
 *     silences one chat; an @mention gets through a mute; an expired mute is no mute. No text in a push.
 *  7. Convenor removal of a message; nobody else; system lines cannot be removed.
 *  8. "Your groups": groups, kept enterprises (🥖) and events hosted or Going (📅), latest message, unread count
 *     per member; nothing the member is not in.
 *  9. The old chat group is gone: the create route answers 410; existing ones are deleted with tombstones.
 * 10. Renaming a group renames its chat.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, joinGroup, approveGroupMember, inviteGroupMember, removeGroupMember,
    setMemberRole, updateGroup, createPost, createTreasury, adminAssignTreasuryOperator, createConversation,
    getUnreadCounts, markConversationRead, listYourChats, getGroup,
} from './state-engine.js';
import { rsvpEvent } from './engine/posts.js';
import {
    postGroupThreadMessage, removeGroupThreadMessage, getGroupThread, detectMentions,
    GROUP_THREAD_NOTICE, GROUP_THREAD_MESSAGE_MAX, GroupSystemType,
} from './engine/group-thread.js';
import { removeOldChatGroups } from './engine/messaging.js';
import { removeEnterpriseThreadMessage } from './engine/enterprise-thread.js';
import { setChatMute } from './engine/chat-mutes.js';
import { GROUP_CATEGORIES, DEFAULT_GROUP_CATEGORY, GROUP_CATEGORY_LABELS } from '@beanpool/core';
import { createGroupRoutes } from './routes/groups.js';
import { createMessagingRoutes } from './routes/messaging.js';
import { chatRateLimit, resetChatRateLimit, CHAT_LINES_PER_MINUTE } from './chat-rate-limit.js';

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
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

const isParticipant = (convId: string, pk: string) =>
    !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(convId, pk);
const hasTombstone = (convId: string, pk: string) =>
    !!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'conversation_participants' AND row_key = ?").get(`${convId}|${pk}`);
const systemLines = (groupId: string) =>
    db.prepare("SELECT system_type, ciphertext, metadata FROM messages WHERE conversation_id = ? AND type = 'system' ORDER BY rowid").all(groupId) as any[];
const lastLine = (groupId: string) => systemLines(groupId).slice(-1)[0];

const broadcasts: { event: any; recipients?: string[] }[] = [];
const pushes: { targets: string[]; actor: string; title: string; body: string; data: any }[] = [];
const cb = {
    broadcast: (event: any, recipients?: string[]) => { broadcasts.push({ event, recipients }); },
    dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: any) => {
        pushes.push({ targets, actor, title, body, data });
    },
    registerVisitor: () => { },
};

async function dispatch(router: any, method: string, path: string, ctx: any) {
    const matched = router.match(path, method);
    const layer = matched.pathAndMethod.find((l: any) => l.methods.includes(method));
    if (!layer) throw new Error(`No route found for ${method} ${path}`);
    const m = path.match(layer.regexp);
    const params: Record<string, string> = {};
    (layer.paramNames || []).forEach((p: any, i: number) => { params[p.name] = decodeURIComponent(m?.[i + 1] ?? ''); });
    ctx.params = { ...params, ...(ctx.params || {}) };
    await layer.stack[layer.stack.length - 1](ctx);
    return ctx;
}
const ctxFor = (actor: string | undefined, body?: any, query: Record<string, string> = {}): any => ({
    requestBody: body ?? {}, state: actor ? { actor } : {}, query, get: () => '', set: () => { }, headers: {},
});

async function main(): Promise<void> {
    initStateEngine();

    // enforceReadAuth OFF on purpose: a group's chat must be private whether or not the node enforces read auth.
    const deps = {
        checkAdminAuth: async () => true,
        rateLimit: () => true,
        clampLimit: (n: any) => Number(n) || 50,
        clampOffset: (n: any) => Number(n) || 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    } as any;
    const groupsRouter = createGroupRoutes(deps);
    const messagingRouter = createMessagingRoutes(deps);
    const get = (path: string, actor?: string, query: Record<string, string> = {}) => dispatch(groupsRouter, 'GET', path, ctxFor(actor, undefined, query));
    const post = (path: string, actor: string | undefined, body: any) => dispatch(groupsRouter, 'POST', path, ctxFor(actor, body));
    const mget = (path: string, actor?: string) => dispatch(messagingRouter, 'GET', path, ctxFor(actor));
    const mpost = (path: string, actor: string | undefined, body: any) => dispatch(messagingRouter, 'POST', path, ctxFor(actor, body));

    const alice = makeMember('Alice');       // convenor
    const bob = makeMember('Bob');           // member
    const carol = makeMember('Carol');       // observer
    const dave = makeMember('Dave');         // removed
    const erin = makeMember('Erin');         // outsider
    const frank = makeMember('Frank');       // pending request, later approved
    const gina = makeMember('Gina');         // leaves
    const hugo = makeMember('Hugo');         // invitee
    const admin = makeMember('NodeAdmin');   // node admin, never a member
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'genesis')`).run(admin);

    // ── 1. The chat is created with the group ───────────────────────────────────────────────
    console.log('\n--- 1. A group is created with its chat ---');
    assert(GROUP_CATEGORIES.join(',') === 'social,general,working_group,project,guild',
        'categories are ordered Social Circle, General, Working Group, Project Team, Guild');
    assert(DEFAULT_GROUP_CATEGORY === 'social' && GROUP_CATEGORY_LABELS.project === 'Project Team' && GROUP_CATEGORY_LABELS.social === 'Social Circle',
        'Social Circle is the default, and "project" reads as Project Team');
    const garden = createGroup({ name: 'Garden Crew', joinPolicy: 'request_to_join', createdBy: alice });
    assert(garden.category === 'social', 'a group created without a category is a Social Circle');
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(garden.id) as any;
    assert(conv?.type === 'group_thread', "the group's chat is one group_thread conversation");
    assert(conv?.name === 'Garden Crew', "named after the group");
    assert(isParticipant(garden.id, alice), 'the convenor is in it');
    assert(systemLines(garden.id).length === 0, 'a new group chat is empty (the app shows its invite-people empty state)');

    // ── 2. Membership follows the group ─────────────────────────────────────────────────────
    console.log('\n--- 2. Chat membership follows the group ---');
    joinGroup(garden.id, frank);
    assert(!isParticipant(garden.id, frank), 'a pending request is not in the chat');
    inviteGroupMember(garden.id, alice, hugo);
    assert(!isParticipant(garden.id, hugo), 'an open invitation is not in the chat');
    for (const pk of [bob, carol, dave, gina]) { joinGroup(garden.id, pk); approveGroupMember(garden.id, alice, pk); }
    assert([bob, carol, dave, gina].every(pk => isParticipant(garden.id, pk)), 'approved members are in the chat');
    const joined = systemLines(garden.id).filter(l => l.system_type === GroupSystemType.MEMBER_JOINED);
    assert(joined.length === 4 && joined[0].ciphertext === 'Bob joined', `each approval writes a "joined" line (got ${joined.map(j => j.ciphertext).join('; ')})`);
    setMemberRole(garden.id, alice, carol, 'observer');
    assert(lastLine(garden.id)?.system_type === GroupSystemType.ROLE_CHANGED && lastLine(garden.id).ciphertext === 'Alice made Carol an observer',
        'a role change writes a line naming who did it');
    assert(isParticipant(garden.id, carol), 'an observer stays in the chat (reads, does not post)');

    removeGroupMember(garden.id, alice, dave);
    assert(!isParticipant(garden.id, dave), 'a removed member is out of the chat at once');
    assert(hasTombstone(garden.id, dave), 'and the removal is tombstoned so backups drop the row too');
    assert(lastLine(garden.id)?.ciphertext === 'Alice removed Dave' && lastLine(garden.id).system_type === GroupSystemType.MEMBER_REMOVED,
        'a removal writes "Alice removed Dave"');
    removeGroupMember(garden.id, gina, gina);
    assert(!isParticipant(garden.id, gina) && hasTombstone(garden.id, gina), 'someone who leaves is out of the chat, tombstoned');
    assert(lastLine(garden.id)?.ciphertext === 'Gina left', 'leaving writes "Gina left"');
    removeGroupMember(garden.id, alice, hugo);
    assert(lastLine(garden.id)?.ciphertext === 'Gina left', 'withdrawing an invitation writes no line (they were never in)');

    // ── 3. Who reads and who posts ──────────────────────────────────────────────────────────
    console.log('\n--- 3. Read and post, re-checked against the group ---');
    inviteGroupMember(garden.id, alice, hugo);
    // The invite landing (slice 2) names who asked: the invitee sees their own inviter, nobody else sees one.
    const asHugo = getGroup(garden.id, hugo) as any;
    assert(asHugo?.viewerStatus === 'invited' && asHugo?.viewerInvitedBy?.pubkey === alice && asHugo?.viewerInvitedBy?.callsign === 'Alice',
        'an invitee reading the group sees who invited them');
    assert((getGroup(garden.id, bob) as any)?.viewerInvitedBy === undefined, 'a member is shown no inviter');
    assert((getGroup(garden.id, erin) as any)?.viewerInvitedBy === undefined, 'an outsider is shown no inviter');
    const chatPath = `/api/groups/${garden.id}/chat`;
    const read = async (pk?: string) => (await get(chatPath, pk)).status ?? 200;
    assert(await read(alice) === 200 && await read(bob) === 200, 'the convenor and a member read the chat');
    assert(await read(carol) === 200, 'an observer reads the chat');
    for (const [pk, who] of [[erin, 'an outsider'], [dave, 'a removed member'], [gina, 'someone who left'],
        [frank, 'a pending request'], [hugo, 'an invitee who has not accepted'], [admin, 'a node admin who is not a member']] as const) {
        assert(await read(pk) === 403, `${who} is refused the chat (403)`);
        const generic = await mget(`/api/messages/${garden.id}`, pk);
        assert(generic.status === 403, `${who} is refused through GET /api/messages/:id too, with read auth off (got ${generic.status})`);
    }
    assert(await read(undefined) === 401, 'an unsigned request is 401');
    const view = (await get(chatPath, bob)).body;
    assert(view.notice === GROUP_THREAD_NOTICE && /operator/.test(view.notice), 'the chat carries its honest node-readable notice');
    assert(view.canPost === true && view.role === 'member', 'a member may post');
    assert((await get(chatPath, carol)).body.canPost === false, 'an observer may not');
    const genericOk = await mget(`/api/messages/${garden.id}`, bob);
    assert(genericOk.status === undefined || genericOk.status === 200, 'a member reads through the ordinary route old apps use');

    const first = await post(`${chatPath}/message`, bob, { text: 'Seedlings on Saturday?' });
    assert(first.status === 201 && decode(first.body.message.ciphertext) === 'Seedlings on Saturday?', 'a member posts');
    assert(first.body.message.nonce === 'plaintext-v1', 'stored node-readable, plaintext-v1');
    assert((await post(`${chatPath}/message`, carol, { text: 'me too' })).status === 403, 'an observer cannot post');
    assert((await post(`${chatPath}/message`, dave, { text: 'let me back' })).status === 403, 'a removed member cannot post');
    assert((await post(`${chatPath}/message`, erin, { text: 'hi' })).status === 403, 'an outsider cannot post');
    assert((await post(`${chatPath}/message`, bob, { text: 'x'.repeat(GROUP_THREAD_MESSAGE_MAX + 1) })).status === 400, 'the 2000-character cap holds');
    const cid = crypto.randomUUID();
    const once = await post(`${chatPath}/message`, bob, { text: 'once', clientId: cid });
    const twice = await post(`${chatPath}/message`, bob, { text: 'once', clientId: cid });
    assert(once.body.message.id === cid && twice.body.message.id === cid
        && (db.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(cid) as any).c === 1, 'a client id makes a resend idempotent');
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(bob);
    assert((await post(`${chatPath}/message`, bob, { text: 'frozen' })).status === 403, 'a credit-frozen member cannot post (same rule as every node-readable thread)');
    db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(bob);

    // Invite-only: hidden from outsiders, including here.
    const secret = createGroup({ name: 'Quiet Room', joinPolicy: 'invite_only', createdBy: alice });
    inviteGroupMember(secret.id, alice, hugo);
    assert((await get(`/api/groups/${secret.id}/chat`, erin)).status === 404, 'an invite-only group answers an outsider 404, as if it did not exist');
    assert((await get(`/api/groups/${secret.id}/succession`, erin)).status === 404, 'its succession route too');
    assert((await get(`/api/groups/${secret.id}/chat`, hugo)).status === 403, 'an invitee gets 403 (they know it exists) until they accept');
    // The ordinary messaging routes answer the same way (PR #924 review, item 5): an outsider cannot tell an
    // invite-only group's chat from an id that does not exist.
    const nowhere = crypto.randomUUID();
    const same = (a: any, b: any) => a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body);
    const hiddenGet = await mget(`/api/messages/${secret.id}`, erin);
    assert(hiddenGet.status === 404 && same(hiddenGet, await mget(`/api/messages/${nowhere}`, erin)),
        'GET /api/messages/:id: an invite-only group is 404 to an outsider, word for word as an unknown id');
    const muteBody = (id: string) => ({ conversationId: id, duration: '8h' });
    const hiddenMute = await mpost('/api/messages/mute', erin, muteBody(secret.id));
    assert(hiddenMute.status === 404 && same(hiddenMute, await mpost('/api/messages/mute', erin, muteBody(nowhere))), 'mute: the same');
    const hiddenRead = await mpost('/api/messages/mark-read', erin, { conversationId: secret.id });
    assert(hiddenRead.status === 404 && same(hiddenRead, await mpost('/api/messages/mark-read', erin, { conversationId: nowhere })), 'mark-read: the same');
    const sendBody = (id: string) => ({ conversationId: id, authorPubkey: erin, ciphertext: b64('hi'), nonce: 'plaintext-v1' });
    assert(same(await mpost('/api/messages/send', erin, sendBody(secret.id)), await mpost('/api/messages/send', erin, sendBody(nowhere))),
        'send: the same answer as an unknown id');
    assert((await mget(`/api/messages/${secret.id}`, hugo)).status === 403, 'the invitee, who knows it exists, gets 403 there as on the group routes');
    assert((await mget(`/api/messages/${garden.id}`, erin)).status === 403, 'a group that is not invite-only stays 403 to an outsider');
    joinGroup(secret.id, hugo);
    assert((await get(`/api/groups/${secret.id}/chat`, hugo)).status === undefined, 'after accepting, the invitee reads it');
    assert(lastLine(secret.id)?.ciphertext === 'Hugo joined', 'accepting an invitation writes "joined"');

    // ── 4. The ordinary routes every store app uses ─────────────────────────────────────────
    console.log('\n--- 4. The ordinary send route, edits and reactions ---');
    const viaOld = await mpost('/api/messages/send', bob, { conversationId: garden.id, authorPubkey: bob, ciphertext: b64('from an old app'), nonce: 'plaintext-v1' });
    assert(viaOld.body?.success === true, `an old app's send to the group chat is accepted (got ${viaOld.status} ${viaOld.body?.error ?? ''})`);
    const stored = db.prepare('SELECT * FROM messages WHERE id = ?').get(viaOld.body?.message?.id) as any;
    assert(stored?.conversation_id === garden.id && decode(stored.ciphertext) === 'from an old app', 'stored in the group chat, readable');
    const oldObserver = await mpost('/api/messages/send', carol, { conversationId: garden.id, authorPubkey: carol, ciphertext: b64('hi'), nonce: 'plaintext-v1' });
    assert(oldObserver.status === 403, `an observer is refused through the old route too (got ${oldObserver.status})`);
    const oldRemoved = await mpost('/api/messages/send', dave, { conversationId: garden.id, authorPubkey: dave, ciphertext: b64('hi'), nonce: 'plaintext-v1' });
    assert(oldRemoved.status === 403, `a removed member is refused through the old route (got ${oldRemoved.status})`);
    const oldEncrypted = await mpost('/api/messages/send', bob, { conversationId: garden.id, authorPubkey: bob, ciphertext: 'xx', nonce: 'somenonce' });
    assert(oldEncrypted.status === 400, 'anything but plaintext-v1 is refused (a group chat is node-readable)');
    const oldImage = await mpost('/api/messages/send', bob, { conversationId: garden.id, authorPubkey: bob, ciphertext: b64('pic'), nonce: 'plaintext-v1', type: 'image', attachment: { data: 'x', nonce: 'y' } });
    assert(oldImage.status === 400, 'no photos in a group chat through the old route');
    const oldLong = await mpost('/api/messages/send', bob, { conversationId: garden.id, authorPubkey: bob, ciphertext: b64('y'.repeat(GROUP_THREAD_MESSAGE_MAX + 1)), nonce: 'plaintext-v1' });
    assert(oldLong.status === 400, 'the 2000-character cap holds through the old route');
    // Chat parity (2026-09-23): slice 1 refused an edit and a reaction on a group chat message here, because
    // this route had no size bound and no membership re-check. It has both now, from the same engine the group
    // send uses, so the old store apps' DM-style window works on a group chat as it always looked like it did.
    // The two assertions this replaces were "edits are refused in a group chat" and "reactions are refused in a
    // group chat (not in this slice)". The full rule matrix is test-chat-parity.
    const edit = await mpost('/api/messages/edit', bob, { messageId: first.body.message.id, ciphertext: b64('edited'), nonce: 'plaintext-v1' });
    assert(edit.body?.success === true && decode(edit.body.message.ciphertext) === 'edited' && !!edit.body.message.editedAt,
        `a member edits their own group chat message through the old route (got ${edit.status} ${edit.body?.error ?? ''})`);
    const editedRow = db.prepare('SELECT ciphertext, nonce, edited_at FROM messages WHERE id = ?').get(first.body.message.id) as any;
    assert(decode(editedRow.ciphertext) === 'edited' && editedRow.nonce === 'plaintext-v1' && !!editedRow.edited_at,
        'the edit is stored node-readable, with editedAt');
    assert((await mpost('/api/messages/edit', carol, { messageId: first.body.message.id, ciphertext: b64('mine now'), nonce: 'plaintext-v1' })).status === 400,
        'an observer editing somebody elses message is still refused (not the author)');
    const react = await mpost('/api/messages/react', bob, { messageId: first.body.message.id, emoji: '👍' });
    assert(react.body?.success === true && JSON.parse(react.body.metadata).reactions[0].emoji === '👍',
        `a member reacts to a group chat message through the old route (got ${react.status} ${react.body?.error ?? ''})`);
    assert((await mpost('/api/messages/react', carol, { messageId: first.body.message.id, emoji: '👍' })).status === 403,
        'an observer still cannot react — reacting is writing in the room');
    assert((await mpost('/api/messages/react', dave, { messageId: first.body.message.id, emoji: '👍' })).status === 403,
        'nor can a removed member');
    const markRemoved = await mpost('/api/messages/mark-read', dave, { conversationId: garden.id });
    assert(markRemoved.status === 403, 'a removed member cannot mark the chat read');

    // ── 5. System lines and unread ──────────────────────────────────────────────────────────
    console.log('\n--- 5. System lines and unread counts ---');
    markConversationRead(bob, garden.id);
    // Membership housekeeping does not badge anyone.
    await new Promise(r => setTimeout(r, 5));
    approveGroupMember(garden.id, alice, frank);
    assert(lastLine(garden.id)?.ciphertext === 'Frank joined', 'approving a request writes "Frank joined"');
    assert((getUnreadCounts(bob)[garden.id] || 0) === 0, 'a "joined" line does not count as unread');
    const ev = createPost('event', 'community', 'Seed swap', 'Bring jars', 0, 'fixed', alice, -28.5, 153.5, [], false, undefined, false,
        { audienceScope: 'group', targetGroupId: garden.id, eventStartAt: inHours(24), eventPlaceName: 'The shed' })!;
    const evLine = lastLine(garden.id);
    assert(evLine?.system_type === GroupSystemType.EVENT_POSTED && evLine.ciphertext === 'Alice posted an event: Seed swap',
        'an event posted to the group lands in its chat');
    assert(JSON.parse(evLine.metadata).postId === ev.id, 'with the event id, so the app can draw it as a card');
    const poll = createPost('poll', 'community', 'Which Saturday?', '', 0, 'fixed', bob, undefined, undefined, [], false, undefined, false,
        { audienceScope: 'group', targetGroupId: garden.id, pollOptions: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }], durationDays: 3 })!;
    assert(lastLine(garden.id)?.system_type === GroupSystemType.POLL_POSTED && JSON.parse(lastLine(garden.id).metadata).postId === poll.id,
        'a poll posted to the group lands in its chat');
    assert(getUnreadCounts(bob)[garden.id] === 1, `the event card counts as unread for Bob; the line about his own poll does not (got ${getUnreadCounts(bob)[garden.id]})`);
    const publicEv = createPost('event', 'community', 'Public fair', '', 0, 'fixed', alice, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(48), eventPlaceName: 'Main st' })!;
    assert(!systemLines(garden.id).some(l => JSON.parse(l.metadata || '{}').postId === publicEv.id), 'a public event does not land in any group chat');

    // ── 6. Pushes, mutes and mentions ───────────────────────────────────────────────────────
    console.log('\n--- 6. Pushes, mutes and @mentions ---');
    pushes.length = 0; broadcasts.length = 0;
    postGroupThreadMessage(cb, garden.id, bob, 'Rain tomorrow');
    const all = pushes.flatMap(p => p.targets);
    assert(all.includes(alice) && all.includes(carol) && all.includes(frank), 'every other member (observer included) gets a push by default');
    assert(!all.includes(bob), 'never the author');
    assert(!all.includes(dave) && !all.includes(erin) && !all.includes(gina), 'never someone removed, gone or outside');
    assert(pushes.every(p => !/Rain/.test(p.body) && !/Rain/.test(p.title)), 'no message text leaves the node in a push');
    assert(pushes[0].data?.conversationId === garden.id, 'the push opens the group chat');
    const b0 = broadcasts.find(b => b.event.type === 'new_message');
    assert(!!b0?.recipients && !b0.recipients.includes(dave) && !b0.recipients.includes(erin) && b0.recipients.includes(carol),
        'the live update goes to the people in the chat only');

    setChatMute(garden.id, alice, '8h');
    setChatMute(garden.id, carol, 'always');
    pushes.length = 0;
    postGroupThreadMessage(cb, garden.id, bob, 'Anyone got a spade?');
    const afterMute = pushes.flatMap(p => p.targets);
    assert(!afterMute.includes(alice) && !afterMute.includes(carol), 'muted members get no push');
    assert(afterMute.includes(frank), 'the others still do');
    pushes.length = 0;
    postGroupThreadMessage(cb, garden.id, bob, 'Thanks @alice, and @Carol!');
    const mention = pushes.find(p => /mentioned you/.test(p.body));
    assert(!!mention && mention.targets.includes(alice) && mention.targets.includes(carol), 'an @mention gets through a mute (any case)');
    const mentionMsg = db.prepare("SELECT metadata FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1").get(garden.id) as any;
    const mentioned = JSON.parse(mentionMsg.metadata).mentions as string[];
    assert(mentioned.includes(alice) && mentioned.includes(carol) && !mentioned.includes(bob), 'the message records who it mentions, for the apps to highlight');
    assert(detectMentions('email@alice.com', [{ pubkey: alice, callsign: 'alice' }]).length === 0, 'an @ inside a word is not a mention');
    assert(detectMentions('hi @Alicette', [{ pubkey: alice, callsign: 'Alice' }]).length === 0, 'a longer name is not a mention of a shorter one');
    assert(detectMentions('ping @Mary Jane!', [{ pubkey: bob, callsign: 'Mary Jane' }]).length === 1, 'a callsign with a space can be mentioned');
    db.prepare("UPDATE chat_mutes SET muted_until = ? WHERE conversation_id = ? AND member_pubkey = ?")
        .run(new Date(Date.now() - 1000).toISOString(), garden.id, alice);
    pushes.length = 0;
    postGroupThreadMessage(cb, garden.id, bob, 'Mute over?');
    assert(pushes.flatMap(p => p.targets).includes(alice), 'an expired 8-hour mute is no mute');

    // The mute route.
    const muteRes = await mpost('/api/messages/mute', bob, { conversationId: garden.id, duration: '1w' });
    assert(muteRes.body?.success === true && !!muteRes.body.mute?.mutedUntil, 'a member mutes the chat for a week');
    const until = Date.parse(muteRes.body.mute.mutedUntil) - Date.now();
    assert(until > 6.9 * 24 * HOUR && until <= 7 * 24 * HOUR, 'a week is a week');
    assert((await mpost('/api/messages/mute', bob, { conversationId: garden.id, duration: 'forever' })).status === 400, 'an unknown duration is refused');
    assert((await mpost('/api/messages/mute', erin, { conversationId: garden.id, duration: '8h' })).status === 403, 'an outsider cannot mute it');
    assert((await mpost('/api/messages/mute', dave, { conversationId: garden.id, duration: '8h' })).status === 403, 'nor a removed member');
    const off = await mpost('/api/messages/mute', bob, { conversationId: garden.id, duration: 'off' });
    assert(off.body?.mute === null && !db.prepare('SELECT 1 FROM chat_mutes WHERE conversation_id = ? AND member_pubkey = ?').get(garden.id, bob),
        "'off' unmutes");
    // A DM push honours a mute too (decision 12: every chat is mutable).
    const dm = createConversation('dm', [alice, bob], alice)!;
    setChatMute(dm.id, bob, 'always');
    const dmRes = await mpost('/api/messages/send', alice, { conversationId: dm.id, authorPubkey: alice, ciphertext: 'ZW5j', nonce: 'n1' });
    assert(dmRes.body?.success === true, 'a DM still sends');
    const listed = await mget(`/api/messages/conversations/${bob}`, bob);
    assert(listed.body.conversations.find((c: any) => c.id === dm.id)?.mute?.always === true, 'the Talk list tells the app which chats are muted');

    // ── 7. Moderation ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. A convenor removes a message ---');
    assert((await post(`${chatPath}/remove`, bob, { messageId: first.body.message.id })).status === 403, 'a member cannot remove a message');
    assert((await post(`${chatPath}/remove`, admin, { messageId: first.body.message.id })).status === 403, 'a node admin who is not a member cannot either');
    const removed = await post(`${chatPath}/remove`, alice, { messageId: first.body.message.id });
    assert(removed.body?.success === true && decode(removed.body.message.ciphertext) === 'removed by a convenor', 'the convenor removes it: "removed by a convenor"');
    const sysId = (db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND type = 'system' LIMIT 1").get(garden.id) as any).id;
    assert((await post(`${chatPath}/remove`, alice, { messageId: sysId })).status === 400, 'a system line cannot be removed');
    assertThrows(() => removeGroupThreadMessage(cb, garden.id, 'nope', alice), /not found/, 'an unknown message is not found');

    // ── 8. Your groups ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. "Your groups" ---');
    const bakery = createTreasury('Village Bakery', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(bakery, bob, 'admin');
    const walk = createPost('event', 'community', 'Creek walk', '', 0, 'fixed', erin, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(30), eventPlaceName: 'The creek' })!;
    rsvpEvent(() => { }, walk.id, bob, 'going');
    const quiz = createPost('event', 'community', 'Quiz night', '', 0, 'fixed', erin, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(40), eventPlaceName: 'The pub' })!;
    rsvpEvent(() => { }, quiz.id, bob, 'interested');
    markConversationRead(bob, garden.id);
    await new Promise(r => setTimeout(r, 5));
    postGroupThreadMessage(cb, garden.id, alice, 'See you all Saturday');
    const yours = await get('/api/your-groups', bob);
    const items = yours.body.items as any[];
    const g = items.find(i => i.id === garden.id);
    assert(!!g && g.kind === 'group' && g.badge === null && g.conversationId === garden.id && g.role === 'member', 'the group is listed, no badge');
    assert(g?.lastMessage?.text === 'See you all Saturday' && g.lastMessage.authorCallsign === 'Alice', 'with its latest message, decoded');
    assert(g?.unreadCount === 1, `and Bob's unread count, computed for him (got ${g?.unreadCount})`);
    const e = items.find(i => i.id === bakery);
    assert(!!e && e.kind === 'enterprise' && e.badge === '🥖' && e.role === 'keeper', 'the enterprise he keeps is listed with 🥖');
    const w = items.find(i => i.id === walk.id);
    assert(!!w && w.kind === 'event' && w.badge === '📅' && w.role === 'going', 'the event he is Going to is listed with 📅');
    assert(!items.some(i => i.id === quiz.id), 'an event he is only interested in is not');
    assert(!items.some(i => i.id === secret.id), 'an invite-only group he is not in is not');
    assert(items.every((it, i) => i === 0 || items[i - 1].lastActivityAt >= it.lastActivityAt), 'the list is ordered by latest activity');
    assert(items.findIndex(i => i.id === garden.id) < items.findIndex(i => i.id === bakery),
        'a quiet enterprise sorts by when it was made, not by when its read cursor was');
    assert(yours.body.totalUnread === items.reduce((n: number, i: any) => n + i.unreadCount, 0), 'totalUnread adds up');
    const daveList = (await get('/api/your-groups', dave)).body.items as any[];
    assert(!daveList.some(i => i.id === garden.id), 'a removed member does not see the group');
    const ginaList = (await get('/api/your-groups', gina)).body.items as any[];
    assert(!ginaList.some(i => i.id === garden.id), 'nor does someone who left');
    const erinList = (await get('/api/your-groups', erin)).body.items as any[];
    assert(!erinList.some(i => i.kind === 'group'), 'an outsider sees none of these groups');
    assert(erinList.some(i => i.id === walk.id && i.role === 'host'), 'the host of an event sees it as host');
    assert((await get('/api/your-groups', undefined)).status === 401, 'unsigned: 401');
    await mpost('/api/messages/mark-read', bob, { conversationId: garden.id });
    assert((listYourChats(bob).items.find(i => i.id === garden.id)?.unreadCount ?? -1) === 0, 'marking the chat read clears the count');
    await new Promise(r => setTimeout(r, 5));
    postEnterpriseLine(bakery, erin);
    await new Promise(r => setTimeout(r, 5));
    assert((listYourChats(bob).items.find(i => i.id === bakery)?.unreadCount ?? 0) === 1, 'a new line in the enterprise thread shows as unread for its keeper');
    await mpost('/api/messages/mark-read', bob, { conversationId: bakery });
    assert((listYourChats(bob).items.find(i => i.id === bakery)?.unreadCount ?? -1) === 0, 'and a keeper can mark the enterprise thread read');

    // ── 8a. A tombstone previews the way the chat reads it (#1049 fix round 2) ─────────────
    // A removed row stores ONE marker text, "removed by a convenor", whoever pressed the button. The app tells
    // an author's own delete from a moderator's removal by metadata.removedBy (chat-actions.tombstoneText), so
    // the list has to read it the same way: a member who deleted their own message was seeing the chat call it
    // "This message was deleted" while Talk called the same message "removed by a convenor".
    console.log('\n--- 8a. What a tombstone previews as in "Your groups" ---');
    const ownLine = postGroupThreadMessage(cb, garden.id, alice, 'A line of my own');
    assert((await post(`${chatPath}/remove`, alice, { messageId: ownLine.id })).body?.success === true,
        'Alice removes a message of her own');
    assert(listYourChats(alice).items.find(i => i.id === garden.id)?.lastMessage?.text === 'This message was deleted',
        'her own delete previews as "This message was deleted"');
    await new Promise(r => setTimeout(r, 5));
    const bobsLine = postGroupThreadMessage(cb, garden.id, bob, "Bob's line");
    assert((await post(`${chatPath}/remove`, alice, { messageId: bobsLine.id })).body?.success === true,
        "the convenor removes Bob's message");
    assert(listYourChats(alice).items.find(i => i.id === garden.id)?.lastMessage?.text === 'removed by a convenor',
        'a removal of someone else\'s message still previews as "removed by a convenor"');

    // An enterprise thread has no author delete at all: #1048 refuses one on the node, and the app offers a
    // keeper no Remove of their own either — so a keeper removing their OWN line is still a keeper's removal,
    // and must never preview as "This message was deleted". Same rule as an event's host (fix round 1).
    await new Promise(r => setTimeout(r, 5));
    const keepersOwnLine = postEnterpriseLine(bakery, bob);
    removeEnterpriseThreadMessage(cb, bakery, keepersOwnLine, bob);
    assert(listYourChats(bob).items.find(i => i.id === bakery)?.lastMessage?.text === 'removed by a keeper',
        'a keeper removing their own line previews as "removed by a keeper", not as a delete');
    await new Promise(r => setTimeout(r, 5));
    const otherLine = postEnterpriseLine(bakery, erin);
    removeEnterpriseThreadMessage(cb, bakery, otherLine, bob);
    assert(listYourChats(bob).items.find(i => i.id === bakery)?.lastMessage?.text === 'removed by a keeper',
        'and so does a keeper removing somebody else\'s');

    // ── 8b. Group chat sends through the ordinary send route are rate-limited ───────────────
    // (PR #924 review, item 4) — exactly as POST /api/groups/:id/chat/message is: per signed member in the chat
    // bucket, never the per-IP auth limiter that also guards recovery (0919 follow-up). A DM is not throttled.
    console.log('\n--- 8b. Rate limit on the ordinary send route ---');
    let authLimiterCalls = 0;
    const limited = createMessagingRoutes({
        ...deps,
        rateLimit: (ctx: any) => { authLimiterCalls++; ctx.status = 429; ctx.body = { error: 'Too many attempts' }; return false; },
    });
    resetChatRateLimit();
    for (let i = 0; i < CHAT_LINES_PER_MINUTE; i++) chatRateLimit({} as any, bob); // Bob has used his minute
    const before8b = (db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(garden.id) as any).c;
    const throttled = await dispatch(limited, 'POST', '/api/messages/send',
        ctxFor(bob, { conversationId: garden.id, authorPubkey: bob, ciphertext: b64('spam'), nonce: 'plaintext-v1' }));
    assert(throttled.status === 429, 'a group chat line through /api/messages/send goes through the chat limiter and is refused when it trips');
    assert(authLimiterCalls === 0, 'and the per-IP auth limiter never sees it');
    assert((db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(garden.id) as any).c === before8b, 'and nothing is written');
    const dmPair = createConversation('dm', [bob, erin], bob)!;
    const dmSent = await dispatch(limited, 'POST', '/api/messages/send',
        ctxFor(bob, { conversationId: dmPair.id, authorPubkey: bob, ciphertext: 'c', nonce: 'n' }));
    assert(dmSent.body?.success === true && authLimiterCalls === 0, 'a DM is not put through either limiter');
    resetChatRateLimit();

    // ── 9. The old chat group is gone ───────────────────────────────────────────────────────
    console.log('\n--- 9. The old chat group is removed ---');
    const oldCreate = await mpost('/api/messages/conversation', alice, { type: 'group', participants: [alice, bob, erin], createdBy: alice, name: 'Old style' });
    assert(oldCreate.status === 410 && /Commons/.test(oldCreate.body.error), 'creating an old chat group answers 410 and points to Commons groups');
    const oldId = crypto.randomUUID();
    db.prepare(`INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'group', 'Legacy', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(oldId, alice);
    for (const pk of [alice, bob]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(oldId, pk);
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, ?, ?, ?, 'plaintext-v1')`).run(crypto.randomUUID(), oldId, alice, b64('old'));
    assert(removeOldChatGroups() === 1, 'the boot purge removes an existing old chat group');
    assert(!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(oldId), 'the conversation is gone');
    assert((db.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id = ?').get(oldId) as any).c === 0, 'with its messages');
    assert((db.prepare('SELECT COUNT(*) c FROM conversation_participants WHERE conversation_id = ?').get(oldId) as any).c === 0, 'and its participants');
    assert(!!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'conversations' AND row_key = ?").get(oldId), 'a conversations tombstone carries it to backups');
    assert(hasTombstone(oldId, bob), 'and a participant tombstone for each member');
    assert(removeOldChatGroups() === 0, 'the purge is idempotent');
    assert(!!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(garden.id), 'group chats are untouched by it');

    // ── 10. Rename ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. Renaming a group renames its chat ---');
    updateGroup(garden.id, alice, { name: 'Garden Crew North' });
    assert((db.prepare('SELECT name FROM conversations WHERE id = ?').get(garden.id) as any).name === 'Garden Crew North', 'the chat takes the new name');
    assert(getGroupThread(garden.id, bob).group.name === 'Garden Crew North', 'and the chat view shows it');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

/** A message in an enterprise thread from someone who is not the keeper under test. */
function postEnterpriseLine(enterprise: string, author: string): string {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp)
                VALUES (?, ?, ?, ?, 'plaintext-v1', 'text', ?)`).run(id, enterprise, author, b64('Bread is up'), new Date().toISOString());
    return id;
}

main().catch(e => { console.error(e); process.exit(1); });
