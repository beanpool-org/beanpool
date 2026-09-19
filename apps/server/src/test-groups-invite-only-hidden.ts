/**
 * Invite-only groups stay hidden from outsiders on EVERY route (the #828 rule, extended past GET /api/groups).
 *
 * #828 stopped the group list advertising an invite_only group to anyone without a group_members row for it. The
 * by-id routes kept answering: GET /api/groups/:id handed an outsider the name, description, convenor and member
 * count, GET /members handed them the roster, and the write routes answered 403/400 for a hidden group but 403/400
 * with different words for an id nobody has — so any of them confirmed the group exists.
 *
 * Every route that names a group is exercised as: an outsider, an invited person (not yet joined), a pending
 * applicant, an active member, a removed member, a node admin who is not in the group, and signed-out. An
 * outsider, a removed member, the admin and (where the route is open to them) signed-out get the SAME 404 as an
 * id that does not exist. The invitee gets the group card — the invite landing — and nothing more.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import {
    initStateEngine, createGroup, inviteGroupMember, joinGroup, removeGroupMember, updateGroupPolicy, createPost,
} from './state-engine.js';
import { createGroupRoutes } from './routes/groups.js';
import { createMarketplaceRoutes } from './routes/marketplace.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, earned_credit, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pub, `${callsign}_${crypto.randomBytes(3).toString('hex')}`, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    // An offer on the books, so posting (the covenant) is never what refuses them.
    createPost('offer', 'other', `${callsign}'s offer`, 'covenant', 10, 'fixed', pub, undefined, undefined, [], false);
    return pub;
}

const deps: any = {
    checkAdminAuth: async () => true,
    rateLimit: () => true,
    clampLimit: (n: any) => Number(n) || 50,
    clampOffset: (n: any) => Number(n) || 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

async function call(router: any, method: string, path: string, actor: string | undefined, body?: any, query: any = {}) {
    const ctx: any = {
        method, path, url: path, request: {}, query, querystring: '',
        state: actor ? { actor } : {},
        requestBody: body,
        headers: {},
        set: () => {},
        get: () => '',
    };
    await router.routes()(ctx, async () => {});
    return ctx;
}

async function main() {
    console.log('🧪 Invite-only groups stay hidden on every route\n');
    await initStateEngine();
    const groups = createGroupRoutes(deps);
    const market = createMarketplaceRoutes(deps);

    const convenor = makeMember('Convenor');
    const member = makeMember('Member');
    const invitee = makeMember('Invitee');
    const applicant = makeMember('Applicant');
    const removed = makeMember('Removed');
    const outsider = makeMember('Outsider');
    const admin = makeMember('NodeOwner');
    db.prepare("INSERT INTO node_roles (member_pubkey, role) VALUES (?, 'owner')").run(admin);

    // Built as request_to_join so an applicant can ask, then closed to invite_only: a pending request survives the
    // switch and is a live relationship, like an invitation.
    const g = createGroup({ name: 'Quiet Circle', slug: 'quiet-circle', description: 'Nobody outside knows', joinPolicy: 'request_to_join', createdBy: convenor });
    joinGroup(g.id, applicant);
    updateGroupPolicy(g.id, convenor, 'invite_only');
    inviteGroupMember(g.id, convenor, member, 'member');
    joinGroup(g.id, member);
    inviteGroupMember(g.id, convenor, removed, 'member');
    joinGroup(g.id, removed);
    removeGroupMember(g.id, convenor, removed);
    inviteGroupMember(g.id, convenor, invitee, 'member');
    const post = createPost('offer', 'other', 'Circle-only offer', 'for the circle', 5, 'fixed', member,
        undefined, undefined, [], false, undefined, false, { audienceScope: 'group', targetGroupId: g.id });
    assert(!!post, 'setup: a group-only post exists');

    const status = (pk: string) => (db.prepare('SELECT status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g.id, pk) as any)?.status;
    assert(status(invitee) === 'invited' && status(applicant) === 'pending_approval' && status(member) === 'active'
        && status(removed) === 'removed' && !status(outsider) && !status(admin), 'setup: every relationship is as described');

    const ghost = crypto.randomUUID();
    const HIDDEN = [['an outsider', outsider], ['a removed member', removed], ['a node admin not in the group', admin]] as const;
    const notFound = (ctx: any) => ctx.status === 404 && ctx.body?.error === 'Group not found';

    // --- The control: an id nobody has. Every hidden answer below must look exactly like this. ---
    for (const [method, path, body] of [
        ['GET', `/api/groups/${ghost}`], ['GET', `/api/groups/${ghost}/members`], ['POST', `/api/groups/${ghost}/join`],
        ['POST', `/api/groups/${ghost}/members`, { memberPubkey: outsider }],
        ['PATCH', `/api/groups/${ghost}/members/${member}`, { role: 'observer' }],
        ['DELETE', `/api/groups/${ghost}/members/${member}`], ['PATCH', `/api/groups/${ghost}`, { description: 'x' }],
        ['DELETE', `/api/groups/${ghost}/posts/${post!.id}`], ['GET', `/api/groups/${ghost}/chat`], ['GET', `/api/groups/${ghost}/succession`],
    ] as const) {
        const res = await call(groups, method, path, outsider, body);
        assert(notFound(res), `control: ${method} ${path.replace(ghost, ':unknown')} answers 404 "Group not found" (got ${res.status})`);
    }

    // --- GET /api/groups (the #828 list) ---
    {
        const listed = async (pk?: string) => ((await call(groups, 'GET', '/api/groups', pk)).body as any[]).some(x => x.id === g.id);
        for (const [who, pk] of HIDDEN) assert(!(await listed(pk)), `list: ${who} is not shown the group`);
        assert(!(await listed(undefined)), 'list: signed-out is not shown the group');
        assert(await listed(invitee), 'list: the invitee is shown it');
        assert(await listed(applicant), 'list: the applicant is shown it');
        assert(await listed(member), 'list: a member is shown it');
        const byMember = await call(groups, 'GET', '/api/groups', outsider, undefined, { member: convenor });
        assert(!(byMember.body as any[]).some(x => x.id === g.id), "list: ?member=<convenor> does not reveal the convenor's hidden group to an outsider");
    }

    // --- GET /api/groups/:id (by id and by slug) ---
    for (const ref of [g.id, g.slug]) {
        const label = ref === g.id ? 'by id' : 'by slug';
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, 'GET', `/api/groups/${ref}`, pk)), `GET /:id ${label}: ${who} gets 404`);
        assert(notFound(await call(groups, 'GET', `/api/groups/${ref}`, undefined)), `GET /:id ${label}: signed-out gets 404`);
        const inv = await call(groups, 'GET', `/api/groups/${ref}`, invitee);
        assert(inv.status === 200 && inv.body?.name === 'Quiet Circle' && inv.body?.viewerStatus === 'invited',
            `GET /:id ${label}: the invitee sees the group card for the invite landing`);
        const app = await call(groups, 'GET', `/api/groups/${ref}`, applicant);
        assert(app.status === 200 && app.body?.viewerStatus === 'pending_approval', `GET /:id ${label}: the applicant sees their request`);
        const mem = await call(groups, 'GET', `/api/groups/${ref}`, member);
        assert(mem.status === 200 && mem.body?.viewerRole === 'member', `GET /:id ${label}: a member sees it`);
    }

    // --- GET /api/groups/:id/members ---
    {
        const path = `/api/groups/${g.id}/members`;
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, 'GET', path, pk)), `members: ${who} gets 404`);
        assert(notFound(await call(groups, 'GET', path, undefined)), 'members: signed-out gets 404');
        const inv = await call(groups, 'GET', path, invitee);
        assert(inv.status === 403 && !Array.isArray(inv.body), 'members: the invitee is refused the roster (403, no list)');
        const app = await call(groups, 'GET', path, applicant);
        assert(app.status === 403 && !Array.isArray(app.body), 'members: the applicant is refused the roster (403, no list)');
        const mem = await call(groups, 'GET', path, member);
        assert(mem.status === 200 && (mem.body as any[]).some(m => m.memberPubkey === convenor), 'members: a member sees the roster');
        const conv = await call(groups, 'GET', path, convenor, undefined, { status: 'invited' });
        assert(conv.status === 200 && (conv.body as any[]).some(m => m.memberPubkey === invitee), 'members: the convenor still sees the invitations');
    }

    // --- Convenor-only and self writes: POST /members, PATCH /members/:pk, DELETE /members/:pk, PATCH /:id, DELETE /posts/:postId ---
    const writes = [
        ['POST', `/api/groups/${g.id}/members`, { memberPubkey: outsider }, 'invite'],
        ['PATCH', `/api/groups/${g.id}/members/${member}`, { role: 'observer' }, 'change a role'],
        ['DELETE', `/api/groups/${g.id}/members/${convenor}`, undefined, 'remove someone else'],
        ['PATCH', `/api/groups/${g.id}`, { description: 'renamed by a stranger' }, 'edit the group'],
        ['DELETE', `/api/groups/${g.id}/posts/${post!.id}`, undefined, 'delete a group post'],
    ] as const;
    for (const [method, path, body, what] of writes) {
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, method, path, pk, body)), `${what}: ${who} gets 404`);
        assert((await call(groups, method, path, undefined, body)).status === 401, `${what}: signed-out gets 401`);
        assert((await call(groups, method, path, invitee, body)).status === 403, `${what}: the invitee gets 403`);
        assert((await call(groups, method, path, member, body)).status === 403, `${what}: a member (not convenor) gets 403`);
    }
    assert(status(member) === 'active' && (db.prepare('SELECT description FROM groups WHERE id = ?').get(g.id) as any).description === 'Nobody outside knows',
        'writes: nothing above changed the group');

    // --- The chat and the convenor vote (already under groupChatRefusal; the removed member and admin cases pinned here) ---
    for (const sub of ['chat', 'succession']) {
        const path = `/api/groups/${g.id}/${sub}`;
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, 'GET', path, pk)), `${sub}: ${who} gets 404`);
        assert((await call(groups, 'GET', path, undefined)).status === 401, `${sub}: signed-out gets 401`);
        assert((await call(groups, 'GET', path, invitee)).status === 403, `${sub}: the invitee gets 403`);
        const res = await call(groups, 'GET', path, member);
        // These routes set only a body and let Koa default the status to 200; this bare ctx has no Koa to do it.
        assert((res.status ?? 200) === 200 && res.body && !res.body.error, `${sub}: a member gets 200`);
    }
    {
        const path = `/api/groups/${g.id}/chat/message`;
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, 'POST', path, pk, { text: 'hello?' })), `chat post: ${who} gets 404`);
    }

    // --- Posts with the group as audience ---
    {
        const q = { targetGroupId: g.id };
        const sees = async (pk?: string) => {
            const res = await call(market, 'GET', '/api/marketplace/posts', pk, undefined, q);
            return JSON.parse(res.body as string).some((p: any) => p.id === post!.id);
        };
        for (const [who, pk] of HIDDEN) assert(!(await sees(pk)), `posts ?targetGroupId: ${who} sees nothing`);
        assert(!(await sees(undefined)), 'posts ?targetGroupId: signed-out sees nothing');
        assert(!(await sees(invitee)), 'posts ?targetGroupId: the invitee sees nothing until they join');
        assert(await sees(member), 'posts ?targetGroupId: a member sees the post');
        const byId = await call(market, 'GET', '/api/marketplace/posts', outsider, undefined, { id: post!.id });
        assert(JSON.parse(byId.body as string).length === 0, 'posts ?id: an outsider cannot fetch the group post by id');
    }

    // --- Posting to the group: the refusal must not confirm it exists ---
    {
        const attempt = async (pk: string, groupId: string) => {
            const res = await call(market, 'POST', '/api/marketplace/posts', pk, {
                type: 'offer', title: 'Probe', authorPublicKey: pk, audienceScope: 'group', targetGroupId: groupId,
            });
            return `${res.status} ${res.body?.error}`;
        };
        const control = await attempt(outsider, ghost);
        for (const [who, pk] of HIDDEN) {
            assert((await attempt(pk, g.id)) === control, `post to group: ${who} gets the same answer as for an unknown group (${control})`);
        }
        assert(/UNAUTHORIZED/.test(await attempt(invitee, g.id)), 'post to group: the invitee is told they must be a member');
    }

    // --- POST /:id/join — last, since the invitee's call accepts the invitation ---
    {
        const path = `/api/groups/${g.id}/join`;
        for (const [who, pk] of HIDDEN) assert(notFound(await call(groups, 'POST', path, pk)), `join: ${who} gets 404`);
        assert(status(removed) === 'removed' && !status(outsider) && !status(admin), 'join: none of them gained a row');
        assert((await call(groups, 'POST', path, undefined)).status === 401, 'join: signed-out gets 401');
        const mem = await call(groups, 'POST', path, member);
        assert(mem.status === 200 && mem.body?.member?.status === 'active', 'join: a member joining again is a no-op 200');
        const inv = await call(groups, 'POST', path, invitee);
        assert(inv.status === 200 && inv.body?.member?.status === 'active', 'join: the invitee accepts their invitation');
    }

    // --- Someone who LEFT on their own has no row at all: an outsider again ---
    {
        const leave = await call(groups, 'DELETE', `/api/groups/${g.id}/members/${invitee}`, invitee);
        assert(leave.status === 200, 'leave: the new member leaves');
        assert(notFound(await call(groups, 'GET', `/api/groups/${g.id}`, invitee)), 'leave: after leaving, the group is 404 to them');
    }

    // --- Open and request_to_join groups are unaffected ---
    {
        const open = createGroup({ name: 'Open Garden', joinPolicy: 'open', createdBy: convenor });
        const card = await call(groups, 'GET', `/api/groups/${open.id}`, undefined);
        assert(card.status === 200, 'open group: signed-out still sees the card');
        const roster = await call(groups, 'GET', `/api/groups/${open.id}/members`, undefined);
        assert(roster.status === 200 && Array.isArray(roster.body), 'open group: signed-out still sees the active roster');
        const edit = await call(groups, 'PATCH', `/api/groups/${open.id}`, outsider, { description: 'x' });
        assert(edit.status === 403, 'open group: an outsider editing it is still a plain 403');
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('✗ FAIL: suite crashed', err);
    process.exit(1);
});
