/**
 * Connected assistants in Settings (admin MCP design §8, §10; slice S3): an owner or an admin connects their own AI
 * assistant, sees the connections, disconnects one, and sees exactly what an assistant would read before connecting.
 *
 * - No token reaches these routes (automation-tokens.ts isRefusedToEveryToken): only a person's own session.
 * - Make (`POST …/agent/grants`): an owner's or an admin's KEY session, for themselves, never the admin password (an
 *   assistant acts for a member, whose live role it carries: agent/mcp-route.ts agentGrantFrom). Making one is a new
 *   credential, so a session from the phone's Manage asks for its unlock again (requirePhoneStepUp), whatever the role.
 *   The token is in that answer and nowhere else; no list carries a secret or a hash.
 * - List: an owner sees every assistant (member, name, role, via, last used, calls today); an admin their own.
 * - Disconnect: an owner any assistant, an admin their own. Its next call to /mcp is 401.
 * - Preview (`POST …/agent/preview`): what a tool answers, run by the same table /mcp runs (agent/tools.ts), with the
 *   same redaction and the same fences. Never a write: take_backup is not previewed. Not counted against any limit.
 */
import Router from '@koa/router';
import type { RouteDeps } from '../routes/types.js';
import { requireAdminRole, requirePhoneStepUp } from '../admin-auth.js';
import {
    issueAutomationToken, listAutomationTokens, revokeAutomationToken, AGENT_TOKEN_DEFAULT_DAYS, AGENT_TOKEN_MAX_DAYS,
    type AutomationTokenView,
} from '../automation-tokens.js';
import { nodeRoleOf } from '../engine/node-roles.js';
import { getMember } from '../state-engine.js';
import { logger } from '../logger.js';
import { noteSecurityEvent } from '../services/security-signal.js';
import { cleanMemberText, newBoundary } from './fence.js';
import { agentCallsToday, forgetAgentGrant } from './limits.js';
import { aiAssistantsAllowed, MCP_PATH, nodeUrlFor } from './mcp-route.js';
import { offersSuggestions, toolDescription, toolsFor, type AgentGrant } from './tools.js';
import { agentConnectedWords, agentDisconnectedWords } from './welcome.js';

export const AGENT_GRANTS_PATH = '/api/local/admin/agent/grants';
export const AGENT_PREVIEW_PATH = '/api/local/admin/agent/preview';
/** At most this many assistants per member: one member cannot fill the node's TOKEN_LIMIT and shut the owners out. */
export const AGENT_GRANTS_PER_MEMBER = 5;
const DAY_MS = 24 * 60 * 60_000;

const ROLE_ERROR = 'Only an owner or an admin of this node can connect an AI assistant';
const NEEDS_KEY_ERROR = 'Connect an assistant from the app: sign in with your own key (Manage, or a computer signed in by scanning a code). An assistant acts for a member, and the admin password is nobody\'s.';

type Role = 'owner' | 'admin';

/** A person's session, an owner or an admin, never a token (isRefusedToEveryToken refuses them first; said again). */
async function personOnly(ctx: any, deps: RouteDeps): Promise<boolean> {
    if (!(await deps.checkAdminAuth(ctx))) return false;
    if (ctx.state?.automationTokenId) {
        ctx.status = 403;
        ctx.body = { error: 'An automation token cannot see or connect AI assistants' };
        return false;
    }
    return requireAdminRole(ctx, ['owner', 'admin'], ROLE_ERROR);
}

const roleOf = (ctx: any): Role => (ctx.state?.adminRole === 'owner' ? 'owner' : 'admin');
const actorOf = (ctx: any): string | null => (ctx.state?.isKeySession === true && typeof ctx.state?.actor === 'string' && ctx.state.actor ? ctx.state.actor : null);

const body = (ctx: any): Record<string, unknown> => {
    const b = ctx.requestBody ?? ctx.request?.body;
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
};

/** The agent grants this caller may see: an owner every one, an admin (or anyone else) only their own. */
function visibleGrants(ctx: any): AutomationTokenView[] {
    const agents = listAutomationTokens().filter((t) => t.scope === 'agent');
    if (roleOf(ctx) === 'owner') return agents;
    const me = actorOf(ctx);
    return me ? agents.filter((t) => t.createdBy === me) : [];
}

/** What Settings shows of one grant: never the secret, the hash or the maker's whole key. */
function grantView(t: AutomationTokenView, me: string | null, now = Date.now()) {
    const role = typeof t.createdBy === 'string' ? nodeRoleOf(t.createdBy) : null;
    return {
        id: t.id,
        name: cleanMemberText(t.name, 60),
        member: cleanMemberText(getMember(t.createdBy)?.callsign ?? '', 60) || null,
        mine: !!me && t.createdBy === me,
        /** The maker's role now: null when they are no longer an owner or admin (the assistant answers 401 then). */
        role: role === 'owner' || role === 'admin' ? role : null,
        via: 'token' as const,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        expired: t.expiresAt !== null && t.expiresAt <= now,
        lastUsedAt: t.lastUsedAt,
        callsToday: agentCallsToday(t.id, now),
    };
}

/** The grant a preview runs as: one the caller may see, else the caller themselves with their own role. */
function previewGrant(ctx: any, grantId: unknown): AgentGrant | { error: string } {
    if (typeof grantId === 'string' && grantId) {
        const t = visibleGrants(ctx).find((g) => g.id === grantId);
        if (!t) return { error: 'No such assistant' };
        const role = nodeRoleOf(t.createdBy);
        if (role !== 'owner' && role !== 'admin') return { error: 'Its member is no longer an owner or admin: it reads nothing now' };
        return { id: t.id, name: t.name, member: t.createdBy, role, via: 'token', createdAt: t.createdAt, expiresAt: t.expiresAt };
    }
    return {
        id: 'preview', name: 'Preview', member: actorOf(ctx) ?? 'owner:password', role: roleOf(ctx), via: 'token',
        createdAt: Date.now(), expiresAt: null,
    };
}

