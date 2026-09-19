/**
 * Harvester service unit/integration test.
 *
 * Tests node slug generation, fleet node config load/save persistence,
 * and harvest state load/save in isolated temporary data directory.
 * Then harvests a real (in-process, local HTTP) node (sealed keys slice 3, sealed-keys.md §6.3–6.4):
 * - with nobody to lock to, the node refuses and nothing is stored;
 * - with a recovery code, the node's backup is stored as a sealed file and the code opens it; the keys come with
 *   it even over the replication token, so identity is 'secured'; the new status names who can open it;
 * - the seal-old pass seals the plaintext the harvester wrote before (latest db, daily history, key files),
 *   re-opens each, and leaves no plaintext; a node too old to seal has its plain archive deleted, not kept.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-harvester.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import { openEnvelope, readSealedHeader, verifySealedHeader } from '@beanpool/core';
import { nodeSlug, getNodes, saveNodes, loadHarvestState, harvestNode, listSealedBackups, type FleetNodeConfig } from './services/harvester.js';
import { ensureGenesis } from './genesis.js';
import { makeRecoveryCode } from './services/takeover-envelope.js';
import { initStateEngine } from './state-engine.js';
import { createBackupRoutes } from './routes/backup.js';
import { hashPassword, updateLocalConfig, setReplicationToken } from './config/local-config.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import type { RouteDeps } from './routes/types.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

/** Harvest a node served in-process over local HTTP, the way the harvester reaches a real one. */
async function harvestLocalNode(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    initStateEngine();
    const PW = 'HarvesterAdmin123!';
    const TOKEN = 'harvester-test-token-0123456789abcdef';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    setReplicationToken(TOKEN);
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));

    const deps: RouteDeps = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    };
    const app = new Koa();
    // A node older than sealed backups, for the refusal below: it answers /backup with a plain archive.
    app.use(async (ctx, next) => {
        if (ctx.path === '/old-node/api/local/admin/backup') {
            ctx.set('Content-Type', 'application/gzip');
            ctx.body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
            return;
        }
        await next();
    });
    app.use(createBackupRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        const tokenOnly: FleetNodeConfig = { id: 'tok-node', name: 'Token Node', url, replicationToken: TOKEN };
        const slug = nodeSlug(tokenOnly);
        const nodeDir = path.join(dataDir, 'backups', slug);
        const sealedDir = path.join(nodeDir, 'sealed');

        // ── Nobody to lock to: nothing is kept, and the status says why ──
        resetAdminAuthTarpit();
        const none = await harvestNode(tokenOnly, true);
        assert(none.status === 'error' && /HTTP 409/.test(none.error || '') && /recovery code/.test(none.error || ''),
            `no owner and no code: the harvest fails with the node's reason (got ${none.status}: ${none.error})`);
        assert(listSealedBackups(tokenOnly).length === 0 && (!fs.existsSync(sealedDir) || fs.readdirSync(sealedDir).length === 0),
            'no owner and no code: nothing is stored');
        assert(none.identityStatus === 'missing' && none.sealedBackup?.state === 'none', 'no owner and no code: identity missing, no sealed backup');

        // ── Old plaintext the harvester wrote before sealed backups (§6.4) ──
        fs.mkdirSync(path.join(nodeDir, 'history'), { recursive: true });
        fs.mkdirSync(path.join(nodeDir, 'identity', '.tmp-extract'), { recursive: true });
        const oldLatest = crypto.randomBytes(5000);
        const oldDaily = crypto.randomBytes(3000);
        fs.writeFileSync(path.join(nodeDir, 'state.db'), oldLatest);
        fs.writeFileSync(path.join(nodeDir, 'history', 'beanpool-2026-09-10.db'), oldDaily);
        fs.writeFileSync(path.join(nodeDir, 'identity', 'libp2p_key'), 'old-node-key-bytes');
        fs.writeFileSync(path.join(nodeDir, 'identity', 'genesis.json'), '{"communityId":"old"}');
        fs.writeFileSync(path.join(nodeDir, 'identity', '.tmp-extract', 'libp2p_key'), 'leftover-temp-key');
        fs.writeFileSync(path.join(nodeDir, '.tmp-backup.tar.gz'), 'leftover-temp-archive');
        const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
        fs.utimesSync(path.join(nodeDir, 'history', 'beanpool-2026-09-10.db'), tenDaysAgo, tenDaysAgo);

        // ── A recovery code: now the node can lock its backups ──
        const made = await makeRecoveryCode();
        resetAdminAuthTarpit();
        const a = await harvestNode(tokenOnly, true);
        assert(a.status === 'ok' && a.error === null, `token-only harvest completes without error (${a.status}: ${a.error})`);
        const held = listSealedBackups(tokenOnly);
        const pulled = held.find(f => !f.file.includes('-legacy'));
        assert(!!pulled && pulled.file.endsWith('.bpsealed'), `the node's backup is stored as a sealed file (${pulled?.file})`);
        const pulledBytes = fs.readFileSync(pulled!.path);
        assert(!(pulledBytes[0] === 0x1f && pulledBytes[1] === 0x8b), 'the stored file is not a plain archive');
        assert(a.dbSizeBytes === pulled!.size, 'dbSizeBytes is the sealed file\'s size');
        // Token only: the keys now come too, locked (they are in the sealed backup's bundle).
        assert(a.identityStatus === 'secured' && a.identityNote === null, `token-only node: identity secured, inside the sealed backup (got ${a.identityStatus}: ${a.identityNote})`);
        assert(a.sealedBackup?.state === 'sealed' && a.sealedBackup.codeIds.includes(made.codeId), 'the new status names the recovery code the file opens with');
        assert(/^Sealed backup held: sealed .* locked to recovery code #\d+\.$/.test(a.sealedBackup?.message || ''), `…in words: "${a.sealedBackup?.message}"`);
        const opened = await openEnvelope(new Uint8Array(pulledBytes), { type: 'code', code: made.code }, { kind: 'backup' });
        const extract = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-open-'));
        fs.writeFileSync(path.join(extract, 'b.tar.gz'), opened.payload);
        execFileSync('tar', ['-xzf', path.join(extract, 'b.tar.gz'), '-C', extract]);
        assert(fs.existsSync(path.join(extract, 'state.db')) && fs.existsSync(path.join(extract, 'takeover-bundle.json')),
            'the code opens it: state.db and the take-over bundle are inside');
        fs.rmSync(extract, { recursive: true, force: true });

        // The seal-old pass ran on this first harvest: no plaintext left, every file re-opens to its bytes.
        const leftovers: string[] = [];
        const walk = (d: string) => {
            for (const f of fs.readdirSync(d)) {
                const p = path.join(d, f);
                if (p === sealedDir) continue;
                if (fs.lstatSync(p).isDirectory()) walk(p); else leftovers.push(path.relative(nodeDir, p));
            }
        };
        walk(nodeDir);
        assert(leftovers.length === 0, `seal-old: no plaintext left outside sealed/ (left: ${leftovers.join(', ') || 'none'})`);
        assert(a.sealOld?.left.length === 0 && a.sealOld?.error === null, 'seal-old: the status says nothing is left');
        const legacy = fs.readdirSync(sealedDir).filter(f => f.endsWith('-legacy.bpsealed')).sort();
        assert(legacy.length === 3, `seal-old: three sealed files made — latest db, one daily, the key files (${legacy.join(', ')})`);
        assert(fs.readdirSync(sealedDir).every(f => f.endsWith('.bpsealed')), 'seal-old: nothing but sealed files in sealed/ (no temp files)');
        const openTar = async (file: string): Promise<string> => {
            const bytes = new Uint8Array(fs.readFileSync(path.join(sealedDir, file)));
            const { header, payload } = await openEnvelope(bytes, { type: 'code', code: made.code }, { kind: 'backup' });
            assert(header.nodePeerId !== readSealedHeader(new Uint8Array(pulledBytes)).nodePeerId && verifySealedHeader(header,
                (peerIdFromString(header.nodePeerId) as any).publicKey.raw), `seal-old: ${file} is signed by the harvester's own key, named in its header`);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sealold-'));
            fs.writeFileSync(path.join(dir, 'x.tar.gz'), payload);
            execFileSync('tar', ['-xzf', path.join(dir, 'x.tar.gz'), '-C', dir]);
            fs.rmSync(path.join(dir, 'x.tar.gz'));
            return dir;
        };
        const latestFile = legacy.find(f => f.includes('-latest-'))!;
        const d1 = await openTar(latestFile);
        assert(fs.readFileSync(path.join(d1, 'state.db')).equals(oldLatest), 'seal-old: the old latest state.db re-opens byte for byte, as a restorable backup (state.db)');
        const dailyFile = legacy.find(f => f.startsWith('beanpool-2026-09-10'))!;
        const d2 = await openTar(dailyFile);
        assert(fs.readFileSync(path.join(d2, 'state.db')).equals(oldDaily), 'seal-old: the old daily archive re-opens byte for byte');
        assert(Math.abs(fs.statSync(path.join(sealedDir, dailyFile)).mtimeMs - tenDaysAgo.getTime()) < 2000, 'seal-old: the file keeps its date, so the 30-day rule still applies');
        const d3 = await openTar(legacy.find(f => f.startsWith('identity-'))!);
        assert(fs.readFileSync(path.join(d3, 'libp2p_key'), 'utf-8') === 'old-node-key-bytes'
            && fs.readFileSync(path.join(d3, 'genesis.json'), 'utf-8') === '{"communityId":"old"}', 'seal-old: the old key files re-open intact');
        for (const d of [d1, d2, d3]) fs.rmSync(d, { recursive: true, force: true });
        assert(a.historyCount === listSealedBackups(tokenOnly).length, 'historyCount counts the sealed backups held');

        // A second run has nothing to seal and keeps the files.
        resetAdminAuthTarpit();
        const b = await harvestNode(tokenOnly, false);
        assert(b.status === 'ok' && b.sealOld?.left.length === 0, 'a second run: nothing left to seal');
        // The 30-day rule: the newest file, plus the newest of each day. The sealed copy of the old latest db is
        // today's and older than today's new pull, so it goes; the 10-day-old daily and the key files stay.
        const afterSecond = fs.readdirSync(sealedDir);
        assert(afterSecond.includes(dailyFile) && afterSecond.some(f => f.startsWith('identity-') && f.endsWith('-legacy.bpsealed')),
            `a second run: the old daily and the old key files are kept (${afterSecond.join(', ')})`);
        const todays = listSealedBackups(tokenOnly).filter(f => new Date(f.mtimeMs).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10));
        assert(todays.length === 1, `a second run: one backup kept for today, the newest (${todays.map(f => f.file).join(', ')})`);

        // Admin password works the same way, and the token-only status no longer says 'partial'.
        const withPw: FleetNodeConfig = { ...tokenOnly, replicationToken: undefined, adminPassword: PW };
        resetAdminAuthTarpit();
        const c = await harvestNode(withPw, true);
        assert(c.status === 'ok' && c.identityStatus === 'secured', `with the admin password: a sealed backup, identity secured (got ${c.status}/${c.identityStatus})`);

        // A node too old to seal: its plain archive is deleted, not stored.
        // Both local nodes share the 'local-node' slug (a 127.0.0.1 url), so compare the folder before and after.
        const oldNode: FleetNodeConfig = { id: 'old-node', name: 'Old Node', url: url + '/old-node', replicationToken: TOKEN };
        const oldDir = path.join(dataDir, 'backups', nodeSlug(oldNode));
        const filesIn = () => (fs.existsSync(oldDir) ? execFileSync('find', [oldDir, '-type', 'f'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).sort() : []);
        const beforeOld = filesIn();
        resetAdminAuthTarpit();
        const d = await harvestNode(oldNode, true);
        assert(d.status === 'error' && /unlocked backup/.test(d.error || ''), `an old node's plain archive is refused (got ${d.status}: ${d.error})`);
        const added = filesIn().filter(f => !beforeOld.includes(f));
        assert(added.length === 0, `…and nothing of it is kept on disk (${added.join(', ') || 'none added'})`);

        // A wrong admin password: the harvest reports it; nothing crashes.
        const wrongPw: FleetNodeConfig = { ...tokenOnly, replicationToken: undefined, adminPassword: 'wrong-password-1!' };
        resetAdminAuthTarpit();
        const e = await harvestNode(wrongPw, true);
        assert(e.status === 'error' && /HTTP 401/.test(e.error || ''), `a refused admin password: error with the reason (got ${e.status}: ${e.error})`);
        assert(e.identityStatus === 'secured' && /latest pull failed/.test(e.sealedBackup?.message || ''),
            'a refused admin password: the sealed backups already held still count, and the status says the latest pull failed');
    } finally {
        await new Promise<void>(r => server.close(() => r()));
    }
}

