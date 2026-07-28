/**
 * Automated Fleet Harvester Service
 * 
 * Periodically checks fleet nodes for metric drift (member, post, tx count changes),
 * streams database backups to ./backups/<nodeId>/state.db, archives daily snapshots to
 * ./backups/<nodeId>/history/beanpool-YYYY-MM-DD.db (auto-pruning >30 days), and collects
 * identity bundles into ./backups/<nodeId>/identity/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
    identityStatus: 'secured' | 'partial' | 'missing';
    identityFiles: string[];
    historyCount: number;
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
    const id = typeof target === 'string' ? target : target.id;
    const url = typeof target === 'object' ? target.url : '';
    const name = typeof target === 'object' ? target.name : '';

    if (['test', 'mullum', 'bris', 'bindarrabi', 'eastgippy', 'gippsland', 'castlemaine', 'melb', 'review', 'local-node'].includes(id)) {
        return id;
    }

    const str = `${id} ${url} ${name}`.toLowerCase();
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

    return id.replace(/[^a-zA-Z0-9_-]/g, '_');
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

/** Pull backup stream tar.gz from node and extract state.db */
export async function pullBackupForNode(node: FleetNodeConfig): Promise<{ dbSize: number }> {
    const baseUrl = normalizeUrl(node.url);
    const headers: Record<string, string> = {};
    if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;
    if (node.replicationToken) headers['X-Replication-Token'] = node.replicationToken;

    const res = await fetch(`${baseUrl}/api/local/admin/backup`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const slug = nodeSlug(node);
    const nodeDir = path.join(BACKUPS_DIR, slug);
    const tmpTar = path.join(nodeDir, '.tmp-backup.tar.gz');
    const tmpExtract = path.join(nodeDir, '.tmp-extract');

    fs.mkdirSync(nodeDir, { recursive: true });
    if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true });
    fs.mkdirSync(tmpExtract, { recursive: true });

    // Download stream to temp file
    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpTar, Buffer.from(arrayBuffer));

    // Extract tar.gz
    execFileSync('tar', ['-xzf', tmpTar, '-C', tmpExtract]);

    // Move extracted state.db to node backup directory
    const extractedDb = path.join(tmpExtract, 'state.db');
    const destDb = path.join(nodeDir, 'state.db');
    if (fs.existsSync(extractedDb)) {
        fs.copyFileSync(extractedDb, destDb);
    } else {
        throw new Error('Downloaded backup did not contain state.db');
    }

    // Cleanup temp files
    fs.rmSync(tmpExtract, { recursive: true });
    fs.unlinkSync(tmpTar);

    const stat = fs.statSync(destDb);
    return { dbSize: stat.size };
}

/** Pull identity bundle tar.gz from node */
export async function pullIdentityForNode(node: FleetNodeConfig): Promise<string[]> {
    const baseUrl = normalizeUrl(node.url);
    const headers: Record<string, string> = {};
    if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;
    if (node.replicationToken) headers['X-Replication-Token'] = node.replicationToken;

    const res = await fetch(`${baseUrl}/api/local/admin/identity-bundle`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const slug = nodeSlug(node);
    const identityDir = path.join(BACKUPS_DIR, slug, 'identity');
    const tmpTar = path.join(identityDir, '.tmp-identity.tar.gz');

    fs.mkdirSync(identityDir, { recursive: true });

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(tmpTar, Buffer.from(arrayBuffer));

    // Extract identity tar
    execFileSync('tar', ['-xzf', tmpTar, '-C', identityDir]);
    fs.unlinkSync(tmpTar);

    // List collected files
    const files = fs.readdirSync(identityDir).filter(f => !f.startsWith('.'));
    return files;
}

/** Create daily snapshot archive in history/ */
function createDailyArchive(target: string | FleetNodeConfig): void {
    const slug = nodeSlug(target);
    const nodeDir = path.join(BACKUPS_DIR, slug);
    const dbPath = path.join(nodeDir, 'state.db');
    if (!fs.existsSync(dbPath)) return;

    const historyDir = path.join(nodeDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    const todayStr = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(historyDir, `beanpool-${todayStr}.db`);

    // Copy if not already archived today
    if (!fs.existsSync(archivePath)) {
        fs.copyFileSync(dbPath, archivePath);
        console.log(`[Harvester] Created daily archive for ${slug}: beanpool-${todayStr}.db`);
    }

    // Prune historical archives older than 30 days
    const files = fs.readdirSync(historyDir).filter(f => f.startsWith('beanpool-') && f.endsWith('.db'));
    const nowMs = Date.now();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

    for (const file of files) {
        const filePath = path.join(historyDir, file);
        try {
            const stat = fs.statSync(filePath);
            if (nowMs - stat.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
                console.log(`[Harvester] Pruned old snapshot archive for ${slug}: ${file}`);
            }
        } catch {}
    }
}

/** Harvest a single node: check drift, pull backup if needed, pull identity, update history */
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

    try {
        const counts = await fetchRemoteCounts(node);
        const hasDrift = force || !counts || counts.members !== prev.memberCount || counts.posts !== prev.postCount || prev.dbSizeBytes === 0;

        if (hasDrift) {
            console.log(`[Harvester] Pulling backup for ${node.name} (${slug}) [drift: ${hasDrift}, force: ${force}]`);
            const { dbSize } = await pullBackupForNode(node);
            prev.dbSizeBytes = dbSize;

            // Also attempt identity bundle pull
            try {
                const idFiles = await pullIdentityForNode(node);
                prev.identityFiles = idFiles;
                if (idFiles.includes('genesis.json') && idFiles.includes('community.key')) {
                    prev.identityStatus = 'secured';
                } else {
                    prev.identityStatus = 'partial';
                }
            } catch (idErr: any) {
                console.warn(`[Harvester] Identity pull warn for ${node.name}:`, idErr.message);
            }

            // Create daily snapshot archive
            createDailyArchive(node);
        }

        if (counts) {
            prev.memberCount = counts.members;
            prev.postCount = counts.posts;
        }

        // Count history files
        const historyDir = path.join(BACKUPS_DIR, slug, 'history');
        if (fs.existsSync(historyDir)) {
            prev.historyCount = fs.readdirSync(historyDir).filter(f => f.startsWith('beanpool-') && f.endsWith('.db')).length;
        }

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

    console.log('[Harvester] Starting automated background harvester loop (60s interval)...');
    
    // Initial harvest cycle 5s after boot
    setTimeout(() => {
        harvestAllNodes().catch(err => console.error('[Harvester] Harvest loop error:', err));
    }, 5000);

    harvesterTimer = setInterval(() => {
        harvestAllNodes().catch(err => console.error('[Harvester] Harvest loop error:', err));
    }, DEFAULT_HARVEST_INTERVAL_MS);
}
