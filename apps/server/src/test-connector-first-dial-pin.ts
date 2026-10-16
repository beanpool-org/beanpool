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
 * - Refusal is recorded in the connector's status with error = "A different node answered at this address".
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
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import * as cm from './connector-manager.js';
import { registerHandshakeHandler } from './handshake.js';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { generateKeyPair } from '@libp2p/crypto/keys';

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

async function removeConnectorOverHttp(address: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/local/connectors/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PW, ...(tfa ? { totpCode: tfa.code() } : {}), address }),
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

async function makeNode(port = 0, privateKey?: any) {
    const node = await createLibp2p({
        privateKey: privateKey ?? await generateKeyPair('Ed25519'),
        addresses: { listen: [`/ip4/127.0.0.1/tcp/${port}`] },
        transports: [tcp()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: { identify: identify() },
    });
    await node.start();
    return node;
}

async function rpc(node: any, target: any, protocol: string, obj: object, timeout = 6000): Promise<any> {
    const s = await node.dialProtocol(target, protocol);
    const chunks: Uint8Array[] = [];
    const reader = (async () => {
        for await (const c of s) {
            chunks.push(c instanceof Uint8Array ? c : (c as any).subarray());
        }
    })().catch(() => {});
    s.send(new TextEncoder().encode(JSON.stringify(obj)));
    await s.close();
    await Promise.race([reader, new Promise(r => setTimeout(r, timeout))]);
    const raw = Buffer.concat(chunks).toString();
    return raw ? JSON.parse(raw) : { __noAnswer: true, status: s.status };
}

async function child() {
    const childIdx = process.argv.indexOf('--child');
    const dir = process.argv[childIdx + 1];
    const port = process.argv[childIdx + 2];
    const xId = process.argv[childIdx + 3];
    const yId = process.argv[childIdx + 4];

    const { initStateEngine } = await import('./state-engine.js');
    const cm = await import('./connector-manager.js');
    initStateEngine();
    const v = await makeNode(0);
    cm.initConnectorManager(v);

    const addr = `127.0.0.1:${port}`;
    const before = cm.getConnectorByAddress(addr);
    if (!before || before.pinnedPeerId !== xId || before.peerId !== xId) {
        console.error('Child check failed before dial', before);
        process.exit(10);
    }
    if (!cm.isPeerTrusted(xId).trusted || cm.isPeerTrusted(yId).trusted) {
        console.error('Child trust check failed before dial');
        process.exit(11);
    }

    const ok = await cm.connectToAddress(addr);
    if (ok !== false) {
        console.error('Child dial should have returned false, got', ok);
        process.exit(12);
    }

    const after = cm.getConnectorByAddress(addr);
    if (after?.error !== 'A different node answered at this address' || after?.pinnedPeerId !== xId) {
        console.error('Child check failed after dial', after);
        process.exit(13);
    }
    if (!cm.isPeerTrusted(xId).trusted || cm.isPeerTrusted(yId).trusted) {
        console.error('Child trust check failed after dial');
        process.exit(14);
    }

    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'connectors.json'), 'utf8'));
    if (disk[0]?.pinnedPeerId !== xId) {
        console.error('Child disk check failed', disk);
        process.exit(15);
    }

    await v.stop();
    process.exit(0);
}

