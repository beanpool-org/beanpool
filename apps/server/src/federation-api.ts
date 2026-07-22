/**
 * Federation API — Cross-Community Protocol
 *
 * Provides endpoints for inter-node communication:
 * - GET /api/node/info — Node metadata + peer list (for PWA node discovery)
 * - POST /api/federation/verify-member — Check if pubkey is a local member
 *
 * Also exports the dynamic CORS middleware that whitelists peer connector origins.
 */

import type Koa from 'koa';
import type Router from '@koa/router';
import { getPeerOrigins, getConnectorsByLevel } from './connector-manager.js';
import { getMembers, getPosts, getBalance, createConversation, sendMessage, registerVisitor, getCommunityInfo, getActivePostCount } from './state-engine.js';
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

        ctx.body = {
            name: config.communityName || 'BeanPool Node',
            // ⚡ O(1) SQL counts instead of materialising every member + post row to count
            // them. postCount keeps the original semantics (active + status active/pending,
            // i.e. excludes paused) — getCommunityInfo().postCount would wrongly include paused.
            memberCount: getCommunityInfo().memberCount,
            postCount: getActivePostCount(),
            peerNodes: peers,
        };
    });

    // [SECURITY PATCH]: The following routes are currently unauthenticated HTTP stubs. 
    // They are disabled to prevent remote message spoofing until cross-node 
    // cryptographic PeerID signatures are fully implemented for federation routing.
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

        // Get balance info for the member
        const balance = getBalance(publicKey);

        ctx.body = {
            isMember: true,
            callsign: member.callsign,
            homeBalance: balance?.balance ?? 0,
        };
    });

    // Relay message — receive a DM from a remote node
    router.post('/api/federation/relay-message', async (ctx) => {
        const body = (ctx as any).requestBody || {};
        const { senderPublicKey, senderCallsign, senderNodeUrl, recipientPublicKey, ciphertext, nonce } = body;

        if (!senderPublicKey || !recipientPublicKey || !ciphertext || !nonce) {
            ctx.status = 400;
            ctx.body = { error: 'Missing required fields: senderPublicKey, recipientPublicKey, ciphertext, nonce' };
            return;
        }

        // Verify recipient exists locally
        const members = getMembers();
        const recipient = members.find(m => m.publicKey === recipientPublicKey);
        if (!recipient) {
            ctx.status = 404;
            ctx.body = { error: 'Recipient not found on this node' };
            return;
        }

        // Register sender as a visitor with their callsign and home node URL
        registerVisitor(senderPublicKey, senderCallsign || undefined, senderNodeUrl || undefined);

        // Create or find the DM conversation
        const conversation = createConversation('dm', [senderPublicKey, recipientPublicKey], senderPublicKey);
        if (!conversation) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to create conversation' };
            return;
        }

        // Store the message
        const message = sendMessage(conversation.id, senderPublicKey, ciphertext, nonce);
        if (!message) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to store message' };
            return;
        }

        console.log(`📨 Federation relay: ${senderCallsign || senderPublicKey.substring(0, 8)} → ${recipient.callsign} (from ${senderNodeUrl || 'unknown'})`);

        ctx.body = {
            success: true,
            conversationId: conversation.id,
            messageId: message.id,
        };
    });
    */
}
