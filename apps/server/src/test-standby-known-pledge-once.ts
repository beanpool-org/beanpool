/**
 * Test Suite: a standby counts a keeper's known pledge once in an enterprise's floor, as its main server does (#2309's
 * STOP-and-report; test-known-pledge-counted-once.ts has the main server's side). A standby copies both the keeper's
 * binding, with the figure they pledged as they joined (treasury_operators.backing), and their pledge rows
 * (engine/sync.ts mergeEnterprisePledges). The floor reads the pledge rows only, so the copy reads what its main server
 * does, before a take-over and after one, and after a release the copy follows.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; the
 * members sign their own requests. The standby pulls through its real puller (services/backup-puller.ts) from the main
 * server's real backup routes. Nothing leaves this machine.
 *
 *  1. On the main server M (the confirmation dial on by default: no row), a confirmed Kai asks to join Kai Co pledging
 *     500, all of it from his known grant, and the owner approves: Kai Co's floor is -500.
 *  2. A standby S, whose own owner switched its own dial off, takes its first copy: the binding (figure 500) and the known
 *     row of 500. S applies none of the community's settings while it is a standby (config/community-settings.ts), so its
 *     own dial stands and no known part counts there, for Kai's own line or Kai Co's: both 0, where the figure alone made
 *     Kai Co -500 on origin/main.
 *     Booting on the copy, S counts Kai Co among the enterprises whose floor reads its pledges alone (backingFigureDrift).
 *  3. S installs the settings it kept, as a take-over does: M's default (no row) takes the place of S's own 'off', so the
 *     dial is on and Kai Co is -500 there, as on M, never -1,000.
 *  4. On M, Kai releases 200: -300. S's next copy follows: -300, never -800, though the figure still says 500.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-known-pledge-once.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Pledge-Main-Pw-8841!';
const PW_STANDBY = 'Pledge-Standby-Pw-266!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine. */
function guardFetch(): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
}

async function child(): Promise<void> {
    guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; owner: string; kai: string; enterprise: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { createPost } = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { setMemberPhoto } = await import('@beanpool/engine');
            const avatar = 'data:image/png;base64,iVBORw0KGgo=';
            seedGenesisMember(a.owner, 'Owen');
            grantNodeRole(a.owner, 'owner', 'owner:password');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                        VALUES (?, 'Kai', strftime('%Y-%m-%dT%H:%M:%fZ','now', '-30 days'), ?, 'INV-Kai', 'active')`).run(a.kai, a.owner);
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                        VALUES (?, 'Kai Co', strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day'), ?, 'INV-KaiCo', 'active', 1)`).run(a.enterprise, a.owner);
            for (const pk of [a.kai, a.enterprise]) {
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
                setMemberPhoto(db, pk, avatar);
            }
            for (let i = 0; i < 5; i++) createPost('offer', 'produce', `Kai Co goods ${i}`, 'Goods', 10, 'fixed', a.enterprise);
            // The confirmation dial stays on its default, on, with no row (config/known-floor.ts).
            db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
                .run(crypto.randomBytes(16).toString('hex'), a.kai, crypto.randomBytes(16).toString('hex'), a.owner);
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            const { db } = await import('./db/db.js');
            const { CONFIRMATION_DIAL_KEY } = await import('@beanpool/engine');
            // S's own owner switched its own dial off: a standby keeps its own until it installs the community's.
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIRMATION_DIAL_KEY, 'off');
            pinMainServerForTests(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { pullNow } = await import('./services/backup-puller.js');
            return pullNow();
        },
        'install-settings': async () => {
            const { installCommunitySettings } = await import('./config/community-settings.js');
            return installCommunitySettings();
        },
        /** This server's figures for the enterprise: its floor where a spend is checked and in the engine, the rows behind it. */
        floors: async (a: { enterprise: string; kai: string }) => {
            const { db } = await import('./db/db.js');
            const { getEnterpriseUnderlyingFloor, getBalance } = await import('./state-engine.js');
            const { getEnterpriseFloor, clearEnterpriseFloorCache, confirmationDialOn, CONFIRMATION_DIAL_KEY } = await import('@beanpool/engine');
            clearEnterpriseFloorCache(db, a.enterprise);
            return {
                dial: confirmationDialOn(db),
                dialRow: (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string } | undefined)?.value ?? null,
                spend: getEnterpriseUnderlyingFloor(a.enterprise).floor,
                engine: getEnterpriseFloor(db, a.enterprise).floor,
                usable: getBalance(a.enterprise).usableFloor,
                kaiOwn: getBalance(a.kai).floor,
                figure: (db.prepare('SELECT backing FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').get(a.enterprise, a.kai) as { backing: number } | undefined)?.backing ?? null,
                pledges: (db.prepare('SELECT id, amount FROM enterprise_pledges WHERE enterprise = ? AND released_at IS NULL').all(a.enterprise) as { id: string; amount: number }[])
                    .map((r) => `${r.id.startsWith('known:') ? 'known' : 'earned'} ${r.amount}`).sort(),
            };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const j = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** A member's signed request to a node's real HTTPS server. */
