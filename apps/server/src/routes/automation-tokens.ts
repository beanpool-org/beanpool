/**
 * Owner automation tokens in Settings (automation-tokens.ts; node sign-in design step 7, D8): make one, list them, revoke
 * one. An owner's, every route: making a token is an owner-only change, so a session from the phone's Manage asks for its
 * unlock again (requireAdminRole's step-up). No token reaches these routes (isRefusedToEveryToken). The token is in the
 * answer that makes it and nowhere else; the list never carries a secret or a hash.
 *
 * Only an owner's KEY session makes one (the phone's Manage, or a computer signed in by scanning a code): never the admin
 * password, by session, header or body, whatever the node's 2FA. So every token belongs to a person and stops when they
 * are no longer an owner (checkAutomationToken). Listing and revoking take any owner credential: removing one is safe.
 *
 * An AI assistant's token (scope agent) is not made here: Connected assistants makes it (agent/grants-route.ts), where the
 * owners' switch and the per-member cap hold. It is still listed here and can be revoked here.
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { requireAdminRole } from '../admin-auth.js';
import { issueAutomationToken, listAutomationTokens, revokeAutomationToken, TOKEN_SCOPES } from '../automation-tokens.js';
import { logger } from '../logger.js';
import { noteSecurityEvent } from '../services/security-signal.js';
import { forgetAgentGrant } from '../agent/limits.js';
import { agentDisconnectedWords } from '../agent/welcome.js';
import { cleanMemberText } from '../agent/fence.js';
import { AGENT_GRANTS_PATH } from '../agent/grants-route.js';

export const TOKENS_OWNER_ONLY = 'Only an owner of this node can make, see or revoke its automation tokens';
export const TOKEN_NEEDS_KEY_CODE = 'token_needs_key';
export const TOKEN_NEEDS_KEY_ERROR = 'Make automation tokens from the app: sign in with your owner key (Manage, or a computer signed in by scanning a code)';
export const TOKEN_AGENT_ELSEWHERE_CODE = 'agent_via_grants';

export function createAutomationTokenRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    async function ownerOnly(ctx: any): Promise<boolean> {
        if (!(await checkAdminAuth(ctx))) return false;
        // checkAdminAuth already refuses every token here; said again where it matters most.
        if (ctx.state?.automationTokenId) {
            ctx.status = 403;
            ctx.body = { error: 'An automation token cannot manage tokens' };
            return false;
        }
        return requireAdminRole(ctx, ['owner'], TOKENS_OWNER_ONLY);
    }

    const body = (ctx: any): Record<string, unknown> => {
        const b = ctx.requestBody ?? ctx.request?.body;
        return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    };

    router.get('/api/local/admin/automation-tokens', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await ownerOnly(ctx))) return;
        ctx.body = { tokens: listAutomationTokens(), scopes: TOKEN_SCOPES.filter((s) => s !== 'agent') };
    });

    router.post('/api/local/admin/automation-tokens', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await ownerOnly(ctx))) return;
        const actor = (ctx.state as any)?.actor;
        if ((ctx.state as any)?.isKeySession !== true || typeof actor !== 'string' || !actor) {
            ctx.status = 403;
            ctx.body = { error: TOKEN_NEEDS_KEY_ERROR, code: TOKEN_NEEDS_KEY_CODE };
            return;
        }
        const b = body(ctx);
        if (b.scope === 'agent') {
            ctx.status = 400;
            ctx.body = {
                error: `Connect an AI assistant under Connected assistants (${AGENT_GRANTS_PATH}): the owners' switch and its limits apply there`,
                code: TOKEN_AGENT_ELSEWHERE_CODE,
            };
            return;
        }
        const createdBy: string = actor;
        const res = issueAutomationToken({ name: b.name, scope: b.scope, expiresAt: b.expiresAt, createdBy });
        if (!res.ok) {
            ctx.status = 400;
            ctx.body = { error: res.error };
            return;
        }
        logger.info('AUTH', 'Automation token made', {
            tokenId: res.record.id, scope: res.record.scope, issuedBy: createdBy.slice(0, 16), expiresAt: res.record.expiresAt,
        });
        ctx.status = 201;
        ctx.body = { token: res.token, record: res.record };
    });

    router.post('/api/local/admin/automation-tokens/:id/revoke', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await ownerOnly(ctx))) return;
        const id = String(ctx.params.id || '');
        const revoked = listAutomationTokens().find((t) => t.id === id);
        if (!revokeAutomationToken(id)) {
            ctx.status = 404;
            ctx.body = { error: 'No such token' };
            return;
        }
        const by = typeof (ctx.state as any)?.actor === 'string' && (ctx.state as any).actor ? (ctx.state as any).actor : 'owner:password';
        logger.info('AUTH', 'Automation token revoked', { tokenId: id, revokedBy: String(by).slice(0, 16) });
        if (revoked?.scope === 'agent') {
            forgetAgentGrant(id);
            noteSecurityEvent({ key: 'sec.agent', actor: String(by), actorRole: 'owner', detail: agentDisconnectedWords(cleanMemberText(revoked.name, 60), 'owner') });
        }
        ctx.body = { revoked: id };
    });

    return router;
}
