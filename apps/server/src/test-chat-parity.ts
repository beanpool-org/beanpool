/**
 * Chat parity, server side (2026-09-23): one chat experience, one set of rules, whichever route reaches it.
 *
 * Groups slice 1 (#924) refused an edit and a reaction on a group chat message, because POST /api/messages/edit
 * "has no size bound and no membership re-check". This suite is the slice-3 rule book that replaces that:
 *
 *  1. EDIT in a group chat: the author only, text only, inside the 15-minute window, same 2000-character cap as
 *     a group send, never a removed message or a system line, and only while the author may still POST there —
 *     an active convenor or member. An observer, a removed member, someone who left, an outsider and a node
 *     admin who is not in the group are all refused.
 *  2. REACT in a group chat: whoever may post there, toggle semantics and `metadata.reactions` exactly as in a
 *     DM, back on the chat GET and live.
 *  3. DELETE FOR EVERYONE (new): the AUTHOR, in a DM or a group chat, at any age. A tombstone — reactions,
 *     mentions and the reply go with it, later edits and reactions are refused, deleting twice is a no-op
 *     success, it reaches the chat live and it never pushes.
 *  4. A convenor's removal of somebody else's message still works and is told apart by `metadata.removedBy`.
 *  5. Reports keep their evidence: a report never referenced a message, so a delete destroys none of it.
 *  6. REPLY in a group chat: `metadata.replyToId`, refused for a message in another chat or a system line, and
 *     carried through the old apps' /api/messages/send path too.
 *  7. A muted DM sends no push.
 *  8. Enterprise and event threads are unchanged: edit, react and author-delete stay refused there.
 *  9. Nothing here pushes: an edit, a reaction and a delete are silent, and an edited text raises no new
 *     @mention notification.
 * 10. The two rules the room writes share with the room's send route (PR #1048 review): an invite-only group is
 *     answered word for word as an id nobody has, whichever of the three is asked; and all three are throttled
 *     in the chat bucket, exactly as posting a line is.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, joinGroup, approveGroupMember, removeGroupMember, inviteGroupMember,
    setMemberRole, createPost, createTreasury, adminAssignTreasuryOperator, createConversation, submitReport,
    getReports,
} from './state-engine.js';
import { resetChatRateLimit, CHAT_LINES_PER_MINUTE } from './chat-rate-limit.js';
import { rsvpEvent } from './engine/posts.js';
import { postGroupThreadMessage, getGroupThread, GROUP_THREAD_MESSAGE_MAX } from './engine/group-thread.js';
import { postEnterpriseThreadMessage } from './engine/enterprise-thread.js';
import { postEventThreadMessage } from './engine/event-thread.js';
import {
    MESSAGE_EDIT_WINDOW_MS, editMessage as editEngine, toggleMessageReaction as reactEngine,
    deleteOwnMessage as deleteEngine, sendMessage as sendEngine,
} from './engine/messaging.js';
import { createGroupRoutes } from './routes/groups.js';
import { createMessagingRoutes } from './routes/messaging.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
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

const rowOf = (id: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
const metaOf = (id: string) => { try { return JSON.parse(rowOf(id)?.metadata || '{}'); } catch { return {}; } };
/** Age a message past the edit window without waiting 15 minutes. */
const ageOut = (id: string) =>
    db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?')
        .run(new Date(Date.now() - MESSAGE_EDIT_WINDOW_MS - 60_000).toISOString(), id);

const broadcasts: { event: any; recipients?: string[] }[] = [];
const pushes: { targets: string[]; actor: string; title: string; body: string; data: any }[] = [];
const cb = {
    broadcast: (event: any, recipients?: string[]) => { broadcasts.push({ event, recipients }); },
    dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: any) => {
        // The real dispatcher never notifies the actor; the fake matches it, so "no push" means no push.
        const others = targets.filter(pk => pk !== actor && pk !== 'SYSTEM');
        if (others.length > 0) pushes.push({ targets: others, actor, title, body, data });
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
/** A route that answered without setting ctx.status succeeded (Koa's 200). */
const statusOf = (ctx: any) => ctx.status ?? 200;
/** Parse a metadata blob without throwing, so a missing field fails its assertion instead of the suite. */
const parseMeta = (raw: unknown): any => { try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; } };

