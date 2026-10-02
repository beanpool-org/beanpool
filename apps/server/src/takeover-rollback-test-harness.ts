/**
 * Shared by test-takeover-failure-rolls-back.ts and the three suites of a take-over killed and then failing at the next
 * start, test-takeover-crash-next-start-fails.ts, test-takeover-crash-boot-role.ts and test-takeover-crash-promoted-in-place.ts
 * (not a suite itself): a take-over that stops part way (F2 of the 2026-10-01 standby review,
 * scratch/reviews/FABLE-standby-e2e.md "Area 2"). The three were one suite until it took 3m52s-4m17s on CI against the
 * runner's 300 s per suite (killed at 300 s on a slow runner, Test-All run 36986738475).
 *
 * Every node is its own process (takeover-test-harness.ts). The world every suite starts from, built once per suite:
 *   - a main server with an owner (Anna), an admin (Ben), a link with another community, a tunnel address and a recovery
 *     code. It stays up for the whole suite, so a standby can copy it after a take-over that stopped;
 *   - a standby that copied it and holds its locked keys, with things of its own a take-over writes over: Ben as the
 *     standby's own owner (a standby copies no roles) and a web address of its own. Its data dir is the starting point
 *     of every case, and `state` read on it is what a roll-back must put back.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnNode, post, copyDir, runNodeChild, inspectNode, type NodeProc } from './takeover-test-harness.js';

export const PW_MAIN = 'Main-Server-Pw-512!';
export const PW_STANDBY = 'Standby-Own-Pw-618!';
export const TUNNEL_TOKEN = 'tunnel-' + crypto.randomBytes(12).toString('hex');
export const STANDBY_OWN_ADDRESS = { name: 'standby-own', mode: 'direct', hostname: 'standby-own.example' };
/** A start of the standby: its own admin password, as a standby. */
export const STANDBY_ENV = { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' };

/**
 * node_config rows a main server's boot writes and a standby's does not (the 2026-10-02 review of #1433): the listing-photo
 * URLs' shape and when it changed (engine/photo-keys.ts), the members' schema-rules pass (db.ts), and the recovery seal's
 * clear and the epoch its main server sent (services/recovery-seal-key.ts).
 */
export const MAIN_BOOT_ROWS = [
    'photoKeysShape', 'photoKeysSince', 'migration_members_schema_rules_v1',
    'recovery_seal_cleared', 'recovery_seal_main_epoch', 'recovery_seal_reopened',
];

/** The files a take-over writes and a roll-back puts back, by hash (null: not there). */
const FILES = ['libp2p_key', 'community.key', 'genesis.json', 'connectors.json', 'recovery-seal.key', 'open-join.key'];

/** The node processes' commands. Run as the suite's child (`--child`). */
export async function rollbackChild(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string; tunnelToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { addConnector } = await import('./connector-manager.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            const ben = crypto.randomBytes(32).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
                .run(ben, 'Ben', new Date().toISOString(), anna, 'TEST');
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(ben);
            se.grantNodeRole(ben, 'admin', anna);
            se.payFromCommons(ben, 3, 'a commons grant', { allowDeficit: true });
            addConnector('/ip4/127.0.0.1/tcp/4999/p2p/12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA', 'peer', 'Neighbours', 'https://neighbours.example', true);
            se.updateNodeConfig({ publicAddress: { name: 'rollbacktown', mode: 'tunnel', hostname: 'rollbacktown.beanpool.org', status: 'live', tunnelToken: a.tunnelToken } } as any);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code, anna, ben };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        /** What the standby has of its own, which a take-over writes over: Ben its owner, and its own web address. */
        'standby-own': async (a: { ben: string }) => {
            const { db } = await import('./db/db.js');
            const { updateNodeConfig } = await import('./state-engine.js');
            db.prepare("INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch) VALUES (?, 'owner', ?, NULL, 0)")
                .run(a.ben, new Date().toISOString());
            updateNodeConfig({ publicAddress: STANDBY_OWN_ADDRESS } as any);
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /**
         * A role the database refuses (a constraint the keys' roles break, as F2 names): Ben made an admin, as the keys carry
         * him, never as the standby's own owner. The take-over's `roles` step fails on it, with no test hook, as it would on
         * any build; putting the standby's own roles back is not refused.
         */
        'refuse-admin-role': async (a: { ben: string }) => {
            const { db } = await import('./db/db.js');
            db.exec(`CREATE TRIGGER test_refuse_admin BEFORE INSERT ON node_roles WHEN NEW.member_pubkey = '${a.ben}' AND NEW.role = 'admin'
                     BEGIN SELECT RAISE(ABORT, 'the database refused this role'); END`);
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        'backup-status': async () => {
            const { getBackupStatus } = await import('./services/backup-puller.js');
            return getBackupStatus();
        },
        /** This process's role set while it runs (config/node-role.ts setNodeRole), as a role changed after the boot would be. */
        'set-role': async (a: { role: 'primary' | 'backup' }) => {
            const { setNodeRole } = await import('./state-engine.js');
            setNodeRole(a.role);
            return true;
        },
        /** Rows read, for a suite's own question. */
        query: async (a: { sql: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).all();
        },
        state: async () => standbyState(),
        inspect: (a) => inspectNode(a),
    });
}

/** What a roll-back must put back, and what says where the take-over stands. Runs inside the node's process. */
async function standbyState(): Promise<Record<string, any>> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const { db } = await import('./db/db.js');
    const { getLocalConfig } = await import('./config/local-config.js');
    const { getNodeRole, getNodeConfig } = await import('./state-engine.js');
    const { getConnectors } = await import('./connector-manager.js');
    const { getBackupStatus } = await import('./services/backup-puller.js');
    const { getTakeoverProgress } = await import('./services/takeover.js');
    const hash = (f: string) => {
        const p = path.join(dataDir, f);
        return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : null;
    };
    const c = getLocalConfig() as Record<string, any>;
    const journalFile = path.join(dataDir, 'takeover-journal.json');
    const progress = getTakeoverProgress() as any;
    const configRows = db.prepare('SELECT key, value FROM node_config ORDER BY key').all() as { key: string; value: string | null }[];
    const row = (key: string) => configRows.find((r) => r.key === key)?.value ?? null;
    return {
        role: getNodeRole(),
        files: Object.fromEntries(FILES.map((f) => [f, hash(f)])),
        config: {
            adminHash: c.adminHash ?? null, salt: c.salt ?? null, totpSecret: c.totpSecret ?? null, nodeRole: c.nodeRole ?? null,
            identityEpoch: c.identityEpoch ?? null, identityEpochSince: c.identityEpochSince ?? null, promotionAuditPending: c.promotionAuditPending ?? null,
            backupPrimaryUrl: c.backupPrimaryUrl ?? null, backupReplicationToken: c.backupReplicationToken ? 'set' : null,
            recoveryCode: c.recoveryCode ?? null, recoveryCodeUsed: c.recoveryCodeUsed ?? null,
        },
        roles: db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all(),
        publicAddress: (getNodeConfig() as any).publicAddress ?? null,
        cursor: (db.prepare("SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'backup:primary'").get() as { c: string } | undefined)?.c ?? null,
        ledger: {
            members: (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n,
            sum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
        },
        connectorsInMemory: getConnectors().map((x: any) => x.trustLevel).sort(),
        journal: fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf-8')) : null,
        bundleFile: fs.existsSync(path.join(dataDir, 'takeover-bundle.json')),
        preTakeoverDirs: fs.readdirSync(dataDir).filter((n) => n.startsWith('pre-takeover-')),
        pullerRunning: getBackupStatus().running,
        progress: { state: progress.state, rolledBack: progress.rolledBack ?? null, error: progress.error ?? null, rollBackStopped: progress.rollBackStopped ?? null },
        /** Every node_config row, by a hash of its value (null: no value): what a boot as the main server would write shows here. */
        configRows: Object.fromEntries(configRows.map((r) => [r.key, r.value === null ? null
            : crypto.createHash('sha256').update(String(r.value)).digest('hex').slice(0, 16)])),
        /** The rows a main server's boot writes and a standby's does not, as they are. */
        mainBootRows: Object.fromEntries(MAIN_BOOT_ROWS.map((k) => [k, row(k)])),
    };
}

/**
 * The parts of `state` a roll-back puts back, for comparing with the standby before its take-over: with the rows a main
 * server's boot writes, which no start that rolls back may leave behind.
 */
export function ownParts(s: Record<string, any>): string {
    return JSON.stringify({
        files: s.files, config: s.config, roles: s.roles, publicAddress: s.publicAddress, cursor: s.cursor, ledger: s.ledger, mainBootRows: s.mainBootRows,
    });
}

/** What differs between two `ownParts`, in a line, for a failing check. */
export function differences(before: Record<string, any>, after: Record<string, any>): string {
    const out: string[] = [];
    for (const k of ['files', 'config', 'roles', 'publicAddress', 'cursor', 'ledger', 'mainBootRows']) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
        if (before[k] && typeof before[k] === 'object' && !Array.isArray(before[k])) {
            for (const f of new Set([...Object.keys(before[k]), ...Object.keys(after[k] ?? {})])) {
                if (JSON.stringify(before[k][f]) !== JSON.stringify(after[k]?.[f])) out.push(`${k}.${f}: ${JSON.stringify(before[k][f])} → ${JSON.stringify(after[k]?.[f])}`);
            }
        } else {
            out.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
        }
    }
    return out.join('; ') || 'none';
}