function proxy(plan: Array<{ port: number; delay: number }>): Promise<{ port: number; close: () => void }> {
    let n = 0;
    const server = net.createServer((client) => {
        const step = plan[Math.min(n++, plan.length - 1)];
        client.pause();
        setTimeout(() => {
            const up = net.connect(step.port, '127.0.0.1', () => { client.pipe(up); up.pipe(client); client.resume(); });
            up.on('error', () => client.destroy());
            client.on('error', () => up.destroy());
        }, step.delay);
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: (server.address() as any).port, close: () => server.close() })));
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
    registerHandshakeHandler(localNode);

    const loaded = cm.getConnectorByAddress(legacyHostPort);
    assert(loaded !== null && loaded.pinnedPeerId === undefined,
        `1a. legacy connectors file loads cleanly with pinnedPeerId undefined (got ${loaded?.pinnedPeerId})`);
    assert(loaded?.error === null,
        `1b. legacy connector initializes with error null`);

    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    tfa = turnOn2faForTests(PW);

    // ── 2. Add 127.0.0.1:<port> as a peer connector and dial node X ──
    const kx = await generateKeyPair('Ed25519');
    const nodeX = await makeNode(0, kx);
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

    // ── Panel's Make Passive / Make Active and oldAddress === address save keep pinnedPeerId (N2) ──
    await postConnector({ address: hostPortAddr, trustLevel: 'peer', callsign: 'NodeX', enabled: false });
    assert(cm.getConnectorByAddress(hostPortAddr)?.pinnedPeerId === peerIdX,
        `2h. panel "Make Passive" body keeps pinnedPeerId`);

    await postConnector({ address: hostPortAddr, trustLevel: 'peer', callsign: 'NodeX', enabled: true });
    assert(cm.getConnectorByAddress(hostPortAddr)?.pinnedPeerId === peerIdX,
        `2i. panel "Make Active" body keeps pinnedPeerId`);

    await postConnector({ address: hostPortAddr, oldAddress: hostPortAddr, trustLevel: 'peer', callsign: 'NodeX-Renamed' });
    assert(cm.getConnectorByAddress(hostPortAddr)?.pinnedPeerId === peerIdX,
        `2j. save with oldAddress === address keeps pinnedPeerId`);

    await postConnector({ address: hostPortAddr, trustLevel: 'blocked', callsign: 'BlockedNodeX' });
    assert(cm.getConnectorByAddress(hostPortAddr)?.pinnedPeerId === peerIdX,
        `2k. panel add form re-submitted with blocked keeps pinnedPeerId`);

    await postConnector({ address: hostPortAddr, trustLevel: 'peer', callsign: 'NodeX' });
    assert(cm.getConnectorByAddress(hostPortAddr)?.pinnedPeerId === peerIdX,
        `2l. panel save back to peer keeps pinnedPeerId`);

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
    assert(afterDial2?.error === 'A different node answered at this address',
        `3c. connector error shows refusal: "${afterDial2?.error}"`);
    assert(cm.isPeerTrusted(peerIdY).trusted === false,
        `3d. node Y is NOT linked or trusted (isPeerTrusted is false)`);
    assert(afterDial2?.pinnedPeerId === peerIdX,
        `3e. node X is STILL the recorded pinnedPeerId`);

    // ── 3b. Inbound dials (Y dials in; X dials in from a new address) ──
    const localAddr = localNode.getMultiaddrs()[0];
    const resY = await rpc(nodeY, localAddr, '/beanpool/handshake/1.0.0', {
        type: 'handshake_req',
        ts: Date.now(),
        youAreTrusted: true,
        trustLevel: 'peer',
        active: true,
    });
    assert(resY?.youAreTrusted === false, `3g. inbound handshake from node Y refused (youAreTrusted is false)`);

    const stAfterYInbound = cm.getConnectorByAddress(hostPortAddr);
    assert(stAfterYInbound?.connected === false && stAfterYInbound?.mutualTrust === false,
        `3h. connector status unchanged after Y inbound (connected: ${stAfterYInbound?.connected}, mutualTrust: ${stAfterYInbound?.mutualTrust})`);

    const nodeX2 = await makeNode(0, kx);
    const resX = await rpc(nodeX2, localAddr, '/beanpool/handshake/1.0.0', {
        type: 'handshake_req',
        ts: Date.now(),
        youAreTrusted: true,
        trustLevel: 'peer',
        active: true,
    });
    assert(resX?.youAreTrusted === true, `3i. inbound handshake from node X (new port) accepted (youAreTrusted is true)`);

    const stAfterXInbound = cm.getConnectorByAddress(hostPortAddr);
    assert(stAfterXInbound?.connected === true && stAfterXInbound?.mutualTrust === true,
        `3j. connector status marked connected and mutualTrust true after X inbound`);

    await localNode.hangUp(nodeX2.peerId).catch(() => {});
    await nodeX2.stop();
    await cm.disconnectFromAddress(hostPortAddr);

    // ── 4. Remove and add again (changing address is remove + add): fresh record links Y ──
    const removeRes = await removeConnectorOverHttp(hostPortAddr);
    assert(removeRes.status === 200 && removeRes.json?.success === true,
        `4a. removed old connector ${hostPortAddr}`);

    const newHostPortAddr = `localhost:${portX}`;
    const addAgainRes = await postConnector({
        address: newHostPortAddr,
        trustLevel: 'peer',
        callsign: 'NodeY',
    });
    assert(addAgainRes.status === 200 && addAgainRes.json?.success === true,
        `4b. added new connector ${newHostPortAddr} with fresh record`);

    const afterAddAgain = cm.getConnectorByAddress(newHostPortAddr);
    assert(afterAddAgain?.pinnedPeerId === undefined,
        `4c. fresh record starts with pinnedPeerId undefined (got ${afterAddAgain?.pinnedPeerId})`);

    const dialYAfterEdit = await dialOverHttp(newHostPortAddr);
    assert(dialYAfterEdit.status === 200 && dialYAfterEdit.json?.success === true,
        `4d. dial to node Y after address change succeeded`);

    const afterDial3 = cm.getConnectorByAddress(newHostPortAddr);
    assert(afterDial3?.pinnedPeerId === peerIdY,
        `4e. node Y is now recorded in pinnedPeerId (got ${afterDial3?.pinnedPeerId})`);
    assert(cm.isPeerTrusted(peerIdY).trusted === true,
        `4f. node Y is now linked and trusted`);
    assert(cm.isPeerTrusted(peerIdX).trusted === false,
        `4g. node X is no longer linked or trusted`);

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

    // ── 7. Concurrent first dials with different answerers (N4) ──
    const nodeZ = await makeNode(0);
    const portZ = Number(nodeZ.getMultiaddrs()[0].toString().split('/tcp/')[1].split('/')[0]);
    const peerIdZ = nodeZ.peerId.toString();

    // px: 1st connection goes to nodeY (slow, 300ms delay), 2nd connection goes to nodeZ (fast, 0ms delay)
    const px = await proxy([{ port: portX, delay: 300 }, { port: portZ, delay: 0 }]);
    const racedAddr = `127.0.0.1:${px.port}`;
    cm.addConnector(racedAddr, 'peer', 'Raced');

    const dial1Promise = cm.connectToAddress(racedAddr);
    await new Promise(r => setTimeout(r, 50));
    const dial2Promise = cm.connectToAddress(racedAddr);

    const res2 = await dial2Promise; // fast dial to nodeZ finishes first
    const res1 = await dial1Promise; // slow dial to nodeY finishes second

    assert(res2 === true, `7a. fast first dial to node Z succeeded`);
    assert(res1 === false, `7b. raced first dial to node Y was refused (got ${res1})`);

    const racedConn = cm.getConnectorByAddress(racedAddr);
    assert(racedConn?.pinnedPeerId === peerIdZ,
        `7c. pinnedPeerId is node Z (got ${racedConn?.pinnedPeerId})`);
    // The link to Z is up: the refused dial to Y leaves it connected and quiet (review check of fix round 1, N4).
    assert(racedConn?.connected === true && racedConn?.peerId === peerIdZ && racedConn?.error === null,
        `7d. the healthy link to node Z stays connected, with no error (connected=${racedConn?.connected}, error=${racedConn?.error})`);
    // Y is still named by the connectors of cases 4 and 5 (its record, its /p2p/ address): their link is not cut.
    assert(cm.getConnectorByPeerId(peerIdY)?.address !== racedAddr && localNode.getConnections(nodeY.peerId).length > 0,
        `7e. the refused dial closed only its own connection: Y's other connectors keep theirs (${localNode.getConnections(nodeY.peerId).length})`);

    cm.removeConnector(racedAddr);
    px.close();
    await nodeZ.stop();

    // 7f. The same race with a node no connector names: it is hung up entirely.
    const nodeW = await makeNode(0);
    const nodeV = await makeNode(0);
    const portOf = (n: any) => Number(n.getMultiaddrs()[0].toString().split('/tcp/')[1].split('/')[0]);
    const pxW = await proxy([{ port: portOf(nodeW), delay: 300 }, { port: portOf(nodeV), delay: 0 }]);
    const racedAddrW = `127.0.0.1:${pxW.port}`;
    cm.addConnector(racedAddrW, 'peer', 'RacedW');
    const slowW = cm.connectToAddress(racedAddrW);
    await new Promise(r => setTimeout(r, 50));
    const fastV = await cm.connectToAddress(racedAddrW);
    const refusedW = await slowW;
    assert(fastV === true && refusedW === false && cm.getConnectorByAddress(racedAddrW)?.pinnedPeerId === nodeV.peerId.toString()
        && localNode.getConnections(nodeW.peerId).length === 0,
        `7f. a refused node that no connector names is hung up (connections ${localNode.getConnections(nodeW.peerId).length})`);
    cm.removeConnector(racedAddrW);
    pxW.close();
    await nodeW.stop();
    await nodeV.stop();

    // ── 8. Stale pinnedPeerId on /p2p/ connector dropped in migrateConnector (N5) ──
    const staleP2pAddr = `/ip4/127.0.0.1/tcp/1234/p2p/${peerIdY}`;
    fs.writeFileSync(CONNECTORS_PATH, JSON.stringify([{
        address: staleP2pAddr,
        trustLevel: 'peer',
        enabled: true,
        pinnedPeerId: peerIdX, // stale pin
    }], null, 2));

    cm.loadConnectors();

    const migrated = cm.getConnectorByAddress(staleP2pAddr);
    assert(migrated?.pinnedPeerId === undefined,
        `8a. stale pinnedPeerId was dropped for /p2p/ connector (got ${migrated?.pinnedPeerId})`);
    assert(cm.isPeerTrusted(peerIdY).trusted === true,
        `8b. peer ID in address is trusted`);
    assert(cm.isPeerTrusted(peerIdX).trusted === false,
        `8c. stale pinned peer ID is NOT trusted`);

    const diskAfterMigration = JSON.parse(fs.readFileSync(CONNECTORS_PATH, 'utf-8'));
    assert(diskAfterMigration[0]?.pinnedPeerId === undefined,
        `8d. stale pinnedPeerId was removed from disk on migration`);

    // ── 9. Restart: fresh process reads the record and refuses Y ──
    const childDir = fs.mkdtempSync(path.join(DATA_DIR, 'restart-test-'));
    fs.writeFileSync(path.join(childDir, 'connectors.json'), JSON.stringify([{
        address: hostPortAddr,
        trustLevel: 'peer',
        enabled: true,
        callsign: 'Partner',
        addedAt: 1,
        pinnedPeerId: peerIdX,
    }], null, 2));

    const here = fileURLToPath(import.meta.url);
    const childExitCode = await new Promise<number>((resolve) => {
        const c = spawn(process.execPath, [
            ...process.execArgv,
            here,
            '--child',
            childDir,
            String(portX),
            peerIdX,
            peerIdY,
        ], {
            env: {
                ...process.env,
                BEANPOOL_DATA_DIR: childDir,
                ENABLE_PEER_CONNECTORS: 'true',
            },
            stdio: ['ignore', 'inherit', 'inherit'],
        });
        c.on('exit', (code) => resolve(code ?? 1));
    });
    assert(childExitCode === 0, `9a. fresh process restart correctly loaded pinnedPeerId, refused node Y, and kept pinnedPeerId (exit ${childExitCode})`);

    // Cleanup
    await localNode.stop();
    await nodeY.stop();

    console.log(`\n${passed}/${run} connector first-dial pin tests passed.\n`);
    if (passed < run) process.exit(1);
    process.exit(0);
}

if (process.argv.includes('--child')) {
    child().catch((err) => {
        console.error('Child failed:', err);
        process.exit(1);
    });
} else {
    main().catch((err) => {
        console.error('Test failed with error:', err);
        process.exit(1);
    });
}
