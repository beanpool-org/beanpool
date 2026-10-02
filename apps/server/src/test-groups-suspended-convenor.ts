/**
 * A suspended member's convenor powers rest while the suspension lasts — over a REAL HTTPS round trip, through the
 * signature middleware.
 *
 * FABLE-sec-roles (2026-10-01, MEDIUM): every group-convenor check read group_members and never the account, so a
 * convenor an admin had just suspended for harassment could still, from their phone, remove the members who reported
 * them, promote a friend, delete their posts, rename the group and hand its lead away. Only the group's chat was
 * closed to them.
 *
 * 1. Suspended (an admin's emergency suspension, the real path): every convenor action is refused 403 in words that
 *    say why — remove, promote, invite, approve, edit the group or its join policy, remove a group post (both
 *    routes), remove a chat message, edit or cancel someone else's group event and remove a line from its chat, list
 *    the group's requests, hand the lead over — and none of them writes anything. They also join no group, and no
 *    convenor approves a suspended member in. Their convenor role, and their group's lead, stay theirs.
 * 2. The group a suspended lead runs alone still works for its members: they chat, newcomers join the open group,
 *    and the 30-day-silence vote opens and runs, because nothing a suspended account signs counts as the lead coming
 *    back.
 * 3. The suspension lifted: the same calls work again, and the lead's next write is the lead coming back.
 * 4. A community Decision can't suspend or remove a node owner or admin (docs/the-commons.md §3.8): refused when it
 *    is proposed. A plain member still can be.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-groups-suspended-convenor.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, createPost, createGroup, joinGroup, inviteGroupMember, approveGroupMember,
    postGroupThreadMessage, postEventThreadMessage, getGroupLead, seedGenesisMember,
    adminEmergencySuspend, adminLiftSuspension,
} from './state-engine.js';
import { getConvenorSilence } from './engine/group-succession.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

type Id = { pk: string; key: crypto.KeyObject; name: string };
type Res = { status: number; error?: string; body: any };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), key: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
        VALUES (?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, name, daysAgo(90));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    transfer('genesis', id.pk, 100, `seed ${name}`, 'direct', true);
    createPost('offer', 'other', `${name}'s offer`, 'on the books', 5, 'fixed', id.pk);
    return id;
}

async function call(method: string, path: string, id: Id, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.key).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, error: json?.error, body: json };
}

const SUSPENDED_WORDS = /suspended/i;
const refused = (r: Res) => r.status === 403 && SUSPENDED_WORDS.test(r.error ?? '');
const show = (r: Res) => `${r.status} ${r.error ?? ''}`.trim();

const membership = (groupId: string, pk: string) =>
    db.prepare('SELECT role, status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(groupId, pk) as
        { role: string; status: string } | undefined;
const groupRow = (groupId: string) =>
    db.prepare('SELECT name, join_policy FROM groups WHERE id = ?').get(groupId) as { name: string; join_policy: string };
const postRow = (id: string) =>
    db.prepare('SELECT title, active, status, event_state FROM posts WHERE id = ?').get(id) as any;
const messageType = (id: string) => (db.prepare('SELECT type FROM messages WHERE id = ?').get(id) as any)?.type;
const lastActive = (pk: string) => (db.prepare('SELECT last_active_at FROM members WHERE public_key = ?').get(pk) as any)?.last_active_at;
const proposalStatus = (id: string) => (db.prepare('SELECT status FROM group_convenor_proposals WHERE id = ?').get(id) as any)?.status;

async function main(): Promise<void> {
    console.log("A suspended member's convenor powers rest while the suspension lasts (over HTTP)\n");
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const founder = keypair('FounderSC');
    seedGenesisMember(founder.pk, founder.name);
    const admin = makeMember('AdminSC');
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')`).run(admin.pk);
    const lead = makeMember('LeadSC');
    const susp = makeMember('SuspSC');          // a convenor who is about to be suspended
    const reporter = makeMember('ReporterSC');  // reported them
    const friend = makeMember('FriendSC');      // the one they would promote
    const asker = makeMember('AskerSC');        // asked to join, waiting
    const outsider = makeMember('OutsiderSC');  // nobody's invited them
    const newcomer = makeMember('NewcomerSC');

    // Group A: Mullum Gardeners, asks to join; led by LeadSC, with SuspSC one of its convenors.
    const ga = createGroup({ name: 'Mullum Gardeners SC', joinPolicy: 'request_to_join', createdBy: lead.pk } as any);
    for (const who of [reporter, friend]) { joinGroup(ga.id, who.pk); approveGroupMember(ga.id, lead.pk, who.pk); }
    inviteGroupMember(ga.id, lead.pk, susp.pk, 'convenor');
    joinGroup(ga.id, susp.pk);
    joinGroup(ga.id, asker.pk);
    const post = createPost('offer', 'tools', 'Spare rototiller', 'Reporter lends it', 5, 'fixed', reporter.pk,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: ga.id })!;
    const event = createPost('event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', reporter.pk,
        -28.55, 153.5, [], false, undefined, false,
        { audienceScope: 'group', targetGroupId: ga.id, eventStartAt: inHours(24), eventPlaceName: 'The hall' })!;
    const chatLine = postGroupThreadMessage(ga.id, reporter.pk, 'I reported SuspSC to the moderators');
    const eventLine = postEventThreadMessage(event.id, reporter.pk, 'See you at the hall');

    // Group B: open, run by SuspSC alone. FriendSC and ReporterSC have been in it 50 days; SuspSC last did anything 40
    // days ago, so the group's 30-day-silence vote is there to be opened.
    const gb = createGroup({ name: 'Susp Circle SC', joinPolicy: 'open', createdBy: susp.pk } as any);
    joinGroup(gb.id, friend.pk);
    joinGroup(gb.id, reporter.pk);
    db.prepare('UPDATE group_members SET joined_at = ?, role_since = ? WHERE group_id = ? AND member_pubkey != ?')
        .run(daysAgo(50), daysAgo(50), gb.id, susp.pk);
    db.prepare('UPDATE group_members SET joined_at = ?, role_since = ? WHERE group_id = ? AND member_pubkey = ?')
        .run(daysAgo(60), daysAgo(60), gb.id, susp.pk);
    const fortyDaysAgo = daysAgo(40);
    db.prepare('UPDATE members SET last_active_at = ? WHERE public_key = ?').run(fortyDaysAgo, susp.pk);

    // Group C: open, SuspSC not in it.
    const gc = createGroup({ name: 'Open Choir SC', joinPolicy: 'open', createdBy: lead.pk } as any);

    const A = `/api/groups/${encodeURIComponent(ga.id)}`;
    const B = `/api/groups/${encodeURIComponent(gb.id)}`;
    const C = `/api/groups/${encodeURIComponent(gc.id)}`;

    // ── 1. Suspended: every convenor action refused, nothing written ─────────────────────────────────────────────
    const suspension = adminEmergencySuspend(susp.pk, admin.pk, 'Harassing the members who reported them');
    assert(suspension.success === true, `the admin's emergency suspension goes through (${suspension.error ?? 'ok'})`);
    assert((db.prepare('SELECT status FROM members WHERE public_key = ?').get(susp.pk) as any)?.status === 'disabled',
        'SuspSC is suspended');
    console.log('\n— Suspended: SuspSC tries every convenor power —');

    const groupsBefore = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as any).n;
    const membersBefore = (db.prepare('SELECT COUNT(*) AS n FROM group_members').get() as any).n;
    let r = await call('POST', '/api/groups', susp, { name: 'Suspended Start SC', description: 'A group nobody can take down', joinPolicy: 'open' });
    assert(refused(r), `starting a group → 403, says suspended (${show(r)})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM groups').get() as any).n === groupsBefore
        && (db.prepare('SELECT COUNT(*) AS n FROM group_members').get() as any).n === membersBefore
        && !db.prepare("SELECT 1 FROM groups WHERE name = 'Suspended Start SC'").get(),
        'and no group row and no member row was written');

    r = await call('DELETE', `${A}/members/${reporter.pk}`, susp);
    assert(refused(r), `removing the member who reported them → 403, says suspended (${show(r)})`);
    assert(membership(ga.id, reporter.pk)?.status === 'active', 'and ReporterSC is still in the group');

    r = await call('PATCH', `${A}/members/${friend.pk}`, susp, { role: 'convenor' });
    assert(refused(r), `promoting a friend to convenor → 403, says suspended (${show(r)})`);
    assert(membership(ga.id, friend.pk)?.role === 'member', 'and FriendSC is still a member');

    r = await call('PATCH', `${A}/members/${susp.pk}`, susp, { role: 'member' });
    assert(refused(r), `changing their own role → 403, says suspended (${show(r)})`);

    r = await call('POST', `${A}/members`, susp, { targetPubkey: outsider.pk, role: 'convenor' });
    assert(refused(r), `inviting someone in as a convenor → 403, says suspended (${show(r)})`);
    assert(membership(ga.id, outsider.pk) === undefined, 'and no invitation was written');

    r = await call('POST', `${A}/members`, susp, { targetPubkey: asker.pk, action: 'approve' });
    assert(refused(r), `approving a request to join → 403, says suspended (${show(r)})`);
    assert(membership(ga.id, asker.pk)?.status === 'pending_approval', 'and the request is still waiting');

    r = await call('PATCH', A, susp, { name: 'Hijacked SC' });
    assert(refused(r), `renaming the group → 403, says suspended (${show(r)})`);
    r = await call('PATCH', A, susp, { joinPolicy: 'invite_only' });
    assert(refused(r), `changing who can join → 403, says suspended (${show(r)})`);
    assert(groupRow(ga.id).name === 'Mullum Gardeners SC' && groupRow(ga.id).join_policy === 'request_to_join',
        `and the group is unchanged (${JSON.stringify(groupRow(ga.id))})`);

    r = await call('DELETE', `${A}/posts/${post.id}`, susp);
    assert(refused(r), `removing a member's group post (group route) → 403, says suspended (${show(r)})`);
    r = await call('POST', '/api/marketplace/posts/remove', susp, { id: post.id, authorPublicKey: susp.pk });
    assert(refused(r), `removing it through the listings route → 403, says suspended (${show(r)})`);
    assert(postRow(post.id).active === 1, 'and the post is still up');

    r = await call('POST', '/api/marketplace/posts/remove', susp, { id: event.id, authorPublicKey: susp.pk });
    assert(refused(r), `cancelling a member's group event → 403, says suspended (${show(r)})`);
    r = await call('POST', '/api/marketplace/posts/update', susp, { id: event.id, authorPublicKey: susp.pk, title: 'Cancelled, go home' });
    assert(refused(r), `editing a member's group event → 403, says suspended (${show(r)})`);
    assert(postRow(event.id).title === 'Working bee' && postRow(event.id).event_state !== 'cancelled',
        `and the event is as its host left it (${JSON.stringify(postRow(event.id))})`);

    r = await call('POST', `${A}/chat/remove`, susp, { messageId: chatLine.id });
    assert(refused(r), `removing a line from the group's chat → 403, says suspended (${show(r)})`);
    assert(messageType(chatLine.id) === 'text', 'and the line is still there');
    r = await call('POST', `/api/marketplace/posts/${event.id}/chat/remove`, susp, { messageId: eventLine.id });
    assert(refused(r), `removing a line from the group event's chat → 403, says suspended (${show(r)})`);
    assert(messageType(eventLine.id) === 'text', 'and that line is still there');

    r = await call('GET', `${A}/members?status=pending_approval`, susp);
    assert(refused(r), `listing who asked to join → 403, says suspended (${show(r)})`);
    r = await call('GET', `${A}/members`, susp);
    assert(r.status === 200 && Array.isArray(r.body) && !r.body.some((m: any) => m.memberPubkey === asker.pk),
        `the plain roster still opens, without the requests a convenor sees (${r.status})`);

    r = await call('POST', `${B}/lead`, susp, { targetPubkey: friend.pk });
    assert(refused(r), `handing their own group's lead to a friend → 403, says suspended (${show(r)})`);
    assert(getGroupLead(gb.id) === susp.pk, 'and SuspSC still leads it');

    r = await call('POST', `${C}/join`, susp);
    assert(r.status === 403 && SUSPENDED_WORDS.test(r.error ?? ''), `joining an open group → 403, says suspended (${show(r)})`);
    assert(membership(gc.id, susp.pk) === undefined, 'and no membership was written');

    assert(membership(ga.id, susp.pk)?.role === 'convenor' && membership(ga.id, susp.pk)?.status === 'active',
        'SuspSC keeps their convenor role in Mullum Gardeners');
    assert(membership(gb.id, susp.pk)?.role === 'convenor' && getGroupLead(gb.id) === susp.pk,
        'and stays the lead of the group they run');

    // ── 2. The group they lead alone still works for its members ───────────────────────────────────────────────────
    console.log('\n— The group a suspended lead runs alone carries on —');
    assert(lastActive(susp.pk) === fortyDaysAgo, `none of those signed calls counted as the lead being active (${lastActive(susp.pk)})`);
    r = await call('POST', `${B}/chat/message`, friend, { text: 'Carrying on without our convenor for now' });
    assert(r.status === 201, `a member chats in the group (${show(r)})`);
    r = await call('POST', `${B}/join`, newcomer);
    assert(r.status === 200 && membership(gb.id, newcomer.pk)?.status === 'active', `a newcomer joins the open group (${show(r)})`);
    const silence = getConvenorSilence(gb.id);
    assert(silence.isSilent && silence.isEligible, `the 30-day-silence vote can open (${JSON.stringify({ s: silence.isSilent, e: silence.isEligible })})`);
    r = await call('POST', `${B}/succession/propose`, friend, { candidatePubkey: friend.pk });
    const proposalId = r.body?.proposal?.id ?? r.body?.proposalId ?? r.body?.id;
    assert(r.status === 200 && typeof proposalId === 'string', `a member proposes a new lead (${show(r)})`);
    r = await call('PATCH', `${B}/members/${friend.pk}`, susp, { role: 'observer' });
    assert(refused(r), `the suspended lead demoting the proposer → 403 (${show(r)})`);
    assert(proposalStatus(proposalId) === 'active', `and their signed call does not cancel the vote (${proposalStatus(proposalId)})`);
    assert(lastActive(susp.pk) === fortyDaysAgo, 'nor count as the lead being active');

    // ── 3. The suspension lifted: the powers come back ────────────────────────────────────────────────────────────
    console.log('\n— Suspension lifted —');
    const lifted = adminLiftSuspension(susp.pk, admin.pk);
    assert(lifted.success === true, `the admin lifts the suspension (${lifted.error ?? 'ok'})`);

    r = await call('POST', '/api/groups', susp, { name: 'Suspended Start SC', description: 'Allowed again', joinPolicy: 'open' });
    assert(r.status === 201 && membership(r.body?.id, susp.pk)?.role === 'convenor', `starting a group works again (${show(r)})`);

    r = await call('PATCH', `${A}/members/${friend.pk}`, susp, { role: 'convenor' });
    assert(r.status === 200 && membership(ga.id, friend.pk)?.role === 'convenor', `promoting works again (${show(r)})`);
    assert(proposalStatus(proposalId) === 'cancelled', `and that first write is the lead coming back: the vote closes (${proposalStatus(proposalId)})`);
    r = await call('GET', `${A}/members?status=pending_approval`, susp);
    assert(r.status === 200 && Array.isArray(r.body) && r.body.some((m: any) => m.memberPubkey === asker.pk),
        `listing the requests works again (${show(r)})`);
    r = await call('POST', `${A}/members`, susp, { targetPubkey: asker.pk, action: 'approve' });
    assert(r.status === 200 && membership(ga.id, asker.pk)?.status === 'active', `approving works again (${show(r)})`);
    r = await call('POST', `${A}/members`, susp, { targetPubkey: outsider.pk, role: 'member' });
    assert(r.status === 200 && membership(ga.id, outsider.pk)?.status === 'invited', `inviting works again (${show(r)})`);
    r = await call('PATCH', A, susp, { name: 'Mullum Gardeners Renamed SC' });
    assert(r.status === 200 && groupRow(ga.id).name === 'Mullum Gardeners Renamed SC', `renaming works again (${show(r)})`);
    r = await call('PATCH', A, susp, { joinPolicy: 'open' });
    assert(r.status === 200 && groupRow(ga.id).join_policy === 'open', `changing who can join works again (${show(r)})`);
    r = await call('POST', `${A}/chat/remove`, susp, { messageId: chatLine.id });
    assert(r.status === 200 && messageType(chatLine.id) === 'removed', `removing a chat line works again (${show(r)})`);
    r = await call('POST', '/api/marketplace/posts/update', susp, { id: event.id, authorPublicKey: susp.pk, title: 'Working bee, moved' });
    assert(r.status === 200 && postRow(event.id).title === 'Working bee, moved', `editing the group's event works again (${show(r)})`);
    r = await call('POST', `/api/marketplace/posts/${event.id}/chat/remove`, susp, { messageId: eventLine.id });
    assert(r.status === 200 && messageType(eventLine.id) === 'removed', `removing an event chat line works again (${show(r)})`);
    r = await call('DELETE', `${A}/posts/${post.id}`, susp);
    assert(r.status === 200 && r.body?.success === true && postRow(post.id).active === 0, `removing a group post works again (${show(r)})`);
    r = await call('DELETE', `${A}/members/${reporter.pk}`, susp);
    assert(r.status === 200 && membership(ga.id, reporter.pk)?.status === 'removed', `removing a member works again (${show(r)})`);
    r = await call('POST', `${C}/join`, susp);
    assert(r.status === 200 && membership(gc.id, susp.pk)?.status === 'active', `joining an open group works again (${show(r)})`);
    r = await call('POST', `${B}/lead`, susp, { targetPubkey: friend.pk });
    assert(r.status === 200 && getGroupLead(gb.id) === friend.pk, `handing the lead over works again (${show(r)})`);

    // ── 3b. Nor does a convenor's approval let a suspended member in ──────────────────────────────────────────────
    console.log('\n— A suspended member is not approved into a group either —');
    const waiter = makeMember('WaiterSC');
    const gd = createGroup({ name: 'Asking Circle SC', joinPolicy: 'request_to_join', createdBy: lead.pk } as any);
    const D = `/api/groups/${encodeURIComponent(gd.id)}`;
    joinGroup(gd.id, waiter.pk);
    const waiterSuspension = adminEmergencySuspend(waiter.pk, admin.pk, 'Suspended while their request waited');
    assert(waiterSuspension.success === true, `WaiterSC is suspended while their request waits (${waiterSuspension.error ?? 'ok'})`);
    r = await call('POST', `${D}/members`, lead, { targetPubkey: waiter.pk, action: 'approve' });
    assert(r.status === 400 && SUSPENDED_WORDS.test(r.error ?? ''), `the lead approving their request → refused, says suspended (${show(r)})`);
    r = await call('POST', `${D}/members`, lead, { targetPubkey: waiter.pk, role: 'member' });
    assert(r.status === 400 && SUSPENDED_WORDS.test(r.error ?? ''), `nor let in by an invitation to someone who asked (${show(r)})`);
    assert(membership(gd.id, waiter.pk)?.status === 'pending_approval', 'and the request still waits');
    assert(adminLiftSuspension(waiter.pk, admin.pk).success === true, 'their suspension is lifted');
    r = await call('POST', `${D}/members`, lead, { targetPubkey: waiter.pk, action: 'approve' });
    assert(r.status === 200 && membership(gd.id, waiter.pk)?.status === 'active', `and the lead approves them (${show(r)})`);

    // ── 4. A community Decision can't suspend or remove a node owner or admin (§3.8) ─────────────────────────────
    console.log('\n— Decisions and node owners and admins —');
    const coOwner = makeMember('CoOwnerSC');
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', ?)`).run(coOwner.pk, admin.pk);
    const nodeAdmin = makeMember('NodeAdminSC');
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', ?)`).run(nodeAdmin.pk, admin.pk);
    const openDecisions = () => (db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE effect IN ('suspend_member', 'remove_member')").get() as any).c;
    const before = openDecisions();
    for (const [subject, effect, what] of [
        [coOwner, 'remove_member', 'remove one of two owners'],
        [coOwner, 'suspend_member', 'suspend one of two owners'],
        [nodeAdmin, 'remove_member', 'remove an admin'],
        [nodeAdmin, 'suspend_member', 'suspend an admin'],
    ] as const) {
        r = await call('POST', '/api/commons/decisions', admin, {
            title: `Vote to ${what}`, description: 'They should not run the server any more', touches: 'member', effect, subject: subject.pk,
        });
        assert(r.status === 400 && /owner|admin/i.test(r.error ?? ''), `a Decision to ${what} is refused when proposed (${show(r)})`);
    }
    assert(openDecisions() === before, 'and no such Decision was opened');
    r = await call('POST', '/api/commons/decisions', admin, {
        title: 'Vote to suspend LeadSC', description: 'A plain member, as any other', touches: 'member', effect: 'suspend_member', subject: lead.pk,
    });
    assert(r.status === 200 && r.body?.decision?.effect === 'suspend_member', `a Decision to suspend a plain member still opens (${show(r)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => {
    console.error('✗ FAIL: suite crashed', err);
    process.exit(1);
});