// Paths written out in full, so the route sweeps (test-admin-mcp.ts, test-automation-tokens.ts) find them.
export function createAgentGrantRoutes(deps: RouteDeps): Router {
    const router = new Router();

    router.get('/api/local/admin/agent/grants', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const me = actorOf(ctx);
        const role = roleOf(ctx);
        ctx.body = {
            allowed: aiAssistantsAllowed(),
            mcpUrl: `${nodeUrlFor(ctx)}${MCP_PATH}`,
            role,
            canConnect: !!me,
            seesAll: role === 'owner',
            defaultDays: AGENT_TOKEN_DEFAULT_DAYS,
            maxDays: AGENT_TOKEN_MAX_DAYS,
            perMember: AGENT_GRANTS_PER_MEMBER,
            grants: visibleGrants(ctx).map((t) => grantView(t, me)),
        };
    });

    router.post('/api/local/admin/agent/grants', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const me = actorOf(ctx);
        if (!me) {
            ctx.status = 403;
            ctx.body = { error: NEEDS_KEY_ERROR, code: 'agent_needs_key' };
            return;
        }
        // A new credential: the phone's Manage asks for its unlock again, for an admin as for an owner.
        if (!requirePhoneStepUp(ctx)) return;
        if (!aiAssistantsAllowed()) {
            ctx.status = 409;
            ctx.body = { error: 'AI assistants are turned off on this server: an owner turns them on here first' };
            return;
        }
        const role = roleOf(ctx);
        if (listAutomationTokens().filter((t) => t.scope === 'agent' && t.createdBy === me).length >= AGENT_GRANTS_PER_MEMBER) {
            ctx.status = 400;
            ctx.body = { error: `You have ${AGENT_GRANTS_PER_MEMBER} assistants connected: disconnect one first` };
            return;
        }
        const b = body(ctx);
        const days = b.days === undefined || b.days === null || b.days === '' ? AGENT_TOKEN_DEFAULT_DAYS : Number(b.days);
        if (!Number.isInteger(days) || days < 1 || days > AGENT_TOKEN_MAX_DAYS) {
            ctx.status = 400;
            ctx.body = { error: `Pick from 1 to ${AGENT_TOKEN_MAX_DAYS} days` };
            return;
        }
        const res = issueAutomationToken({ name: b.name, scope: 'agent', expiresAt: Date.now() + days * DAY_MS, createdBy: me });
        if (!res.ok) {
            ctx.status = 400;
            ctx.body = { error: res.error };
            return;
        }
        logger.info('AUTH', 'AI assistant connected', { tokenId: res.record.id, role, by: me.slice(0, 16), expiresAt: res.record.expiresAt });
        noteSecurityEvent({
            key: 'sec.agent', actor: me, actorRole: role,
            detail: agentConnectedWords(cleanMemberText(res.record.name, 60), role, role === 'owner', offersSuggestions()),
        });
        ctx.status = 201;
        ctx.body = { token: res.token, grant: grantView(res.record, me) };
    });

    router.post('/api/local/admin/agent/grants/:id/revoke', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const id = String(ctx.params.id || '');
        const target = visibleGrants(ctx).find((t) => t.id === id);
        if (!target || !revokeAutomationToken(id)) {
            ctx.status = 404;
            ctx.body = { error: 'No such assistant' };
            return;
        }
        forgetAgentGrant(id);
        const by = actorOf(ctx) ?? 'owner:password';
        const role = roleOf(ctx);
        logger.info('AUTH', 'AI assistant disconnected', { tokenId: id, role, by: by.slice(0, 16) });
        noteSecurityEvent({ key: 'sec.agent', actor: by, actorRole: role, detail: agentDisconnectedWords(cleanMemberText(target.name, 60), role) });
        ctx.body = { revoked: id };
    });

    router.post('/api/local/admin/agent/preview', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await personOnly(ctx, deps))) return;
        const b = body(ctx);
        const grant = previewGrant(ctx, b.grant);
        if ('error' in grant) {
            ctx.status = 404;
            ctx.body = { error: grant.error };
            return;
        }
        const tools = toolsFor(grant);
        if (b.tool === undefined) {
            ctx.body = {
                tools: tools.map((t) => ({ name: t.name, title: t.title, description: toolDescription(t), write: !!t.write, memberText: !!t.memberText })),
            };
            return;
        }
        const tool = tools.find((t) => t.name === b.tool);
        if (!tool) {
            ctx.status = 404;
            ctx.body = { error: 'This assistant has no such tool' };
            return;
        }
        if (tool.write) {
            ctx.status = 400;
            ctx.body = { error: 'A preview never writes: it shows what the reading tools answer' };
            return;
        }
        const raw = b.args;
        const args: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        let out;
        try {
            out = tool.run(grant, args, newBoundary());
        } catch (e) {
            logger.warn('ADMIN', 'AI assistant preview failed', { tool: tool.name, error: e instanceof Error ? e.name : 'error' });
            ctx.status = 500;
            ctx.body = { error: 'The server could not answer that now: try again later.' };
            return;
        }
        logger.info('ADMIN', 'AI assistant preview', { tool: tool.name, role: grant.role, by: String(actorOf(ctx) ?? 'owner:password').slice(0, 16) });
        if (!out.ok) {
            ctx.body = { tool: tool.name, ok: false, error: out.error };
            return;
        }
        ctx.body = { tool: tool.name, ok: true, rows: out.rows, result: out.result };
    });

    return router;
}
