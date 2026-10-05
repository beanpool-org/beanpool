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
import Database from 'better-sqlite3';
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

    // genesis.json gone but the community's key still here. A new install stopped between its two first writes (a kill,
    // a power cut, a full disk) starts again with a new community; anything else stops, and the key is left as it is: a
    // new genesis would write a new community key over this one, and the community's trust root would change for good.
    const communityKeyPath = path.join(DATA_DIR, 'community.key');
    if (fs.existsSync(communityKeyPath)) {
        const why = notABrandNewInstall(DATA_DIR);
        if (why) {
            const msg = `${GENESIS_PATH} is missing, but this server already has a community key (${communityKeyPath}), and it is not a `
                + `new install (${why}). This server will not start a new community over it; the key is left as it is. `
                + 'To start again, put back genesis.json from a backup of this server\'s data dir: a sealed backup, or a standby of '
                + 'this community, holds the same file. With no backup: move community.key aside (rename it, for example to '
                + 'community.key.old, and keep it) and restart. This server then starts a new community, with a new community key '
                + 'and community ID. Its database (members and balances) and local-config.json are not touched, but its standbys '
                + 'and the backups made so far carry the old community ID and genesis.json.';
            console.error(`🛑 [Genesis] ${msg}`);
            throw new Error(msg);
        }
        const keptAs = `${communityKeyPath}.unfinished-${Date.now()}`;
        fs.renameSync(communityKeyPath, keptAs);
        console.warn(`🌱 [Genesis] This server stopped during its first start, before genesis.json was written (it has no node key, `
            + `no members and no ledger yet). Its unfinished community key is kept as ${keptAs}; the community is made again.`);
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

/** Files a server holds once it has finished a first start, or once a take-over or a restore has begun writing into it. */
const NOT_NEW_INSTALL_FILES = ['libp2p_key', 'connectors.json', 'recovery-seal.key', 'open-join.key', 'takeover-journal.json'];

/**
 * Null only when this data dir is provably a new install that never finished its first start; otherwise why not.
 *
 * The proof: none of NOT_NEW_INSTALL_FILES is there, and state.db is missing or has no member (other than the synthetic
 * SYSTEM and genesis rows) and no ledger row. A new install writes community.key and genesis.json before it makes its
 * node key (startP2P, later in the same start), so every server that ever finished a start holds libp2p_key. A take-over
 * or sealed restore writes libp2p_key first, then community.key, then genesis.json (BUNDLED_FILES's order; a bundle with
 * no node key is refused), and a take-over keeps its journal while it runs, so one stopped half way is never taken for a
 * new install. A database that can't be read is no proof: the start stops.
 */
export function notABrandNewInstall(dataDir: string): string | null {
    for (const f of NOT_NEW_INSTALL_FILES) {
        if (fs.existsSync(path.join(dataDir, f))) return `it has ${f}`;
    }
    const dbPath = path.join(dataDir, 'state.db');
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
            const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
            const members = tables.has('members') ? count("SELECT COUNT(*) AS n FROM members WHERE public_key NOT IN ('SYSTEM', 'genesis')") : 0;
            if (members > 0) return `its database has ${members} member${members === 1 ? '' : 's'}`;
            const ledger = tables.has('transactions') ? count('SELECT COUNT(*) AS n FROM transactions') : 0;
            if (ledger > 0) return `its database has ${ledger} ledger row${ledger === 1 ? '' : 's'}`;
        } finally {
            db.close();
        }
    } catch (e) {
        return `its database can't be read (${(e as Error).message})`;
    }
    return null;
}
