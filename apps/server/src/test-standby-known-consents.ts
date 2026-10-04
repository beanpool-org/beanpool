/**
 * Test Suite: a member's withdrawn consent reaches the standby (community modes slice 6; engine/community-health.ts;
 * review r4176631105 on #1599). known_consents is a plain table, and a delta carries a delete only as its tombstone
 * (db.ts deletePlainRows): a withdrawal that wrote none would leave the consent on the standby until its next whole copy,
 * and a take-over before then would put the member back among the exceptions (GDPR Art. 7(3)).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; the
 * member signs her own requests. The standby pulls through its real puller (services/backup-puller.ts) from the main
 * server's real backup routes. Nothing leaves this machine.
 *
 *  1. On the main server M (a known community), Kimberly and Ludo agree to the consent text through the real route.
 *  2. A standby S takes its first copy: it holds both consents.
 *  3. On M, Kimberly withdraws (DELETE /api/names/consent): her row is gone and one known_consents tombstone is written.
 *  4. S's next pull (a delta) drops her row and keeps Ludo's: on S she has no consent, so she is in no exception there
 *     (openExceptions lists only members with a known_consents row).
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-known-consents.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Consent-Main-Pw-5512!';
const PW_STANDBY = 'Consent-Standby-Pw-731!';

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
        'setup-primary': async (a: { replicationToken: string; owner: string; members: [string, string][] }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { CONFIRMATION_DIAL_KEY } = await import('@beanpool/engine');
            seedGenesisMember(a.owner, 'Owen');
            for (const [key, name] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'active')`).run(key, name, a.owner, `INV-${name}`);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            grantNodeRole(a.owner, 'owner', 'owner:password');
            db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIRMATION_DIAL_KEY, 'on');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { pullNow } = await import('./services/backup-puller.js');
            return pullNow();
        },
        /** This server's consents, its known_consents tombstones, and each member's own view of their consent here. */
        consents: async (a: { members: string[] }) => {
            const { db } = await import('./db/db.js');
            const { myConsent } = await import('./engine/community-health.js');
            return {
                rows: db.prepare('SELECT member_pubkey FROM known_consents ORDER BY member_pubkey').all().map((r: any) => r.member_pubkey),
                tombstones: db.prepare("SELECT row_key FROM tombstones WHERE table_name = 'known_consents' ORDER BY row_key").all().map((r: any) => r.row_key),
                consentedAt: Object.fromEntries(a.members.map((m) => [m, myConsent(m).consentedAt])),
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
async function signedCall(base: string, method: 'GET' | 'POST' | 'DELETE', route: string, id: Id | null, body?: unknown): Promise<{ status: number; body: any }> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
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
    const [owen, kim, ludo] = ['Owen', 'Kimberly', 'Ludo'].map(newId);
    const both = [kim.pk, ludo.pk];

    try {
        // ── 1. M ──
        console.log('\n— 1. on the main server, two members agree —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, owner: owen.pk, members: [[kim.pk, 'Kimberly'], [ludo.pk, 'Ludo']] });
        const mBase = `https://localhost:${await main.send('serve')}`;
        const terms = await signedCall(mBase, 'GET', '/api/community/consent-terms', null);
        require_(terms.status === 200 && terms.body?.known === true && typeof terms.body?.version === 'string', `M is a known community and shows the text (${j(terms)})`);
        for (const id of [kim, ludo]) {
            const agreed = await signedCall(mBase, 'POST', '/api/names/consent', id, { version: terms.body.version });
            require_(agreed.status === 200 && typeof agreed.body?.consentedAt === 'string', `M: ${id.name} agrees (${agreed.status} ${j(agreed.body)})`);
        }

        // ── 2. S's first copy ──
        console.log('\n— 2. a standby takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first = await standby.send('pull');
        require_(first.ok === true, `S: its first copy lands (${j(first)})`);
        const s1 = await standby.send('consents', { members: both });
        assert(j(s1.rows) === j([...both].sort()) && s1.consentedAt[kim.pk] && s1.consentedAt[ludo.pk],
            `S holds both consents (${j(s1)})`);

        // ── 3. Kimberly withdraws on M ──
        console.log('\n— 3. on M, Kimberly withdraws —');
        const gone = await signedCall(mBase, 'DELETE', '/api/names/consent', kim);
        require_(gone.status === 200 && gone.body?.consentedAt === null && typeof gone.body?.withdrawnAt === 'string', `M: Kimberly withdraws (${gone.status} ${j(gone.body)})`);
        const m3 = await main.send('consents', { members: both });
        assert(j(m3.rows) === j([ludo.pk]), `M: her row is gone, Ludo's stays (${j(m3.rows)})`);
        assert(j(m3.tombstones) === j([kim.pk]), `M: one known_consents tombstone, hers, for the delta to carry (${j(m3.tombstones)})`);

        // ── 4. S's delta ──
        console.log('\n— 4. the standby\'s next copy —');
        const delta = await standby.send('pull');
        require_(delta.ok === true, `S: the next copy lands (${j(delta)})`);
        const s4 = await standby.send('consents', { members: both });
        assert(j(s4.rows) === j([ludo.pk]), `S: Kimberly's consent is gone, Ludo's stays (${j(s4.rows)})`);
        assert(s4.consentedAt[kim.pk] === null && typeof s4.consentedAt[ludo.pk] === 'string',
            `S: Kimberly has no consent there, so a take-over puts her in no exception (${j(s4.consentedAt)})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A withdrawn consent reaches the standby.');
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
