/**
 * Groups, Working Groups & Enterprise Teams routes.
 */

import Router from '@koa/router';
import {
    createGroup,
    getGroup,
    listGroups,
    getGroupMembers,
    joinGroup,
    setMemberRole,
    removeGroupMember,
    isGroupSteward
} from '@beanpool/engine';
import { db } from '../db/db.js';
import type { RouteDeps } from './types.js';

export function createGroupRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { clampLimit, clampOffset, broadcast, checkAdminAuth } = deps;

    // GET /api/groups — List groups with counts
    router.get('/api/groups', async (ctx) => {
        const category = ctx.query.category as string | undefined;
        const memberPubkey = ctx.query.member as string | undefined;
        const search = ctx.query.q as string | undefined;
        const limit = clampLimit(ctx.query.limit, 50);
        const offset = clampOffset(ctx.query.offset);
        const viewerPubkey = ctx.state.actor as string | undefined;

        const groups = listGroups(db, {
            category,
            memberPubkey,
            search,
            limit,
            offset,
            viewerPubkey
        });

        ctx.body = { success: true, groups };
    });

    // GET /api/groups/:id — Single group details + members
    router.get('/api/groups/:id', async (ctx) => {
        const { id } = ctx.params;
        const viewerPubkey = ctx.state.actor as string | undefined;

        const group = getGroup(db, id, viewerPubkey);
        if (!group) {
            ctx.status = 404;
            ctx.body = { error: 'Group not found' };
            return;
        }

        const members = getGroupMembers(db, group.id);
        ctx.body = {
            success: true,
            group,
            members
        };
    });

    // POST /api/groups — Create a new group
    router.post('/api/groups', async (ctx) => {
        const body = (ctx as any).requestBody || {};
        const actor = (ctx.state.actor as string) || body.createdBy;

        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required to create a group' };
            return;
        }

        if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
            ctx.status = 400;
            ctx.body = { error: 'Group name must be at least 2 characters long' };
            return;
        }

        // Official groups or linking an enterprise treasury requires admin authorization
        if (body.isOfficial || body.treasuryPubkey) {
            const isAdmin = await checkAdminAuth(ctx);
            if (!isAdmin) {
                ctx.status = 403;
                ctx.body = { error: 'Admin permissions required to create official groups or attach a treasury' };
                return;
            }
        }

        try {
            const group = createGroup(db, {
                id: body.id,
                name: body.name.trim(),
                slug: body.slug,
                description: body.description,
                avatarUrl: body.avatarUrl,
                category: body.category,
                createdBy: actor,
                joinPolicy: body.joinPolicy,
                isOfficial: Boolean(body.isOfficial),
                treasuryPubkey: body.treasuryPubkey,
                conversationId: body.conversationId
            });

            if (broadcast) {
                broadcast({ type: 'group_created', group });
            }

            ctx.body = { success: true, group };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to create group' };
        }
    });

    // POST /api/groups/:id/join — Join or request to join a group
    router.post('/api/groups/:id/join', async (ctx) => {
        const { id } = ctx.params;
        const body = (ctx as any).requestBody || {};
        const actor = (ctx.state.actor as string) || body.memberPubkey;

        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required to join a group' };
            return;
        }

        try {
            const membership = joinGroup(db, id, actor, body.invitedBy);
            if (broadcast) {
                broadcast({ type: 'group_member_joined', groupId: id, membership });
            }
            ctx.body = { success: true, membership };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to join group' };
        }
    });

    // POST /api/groups/:id/members — Set role or status for a member (steward only)
    router.post('/api/groups/:id/members', async (ctx) => {
        const { id } = ctx.params;
        const body = (ctx as any).requestBody || {};
        const actor = ctx.state.actor as string | undefined;

        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }

        const { memberPubkey, role, status } = body;
        if (!memberPubkey || !role) {
            ctx.status = 400;
            ctx.body = { error: 'memberPubkey and role are required' };
            return;
        }

        try {
            const membership = setMemberRole(db, id, memberPubkey, role, status || 'active', actor);
            if (broadcast) {
                broadcast({ type: 'group_member_updated', groupId: id, membership });
            }
            ctx.body = { success: true, membership };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to update member role' };
        }
    });

    // DELETE /api/groups/:id/members/:pubkey — Leave group or remove member
    router.delete('/api/groups/:id/members/:pubkey', async (ctx) => {
        const { id, pubkey } = ctx.params;
        const actor = ctx.state.actor as string | undefined;

        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }

        try {
            const removed = removeGroupMember(db, id, pubkey, actor);
            if (broadcast) {
                broadcast({ type: 'group_member_removed', groupId: id, memberPubkey: pubkey });
            }
            ctx.body = { success: removed };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to remove group member' };
        }
    });

    return router;
}