async function main(): Promise<void> {
    initStateEngine();

    // enforceReadAuth OFF on purpose: these rules hold whether or not the node enforces read auth.
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
    const gpost = (path: string, actor: string | undefined, body: any) => dispatch(groupsRouter, 'POST', path, ctxFor(actor, body));
    const mpost = (path: string, actor: string | undefined, body: any) => dispatch(messagingRouter, 'POST', path, ctxFor(actor, body));

    const alice = makeMember('Alice');     // convenor
    const bob = makeMember('Bob');         // member, the author under test
    const carol = makeMember('Carol');     // observer
    const dave = makeMember('Dave');       // removed
    const erin = makeMember('Erin');       // outsider
    const gina = makeMember('Gina');       // leaves
    const admin = makeMember('NodeAdmin'); // node admin, never a member
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'genesis')`).run(admin);

    const crew = createGroup({ name: 'Repair Crew', joinPolicy: 'request_to_join', createdBy: alice });
    for (const pk of [bob, carol, dave, gina]) { joinGroup(crew.id, pk); approveGroupMember(crew.id, alice, pk); }
    removeGroupMember(crew.id, alice, dave);
    removeGroupMember(crew.id, gina, gina);
    const chatPath = `/api/groups/${crew.id}/chat`;

    /** A fresh message from Bob in the group chat. */
    const bobLine = (text = 'Kettle needs a new element') => postGroupThreadMessage(cb, crew.id, bob, text);
    const editBody = (id: string, text: string) => ({ messageId: id, ciphertext: b64(text), nonce: 'plaintext-v1' });
    const edit = (actor: string | undefined, id: string, text: string) => mpost('/api/messages/edit', actor, editBody(id, text));
    const react = (actor: string | undefined, id: string, emoji = '👍') => mpost('/api/messages/react', actor, { messageId: id, authorPubkey: actor, emoji });
    const del = (actor: string | undefined, id: string) => mpost('/api/messages/delete', actor, { messageId: id });

    // ── 1. Edit in a group chat ─────────────────────────────────────────────────────────────
    console.log('\n--- 1. Edit in a group chat ---');
    const m1 = bobLine();
    const e1 = await edit(bob, m1.id, 'Kettle needs a new element, and a fuse');
    assert(e1.body?.success === true && decode(rowOf(m1.id).ciphertext) === 'Kettle needs a new element, and a fuse',
        `the author edits their own line (got ${statusOf(e1)} ${e1.body?.error ?? ''})`);
    assert(!!rowOf(m1.id).edited_at && rowOf(m1.id).nonce === 'plaintext-v1', 'editedAt is stamped and it stays node-readable');
    const seen = getGroupThread(crew.id, bob).messages.find(x => x.id === m1.id)!;
    assert(!!seen.editedAt && decode(seen.ciphertext) === 'Kettle needs a new element, and a fuse', "the chat's GET returns the new text with editedAt");
    // The live update, straight from the engine: the routes run on the node's own callbacks, which a test
    // cannot see. Everything about who may do what is asserted through the routes above.
    broadcasts.length = 0; pushes.length = 0;
    const m1b = bobLine('a line to edit for the live update');
    broadcasts.length = 0; pushes.length = 0;
    editEngine(cb, m1b.id, bob, b64('edited, live'), 'plaintext-v1');
    const liveEdit = broadcasts.filter(b => b.event?.action === 'edited' && b.event?.message?.id === m1b.id);
    assert(liveEdit.length === 1 && liveEdit[0].recipients!.includes(alice) && liveEdit[0].recipients!.includes(carol)
        && !liveEdit[0].recipients!.includes(erin) && !liveEdit[0].recipients!.includes(dave),
        `the edit reaches the chat's members live, and nobody else (got ${JSON.stringify(broadcasts.map(b => b.event?.action))})`);
    assert(decode(liveEdit[0].event.message.ciphertext) === 'edited, live' && !!liveEdit[0].event.message.editedAt,
        'and carries the new text and editedAt');
    assert(pushes.length === 0, 'an edit pushes nobody');

    const convLine = postGroupThreadMessage(cb, crew.id, alice, 'I have a spare');
    assert((await edit(alice, convLine.id, 'I have two spares')).body?.success === true, 'an active convenor edits their own line');

    // Who may NOT edit. Each writes their own line first where they can, else borrows Bob's — an edit by anyone
    // but the author is refused before any group rule, so the interesting case is the author who lost standing.
    const carolBefore = postGroupThreadMessage(cb, crew.id, carol, 'from when Carol was a member');
    setMemberRole(crew.id, alice, carol, 'observer');  // an observer from here on
    assert(statusOf(await edit(carol, carolBefore.id, 'changed my mind')) === 403, 'an observer cannot edit, even their own line: reacting and editing are writing in the room');
    const daveLine = postGroupThreadMessage(cb, crew.id, alice, 'placeholder');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(dave, daveLine.id);
    assert(statusOf(await edit(dave, daveLine.id, 'let me back')) === 403, 'a removed member cannot edit their old line');
    const ginaLine = postGroupThreadMessage(cb, crew.id, alice, 'placeholder 2');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(gina, ginaLine.id);
    assert(statusOf(await edit(gina, ginaLine.id, 'back for a sec')) === 403, 'nor does someone who left');
    const erinLine = postGroupThreadMessage(cb, crew.id, alice, 'placeholder 3');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(erin, erinLine.id);
    assert(statusOf(await edit(erin, erinLine.id, 'hello')) === 403, 'nor an outsider');
    const adminLine = postGroupThreadMessage(cb, crew.id, alice, 'placeholder 4');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(admin, adminLine.id);
    assert(statusOf(await edit(admin, adminLine.id, 'moderating')) === 403, 'nor a node admin who is not in the group — adminship is not membership');
    assert(statusOf(await edit(undefined, m1.id, 'unsigned')) === 401, 'an unsigned edit is 401');

    // What may NOT be edited.
    const other = bobLine('someone elses');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(alice, other.id);
    assert(statusOf(await edit(bob, other.id, 'mine now')) === 400, "somebody else's message is refused");
    const old = bobLine('too old to change');
    ageOut(old.id);
    const oldEdit = await edit(bob, old.id, 'changed anyway');
    assert(statusOf(oldEdit) === 400 && /15 minutes/.test(oldEdit.body?.error || '') && decode(rowOf(old.id).ciphertext) === 'too old to change',
        'outside the 15-minute window it is refused, and nothing is written');
    const big = bobLine('short');
    const bigEdit = await edit(bob, big.id, 'x'.repeat(GROUP_THREAD_MESSAGE_MAX + 1));
    assert(statusOf(bigEdit) === 400 && decode(rowOf(big.id).ciphertext) === 'short',
        `over the 2000-character cap is refused, and nothing is written (got ${statusOf(bigEdit)})`);
    assert(statusOf(await edit(bob, big.id, '   ')) === 400, 'an empty edit is refused');
    const encrypted = await mpost('/api/messages/edit', bob, { messageId: big.id, ciphertext: 'zz', nonce: 'somenonce' });
    assert(statusOf(encrypted) === 400, 'anything but plaintext-v1 is refused — a group chat is node-readable');
    const sysId = (db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND type = 'system' LIMIT 1").get(crew.id) as any).id;
    assert(statusOf(await edit(alice, sysId, 'rewriting history')) === 400, 'a system line cannot be edited');
    const gone = bobLine('about to go');
    await gpost(`${chatPath}/remove`, alice, { messageId: gone.id });
    assert(statusOf(await edit(bob, gone.id, 'undelete')) === 403, 'a removed message cannot be edited');

    // ── 2. React in a group chat ────────────────────────────────────────────────────────────
    console.log('\n--- 2. React in a group chat ---');
    const m2 = bobLine('New handle for the shed door');
    const r1 = await react(alice, m2.id, '👍');
    assert(r1.body?.success === true && metaOf(m2.id).reactions?.length === 1
        && metaOf(m2.id).reactions?.[0]?.emoji === '👍' && metaOf(m2.id).reactions?.[0]?.author === alice,
        `a convenor reacts; it lands in metadata.reactions as {emoji, author} (got ${statusOf(r1)} ${r1.body?.error ?? ''})`);
    assert((await react(bob, m2.id, '🔧')).body?.success === true && metaOf(m2.id).reactions?.length === 2, 'a member reacts too');
    await react(alice, m2.id, '🎉');
    assert(metaOf(m2.id).reactions?.find((x: any) => x.author === alice)?.emoji === '🎉' && metaOf(m2.id).reactions?.length === 2,
        'a different emoji from the same person replaces theirs, as in a DM');
    await react(alice, m2.id, '🎉');
    assert(metaOf(m2.id).reactions.length === 1 && !metaOf(m2.id).reactions?.some((x: any) => x.author === alice),
        'the same emoji again takes it off, as in a DM');
    const shown = getGroupThread(crew.id, bob).messages.find(x => x.id === m2.id)!;
    assert(parseMeta(shown.metadata).reactions?.length === 1, "reactions come back on the chat's GET");
    broadcasts.length = 0; pushes.length = 0;
    reactEngine(cb, m2.id, alice, '🔨');
    const liveReact = broadcasts.filter(b => b.event?.type === 'message_reaction' && b.event?.messageId === m2.id);
    assert(liveReact.length === 1 && liveReact[0].recipients!.includes(carol) && !liveReact[0].recipients!.includes(erin)
        && parseMeta(liveReact[0].event.metadata).reactions?.some((x: any) => x.emoji === '🔨'),
        'a reaction reaches the chat live, carrying the new metadata, and only to the people in it');
    assert(pushes.length === 0, 'a reaction pushes nobody');
    reactEngine(cb, m2.id, alice, '🔨');  // back off again, so the counts below are unchanged

    for (const [pk, who] of [[carol, 'an observer'], [dave, 'a removed member'], [gina, 'someone who left'],
        [erin, 'an outsider'], [admin, 'a node admin who is not a member']] as const) {
        assert(statusOf(await react(pk, m2.id)) === 403, `${who} cannot react`);
    }
    assert(statusOf(await react(undefined, m2.id)) === 401, 'an unsigned reaction is 401');
    assert(statusOf(await react(alice, sysId)) === 400, 'a system line takes no reaction');
    assert(statusOf(await react(alice, gone.id)) === 403, 'a removed message takes no reaction');
    // Age is nothing to a reaction — only an edit has a window.
    const oldish = bobLine('an old line');
    ageOut(oldish.id);
    assert((await react(alice, oldish.id)).body?.success === true, 'an old message can still be reacted to — the window is the edits');

    // ── 3. Delete for everyone ──────────────────────────────────────────────────────────────
    console.log('\n--- 3. Delete for everyone ---');
    // ── 3a. In a group chat ──
    const m3 = postGroupThreadMessage(cb, crew.id, bob, 'Thanks @Alice, I owe you one', undefined, m2.id);
    await react(alice, m3.id, '❤️');
    assert(metaOf(m3.id).mentions?.includes(alice) && metaOf(m3.id).replyToId === m2.id && metaOf(m3.id).reactions?.length === 1,
        'before the delete it carries a mention, a reply and a reaction');
    const d1 = await del(bob, m3.id);
    assert(d1.body?.success === true && d1.body.message.type === 'removed', `the author deletes their own group chat line (got ${statusOf(d1)} ${d1.body?.error ?? ''})`);
    const t3 = rowOf(m3.id);
    assert(t3.type === 'removed' && decode(t3.ciphertext) === 'This message was deleted' && t3.nonce === 'plaintext-v1',
        'the row becomes a tombstone with a fixed marker');
    assert(metaOf(m3.id).removed === true && metaOf(m3.id).removedBy === bob && !!metaOf(m3.id).removedAt,
        'metadata.removed / removedBy / removedAt say who took it down and when');
    assert(!metaOf(m3.id).reactions && !metaOf(m3.id).mentions && !metaOf(m3.id).replyToId,
        'reactions, mentions and the reply go with it');
    const liveMsg = postGroupThreadMessage(cb, crew.id, bob, 'a line to delete for the live update');
    broadcasts.length = 0; pushes.length = 0;
    deleteEngine(cb, liveMsg.id, bob);
    const liveDel = broadcasts.filter(b => b.event?.action === 'removed' && b.event?.message?.id === liveMsg.id);
    assert(liveDel.length === 1 && liveDel[0].recipients!.includes(alice) && liveDel[0].recipients!.includes(carol)
        && !liveDel[0].recipients!.includes(erin),
        'it reaches the chat live, the way a convenor removal does');
    assert(decode(liveDel[0].event.message.ciphertext) === 'This message was deleted', 'carrying the tombstone the chat now shows');
    assert(pushes.length === 0, 'and nobody is pushed for a delete');
    assert(statusOf(await edit(bob, m3.id, 'back please')) === 403, 'a deleted message cannot be edited afterwards');
    assert(statusOf(await react(alice, m3.id)) === 403, 'nor reacted to');
    const d1again = await del(bob, m3.id);
    assert(d1again.body?.success === true && metaOf(m3.id).removedBy === bob, 'deleting twice is a no-op success');
    assert(getGroupThread(crew.id, alice).messages.find(x => x.id === m3.id)!.type === 'removed',
        "the tombstone is what the chat's GET shows");

    // Age is nothing to a delete: "no window" is the whole point.
    const ancient = bobLine('written long ago');
    ageOut(ancient.id);
    assert((await del(bob, ancient.id)).body?.success === true, 'a message far outside the edit window can still be deleted');

    // Who may NOT delete.
    const mine = bobLine('bobs line');
    for (const [pk, who] of [[alice, 'a convenor'], [carol, 'an observer'], [erin, 'an outsider'],
        [admin, 'a node admin']] as const) {
        assert(statusOf(await del(pk, mine.id)) === 403, `${who} cannot delete somebody elses message through this route`);
    }
    assert(rowOf(mine.id).type === 'text', 'and the message is untouched');
    assert(statusOf(await del(undefined, mine.id)) === 401, 'an unsigned delete is 401');
    assert(statusOf(await del(bob, crypto.randomUUID())) === 404, 'an unknown message is 404');
    assert(statusOf(await del(alice, sysId)) === 400, 'a system line cannot be deleted');
    // Left the room: the author can no longer reach in.
    const ginasOwn = postGroupThreadMessage(cb, crew.id, alice, 'placeholder 5');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(gina, ginasOwn.id);
    assert(statusOf(await del(gina, ginasOwn.id)) === 403, 'someone who left cannot delete the line they wrote while they were in');
    // An observer still READS the chat, so they may take down what they wrote when they could post.
    const carolsOwn = postGroupThreadMessage(cb, crew.id, alice, 'placeholder 6');
    db.prepare('UPDATE messages SET author_pubkey = ? WHERE id = ?').run(carol, carolsOwn.id);
    assert((await del(carol, carolsOwn.id)).body?.success === true, 'an observer deletes their own old line — delete needs read, not post');

    // ── 3b. In a DM ──
    const dm = createConversation('dm', [bob, erin], bob)!;
    const dmMsg = await mpost('/api/messages/send', bob, { conversationId: dm.id, authorPubkey: bob, ciphertext: 'ZW5jcnlwdGVk', nonce: 'dm-nonce-1' });
    const dmId = dmMsg.body.message.id;
    await react(erin, dmId, '👀');
    assert(metaOf(dmId).reactions?.length === 1, 'a DM message with a reaction on it');
    const d2 = await del(bob, dmId);
    assert(d2.body?.success === true && rowOf(dmId).type === 'removed', `the author deletes their own DM (got ${statusOf(d2)} ${d2.body?.error ?? ''})`);
    assert(decode(rowOf(dmId).ciphertext) === 'This message was deleted' && rowOf(dmId).nonce === 'plaintext-v1',
        'the DM tombstone REPLACES the ciphertext on the node, readable without the conversation key, so both phones pick it up on their next sync');
    assert(!metaOf(dmId).reactions && metaOf(dmId).removedBy === bob, 'the reaction goes with it');
    const dmLiveMsg = sendEngine(cb, dm.id, bob, 'YW5vdGhlcg==', 'dm-nonce-live')!;
    broadcasts.length = 0; pushes.length = 0;
    deleteEngine(cb, dmLiveMsg.id, bob);
    const dmLive = broadcasts.filter(b => b.event?.type === 'message_edited' && b.event?.message?.id === dmLiveMsg.id);
    assert(dmLive.length === 1 && dmLive[0].recipients!.includes(erin) && dmLive[0].event.message.type === 'removed',
        'the other phone hears it live, as a message_edited carrying the tombstone');
    assert(pushes.length === 0, 'and no push');
    assert(statusOf(await del(erin, dmId)) === 403, 'the other participant cannot delete it');
    const dmMsg2 = await mpost('/api/messages/send', bob, { conversationId: dm.id, authorPubkey: bob, ciphertext: 'YWdhaW4=', nonce: 'dm-nonce-2' });
    assert(statusOf(await del(alice, dmMsg2.body.message.id)) === 403, 'nor can someone outside the DM');

    // A deleted image DM loses the photo too, or /api/attachment/:id would keep serving it.
    const withPhoto = await mpost('/api/messages/send', bob, {
        conversationId: dm.id, authorPubkey: bob, ciphertext: 'cGhvdG8=', nonce: 'dm-nonce-3',
        type: 'image', attachment: { data: 'aW1hZ2VieXRlcw==', nonce: 'att-nonce' },
    });
    const photoId = withPhoto.body.message.id;
    assert(!!db.prepare('SELECT 1 FROM message_attachments WHERE message_id = ?').get(photoId), 'the photo is stored');
    await del(bob, photoId);
    assert(!db.prepare('SELECT 1 FROM message_attachments WHERE message_id = ?').get(photoId),
        'deleting the message deletes the attachment blob — "for everyone" means the photo too');

    // ── 4. A convenor's removal is still its own thing ──────────────────────────────────────
    console.log('\n--- 4. Convenor removal, told apart by removedBy ---');
    const toRemove = bobLine('something a convenor takes down');
    const removed = await gpost(`${chatPath}/remove`, alice, { messageId: toRemove.id });
    assert(removed.body?.success === true && decode(removed.body.message.ciphertext) === 'removed by a convenor',
        'a convenor still removes somebody elses message');
    assert(metaOf(toRemove.id).removedBy === alice && metaOf(toRemove.id).removedBy !== rowOf(toRemove.id).author_pubkey,
        'removedBy is the convenor, not the author — which is how the apps say "Removed by a convenor"');
    assert(metaOf(m3.id).removedBy === rowOf(m3.id).author_pubkey,
        'and on an author delete removedBy IS the author — "This message was deleted"');
    assert(decode(getGroupThread(crew.id, alice).messages.find(x => x.id === m3.id)!.ciphertext) === 'This message was deleted'
        && decode(getGroupThread(crew.id, alice).messages.find(x => x.id === toRemove.id)!.ciphertext) === 'removed by a convenor',
        'the chat GET reads each tombstone with its own words');
    const d3 = await del(bob, toRemove.id);
    assert(d3.body?.success === true && metaOf(toRemove.id).removedBy === alice,
        'the author deleting a message a convenor already removed is a no-op that keeps the convenor on the record');
    assert(statusOf(await gpost(`${chatPath}/remove`, alice, { messageId: m3.id })) === 200 && metaOf(m3.id).removedBy === bob,
        'and a convenor removing an already-deleted message does not rewrite the author off it either');

    // ── 5. Reports keep their evidence ──────────────────────────────────────────────────────
    console.log('\n--- 5. A reported message keeps its evidence ---');
    // A report has never referenced a message: abuse_reports targets a MEMBER, a posts row (target_post_id) or a
    // pulse item, and the moderation list reads the joined posts/pulse_items row for what was said. There is no
    // report path in any app that names a chat message, so a delete destroys no moderator's copy — the evidence
    // a report holds is its own `reason` text plus the joined row, and both survive untouched.
    const reportable = bobLine('the line someone reports');
    const report = submitReport(erin, bob, 'Rude in the Repair Crew chat', undefined, undefined)!;
    const messageColumns = (db.prepare('PRAGMA table_info(abuse_reports)').all() as any[]).map(c => c.name);
    assert(!messageColumns.some(c => /message/i.test(c)),
        `abuse_reports holds no message reference at all (${messageColumns.join(', ')}) — nothing to snapshot before a delete`);
    await del(bob, reportable.id);
    const afterDelete = getReports('pending').reports.find(r => r.id === report.id)!;
    assert(!!afterDelete && afterDelete.reason === 'Rude in the Repair Crew chat' && afterDelete.targetPubkey === bob,
        'the report and its evidence are intact after the message is deleted');
    assert(rowOf(reportable.id).type === 'removed', 'the message itself is a tombstone — the row is never dropped, so a replica carries the removal');

    // ── 6. Reply in a group chat ────────────────────────────────────────────────────────────
    console.log('\n--- 6. Reply in a group chat ---');
    const parent = bobLine('Who has the 10mm?');
    const replyRes = await gpost(`${chatPath}/message`, alice, { text: 'I do', replyToId: parent.id });
    assert(statusOf(replyRes) === 201 && parseMeta(replyRes.body.message.metadata).replyToId === parent.id,
        `a reply stores metadata.replyToId (got ${statusOf(replyRes)} ${replyRes.body?.error ?? ''})`);
    assert(parseMeta(getGroupThread(crew.id, bob).messages.find(x => x.id === replyRes.body.message.id)?.metadata).replyToId === parent.id,
        "and the chat's GET carries it");
    const otherGroup = createGroup({ name: 'Other Crew', joinPolicy: 'open', createdBy: alice });
    const elsewhere = postGroupThreadMessage(cb, otherGroup.id, alice, 'a line in another chat');
    const crossed = await gpost(`${chatPath}/message`, alice, { text: 'quoting another room', replyToId: elsewhere.id });
    assert(statusOf(crossed) === 400, `a message from another chat cannot be replied to (got ${statusOf(crossed)})`);
    assert(statusOf(await gpost(`${chatPath}/message`, alice, { text: 'quoting the system', replyToId: sysId })) === 400,
        'nor a system line');
    assert(statusOf(await gpost(`${chatPath}/message`, alice, { text: 'nobody', replyToId: crypto.randomUUID() })) === 400,
        'nor a message that does not exist');
    assert(statusOf(await gpost(`${chatPath}/message`, alice, { text: 'bad type', replyToId: 42 })) === 400,
        'replyToId must be a string');
    assert(statusOf(await gpost(`${chatPath}/message`, alice, { text: 'no reply at all' })) === 201,
        'and a message without a reply is unchanged');
    // The old apps' path keeps a valid replyToId too.
    const viaOld = await mpost('/api/messages/send', bob, {
        conversationId: crew.id, authorPubkey: bob, ciphertext: b64('from an old app, quoting'), nonce: 'plaintext-v1',
        metadata: JSON.stringify({ replyToId: parent.id }),
    });
    assert(viaOld.body?.success === true && metaOf(viaOld.body.message.id).replyToId === parent.id,
        'the old /api/messages/send path keeps a valid replyToId');
    const oldCrossed = await mpost('/api/messages/send', bob, {
        conversationId: crew.id, authorPubkey: bob, ciphertext: b64('old app, wrong room'), nonce: 'plaintext-v1',
        metadata: JSON.stringify({ replyToId: elsewhere.id }),
    });
    assert(statusOf(oldCrossed) === 400, 'and refuses one from another chat, exactly as the group route does');
    const oldForged = await mpost('/api/messages/send', bob, {
        conversationId: crew.id, authorPubkey: bob, ciphertext: b64('old app, forging'), nonce: 'plaintext-v1',
        metadata: JSON.stringify({ mentions: [erin], reactions: [{ emoji: '👍', author: erin }], replyToId: parent.id }),
    });
    assert(!metaOf(oldForged.body.message.id).reactions && !metaOf(oldForged.body.message.id).mentions?.includes(erin),
        'a client cannot smuggle reactions or mentions in through that metadata — only the reply is taken');

    // ── 7. A muted DM sends no push ─────────────────────────────────────────────────────────
    console.log('\n--- 7. A muted DM sends no push ---');
    const quiet = createConversation('dm', [alice, erin], alice)!;
    pushes.length = 0;
    sendEngine(cb, quiet.id, alice, 'aGk=', 'n1');
    assert(pushes.flatMap(p => p.targets).includes(erin), 'an unmuted DM pushes the other person');
    // The mute is set through the ROUTE (the phone's only way in) and honoured where pushes are decided.
    const muted = await mpost('/api/messages/mute', erin, { conversationId: quiet.id, duration: '8h' });
    assert(muted.body?.success === true && !!muted.body.mute?.mutedUntil, 'the other person mutes the DM for 8 hours through /api/messages/mute');
    pushes.length = 0;
    sendEngine(cb, quiet.id, alice, 'aGkgYWdhaW4=', 'n2');
    assert(pushes.length === 0, 'and the next DM pushes nobody');
    db.prepare('UPDATE chat_mutes SET muted_until = ? WHERE conversation_id = ? AND member_pubkey = ?')
        .run(new Date(Date.now() - 1000).toISOString(), quiet.id, erin);
    pushes.length = 0;
    sendEngine(cb, quiet.id, alice, 'YmFjaw==', 'n3');
    assert(pushes.flatMap(p => p.targets).includes(erin), 'an expired mute is no mute');
    const off = await mpost('/api/messages/mute', erin, { conversationId: quiet.id, duration: 'always' });
    assert(off.body?.mute?.always === true, "'always' is accepted for a DM");
    pushes.length = 0;
    sendEngine(cb, quiet.id, alice, 'cXVpZXQ=', 'n4');
    assert(pushes.length === 0, "'always' silences it for good");
    assert((await mpost('/api/messages/mute', erin, { conversationId: quiet.id, duration: 'off' })).body?.mute === null,
        "'off' unmutes the DM again");
    assert(statusOf(await mpost('/api/messages/mute', bob, { conversationId: quiet.id, duration: '8h' })) === 403,
        'someone outside the DM cannot mute it');

    // ── 8. Enterprise and event threads are unchanged ───────────────────────────────────────
    console.log('\n--- 8. Enterprise and event threads still refuse all three ---');
    const bakery = createTreasury('Village Bakery', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(bakery, bob, 'admin');
    const entLine = postEnterpriseThreadMessage(cb, bakery, bob, 'Bread is up');
    assert(statusOf(await edit(bob, entLine.id, 'Bread is down')) === 403, 'an enterprise thread message cannot be edited');
    assert(statusOf(await react(bob, entLine.id)) === 403, 'nor reacted to');
    const entDel = await del(bob, entLine.id);
    assert(statusOf(entDel) === 403 && rowOf(entLine.id).type !== 'removed',
        `nor deleted by its author (got ${statusOf(entDel)} ${entDel.body?.error ?? ''})`);

    const ev = createPost('event', 'community', 'Tool library launch', '', 0, 'fixed', alice, -28.5, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(24), eventPlaceName: 'The hall' })!;
    rsvpEvent(() => { }, ev.id, bob, 'going');
    const evLine = postEventThreadMessage(cb, ev.id, bob, 'Bringing a drill');
    assert(statusOf(await edit(bob, evLine.id, 'Bringing two drills')) === 403, 'an event chat message cannot be edited');
    assert(statusOf(await react(bob, evLine.id)) === 403, 'nor reacted to');
    const evDel = await del(bob, evLine.id);
    assert(statusOf(evDel) === 403 && rowOf(evLine.id).type !== 'removed',
        `nor deleted by its author (got ${statusOf(evDel)} ${evDel.body?.error ?? ''})`);

    // ── 9. None of this pushes ──────────────────────────────────────────────────────────────
    console.log('\n--- 9. Edits, reactions and deletes are silent ---');
    const loud = postGroupThreadMessage(cb, crew.id, bob, 'plain line');
    pushes.length = 0;
    editEngine(cb, loud.id, bob, b64('Hey @Alice, look at this'), 'plaintext-v1');
    assert(pushes.length === 0, 'an edit pushes nobody — and an edited text raises no new @mention notification');
    assert(!metaOf(loud.id).mentions, 'nor does it add a mention to the message');
    reactEngine(cb, loud.id, alice, '👍');
    assert(pushes.length === 0, 'a reaction pushes nobody');
    deleteEngine(cb, loud.id, bob);
    assert(pushes.length === 0, 'a delete pushes nobody');
    const stillLoud = postGroupThreadMessage(cb, crew.id, bob, 'and a NEW message still pushes');
    assert(pushes.flatMap(p => p.targets).includes(alice) && !!stillLoud, 'while a new message still does');

    // ── 10. A hidden group stays hidden, and the room writes are throttled ──────────────────
    console.log('\n--- 10. The #828 rule and the room throttle ---');
    resetChatRateLimit();
    const circle = createGroup({ name: 'Quiet Circle', joinPolicy: 'invite_only', createdBy: alice });
    inviteGroupMember(circle.id, alice, bob, 'member');
    joinGroup(circle.id, bob);
    const secret = postGroupThreadMessage(cb, circle.id, bob, 'only the circle sees this');
    const ghost = crypto.randomUUID();  // an id nobody has
    /** Status and words: all a prober can see. The two answers must be the same string. */
    const answer = (ctx: any) => `${statusOf(ctx)} ${ctx.body?.error ?? ''}`;
    for (const [pk, who] of [[erin, 'an outsider'], [admin, 'a node admin']] as const) {
        const [realDel, ghostDel] = [await del(pk, secret.id), await del(pk, ghost)];
        assert(answer(realDel) === answer(ghostDel),
            `${who} deleting a message inside an invite-only group is answered exactly as an id nobody has (got ${answer(realDel)} vs ${answer(ghostDel)})`);
        const [realEdit, ghostEdit] = [await edit(pk, secret.id, 'mine now'), await edit(pk, ghost, 'mine now')];
        assert(answer(realEdit) === answer(ghostEdit),
            `${who} editing one is answered the same way (got ${answer(realEdit)} vs ${answer(ghostEdit)})`);
        const [realReact, ghostReact] = [await react(pk, secret.id), await react(pk, ghost)];
        assert(answer(realReact) === answer(ghostReact),
            `${who} reacting to one is answered the same way (got ${answer(realReact)} vs ${answer(ghostReact)})`);
    }
    assert(rowOf(secret.id).type === 'text' && !metaOf(secret.id).reactions && !rowOf(secret.id).edited_at,
        'and none of that touched the message');
    assert((await del(bob, secret.id)).body?.success === true, 'while its author, who is in the group, still takes it down');

    // The throttle: changing a line in a room fans out to every member, so it is counted like sending one.
    resetChatRateLimit();
    const frank = makeMember('Frank');
    joinGroup(crew.id, frank); approveGroupMember(crew.id, alice, frank);
    const franksLine = postGroupThreadMessage(cb, crew.id, frank, 'a line of my own');
    let braked = 0;
    for (let i = 0; i < CHAT_LINES_PER_MINUTE + 1; i++) {
        if (statusOf(await react(frank, franksLine.id)) === 429) braked++;
    }
    assert(braked === 1, `only the ${CHAT_LINES_PER_MINUTE + 1}th room write in a minute is braked (got ${braked})`);
    assert(statusOf(await edit(frank, franksLine.id, 'still braked')) === 429,
        'and edits, reactions and deletes share the one bucket — the chat bucket the group send route uses');
    // A DM is not a room: its fan-out is the other phone, so it keeps the DM rules.
    const franksDm = createConversation('dm', [frank, bob], frank)!;
    const franksDmMsg = sendEngine(cb, franksDm.id, frank, b64('hello'), 'dm-nonce-frank')!;
    assert((await del(frank, franksDmMsg.id)).body?.success === true, 'while a DM write goes through the brake untouched');
    resetChatRateLimit();
    assert((await del(frank, franksLine.id)).body?.success === true, 'and the next window lets the room write through again');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
