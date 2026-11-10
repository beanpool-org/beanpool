/**
 * Test Suite: a member's step-back and the rule's start reach a standby (scratch/fable-design/DESIGN-balance-rule-fable.md
 * §1, §3). A take-over must keep the community's rule as it stood: a member who stepped back owing stays on the admins'
 * list there, and the day the rule starts doesn't move.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; the
 * member signs her own requests. The standby pulls through its real puller (services/backup-puller.ts) from the main
 * server's real backup routes. Nothing leaves this machine.
 *
 *  1. On the main server M (a known community), Kimberly is confirmed, on the known floor, and owes 300.
 *  2. A standby S takes its first copy: it holds her live confirmation and M's start in the record it keeps, and has
 *     written no start of its own.
 *  3. On M, Kimberly steps back, owing past her ordinary line of 0.
 *  4. S's next pull (a delta) carries her step-back whole: the reason, and that she stepped back owing.
 *  5. S installs the settings it kept, as a take-over does: its start is M's, to the millisecond.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-step-back.ts
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
const PW_MAIN = 'Rule-Main-Pw-5512!';
const PW_STANDBY = 'Rule-Standby-Pw-731!';

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
        'setup-primary': async (a: { replicationToken: string; owner: string; member: string }) => {
            const { seedGenesisMember, createPost: raw } = await import('./state-engine.js');
            const { wrapCreatePost } = await import('./post-test-helper.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { setMemberPhoto } = await import('@beanpool/engine');
            const createPost = wrapCreatePost(raw);
            seedGenesisMember(a.owner, 'Owen');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                        VALUES (?, 'Kimberly', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'INV-K', 'active')`).run(a.member, a.owner);
            for (const key of [a.owner, a.member]) setMemberPhoto(db, key, 'data:image/png;base64,iVBORw0KGgo=');
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.member);
            db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
                .run(crypto.randomBytes(16).toString('hex'), a.member, crypto.randomBytes(16).toString('hex'), a.owner);
            createPost('offer', 'produce', 'Kimberly mends things', 'Repairs', 10, 'fixed', a.member);
            const basket = createPost('offer', 'produce', "Owen's basket", 'Veg', 300, 'fixed', a.owner)!;
            grantNodeRole(a.owner, 'owner', 'owner:password');
            setReplicationToken(a.replicationToken);
            return { postId: basket.id };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            pinMainServerForTests(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { pullNow } = await import('./services/backup-puller.js');
            return pullNow();
        },
        /** This server's confirmation of the member, its own start, and the start in the record it keeps of its main server's settings. */
        state: async (a: { member: string }) => {
            const { db } = await import('./db/db.js');
            const { keptCommunitySettings } = await import('./config/community-settings.js');
            const { isConfirmed } = await import('@beanpool/engine');
            return {
                row: db.prepare('SELECT revoked_at, revoked_by, revoke_reason, stepped_back_owing FROM confirmations WHERE member_pubkey = ?').get(a.member),
                confirmed: isConfirmed(db, a.member),
                stamp: (db.prepare("SELECT value FROM node_config WHERE key = 'balance_rule_from'").get() as { value: string } | undefined)?.value ?? null,
                kept: keptCommunitySettings()?.record?.nodeConfig?.balance_rule_from ?? null,
            };
        },
        install: async () => {
            const { installCommunitySettings } = await import('./config/community-settings.js');
            return installCommunitySettings();
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
async function signedPost(base: string, route: string, id: Id, body: unknown): Promise<{ status: number; body: any }> {
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json', 'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
    };
    const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: raw });
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
    const [owen, kim] = ['Owen', 'Kimberly'].map(newId);

    try {
        // ── 1. M ──
        console.log('\n— 1. on the main server, a confirmed member owes 300 —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const { postId } = await main.send('setup-primary', { replicationToken, owner: owen.pk, member: kim.pk });
        const mBase = `https://localhost:${await main.send('serve')}`;
        const buy = await signedPost(mBase, '/api/marketplace/posts/accept', kim, { postId, buyerPublicKey: kim.pk });
        require_(buy.status === 200, `M: Kimberly buys on her known floor (${buy.status} ${j(buy.body)})`);
        const m1 = await main.send('state', { member: kim.pk });
        require_(m1.confirmed === true && typeof m1.stamp === 'string', `M is on the rule, with its start (${j(m1)})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. a standby takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first = await standby.send('pull');
        require_(first.ok === true, `S: its first copy lands (${j(first)})`);
        const s1 = await standby.send('state', { member: kim.pk });
        assert(s1.confirmed === true, `S holds her live confirmation (${j(s1)})`);
        assert(s1.stamp === null, 'S wrote no start of its own');
        assert(s1.kept === m1.stamp, `and keeps M's, in the record of M's settings (${j(s1)})`);

        // ── 3. she steps back ──
        console.log('\n— 3. on M, Kimberly steps back —');
        const back = await signedPost(mBase, '/api/names/step-back', kim, {});
        require_(back.status === 200 && back.body?.owing === true, `M: Kimberly steps back, owing past her ordinary line (${back.status} ${j(back.body)})`);

        // ── 4. S's delta ──
        console.log('\n— 4. the standby\'s next copy —');
        const delta = await standby.send('pull');
        require_(delta.ok === true, `S: the next copy lands (${j(delta)})`);
        const s4 = await standby.send('state', { member: kim.pk });
        assert(s4.confirmed === false && s4.row?.revoke_reason === 'member' && s4.row?.revoked_by === kim.pk && !!s4.row?.revoked_at,
            `S: her confirmation is revoked, by her (${j(s4.row)})`);
        assert(s4.row?.stepped_back_owing === 1, `S: and it says she stepped back owing, so a take-over keeps her on the list (${j(s4.row)})`);

        // ── 5. the settings a take-over installs ──
        console.log('\n— 5. what a take-over installs —');
        const installed = await standby.send('install');
        require_(installed.installed === true, `S installs what it kept (${j(installed)})`);
        const s5 = await standby.send('state', { member: kim.pk });
        assert(s5.stamp === m1.stamp, `S's start is M's: a take-over doesn't move it (${j({ s: s5.stamp, m: m1.stamp })})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log("⭐️ A step-back and the rule's start reach the standby.");
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
