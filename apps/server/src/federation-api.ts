/**
 * Federation API — Cross-Community Protocol
 *
 * Provides endpoints for inter-node communication:
 * - GET /api/node/info — Node metadata + peer list (for PWA node discovery)
 * - POST /api/federation/verify-member — Check if pubkey is a local member (commented out: an unsigned stub)
 *
 * Also exports the dynamic CORS middleware that whitelists peer connector origins.
 */

import type Koa from 'koa';
import type Router from '@koa/router';
import { getPeerOrigins, getConnectorsByLevel } from './connector-manager.js';
import { getMembers, getPosts, communityCountsCached } from './state-engine.js';
import { getLocalConfig } from './config/local-config.js';

/**
 * Dynamic CORS middleware for federation.
 * Checks the request Origin against the list of peer connector publicUrls.
 * Only whitelists peer nodes — blocked nodes get no CORS headers.
 */
export function federationCors(): Koa.Middleware {
    return async (ctx, next) => {
        // Only handle CORS preflights/headers for federation routes
        if (!ctx.path.startsWith('/api/federation') && ctx.path !== '/api/node/info') {
            await next();
            return;
        }

        const origin = ctx.get('Origin');

        if (origin) {
            // SECURITY (SRV-5): exact-origin match only.
            const allowedOrigins = getPeerOrigins();
            const normalized = origin.replace(/\/+$/, '');
            if (allowedOrigins.some(o => o.replace(/\/+$/, '') === normalized)) {
                ctx.set('Access-Control-Allow-Origin', origin);
                ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                ctx.set('Access-Control-Allow-Credentials', 'true');
            }
        }

        // Handle preflight for federation routes
        if (ctx.method === 'OPTIONS') {
            ctx.status = 200;
            ctx.body = '';
            return;
        }

        await next();
    };
}

/**
 * Mount federation routes on the router.
 */
export function mountFederationRoutes(router: Router): void {
    // Node info — public metadata for federation discovery
    router.get('/api/node/info', async (ctx) => {
        const config = getLocalConfig();
        const peers = getConnectorsByLevel('peer')
            .filter(c => c.connected && c.mutualTrust)
            .map(c => ({
                callsign: c.callsign || c.address,
                publicUrl: c.publicUrl || null,
            }));

        const counts = communityCountsCached();
        ctx.body = {
            name: config.communityName || 'BeanPool Node',
            // The node-wide counts from communityCountsCached, as GET /api/community/info: members not pruned, and the
            // live public listings (getActivePostCount, the count it caches). This read is public and counted both
            // afresh on every hit, and the member count reads every inline photo (the global load rehearsal). Counted
            // again once a member or a listing changes (the version counters), else at most COMMUNITY_COUNTS_TTL_MS old.
            memberCount: counts.memberCount,
            postCount: counts.postCount,
            peerNodes: peers,
        };
    });

    // [SECURITY PATCH]: The following route is an unauthenticated HTTP stub, disabled until cross-node requests are
    // signed. Its old neighbour, POST /api/federation/relay-message, is deleted (X7): a line between communities goes
    // through the mailbox over signed HTTPS (POST /api/relay/mail, engine/relay-mail.ts).
    /*
    // Verify member — used by remote nodes before accepting visitor trades
    router.post('/api/federation/verify-member', async (ctx) => {
        const { publicKey } = (ctx as any).requestBody || {};
        if (!publicKey) {
            ctx.status = 400;
            ctx.body = { error: 'publicKey is required' };
            return;
        }

        const members = getMembers();
        const member = members.find(m => m.publicKey === publicKey);

        if (!member) {
            ctx.body = { isMember: false };
            return;
        }

        // Never the member's balance: balances are private to their owner (Marty, 2026-09-28), and any key can sign
        // this request. Nothing ever read the `homeBalance` this used to carry.
        ctx.body = {
            isMember: true,
            callsign: member.callsign,
        };
    });
    */
}
