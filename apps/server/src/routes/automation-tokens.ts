/**
 * Owner automation tokens in Settings (automation-tokens.ts; node sign-in design step 7, D8): make one, list them, revoke
 * one. An owner's, every route: making a token is an owner-only change, so a session from the phone's Manage asks for its
 * unlock again (requireAdminRole's step-up). No token reaches these routes (isRefusedToEveryToken). The token is in the
 * answer that makes it and nowhere else; the list never carries a secret or a hash.
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { requireAdminRole } from '../admin-auth.js';
import { issueAutomationToken, listAutomationTokens, revokeAutomationToken, TOKEN_SCOPES } from '../automation-tokens.js';
import { logger } from '../logger.js';

export const TOKENS_OWNER_ONLY = 'Only an owner of this node can make, see or revoke its automation tokens';

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
        ctx.body = { tokens: listAutomationTokens(), scopes: TOKEN_SCOPES };
    });

    router.post('/api/local/admin/automation-tokens', async (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        if (!(await ownerOnly(ctx))) return;
        const b = body(ctx);
        const createdBy = typeof (ctx.state as any)?.actor === 'string' && (ctx.state as any).actor ? (ctx.state as any).actor : 'owner:password';
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
        if (!revokeAutomationToken(id)) {
            ctx.status = 404;
            ctx.body = { error: 'No such token' };
            return;
        }
        const by = typeof (ctx.state as any)?.actor === 'string' && (ctx.state as any).actor ? (ctx.state as any).actor : 'owner:password';
        logger.info('AUTH', 'Automation token revoked', { tokenId: id, revokedBy: String(by).slice(0, 16) });
        ctx.body = { revoked: id };
    });

    return router;
}
