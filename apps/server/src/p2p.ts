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
import { writeFileAtomic } from './write-file-atomic.js';
import path from 'node:path';
import { announceAddrsFor } from './p2p-announce.js';

import type { Libp2p } from 'libp2p';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const KEY_PATH = path.join(DATA_DIR, 'libp2p_key');

let node: Libp2p;
let _privateKey: any;


/**
 * data/libp2p_key is there and is not a key this server can read (empty, cut off, not a key): the server stops. A new
 * random identity would be a different PeerId: standbys, take-over bundles and federation links pin this one, and the
 * file must stay as it is so the real key can be put back.
 */
export class NodeKeyUnreadableError extends Error {}

/**
 * The node's identity: data/libp2p_key, or on a new install (no file) a new Ed25519 key, saved 0600. A file that is
 * there and can't be read, or a new key that can't be saved, stops the start (NodeKeyUnreadableError): never a new
 * random identity for this run only, and never a write over the file.
 */
export async function loadOrCreateIdentity(): Promise<ReturnType<typeof privateKeyFromProtobuf>> {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(KEY_PATH)) {
        let why: string;
        try {
            const keyBytes = fs.readFileSync(KEY_PATH);
            if (keyBytes.length === 0) throw new Error('the file is empty');
            const privateKey = privateKeyFromProtobuf(keyBytes);
            console.log('🔑 Loaded persistent identity from disk.');
            return privateKey;
        } catch (e) {
            why = (e as Error).message;
        }
        const msg = `${KEY_PATH} is this server's node key (its PeerId), and it can't be read (${why}). This server will not `
            + 'start on a new random identity: its standbys, take-over bundles and federation links know it by this key. The file is '
            + 'left as it is. Put back libp2p_key from a backup of this server\'s data dir (a sealed backup restores it too), then restart. '
            + 'With no backup: move libp2p_key aside (rename it, for example to libp2p_key.old, and keep it) and restart. This server then '
            + 'starts with a new node key and a new PeerId. The community (genesis.json, community.key), its members and its address '
            + 'stay. But its standbys and federated servers know it by the old PeerId and must be given the new one (a standby is set '
            + 'up again), a backup collector pinned to the old PeerId must be told the new one, and members\' apps that pinned this '
            + 'server\'s notice key see its notices signed by a different key.';
        console.error(`🛑 [P2P] ${msg}`);
        throw new NodeKeyUnreadableError(msg);
    }

    console.log('🔑 Generating new Ed25519 identity...');
    const privateKey = await generateKeyPair('Ed25519');
    try {
        writeFileAtomic(KEY_PATH, privateKeyToProtobuf(privateKey), { mode: 0o600 });
    } catch (e) {
        const msg = `Could not save this server's new node key to ${KEY_PATH} (${(e as Error).message}). This server will not run `
            + 'on an identity it would lose at its next start. Make the data dir writable for the node, then restart.';
        console.error(`🛑 [P2P] ${msg}`);
        throw new NodeKeyUnreadableError(msg);
    }
    console.log('🔑 Identity saved to disk.');
    return privateKey;
}

export async function startP2P(tcpPort: number, wsPort: number): Promise<Libp2p> {
    _privateKey = await loadOrCreateIdentity();

    // If PUBLIC_IP is set, announce those addresses to bypass Docker NAT (IPv4 or IPv6; see p2p-announce.ts)
    const announceAddrs = announceAddrsFor(process.env.PUBLIC_IP, tcpPort, wsPort);

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
