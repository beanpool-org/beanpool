/**
 * A Commons grant is capped when it's proposed — over a REAL HTTPS round trip, through the signature middleware.
 *
 * Marty's card grant-cap (2026-09-27, "Cap it when proposed"): a grant_enterprise or grant_hardship bigger than what the
 * Commons holds now plus what flowed into it over the last 30 days is refused before anyone votes. Left to a vote, a
 * grant the Commons can't pay sits in the one-slot funding queue for up to 90 days, and every other grant that passes
 * short of funds is refused "Funding queue is full" (#1200's review).
 *
 * The inflow is read from the ledger (decisions-engine.ts commonsGrantCap): the amount of every transactions row to
 * COMMONS_POOL (circulation fee, moveToCommons) plus tax_fee on every row (the 1.5% market fee), in (now − 30 days, now].
 *
 * Verifies, each proposal a signed POST /api/commons/decisions from a member's key (format 2, as the apps sign):
 *  1. A grant exactly at the cap is accepted; one Bean over, and one cent over, is refused 400 with the sentence, and
 *     nothing is written (no Decision row, the Commons and the ledger unchanged). The same for a hardship grant.
 *     Which rows count: a real moveToCommons, a circulation-fee row, a trade's tax_fee and a row in SQLite's own
 *     timestamp form count; a row 31 days old, a fee 40 days old, a payment OUT of the Commons and a row dated after
 *     now do not.
 *  2. The cap moves with the balance, with a new inflow row, and with the clock (injected): two days on, a row 29 days
 *     old drops out and tomorrow's row comes in; sixty days on the inflow is 0 and the cap is what the Commons holds.
 *  3. A Commons in deficit is named plainly ("owes") and the cap never shows below 0; a grant with no usable amount is
 *     refused with its own sentence, writing nothing.
 *  4. Other Decision kinds are unaffected: with a cap of 0, a member Decision and a deficit write-off are still proposed.
 *  5. Day zero: a grant queued and a grant open before the rule, both far over today's cap, are untouched by all of the
 *     above (their rows are byte-identical), and the queued one still waits on the tick and pays when the Commons can.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-decisions-grant-cap.ts
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { buildBoundRequestHeaders, ed25519Signer, setCommonsBalance } from '@beanpool/core';
import { initTls } from './services/tls.js';
import {
    initStateEngine, reconcileLedgerFromDb, moveToCommons, getCommonsBalanceExact, tickDecisions,
} from './state-engine.js';
// Looked up by name, so this suite also runs on a tree without the cap and fails on its checks there (fail-first).
import * as decisionsEngine from './decisions-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const PORT = 8713;
const BASE = `https://localhost:${PORT}`;
const DAY = 24 * 60 * 60 * 1000;
const AMOUNT_ERROR = 'A grant needs an amount in Beans above 0.';

// Every assertion runs and failures are reported together, so one broken check does not hide the others.
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

const setCapClock = (decisionsEngine as Record<string, unknown>).setGrantCapClockForTests as
    ((now: (() => number) | null) => void) | undefined;

type Id = { pubKeyHex: string; sign: ReturnType<typeof ed25519Signer> };

let seq = 0;
function makeMember(callsign: string, opts: { treasury?: boolean; balance?: number } = {}): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const pkcs8 = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer);
    const joinedAt = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit, is_treasury)
                VALUES (?, ?, ?, 'active', 100, ?)`).run(pubKeyHex, `${callsign}${++seq}`, joinedAt, opts.treasury ? 1 : 0);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(pubKeyHex, opts.balance ?? 0);
    reconcileLedgerFromDb();
    return { pubKeyHex, sign: ed25519Signer(pkcs8) };
}

async function signedPost(path: string, body: unknown, id: Id) {
    const bodyString = JSON.stringify(body);
    const url = `${BASE}${path}`;
    const headers = await buildBoundRequestHeaders({ method: 'POST', url, body: bodyString, publicKeyHex: id.pubKeyHex, sign: id.sign });
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

let enterprise: Id;
let recipient: Id;

function grantBody(effect: 'grant_enterprise' | 'grant_hardship', params: unknown) {
    return {
        title: effect === 'grant_enterprise' ? 'Seed money for the tool library' : 'Help with the rent this month',
        description: 'A grant from the Commons, as set out here.',
        touches: 'pool',
        effect,
        subject: effect === 'grant_enterprise' ? enterprise.pubKeyHex : recipient.pubKeyHex,
        params,
    };
}

async function propose(effect: 'grant_enterprise' | 'grant_hardship', amount: unknown, proposer = makeMember('Proposer')) {
    const res = await signedPost('/api/commons/decisions', grantBody(effect, amount === undefined ? undefined : { amount }), proposer);
    return { ...res, proposer };
}

function snapshot(author: string) {
    return {
        decisions: (db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as any).c as number,
        byAuthor: (db.prepare('SELECT COUNT(*) AS c FROM decisions WHERE author_pubkey = ?').get(author) as any).c as number,
        transactions: (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as any).c as number,
        pot: getCommonsBalanceExact(),
    };
}

/** A proposal the cap must refuse: 400, exactly this sentence, and nothing written. */
async function expectRefused(effect: 'grant_enterprise' | 'grant_hardship', amount: unknown, sentence: string, label: string) {
    const proposer = makeMember('Refused');
    const before = snapshot(proposer.pubKeyHex);
    const res = await propose(effect, amount, proposer);
    const after = snapshot(proposer.pubKeyHex);
    assert(res.status === 400 && res.error === sentence, `${label}: refused 400 with "${sentence}" (got ${res.status} ${JSON.stringify(res.error)})`);
    assert(after.byAuthor === 0 && after.decisions === before.decisions && after.transactions === before.transactions && after.pot === before.pot,
        `${label}: nothing written (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
}

async function expectAccepted(effect: 'grant_enterprise' | 'grant_hardship', amount: number, label: string) {
    const res = await propose(effect, amount);
    const row = db.prepare('SELECT status, params FROM decisions WHERE author_pubkey = ?').get(res.proposer.pubKeyHex) as any;
    assert(res.status === 200 && res.body?.success === true && row?.status === 'open' && JSON.parse(row.params).amount === amount,
        `${label}: accepted and stored open for ${amount} (got ${res.status} ${JSON.stringify(res.error ?? '')}, row ${JSON.stringify(row)})`);
}

function refusal(held: string, inflow: string, most: string): string {
    return `This grant is bigger than the Commons could pay: it ${held} and took in ${inflow} Beans over the last 30 days, so the most you can ask for now is ${most} Beans.`;
}

function insertTxn(opts: { from: string; to: string; amount: number; taxFee?: number; at: string; id?: string; memo?: string }) {
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(opts.id ?? `txn-${crypto.randomUUID()}`, opts.from, opts.to, opts.amount, opts.taxFee ?? 0, opts.memo ?? '', opts.at);
}

function insertDecision(opts: { id: string; author: string; effect: string; subject: string; amount: number; status: string; closesAt: string }) {
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                               opens_at, closes_at, created_at, updated_at, execution_reason)
        VALUES (?, ?, 'Before the cap', 'Proposed before grants were capped', 'pool', ?, ?, ?, 'quadratic_trade', ?,
                '2026-09-01T00:00:00.000Z', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ?)
    `).run(opts.id, opts.author, opts.effect, opts.subject, JSON.stringify({ amount: opts.amount }), opts.status, opts.closesAt,
        opts.status === 'passed_queued_for_funds' ? 'Insufficient pool funds: requires 5000, available 10.00' : null);
}

