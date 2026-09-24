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
// FIRST IMPORT, AND IT MUST STAY FIRST. ES modules evaluate every import below before the first statement
// of this file runs, and those imports are the whole application — db/db.ts opens SQLite at import. A crash
// while that graph loads (state.db unopenable, a native binding missing) is written to a Node diagnostic
// report before any statement here can tell Node to leave the environment out of it, and a node in that
// state crash-loops, so no boot ever reaches the scrub either. See report-privacy.ts; it imports nothing,
// deliberately.
import './report-privacy.js';

import fs from 'node:fs';
import path from 'node:path';
import { installProcessHandlers, scrubReportEnvironment } from './process-handlers.js';

// Step 0: the process-level error net, before anything else in this file runs. A stray rejected promise
// is recorded and the node keeps serving; a true uncaught exception still crashes and Docker still
// restarts. Both leave a record in the data dir. See process-handlers.ts for why the two differ.
installProcessHandlers();

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

// Now that the .env above has been read, the data dir is certain. On a self-hoster who sets
// BEANPOOL_DATA_DIR there rather than in the real environment, the scrub inside installProcessHandlers()
// looked in the wrong directory — this is the one that finds their old reports. Idempotent and, on a node
// with nothing to scrub, one readdir.
scrubReportEnvironment();

