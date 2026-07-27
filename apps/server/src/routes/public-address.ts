/**
 * Public-address routes — the node half of the registrar (docs/node-dns-registrar.md).
 *
 *   - GET /api/attest  (PUBLIC): proves this node still holds its registered identity. The registrar's
 *     cron calls it with a nonce; we return a reply signed by the node's Ed25519 key. Public by design.
 *   - Admin routes drive the node's public address for the manager "Public Address" tab (claim/status/offline).
 */

import Router from '@koa/router';
import { buildAttestation, claimAddress, addressStatus, releaseAddress, nodePubkeyHex } from '../services/registrar-client.js';
import { getNodeConfig, updateNodeConfig } from '../state-engine.js';
import type { RouteDeps } from './types.js';

export function createPublicAddressRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    router.get('/api/attest', async (ctx) => {
        const nonce = String(ctx.query.nonce || '');
        if (!nonce || nonce.length > 256) { ctx.status = 400; ctx.body = { error: 'nonce required' }; return; }
        try { ctx.body = await buildAttestation(nonce); }
        catch (e: any) { ctx.status = 503; ctx.body = { error: e.message || 'identity not ready' }; }
    });

    router.post('/api/local/admin/public-address/claim', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const b = (ctx as any).requestBody || {};
        const name = String(b.name || '').toLowerCase().trim();
        const mode: 'tunnel' | 'direct' = b.mode === 'direct' ? 'direct' : 'tunnel';
        if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
        try {
            const result = await claimAddress(name, mode, b.origin, b.contact);
            // Persist so the cloudflared sidecar (Phase 1c) can pick up the token on boot.
            updateNodeConfig({ publicAddress: { name, mode, hostname: result.hostname, status: result.status, tunnelToken: result.tunnelToken } } as any);
            ctx.body = { success: true, ...result };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    router.get('/api/local/admin/public-address/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        try {
            const result = await addressStatus();
            if (result.status === 'live') {
                const prev = (getNodeConfig() as any).publicAddress || {};
                updateNodeConfig({ publicAddress: { ...prev, ...result } } as any);
            }
            ctx.body = { success: true, pubkey: nodePubkeyHex(), ...result };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    router.post('/api/local/admin/public-address/offline', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        try {
            const result = await releaseAddress();
            updateNodeConfig({ publicAddress: null } as any);
            ctx.body = { success: true, ...result };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    return router;
}
