process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ENABLE_PEER_CONNECTORS = 'true';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { addConnector, updateInboundHandshakeStatus } from './connector-manager.js';
import { saveLocalConfig, getLocalConfig } from './config/local-config.js';
import crypto from 'node:crypto';

const PORT = 8553;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running federation API tests (/api/node/info)...\n');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // ── 1. Setup Data ────────────────────────────────────────────────────────

    // Set community name
    const config = getLocalConfig();
    config.communityName = 'Test Federation Community';
    saveLocalConfig(config);

    // Add some members
    const { publicKey: pk1 } = crypto.generateKeyPairSync('ed25519');
    const pubHex1 = pk1.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubHex1, 'Alice');

    const { publicKey: pk2 } = crypto.generateKeyPairSync('ed25519');
    const pubHex2 = pk2.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubHex2, 'Bob');

    // Add some posts (active ones should be counted)
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, search_keywords) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?)`).run(
        'post-1', 'offer', 'general', 'Active Post 1', 'desc', 5, 'fixed', pubHex1, 1, 'active', 0, ''
    );
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, search_keywords) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?)`).run(
        'post-2', 'need', 'general', 'Active Post 2', 'desc', 10, 'fixed', pubHex2, 1, 'active', 0, ''
    );
    // Paused post shouldn't be counted
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, search_keywords) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?)`).run(
        'post-3', 'offer', 'general', 'Paused Post', 'desc', 5, 'fixed', pubHex1, 0, 'paused', 0, ''
    );

    // Add some connectors with full multiaddr so `peerIdFromAddress` works
    addConnector('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWpeer1', 'peer', 'Peer One', 'https://peer1.com');
    // Using updateInboundHandshakeStatus to mock successful connection
    // (peerId, initiatorTrusted, initiatorTrustLevel, initiatorActive)
    updateInboundHandshakeStatus('12D3KooWpeer1', true, 'peer', true);

    addConnector('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWpeer2', 'peer', 'Peer Two', 'https://peer2.com');
    // peer2 connected but remote node doesn't trust us back => not mutual
    updateInboundHandshakeStatus('12D3KooWpeer2', false, 'blocked', true);

    addConnector('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWpeer3', 'peer', 'Peer Three', 'https://peer3.com');
    // peer3 not connected (no status update)

    addConnector('/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWmirror', 'mirror', 'Mirror Node', 'https://mirror.com');
    updateInboundHandshakeStatus('12D3KooWmirror', true, 'mirror', true);


    // ── 2. Request Node Info ──────────────────────────────────────────────────
    const res = await fetch(`${BASE}/api/node/info`);
    assert(res.status === 200, `API responds with 200 (got ${res.status})`);

    const body = await res.json();
    assert(body.name === 'Test Federation Community', `name matches config (got ${body.name})`);

    assert(body.memberCount >= 2, `memberCount includes the active members (got ${body.memberCount})`);
    assert(body.postCount >= 2, `postCount includes active posts but not paused (got ${body.postCount})`);

    assert(Array.isArray(body.peerNodes), 'peerNodes is an array');

    // Check if peerNodes contains only connected, mutually trusted 'peer' nodes
    const peerNames = body.peerNodes.map((p: any) => p.callsign);
    assert(peerNames.includes('Peer One'), 'connected mutually-trusted peer is included');
    assert(!peerNames.includes('Peer Two'), 'peer without mutual trust is excluded');
    assert(!peerNames.includes('Peer Three'), 'disconnected peer is excluded');
    assert(!peerNames.includes('Mirror Node'), 'mirror node is excluded');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Federation API checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