import { ensureGenesis } from './genesis.js';
import { initAdminPassword } from './config/local-config.js';
import { initTls, startRenewalScheduler } from './services/tls.js';
import { startDnsShim } from './dns-shim.js';
import { startHttpServer } from './http-server.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { initConnectorManager, connectAll } from './connector-manager.js';
import { registerHandshakeHandler } from './handshake.js';
import { registerFederationHandler, federatedReceiptStatus } from './federation-protocol.js';
import { startListingPull } from './federation-listings.js';
import { reconcileFederationLinks } from './federation-link.js';
import { recoverSettlements } from './federation-settlement-exchange.js';
import { initStateEngine, migrateAdminConversations, getNodeRole, createTreasury } from './state-engine.js';
import { initDirectoryPublisher } from './services/directory-publisher.js';
import { initPublicAddress } from './services/public-address-agent.js';
import { initBackupPuller } from './services/backup-puller.js';
import { initSnapshotScheduler } from './services/snapshot-scheduler.js';
import { startTakeoverEnvelopeService } from './services/takeover-envelope.js';
import { resumeTakeoverAtBoot, finishTakeoverAfterBoot } from './services/takeover.js';
import { startIdentityEpochWatch } from './services/identity-epoch.js';
import { scheduleDailyPulse } from './daily-pulse.js';
import { initHarvester } from './services/harvester.js';
import { startImageEvacuation } from './services/image-evacuation.js';
import { checkImageStoreAtBoot } from './storage/image-store.js';
import { startOrphanObjectSweep } from './engine/storage-health.js';
import { initAppStoreVersionChecks } from './app-store-versions.js';
import { initShutdownRecovery } from './engine/shutdown-recovery.js';

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

    // Step 2.1: Unclean shutdown detection & SQLite PRAGMA integrity_check
    const shutdownRecovery = initShutdownRecovery();
    if (shutdownRecovery.uncleanShutdown) {
        if (shutdownRecovery.ok) {
            console.log(`🛡️  ${shutdownRecovery.message}`);
        } else {
            console.error(`🚨 FATAL: ${shutdownRecovery.message}`);
            process.exit(1);
        }
    }

    // Step 2.5: Initialize state engine (ledger, members, marketplace)
    initStateEngine();
    migrateAdminConversations();

    // Step 2.55: Auto-snapshot scheduler — periodic local DB snapshots into
    // data/snapshots/ (Backup tab). Defaults to daily, keeping the last 7.
    // Wired after initStateEngine() so the DB connection + node_config exist.
    initSnapshotScheduler();

    // Step 2.6: Take-over (sealed-keys.md §5.4). BEFORE the node key is loaded (step 7) and before anything else
    // reads the role: finish any take-over step a crash interrupted, take the role from local-config.json (over
    // NODE_ROLE in .env), and run the ledger conservation audit once if a take-over left it pending. Never blocks
    // the boot; a failure is in data/takeover-journal.json and Settings.
    resumeTakeoverAtBoot();

    // Step 2.7: The image store (storage design §7). IMAGE_STORE=s3 with a setting missing, a bucket these
    // credentials cannot reach, photos still on this node's disk, or a standby role: the node does NOT start,
    // and says which. Never a silent fall back to disk. After the role is settled (2.6), before anything serves.
    console.log(`🖼️  Image store: ${await checkImageStoreAtBoot({ role: getNodeRole() })}`);

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

    // Step 7.1: the take-over envelope (sealed-keys.md §4) — the node's keys sealed to its owners and recovery
    // code. After libp2p, which creates data/libp2p_key on first boot. Never blocks boot: a failure is logged and
    // shown in the status. A standby seals nothing of its own.
    startTakeoverEnvelopeService({ standby: getNodeRole() === 'backup' })
        .catch((e) => console.warn('[Takeover] Envelope check at boot failed:', e?.message || e))
        // Step 7.2: after a take-over: tell the community, lock the keys again here, bring the tunnel back.
        .then(() => finishTakeoverAfterBoot())
        .catch((e) => console.warn('[Takeover] Finishing the take-over failed:', e?.message || e));

    // Step 7.3: the split-brain guard (sealed-keys.md §5.4). A main server asks its own public address, now and
    // hourly, whether another server has taken over its identity; if so it refuses members' writes. Not awaited:
    // the boot never waits on the network, and an unreachable address changes nothing.
    void startIdentityEpochWatch();

    // Step 8: Connector manager + Handshake + Federation protocols
    initConnectorManager(p2pNode);
    registerHandshakeHandler(p2pNode);
    registerFederationHandler(p2pNode);
    connectAll().catch((e) => console.warn('[Connectors] Initial connect failed:', e));

    // Step 8.05: link enterprises for capped peers (#143 step 3) — HERE, not in initStateEngine.
    //
    // It was in initStateEngine, which runs LONG BEFORE this line: the boot log showed bridge exemptions
    // registered at line 9 and `[Connectors] Loaded 1 connector(s) from disk` at line 20. So the reconcile
    // iterated an EMPTY connector list, created nothing, and logged nothing — and on an already-configured
    // node, where no cap is being set, that was the only path that would ever have created a link. Deployed
    // to two live nodes with correct caps and zero links appeared.
    //
    // The step-3 suite passed because it adds connectors over HTTP *after* initStateEngine and the cap route
    // reconciles them; the ordering that matters in production was the one nothing exercised. Sixth time this
    // shape has bitten this feature, and the first where my own test setup was what hid it — so
    // test-federation-link now boots from a connectors.json on disk, which is what a real node does.
    try {
        const n = reconcileFederationLinks(createTreasury);
        if (n > 0) console.log(`🔗 Created ${n} federation link enterprise(s) for capped peers`);
    } catch (e: any) {
        console.warn('[Federation] Failed to reconcile federation links:', e?.message || e);
    }

    // Step 8.1: Resolve settlements that were in flight when this node last stopped (#104 §2.5).
    //
    // Deliberately NOT gated on FEDERATION_SETTLEMENT_ENABLED: turning settlement off is a decision about
    // accepting NEW cross-node trades, and must not strand beans already in escrow or a seller already owed.
    //
    // Two passes, because the two halves have different prerequisites (review finding):
    //   1. Immediately, with no peer resolver — releases lapsed reservations, replays payments we already
    //      owe, and refunds holds interrupted before the ask. All local; none of it needs the network.
    //   2. After a delay, with the resolver — `connectAll()` above is fired detached, so dialling a peer
    //      right now fails for every row and leaves each one unresolved on every single boot. The pass is
    //      idempotent by design, so running it twice costs nothing.
    //
    // A delay rather than a connection-ready event because libp2p exposes none for "the peers I configured
    // are reachable", and waiting is always the safe side here — an unresolved row is retried next boot.
    // ...and then PERIODICALLY, not only at boot (review finding). A peer that was unreachable during the
    // startup window, a receipt lost in flight, or a held receipt blocked by a cap an operator has since
    // raised, would otherwise wait for the next process restart — which on a stable node could be months.
    // The escalation threshold is also crossed during uptime, so nothing would ever report it.
    const RECOVERY_PEER_DELAY_MS = 15_000;
    const RECOVERY_INTERVAL_MS = 15 * 60_000;
    const logRecoveryFailure = (e: any) => console.warn('[Federation] Settlement recovery failed:', e?.message || e);

    // Imported once, not per row: recovery now runs on a timer over every unfinalised settlement, so a
    // dynamic import inside the callback would repeat for each one on every cycle.
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const askPeerForStatus = async (peerId: string, key: string) =>
        federatedReceiptStatus(p2pNode, peerIdFromString(peerId), key);

    recoverSettlements().catch(logRecoveryFailure);

    // Non-overlapping: each run schedules the next only once it has finished, so a slow sweep against an
    // unresponsive peer can never pile up concurrent passes over the same rows.
    let recoveryRunning = false;
    const scheduleRecovery = (delay: number) => setTimeout(async () => {
        if (!recoveryRunning) {
            recoveryRunning = true;
            try { await recoverSettlements(askPeerForStatus); }
            catch (e) { logRecoveryFailure(e); }
            finally { recoveryRunning = false; }
        }
        scheduleRecovery(RECOVERY_INTERVAL_MS);
    }, delay).unref();

    scheduleRecovery(RECOVERY_PEER_DELAY_MS);

    // Step 8.2: The listing pull (#143 step 4). Ask each capped peer for the listings its members agreed to
    // share, and cache them with `origin_node` set. Pull rather than push because off-grid and solar nodes
    // sleep and a board that empties when a peer naps is not a board (§7).
    //
    // Started after the recovery wiring on purpose: recovering beans already in flight matters more than a
    // fresh board, and the pull's own first tick is delayed well past the connector auto-connect window.
    // A no-op when ENABLE_PEER_CONNECTORS is off, which is every node that has not opted in.
    startListingPull(p2pNode);

    // Step 8.5: Backup puller (one-directional live backup). On a node with
    // NODE_ROLE=backup, periodically pull the primary's signed snapshot over
    // HTTPS and import it. No-op on a primary (which imports from nobody). Wired
    // after the connector manager so the primary's `mirror` connector — the
    // trust anchor the import signature gate checks — is already loaded.
    initBackupPuller();

    // Step 8.6: Automated Fleet Harvester (drift-triggered backups + 30-day archiving)
    initHarvester();

    // Step 8.65: Move the images this node already holds out of state.db and into the image store
    // (storage design §7). Idempotent, batched, safe to interrupt, and a no-op once it has finished —
    // which on a node installed at this version or later is its first and only check.
    startImageEvacuation();

    // Step 8.66: Reclaim image-store objects no row points at, daily. Until now this only ever ran when an
    // admin pressed Clean, so on a node nobody administers a member's deleted photo stayed on the disk
    // indefinitely. Same pair of calls the button makes, same one-hour grace period, snapshots out of reach.
    startOrphanObjectSweep();

    // Step 8.7: Daily Pulse scheduler (auto-rotates daily 0-Bean inspirational offer at 5 AM)
    scheduleDailyPulse();

    // Step 8.8: App-store version lookup. The node checks the stores twice a day and
    // serves the answer in /api/community/health, so phones stop downloading the Play
    // Store listing page over their own metered connections to find out.
    initAppStoreVersionChecks();

    // Step 9: Start cert renewal scheduler (checks every 24h)
    startRenewalScheduler();

    // Step 10: Start directory publisher (primary only — a backup replica has no
    // public listing of its own; it mirrors the primary, it isn't a joinable node).
    if (getNodeRole() === 'primary') {
        initDirectoryPublisher();
        // Step 10.5: Auto public-address (opt-in via PUBLIC_ADDRESS_* env). Claims <name>.beanpool.org
        // from the registrar on boot and writes the tunnel token for the cloudflared sidecar. No-op unless enabled.
        initPublicAddress();
    }

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
