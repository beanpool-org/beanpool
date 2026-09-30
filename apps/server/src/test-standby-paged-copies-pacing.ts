/**
 * Test Suite: a whole copy of more than 300 pages from the main server's real HTTPS server never trips its limiter on
 * administrative requests at the standby's own pace (P2 of scratch/global-node/DESIGN-paged-copies-fable.md; the P1 review's
 * note 2), proved on a scaled window.
 *
 * M's limiter allows ADMIN_RATE_LIMIT (300) administrative requests a window (a minute) from one address (https-server.ts),
 * and S asks a copy's pages DEFAULT_PAGE_GAP_MS (250 ms) apart at the least (services/backup-puller.ts): 240 a minute, with
 * room for its other requests. Both are scaled here by one factor, so the ratio is the real one: M's window to WINDOW_MS
 * (ADMIN_RATE_WINDOW_MS, which only a suite's NODE_ENV=test honours), and S's gap to DEFAULT_PAGE_GAP_MS × WINDOW_MS / a
 * minute (BACKUP_PAGE_GAP_MS). The limit is the real 300, and the copy is a real paged copy from M's real HTTPS server;
 * M's pages are scaled to PAGE_ROWS rows, so more than 300 of them take a few thousand rows.
 *
 *  1. S's first copy, M small, lands.
 *  2. M grows past 300 pages. Unpaced (BACKUP_PAGE_GAP_MS 0), in a fresh window of M's limiter, S's whole copy trips it: a
 *     429, the copy refused, S unchanged, no staging left.
 *  3. In a fresh window, at S's scaled default pace, the same copy lands, every listing of it, with no 429.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-paged-copies-pacing.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, type NodeProc } from './takeover-test-harness.js';
import { runPagedCopyChild } from './paged-copies-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
/** The limiter's real window, which WINDOW_MS scales. */
const MINUTE_MS = 60_000;
/**
 * M's limiter window here: a third of a minute. Wide enough that S, unpaced, makes 300 requests inside it on a slow runner
 * (a page every 66 ms would still do), narrow enough that S's paced copy spans more than one window.
 */
