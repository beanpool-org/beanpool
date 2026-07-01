/**
 * Economic hardening tests (audit findings A2-14, A2-18, A2-26).
 *
 *   A2-26 outbound volume counts at most PER_COUNTERPARTY_VOLUME_CAP per recipient,
 *         so Sybil wash-trading between two identities can't inflate governance
 *         credit (or earned credit), while diverse trade is unaffected.
 *   A2-14 importRemoteState counts an amount≤0 transaction as an explicit skip
 *         (no silent INSERT-OR-IGNORE drop that would desync balances/ledger).
 *   A2-18 the public transfer route rejects synthetic recipients (escrow_*, etc.).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-economic-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './tls.js';
import {
    initStateEngine, getGovernanceCredits, importRemoteState, setNodeRole, signSyncPayload, type SyncPayload,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { db } from './db/db.js';

const PORT = 8550;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function seedMember(pk: string) {
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, pk.slice(0, 8));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}
let txc = 0;
function tx(from: string, to: string, amount: number) {
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('etx' + (txc++), from, to, amount, 'm', new Date().toISOString());
}

async function main() {
    console.log('Running economic hardening tests (A2-14/A2-18/A2-26)...\n');
    await initTls();
    initStateEngine();
    const node = await startP2P(4024, 4025);
    await startHttpsServer(PORT);
    const nodeId = node.peerId.toString();

    try {
        // A2-26 — wash (concentrated) volume is capped; diverse volume is not.
        const wash = 'wash-' + Date.now();
        seedMember(wash);
        for (let i = 0; i < 10; i++) tx(wash, 'sybilPartner', 2000); // 20000 to ONE counterparty
        assert(getGovernanceCredits(wash).totalCredits === 5000,
            'A2-26: 20000 washed to one counterparty counts as only 5000 (per-counterparty cap)');

        const diverse = 'diverse-' + Date.now();
        seedMember(diverse);
        for (let i = 0; i < 6; i++) tx(diverse, 'partner' + i, 1000); // 6 distinct counterparties
        assert(getGovernanceCredits(diverse).totalCredits === 6000,
            'A2-26: 6000 across 6 counterparties counts fully (diversity not penalized)');

        // A2-14 — an amount≤0 imported txn is an explicit skip, not a silent drop.
        setNodeRole('backup');
        addConnector(`/ip4/127.0.0.1/tcp/4025/p2p/${nodeId}`, 'mirror', 'self');
        const payload: SyncPayload = await signSyncPayload({
            nodeId,
            transactions: [{ id: 'zero-tx', from: 'A', to: 'B', amount: 0, memo: 'bad', timestamp: new Date().toISOString() } as any],
        });
        const result = await importRemoteState(payload);
        assert(result.conflictsSkipped >= 1 && result.newTransactions === 0,
            'A2-14: amount≤0 txn counted as conflictsSkipped, not inserted');
        const zero = db.prepare(`SELECT 1 FROM transactions WHERE id='zero-tx'`).get();
        assert(!zero, 'A2-14: the invalid txn did not land in the DB');

        // A2-18 — public transfer to a synthetic recipient is rejected.
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
        seedMember(pubHex);
        const path = '/api/ledger/transfer';
        const body = JSON.stringify({ from: pubHex, to: 'escrow_attacker', amount: 5 });
        const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
        const sig = crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${body}`), privateKey).toString('base64');
        const res = await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Public-Key': pubHex, 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Nonce': nonce },
            body,
        });
        const err = (await res.json())?.error ?? '';
        assert(res.status === 400 && /invalid recipient/i.test(err), `A2-18: transfer to escrow_* rejected (got ${res.status} "${err}")`);

        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ Economic hardening checks PASSED (A2-14/A2-18/A2-26).');
    } finally {
        await node.stop();
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
