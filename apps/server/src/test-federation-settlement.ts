/**
 * Cross-node settlement refusal (#102) against the REAL server.
 *
 * A visitor — a member carrying a home_node_url — holds their beans on their home
 * node's ledger. Two routes previously VERIFIED that home balance over libp2p and then
 * moved value LOCALLY, so the home ledger was read and never written: the same beans
 * could be spent once on every node the member visited.
 *
 *   POST /api/ledger/transfer              (routes/community.ts)
 *   POST /api/crowdfund/projects/:id/pledge (routes/commons.ts)
 *
 * Both now refuse via blockCrossNodeSettlement() until charge-home settlement exists
 * (#104). These checks pin the refusal, pin that the ledger does NOT move, and pin that
 * local members are not over-blocked.
 *
 * Both senders are seeded activated (members.earned_credit > 0) and funded, so a send
 * would genuinely succeed if the guard were absent — that is what makes the
 * balance-unchanged assertions meaningful rather than vacuous.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-federation-settlement.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { FEDERATION_SETTLEMENT_ENABLED, isVisitor } from './federation-settlement.js';

const PORT = 8548;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** Seed an activated, funded member. `homeNodeUrl` makes them a visitor from another node. */
function makeIdentity(callsign: string, balance: number, homeNodeUrl?: string) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    // earned_credit > 0 ⇒ activated (granted-credit lane), so the send gate is open.
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, home_node_url)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 200, ?)`
    ).run(pubKeyHex, callsign, homeNodeUrl ?? null);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`)
        .run(pubKeyHex, balance);
    return { pubKeyHex, privateKey };
}

const balanceOf = (pk: string): number =>
    (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0;

async function signedFetch(method: 'GET' | 'POST', path: string, id: { pubKeyHex: string; privateKey: crypto.KeyObject }, body?: any) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, error: json?.error as string | undefined, code: json?.code as string | undefined };
}

async function main() {
    console.log('Running cross-node settlement refusal tests (#102)...\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // A visitor whose beans live on another node, and two local members.
    const visitor = makeIdentity('VisitingVal', 100, 'https://other.beanpool.org');
    const local = makeIdentity('LocalLou', 100);
    const payee = makeIdentity('PayeePat', 0);

    assert(FEDERATION_SETTLEMENT_ENABLED === false, 'settlement flag is OFF until #104 lands');
    assert(isVisitor(visitor.pubKeyHex) === true, 'a member with a home_node_url is a visitor');
    assert(isVisitor(local.pubKeyHex) === false, 'a local member is not a visitor');

    // ── The transfer route ───────────────────────────────────────────────────────
    const vBefore = balanceOf(visitor.pubKeyHex);
    const pBefore = balanceOf(payee.pubKeyHex);
    const vSend = await signedFetch('POST', '/api/ledger/transfer', visitor,
        { to: payee.pubKeyHex, amount: 5, memo: 'cross-node send' });
    assert(vSend.status === 503, `visitor send is REFUSED (got ${vSend.status} ${vSend.error ?? ''})`);
    assert(vSend.code === 'federation_settlement_disabled', `refusal carries the settlement code (got ${vSend.code ?? 'none'})`);
    assert(balanceOf(visitor.pubKeyHex) === vBefore, 'visitor balance unchanged — nothing debited locally');
    assert(balanceOf(payee.pubKeyHex) === pBefore, 'payee balance unchanged — nothing minted on this node');

    // ── No over-blocking ─────────────────────────────────────────────────────────
    // The two senders differ ONLY in home_node_url, so this pins the guard's boundary.
    // The local send is then refused by the ordinary first-completed-trade gate — which
    // is the point: it got past the federation guard and into the ledger logic. (The
    // send gate is orthogonal to #102; activating a credit line does not satisfy it.)
    const lSend = await signedFetch('POST', '/api/ledger/transfer', local,
        { to: payee.pubKeyHex, amount: 5, memo: 'local send' });
    assert(lSend.status !== 503, `local send is not refused by the settlement guard (got ${lSend.status})`);
    assert(lSend.code !== 'federation_settlement_disabled', 'local send carries no settlement refusal code');
    assert(/completed trade/.test(lSend.error ?? ''), `local send reached the ordinary send gate (got "${lSend.error ?? ''}")`);

    // ── The crowdfund pledge route (the second, unreported instance) ─────────────
    // A bogus project id is deliberate: the guard must fire BEFORE any project or
    // ledger work, so ordering is part of what's under test.
    const vAfterSend = balanceOf(visitor.pubKeyHex);
    const vPledge = await signedFetch('POST', '/api/crowdfund/projects/does-not-exist/pledge', visitor,
        { fromPubkey: visitor.pubKeyHex, amount: 5, memo: 'cross-node pledge' });
    assert(vPledge.status === 503, `visitor pledge is REFUSED (got ${vPledge.status} ${vPledge.error ?? ''})`);
    assert(vPledge.code === 'federation_settlement_disabled', `pledge refusal carries the settlement code (got ${vPledge.code ?? 'none'})`);
    assert(balanceOf(visitor.pubKeyHex) === vAfterSend, 'visitor balance unchanged by the refused pledge');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Cross-node settlement refusal checks PASSED (#102).');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
