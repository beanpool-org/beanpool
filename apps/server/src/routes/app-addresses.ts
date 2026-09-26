/**
 * Settings → Network → "Addresses members' apps use" (request binding, engine/own-addresses.ts and
 * engine/member-signature.ts). Owners and admins; a moderator's session never reaches an admin route that is not on its
 * list (admin-auth.ts).
 *
 *   GET  /api/local/admin/app-addresses          this community's addresses, where each comes from, and how many
 *                                                 people's apps signed for it today and on the busiest day of the last 7;
 *                                                 the addresses apps reached a node with none configured at (to
 *                                                 confirm); how many signed in the old format (apps too old to name a
 *                                                 community); and the switch date.
 *   POST /api/local/admin/app-addresses/confirm  { address }: "Yes, that's its address." Adds it to the owner-confirmed
 *                                                 list (node_config.ownerAddresses, carried in the take-over envelope).
 *   POST /api/local/admin/app-addresses/remove   { address }: takes an owner-confirmed address off the list again.
 *
 * An address is only ever added by an owner or admin here, or by config the operator set (the registrar's name,
 * CF_RECORD_NAME, BEANPOOL_ADDRESSES). Never from a request's Host header.
 */

import Router from '@koa/router';
import { getNodeConfig, updateNodeConfig } from '../state-engine.js';
import {
    configuredAddresses, forgetOwnAddresses, normalizeAddress, ownerConfirmedAddresses,
} from '../engine/own-addresses.js';
import { signatureUsage, unboundSignaturesAccepted, unboundSignaturesUntilDay } from '../engine/member-signature.js';
import { logger } from '../logger.js';
import type { RouteDeps } from './types.js';

/** More than any real community needs; a bound on what one Settings session can write. */
export const MAX_OWNER_ADDRESSES = 20;

export function appAddressesReport() {
    const usage = signatureUsage();
    const count = (kind: string, address: string) => usage.find((u) => u.kind === kind && u.address === address);
    const addresses = configuredAddresses().map((a) => {
        const u = count('own', a.address);
        return { address: a.address, source: a.source, today: u?.today ?? 0, busiestDay: u?.busiestDay ?? 0 };
    });
    // Hosts apps signed for while this node knew none of its names (accepted until the switch, and offered to confirm);
    // and any the owner has since confirmed drop off this list, as they are on the one above.
    const known = new Set(addresses.map((a) => a.address));
    const unconfirmed = usage
        .filter((u) => u.kind === 'unconfirmed' && !known.has(u.address))
        .map((u) => ({ address: u.address, today: u.today, busiestDay: u.busiestDay }));
    const old = count('old_app', '');
    return {
        addresses,
        unconfirmed,
        oldApps: { today: old?.today ?? 0, busiestDay: old?.busiestDay ?? 0 },
        unboundSignaturesUntil: unboundSignaturesUntilDay(),
        unboundSignaturesAccepted: unboundSignaturesAccepted(),
    };
}

export function createAppAddressesRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;
    const bodyOf = (ctx: any) => (ctx as any).requestBody || (ctx.request as any)?.body || {};

    router.get('/api/local/admin/app-addresses', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport();
    });

    router.post('/api/local/admin/app-addresses/confirm', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const address = normalizeAddress(bodyOf(ctx).address);
        if (!address) {
            ctx.status = 400;
            ctx.body = { error: 'Send { "address": "community.example.org" }: a web address, with no path.' };
            return;
        }
        const current = ownerConfirmedAddresses();
        if (!current.includes(address)) {
            if (current.length >= MAX_OWNER_ADDRESSES) {
                ctx.status = 409;
                ctx.body = { error: `This community already has ${MAX_OWNER_ADDRESSES} confirmed addresses. Remove one you no longer use first.` };
                return;
            }
            updateNodeConfig({ ownerAddresses: [...current, address] });
            forgetOwnAddresses();
            logger.security('AUTH', `App address confirmed in Settings by ${(ctx.state as any)?.actor || 'the admin password'}: ${address}`);
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport();
    });

    router.post('/api/local/admin/app-addresses/remove', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const address = normalizeAddress(bodyOf(ctx).address);
        const stored: unknown = (getNodeConfig() as any).ownerAddresses;
        const current = Array.isArray(stored) ? stored.filter((a): a is string => typeof a === 'string') : [];
        if (!address || !current.includes(address)) {
            ctx.status = 404;
            ctx.body = { error: 'That address is not one confirmed in Settings. Addresses from the registrar or the server’s own settings are changed there.' };
            return;
        }
        updateNodeConfig({ ownerAddresses: current.filter((a) => a !== address) });
        forgetOwnAddresses();
        logger.security('AUTH', `App address removed in Settings by ${(ctx.state as any)?.actor || 'the admin password'}: ${address}`);
        ctx.set('Cache-Control', 'no-store');
        ctx.body = appAddressesReport();
    });

    return router;
}
