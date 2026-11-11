/**
 * Beans as whole hundredths, on a real node (DESIGN-atomic-beans-fable.md §5): every check here is one a float, a double
 * rounding, a fee rounded toward the Commons, a dropped hundredth or a slack in the audit would fail.
 *   T1  20,000 random moves over 50 members (holds, releases with the fee, refunds, halves, circulation at random epochs):
 *       after every 1,000, SUM(balance_c) is exactly the baseline and memory equals the rows; then a reload changes nothing.
 *   T2  the fee is truncated once and the row is written from it: fee_c + net === amount_c; the CHECK refuses fee > amount.
 *   T3  a spend landing exactly on the floor passes and one hundredth more is refused.
 *   T4  POST /api/ledger/transfer takes `{ to, amount_c }` (an integer), signed; the old `amount`, 20.5, "2000", 0 and -1 are
 *       400 amount_c_required; a standby re-verifies the stored payload, and one tampered 2000 → 20000 fails.
 *   T5  LedgerAudit is exact: one hundredth taken by hand is drift -1 and not ok; a float baseline is refused, not read.
 *   T8  a month of circulation on 1,000 Beans is a whole charge; account + pot unchanged in sum; the row holds the integer.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-hundredths-conservation.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, seedGenesisMember, getCommonsBalanceExact, reconcileLedgerFromDb, settleDemurrage, runLedgerAudit,
} from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { ledger } from './engine/ledger.js';
import { verifyTransactionAuthorship } from './engine/sync.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { feeOf, halves, circulationChargeOf } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}
function makeMember(name: string, hundredths = 0): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 30 * DAY).toISOString());
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)`).run(id.pk, ledger.getCurrentEpoch());
    if (hundredths > 0) assert(!!transfer('genesis', id.pk, hundredths, `seed ${name}`, 'direct', true), `setup: ${name} holds ${hundredths}`);
    return id;
}
async function call(method: string, id: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit(); resetAdminRateLimit(); resetAdminAuthTarpit(); pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = hex(16);
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** Every account's row summed (the pot's COMMONS_POOL row is its persisted figure): the number that must not move. */
const rowsTotal = () => (db.prepare('SELECT COALESCE(SUM(balance_c), 0) AS t FROM accounts').get() as { t: number }).t;
const rowOf = (pk: string) => (db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c;
const allIntegers = () => (db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE typeof(balance_c) != 'integer'`).get() as { n: number }).n === 0;

/** A small seeded generator, so a failure replays. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);

    // ═══════════════ T1: conservation over many moves ═══════════════
    console.log('\n── T1 20,000 random moves conserve to the hundredth ──');
    const rand = rng(20261110);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const members = Array.from({ length: 50 }, (_, i) => makeMember(`M${i}`, 100_000 + Math.floor(rand() * 400_000)));
    const baseline = rowsTotal();
    const audit0 = runLedgerAudit();
    assert(audit0.ok && audit0.drift === 0, `the audit starts exact (sum ${audit0.sumBalances}, drift ${audit0.drift})`);
    const open = new Map<string, { buyer: string; seller: string; held: number }>();
    let moves = 0, fees = 0, refused = 0, halvesSplit = 0, circulated = 0;
    let checksOk = true;
    for (let i = 1; i <= 20_000; i++) {
        const r = rand();
        if (r < 0.40 || open.size === 0) {
            // A hold: a member pays a whole amount they hold into a deal's escrow (fee-free, as a deal's hold is).
            const buyer = pick(members); const seller = pick(members);
            if (buyer.pk === seller.pk) continue;
            const holds = Math.max(0, ledger.getAccount(buyer.pk).balance_c);
            const amount = 1 + Math.floor(rand() * Math.min(holds, 60_000));
            const key = `escrow_t1-${i}`;
            if (amount > holds || !transfer(buyer.pk, key, amount, 'hold', 'escrow', true)) { refused++; continue; }
            open.set(key, { buyer: buyer.pk, seller: seller.pk, held: amount });
        } else {
            const [key, deal] = pick([...open.entries()]);
            const kind = rand();
            if (kind < 0.55) {
                // A release with the fee: the seller gets amount − feeOf(amount), the pot feeOf(amount).
                const t = transfer(key, deal.seller, deal.held, 'release', 'escrow', false);
                if (!t) { checksOk = false; console.error(`release refused at ${i}`); break; }
                if (t.fee_c !== feeOf(deal.held)) { checksOk = false; console.error(`fee ${t.fee_c} != feeOf(${deal.held}) at ${i}`); }
                fees += t.fee_c ?? 0;
            } else if (kind < 0.80) {
                if (!transfer(key, deal.buyer, deal.held, 'refund', 'escrow', true)) { checksOk = false; break; }
            } else {
                const [toBuyer, toSeller] = halves(deal.held);
                if (toBuyer > 0 && !transfer(key, deal.buyer, toBuyer, 'split', 'escrow', true)) { checksOk = false; break; }
                if (!transfer(key, deal.seller, toSeller, 'split', 'escrow', true)) { checksOk = false; break; }
                halvesSplit++;
            }
            if (ledger.getAccount(key).balance_c !== 0) { checksOk = false; console.error(`escrow ${key} left at ${ledger.getAccount(key).balance_c}`); }
            open.delete(key);
        }
        if (rand() < 0.02) {
            // Circulation at a random epoch: an account left for 1 to 90 days, settled (whole charge, rows written).
            const m = pick(members);
            if (ledger.getAccount(m.pk).balance_c > 20_000) {
                db.prepare('UPDATE accounts SET last_demurrage_epoch = ? WHERE public_key = ?').run(ledger.getCurrentEpoch() - (1 + Math.floor(rand() * 90)), m.pk);
                reconcileLedgerFromDb();
                settleDemurrage([m.pk]);
                circulated++;
            }
        }
        moves++;
        if (i % 1000 === 0) {
            const total = rowsTotal();
            const mismatched = members.filter((m) => rowOf(m.pk) !== ledger.getAccount(m.pk).balance_c).length;
            if (total !== baseline || mismatched > 0 || !allIntegers()) {
                checksOk = false;
                console.error(`at ${i}: total ${total} vs ${baseline}, ${mismatched} memory/row mismatches, integers ${allIntegers()}`);
                break;
            }
        }
    }
    // The holds still open go back to their buyers: an escrow holding Beans for no deal is stranded, as the audit says.
    for (const [key, deal] of open) if (!transfer(key, deal.buyer, deal.held, 'refund', 'escrow', true)) checksOk = false;
    open.clear();
    assert(checksOk, `every 1,000 moves the rows sum to the baseline exactly and memory equals them (${moves} moves, ${fees} in fees, ${halvesSplit} splits, ${circulated} circulations, ${refused} holds refused)`);
    assert(fees > 0 && halvesSplit > 0 && circulated > 0, 'the run exercised fees, splits and circulation');
    reconcileLedgerFromDb();
    assert(rowsTotal() === baseline && members.every((m) => rowOf(m.pk) === ledger.getAccount(m.pk).balance_c),
        'a reload from the rows changes nothing: every account equal, the total the baseline');
    const audit1 = runLedgerAudit();
    assert(audit1.drift === 0 && audit1.badBalances === 0, `the audit reads drift exactly 0 after the run (${audit1.drift})`);

    // ═══════════════ T2: the fee is truncated once, and the CHECK holds the row to it ═══════════════
    console.log('\n── T2 the fee, truncated once ──');
    const payer = makeMember('Payer', 10_000);
    const payee = makeMember('Payee');
    const potBefore = getCommonsBalanceExact();
    const oneBean = transfer(payer.pk, 'escrow_t2', 100, 'hold', 'escrow', true);
    const released = transfer('escrow_t2', payee.pk, 100, 'release', 'escrow', false);
    assert(!!oneBean && released?.fee_c === 1 && ledger.getAccount(payee.pk).balance_c === 99 && getCommonsBalanceExact() - potBefore === 1,
        `a 1-Bean deal: fee 1 hundredth, the seller 99, the pot +1 (fee ${released?.fee_c}, seller ${ledger.getAccount(payee.pk).balance_c})`);
    const row = db.prepare('SELECT amount_c, fee_c FROM transactions WHERE id = ?').get(released!.id) as { amount_c: number; fee_c: number };
    assert(row.amount_c === 100 && row.fee_c === 1, `the row holds the fee the ledger took (${JSON.stringify(row)})`);
    let checkRefused = false;
    try {
        db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo) VALUES (?, 'a', 'b', 100, 101, 'bad')`).run(hex(8));
    } catch { checkRefused = true; }
    assert(checkRefused, 'the CHECK refuses a row whose fee is more than its amount');
    let floatRefused = false;
    try {
        db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo) VALUES (?, 'a', 'b', 0, 0, 'bad')`).run(hex(8));
    } catch { floatRefused = true; }
    assert(floatRefused, 'the CHECK refuses a row of 0');
    assert(transfer(payer.pk, 'escrow_t2b', 20.5, 'hold', 'escrow', true) === null, 'a float amount moves nothing');

    // ═══════════════ T3: the floor, to the hundredth ═══════════════
    console.log('\n── T3 a spend landing exactly on the floor ──');
    const edge = makeMember('Edge', 4925);
    assert(!!transfer(edge.pk, 'escrow_t3', 4925, 'hold', 'escrow', true) && ledger.getAccount(edge.pk).balance_c === 0,
        'a member holding 49.25 Beans can put exactly 4925 hundredths in trust (lands on the floor of 0)');
    assert(transfer(edge.pk, 'escrow_t3b', 1, 'hold', 'escrow', true) === null && ledger.getAccount(edge.pk).balance_c === 0,
        'one hundredth more is refused, and nothing moved');
    // Back to Edge: an escrow holding Beans for no deal is stranded, and the audit below would rightly say so.
    assert(!!transfer('escrow_t3', edge.pk, 4925, 'refund', 'escrow', true) && ledger.getAccount('escrow_t3').balance_c === 0, 'the hold goes back whole');

    // ═══════════════ T4: the signed body carries the integer ═══════════════
    console.log('\n── T4 POST /api/ledger/transfer takes amount_c ──');
    const sender = makeMember('Sender', 50_000);
    const partner = makeMember('Partner');
    // A completed trade, so the send gate (a member who has traded) lets the sender give.
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, completed_at)
                VALUES (?, ?, ?, ?, 500, 'completed', datetime('now'), datetime('now'))`).run(crypto.randomUUID(), crypto.randomUUID(), sender.pk, partner.pk);
    const receiver = makeMember('Receiver');
    const sent = await call('POST', sender, '/api/ledger/transfer', { to: receiver.pk, amount_c: 2000, memo: 'twenty Beans' });
    assert(sent.status === 200 && ledger.getAccount(receiver.pk).balance_c === 2000, `{ amount_c: 2000 } sends 20 Beans (${show(sent)})`);
    const stored = db.prepare(`SELECT * FROM transactions WHERE to_pubkey = ? ORDER BY timestamp DESC LIMIT 1`).get(receiver.pk) as any;
    assert(stored?.amount_c === 2000 && typeof stored?.auth_payload === 'string' && stored.auth_payload.includes('"amount_c":2000'),
        'the row stores 2000 and the exact signed body carrying the integer');
    const tx = { id: stored.id, from: stored.from_pubkey, to: stored.to_pubkey, amount_c: stored.amount_c, memo: stored.memo ?? '', timestamp: stored.timestamp,
        authSigner: stored.auth_signer, authSignature: stored.auth_signature, authPayload: stored.auth_payload };
    assert(verifyTransactionAuthorship(tx), 'a standby re-verifies it: the signed amount_c is the row\'s');
    assert(!verifyTransactionAuthorship({ ...tx, amount_c: 20000 }), 'a row claiming 20000 for a body signed at 2000 fails');
    assert(!verifyTransactionAuthorship({ ...tx, authPayload: tx.authPayload.replace('"amount_c":2000', '"amount_c":20000') }), 'a payload tampered 2000 → 20000 fails its signature');
    for (const bad of [{ amount: 20 }, { amount_c: 20.5 }, { amount_c: '2000' }, { amount_c: 0 }, { amount_c: -1 }]) {
        const r = await call('POST', sender, '/api/ledger/transfer', { to: receiver.pk, ...bad, memo: 'bad' });
        assert(r.status === 400 && r.body?.code === 'amount_c_required', `${JSON.stringify(bad)} is refused 400 amount_c_required (${show(r)})`);
    }
    assert(ledger.getAccount(receiver.pk).balance_c === 2000, 'no refused body moved anything');

    // ═══════════════ T5: the audit is exact ═══════════════
    console.log('\n── T5 LedgerAudit, exact ──');
    const ok = runLedgerAudit();
    assert(ok.ok && ok.drift === 0, `the audit passes with drift 0 (${ok.drift})`);
    db.prepare('UPDATE accounts SET balance_c = balance_c - 1 WHERE public_key = ?').run(receiver.pk);
    const short = runLedgerAudit();
    assert(!short.ok && short.drift === -1, `one hundredth taken by hand is drift -1 and not ok (${short.drift}, ok ${short.ok})`);
    db.prepare('UPDATE accounts SET balance_c = balance_c + 1 WHERE public_key = ?').run(receiver.pk);
    assert(runLedgerAudit().ok, 'put back, the audit passes again');
    const stamp = (db.prepare(`SELECT value FROM node_config WHERE key = 'ledger_audit_baseline'`).get() as { value: string }).value;
    assert(/^-?\d+$/.test(stamp), `the baseline is stored as integer text (${stamp})`);
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(`${stamp}.5`);
    const floatBaseline = runLedgerAudit();
    assert(!floatBaseline.ok && Number.isNaN(floatBaseline.baseline), 'a float baseline (from before whole hundredths) is refused, never read');
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(stamp);
    assert(runLedgerAudit().ok, 'with an integer baseline back, the audit passes');

    // ═══════════════ T8: circulation, a whole charge ═══════════════
    console.log('\n── T8 a month of circulation on 1,000 Beans ──');
    const holder = makeMember('Holder', 100_000);
    const pot0 = getCommonsBalanceExact();
    db.prepare('UPDATE accounts SET last_demurrage_epoch = ? WHERE public_key = ?').run(ledger.getCurrentEpoch() - 30, holder.pk);
    reconcileLedgerFromDb();
    settleDemurrage([holder.pk]);
    const charge = circulationChargeOf(100_000, 1);
    const after = ledger.getAccount(holder.pk).balance_c;
    assert(after === 100_000 - charge && Number.isSafeInteger(charge) && charge > 0, `the charge is a whole ${charge} hundredths (balance ${after})`);
    assert(after + (getCommonsBalanceExact() - pot0) === 100_000, 'account + pot unchanged in sum');
    const decayRow = db.prepare(`SELECT amount_c FROM transactions WHERE from_pubkey = ? AND id LIKE 'demurrage_%'`).get(holder.pk) as { amount_c: number } | undefined;
    assert(decayRow?.amount_c === charge && Number.isSafeInteger(decayRow.amount_c), `the row holds the integer charge (${decayRow?.amount_c})`);
    assert(runLedgerAudit().ok, 'and the audit still reads exact');

    console.log(`\n${passed}/${run} passed`);
    if (passed === run) console.log('⭐️ Hundredths conservation PASSED.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
