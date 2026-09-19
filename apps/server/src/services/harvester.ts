/**
 * Automated Fleet Harvester Service
 *
 * Periodically checks fleet nodes for metric drift (member, post, tx count changes) and, on drift, pulls the node's
 * SEALED backup (sealed-keys.md §6.3) into ./backups/<nodeId>/sealed/beanpool-<ts>.bpsealed, keeping the newest file
 * and one a day for 30 days. The harvester cannot open these files and does not need to: they are locked to the
 * node's owners and its printed recovery code, and they carry the node keys inside, so any credential that can
 * pull a backup — the replication token included — now collects the keys too, locked.
 *
 * On every run it also seals any plaintext the harvester wrote before this (state.db, history/*.db, identity/),
 * proves each sealed file re-opens, and deletes the plaintext (§6.4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { readSealedHeader, verifySealedHeader, type CodeStanza, type SealedEnvelopeHeader } from '@beanpool/core';
import { sealFileVerified } from './sealed-backup.js';

export interface FleetNodeConfig {
    id: string;
    name: string;
    url: string;
    adminPassword?: string;
    replicationToken?: string;
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
    /** 'secured' = a sealed backup is held, and it carries the node keys (locked). 'partial' is no longer produced. */
    identityStatus: 'secured' | 'partial' | 'missing';
    /** Why identity is not 'secured', in words for the dashboard; null when it is. */
    identityNote?: string | null;
    /** The sealed file that holds the keys (the newest sealed backup), when there is one. */
    identityFiles: string[];
    /** How many sealed backups are held. */
    historyCount: number;
    /** The newest sealed backup, read from its public header (§6.3). */
    sealedBackup?: {
        state: 'sealed' | 'none';
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
    /** The seal-old pass (§6.4): which old plaintext files were sealed, and anything still left in plaintext. */
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

/** The node's sealed backups, newest first (by modification time, which the seal-old pass carries over). */
export function listSealedBackups(target: string | FleetNodeConfig): { file: string; path: string; mtimeMs: number; size: number }[] {
    const dir = sealedDirOf(target);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.startsWith('beanpool-') && f.endsWith(SEALED_EXT))
        .map(f => {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            return { file: f, path: p, mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

/** The same 30-day rule as the old daily archives: the newest file, plus the newest of each day for 30 days. */
function pruneSealed(target: string | FleetNodeConfig): void {
    const files = listSealedBackups(target);
    const keptDays = new Set<string>();
    const now = Date.now();
    files.forEach((f, i) => {
        const day = new Date(f.mtimeMs).toISOString().slice(0, 10);
        const keep = i === 0 || (!keptDays.has(day) && now - f.mtimeMs <= MAX_AGE_MS);
        if (keep) {
            keptDays.add(day);
            return;
        }
        try {
            fs.unlinkSync(f.path);
            console.log(`[Harvester] Pruned sealed backup for ${nodeSlug(target)}: ${f.file}`);
        } catch { /* ignore */ }
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

/**
 * Pull the node's sealed backup and store it as it arrives: backups/<node>/sealed/beanpool-<ts>.bpsealed. The
 * harvester cannot open it and does not need to. It refuses to keep anything that is not a sealed backup — an
 * older node that still sends a plain archive has it deleted, not stored.
 */
export async function pullBackupForNode(node: FleetNodeConfig): Promise<{ dbSize: number; file: string; header: SealedEnvelopeHeader }> {
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

    const sealedDir = sealedDirOf(node);
    fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
    const incoming = path.join(sealedDir, `.incoming-${process.pid}-${Date.now()}`);
    try {
        if (!res.body) throw new Error('Response body is empty');
        await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(incoming, { mode: 0o600 }));
        const start = Buffer.alloc(2);
        const fd = fs.openSync(incoming, 'r');
        try { fs.readSync(fd, start, 0, 2, 0); } finally { fs.closeSync(fd); }
        if (start[0] === 0x1f && start[1] === 0x8b) {
            throw new Error('The node sent an unlocked backup (it runs a BeanPool older than sealed backups). It was not kept: update the node.');
        }
        let header: SealedEnvelopeHeader;
        try {
            header = readHeaderOf(incoming);
        } catch (e: any) {
            throw new Error(`The node's backup is not a sealed backup file: ${e?.message || e}`);
        }
        if (header.kind !== 'backup') throw new Error(`The node sent a '${header.kind}' envelope, not a backup.`);
        if (!selfSigned(header)) throw new Error("The node's backup signature does not match the server it names; not kept.");
        const stamp = (Date.parse(header.createdAt) ? new Date(header.createdAt) : new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(sealedDir, `beanpool-${stamp}${SEALED_EXT}`);
        fs.renameSync(incoming, dest);
        pruneSealed(node);
        return { dbSize: fs.statSync(dest).size, file: path.basename(dest), header };
    } finally {
        try { fs.rmSync(incoming, { force: true }); } catch { /* ignore */ }
    }
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
 * of its newest sealed backup), re-open each with the data key still in memory to prove the round trip, and only
 * then delete the plaintext. Each database becomes a restorable backup (a tar holding state.db); the old key files
 * become one sealed file. Deleting does not scrub an SSD, and copies elsewhere are the operator's to find.
 */
export async function sealOldBackups(node: FleetNodeConfig, header: SealedEnvelopeHeader): Promise<{ sealed: string[]; left: string[] }> {
    const leftovers = plaintextLeftovers(node);
    if (leftovers.length === 0) return { sealed: [], left: [] };
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
        await sealFileVerified(tarPath, out, sealOpts);
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
            await sealOne(idFiles, false, `identity-${newest.toISOString().slice(0, 10)}-legacy${SEALED_EXT}`, newest);
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
    return { sealed, left: plaintextLeftovers(node).map(p => path.relative(dir, p)) };
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

/** What the harvester holds for this node, from the newest sealed file's public header. */
function refreshSealedStatus(node: FleetNodeConfig, prev: NodeHarvestState, pullError: string | null): SealedEnvelopeHeader | null {
    const files = listSealedBackups(node);
    const newest = files[0];
    let header: SealedEnvelopeHeader | null = null;
    if (newest) {
        try { header = readHeaderOf(newest.path); } catch { header = null; }
    }
    prev.historyCount = files.length;
    if (newest && header) {
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
            message: `Sealed backup held: sealed ${sealedOn} UTC, locked to ${who.words}.`
                + (pullError ? ` The latest pull failed: ${pullError}` : ''),
        };
        prev.identityStatus = 'secured';
        prev.identityFiles = [newest.file];
        prev.identityNote = null;
    } else {
        prev.sealedBackup = {
            state: 'none', file: null, sizeBytes: 0, envelopeId: null, sealedAt: null, sealedBy: null, owners: [], codeIds: [],
            message: pullError ? `No sealed backup held: ${pullError}` : 'No sealed backup held yet.',
        };
        prev.identityStatus = 'missing';
        prev.identityFiles = [];
        prev.identityNote = prev.sealedBackup.message;
    }
    return header;
}

/** Harvest a single node: check drift, pull a sealed backup if needed, seal any old plaintext, update status */
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
        // Also pull when no sealed backup is held yet: the first harvest after the upgrade must get one, both to
        // hold one and to learn who to lock the old plaintext files to.
        const hasDrift = force || !counts || counts.members !== prev.memberCount || counts.posts !== prev.postCount
            || prev.dbSizeBytes === 0 || listSealedBackups(node).length === 0;

        if (hasDrift) {
            console.log(`[Harvester] Pulling sealed backup for ${node.name} (${slug}) [force: ${force}]`);
            try {
                const { dbSize } = await pullBackupForNode(node);
                prev.dbSizeBytes = dbSize;
            } catch (e: any) {
                pullError = e?.message || String(e);
            }
        }

        const header = refreshSealedStatus(node, prev, pullError);

        // Seal old backups: every run while any plaintext is left, so it finishes even if one run is cut short.
        if (header) {
            try {
                const r = await sealOldBackups(node, header);
                if (r.sealed.length || r.left.length || prev.sealOld) {
                    prev.sealOld = {
                        lastRunAt: new Date().toISOString(),
                        sealed: [...(prev.sealOld?.sealed || []), ...r.sealed],
                        left: r.left,
                        error: null,
                    };
                }
            } catch (e: any) {
                console.error(`[Harvester] Seal-old pass failed for ${node.name}:`, e?.message || e);
                prev.sealOld = {
                    lastRunAt: new Date().toISOString(), sealed: prev.sealOld?.sealed || [],
                    left: plaintextLeftovers(node).map(p => path.relative(nodeDirOf(node), p)),
                    error: e?.message || String(e),
                };
            }
            refreshSealedStatus(node, prev, pullError);
        } else if (plaintextLeftovers(node).length) {
            prev.sealOld = {
                lastRunAt: new Date().toISOString(), sealed: prev.sealOld?.sealed || [],
                left: plaintextLeftovers(node).map(p => path.relative(nodeDirOf(node), p)),
                error: 'Old unlocked backups are still here: they are locked once a sealed backup has been pulled from this node.',
            };
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
