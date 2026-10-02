/**
 * Beans from someone you've blocked arrive without their note (Marty on the board, 2026-10-01: "Drop the note, keep the
 * Beans"; engine/withheld-notes.ts). #1403 stopped a blocked member's direct messages reaching the member who blocked
 * them; a send of Beans with a note was the one channel left.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts). The members' requests go over the main
 * server's REAL HTTPS server through the real signature middleware, with signed member sockets and Expo stubbed inside
 * the node; the standby pulls through the real puller from the main server's real backup routes, with
 * ENFORCE_LEDGER_AUTH=true, and serves its own HTTPS server.
 *
 *  1. before any block, Cy's Beans and note reach Ann: her history, her export, her socket (the shape to hold the rest to)
 *  2. Ann blocks Bo; Bo sends her 3 Beans with a note: answered exactly as Cy's send, his note in it; the Beans arrive in
 *     full (both balances, the ledger row), the ledger conserves and its audit holds
 *  3. Ann never sees the note: not in her history, her export, her activity feed, her socket, a push or a kept push
 *     notice, nor stored in the ledger row; she reads the neutral line in its place
 *  4. Bo's own reads show his note as he wrote it, in the shape Cy's have: his history, his export, his socket
 *  5. a standby's copy: the row comes over (its signed request re-checked) with no note, and on the standby's own server
 *     Ann's reads have no note; the copy carries no withheld note
 *  6. after the unblock nothing old arrives: the old send still shows the neutral line; a note sent after it arrives
 *  7. a note sent as a JSON number (412345678) is withheld as a string note is: it never reaches Ann (history, export,
 *     socket, the ledger row, a standby's copy), and Bo reads it as an unblocked send's number note reads
 *  8. a prune takes Bo's words, and a self-deletion Eve's; Ann still never sees one and still reads the neutral line
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-blocks-on-beans.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Beans-Note-Main-Pw-417!';
const PW_STANDBY = 'Beans-Note-Standby-Pw-93!';
/** What the member who blocked the sender reads in place of the note (@beanpool/core BLOCKED_BEANS_NOTE). */
const NEUTRAL = 'Beans from a member you blocked';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    // Expo, stubbed inside the node: every push it hands Expo, by token.
    const pushes: { to: string; title: string; body: string; data: any }[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
        if (String(url).includes('exp.host')) {
            pushes.push(...JSON.parse(init.body));
            return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
        }
        return realFetch(url, init);
    };
    /** The rows of a table this tree may not have: null when it hasn't. */
    const maybe = async <T>(fn: () => T): Promise<T | null> => { try { return fn(); } catch { return null; } };
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string; members: [string, string][]; senders: string[]; seller: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { putPushTokenRow } = await import('./services/push-token-seal.js');
            se.seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            for (const [key, name] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, avatar_ref, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'active', 'data:image/png;base64,iVBORw0KGgo=',
                                    strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(key, name, a.genesis, `INV-${name}`);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
                putPushTokenRow(key, `ExponentPushToken[${name}]`, 'android');
            }
            // Each sender holds Beans and has a completed trade behind them: a direct send needs both (state-engine transfer).
            const offer = (pk: string, title: string) => se.createPost('offer', 'produce', title, `${title}, fresh`, 10, 'fixed', pk)!;
            offer(a.seller, 'Dee eggs');
            for (const pk of a.senders) {
                se.transfer('genesis', pk, 100, 'seed', 'direct', true);
                offer(pk, `Seedlings ${pk.slice(0, 6)}`);
                se.completePostTransaction(se.acceptPost(offer(a.seller, `Bread ${pk.slice(0, 6)}`).id, pk).id, pk);
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
        /** The ledger as this node holds it: a row, the balances named, the totals and the audit. */
        ledger: async (a: { txId?: string; keys: string[] }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const row = a.txId ? db.prepare('SELECT * FROM transactions WHERE id = ?').get(a.txId) as any : null;
            const balances = Object.fromEntries(a.keys.map(k => [k, (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(k) as any)?.balance ?? null]));
            const memory = Object.fromEntries(a.keys.map(k => [k, se.getBalance(k)?.balance ?? null]));
            const sum = (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
            let audit: unknown;
            try { audit = se.runLedgerAudit(); } catch (e: any) { audit = { error: e?.message }; }
            return { row, balances, memory, sum, audit };
        },
        /** Every stored row and kept notice that holds `text`, outside a send's signed request (auth_payload). */
        holding: async (a: { text: string; recipient: string }) => {
            const { db } = await import('./db/db.js');
            const like = `%${a.text}%`;
            return {
                memos: (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE ?').get(like) as { n: number }).n,
                activity: (db.prepare('SELECT COUNT(*) AS n FROM activity_feed WHERE metadata LIKE ?').get(like) as { n: number }).n,
                pushNotices: await maybe(() => (db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE recipient = ? AND (body LIKE ? OR title LIKE ? OR data LIKE ?)')
                    .get(a.recipient, like, like, like) as { n: number }).n),
                pushNoticesToRecipient: await maybe(() => (db.prepare('SELECT COUNT(*) AS n FROM push_notices WHERE recipient = ?').get(a.recipient) as { n: number }).n),
                withheld: await maybe(() => (db.prepare('SELECT COUNT(*) AS n FROM withheld_notes WHERE memo LIKE ?').get(like) as { n: number }).n),
                /** The withheld_notes rows kept for sends to this recipient, blank or not. */
                withheldRows: await maybe(() => (db.prepare('SELECT COUNT(*) AS n FROM withheld_notes WHERE transaction_id IN (SELECT id FROM transactions WHERE to_pubkey = ?)')
                    .get(a.recipient) as { n: number }).n),
                /** Every withheld_notes row's words, to see that none of a deleted member's remain. */
                withheldWords: await maybe(() => (db.prepare('SELECT memo FROM withheld_notes').all() as { memo: string }[]).map(r => r.memo)),
            };
        },
        pushes: async () => pushes,
        /** The copy a standby's whole pull takes (exportSyncState), as JSON. */
        copy: async (a: { nodeId: string }) => {
            const se = await import('./state-engine.js');
            return JSON.stringify(await se.exportSyncState(a.nodeId));
        },
        prune: async (a: { key: string; actor: string }) => {
            const se = await import('./state-engine.js');
            se.adminPruneUser(a.key, a.actor);
            return true;
        },
        'delete-account': async (a: { key: string }) => {
            const se = await import('./state-engine.js');
            return se.purgeMemberSelf(a.key);
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
/** A member's signed request to a node's real HTTPS server (the format before request binding, which every node still takes). */
async function signedCall(base: string, method: 'GET' | 'POST', route: string, id: Id, body?: unknown): Promise<Res> {
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
    return { status: res.status, body: json, text };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 160)}`;
const keysOf = (o: any) => Object.keys(o ?? {}).sort().join(',');

type Sock = { ws: WebSocket; events: any[] };
function socket(base: string, id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${base.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
/** The `transaction` events this socket heard for one send. */
const txnEvents = (s: Sock, txId: string) => s.events.filter(e => e?.type === 'transaction' && e.txn?.id === txId);

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const socks: Sock[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, eve] = ['Ann', 'Bo', 'Cy', 'Dee', 'Eve'].map(newId);
    const NOTE = `meet me behind the shed ${crypto.randomBytes(4).toString('hex')}`;
    const CY_NOTE = `thanks for the eggs ${crypto.randomBytes(4).toString('hex')}`;
    const LATER = `after the unblock ${crypto.randomBytes(4).toString('hex')}`;

    try {
        console.log('\n=== Beans from someone you have blocked arrive without their note ===\n');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        await main.send('setup-primary', {
            replicationToken, genesis: gwen.pk, members: [ann, bo, cy, dee, eve].map(m => [m.pk, m.name]), senders: [bo.pk, cy.pk, eve.pk], seller: dee.pk,
        });
        const base = `https://localhost:${await main.send('serve')}`;
        const annSock = await socket(base, ann);
        const boSock = await socket(base, bo);
        const cySock = await socket(base, cy);
        socks.push(annSock, boSock, cySock);
        await sleep(100);
        const historyOf = async (id: Id, b = base) => signedCall(b, 'GET', `/api/ledger/transactions?publicKey=${id.pk}&limit=50`, id);
        const exportOf = async (id: Id, b = base) => signedCall(b, 'GET', '/api/ledger/export', id);
        const rowIn = (r: Res, txId: string) => Array.isArray(r.body) ? r.body.find((t: any) => t.id === txId) : undefined;

        // ── 1. before any block ─────────────────────────────────────────────────────────────────
        console.log('── 1. before any block ──');
        const cySend = await signedCall(base, 'POST', '/api/ledger/transfer', cy, { to: ann.pk, amount: 2, memo: CY_NOTE });
        const cyTx: string = cySend.body?.transaction?.id;
        require_(cySend.status === 200 && cySend.body?.success === true && !!cyTx, `Cy sends Ann 2 Beans with a note (${show(cySend)})`);
        await sleep(150);
        const annSeesCy = rowIn(await historyOf(ann), cyTx);
        assert(annSeesCy?.memo === CY_NOTE, `Ann reads Cy's note in her history (${JSON.stringify(annSeesCy)?.slice(0, 120)})`);
        const cyLive = txnEvents(cySock, cyTx)[0];
        const annLiveCy = txnEvents(annSock, cyTx)[0];
        assert(cyLive?.txn?.memo === CY_NOTE && annLiveCy?.txn?.memo === CY_NOTE, 'and on her socket, as Cy does on his');

        // ── 2. Ann blocks Bo; Bo sends her Beans with a note ────────────────────────────────────
        console.log('── 2. a blocked member sends Beans with a note ──');
        const blk = await signedCall(base, 'POST', '/api/blocks', ann, { targetPubkey: bo.pk });
        require_(blk.status === 200, `Ann blocks Bo (${show(blk)})`);
        annSock.events.length = 0;
        const pushesBefore = (await main.send('pushes') as any[]).filter(p => p.to === 'ExponentPushToken[Ann]').length;
        const before = await main.send('ledger', { keys: [ann.pk, bo.pk] });
        const boSend = await signedCall(base, 'POST', '/api/ledger/transfer', bo, { to: ann.pk, amount: 3, memo: NOTE });
        const boTx: string = boSend.body?.transaction?.id;
        require_(boSend.status === 200 && boSend.body?.success === true && !!boTx, `the send is accepted (${show(boSend)})`);
        await sleep(200);
        assert(keysOf(boSend.body) === keysOf(cySend.body) && keysOf(boSend.body.transaction) === keysOf(cySend.body.transaction),
            `answered in the shape Cy's send was (${keysOf(boSend.body.transaction)} vs ${keysOf(cySend.body.transaction)})`);
        assert(boSend.body.transaction.memo === NOTE && boSend.body.transaction.amount === 3 && boSend.body.transaction.to === ann.pk
            && boSend.body.transaction.from === bo.pk, `with his note in it, as he wrote it (${JSON.stringify(boSend.body.transaction.memo)})`);
        const after = await main.send('ledger', { txId: boTx, keys: [ann.pk, bo.pk] });
        assert(Math.abs(after.balances[ann.pk] - before.balances[ann.pk] - 3) < 1e-9 && Math.abs(before.balances[bo.pk] - after.balances[bo.pk] - 3) < 1e-9,
            `the Beans arrive in full: Ann ${before.balances[ann.pk]} -> ${after.balances[ann.pk]}, Bo ${before.balances[bo.pk]} -> ${after.balances[bo.pk]}`);
        assert(after.memory[ann.pk] === after.balances[ann.pk] && after.memory[bo.pk] === after.balances[bo.pk], 'the in-memory ledger agrees with the rows');
        assert(after.row?.amount === 3 && after.row?.from_pubkey === bo.pk && after.row?.to_pubkey === ann.pk && after.row?.tax_fee === 0,
            `one ledger row, the amount sent, fee-free as any direct send (${JSON.stringify({ amount: after.row?.amount, fee: after.row?.tax_fee })})`);
        assert(after.row?.auth_signer === bo.pk && typeof after.row?.auth_signature === 'string' && String(after.row?.auth_payload).includes('/api/ledger/transfer'),
            'its signed request is kept, as any send\'s is (SRV-20)');
        assert(Math.abs(after.sum - before.sum) < 1e-9, `the ledger conserves: the accounts sum ${before.sum} -> ${after.sum}`);
        assert(after.audit?.ok === true && Math.abs(after.audit?.drift ?? 1) < 1e-6, `the ledger audit holds (${JSON.stringify(after.audit)})`);

        // ── 3. Ann never sees the note ──────────────────────────────────────────────────────────
        console.log('── 3. the member who blocked him never sees the note ──');
        const annHistory = await historyOf(ann);
        const annRow = rowIn(annHistory, boTx);
        assert(annHistory.status === 200 && !!annRow && annRow.amount === 3 && annRow.from === bo.pk,
            `the send is in Ann's history, 3 Beans from Bo (${JSON.stringify(annRow)?.slice(0, 140)})`);
        assert(!annHistory.text.includes(NOTE), 'with no note anywhere in what she reads');
        assert(annRow?.memo === NEUTRAL, `she reads "${NEUTRAL}" in its place (${JSON.stringify(annRow?.memo)})`);
        assert(keysOf(annRow) === keysOf(annSeesCy), `in the shape every line of hers has (${keysOf(annRow)})`);
        const annExport = await exportOf(ann);
        assert(annExport.status === 200 && annExport.text.includes(boTx) && !annExport.text.includes(NOTE) && annExport.text.includes(NEUTRAL),
            `her export has the send with the neutral line, not the note (${annExport.status})`);
        const feed = await signedCall(base, 'GET', '/api/activity/feed', ann);
        assert(feed.status === 200 && !feed.text.includes(NOTE), `her activity feed has no note (${feed.status})`);
        const annLive = txnEvents(annSock, boTx);
        assert(annLive.length === 1 && annLive[0].txn?.memo === NEUTRAL && keysOf(annLive[0].txn) === keysOf(annLiveCy?.txn),
            `her socket hears the Beans arrive with the neutral line (${JSON.stringify(annLive.map(e => e.txn?.memo))})`);
        assert(!annSock.events.some(e => JSON.stringify(e).includes(NOTE)), `and no event of hers carries the note (${annSock.events.length} heard)`);
        const pushesAfter = (await main.send('pushes') as any[]).filter(p => p.to === 'ExponentPushToken[Ann]');
        assert(pushesAfter.length === pushesBefore && !JSON.stringify(pushesAfter).includes(NOTE), `no push reaches her (${pushesBefore} -> ${pushesAfter.length})`);
        const held = await main.send('holding', { text: NOTE, recipient: ann.pk });
        assert(held.memos === 0, `no ledger row stores the note (${held.memos})`);
        assert(held.activity === 0 && (held.pushNotices ?? 0) === 0, `nor the activity feed, nor a push notice kept for her (${held.activity}, ${held.pushNotices})`);
        assert(held.withheld === 1, `it is kept once, for Bo alone (${held.withheld})`);

        // ── 4. Bo's own reads ───────────────────────────────────────────────────────────────────
        console.log('── 4. the sender reads his note as he wrote it ──');
        const boHistory = await historyOf(bo);
        const boRow = rowIn(boHistory, boTx);
        const cyRow = rowIn(await historyOf(cy), cyTx);
        assert(boRow?.memo === NOTE && boRow?.amount === 3 && keysOf(boRow) === keysOf(cyRow),
            `his history shows his note, in the shape Cy's has (${JSON.stringify(boRow)?.slice(0, 140)})`);
        const boExport = await exportOf(bo);
        assert(boExport.status === 200 && boExport.text.includes(NOTE) && !boExport.text.includes(NEUTRAL), 'his export has his note, and no neutral line');
        const boLive = txnEvents(boSock, boTx);
        assert(boLive.length === 1 && boLive[0].txn?.memo === NOTE && keysOf(boLive[0].txn) === keysOf(cyLive?.txn),
            `his socket hears his send with his note, as Cy's did (${JSON.stringify(boLive.map(e => e.txn?.memo))})`);
        assert(!boSock.events.some(e => JSON.stringify(e).includes(NEUTRAL)) && !boHistory.text.includes(NEUTRAL),
            'nothing he reads says he is blocked');

        // ── 5. a standby's copy ─────────────────────────────────────────────────────────────────
        console.log("── 5. a standby's copy ──");
        const copy = JSON.parse(await main.send('copy', { nodeId: main.ready.peerId }));
        const copied = (copy.transactions ?? []).find((t: any) => t.id === boTx);
        assert(!!copied && copied.memo === '' && copied.amount === 3, `the copy carries the send, with no note (${JSON.stringify(copied?.memo)})`);
        const withoutSigned = JSON.stringify(copy, (k, v) => (k === 'authPayload' ? undefined : v));
        assert(!withoutSigned.includes(NOTE) && !JSON.stringify(Object.keys(copy)).includes('withheld'),
            'and nothing in it holds the note, but the sender\'s own signed request');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', ENFORCE_LEDGER_AUTH: 'true' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies its main server (${JSON.stringify(seeded)?.slice(0, 160)})`);
        const sLedger = await standby.send('ledger', { txId: boTx, keys: [ann.pk, bo.pk] });
        assert(sLedger.row?.amount === 3 && sLedger.row?.from_pubkey === bo.pk && sLedger.row?.to_pubkey === ann.pk,
            'the send is on the standby, its authorship re-checked (ENFORCE_LEDGER_AUTH)');
        assert(sLedger.row?.memo === '' && sLedger.balances[ann.pk] === after.balances[ann.pk] && sLedger.balances[bo.pk] === after.balances[bo.pk],
            `with no note, and the same balances (${JSON.stringify(sLedger.row?.memo)})`);
        const sHeld = await standby.send('holding', { text: NOTE, recipient: ann.pk });
        assert(sHeld.memos === 0 && (sHeld.withheld ?? 0) === 0, `the standby keeps no note: not in the ledger, and no withheld note (${sHeld.memos}, ${sHeld.withheld})`);
        const sBase = `https://localhost:${await standby.send('serve')}`;
        const sAnn = await historyOf(ann, sBase);
        assert(sAnn.status === 200 && !!rowIn(sAnn, boTx) && !sAnn.text.includes(NOTE), `on the standby's own server Ann's history has the send and no note (${sAnn.status})`);
        const sAnnExport = await exportOf(ann, sBase);
        assert(sAnnExport.status === 200 && !sAnnExport.text.includes(NOTE), `nor her export there (${sAnnExport.status})`);

        // ── 6. the unblock ──────────────────────────────────────────────────────────────────────
        console.log('── 6. after the unblock ──');
        const unblk = await signedCall(base, 'POST', '/api/blocks/remove', ann, { targetPubkey: bo.pk });
        require_(unblk.status === 200, `Ann unblocks Bo (${show(unblk)})`);
        const annAfter = await historyOf(ann);
        assert(!annAfter.text.includes(NOTE) && rowIn(annAfter, boTx)?.memo === NEUTRAL, 'nothing old arrives: the send still shows the neutral line');
        const later = await signedCall(base, 'POST', '/api/ledger/transfer', bo, { to: ann.pk, amount: 1, memo: LATER });
        const laterTx: string = later.body?.transaction?.id;
        const annLater = await historyOf(ann);
        assert(later.status === 200 && rowIn(annLater, laterTx)?.memo === LATER, `a note sent after it arrives (${show(later)})`);

        // ── 7. a note sent as a JSON number ─────────────────────────────────────────────────────
        console.log('── 7. a note sent as a JSON number ──');
        const NUM = 412345678;
        const blkAgain = await signedCall(base, 'POST', '/api/blocks', ann, { targetPubkey: bo.pk });
        require_(blkAgain.status === 200, `Ann blocks Bo again (${show(blkAgain)})`);
        annSock.events.length = 0;
        const control = await signedCall(base, 'POST', '/api/ledger/transfer', bo, { to: dee.pk, amount: 1, memo: NUM });
        const controlTx: string = control.body?.transaction?.id;
        require_(control.status === 200 && !!controlTx, `Bo sends Dee (who has not blocked him) a number note: the shape to hold his send to Ann to (${show(control)})`);
        const numSend = await signedCall(base, 'POST', '/api/ledger/transfer', bo, { to: ann.pk, amount: 1, memo: NUM });
        const numTx: string = numSend.body?.transaction?.id;
        require_(numSend.status === 200 && numSend.body?.success === true && !!numTx, `Bo sends Ann a number note; accepted (${show(numSend)})`);
        await sleep(200);
        const annNum = await historyOf(ann);
        assert(rowIn(annNum, numTx)?.memo === NEUTRAL && rowIn(annNum, numTx)?.amount === 1, `Ann's history has the send with the neutral line (${JSON.stringify(rowIn(annNum, numTx)?.memo)})`);
        assert(!annNum.text.includes(String(NUM)), 'and no digit of the number note');
        const annNumExport = await exportOf(ann);
        assert(annNumExport.status === 200 && annNumExport.text.includes(numTx) && !annNumExport.text.includes(String(NUM)), 'her export has the send and not the number');
        assert(txnEvents(annSock, numTx).length === 1 && txnEvents(annSock, numTx)[0].txn?.memo === NEUTRAL && !annSock.events.some(e => JSON.stringify(e).includes(String(NUM))),
            `her socket hears it with the neutral line, and never the number (${JSON.stringify(txnEvents(annSock, numTx).map(e => e.txn?.memo))})`);
        const numLedger = await main.send('ledger', { txId: numTx, keys: [ann.pk] });
        assert(numLedger.row?.memo === '' && numLedger.row?.amount === 1, `the ledger row stores no note (${JSON.stringify(numLedger.row?.memo)})`);
        const numCopy = await main.send('copy', { nodeId: main.ready.peerId });
        const numCopied = (JSON.parse(numCopy).transactions ?? []).find((t: any) => t.id === numTx);
        assert(!!numCopied && numCopied.memo === '' && !JSON.stringify(numCopied, (k, v) => (k === 'authPayload' ? undefined : v)).includes(String(NUM))
            && JSON.stringify(JSON.parse(numCopy).transactions.find((t: any) => t.id === controlTx)?.memo) !== '""',  // the unblocked send's number is in the copy, as any note is
            `a standby's copy (exportSyncState) carries the send with no note (${JSON.stringify(numCopied?.memo)})`);
        const boNum = rowIn(await historyOf(bo), numTx);
        const boControl = rowIn(await historyOf(bo), controlTx);
        assert(boNum?.memo === boControl?.memo && typeof boNum?.memo === typeof boControl?.memo && keysOf(boNum) === keysOf(boControl),
            `Bo's history reads it exactly as the unblocked send's (${JSON.stringify(boNum?.memo)} vs ${JSON.stringify(boControl?.memo)})`);
        const boNumExport = (await exportOf(bo)).text.split('\n');
        const lineEnd = (id: string) => (boNumExport.find(l => l.includes(id)) ?? '').split(',').pop();
        assert(lineEnd(numTx) === lineEnd(controlTx) && lineEnd(numTx) !== '', `his export line ends the same (${lineEnd(numTx)} vs ${lineEnd(controlTx)})`);
        assert(txnEvents(boSock, numTx)[0]?.txn?.memo === numSend.body.transaction.memo && JSON.stringify(txnEvents(boSock, numTx)[0]?.txn?.memo) === JSON.stringify(txnEvents(boSock, controlTx)[0]?.txn?.memo),
            `his socket event carries the number as the unblocked send's did (${JSON.stringify(txnEvents(boSock, numTx)[0]?.txn?.memo)})`);

        // ── 8. a prune and a self-deletion ──────────────────────────────────────────────────────
        console.log('── 8. a prune and a self-deletion ──');
        const rowsBefore = (await main.send('holding', { text: NOTE, recipient: ann.pk })).withheldRows;
        await main.send('prune', { key: bo.pk, actor: gwen.pk });
        const pruned = await main.send('holding', { text: NOTE, recipient: ann.pk });
        assert(pruned.withheld === 0 && !pruned.withheldWords.includes(String(NUM)) && !pruned.withheldWords.some((w: string) => w.includes('412345678')),
            `a prune takes his words (${pruned.withheld})`);
        assert(pruned.withheldRows === rowsBefore, `but keeps the rows, blank (${rowsBefore} -> ${pruned.withheldRows})`);
        const annPruned = await historyOf(ann);
        assert(annPruned.status === 200 && !annPruned.text.includes(NOTE) && !!rowIn(annPruned, boTx), 'Ann still has the Beans and never the note');
        assert(rowIn(annPruned, boTx)?.memo === NEUTRAL && rowIn(annPruned, numTx)?.memo === NEUTRAL, `and still reads the neutral line after the prune (${JSON.stringify(rowIn(annPruned, boTx)?.memo)})`);
        assert((await exportOf(ann)).text.split(NEUTRAL).length - 1 >= 2, 'her export still says it');
        const EVE_NOTE = `from eve ${crypto.randomBytes(4).toString('hex')}`;
        const blkEve = await signedCall(base, 'POST', '/api/blocks', ann, { targetPubkey: eve.pk });
        const eveSend = await signedCall(base, 'POST', '/api/ledger/transfer', eve, { to: ann.pk, amount: 2, memo: EVE_NOTE });
        const eveKept = await main.send('holding', { text: EVE_NOTE, recipient: ann.pk });
        assert(blkEve.status === 200 && eveSend.status === 200 && eveKept.withheld === 1 && eveKept.memos === 0,
            `Ann blocks Eve, and Eve's note is kept for Eve alone (${show(eveSend)})`);
        const gone = await main.send('delete-account', { key: eve.pk });
        const afterDelete = await main.send('holding', { text: EVE_NOTE, recipient: ann.pk });
        const annEve = await historyOf(ann);
        const eveTx = eveSend.body?.transaction?.id;
        assert(gone?.ok === true && afterDelete.withheld === 0 && !afterDelete.withheldWords.includes(EVE_NOTE) && !!rowIn(annEve, eveTx) && !annEve.text.includes(EVE_NOTE),
            `a self-deletion takes his words too; Ann keeps the Beans and never sees the note (${JSON.stringify(gone)?.slice(0, 80)}, ${afterDelete.withheld})`);
        assert(rowIn(annEve, eveTx)?.memo === NEUTRAL && (await exportOf(ann)).text.includes(NEUTRAL) && !(await exportOf(ann)).text.includes(EVE_NOTE),
            'and still reads the neutral line in her history and export');
        const audit = await main.send('ledger', { keys: [] });
        assert(audit.audit?.ok === true, `the ledger audit holds after it all (${JSON.stringify(audit.audit)})`);
    } finally {
        for (const s of socks) s.ws.close();
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Beans from someone you have blocked arrive without their note.');
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