export interface World {
    /** The suite's own file, which every node process runs with `--child`. */
    script: string;
    main: NodeProc;
    mainPeerId: string;
    standbyPeerId: string;
    baseDir: string;
    code: string;
    anna: string;
    ben: string;
    ownerSeedHex: string;
    /** `state` of the standby as the cases start from it. */
    before: Record<string, any>;
}

/** Build the world (above) under `root`. The main server stays up: the caller kills it. */
export async function buildWorld(script: string, root: string): Promise<World> {
    const mainDir = path.join(root, 'main');
    const baseDir = path.join(root, 'standby-base');
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const main = await spawnNode(script, mainDir, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
    try {
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken, tunnelToken: TUNNEL_TOKEN });
        fs.mkdirSync(baseDir, { recursive: true });
        fs.copyFileSync(path.join(mainDir, 'genesis.json'), path.join(baseDir, 'genesis.json'));
        const standby = await spawnNode(script, baseDir, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        let before: Record<string, any>;
        try {
            await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
            const pulled = await standby.send('pull');
            if (!pulled.resync.ok || pulled.envelope !== 'stored') throw new Error(`the standby did not copy the main server: ${JSON.stringify(pulled)}`);
            await standby.send('standby-own', { ben: setup.ben });
            before = await standby.send('state');
        } finally {
            await standby.kill('SIGTERM');
        }
        const standbyPeerId = standby.ready.peerId;
        return { script, main, mainPeerId: main.ready.peerId, standbyPeerId, baseDir, code: setup.code, anna: setup.anna, ben: setup.ben, ownerSeedHex, before };
    } catch (e) {
        await main.kill();
        throw e;
    }
}

