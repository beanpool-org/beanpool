/**
 * BeanPool Node — Entry Point
 *
 * Boots the independent local gateway:
 * 1. Genesis check (first-run community_id + genesis block)
 * 2. Admin password init (from ADMIN_PASSWORD env or auto-generate)
 * 3. TLS certificates (Let's Encrypt or self-signed)
 * 4. DNS shim for beanpool.local resolution
 * 5. Trust Bootstrap (HTTP :80 — redirect or CA cert)
 * 6. PWA + Settings host (HTTPS :443)
 * 7. libp2p P2P transport (TCP :4001, WS :4002)
 * 8. Connector manager (dial trusted peers)
 * 9. Cert renewal scheduler
 */
import fs from 'node:fs';
import path from 'node:path';

// Force load root .env (bypass Turborepo filters)
const envPath = path.join(process.cwd(), '../../.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match && match[1]) {
            const key = match[1].trim();
            if (!process.env[key]) {
                process.env[key] = match[2].trim();
            }
        }
    }
}

import { ensureGenesis } from './genesis.js';
import { initAdminPassword } from './local-config.js';
import { initTls, startRenewalScheduler } from './tls.js';
import { startDnsShim } from './dns-shim.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { initConnectorManager, connectAll } from './connector-manager.js';
import { registerHandshakeHandler } from './handshake.js';
import { registerFederationHandler } from './federation-protocol.js';
import { initStateEngine, migrateAdminConversations, getNodeRole, promotionSanityCheck } from './state-engine.js';
import { initDirectoryPublisher } from './directory-publisher.js';
import { initBackupPuller } from './backup-puller.js';
import { initSnapshotScheduler } from './snapshot-scheduler.js';

const PORT_HTTP = Number(process.env.PORT_HTTP ?? 8080);
const PORT_HTTPS = Number(process.env.PORT_HTTPS ?? 8443);
const PORT_P2P = Number(process.env.PORT_P2P ?? 4001);
const PORT_P2P_WS = PORT_P2P + 1; // 4002

async function main() {
    console.log('\n🫘  BeanPool Node starting...\n');

    // Step 1: Ensure genesis state exists
    const genesis = await ensureGenesis();
    console.log(`✅ Community: ${genesis.communityId}`);
    console.log(`   Genesis hash: ${genesis.genesisHash}\n`);

    // Step 2: Admin password (first boot: env var or auto-generate)
    initAdminPassword();

    // Step 2.5: Initialize state engine (ledger, members, marketplace)
    initStateEngine();
    migrateAdminConversations();

    // Step 2.55: Auto-snapshot scheduler — periodic local DB snapshots into
    // data/snapshots/ (Backup tab). Defaults to daily, keeping the last 7.
    // Wired after initStateEngine() so the DB connection + node_config exist.
    initSnapshotScheduler();

    // Step 2.6: Failover promotion sanity check (one-directional backup topology).
    // When a backup is restarted as the new primary, the operator sets
    // PROMOTED_FROM_BACKUP=true for that one boot; confirm the replicated ledger
    // is conservation-consistent BEFORE it starts taking live writes.
    if (process.env.PROMOTED_FROM_BACKUP === 'true') {
        promotionSanityCheck();
    }

    // Step 3: TLS certificates (LE or self-signed)
    await initTls();

    // Step 4: DNS shim for .local resolution
    startDnsShim();

    // Step 5: HTTP server (Trust Bootstrap or redirect)
    await startHttpServer(PORT_HTTP);

    // Step 6: HTTPS server (PWA + Settings API)
    await startHttpsServer(PORT_HTTPS);

    // Step 7: libp2p (persistent identity, no auto-discovery)
    const p2pNode = await startP2P(PORT_P2P, PORT_P2P_WS);

    // Step 8: Connector manager + Handshake + Federation protocols
    initConnectorManager(p2pNode);
    registerHandshakeHandler(p2pNode);
    registerFederationHandler(p2pNode);
    connectAll().catch((e) => console.warn('[Connectors] Initial connect failed:', e));

    // Step 8.5: Backup puller (one-directional live backup). On a node with
    // NODE_ROLE=backup, periodically pull the primary's signed snapshot over
    // HTTPS and import it. No-op on a primary (which imports from nobody). Wired
    // after the connector manager so the primary's `mirror` connector — the
    // trust anchor the import signature gate checks — is already loaded.
    initBackupPuller();

    // Step 9: Start cert renewal scheduler (checks every 24h)
    startRenewalScheduler();

    // Step 10: Start directory publisher
    initDirectoryPublisher();

    const hostname = process.env.CF_RECORD_NAME ?? 'beanpool.local';
    const isLE = !!process.env.CF_RECORD_NAME;
    console.log(`\n🟢 BeanPool Node is live  [role: ${getNodeRole()}${getNodeRole() === 'primary' ? ' — imports no inbound state' : ' — pulls snapshots from primary'}]\n`);
    console.log(`   PWA:      https://${hostname}${isLE ? '' : ':' + PORT_HTTPS}`);
    console.log(`   Settings: https://${hostname}${isLE ? '' : ':' + PORT_HTTPS}/settings`);
    console.log(`   P2P:      TCP :${PORT_P2P} / WS :${PORT_P2P_WS}`);
    console.log('');
}

main().catch((err) => {
    console.error('❌ BeanPool Node failed to start:', err);
    process.exit(1);
});
