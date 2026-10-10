/**
 * This server's alerts in Settings (services/alerts.ts): what is active, what was told, the channel, and "Send a test".
 *
 * An owner's, every one of them, reading included: the channel's URL and token are a secret of the owners' choosing, and
 * the alerts are about the server they run. An admin or a moderator is answered 403 in words; an automation token reaches
 * none of it (requireAdminRole). The URL is never sent back: the status shows its host only, and that a token is set.
 */

import Router from '@koa/router';
import type { RouteDeps } from './types.js';
import { requireAdminRole } from '../admin-auth.js';
import { getAlertsStatus, sendTestAlert, updateAlertChannel } from '../services/alerts.js';

export const ALERTS_OWNER_ONLY = "Only an owner of this node can see or change its alerts and where they're sent";

export function createAlertsRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    async function ownerOnly(ctx: any): Promise<boolean> {
        if (!(await checkAdminAuth(ctx))) return false;
        return requireAdminRole(ctx, ['owner'], ALERTS_OWNER_ONLY);
    }

    const body = (ctx: any): Record<string, unknown> => {
        const b = ctx.requestBody;
        return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    };

    router.post('/api/local/admin/alerts/status', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = getAlertsStatus();
    });

    // { url, format?: 'ntfy' | 'json', token? } sets the channel; { remove: true } takes it away. A token left out keeps
    // the stored one for the same URL; '' clears it.
    router.post('/api/local/admin/alerts/settings', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        const b = body(ctx);
        const result = updateAlertChannel({ url: b.url, format: b.format, token: b.token, remove: b.remove });
        if (!result.ok) {
            ctx.status = 400;
            ctx.body = { error: result.error };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { success: true, status: getAlertsStatus() };
    });

    // "Send a test": one message to the channel now, and what it answered.
    router.post('/api/local/admin/alerts/test', async (ctx) => {
        if (!(await ownerOnly(ctx))) return;
        const result = await sendTestAlert();
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { ...result, status: getAlertsStatus() };
    });

    return router;
}
