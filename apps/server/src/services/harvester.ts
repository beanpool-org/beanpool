/**
 * Automated Fleet Harvester Service
 *
 * Periodically checks fleet nodes for metric drift (member, post, tx count changes) and, on drift, pulls the node's
 * backup. What it keeps depends on what the node sends (seal review round 1):
 *
 * - A LOCKED backup (the node has a recovery code; sealed-keys.md §6.3) is stored as it arrives in
 *   ./backups/<nodeId>/sealed/beanpool-<ts>.bpsealed, the newest file and one a day for 30 days. The harvester cannot
 *   open it and does not need to: the code opens it, and it carries the node keys inside, locked.
 * - A READABLE backup (a node with no recovery code, or one older than locked backups) is kept exactly as before:
 *   ./backups/<nodeId>/state.db plus ./backups/<nodeId>/history/beanpool-YYYY-MM-DD.db (30 days), and the status
 *   says the node's backups are not locked yet.
 *
 * A failed pull backs off (5 minutes, doubling to 6 hours) instead of asking again every minute.
 *
 * The seal-old pass (§6.4) locks the readable files held for a node — but only when the newest backup from the node
 * is locked, has a recovery-code stanza, and is signed by the node key the harvester already knows (a `peerId` in
 * manager-nodes.json, or the key file it collected before). Without all three it deletes nothing and says why.
 * With them, it deletes a readable file only after its locked copy has been read back from disk and opened.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { readSealedHeader, verifySealedHeader, type CodeStanza, type SealedEnvelopeHeader } from '@beanpool/core';
import { sealFileVerified, checkBackupArchive } from './sealed-backup.js';
import { peerIdOfKeyFile } from './takeover-envelope.js';

export interface FleetNodeConfig {
    id: string;
    name: string;
    url: string;
    adminPassword?: string;
    replicationToken?: string;
    /** The node's PeerId (its libp2p key), set by the operator. The seal-old pass trusts only a header it signed. */
    peerId?: string;
}

export interface NodeHarvestState {
    nodeId: string;
    nodeName: string;
    nodeUrl: string;
    lastHarvestAt: string | null;
    lastSuccessAt: string | null;
    status: 'idle' | 'harvesting' | 'ok' | 'error';
    error: string | null;
    dbSizeBytes: number;
    memberCount: number;
    postCount: number;
    /** 'secured' = a locked backup is held, and it carries the node keys. 'partial' = only a readable backup (no keys). */
    identityStatus: 'secured' | 'partial' | 'missing';
    /** Why identity is not 'secured', in words for the dashboard; null when it is. */
    identityNote?: string | null;
    /** The locked file that holds the keys (the newest locked backup), when there is one. */
    identityFiles: string[];
    /** How many backups are held: locked files plus readable daily copies. */
    historyCount: number;
    /** What the node said about its latest backup: locked, or not locked yet and why. Unset until the first pull. */
    backupLock?: { locked: boolean; message: string; at: string };
    /** After a failed pull: no automatic pull again before `nextPullAt` (a forced one still goes). */
    pullBackoff?: { failures: number; nextPullAt: string; lastError: string };
    /** The node key the seal-old pass trusts, and where it came from. */
    pinnedPeerId?: string | null;
    pinSource?: 'manager-nodes.json' | 'collected key file' | null;
    /** The newest backup held, read from its public header when locked (§6.3). */
    sealedBackup?: {
        state: 'sealed' | 'unlocked' | 'none';
        file: string | null;
        sizeBytes: number;
        envelopeId: string | null;
        sealedAt: string | null;
        /** The PeerId that signed the header: the node, for a backup it made. */
        sealedBy: string | null;
        owners: string[];
        codeIds: number[];
        /** One sentence for the dashboard, e.g. "Sealed backup held: sealed 2026-10-03 14:02 UTC, locked to 2 owners + recovery code #1." */
        message: string;
    };
    /** The seal-old pass (§6.4): which readable files were locked, what is still readable, and why if it did not run. */
    sealOld?: { lastRunAt: string; sealed: string[]; left: string[]; error: string | null };
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'harvester-state.json');
const NODES_FILE = path.join(DATA_DIR, 'manager-nodes.json');

const DEFAULT_HARVEST_INTERVAL_MS = 60_000;
let harvesterTimer: NodeJS.Timeout | null = null;

