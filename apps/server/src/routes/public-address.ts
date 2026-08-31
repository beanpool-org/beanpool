/**
 * Public-address routes — the node half of the registrar (docs/node-dns-registrar.md).
 *
 *   - GET /api/attest  (PUBLIC): proves this node still holds its registered identity. The registrar's
 *     cron calls it with a nonce; we return a reply signed by the node's Ed25519 key. Public by design.
 *   - Admin routes drive the node's public address for the manager "Public Address" tab (claim/status/offline).
 */

import Router from '@koa/router';
import http from 'node:http';
import { buildAttestation, claimAddress, updateAddressMetadata, addressStatus, releaseAddress, nodePubkeyHex } from '../services/registrar-client.js';
import { writeToken, removeToken, restartSidecar } from '../services/public-address-agent.js';
import { getNodeConfig, updateNodeConfig } from '../state-engine.js';
import type { RouteDeps } from './types.js';

export interface ProbeLogEntry {
    timestamp: string;
    step: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
}

const probeLogs: ProbeLogEntry[] = [];

export function addProbeLog(step: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    const timestamp = new Date().toISOString().slice(11, 19);
    probeLogs.push({ timestamp, step, message, type });
    if (probeLogs.length > 60) probeLogs.shift();
}

async function verifyEdgeStatus(hostname: string, target: 'live' | 'offline', maxAttempts = 12, intervalMs = 5000): Promise<boolean> {
    const cfEdgeIp = '104.21.93.179';
    const totalSecs = Math.round(maxAttempts * intervalMs / 1000);
    addProbeLog('4/4', `📡 Probing ${hostname} every ${intervalMs / 1000}s (up to ${totalSecs}s)...`, 'info');
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const status = await new Promise<number>((resolve) => {
                const req = http.request({
                    hostname: cfEdgeIp,
                    port: 80,
                    path: '/',
                    method: 'GET',
                    headers: { Host: hostname }
                }, (res) => {
                    resolve(res.statusCode || 0);
                });
                req.on('error', () => resolve(0));
                req.setTimeout(4000, () => { req.destroy(); resolve(0); });
                req.end();
            });

            const isOriginSuccess = (status === 200 || status === 301 || status === 302 || status === 304 || status === 307 || status === 308);
            const elapsed = (i + 1) * intervalMs / 1000;

            if (target === 'live') {
                if (isOriginSuccess) {
                    addProbeLog('4/4', `🟢 Probe ${i + 1}/${maxAttempts}: HTTP ${status} — Confirmed LIVE!`, 'success');
                    return true;
                }
                addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts} (${elapsed}s): HTTP ${status === 530 ? '530 — waiting for tunnel…' : status}`, 'info');
            } else if (target === 'offline') {
                if (status === 530 || status === 502 || status === 520 || status === 522 || status === 523 || status === 404 || status === 0) {
                    addProbeLog('4/4', `🔴 Probe ${i + 1}/${maxAttempts}: HTTP ${status} — Confirmed OFFLINE!`, 'warning');
                    return true;
                }
                addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts}: HTTP ${status} (waiting for teardown…)`, 'info');
            }
        } catch (err: any) {
            addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts}: error (${err.message})`, 'warning');
            if (target === 'offline') return true;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    addProbeLog('4/4', `⏳ Timed out after ${totalSecs}s. Click ⚡ Reset Tunnel to retry.`, 'warning');
    return false;
}

export function createPublicAddressRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    /**
     * Apple's domain-verification file, served whenever its contents are configured.
     *
     * Here rather than with the Sign in with Apple code that needs it, because Apple re-verifies
     * domains on its own schedule and this has to keep answering long after any particular feature
     * — or diagnostic — is gone. A route that lived beside a temporary probe would be deleted with
     * it, and verification would lapse silently months later.
     *
     * Public by design: the file is a verification token Apple fetches anonymously, and it grants
     * nothing. Same reasoning as `/api/attest` below.
     */
    router.get('/.well-known/apple-developer-domain-association.txt', async (ctx) => {
        const association = process.env.APPLE_DOMAIN_ASSOCIATION;
        if (!association) {
            ctx.status = 404;
            ctx.body = 'not configured';
            return;
        }
        ctx.type = 'text/plain; charset=utf-8';
        ctx.body = association;
    });

    router.get('/api/attest', async (ctx) => {
        const nonce = String(ctx.query.nonce || '');
        // The registrar's nonce is a crypto.randomUUID() — hex and hyphens. Anything outside that
        // charset is an attempt to smuggle structure (a newline turns the signed `${nonce}\n${ts}`
        // into a multi-line message that can mimic another signing context). Domain separation in
        // buildAttestation is the structural backstop; this rejects the payload outright as well.
        if (!nonce) {
            ctx.status = 400; ctx.body = { error: 'nonce required' }; return;
        }
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(nonce)) {
            ctx.status = 400; ctx.body = { error: 'invalid nonce format' }; return;
        }
        try { ctx.body = await buildAttestation(nonce); }
        catch (e: any) { ctx.status = 503; ctx.body = { error: e.message || 'identity not ready' }; }
    });

    router.get('/api/local/admin/public-address/logs', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        ctx.body = { success: true, logs: probeLogs };
    });

    router.post('/api/local/admin/public-address/claim', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const b = (ctx.request as any).body || (ctx as any).requestBody || {};
        const name = String(b.name || '').toLowerCase().trim();
        const mode: 'tunnel' | 'direct' = b.mode === 'direct' ? 'direct' : 'tunnel';
        if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
        try {
            probeLogs.length = 0;
            addProbeLog('1/4', `⏳ Requesting tunnel allocation for "${name}.beanpool.org"...`, 'info');
            const origin = b.origin || process.env.PUBLIC_ADDRESS_ORIGIN || 'http://beanpool-node:8080';
            const communityName = b.communityName || b.community_name;
            const result = await claimAddress(name, mode, origin, b.contact, communityName);
            addProbeLog('1/4', `✅ Registrar granted claim for ${result.hostname}`, 'success');

            updateNodeConfig({ publicAddress: { name, mode, hostname: result.hostname, status: result.status, tunnelToken: result.tunnelToken, communityName, contact: b.contact } } as any);
            if (result.tunnelToken) {
                addProbeLog('2/4', `🔒 Writing tunnel token...`, 'info');
                await writeToken(result.tunnelToken);
                addProbeLog('3/4', `⚡ Sidecar restarted`, 'success');
                // Run edge status probe asynchronously in background to prevent HTTP request timeouts
                verifyEdgeStatus(result.hostname, 'live').catch(err => {
                    console.warn('[PublicAddr] Edge status probe error:', err?.message || err);
                });
            }
            ctx.body = { success: true, ...result };
        } catch (e: any) {
            addProbeLog('1/4', `❌ Claim failed: ${e.message}`, 'error');
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    router.post('/api/local/admin/public-address/update', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const b = (ctx.request as any).body || (ctx as any).requestBody || {};
        try {
            const communityName = b.communityName !== undefined ? b.communityName : b.community_name;
            const result = await updateAddressMetadata(communityName, b.contact);
            const prev = (getNodeConfig() as any).publicAddress || {};
            const updatedPa = { ...prev };
            if (communityName !== undefined) updatedPa.communityName = communityName;
            if (b.contact !== undefined) updatedPa.contact = b.contact;
            updateNodeConfig({ publicAddress: updatedPa } as any);
            ctx.body = { success: true, ...result };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    router.get('/api/local/admin/public-address/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        let localPa = (getNodeConfig() as any).publicAddress || null;

        // Fallback to env or saved token configuration if nodeConfig cache hasn't synced yet
        if (!localPa && process.env.PUBLIC_ADDRESS_NAME) {
            localPa = {
                status: 'live',
                name: process.env.PUBLIC_ADDRESS_NAME,
                hostname: `${process.env.PUBLIC_ADDRESS_NAME}.beanpool.org`,
                mode: process.env.PUBLIC_ADDRESS_MODE || 'tunnel'
            };
        }

        try {
            const result = await addressStatus();
            if (result.status === 'live') {
                const prev = (getNodeConfig() as any).publicAddress || {};
                updateNodeConfig({ publicAddress: { ...prev, ...result } } as any);
                if (result.tunnelToken) {
                    await writeToken(result.tunnelToken);
                }
            } else if (result.status === 'none') {
                updateNodeConfig({ publicAddress: null } as any);
                await removeToken();
            }
            ctx.body = { success: true, pubkey: nodePubkeyHex(), ...result };
        } catch (e: any) {
            if (localPa && (localPa.hostname || localPa.name)) {
                ctx.body = {
                    success: true,
                    pubkey: nodePubkeyHex(),
                    ...localPa,
                    cached: true,
                    error: e.message
                };
            } else {
                ctx.status = 400;
                ctx.body = { error: e.message };
            }
        }
    });

    router.post('/api/local/admin/public-address/restart-sidecar', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        try {
            addProbeLog('1/1', `⚡ Manual trigger: Force-restarting sidecar container (t=0)...`, 'info');
            await restartSidecar();
            addProbeLog('1/1', `✅ Sidecar container successfully restarted!`, 'success');
            ctx.body = { success: true };
        } catch (e: any) {
            addProbeLog('1/1', `❌ Sidecar restart failed: ${e.message}`, 'error');
            ctx.status = 500;
            ctx.body = { error: e.message };
        }
    });

    router.post('/api/local/admin/public-address/offline', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        try {
            probeLogs.length = 0;
            addProbeLog('1/4', `⏳ Releasing domain & deleting tunnel on Cloudflare registrar...`, 'info');
            const prevConfig = (getNodeConfig() as any).publicAddress;
            const hostname = prevConfig?.hostname;
            const result = await releaseAddress();
            addProbeLog('1/4', `✅ Domain released on registrar`, 'success');
            updateNodeConfig({ publicAddress: null } as any);
            addProbeLog('2/4', `🔒 Overwriting tunnel token with empty state...`, 'info');
            await removeToken();
            addProbeLog('3/4', `⚡ Sidecar container force-restarted (t=0)`, 'success');
            if (hostname) {
                verifyEdgeStatus(hostname, 'offline', 10).catch(err => {
                    console.warn('[PublicAddr] Edge offline probe error:', err?.message || err);
                });
            }
            ctx.body = { success: true, status: 'none', ...result };
        } catch (e: any) {
            addProbeLog('1/4', `❌ Offline failed: ${e.message}`, 'error');
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    return router;
}