/** Open the keys with the code and confirm, on the standby's own admin password. The confirm's answer (none if it died). */
export async function openAndConfirm(node: NodeProc, code: string): Promise<{ status: number; body: any }> {
    const opened = await post(node.base, '/api/local/admin/takeover/open', { code }, { 'X-Admin-Password': PW_STANDBY });
    if (opened.status !== 200) return opened;
    return post(node.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
}

/** Confirm with the process killed the moment `step` is recorded (BEANPOOL_TEST_TAKEOVER_CRASH_AFTER, as a power cut). */
export async function killedAfter(world: World, dir: string, step: string): Promise<void> {
    const node = await spawnNode(world.script, dir, { ...STANDBY_ENV, BEANPOOL_TEST_TAKEOVER_CRASH_AFTER: step });
    await openAndConfirm(node, world.code);
    await node.exited;
    const journal = JSON.parse(fs.readFileSync(path.join(dir, 'takeover-journal.json'), 'utf-8'));
    assert(!!journal.steps[step] && journal.state === 'running', `[killed after ${step}] the journal stops at "${step}"`);
}

/** A fresh copy of the standby the cases start from. */
export function standbyCopy(world: World, root: string, name: string): string {
    const dir = path.join(root, name);
    copyDir(world.baseDir, dir);
    return dir;
}

let testsRun = 0;
let testsPassed = 0;
export function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}
export function tally(): { run: number; passed: number } {
    return { run: testsRun, passed: testsPassed };
}

/**
 * A suite's entry: run as `--child`, a node process; otherwise build the world under BEANPOOL_DATA_DIR, run `cases` on it,
 * stop the main server, and print the count and `passedLine`. Exits 0 when every check passed, 1 otherwise.
 */
export function runRollbackSuite(script: string, passedLine: string, cases: (world: World, root: string) => Promise<void>): void {
    if (process.argv.includes('--child')) {
        rollbackChild().catch((e) => {
            console.error('child failed:', e);
            process.exit(1);
        });
        return;
    }
    const main = async (): Promise<void> => {
        const root = process.env.BEANPOOL_DATA_DIR;
        if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
        console.log('\n— setup: a main server (it stays up), and a standby that copies it and has an owner and an address of its own —');
        const world = await buildWorld(script, root);
        try {
            await cases(world, root);
        } finally {
            await world.main.kill();
        }
        const { run, passed } = tally();
        console.log(`\n${passed}/${run} checks passed.`);
        console.log(passedLine);
    };
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        process.exit(1);
    });
}