// Default starter nodes if manager-nodes.json doesn't exist yet
const DEFAULT_NODES: FleetNodeConfig[] = [
    { id: 'test', name: 'Test Staging Node', url: 'https://test.beanpool.org' },
    { id: 'mullum', name: 'Mullumbimby', url: 'https://mullum.beanpool.org' },
    { id: 'bris', name: 'Brisbane', url: 'https://bris.beanpool.org' },
    { id: 'bindarrabi', name: 'Bindarrabi', url: 'https://bindarrabi.beanpool.org' },
    { id: 'eastgippy', name: 'East Gippsland', url: 'https://eastgippy.beanpool.org' },
    { id: 'gippsland', name: 'Gippsland', url: 'https://gippsland.beanpool.org' },
    { id: 'castlemaine', name: 'Castlemaine', url: 'https://castlemaine.beanpool.org' },
    { id: 'melb', name: 'Melbourne', url: 'https://melb.beanpool.org' },
    { id: 'review', name: 'Review Node', url: 'https://review.beanpool.org' },
];

export function nodeSlug(target: string | { id: string; url?: string; name?: string }): string {
    if (!target) return 'unknown';
    const rawId = typeof target === 'string' ? target : (target?.id || '');
    const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const url = typeof target === 'object' ? (target?.url || '') : '';
    const name = typeof target === 'object' ? (target?.name || '') : '';

    if (['test', 'mullum', 'bris', 'bindarrabi', 'eastgippy', 'gippsland', 'castlemaine', 'melb', 'review', 'local-node'].includes(cleanId)) {
        return cleanId;
    }

    const str = `${rawId} ${url} ${name}`.toLowerCase();
    if (str.includes('test')) return 'test';
    if (str.includes('mullum')) return 'mullum';
    if (str.includes('bris')) return 'bris';
    if (str.includes('bindarrabi')) return 'bindarrabi';
    if (str.includes('eastgippy') || str.includes('east-gippsland')) return 'eastgippy';
    if (str.includes('gippsland')) return 'gippsland';
    if (str.includes('castlemaine')) return 'castlemaine';
    if (str.includes('melb') || str.includes('melbourne')) return 'melb';
    if (str.includes('review')) return 'review';
    if (str.includes('localhost') || str.includes('127.0.0.1')) return 'local-node';

    return cleanId || 'unknown';
}

