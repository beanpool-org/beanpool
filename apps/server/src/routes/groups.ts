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
    isGroupConvenor
} from '../state-engine.js';
import type { RouteDeps } from './types.js';

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

        if (status && status !== 'active') {
            if (!viewerPubkey || !isGroupConvenor(ctx.params.id, viewerPubkey)) {
                ctx.status = 403;
                ctx.body = { error: 'Only convenors can view pending or invited members' };
                return;
            }
        }

        const members = getGroupMembers(ctx.params.id, { status: status || 'active', role });
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