const WINDOW_MS = 20_000;
/** M's rows a page, scaled down from 25,000. */
const PAGE_ROWS = 10;
/** How long M keeps a copy no page was asked of (SYNC_COPY_IDLE_MS), scaled down from two minutes. */
const COPY_IDLE_MS = 3000;

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(50);
    }
    console.error(`  (waited ${ms} ms for ${what})`);
    return false;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const gwen = crypto.randomBytes(32).toString('hex');

    try {
        const main = await spawnNode(SCRIPT, dir('main'), {
            ADMIN_PASSWORD: 'Paced-Copies-Main-Pw-5521!', NODE_ROLE: 'primary', NODE_ENV: 'test',
            SYNC_PAGE_ROWS: String(PAGE_ROWS), SYNC_PAGE_BYTES: String(64 * 1024), SYNC_COPY_IDLE_MS: String(COPY_IDLE_MS),
            ADMIN_RATE_WINDOW_MS: String(WINDOW_MS),
        });
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen });
        const m = `https://localhost:${await main.send('serve')}`;
        await main.send('settle-pricing');
        // The real limit and pace, and M's window as it runs now: S's gap is the real one scaled as M's window is.
        const pace = await main.send('pace');
        const gapMs = Math.round(pace.gapMs * WINDOW_MS / MINUTE_MS);
        require_(pace.limit === 300 && pace.gapMs === 250 && pace.windowMs === WINDOW_MS,
            `M allows ${pace.limit} administrative requests in its window, scaled to ${pace.windowMs} ms; S's default gap is ${pace.gapMs} ms, scaled to ${gapMs} ms`);

        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), {
            ADMIN_PASSWORD: 'Paced-Copies-Standby-Pw-8830!', NODE_ROLE: 'backup', NODE_ENV: 'test',
            BACKUP_RECONCILE_EVERY_MS: '86400000', BACKUP_PAGE_GAP_MS: String(gapMs),
        });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: m, replicationToken, primaryPeerId: main.ready.peerId });
        const posts = async (node: NodeProc) => (await node.send('snapshot', { tables: ['posts'] })).tables.posts.count as number;

        console.log('\n— 1. S\'s first copy, from M\'s real HTTPS server —');
        const n0 = standby.swaps();
        const first = await standby.send('pull', {});
        await until('S to start again on its first copy', () => standby.swaps() > n0, 60_000);
        require_(first.ok === true && first.staged === true && (await standby.send('record')).lastOutcome === 'ok',
            `S's first copy lands (${JSON.stringify(first)})`);

        console.log('\n— 2. M past 300 pages: unpaced, S\'s whole copy trips M\'s limiter —');
        await main.send('flood', { kind: 'posts', n: (pace.limit + 40) * PAGE_ROWS, author: gwen });
        const before = await posts(standby);
        await main.send('reset-limiter'); // a fresh window
        await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: '0' } });
        const tFast = Date.now();
        const fast = await standby.send('pull', { whole: true });
        const fastSecs = (Date.now() - tFast) / 1000;
        const st2 = await standby.send('staging');
        assert(fast.ok === false && /HTTP 429/.test(fast.error ?? '') && !st2.staging && (await posts(standby)) === before,
            `unpaced, a copy this size trips M's limit of ${pace.limit} administrative requests a window, ${fastSecs.toFixed(1)} s in: refused, S unchanged, no staging (${JSON.stringify(fast)})`);

        console.log('\n— 3. at S\'s own pace, the same copy lands with no 429 —');
        await sleep(COPY_IDLE_MS + 500); // the copy S left open on M closes (its close was refused too)
        await main.send('reset-limiter'); // a fresh window
        await standby.send('set-env', { vars: { BACKUP_PAGE_GAP_MS: String(gapMs) } });
        const n1 = standby.swaps();
        const t0 = Date.now();
        const paced = await standby.send('pull', { whole: true });
        if (paced.staged) await until('S to start again on the new copy', () => standby.swaps() > n1, 60_000);
        const secs = (Date.now() - t0) / 1000;
        const pages = (await standby.send('record')).lastWholeCopy?.pages ?? 0;
        const [onS, onM] = [await posts(standby), await posts(main)];
        assert(paced.ok === true && paced.staged === true && pages > pace.limit && onS === onM && secs * 1000 > WINDOW_MS,
            `at S's pace the same copy, ${onM} listings in ${pages} pages (more than ${pace.limit}), lands in ${secs.toFixed(0)} s, `
            + `more than one window of ${WINDOW_MS / 1000} s, with no 429 (${JSON.stringify(paced)}; S ${onS}, M ${onM})`);

        const blocked = [...(await main.send('fetches')).blocked, ...(await standby.send('fetches')).blocked];
        assert(blocked.length === 0, `nothing tried to leave this machine (${JSON.stringify(blocked)})`);
    } catch (e: any) {
        assert(false, e?.message || String(e));
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
        nodes.forEach((n, i) => { try { fs.writeFileSync(path.join(root, `node-${i}.log`), n.output()); } catch { /* the dir is gone */ } });
        console.log(`\n${testsPassed}/${testsRun} passed (${((Date.now() - started) / 1000).toFixed(0)} s)`);
        if (testsPassed !== testsRun) process.exitCode = 1;
    }
}

if (process.argv.includes('--child')) {
    runPagedCopyChild({
        /** The limiter's real limit, its window as this process runs it, and a standby's default page gap. */
        pace: async () => {
            const { ADMIN_RATE_LIMIT, adminRateWindowMs } = await import('./https-server.js');
            const { DEFAULT_PAGE_GAP_MS } = await import('./services/backup-puller.js');
            return { limit: ADMIN_RATE_LIMIT, windowMs: adminRateWindowMs(), gapMs: DEFAULT_PAGE_GAP_MS };
        },
        'reset-limiter': async () => {
            const { resetAdminRateLimit } = await import('./https-server.js');
            resetAdminRateLimit();
            return true;
        },
    }).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