async function main() {
    console.log('Running harvester service test...\n');

    // 1. Test nodeSlug
    assert(nodeSlug('') === 'unknown', 'nodeSlug handles empty target');
    assert(nodeSlug('mullum') === 'mullum', 'nodeSlug handles exact default node id');
    assert(nodeSlug({ id: 'custom-1', name: 'Mullumbimby Node', url: 'https://mullum.example.com' }) === 'mullum', 'nodeSlug detects mullum keyword in name/url');
    assert(nodeSlug({ id: 'custom-2', name: 'Local Dev Node', url: 'http://localhost:8450' }) === 'local-node', 'nodeSlug detects localhost url');
    assert(nodeSlug({ id: 'special@node/1', name: 'Special Node', url: 'https://special.org' }) === 'special_node_1', 'nodeSlug sanitizes special characters');

    // 2. Test getNodes default fallback
    const initialNodes = getNodes();
    assert(Array.isArray(initialNodes) && initialNodes.length > 0, 'getNodes returns default nodes when no config file exists');
    assert(initialNodes.some(n => n.id === 'mullum'), 'default nodes include mullum');

    // 3. Test saveNodes & getNodes persistence roundtrip
    const customNodes: FleetNodeConfig[] = [
        { id: 'custom-pool', name: 'Custom Pool Node', url: 'https://custom.beanpool.org', adminPassword: 'secret-pass' },
    ];
    saveNodes(customNodes);
    const reloadedNodes = getNodes();
    assert(reloadedNodes.length === 1 && reloadedNodes[0].id === 'custom-pool', 'saveNodes persists custom node configuration');
    assert(reloadedNodes[0].adminPassword === 'secret-pass', 'adminPassword field preserved');

    // 4. Test loadHarvestState default
    const initialState = loadHarvestState();
    assert(typeof initialState === 'object' && Object.keys(initialState).length === 0, 'loadHarvestState returns empty object when state file does not exist');

    // 5. A real harvest against a local node
    await harvestLocalNode();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
