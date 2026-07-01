/**
 * libp2p P2P Transport Layer — Federated Node
 *
 * Handles:
 * - TCP transport on port 4001
 * - WebSocket transport on port 4002
 * - Noise encryption
 * - Yamux stream multiplexing
 * - Persistent Ed25519 identity (saved to data/libp2p_key)
 * - Ping service for latency measurement
 * - PUBLIC_IP announcement for Docker NAT bypass
 *
 * No automatic peer discovery. Connections are managed
 * exclusively by the Connector Manager.
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import fs from 'node:fs';
import path from 'node:path';

import type { Libp2p } from 'libp2p';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const KEY_PATH = path.join(DATA_DIR, 'libp2p_key');

let node: Libp2p;
let _privateKey: any;


async function loadOrCreateIdentity() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        if (fs.existsSync(KEY_PATH)) {
            const keyBytes = fs.readFileSync(KEY_PATH);
            const privateKey = privateKeyFromProtobuf(keyBytes);
            console.log('🔑 Loaded persistent identity from disk.');
            return privateKey;
        }

        console.log('🔑 Generating new Ed25519 identity...');
        const privateKey = await generateKeyPair('Ed25519');
        fs.writeFileSync(KEY_PATH, privateKeyToProtobuf(privateKey));
        console.log('🔑 Identity saved to disk.');
        return privateKey;
    } catch (e) {
        console.error('[P2P] Failed to load/create identity:', e);
        console.log('🔑 Falling back to ephemeral identity.');
        return await generateKeyPair('Ed25519');
    }
}

export async function startP2P(tcpPort: number, wsPort: number): Promise<Libp2p> {
    _privateKey = await loadOrCreateIdentity();

    // If PUBLIC_IP is set, announce those addresses to bypass Docker NAT
    const publicIp = process.env.PUBLIC_IP;
    const announceAddrs = publicIp ? [
        `/ip4/${publicIp}/tcp/${tcpPort}`,
        `/ip4/${publicIp}/tcp/${wsPort}/ws`,
    ] : undefined;

    node = await createLibp2p({
        privateKey: _privateKey,
        addresses: {
            listen: [
                `/ip4/0.0.0.0/tcp/${tcpPort}`,
                `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
            ],
            announce: announceAddrs,
        },
        transports: [tcp(), webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
            identify: identify(),
        },
    });

    await node.start();

    const peerId = node.peerId.toString();
    const addrs = node.getMultiaddrs().map((ma) => ma.toString());

    console.log(`🌐 libp2p started — PeerId: ${peerId}`);
    addrs.forEach((a) => console.log(`   ${a}`));

    return node;
}

export function getP2PNode(): Libp2p {
    return node;
}

export function getPrivateKey(): any {
    return _privateKey;
}