export function getNodes(): FleetNodeConfig[] {
    try {
        if (fs.existsSync(NODES_FILE)) {
            const raw = fs.readFileSync(NODES_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {
        console.warn('[Harvester] Failed to read manager-nodes.json:', e);
    }
    return DEFAULT_NODES;
}

export function saveNodes(nodes: FleetNodeConfig[]): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NODES_FILE, JSON.stringify(nodes, null, 2));
}

export function loadHarvestState(): Record<string, NodeHarvestState> {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

function saveHarvestState(state: Record<string, NodeHarvestState>): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function normalizeUrl(url: string): string {
    let trimmed = (url || '').trim();
    if (!trimmed) return '';
    if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
    return trimmed.replace(/\/+$/, '');
}

/** Fetch remote counts from /api/community/info or /api/local/admin/diagnostics */
async function fetchRemoteCounts(node: FleetNodeConfig): Promise<{ members: number; posts: number } | null> {
    try {
        const baseUrl = normalizeUrl(node.url);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;
        if (node.replicationToken) headers['X-Replication-Token'] = node.replicationToken;

        const res = await fetch(`${baseUrl}/api/community/info`, { headers, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
            const data = await res.json() as any;
            return {
                members: Number(data.memberCount) || 0,
                posts: Number(data.postCount) || 0,
            };
        }
    } catch { /* ignore error and return null */ }
    return null;
}

// ── Sealed files (sealed-keys.md §6.3) ─────────────────────────────────────────────────────

const SEALED_EXT = '.bpsealed';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function nodeDirOf(target: string | FleetNodeConfig): string {
    return path.join(BACKUPS_DIR, nodeSlug(target));
}
function sealedDirOf(target: string | FleetNodeConfig): string {
    return path.join(nodeDirOf(target), 'sealed');
}

/** The legacy key files, locked by the seal-old pass: beanpool-identity-<date>-legacy.bpsealed. */
const IDENTITY_PREFIX = 'beanpool-identity-';

/**
 * The node's sealed files, newest first (by modification time, which the seal-old pass carries over). `identity`
 * marks the locked legacy key files; they are listed and downloadable like any other, but they are not backups.
 */
export function listSealedBackups(target: string | FleetNodeConfig): { file: string; path: string; mtimeMs: number; size: number; identity: boolean }[] {
    const dir = sealedDirOf(target);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.startsWith('beanpool-') && f.endsWith(SEALED_EXT))
        .map(f => {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            return { file: f, path: p, mtimeMs: st.mtimeMs, size: st.size, identity: f.startsWith(IDENTITY_PREFIX) };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

/**
 * The same 30-day rule as the old daily archives: the newest backup, plus the newest of each day for 30 days. Key
 * files are counted on their own: the newest is always kept (keys do not go stale), older ones go after 30 days.
 */
function pruneSealed(target: string | FleetNodeConfig): void {
    const all = listSealedBackups(target);
    const now = Date.now();
    const drop = (f: { file: string; path: string }) => {
        try {
            fs.unlinkSync(f.path);
            console.log(`[Harvester] Pruned sealed file for ${nodeSlug(target)}: ${f.file}`);
        } catch { /* ignore */ }
    };
    const keptDays = new Set<string>();
    all.filter(f => !f.identity).forEach((f, i) => {
        const day = new Date(f.mtimeMs).toISOString().slice(0, 10);
        const keep = i === 0 || (!keptDays.has(day) && now - f.mtimeMs <= MAX_AGE_MS);
        if (keep) keptDays.add(day);
        else drop(f);
    });
    all.filter(f => f.identity).forEach((f, i) => {
        if (i > 0 && now - f.mtimeMs > MAX_AGE_MS) drop(f);
    });
}

/** Check a sealed file's header holds up on its own terms: its signature is by the key its nodePeerId names. */
function selfSigned(header: SealedEnvelopeHeader): boolean {
    try {
        const raw = (peerIdFromString(header.nodePeerId) as any).publicKey?.raw as Uint8Array | undefined;
        return !!raw && verifySealedHeader(header, raw);
    } catch {
        return false;
    }
}

function readHeaderOf(file: string): SealedEnvelopeHeader {
    const fd = fs.openSync(file, 'r');
    try {
        const pre = Buffer.alloc(4);
        fs.readSync(fd, pre, 0, 4, 0);
        const len = Math.min(pre.readUInt32BE(0), 256 * 1024 + 1);
        const buf = Buffer.alloc(4 + len);
        const got = fs.readSync(fd, buf, 0, 4 + len, 0);
        return readSealedHeader(new Uint8Array(buf.subarray(0, got)));
    } finally {
        fs.closeSync(fd);
    }
}

export type PullResult =
    | { kind: 'sealed'; dbSize: number; file: string; header: SealedEnvelopeHeader }
    | { kind: 'plain'; dbSize: number; message: string };

/** The node's own words when it sends a readable backup, or ours for a node too old to say. */
function notLockedMessage(res: Response): string {
    const said = res.headers.get('x-backup-locked');
    if (said === 'no') return res.headers.get('x-backup-not-locked') || 'Backups are not locked yet: make a recovery code to lock them.';
    return 'This node runs a BeanPool older than locked backups, so its backups are readable. Update it, then make a recovery code to lock them.';
}

/** Keep a readable backup exactly as before locked backups: state.db, and one copy a day in history/. */
function keepPlainBackup(node: FleetNodeConfig, tarPath: string): number {
    const nodeDir = nodeDirOf(node);
    const extract = path.join(nodeDir, '.tmp-extract');
    fs.rmSync(extract, { recursive: true, force: true });
    fs.mkdirSync(extract, { recursive: true });
    try {
        checkBackupArchive(tarPath, { requireStateDb: true });
        execFileSync('tar', ['-xzf', tarPath, '-C', extract, '--no-same-owner', '--no-same-permissions']);
        const extractedDb = path.join(extract, 'state.db');
        if (!fs.existsSync(extractedDb) || !fs.lstatSync(extractedDb).isFile()) throw new Error('Downloaded backup did not contain state.db');
        const destDb = path.join(nodeDir, 'state.db');
        fs.copyFileSync(extractedDb, destDb);
        createDailyArchive(node);
        return fs.statSync(destDb).size;
    } finally {
        fs.rmSync(extract, { recursive: true, force: true });
    }
}

/** One copy a day of the readable state.db in history/, pruned after 30 days, as before locked backups. */
function createDailyArchive(node: FleetNodeConfig): void {
    const nodeDir = nodeDirOf(node);
    const dbPath = path.join(nodeDir, 'state.db');
    if (!fs.existsSync(dbPath)) return;
    const historyDir = path.join(nodeDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });
    const todayStr = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(historyDir, `beanpool-${todayStr}.db`);
    if (!fs.existsSync(archivePath)) {
        fs.copyFileSync(dbPath, archivePath);
        console.log(`[Harvester] Created daily archive for ${nodeSlug(node)}: beanpool-${todayStr}.db`);
    }
    const now = Date.now();
    for (const file of fs.readdirSync(historyDir).filter(f => f.startsWith('beanpool-') && f.endsWith('.db'))) {
        const filePath = path.join(historyDir, file);
        try {
            if (now - fs.statSync(filePath).mtimeMs > MAX_AGE_MS) {
                fs.unlinkSync(filePath);
                console.log(`[Harvester] Pruned old snapshot archive for ${nodeSlug(node)}: ${file}`);
            }
        } catch { /* ignore */ }
    }
}

/** The readable daily copies held for a node, newest first. */
export function listPlainHistory(target: string | FleetNodeConfig): { file: string; path: string; mtimeMs: number; size: number }[] {
    const dir = path.join(nodeDirOf(target), 'history');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.startsWith('beanpool-') && f.endsWith('.db'))
        .map(f => {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            return { file: f, path: p, mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.file.localeCompare(a.file));
}

/**
 * Pull the node's backup. A locked one is stored as it arrives (backups/<node>/sealed/beanpool-<ts>.bpsealed); the
 * harvester cannot open it and does not need to. A readable one — the node has no recovery code, or it is older
 * than locked backups — is kept as it always was (state.db + history/), with the node's reason.
 */
export async function pullBackupForNode(node: FleetNodeConfig): Promise<PullResult> {
    if (!node.adminPassword && !node.replicationToken) {
        throw new Error('No admin credentials (adminPassword / replicationToken) configured');
    }

    const baseUrl = normalizeUrl(node.url);
    const headers: Record<string, string> = {};
    if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;
    if (node.replicationToken) headers['X-Replication-Token'] = node.replicationToken;

    const res = await fetch(`${baseUrl}/api/local/admin/backup`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
        const detail = await res.json().then((j: any) => j?.error).catch(() => null);
        throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`);
    }

    const nodeDir = nodeDirOf(node);
    fs.mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    const incoming = path.join(nodeDir, `.incoming-${process.pid}-${Date.now()}`);
    try {
        if (!res.body) throw new Error('Response body is empty');
        await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(incoming, { mode: 0o600 }));
        const start = Buffer.alloc(2);
        const fd = fs.openSync(incoming, 'r');
        try { fs.readSync(fd, start, 0, 2, 0); } finally { fs.closeSync(fd); }
        if (start[0] === 0x1f && start[1] === 0x8b) {
            const message = notLockedMessage(res);
            const dbSize = keepPlainBackup(node, incoming);
            console.warn(`[Harvester] ${node.name}: kept a readable backup. ${message}`);
            return { kind: 'plain', dbSize, message };
        }
        let header: SealedEnvelopeHeader;
        try {
            header = readHeaderOf(incoming);
        } catch (e: any) {
            throw new Error(`The node's backup is neither a locked backup nor a readable one: ${e?.message || e}`);
        }
        if (header.kind !== 'backup') throw new Error(`The node sent a '${header.kind}' envelope, not a backup.`);
        if (!selfSigned(header)) throw new Error("The node's backup signature does not match the server it names; not kept.");
        const sealedDir = sealedDirOf(node);
        fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
        const stamp = (Date.parse(header.createdAt) ? new Date(header.createdAt) : new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(sealedDir, `beanpool-${stamp}${SEALED_EXT}`);
        fs.renameSync(incoming, dest);
        pruneSealed(node);
        return { kind: 'sealed', dbSize: fs.statSync(dest).size, file: path.basename(dest), header };
    } finally {
        try { fs.rmSync(incoming, { force: true }); } catch { /* ignore */ }
    }
}

// ── Back-off after a failed pull ────────────────────────────────────────────────────────────

const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** How long to wait after the n-th failure in a row: 5 min, 10, 20 … up to 6 hours. */
export function backoffDelayMs(failures: number): number {
    return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

// ── The node key the seal-old pass trusts ────────────────────────────────────────────────────

/**
 * The node's PeerId, from somewhere other than the node's own answer: the operator's `peerId` in
 * manager-nodes.json, or the libp2p_key file this harvester collected before locked backups (remembered in the
 * state, since the seal-old pass locks that file away). Never learned from a backup it is about to trust.
 */
function nodePin(node: FleetNodeConfig, prev: NodeHarvestState): { peerId: string; source: NonNullable<NodeHarvestState['pinSource']> } | null {
    if (typeof node.peerId === 'string' && node.peerId.trim()) return { peerId: node.peerId.trim(), source: 'manager-nodes.json' };
    if (prev.pinnedPeerId && prev.pinSource === 'collected key file') return { peerId: prev.pinnedPeerId, source: 'collected key file' };
    const keyFile = path.join(nodeDirOf(node), 'identity', 'libp2p_key');
    try {
        if (fs.existsSync(keyFile) && fs.lstatSync(keyFile).isFile()) {
            return { peerId: peerIdOfKeyFile(fs.readFileSync(keyFile)), source: 'collected key file' };
        }
    } catch { /* not a key: no pin from it */ }
    return null;
}

// ── The harvester's own signing key (seal-old pass) ─────────────────────────────────────────

/**
 * Old files are sealed by the harvester, not the node, so they are signed with a key of the harvester's own,
 * kept beside its data and named in each file's header. A restore onto the node itself then asks the operator
 * to confirm that signer by name (routes/backup.ts), instead of taking a file signed by an unknown key.
 */
async function harvesterSigner(): Promise<{ peerId: string; seed: Uint8Array }> {
    const keyPath = path.join(DATA_DIR, 'harvester-seal.key');
    let bytes: Uint8Array;
    if (fs.existsSync(keyPath)) {
        bytes = new Uint8Array(fs.readFileSync(keyPath));
    } else {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        bytes = privateKeyToProtobuf(await generateKeyPair('Ed25519'));
        fs.writeFileSync(keyPath, bytes, { mode: 0o600 });
    }
    const priv = privateKeyFromProtobuf(bytes);
    if (priv.type !== 'Ed25519') throw new Error('harvester-seal.key is not an Ed25519 key');
    return { peerId: peerIdFromPrivateKey(priv).toString(), seed: new Uint8Array(priv.raw.subarray(0, 32)) };
}

// ── Seal old backups (§6.4) ─────────────────────────────────────────────────────────────────

/** Plaintext the harvester itself wrote before sealed backups: the latest state.db, daily history, key files. */
function plaintextLeftovers(node: FleetNodeConfig): string[] {
    const dir = nodeDirOf(node);
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (p === sealedDirOf(node)) continue;
            const st = fs.lstatSync(p);
            if (st.isDirectory()) walk(p);
            else out.push(p);
        }
    };
    walk(dir);
    return out;
}

function tarInto(tarPath: string, stageDir: string): void {
    execFileSync('tar', ['-czf', tarPath, '-C', stageDir, '.']);
}

/**
 * Seal every plaintext file the harvester holds for this node, to the node's current recipients (the public header
 * of its newest locked backup, which the caller has checked against the pinned node key), read each back from
 * disk and open it (sealFileVerified), and only then delete the plaintext. Refuses without a recovery-code stanza. Each database becomes a restorable backup (a tar holding state.db); the old key files
 * become one sealed file. Deleting does not scrub an SSD, and copies elsewhere are the operator's to find.
 */
export async function sealOldBackups(node: FleetNodeConfig, header: SealedEnvelopeHeader): Promise<{ sealed: string[]; left: string[]; error: string | null }> {
    const leftovers = plaintextLeftovers(node);
    if (leftovers.length === 0) return { sealed: [], left: [], error: null };
    // Only the recovery code opens anything today. Locked to owners alone, these files would be unopenable, and the
    // readable originals are about to be deleted: refuse, touching nothing.
    if (!header.recipients.some(r => r.type === 'code')) {
        return {
            sealed: [], left: leftovers.map(p => path.relative(nodeDirOf(node), p)),
            error: 'Old readable backups are kept: the newest locked backup has no recovery code to lock them to. Nothing was deleted.',
        };
    }
    const signer = await harvesterSigner();
    const recipients = {
        owners: header.recipients.filter(r => r.type === 'owner').map(r => ({ pubkey: (r as any).pubkey, callsign: (r as any).callsign })),
        codes: header.recipients.filter((r): r is CodeStanza => r.type === 'code')
            .map(({ codeId, codePub, salt, N, r, p, createdAt }) => ({ codeId, codePub, salt, N, r, p, createdAt })),
    };
    const sealOpts = { communityId: header.communityId, nodePeerId: signer.peerId, signingKey: signer.seed, recipients };
    const dir = nodeDirOf(node);
    const sealedDir = sealedDirOf(node);
    fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
    const work = path.join(dir, `.seal-old-${process.pid}`);
    const sealed: string[] = [];

    const sealOne = async (sources: string[], asDb: boolean, outName: string, mtime: Date) => {
        fs.rmSync(work, { recursive: true, force: true });
        const stage = path.join(work, 'stage');
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        for (const src of sources) fs.copyFileSync(src, path.join(stage, asDb ? 'state.db' : path.basename(src)));
        const tarPath = path.join(work, 'plain.tar.gz');
        tarInto(tarPath, stage);
        const out = path.join(sealedDir, outName);
        // Resolves only once the file on disk has been read back, opened, and passed the restore's archive checks.
        await sealFileVerified(tarPath, out, { ...sealOpts, requireStateDb: asDb });
        fs.utimesSync(out, mtime, mtime);
        for (const src of sources) fs.rmSync(src, { force: true });
        fs.rmSync(work, { recursive: true, force: true });
        sealed.push(outName);
        console.log(`[Harvester] Sealed old plaintext backup for ${nodeSlug(node)}: ${sources.map(s => path.relative(dir, s)).join(', ')} → sealed/${outName}`);
    };

    try {
        // Databases: the latest copy and the daily history.
        for (const p of leftovers) {
            const rel = path.relative(dir, p);
            const isDb = rel === 'state.db' || (/^history\/beanpool-[\w-]+\.db$/.test(rel));
            if (!isDb || !fs.existsSync(p)) continue;
            const st = fs.statSync(p);
            const stamp = rel === 'state.db'
                ? `${new Date(st.mtimeMs).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-latest`
                : path.basename(rel, '.db').replace(/^beanpool-/, '');
            await sealOne([p], true, `beanpool-${stamp}-legacy${SEALED_EXT}`, st.mtime);
        }
        // The old identity folder, as one file.
        const idDir = path.join(dir, 'identity');
        const idFiles = fs.existsSync(idDir)
            ? fs.readdirSync(idDir).map(f => path.join(idDir, f)).filter(p => fs.lstatSync(p).isFile() && !path.basename(p).startsWith('.'))
            : [];
        if (idFiles.length) {
            const newest = new Date(Math.max(...idFiles.map(p => fs.statSync(p).mtimeMs)));
            await sealOne(idFiles, false, `${IDENTITY_PREFIX}${newest.toISOString().slice(0, 10)}-legacy${SEALED_EXT}`, newest);
        }
        // Temp leftovers of the old pull code, and folders now empty: nothing in them is worth keeping in plaintext.
        for (const p of plaintextLeftovers(node)) {
            const rel = path.relative(dir, p);
            if (rel.split(path.sep).some(seg => seg.startsWith('.tmp-') || seg.startsWith('.identity-export-'))) fs.rmSync(p, { force: true });
        }
        for (const sub of ['history', 'identity', '.tmp-extract', path.join('identity', '.tmp-extract')]) {
            const d = path.join(dir, sub);
            try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* ignore */ }
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    return { sealed, left: plaintextLeftovers(node).map(p => path.relative(dir, p)), error: null };
}

// ── Status ─────────────────────────────────────────────────────────────────────────────────

function describeHeader(header: SealedEnvelopeHeader): { owners: string[]; codeIds: number[]; words: string } {
    const owners = header.recipients.filter(r => r.type === 'owner').map(r => (r as any).callsign as string);
    const codeIds = header.recipients.filter((r): r is CodeStanza => r.type === 'code').map(r => r.codeId);
    const parts = [
        owners.length ? `${owners.length} owner${owners.length === 1 ? '' : 's'}` : null,
        codeIds.length ? `recovery code #${codeIds.join(', #')}` : null,
    ].filter(Boolean);
    return { owners, codeIds, words: parts.join(' + ') };
}

/** What the harvester holds for this node: the newest locked backup, else the readable one, and what the node said. */
function refreshSealedStatus(node: FleetNodeConfig, prev: NodeHarvestState, pullError: string | null): void {
    const files = listSealedBackups(node).filter(f => !f.identity);
    const plainHistory = listPlainHistory(node);
    const plainDb = path.join(nodeDirOf(node), 'state.db');
    const plain = fs.existsSync(plainDb) ? fs.statSync(plainDb) : null;
    const newest = files[0];
    let header: SealedEnvelopeHeader | null = null;
    if (newest) {
        try { header = readHeaderOf(newest.path); } catch { header = null; }
    }
    prev.historyCount = files.length + plainHistory.length;
    const failed = pullError ? ` The latest pull failed: ${pullError}` : '';
    const notLocked = prev.backupLock && !prev.backupLock.locked ? ` ${prev.backupLock.message}` : '';
    if (newest && header && (!plain || newest.mtimeMs >= plain.mtimeMs)) {
        const who = describeHeader(header);
        const sealedOn = header.createdAt.slice(0, 16).replace('T', ' ');
        prev.sealedBackup = {
            state: 'sealed',
            file: newest.file,
            sizeBytes: newest.size,
            envelopeId: header.envelopeId,
            sealedAt: header.createdAt,
            sealedBy: header.nodePeerId,
            owners: who.owners,
            codeIds: who.codeIds,
            message: `Sealed backup held: sealed ${sealedOn} UTC, locked to ${who.words}.` + notLocked + failed,
        };
        prev.identityStatus = 'secured';
        prev.identityFiles = [newest.file];
        prev.identityNote = null;
    } else if (plain) {
        const heldOn = new Date(plain.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
        const why = prev.backupLock && !prev.backupLock.locked ? prev.backupLock.message : 'Backups are not locked yet: make a recovery code to lock them.';
        prev.sealedBackup = {
            state: 'unlocked', file: 'state.db', sizeBytes: plain.size, envelopeId: null, sealedAt: null, sealedBy: null,
            owners: [], codeIds: [],
            message: `Readable backup held (not locked): copied ${heldOn} UTC. ${why}` + failed,
        };
        // A readable backup never carries the node keys: they travel only inside a locked one.
        prev.identityStatus = 'partial';
        prev.identityFiles = [];
        prev.identityNote = 'Database only: the node keys travel only inside a locked backup. Make a recovery code on the node to lock its backups.';
    } else {
        prev.sealedBackup = {
            state: 'none', file: null, sizeBytes: 0, envelopeId: null, sealedAt: null, sealedBy: null, owners: [], codeIds: [],
            message: pullError ? `No backup held: ${pullError}` : 'No backup held yet.',
        };
        prev.identityStatus = 'missing';
        prev.identityFiles = [];
        prev.identityNote = prev.sealedBackup.message;
    }
}

/**
 * The header the seal-old pass may lock old files to, or why there is none. All of: the node's latest backup was
 * locked (so its recipients are current), the newest file it sent is signed by the pinned node key, and that file
 * has a recovery-code stanza. A spoofed endpoint cannot choose the recipients, and nothing is locked to owners only.
 */
function sealOldHeader(node: FleetNodeConfig, prev: NodeHarvestState): { header: SealedEnvelopeHeader } | { reason: string } {
    const kept = 'Old readable backups are kept';
    if (!prev.backupLock?.locked) {
        return { reason: `${kept}: this node's backups are not locked yet (make a recovery code on the node). Nothing was deleted.` };
    }
    const pin = nodePin(node, prev);
    if (!pin) {
        return { reason: `${kept}: the fleet manager has no pinned key for this node, so it cannot check who a locked backup `
            + 'says to lock them to. Add the node\'s "peerId" to manager-nodes.json. Nothing was deleted.' };
    }
    prev.pinnedPeerId = pin.peerId;
    prev.pinSource = pin.source;
    const newest = listSealedBackups(node).filter(f => !f.identity)
        .map(f => { try { return readHeaderOf(f.path); } catch { return null; } })
        .find((h): h is SealedEnvelopeHeader => !!h && h.nodePeerId === pin.peerId);
    if (!newest || newest.kind !== 'backup' || !selfSigned(newest)) {
        return { reason: `${kept}: no locked backup held is signed by this node's pinned key (${pin.peerId}, from ${pin.source}). Nothing was deleted.` };
    }
    if (!newest.recipients.some(r => r.type === 'code')) {
        return { reason: `${kept}: the newest locked backup has no recovery code to lock them to. Nothing was deleted.` };
    }
    return { header: newest };
}

/** Harvest a single node: check drift, pull a backup if needed (backing off after a failure), seal old files, status */
export async function harvestNode(node: FleetNodeConfig, force = false): Promise<NodeHarvestState> {
    const slug = nodeSlug(node);
    const stateMap = loadHarvestState();
    const prev = stateMap[node.id] || stateMap[slug] || {
        nodeId: node.id,
        nodeName: node.name,
        nodeUrl: node.url,
        lastHarvestAt: null,
        lastSuccessAt: null,
        status: 'idle',
        error: null,
        dbSizeBytes: 0,
        memberCount: 0,
        postCount: 0,
        identityStatus: 'missing',
        identityFiles: [],
        historyCount: 0,
    };

    prev.nodeId = node.id;
    prev.nodeName = node.name;
    prev.nodeUrl = node.url;
    prev.status = 'harvesting';
    prev.lastHarvestAt = new Date().toISOString();
    stateMap[node.id] = prev;
    stateMap[slug] = prev;
    saveHarvestState(stateMap);

    let pullError: string | null = null;
    try {
        const counts = await fetchRemoteCounts(node);
        // Also pull once after this update (backupLock unset), to learn whether the node's backups are locked.
        const hasDrift = force || !counts || counts.members !== prev.memberCount || counts.posts !== prev.postCount
            || prev.dbSizeBytes === 0 || prev.backupLock === undefined;
        const waitUntil = prev.pullBackoff ? Date.parse(prev.pullBackoff.nextPullAt) : 0;

        if (hasDrift && !force && waitUntil > Date.now()) {
            // Backing off: the node failed recently. A forced harvest (the dashboard button) still pulls.
            pullError = `${prev.pullBackoff!.lastError} (next try after ${prev.pullBackoff!.nextPullAt.slice(0, 16).replace('T', ' ')} UTC)`;
        } else if (hasDrift) {
            console.log(`[Harvester] Pulling backup for ${node.name} (${slug}) [force: ${force}]`);
            try {
                const r = await pullBackupForNode(node);
                prev.dbSizeBytes = r.dbSize;
                prev.backupLock = r.kind === 'sealed'
                    ? { locked: true, message: 'Backups are locked.', at: new Date().toISOString() }
                    : { locked: false, message: r.message, at: new Date().toISOString() };
                delete prev.pullBackoff;
            } catch (e: any) {
                const msg = e?.message || String(e);
                const failures = (prev.pullBackoff?.failures || 0) + 1;
                prev.pullBackoff = { failures, nextPullAt: new Date(Date.now() + backoffDelayMs(failures)).toISOString(), lastError: msg };
                pullError = msg;
            }
        }

        refreshSealedStatus(node, prev, pullError);

        // Seal old backups: every run while any readable file is left, so it finishes even if one run is cut short.
        const leftovers = plaintextLeftovers(node);
        if (leftovers.length || prev.sealOld) {
            const gate = sealOldHeader(node, prev);
            if ('reason' in gate) {
                if (leftovers.length) {
                    prev.sealOld = {
                        lastRunAt: new Date().toISOString(), sealed: prev.sealOld?.sealed || [],
                        left: leftovers.map(p => path.relative(nodeDirOf(node), p)), error: gate.reason,
                    };
                }
            } else {
                try {
                    const r = await sealOldBackups(node, gate.header);
                    prev.sealOld = {
                        lastRunAt: new Date().toISOString(),
                        sealed: [...(prev.sealOld?.sealed || []), ...r.sealed],
                        left: r.left,
                        error: r.error,
                    };
                } catch (e: any) {
                    console.error(`[Harvester] Seal-old pass failed for ${node.name}:`, e?.message || e);
                    prev.sealOld = {
                        lastRunAt: new Date().toISOString(), sealed: prev.sealOld?.sealed || [],
                        left: plaintextLeftovers(node).map(p => path.relative(nodeDirOf(node), p)),
                        error: e?.message || String(e),
                    };
                }
                refreshSealedStatus(node, prev, pullError);
            }
        }

        if (counts) {
            prev.memberCount = counts.members;
            prev.postCount = counts.posts;
        }

        if (pullError) throw new Error(pullError);
        prev.status = 'ok';
        prev.lastSuccessAt = new Date().toISOString();
        prev.error = null;
    } catch (e: any) {
        console.error(`[Harvester] Failed to harvest node ${node.name}:`, e.message);
        prev.status = 'error';
        prev.error = e.message;
    }

    stateMap[node.id] = prev;
    saveHarvestState(stateMap);
    return prev;
}

/** Harvest all configured fleet nodes */
export async function harvestAllNodes(force = false): Promise<Record<string, NodeHarvestState>> {
    const nodes = getNodes();
    for (const node of nodes) {
        await harvestNode(node, force);
    }
    return loadHarvestState();
}

/** Initialize background harvester timer */
export function initHarvester(): void {
    if (harvesterTimer) clearInterval(harvesterTimer);

    if (process.env.ENABLE_HARVESTER !== 'true') {
        return;
    }

    console.log('[Harvester] Starting automated background harvester loop (60s interval)...');
    
    // Initial harvest cycle 5s after boot
    setTimeout(() => {
        harvestAllNodes().catch(err => console.error('[Harvester] Harvest loop error:', err));
    }, 5000);

    harvesterTimer = setInterval(() => {
        harvestAllNodes().catch(err => console.error('[Harvester] Harvest loop error:', err));
    }, DEFAULT_HARVEST_INTERVAL_MS);
}
