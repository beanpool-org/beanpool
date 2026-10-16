/**
 * Connector first-dial pin (FED-07) — host:port connectors pin identity on first dial.
 *
 * THE BUG THIS PINS DOWN:
 * When an admin configured a connector as a plain host:port (e.g. us.beanpool.org:4001),
 * connector-manager overwrote status.peerId with whoever answered on EVERY dial.
 * If a different node later answered at that address (DNS change, reused IP, container restart),
 * that different node was treated as the linked peer and trusted, while the original node was no longer linked.
 *
 * THE FIX:
 * - The FIRST successful dial of a host:port connector records which node answered in `pinnedPeerId`.
 *   The connector's address string is NEVER rewritten.
 * - Every subsequent dial uses address + /p2p/<pinnedPeerId>, so libp2p itself (Noise protocol)
 *   refuses a different node identity.
 * - Refusal is recorded in the connector's status with lastError = "A different node answered at this address".
 * - A different node answering is NEVER trusted (isPeerTrusted returns false).
 * - Editing the connector's address clears `pinnedPeerId`, allowing deliberate re-linking.
 * - Connectors whose address already specifies /p2p/ remain unchanged.
 * - Legacy connectors.json files without pinnedPeerId load cleanly (absent = not yet recorded).
 *
 * Run with:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-connector-first-dial-pin.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdmin123!';
process.env.ENABLE_PEER_CONNECTORS = 'true';

import fs from 'node:fs';
import path from 'node:path';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import * as cm from './connector-manager.js';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';

let PORT = 0;
let BASE = '';
const PW = 'TestAdmin123!';
let tfa: ReturnType<typeof turnOn2faForTests> | null = null;
const DATA_DIR = process.env.BEANPOOL_DATA_DIR || '.';
const CONNECTORS_PATH = path.join(DATA_DIR, 'connectors.json');

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function postConnector(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/local/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, ...(tfa ? { totpCode: tfa.code() } : {}), ...body }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

async function dialOverHttp(address: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/local/connectors/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, ...(tfa ? { totpCode: tfa.code() } : {}), address }),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* no json */ }
    return { status: res.status, json };
}

async function makeNode(port = 0) {
    const node = await createLibp2p({
        addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: { identify: identify() },
    });
    await node.start();
    return node;
}

