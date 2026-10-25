/**
 * A pledge to a project past its deadline: refused over real HTTP before any money moves.
 *
 * Verifies:
 *  1. A pledge before the deadline is taken (200 OK), debits the backer, credits escrow, advances current_amount.
 *  2. A pledge to a project whose deadline_at has passed is refused BEFORE any money moves:
 *     - POST /api/treasury/:treasury/pledge returns 409 { code: 'project_closed', error: "This project's deadline has passed: it takes no more pledges." }
 *     - POST /api/crowdfund/projects/:id/pledge returns 409 { code: 'project_closed', error: "This project's deadline has passed: it takes no more pledges." }
 *  3. After the refusal: backer balance, project current_amount, accounts sum, and transaction count are completely unchanged.
 *  4. A LedgerAudit-style check (runLedgerAudit) passes with ok: true and 0 drift.
 *  5. Actor is taken strictly from auth (never the body).
 *  6. A project with no deadline (or an open deadline) continues to accept pledges.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-pledge-deadline-http
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, payFromCommons } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { runLedgerAudit } from './engine/audit.js';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 24 * 60 * 60 * 1000;
const REFUSAL_TEXT = "This project's deadline has passed: it takes no more pledges.";
const REFUSAL_CODE = 'project_closed';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
let made = 0;

function makeMember(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(pubKeyHex, `Member${++made}`);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
    return { pubKeyHex, privateKey };
}

async function signedPost(path: string, body: unknown, id: Id) {
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `POST\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json, error: json?.error as string | undefined };
}

async function main(): Promise<void> {
    console.log('\nPledge deadline enforcement over real HTTP\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const creator = makeMember();
    const backer = makeMember();

    // Fund backer with 50 Beans from Commons
    payFromCommons(backer.pubKeyHex, 50, 'Initial beans for backer', { allowDeficit: true });
    const backerInitialBal = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(backer.pubKeyHex) as any).balance;
    assert(backerInitialBal === 50, `backer funded with 50 beans (got ${backerInitialBal})`);

    // ── 1. Create bounded enterprise with a future deadline ──────────────────────────────────
    const futureDeadline = new Date(Date.now() + 5 * DAY).toISOString();
    const created = await signedPost('/api/enterprise', {
        name: 'Community Greenhouse',
        purpose: 'Grow winter greens',
        lifecycle: 'bounded',
        goalAmount: 100,
        deadlineAt: futureDeadline,
    }, creator);
    assert(created.status === 200, `project created with future deadline (status ${created.status})`);
    const projectId = created.body.publicKey;

    // ── 2. Pledge BEFORE deadline is taken ──────────────────────────────────────────────────
    const pledgeBefore = await signedPost(`/api/treasury/${projectId}/pledge`, {
        amount: 10,
        memo: 'Early pledge',
    }, backer);
    assert(pledgeBefore.status === 200 && pledgeBefore.body?.success === true,
        `pledge before deadline is taken (got ${pledgeBefore.status})`);

    const backerBalAfterFirst = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(backer.pubKeyHex) as any).balance;
    assert(backerBalAfterFirst === 40, `backer debited by 10 (got ${backerBalAfterFirst})`);
    const projectRaised = (db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(projectId) as any).current_amount;
    assert(projectRaised === 10, `project current_amount is 10 (got ${projectRaised})`);

    const auditFirst = runLedgerAudit();
    assert(auditFirst.ok && Math.abs(auditFirst.drift) < 0.0001, 'ledger audit holds after valid pledge');

    // ── 3. Expire the deadline ─────────────────────────────────────────────────────────────
    const twoDaysAgo = new Date(Date.now() - 2 * DAY).toISOString();
    db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(twoDaysAgo, projectId);
    db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(twoDaysAgo, projectId);

    // Snapshot before late pledge attempt
    const backerBalBeforeLate = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(backer.pubKeyHex) as any).balance;
    const projectBeforeLate = (db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(projectId) as any).current_amount;
    const accountsSumBeforeLate = (db.prepare('SELECT SUM(balance) as s FROM accounts').get() as any).s;
    const txCountBeforeLate = (db.prepare('SELECT COUNT(*) as n FROM transactions').get() as any).n;
    const auditBeforeLate = runLedgerAudit();
    assert(auditBeforeLate.ok, 'audit holds before late pledge attempts');

    // ── 4. Pledge AFTER deadline refused: treasury route ───────────────────────────────────
    const pledgeLateTreasury = await signedPost(`/api/treasury/${projectId}/pledge`, {
        amount: 10,
        memo: 'Late pledge to treasury',
    }, backer);
    assert(pledgeLateTreasury.status === 409,
        `treasury pledge after deadline refused with 409 (got ${pledgeLateTreasury.status})`);
    assert(pledgeLateTreasury.body?.code === REFUSAL_CODE,
        `refusal code is ${REFUSAL_CODE} (got ${pledgeLateTreasury.body?.code})`);
    assert(pledgeLateTreasury.body?.error === REFUSAL_TEXT,
        `refusal text matches (got "${pledgeLateTreasury.body?.error}")`);

    // ── 5. Pledge AFTER deadline refused: crowdfund route ──────────────────────────────────
    const pledgeLateCrowdfund = await signedPost(`/api/crowdfund/projects/${projectId}/pledge`, {
        fromPubkey: backer.pubKeyHex,
        amount: 10,
        memo: 'Late pledge to crowdfund',
    }, backer);
    assert(pledgeLateCrowdfund.status === 409,
        `crowdfund pledge after deadline refused with 409 (got ${pledgeLateCrowdfund.status})`);
    assert(pledgeLateCrowdfund.body?.code === REFUSAL_CODE,
        `crowdfund refusal code is ${REFUSAL_CODE} (got ${pledgeLateCrowdfund.body?.code})`);
    assert(pledgeLateCrowdfund.body?.error === REFUSAL_TEXT,
        `crowdfund refusal text matches (got "${pledgeLateCrowdfund.body?.error}")`);

    // ── 6. Balances and project total unchanged (LedgerAudit check) ─────────────────────────
    const backerBalAfterLate = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(backer.pubKeyHex) as any).balance;
    assert(backerBalAfterLate === backerBalBeforeLate,
        `backer balance unchanged after refused pledges (${backerBalAfterLate} === ${backerBalBeforeLate})`);

    const projectAfterLate = (db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(projectId) as any).current_amount;
    assert(projectAfterLate === projectBeforeLate,
        `project current_amount unchanged (${projectAfterLate} === ${projectBeforeLate})`);

    const accountsSumAfterLate = (db.prepare('SELECT SUM(balance) as s FROM accounts').get() as any).s;
    assert(accountsSumAfterLate === accountsSumBeforeLate,
        `sum of accounts unchanged (${accountsSumAfterLate} === ${accountsSumBeforeLate})`);

    const txCountAfterLate = (db.prepare('SELECT COUNT(*) as n FROM transactions').get() as any).n;
    assert(txCountAfterLate === txCountBeforeLate,
        `transaction count unchanged (${txCountAfterLate} === ${txCountBeforeLate})`);

    const auditAfterLate = runLedgerAudit();
    assert(auditAfterLate.ok && Math.abs(auditAfterLate.drift) < 0.0001,
        `LedgerAudit holds with 0 drift after refused pledges (drift: ${auditAfterLate.drift})`);

    // ── 7. Actor from auth, not body ────────────────────────────────────────────────────────
    const stranger = makeMember();
    // stranger signs, but body claims backer's pubkey: signature middleware enforces identity match (403)
    const spoofAttempt = await signedPost(`/api/crowdfund/projects/${projectId}/pledge`, {
        fromPubkey: backer.pubKeyHex,
        amount: 10,
        memo: 'Spoof attempt',
    }, stranger);
    assert(spoofAttempt.status === 403,
        `identity mismatch in body refused with 403 by auth middleware (got ${spoofAttempt.status})`);

    // stranger signs with valid signature: deadline check still refuses with 409 project_closed
    const strangerPledgeClosed = await signedPost(`/api/crowdfund/projects/${projectId}/pledge`, {
        amount: 10,
        memo: 'Stranger pledge to closed project',
    }, stranger);
    assert(strangerPledgeClosed.status === 409 && strangerPledgeClosed.body?.code === REFUSAL_CODE,
        `stranger pledge to closed project refused with 409 project_closed (got ${strangerPledgeClosed.status})`);

    // ── 8. Project without deadline continues to take pledges ──────────────────────────────
    const createdNoDeadline = await signedPost('/api/enterprise', {
        name: 'Open Solar Project',
        purpose: 'Solar panels',
        lifecycle: 'bounded',
        goalAmount: 100,
        deadlineAt: '',
    }, creator);
    assert(createdNoDeadline.status === 200, `project created without deadline`);
    const noDeadlineId = createdNoDeadline.body.publicKey;

    const pledgeNoDeadline = await signedPost(`/api/treasury/${noDeadlineId}/pledge`, {
        amount: 5,
        memo: 'Pledge to open project',
    }, backer);
    assert(pledgeNoDeadline.status === 200 && pledgeNoDeadline.body?.success === true,
        `pledge to project without deadline succeeded (status ${pledgeNoDeadline.status})`);

    console.log(`\n${passed}/${run} assertions passed`);
    if (passed < run) process.exit(1);
    process.exit(0);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});
