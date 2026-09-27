/**
 * Test Suite: a standby holds every member's block list, and an unblock never comes back there (Marty's card
 * web-blocklist-where, 2026-09-27: "The community keeps it for the account"; engine/member-blocks.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), and the standby pulls through the real
 * puller (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes.
 *
 *  1. Ann blocks Bo and Cy on the main server; the standby's first copy has both.
 *  2. She unblocks Bo and blocks Dee: the next delta brings both.
 *  3. She blocks Bo again: it comes back.
 *  4. Between two pulls: Cy unblocked, blocked again and unblocked again (gone); Dee unblocked and blocked again (kept).
 *  5. In one millisecond: Bo unblocked and blocked again (kept); then unblocked (gone).
 *  6. A whole copy after all that brings back nothing she unblocked.
 *  7. Ann is re-keyed: the standby has her list under the new key only, and Eve's block of her names the new key.
 *  8. A standby that copied before it had block lists (it ignored the rows) takes one whole copy and has every list.
 *  9. Ann deletes her account on the main server: her list goes from the standby too; Eve's block of her stays.
 * 10. On the standby's own HTTPS server, Eve reads her list from its copy, and it refuses her a change; promoted, it takes one.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-member-blocks-standby.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the standby's own self-signed certificate

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Blocks-Main-Pw-731!';
const PW_STANDBY = 'Blocks-Standby-Pw-58!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    /** The engine module, or null on a tree without it: every command answers, and the checks fail. */
    const blocks = async (): Promise<any> => import('./engine/member-blocks.js').catch(() => null);
    const rowsOf = async (owner: string) => {
        const { db } = await import('./db/db.js');
        try {
            return (db.prepare('SELECT blocked_pubkey, created_at, updated_at FROM member_blocks WHERE owner_pubkey = ? ORDER BY created_at, blocked_pubkey')
                .all(owner) as { blocked_pubkey: string }[]).map(r => r.blocked_pubkey);
        } catch { return null; }
    };
    await runNodeChild({
        'setup-primary': async (a: { replicationToken: string; genesis: string; members: [string, string][] }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            se.seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            for (const [key, name] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`).run(key, name, a.genesis, `INV-${name}`);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        pull: async () => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
        },
        block: async (a: { owner: string; keys: string[] }) => (await blocks())?.addBlocks(a.owner, a.keys) ?? null,
        unblock: async (a: { owner: string; key: string }) => (await blocks())?.removeBlock(a.owner, a.key) ?? null,
        /** An unblock and a block again, or an unblock alone, in one and the same millisecond. */
        'same-ms': async (a: { owner: string; key: string; reblock: boolean }) => {
            const b = await blocks();
            if (!b) return null;
            const now = Date.now();
            b.removeBlock(a.owner, a.key, now);
            if (a.reblock) b.addBlocks(a.owner, [a.key], now);
            return now;
        },
        rekey: async (a: { old: string; next: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const code = issueRekeyCode(a.old, a.operator).code;
            return completeRekey(a.old, a.next, code, a.operator).success;
        },
        'delete-account': async (a: { key: string }) => {
            const se = await import('./state-engine.js');
            return se.purgeMemberSelf(a.key);
        },
        list: async (a: { owner: string }) => rowsOf(a.owner),
        wants: async () => (await blocks())?.memberBlocksWantWholeCopy() ?? null,
        /** As a standby on a version without block lists left it: the rows ignored, the tombstones recorded, no mark. */
        'forget-lists': async () => {
            const { db } = await import('./db/db.js');
            try { db.prepare('DELETE FROM member_blocks').run(); } catch { /* no table */ }
            db.prepare("DELETE FROM node_config WHERE key = 'replicated_member_blocks_v1'").run();
            return true;
        },
        serve: async () => {
            delete process.env.CF_RECORD_NAME;
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            const { initTls } = await import('./services/tls.js');
            const { startHttpsServer } = await import('./https-server.js');
            await initTls();
            return startHttpsServer(0);
        },
        promote: async () => {
            const se = await import('./state-engine.js');
            se.setNodeRole('primary');
            return se.getNodeRole();
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

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

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** A member's signed request to a node's real HTTPS server (the format before request binding, which every node still takes). */
async function signedCall(base: string, method: 'GET' | 'POST', route: string, id: Id, body?: unknown): Promise<{ status: number; body: any }> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
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
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, eve] = ['Ann', 'Bo', 'Cy', 'Dee', 'Eve'].map(newId);
    const name = new Map([ann, bo, cy, dee, eve].map(m => [m.pk, m.name]));
    const names = (keys: string[] | null) => keys === null ? 'no table' : `[${keys.map(k => name.get(k) ?? k.slice(0, 8)).join(', ')}]`;
    const sameSet = (keys: string[] | null, want: Id[]) => !!keys && keys.length === want.length && want.every(w => keys.includes(w.pk));

    try {
        console.log('\n— 1. Ann blocks Bo and Cy on the main server; the standby copies it —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk, members: [ann, bo, cy, dee, eve].map(m => [m.pk, m.name]) });
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        await main.send('block', { owner: ann.pk, keys: [bo.pk, cy.pk] });
        await main.send('block', { owner: eve.pk, keys: [ann.pk] });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies its main server (${JSON.stringify(seeded)})`);
        const s1 = await standby.send('list', { owner: ann.pk });
        assert(sameSet(s1, [bo, cy]), `the standby has Ann's list: ${names(s1)}`);
        assert(await standby.send('wants') === false, 'its first copy was a whole one, so it wants no other');

        console.log('\n— 2. she unblocks Bo and blocks Dee —');
        await main.send('unblock', { owner: ann.pk, key: bo.pk });
        await main.send('block', { owner: ann.pk, keys: [dee.pk] });
        const p2 = await standby.send('pull');
        const s2 = await standby.send('list', { owner: ann.pk });
        assert(p2.ok && !p2.whole, `a delta (${JSON.stringify(p2)})`);
        assert(sameSet(s2, [cy, dee]), `Bo is unblocked there too, and Dee blocked: ${names(s2)}`);

        console.log('\n— 3. she blocks Bo again —');
        await main.send('block', { owner: ann.pk, keys: [bo.pk] });
        await standby.send('pull');
        const s3 = await standby.send('list', { owner: ann.pk });
        assert(sameSet(s3, [bo, cy, dee]), `a block made again after an unblock comes back: ${names(s3)}`);

        console.log('\n— 4. between two pulls: Cy unblocked, blocked, unblocked; Dee unblocked and blocked again —');
        await main.send('unblock', { owner: ann.pk, key: cy.pk });
        await main.send('block', { owner: ann.pk, keys: [cy.pk] });
        await main.send('unblock', { owner: ann.pk, key: cy.pk });
        await main.send('unblock', { owner: ann.pk, key: dee.pk });
        await main.send('block', { owner: ann.pk, keys: [dee.pk] });
        await standby.send('pull');
        const s4 = await standby.send('list', { owner: ann.pk });
        const m4 = await main.send('list', { owner: ann.pk });
        assert(sameSet(s4, [bo, dee]) && sameSet(m4, [bo, dee]), `the standby ends where the main server did: ${names(s4)} (main ${names(m4)})`);

        console.log('\n— 5. in one millisecond —');
        await main.send('same-ms', { owner: ann.pk, key: bo.pk, reblock: true });
        await standby.send('pull');
        const s5a = await standby.send('list', { owner: ann.pk });
        assert(sameSet(s5a, [bo, dee]), `Bo unblocked and blocked again in one millisecond stays blocked: ${names(s5a)}`);
        await main.send('same-ms', { owner: ann.pk, key: bo.pk, reblock: false });
        await standby.send('pull');
        const s5b = await standby.send('list', { owner: ann.pk });
        assert(sameSet(s5b, [dee]), `and unblocked in the same millisecond as his last block, he is unblocked: ${names(s5b)}`);

        console.log('\n— 6. a whole copy —');
        const whole = await standby.send('resync');
        const s6 = await standby.send('list', { owner: ann.pk });
        assert(whole.ok && sameSet(s6, [dee]), `nothing she unblocked comes back with a whole copy: ${names(s6)}`);

        console.log('\n— 7. Ann is re-keyed —');
        const annNew = newId('AnnNew');
        name.set(annNew.pk, 'Ann (new key)');
        await main.send('block', { owner: ann.pk, keys: [cy.pk] });
        await standby.send('pull');
        require_(await main.send('rekey', { old: ann.pk, next: annNew.pk, operator: gwen.pk }) === true, 'the main server re-keys her');
        await standby.send('pull');
        const s7 = { old: await standby.send('list', { owner: ann.pk }), next: await standby.send('list', { owner: annNew.pk }), eve: await standby.send('list', { owner: eve.pk }) };
        assert(s7.old?.length === 0 && sameSet(s7.next, [dee, cy]), `the standby has her list under the new key only: old ${names(s7.old)}, new ${names(s7.next)}`);
        assert(sameSet(s7.eve, [annNew]), `and Eve's block of her names the new key: ${names(s7.eve)}`);

        console.log('\n— 8. a standby that copied before it had block lists —');
        await standby.send('forget-lists');
        const p8a = await standby.send('pull');
        const wants = await standby.send('wants');
        const p8b = await standby.send('pull');
        const s8 = await standby.send('list', { owner: annNew.pk });
        assert(p8a.ok && !p8a.whole && wants === true, `its next delta carries block lists, so it asks for one whole copy (${JSON.stringify(p8a)}, wants ${wants})`);
        assert(p8b.ok && p8b.whole && sameSet(s8, [dee, cy]) && await standby.send('wants') === false,
            `the next pull is that whole copy, and every list is there: ${names(s8)} (${JSON.stringify(p8b)})`);

        console.log('\n— 9. Ann deletes her account on the main server —');
        const deleted = await main.send('delete-account', { key: annNew.pk });
        await standby.send('pull');
        const s9 = await standby.send('list', { owner: annNew.pk });
        const m9 = await main.send('list', { owner: annNew.pk });
        const eveKeeps = await standby.send('list', { owner: eve.pk });
        assert(deleted?.ok === true && m9?.length === 0 && s9?.length === 0, `her list is gone on both (main ${names(m9)}, standby ${names(s9)})`);
        assert(sameSet(eveKeeps, [annNew]), `Eve's block of her is Eve's, and stays: ${names(eveKeeps)}`);

        console.log('\n— 10. on the standby\'s own server —');
        const port = await standby.send('serve');
        const sBase = `https://localhost:${port}`;
        const read = await signedCall(sBase, 'GET', '/api/blocks', eve);
        assert(read.status === 200 && sameSet((read.body?.blocked ?? []).map((b: any) => b.publicKey), [annNew]),
            `Eve reads her list from its copy (${read.status} ${JSON.stringify(read.body)?.slice(0, 100)})`);
        const refused = await signedCall(sBase, 'POST', '/api/blocks/remove', eve, { targetPubkey: annNew.pk });
        assert(refused.status === 503 && refused.body?.code === 'standby' && sameSet(await standby.send('list', { owner: eve.pk }), [annNew]),
            `and it refuses her a change while it is a standby (${refused.status})`);
        assert(await standby.send('promote') === 'primary', 'the standby is promoted');
        const taken = await signedCall(sBase, 'POST', '/api/blocks/remove', eve, { targetPubkey: annNew.pk });
        assert(taken.status === 200 && (await standby.send('list', { owner: eve.pk }))?.length === 0, `promoted, it takes her unblock (${taken.status})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby holds every member\'s block list, and an unblock never comes back there.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