async function signedCall(base: string, method: 'GET' | 'POST', route: string, id: Id, body?: unknown): Promise<{ status: number; body: any }> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (name: string) => path.join(root, name);
    const nodes: NodeProc[] = [];
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const [owen, kai] = ['Owen', 'Kai'].map(newId);
    const enterprise = newId('Kai Co').pk;
    const who = { enterprise, kai: kai.pk };

    try {
        // ── 1. M ──
        console.log('\n— 1. on the main server, Kai joins Kai Co with a known 500 —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, owner: owen.pk, kai: kai.pk, enterprise });
        const mBase = `https://localhost:${await main.send('serve')}`;
        const asked = await signedCall(mBase, 'POST', `/api/enterprise/${enterprise}/keepers/request`, kai, { pledgedBacking: 500 });
        require_(asked.status === 200 && typeof asked.body?.request?.id === 'string', `M: Kai asks to join, pledging 500 (${asked.status} ${j(asked.body)})`);
        const approved = await signedCall(mBase, 'POST', `/api/enterprise/${enterprise}/keepers/requests/${asked.body.request.id}/approve`, owen, {});
        require_(approved.status === 200 && approved.body?.applied === true, `M: the owner approves him at once (${approved.status} ${j(approved.body)})`);
        const m1 = await main.send('floors', who);
        assert(m1.dial === true && m1.dialRow === null && m1.spend === -500 && m1.engine === -500 && m1.usable === -500 && j(m1.pledges) === j(['known 500']) && m1.figure === 500,
            `M: on the default dial (no row), Kai Co's floor is -500, one known row of 500, the figure 500 (${j(m1)})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. a standby takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first = await standby.send('pull');
        require_(first.ok === true, `S: its first copy lands (${j(first)})`);
        const s2 = await standby.send('floors', who);
        assert(j(s2.pledges) === j(['known 500']) && s2.figure === 500, `S holds the binding, figure 500, and the known row of 500 (${j(s2)})`);
        assert(s2.dialRow === 'off', `S keeps its own dial through the copy: its own 'off' row (${j(s2.dialRow)})`);
        assert(s2.dial === false && s2.kaiOwn === 0 && s2.spend === 0 && s2.engine === 0,
            `S applies none of the community's settings yet: no known part counts there, Kai's own line 0 and Kai Co's 0 alike, never the figure's -500 (${j(s2)})`);
        // The copy swapped in at a restart, so S booted on it: its boot counts Kai Co (figure 500, no earned pledge), owing nothing.
        const bootLine = /spend floors read their keepers' pledges only: (\d+) enterprise\(s\) had a joining figure above what is pledged now, (\d+) of them/.exec(standby.output());
        assert(standby.swaps() >= 1 && bootLine?.[1] === '1' && bootLine?.[2] === '0',
            `S's boot on the copy counts one enterprise whose floor reads its pledges alone, none spend-frozen (${bootLine?.[0] ?? 'no line'}; ${standby.swaps()} swap(s))`);

        // ── 3. S installs the community's settings, as a take-over does ──
        console.log('\n— 3. the standby installs the settings it kept —');
        const installed = await standby.send('install-settings');
        require_(installed.installed === true, `S installs the community's settings it kept (${j(installed)})`);
        const s3 = await standby.send('floors', who);
        assert(s3.dial === true && s3.dialRow === null && s3.spend === -500 && s3.engine === -500 && s3.usable === -500 && s3.kaiOwn === -500,
            `S: M's default dial (no row) replaces S's own 'off'; Kai Co reads -500, as on M, never -1,000; Kai's own line 500 (${j(s3)})`);

        // ── 4. a release on M, and S's next copy ──
        console.log('\n— 4. Kai releases 200 on M; the standby\'s next copy —');
        const released = await signedCall(mBase, 'POST', `/api/enterprise/${enterprise}/release`, kai, { amount: 200 });
        require_(released.status === 200 && released.body?.remainingPledge === 300, `M: Kai releases 200 (${released.status} ${j(released.body)})`);
        const m4 = await main.send('floors', who);
        assert(m4.spend === -300 && m4.engine === -300 && j(m4.pledges) === j(['known 300']) && m4.figure === 500,
            `M: Kai Co reads -300, the figure still 500 (${j(m4)})`);
        const delta = await standby.send('pull');
        require_(delta.ok === true, `S: the next copy lands (${j(delta)})`);
        const s4 = await standby.send('floors', who);
        assert(s4.spend === -300 && s4.engine === -300 && s4.usable === -300 && j(s4.pledges) === j(['known 300']) && s4.figure === 500,
            `S: Kai Co reads -300, as on M, never -800 (${j(s4)})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby counts a known pledge once.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        process.exit(1);
    });
}
