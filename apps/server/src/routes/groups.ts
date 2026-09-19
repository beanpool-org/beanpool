/**
// Groups and Convenor Moderation routes.
// Docs: docs/the-commons.md §9 (Item 10)
//
// A group is an audience scope and NOTHING else:
// - It holds no money, grants no trust, confers no node role, and is never linked to an enterprise.
// - Separate role table: group_members (convenor | member | observer).
// - Join policies: open | request_to_join | invite_only.
*/

import Router from '@koa/router';
import crypto from 'node:crypto';
import {
    createGroup,
    getGroup,
    listGroups,
    getGroupMembers,
    getGroupMember,
    joinGroup,
    setMemberRole,
    removeGroupMember,
    updateGroup,
    updateGroupPolicy,
    approveGroupMember,
    inviteGroupMember,
    deleteGroupPost,
    getGroupsVersion,
    isGroupConvenor,
    getGroupThread,
    postGroupThreadMessage,
    removeGroupThreadMessage,
    proposeGroupConvenor,
    voteGroupConvenor,
    getGroupSuccession,
    listYourChats,
    canReadGroupThread,
} from '../state-engine.js';
import { db } from '../db/db.js';
import type { RouteDeps } from './types.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createGroupRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset } = deps;

    function requireAuth(ctx: any): string | null {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return null;
        }
        return actor;
    }

    /**
     * Refuse someone who is not an active member of the group. An invite-only group answers 404, exactly as if it
     * did not exist, unless the caller has a live relationship with it (an invitation, a request) — the #828 rule
     * that invite-only groups stay hidden from outsiders. Returns true when the caller may go on.
     */
    function requireGroupMember(ctx: any, groupId: string, actor: string): boolean {
        if (canReadGroupThread(groupId, actor)) return true;
        const g = db.prepare('SELECT join_policy FROM groups WHERE id = ?').get(groupId) as { join_policy: string } | undefined;
        const related = !!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status != 'removed'")
            .get(groupId, actor);
        if (!g || (g.join_policy === 'invite_only' && !related)) {
            ctx.status = 404;
            ctx.body = { error: 'Group not found' };
            return false;
        }
        ctx.status = 403;
        ctx.body = { error: 'Only members of this group can open its chat' };
        return false;
    }

    /** Refusals from the group chat and succession engines, as statuses. */
    function groupChatStatus(msg: string): number {
        if (msg === 'This vote has closed' || msg.includes('already open') || msg.includes('already voted')) return 409;
        if (msg.includes('not found') || msg.includes('Not found')) return 404;
        if (msg.includes('Only') || msg.includes('Observers') || msg.includes('disabled') || msg.includes('suspended')
            || msg.includes('pruned') || msg.includes('closed') || msg.includes('Frozen') || msg.includes('invalidated')) return 403;
        return 400;
    }

    // ===================== YOUR GROUPS (decisions 6, 7, 13) =====================

    // Every group-like chat the caller is in — their groups, the enterprises they keep (🥖), the events they host
    // or are Going to (📅) — with the latest message and their unread count. Never anyone else's.
    router.get('/api/your-groups', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = listYourChats(actor);
    });

    // ===================== GROUPS API =====================

    // 1. List groups
    router.get('/api/groups', async (ctx) => {
        const category = ctx.query.category as string | undefined;
        const q = ctx.query.q as string | undefined;
        const member = ctx.query.member as string | undefined;
        const limit = clampLimit(ctx.query.limit);
        const offset = clampOffset(ctx.query.offset);
        const viewerPubkey = ctx.state?.actor as string | undefined;

        const queryPart = `${ctx.querystring || ''}:${viewerPubkey || ''}`;
        const queryHash = crypto.createHash('sha256').update(queryPart).digest('hex').slice(0, 8);
        const etag = `W/"groups-${getGroupsVersion()}-${queryHash}"`;

        ctx.set('ETag', etag);
        ctx.set('Cache-Control', 'private, max-age=0, must-revalidate');

        const ifNoneMatch = typeof ctx.get === 'function' ? ctx.get('If-None-Match') : ctx.headers?.['if-none-match'];
        if (ifNoneMatch) {
            const cleanEtag = etag.replace(/^W\//, '');
            const tags = ifNoneMatch.split(',').map((t: string) => t.trim().replace(/^W\//, ''));
            if (tags.includes(cleanEtag) || tags.includes('*')) {
                ctx.status = 304;
                return;
            }
        }

        const groups = listGroups({ category, query: q, memberPubkey: member, limit, offset }, viewerPubkey);
        ctx.status = 200;
        ctx.type = 'application/json';
        ctx.body = groups;
    });

    // 2. Get group by ID or slug
    router.get('/api/groups/:id', async (ctx) => {
        const viewerPubkey = ctx.state?.actor as string | undefined;
        const group = getGroup(ctx.params.id, viewerPubkey);
        if (!group) {
            ctx.status = 404;
            ctx.body = { error: 'Group not found' };
            return;
        }
        ctx.status = 200;
        ctx.body = group;
    });

    // 3. Create a group
    router.post('/api/groups', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        const body = (ctx as any).requestBody || {};
        const { name, slug, description, avatarUrl, category, joinPolicy } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            ctx.status = 400;
            ctx.body = { error: 'name is required' };
            return;
        }

        try {
            const group = createGroup({
                name: name.trim(),
                slug: slug?.trim(),
                description: description?.trim(),
                avatarUrl,
                category,
                joinPolicy,
                createdBy: actor
            });
            ctx.status = 201;
            ctx.body = group;
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to create group' };
        }
    });

    // 4. Join a group (or request to join / accept invite)
    router.post('/api/groups/:id/join', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        try {
            const member = joinGroup(ctx.params.id, actor);
            ctx.status = 200;
            ctx.body = { success: true, member };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to join group' };
        }
    });

    // 5. Get group members
    router.get('/api/groups/:id/members', async (ctx) => {
        const status = ctx.query.status as any;
        const role = ctx.query.role as any;
        const viewerPubkey = ctx.state?.actor as string | undefined;
        const isConvenor = Boolean(viewerPubkey && isGroupConvenor(ctx.params.id, viewerPubkey));
        if (status && status !== 'active') {
            if (!isConvenor) {
                ctx.status = 403;
                ctx.body = { error: 'Only convenors can view pending or invited members' };
                return;
            }
        }

        const effectiveStatus = status ? (status === 'all' ? undefined : status) : (isConvenor ? undefined : 'active');
        const members = getGroupMembers(ctx.params.id, { status: effectiveStatus, role });
        ctx.status = 200;
        ctx.body = members;
    });

    // 6. Invite a member or approve pending request (Convenor only)
    router.post('/api/groups/:id/members', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        const body = (ctx as any).requestBody || {};
        const memberPubkey = body.targetPubkey || body.memberPubkey;

        if (!memberPubkey) {
            ctx.status = 400;
            ctx.body = { error: 'targetPubkey or memberPubkey is required' };
            return;
        }

        const { role, action } = body;

        try {
            if (action === 'approve') {
                const member = approveGroupMember(ctx.params.id, actor, memberPubkey);
                ctx.status = 200;
                ctx.body = { success: true, member };
            } else {
                const member = inviteGroupMember(ctx.params.id, actor, memberPubkey, role || 'member');
                ctx.status = 200;
                ctx.body = { success: true, member };
            }
        } catch (e: any) {
            const status = e.message?.includes('UNAUTHORIZED') ? 403 : 400;
            ctx.status = status;
            ctx.body = { error: e.message || 'Failed to update member' };
        }
    });

    // 7. Update member role (Convenor only)
    router.patch('/api/groups/:id/members/:pubkey', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        const body = (ctx as any).requestBody || {};
        const { role } = body;

        if (!role) {
            ctx.status = 400;
            ctx.body = { error: 'role is required' };
            return;
        }

        try {
            const member = setMemberRole(ctx.params.id, actor, ctx.params.pubkey, role);
            ctx.status = 200;
            ctx.body = { success: true, member };
        } catch (e: any) {
            const status = e.message?.includes('UNAUTHORIZED') ? 403 : 400;
            ctx.status = status;
            ctx.body = { error: e.message || 'Failed to change member role' };
        }
    });

    // 8. Remove member (Convenor or self)
    router.delete('/api/groups/:id/members/:pubkey', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        try {
            const removed = removeGroupMember(ctx.params.id, actor, ctx.params.pubkey);
            ctx.status = 200;
            ctx.body = { success: removed };
        } catch (e: any) {
            const status = e.message?.includes('UNAUTHORIZED') ? 403 : 400;
            ctx.status = status;
            ctx.body = { error: e.message || 'Failed to remove member' };
        }
    });

    // 9. Update group details or policy (Convenor only)
    router.patch('/api/groups/:id', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        const body = (ctx as any).requestBody || {};
        const { name, description, avatarUrl, category, joinPolicy } = body;

        try {
            let group;
            if (joinPolicy && !name && !description && !avatarUrl && !category) {
                group = updateGroupPolicy(ctx.params.id, actor, joinPolicy);
            } else {
                group = updateGroup(ctx.params.id, actor, { name, description, avatarUrl, category, joinPolicy });
            }
            ctx.status = 200;
            ctx.body = { success: true, group };
        } catch (e: any) {
            const status = e.message?.includes('UNAUTHORIZED') ? 403 : 400;
            ctx.status = status;
            ctx.body = { error: e.message || 'Failed to update group' };
        }
    });

    // 11. The group's chat (decision 3): active members read; convenors and members post; convenors remove.
    router.get('/api/groups/:id/chat', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        const limit = Math.min(clampLimit(ctx.query.limit), 100);
        const offset = clampOffset(ctx.query.offset);
        try {
            ctx.body = getGroupThread(ctx.params.id, actor, limit, offset);
        } catch (e: any) {
            const msg = e?.message || 'Could not open the group chat';
            ctx.status = groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    router.post('/api/groups/:id/chat/message', async (ctx) => {
        // A row per call in a room that pushes to every member: throttled per IP like the event chat.
        if (!deps.rateLimit(ctx)) return;
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        const body = (ctx as any).requestBody || {};
        const text = typeof body.text === 'string' ? body.text : '';
        let clientId: string | undefined;
        if (body.clientId !== undefined && body.clientId !== null) {
            if (typeof body.clientId !== 'string' || !UUID_V4.test(body.clientId)) {
                ctx.status = 400;
                ctx.body = { error: 'clientId must be a UUID v4' };
                return;
            }
            clientId = body.clientId.toLowerCase();
        }
        if (!text.trim()) {
            ctx.status = 400;
            ctx.body = { error: 'Message text cannot be empty' };
            return;
        }
        try {
            const message = postGroupThreadMessage(ctx.params.id, actor, text, clientId);
            ctx.status = 201;
            ctx.body = { success: true, message };
        } catch (e: any) {
            const msg = e?.message || 'Could not post the message';
            ctx.status = e?.code === 'ID_CONFLICT' ? 409 : groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    router.post('/api/groups/:id/chat/remove', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        const body = (ctx as any).requestBody || {};
        const messageId = body.messageId;
        if (!messageId || typeof messageId !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'messageId is required' };
            return;
        }
        try {
            ctx.body = { success: true, message: removeGroupThreadMessage(ctx.params.id, messageId, actor) };
        } catch (e: any) {
            const msg = e?.message || 'Could not remove the message';
            ctx.status = groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    // 12. Convenor succession (answer B): only when the group's only convenor has been silent for 30 days.
    router.get('/api/groups/:id/succession', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        try {
            ctx.body = getGroupSuccession(ctx.params.id, actor);
        } catch (e: any) {
            const msg = e?.message || 'Could not load the convenor vote';
            ctx.status = groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    router.post('/api/groups/:id/succession/propose', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        const body = (ctx as any).requestBody || {};
        const candidate = body.candidatePubkey;
        if (!candidate || typeof candidate !== 'string') {
            ctx.status = 400;
            ctx.body = { error: 'candidatePubkey is required' };
            return;
        }
        try {
            const res = proposeGroupConvenor(ctx.params.id, actor, candidate);
            ctx.body = { success: true, ...res };
        } catch (e: any) {
            const msg = e?.message || 'Could not propose a convenor';
            ctx.status = groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    router.post('/api/groups/:id/succession/:proposalId/vote', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;
        if (!requireGroupMember(ctx, ctx.params.id, actor)) return;
        const body = (ctx as any).requestBody || {};
        const choice = body.choice;
        if (choice !== 'yes' && choice !== 'no') {
            ctx.status = 400;
            ctx.body = { error: "choice must be 'yes' or 'no'" };
            return;
        }
        const prop = db.prepare('SELECT group_id FROM group_convenor_proposals WHERE id = ?').get(ctx.params.proposalId) as any;
        if (!prop || prop.group_id !== ctx.params.id) {
            ctx.status = 404;
            ctx.body = { error: 'Convenor proposal not found' };
            return;
        }
        try {
            const res = voteGroupConvenor(ctx.params.proposalId, actor, choice);
            ctx.body = { success: true, ...res };
        } catch (e: any) {
            const msg = e?.message || 'Could not record the vote';
            ctx.status = groupChatStatus(msg);
            ctx.body = { error: msg };
        }
    });

    // 10. Convenor moderation: delete post in group
    router.delete('/api/groups/:id/posts/:postId', async (ctx) => {
        const actor = requireAuth(ctx);
        if (!actor) return;

        try {
            const deleted = deleteGroupPost(ctx.params.id, actor, ctx.params.postId);
            ctx.status = 200;
            ctx.body = { success: deleted };
        } catch (e: any) {
            const status = e.message?.includes('UNAUTHORIZED') ? 403 : 400;
            ctx.status = status;
            ctx.body = { error: e.message || 'Failed to delete group post' };
        }
    });

    return router;
}
