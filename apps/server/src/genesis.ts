/**
 * Genesis Logic
 *
 * On first boot, generates:
 * - A unique community_id (Ed25519 public key hash)
 * - A signed genesis block with the community's founding state
 *
 * Persisted to ./data/genesis.json so subsequent boots skip creation.
 */

import fs from 'node:fs';
import { writeFileAtomic } from './write-file-atomic.js';
import path from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { BeanPoolMerkleTree } from '@beanpool/core';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const GENESIS_PATH = path.join(DATA_DIR, 'genesis.json');

export interface GenesisState {
    communityId: string;
    publicKey: string;
    genesisHash: string;
    createdAt: string;
}

export async function ensureGenesis(): Promise<GenesisState> {
    // If genesis already exists, load and return it
    if (fs.existsSync(GENESIS_PATH)) {
        const raw = fs.readFileSync(GENESIS_PATH, 'utf-8');
        return JSON.parse(raw) as GenesisState;
    }

    // genesis.json gone but the community's key still here: not a first boot. A new genesis would write a new community
    // key over this one, and the community's trust root would change for good. Stop, and leave the key as it is.
    const communityKeyPath = path.join(DATA_DIR, 'community.key');
    if (fs.existsSync(communityKeyPath)) {
        const msg = `${GENESIS_PATH} is missing, but this server already has a community key (${communityKeyPath}). This server `
            + 'will not start a new community over it. Put back genesis.json from a backup of this server\'s data dir, then restart.';
        console.error(`🛑 [Genesis] ${msg}`);
        throw new Error(msg);
    }

    console.log('🌱 First boot detected — generating Genesis Block...');

    // Ensure data dir exists
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Generate the community's master keypair (Ed25519)
    const keypair = await generateKeyPair('Ed25519');
    const publicKeyBytes = keypair.publicKey.raw;
    const publicKeyHex = Buffer.from(publicKeyBytes).toString('hex');

    // Community ID is the first 16 chars of the public key hash
    const communityId = BeanPoolMerkleTree.hash(publicKeyHex).substring(0, 16);

    // Genesis hash signs the founding state with an empty ledger
    const genesisHash = BeanPoolMerkleTree.hash(
        `genesis:${communityId}:${Date.now()}`
    );

    const genesis: GenesisState = {
        communityId,
        publicKey: publicKeyHex,
        genesisHash,
        createdAt: new Date().toISOString(),
    };

    // Persist the private key separately (never exposed via API)
    const privateKeyBytes = keypair.raw;
    writeFileAtomic(
        communityKeyPath,
        Buffer.from(privateKeyBytes),
        { mode: 0o600 }
    );

    // Persist genesis state
    writeFileAtomic(GENESIS_PATH, JSON.stringify(genesis, null, 2));
    console.log('🌱 Genesis Block written to data/genesis.json');

    return genesis;
}