const rowOf = (id: string) => JSON.stringify(db.prepare('SELECT * FROM decisions WHERE id = ?').get(id));

async function main(): Promise<void> {
    console.log('\nA Commons grant is capped when it is proposed, over real HTTPS\n');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    assert(typeof setCapClock === 'function', 'the grant cap has a test clock (setGrantCapClockForTests)');
    const setClock = (now: (() => number) | null) => { if (setCapClock) setCapClock(now); };

    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    enterprise = makeMember('ToolLibrary', { treasury: true, balance: 7.75 });
    recipient = makeMember('Renter');
    const buyer = makeMember('Buyer');
    const seller = makeMember('Seller');

    // ── 5 (set up first). Grants from before the rule, far over any cap below ──
    const oldAuthorA = makeMember('OldAuthorA');
    const oldAuthorB = makeMember('OldAuthorB');
    insertDecision({ id: 'queued-before-cap', author: oldAuthorA.pubKeyHex, effect: 'grant_enterprise', subject: enterprise.pubKeyHex,
        amount: 5000, status: 'passed_queued_for_funds', closesAt: iso(-DAY) });
    insertDecision({ id: 'open-before-cap', author: oldAuthorB.pubKeyHex, effect: 'grant_hardship', subject: recipient.pubKeyHex,
        amount: 5000, status: 'open', closesAt: iso(5 * DAY) });
    const queuedBefore = rowOf('queued-before-cap');
    const openBefore = rowOf('open-before-cap');

    // ── The ledger the 30-day inflow is read from ──
    // Counted: a real sweep into the Commons (moveToCommons, timestamped now), a circulation-fee row 29 days old, a
    // trade's 1.5% fee 5 days old, and a row in SQLite's 'YYYY-MM-DD HH:MM:SS' form 2 days old.
    const swept = moveToCommons(enterprise.pubKeyHex, 7.75, 'Surplus swept to Commons');
    assert(!!swept && swept.to === 'COMMONS_POOL', 'a real moveToCommons wrote its row to COMMONS_POOL');
    insertTxn({ id: `demurrage_${buyer.pubKeyHex.slice(0, 16)}_1_30`, from: buyer.pubKeyHex, to: 'COMMONS_POOL', amount: 12.25,
        at: iso(-29 * DAY), memo: 'Circulation fee (demurrage, 29d)' });
    insertTxn({ from: buyer.pubKeyHex, to: seller.pubKeyHex, amount: 200, taxFee: 3, at: iso(-5 * DAY), memo: 'Trade' });
    insertTxn({ from: buyer.pubKeyHex, to: 'COMMONS_POOL', amount: 0.5, at: iso(-2 * DAY).replace('T', ' ').slice(0, 19) });
    // Not counted: 31 and 40 days old, a payment OUT of the Commons, and a row dated after now.
    insertTxn({ from: seller.pubKeyHex, to: 'COMMONS_POOL', amount: 1000, at: iso(-31 * DAY) });
    insertTxn({ from: buyer.pubKeyHex, to: seller.pubKeyHex, amount: 900, taxFee: 500, at: iso(-40 * DAY) });
    insertTxn({ from: 'COMMONS_POOL', to: enterprise.pubKeyHex, amount: 999, at: iso(-DAY), memo: 'Commons grant: earlier' });
    insertTxn({ from: seller.pubKeyHex, to: 'COMMONS_POOL', amount: 40, at: iso(DAY) });

    // ── 1. At the cap, and over it ──
    console.log('\n--- 1. At the cap, and over it ---');
    setCommonsBalance(100);
    // held 100 + inflow (7.75 + 12.25 + 3 + 0.5 = 23.50) = 123.50
    await expectRefused('grant_enterprise', 124.5, refusal('holds 100 Beans', '23.50', '123.50'), 'one Bean over the cap');
    await expectRefused('grant_enterprise', 123.51, refusal('holds 100 Beans', '23.50', '123.50'), 'one cent over the cap');
    await expectRefused('grant_hardship', 124.5, refusal('holds 100 Beans', '23.50', '123.50'), 'a hardship grant one Bean over');
    await expectAccepted('grant_enterprise', 123.5, 'a grant exactly at the cap');
    await expectAccepted('grant_hardship', 123.5, 'a hardship grant exactly at the cap');

    // ── 2. The cap moves with the balance, the inflow and the clock ──
    console.log('\n--- 2. The cap moves with the balance, the inflow and the clock ---');
    setCommonsBalance(150);
    await expectRefused('grant_enterprise', 174.5, refusal('holds 150 Beans', '23.50', '173.50'), 'with 150 held, one Bean over');
    await expectAccepted('grant_enterprise', 173.5, 'with 150 held, a grant at 173.50');

    insertTxn({ from: buyer.pubKeyHex, to: seller.pubKeyHex, amount: 166.67, taxFee: 2.5, at: iso(-60 * 60 * 1000), memo: 'Trade' });
    await expectRefused('grant_enterprise', 176.01, refusal('holds 150 Beans', '26', '176'), 'after a new 2.50 market fee, one cent over');
    await expectAccepted('grant_enterprise', 176, 'after a new 2.50 market fee, a grant at 176');

    // Two days on: the 12.25 circulation fee (29 days old) leaves the window, tomorrow's 40 enters it.
    setClock(() => now + 2 * DAY);
    await expectRefused('grant_enterprise', 204.75, refusal('holds 150 Beans', '53.75', '203.75'), 'two days on, one Bean over');
    await expectAccepted('grant_enterprise', 203.75, 'two days on, a grant at 203.75');
    // Sixty days on: nothing is inside the window, so the cap is what the Commons holds.
    setClock(() => now + 60 * DAY);
    await expectRefused('grant_enterprise', 150.01, refusal('holds 150 Beans', '0', '150'), 'sixty days on, one cent over what it holds');
    await expectAccepted('grant_enterprise', 150, 'sixty days on, a grant of exactly what it holds');

    // ── 3. A Commons in deficit, and amounts that are not amounts ──
    console.log('\n--- 3. A Commons in deficit, and amounts that are not amounts ---');
    setClock(null);
    setCommonsBalance(-5);
    await expectRefused('grant_hardship', 22, refusal('owes 5 Beans', '26', '21'), 'a Commons 5 Beans in deficit');
    await expectAccepted('grant_hardship', 21, 'a Commons 5 Beans in deficit, a grant at 21');
    setCommonsBalance(-30);
    await expectRefused('grant_hardship', 1, refusal('owes 30 Beans', '26', '0'), 'a Commons deeper in deficit than its inflow: the most is 0, never below');
    setCommonsBalance(100);
    for (const bad of ['ten', 0, -5, null, '1e999'] as unknown[]) {
        await expectRefused('grant_enterprise', bad, AMOUNT_ERROR, `amount ${JSON.stringify(bad)}`);
    }
    await expectRefused('grant_enterprise', undefined, AMOUNT_ERROR, 'no params at all');

    // ── 4. Other Decision kinds are unaffected ──
    console.log('\n--- 4. Other Decision kinds are unaffected ---');
    setCommonsBalance(0);
    setClock(() => now + 60 * DAY);
    await expectRefused('grant_enterprise', 1, refusal('holds 0 Beans', '0', '0'), 'with a cap of 0, any grant');
    const target = makeMember('Target');
    const freeze = await signedPost('/api/commons/decisions', {
        title: 'Freeze Target', description: 'Freeze their credit for a while', touches: 'member', effect: 'freeze_credit',
        subject: target.pubKeyHex,
    }, makeMember('MemberProposer'));
    assert(freeze.status === 200 && freeze.body?.success === true, `a member Decision is still proposed (${freeze.status} ${freeze.error ?? ''})`);
    const debtor = makeMember('Debtor', { treasury: true, balance: -500 });
    const writeOff = await signedPost('/api/commons/decisions', {
        title: 'Write off the debt', description: 'The enterprise closed owing 500 Beans', touches: 'pool', effect: 'write_off_deficit',
        subject: debtor.pubKeyHex,
    }, makeMember('WriteOffProposer'));
    assert(writeOff.status === 200 && writeOff.body?.success === true,
        `a write-off of a 500-Bean deficit is still proposed: it is not a grant (${writeOff.status} ${writeOff.error ?? ''})`);
    setClock(null);

    // ── 5. Grants from before the rule are untouched ──
    console.log('\n--- 5. Grants from before the rule are untouched ---');
    assert(rowOf('queued-before-cap') === queuedBefore, 'the queued 5000-Bean grant is byte-identical after every proposal above');
    assert(rowOf('open-before-cap') === openBefore, 'the open 5000-Bean grant is byte-identical after every proposal above');
    setCommonsBalance(10);
    tickDecisions();
    const waiting = db.prepare('SELECT status FROM decisions WHERE id = ?').get('queued-before-cap') as any;
    assert(waiting?.status === 'passed_queued_for_funds', `with 10 in the Commons it still waits in the queue (got ${waiting?.status})`);
    const entBefore = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(enterprise.pubKeyHex) as any).balance as number;
    setCommonsBalance(5000);
    tickDecisions();
    const paid = db.prepare('SELECT status FROM decisions WHERE id = ?').get('queued-before-cap') as any;
    const entAfter = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(enterprise.pubKeyHex) as any).balance as number;
    assert(paid?.status === 'executed' && Math.abs(entAfter - entBefore - 5000) < 1e-9 && Math.abs(getCommonsBalanceExact()) < 1e-9,
        `once the Commons holds 5000 it pays, as before (status ${paid?.status}, enterprise +${entAfter - entBefore}, Commons ${getCommonsBalanceExact()})`);
    const stillOpen = db.prepare('SELECT status FROM decisions WHERE id = ?').get('open-before-cap') as any;
    assert(stillOpen?.status === 'open', `the open grant from before the rule is still open for its vote (got ${stillOpen?.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A COMMONS GRANT IS CAPPED WHEN IT IS PROPOSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
