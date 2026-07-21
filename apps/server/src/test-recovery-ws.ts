/**
 * A2-16 (recovery pending authz) + A2-20 (WS transaction scoping) against the real
 * server, with ENFORCE_READ_AUTH and ENFORCE_WS_AUTH ON.
 *
 *   A2-16 GET /api/recovery/pending/:guardian requires the VERIFIED signer to be
 *         that guardian (the unsigned x-public-key header was non-authenticating).
 *   A2-20 a ledger 'transaction' event on the /ws feed is delivered ONLY to its two
 *         parties, not broadcast to every connected member.
 *
 * MUST run with both flags on (module consts read at import):
 *   ENFORCE_READ_AUTH=true ENFORCE_WS_AUTH=true BEANPOOL_DATA_DIR=$(mktemp -d) \
 *     pnpm exec tsx src/test-recovery-ws.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8551;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function makeId(callsign: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pubKeyHex, callsign);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}
const sign = (msg: string, pk: crypto.KeyObject) => crypto.sign(null, Buffer.from(msg), pk).toString('base64');

async function signedGet(path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }) {
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${path}`, {
        headers: { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sign(`GET\n${path}\n${ts}\n${nonce}\n`, id.privateKey), 'X-Timestamp': String(ts), 'X-Nonce': nonce },
    });
    return res.status;
}

function wsConnect(id: { pubKeyHex: string; privateKey: crypto.KeyObject }): Promise<{ ws: WebSocket; events: any[] }> {
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString('hex');
    const sig = sign(`WS\n/ws\n${ts}\n${nonce}\n`, id.privateKey);
    const qs = `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    const ws = new WebSocket(`wss://localhost:${PORT}/ws?${qs}`, { rejectUnauthorized: false });
    const events: any[] = [];
    ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
    return new Promise((resolve, reject) => {
        ws.on('open', () => resolve({ ws, events }));
        ws.on('error', reject);
    });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('Running A2-16 + A2-20 tests (ENFORCE_READ_AUTH + ENFORCE_WS_AUTH on)...\n');
    if (process.env.ENFORCE_READ_AUTH !== 'true' || process.env.ENFORCE_WS_AUTH !== 'true')
        throw new Error('Run with ENFORCE_READ_AUTH=true ENFORCE_WS_AUTH=true');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const guardian = makeId('Guardian');
    const ward = makeId('Ward');
    const outsider = makeId('Outsider');

    // A2-16 — the guardian may read their own pending; an outsider may not.
    assert(await signedGet(`/api/recovery/pending/${guardian.pubKeyHex}`, guardian) === 200,
        'A2-16: guardian reads their OWN pending recovery requests (200)');
    assert(await signedGet(`/api/recovery/pending/${guardian.pubKeyHex}`, outsider) === 403,
        'A2-16: a non-guardian is DENIED another guardian\'s pending requests (403)');

    // A2-20 — connect the ward (a party) and the outsider (not a party); a transfer
    // to the ward must reach only the ward's socket.
    const wardWs = await wsConnect(ward);
    const outWs = await wsConnect(outsider);
    await sleep(100);
    wardWs.events.length = 0; outWs.events.length = 0; // drop the initial state_snapshot

    transfer('COMMONS_POOL', ward.pubKeyHex, 5, 'a2-20 test'); // recipients = [COMMONS_POOL, ward]
    await sleep(300);

    const wardGotTxn = wardWs.events.some(e => e.type === 'transaction' && e.txn?.to === ward.pubKeyHex);
    const outGotTxn = outWs.events.some(e => e.type === 'transaction');
    assert(wardGotTxn, 'A2-20: the party (ward) received the transaction event on /ws');
    assert(!outGotTxn, 'A2-20: a non-party (outsider) did NOT receive the transaction event');

    wardWs.ws.close(); outWs.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A2-16 + A2-20 checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