async function main() {
    console.log('Running connector first-dial pin tests (FED-07)...\n');

    initAdminPassword();
    await initTls();
    initStateEngine();

    // ── 1. Old connectors.json compatibility: field absent = not yet recorded ──
    const legacyHostPort = 'legacy.example.org:4001';
    fs.writeFileSync(CONNECTORS_PATH, JSON.stringify([{
        address: legacyHostPort,
        trustLevel: 'peer',
        enabled: true,
        callsign: 'legacy',
        addedAt: Date.now(),
    }], null, 2));

    const localNode = await makeNode(0);
    cm.initConnectorManager(localNode);

    const loaded = cm.getConnectorByAddress(legacyHostPort);
    assert(loaded !== null && loaded.pinnedPeerId === undefined,
        `1a. legacy connectors file loads cleanly with pinnedPeerId undefined (got ${loaded?.pinnedPeerId})`);
    assert(loaded?.lastError === null && loaded?.error === null,
        `1b. legacy connector initializes with lastError null`);

    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    tfa = turnOn2faForTests(PW);

    // ── 2. Add 127.0.0.1:<port> as a peer connector and dial node X ──
    const nodeX = await makeNode(0);
    const portX = Number(nodeX.getMultiaddrs()[0].toString().split('/tcp/')[1].split('/')[0]);
    const peerIdX = nodeX.peerId.toString();
    const hostPortAddr = `127.0.0.1:${portX}`;

    const addRes = await postConnector({ address: hostPortAddr, trustLevel: 'peer', callsign: 'NodeX' });
    assert(addRes.status === 200 && addRes.json?.success === true,
        `2a. added host:port connector ${hostPortAddr}`);

    const beforeDial = cm.getConnectorByAddress(hostPortAddr);
    assert(beforeDial?.pinnedPeerId === undefined,
        `2b. before first dial, pinnedPeerId is undefined`);

    const dialXRes = await dialOverHttp(hostPortAddr);
    assert(dialXRes.status === 200 && dialXRes.json?.success === true,
        `2c. first dial to node X succeeded`);

    const afterDial1 = cm.getConnectorByAddress(hostPortAddr);
    assert(afterDial1?.pinnedPeerId === peerIdX,
        `2d. record holds node X's peer ID in pinnedPeerId (got ${afterDial1?.pinnedPeerId})`);
    assert(afterDial1?.address === hostPortAddr,
        `2e. connector address string was NOT rewritten (got ${afterDial1?.address})`);
    assert(cm.isPeerTrusted(peerIdX).trusted === true,
        `2f. node X is linked and trusted`);

    // Verify pinnedPeerId persisted to connectors.json on disk
    const onDisk1 = JSON.parse(fs.readFileSync(CONNECTORS_PATH, 'utf-8'));
    const diskRecord1 = onDisk1.find((c: any) => c.address === hostPortAddr);
    assert(diskRecord1?.pinnedPeerId === peerIdX,
        `2g. pinnedPeerId persisted to connectors.json on disk`);

    // ── 3. Stop X, start node Y (different key) on the same port, dial again ──
    await nodeX.stop();

    const nodeY = await makeNode(portX);
    const peerIdY = nodeY.peerId.toString();
    assert(peerIdY !== peerIdX,
        `3a. node Y has a different peer ID (${peerIdY} vs ${peerIdX})`);

    const dialYRes = await dialOverHttp(hostPortAddr);
    assert(dialYRes.status === 200 && dialYRes.json?.success === false,
        `3b. dialing node Y at same host:port is refused (dial returned false)`);

    const afterDial2 = cm.getConnectorByAddress(hostPortAddr);
    assert(afterDial2?.lastError === 'A different node answered at this address',
        `3c. connector lastError shows refusal: "${afterDial2?.lastError}"`);
    assert(afterDial2?.error === 'A different node answered at this address',
        `3d. connector error shows refusal: "${afterDial2?.error}"`);
    assert(cm.isPeerTrusted(peerIdY).trusted === false,
        `3e. node Y is NOT linked or trusted (isPeerTrusted is false)`);
    assert(afterDial2?.pinnedPeerId === peerIdX,
        `3f. node X is STILL the recorded pinnedPeerId`);

    // ── 4. Edit connector's address and dial: Y is recorded and linked ──
    const newHostPortAddr = `localhost:${portX}`;
    const editRes = await postConnector({
        address: newHostPortAddr,
        oldAddress: hostPortAddr,
        trustLevel: 'peer',
        callsign: 'NodeY',
    });
    assert(editRes.status === 200 && editRes.json?.success === true,
        `4a. edited connector address from ${hostPortAddr} to ${newHostPortAddr}`);

    const afterEdit = cm.getConnectorByAddress(newHostPortAddr);
    assert(afterEdit?.pinnedPeerId === undefined,
        `4b. editing connector address cleared pinnedPeerId (got ${afterEdit?.pinnedPeerId})`);

    const dialYAfterEdit = await dialOverHttp(newHostPortAddr);
    assert(dialYAfterEdit.status === 200 && dialYAfterEdit.json?.success === true,
        `4c. dial to node Y after address edit succeeded`);

    const afterDial3 = cm.getConnectorByAddress(newHostPortAddr);
    assert(afterDial3?.pinnedPeerId === peerIdY,
        `4d. node Y is now recorded in pinnedPeerId (got ${afterDial3?.pinnedPeerId})`);
    assert(cm.isPeerTrusted(peerIdY).trusted === true,
        `4e. node Y is now linked and trusted`);
    assert(cm.isPeerTrusted(peerIdX).trusted === false,
        `4f. node X is no longer linked or trusted`);

    // ── 5. Connector with full /p2p/ address remains unchanged ──
    const fullP2pAddr = `/ip4/127.0.0.1/tcp/${portX}/p2p/${peerIdY}`;
    const addFull = await postConnector({ address: fullP2pAddr, trustLevel: 'peer', callsign: 'FullP2P' });
    assert(addFull.status === 200 && addFull.json?.success === true,
        `5a. added full multiaddr connector`);

    const dialFull = await dialOverHttp(fullP2pAddr);
    assert(dialFull.status === 200 && dialFull.json?.success === true,
        `5b. dial full multiaddr succeeded`);

    const fullConnector = cm.getConnectorByAddress(fullP2pAddr);
    assert(fullConnector?.pinnedPeerId === undefined,
        `5c. connector with /p2p/ does not set pinnedPeerId (already specified in address)`);

    // ── 6. Unrecorded connector at non-libp2p port does not get identity mismatch error (N1) ──
    const nonP2pAddr = `127.0.0.1:${PORT}`;
    const addNonP2p = await postConnector({ address: nonP2pAddr, trustLevel: 'peer', callsign: 'HttpsPort' });
    assert(addNonP2p.status === 200 && addNonP2p.json?.success === true,
        `6a. added unrecorded connector at HTTPS port`);

    const dialNonP2p = await dialOverHttp(nonP2pAddr);
    assert(dialNonP2p.status === 200 && dialNonP2p.json?.success === false,
        `6b. dial to non-libp2p port failed`);

    const nonP2pConn = cm.getConnectorByAddress(nonP2pAddr);
    assert(nonP2pConn?.error !== 'A different node answered at this address',
        `6c. unrecorded connector at non-libp2p port must not get "A different node answered at this address" (got: "${nonP2pConn?.error}")`);
    assert(nonP2pConn?.pinnedPeerId === undefined,
        `6d. unrecorded connector was not pinned`);

    // Cleanup
    await localNode.stop();
    await nodeY.stop();

    console.log(`\n${passed}/${run} connector first-dial pin tests passed.\n`);
    if (passed < run) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
