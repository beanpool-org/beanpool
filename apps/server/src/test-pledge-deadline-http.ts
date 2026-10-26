/**
 * A pledge to a project past its deadline: refused over real HTTP before any money moves.
 *
 * A deadline is a day. The web sends UTC midnight at the start of the chosen day, the phone the chosen day at the time
 * its picker opened, and the node takes today's date (routes/project-deadline.ts). Pledges stop once that day is over:
 * from the moment the deadline badge says "Expired", a full day after the deadline's instant (core's isPastDeadline).
 *
 * Verifies:
 *  1. A pledge before the deadline is taken (200 OK), debits the backer, credits escrow, advances current_amount.
 *  2. On the end date pledges are still taken: a deadline an hour ago, and a project made with today's date exactly
 *     as the web sends it, through both doors.
 *  3. A pledge to a project whose deadline passed 25 hours ago is refused BEFORE any money moves:
 *     - POST /api/treasury/:treasury/pledge returns 409 { code: 'project_closed', error: "This project's deadline has passed: it takes no more pledges." }
 *     - POST /api/crowdfund/projects/:id/pledge returns 409 { code: 'project_closed', error: "This project's deadline has passed: it takes no more pledges." }
 *  4. After the refusal: backer balance, the project's escrow and current_amount, accounts sum, and transaction count are
 *     completely unchanged, and a LedgerAudit-style check (runLedgerAudit) passes with ok: true and 0 drift.
 *  5. Actor is taken strictly from auth (never the body).
 *  6. A project with no deadline continues to accept pledges.
 *  7. A server fault inside pledgeToProject is answered in the general words with no `code`: never the database's own
 *     (SQLITE_CONSTRAINT_TRIGGER). The deadline refusal pledgeToProject throws itself still carries project_closed.
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
import { SERVER_FAULT_TEXT } from './routes/member-error-text.js';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

const balanceOf = (key: string): number =>
    (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(key) as { balance: number } | undefined)?.balance ?? 0;
const raisedOf = (projectId: string): number =>
    (db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(projectId) as { current_amount: number } | undefined)?.current_amount ?? 0;

/** A project's deadline on both its rows: the enterprise's (members) and the crowdfund project's (projects). */
function setDeadline(projectId: string, deadline: string | null): void {
    db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(deadline, projectId);
    db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(deadline, projectId);
}

/** What a refused pledge leaves as it was: the backer's balance, the project's escrow and total, every balance, the transactions. */
function moneyNow(backer: string, projectId: string) {
    return {
        backer: balanceOf(backer),
        escrow: balanceOf(`escrow_${projectId}`),
        raised: raisedOf(projectId),
        sum: (db.prepare('SELECT SUM(balance) as s FROM accounts').get() as any).s as number,
        txs: (db.prepare('SELECT COUNT(*) as n FROM transactions').get() as any).n as number,
    };
}

function assertNothingMoved(before: ReturnType<typeof moneyNow>, after: ReturnType<typeof moneyNow>, what: string): void {
    for (const field of ['backer', 'escrow', 'raised', 'sum', 'txs'] as const) {
        assert(after[field] === before[field], `${what}: ${field} unchanged (${after[field]} === ${before[field]})`);
    }
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.0001, `${what}: LedgerAudit holds with 0 drift (drift: ${audit.drift})`);
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
    const backerInitialBal = balanceOf(backer.pubKeyHex);
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

    const backerBalAfterFirst = balanceOf(backer.pubKeyHex);
    assert(backerBalAfterFirst === 40, `backer debited by 10 (got ${backerBalAfterFirst})`);
    const projectRaised = raisedOf(projectId);
    assert(projectRaised === 10, `project current_amount is 10 (got ${projectRaised})`);

    const auditFirst = runLedgerAudit();
    assert(auditFirst.ok && Math.abs(auditFirst.drift) < 0.0001, 'ledger audit holds after valid pledge');

    // ── 3. A deadline an hour ago is still its end date: the badge says "Ends today", and pledges are taken ──────
    // The phone stores the chosen day at the time its picker opened, so on the end date its deadline is hours behind now.
    const oneHourAgo = new Date(Date.now() - HOUR).toISOString();
    setDeadline(projectId, oneHourAgo);
    for (const [door, path] of [
        ['treasury', `/api/treasury/${projectId}/pledge`],
        ['crowdfund', `/api/crowdfund/projects/${projectId}/pledge`],
    ] as const) {
        const before = moneyNow(backer.pubKeyHex, projectId);
        const onEndDate = await signedPost(path, { amount: 5, memo: `Pledge on the end date (${door})` }, backer);
        assert(onEndDate.status === 200 && onEndDate.body?.success === true,
            `${door} pledge an hour after the deadline's instant (its end date) is taken (got ${onEndDate.status} ${onEndDate.body?.code ?? ''})`);
        const after = moneyNow(backer.pubKeyHex, projectId);
        assert(before.backer - after.backer === 5 && after.raised - before.raised === 5,
            `${door} pledge on the end date moved 5 Beans from the backer to the project (backer ${before.backer} → ${after.backer}, raised ${before.raised} → ${after.raised})`);
    }

    // ── 3b. A project made with today's date, exactly as the web sends it, takes pledges ─────
    // ProjectsPage sends new Date(<the date field's day>).toISOString(): UTC midnight at the start of the day. Today's
    // UTC date, so that midnight is always behind now (a date ahead of UTC's, east of it, would be in the future).
    const creator2 = makeMember();
    const webToday = new Date(new Date().toISOString().slice(0, 10)).toISOString();
    const createdToday = await signedPost('/api/enterprise', {
        name: 'Seed Swap',
        purpose: 'Seeds for the spring',
        lifecycle: 'bounded',
        goalAmount: 100,
        deadlineAt: webToday,
    }, creator2);
    assert(createdToday.status === 200, `project created with today's date as the web sends it, ${webToday} (status ${createdToday.status} ${createdToday.error ?? ''})`);
    const todayId = createdToday.body?.publicKey as string;
    const storedToday = (db.prepare('SELECT deadline_at FROM members WHERE public_key = ?').get(todayId) as any)?.deadline_at;
    assert(storedToday === webToday, `its deadline is stored as sent (got ${storedToday})`);
    for (const [door, path] of [
        ['treasury', `/api/treasury/${todayId}/pledge`],
        ['crowdfund', `/api/crowdfund/projects/${todayId}/pledge`],
    ] as const) {
        const before = moneyNow(backer.pubKeyHex, todayId);
        const pledgeToday = await signedPost(path, { amount: 5, memo: `Pledge on the day it ends (${door})` }, backer);
        assert(pledgeToday.status === 200 && pledgeToday.body?.success === true,
            `${door} pledge to a project ending today is taken (got ${pledgeToday.status} ${pledgeToday.body?.code ?? ''})`);
        const after = moneyNow(backer.pubKeyHex, todayId);
        assert(before.backer - after.backer === 5 && after.escrow - before.escrow === 5 && after.raised - before.raised === 5,
            `${door} pledge to a project ending today moved 5 Beans into its escrow (backer ${before.backer} → ${after.backer}, escrow ${before.escrow} → ${after.escrow})`);
    }

    // ── 3c. Its end date over: the deadline's instant 25 hours ago ─────────────────────────────
    const dayAndAnHourAgo = new Date(Date.now() - DAY - HOUR).toISOString();
    setDeadline(projectId, dayAndAnHourAgo);

    // Snapshot before late pledge attempt
    const backerBalBeforeLate = balanceOf(backer.pubKeyHex);
    const escrowBeforeLate = balanceOf(`escrow_${projectId}`);
    const projectBeforeLate = raisedOf(projectId);
    const accountsSumBeforeLate = (db.prepare('SELECT SUM(balance) as s FROM accounts').get() as any).s;
    const txCountBeforeLate = (db.prepare('SELECT COUNT(*) as n FROM transactions').get() as any).n;
    const auditBeforeLate = runLedgerAudit();
    assert(auditBeforeLate.ok, 'audit holds before late pledge attempts');
    assert(escrowBeforeLate === 20, `the project's escrow holds the 20 Beans pledged so far (got ${escrowBeforeLate})`);

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

    // ── 5b. Deadline only on members table (projects.deadline_at is null) ───────────────────
    db.prepare('UPDATE projects SET deadline_at = NULL WHERE id = ?').run(projectId);
    const pledgeMemberOnly = await signedPost(`/api/crowdfund/projects/${projectId}/pledge`, {
        fromPubkey: backer.pubKeyHex,
        amount: 10,
        memo: 'Pledge when deadline only on members table',
    }, backer);
    assert(pledgeMemberOnly.status === 409 && pledgeMemberOnly.body?.code === REFUSAL_CODE,
        `crowdfund pledge refused when projects.deadline_at is null and members.deadline_at passed (got ${pledgeMemberOnly.status})`);

    // ── 6. Balances and project total unchanged (LedgerAudit check) ─────────────────────────
    const backerBalAfterLate = balanceOf(backer.pubKeyHex);
    assert(backerBalAfterLate === backerBalBeforeLate,
        `backer balance unchanged after refused pledges (${backerBalAfterLate} === ${backerBalBeforeLate})`);

    const escrowAfterLate = balanceOf(`escrow_${projectId}`);
    assert(escrowAfterLate === escrowBeforeLate,
        `project escrow unchanged (${escrowAfterLate} === ${escrowBeforeLate})`);

    const projectAfterLate = raisedOf(projectId);
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

    // ── 9. A server fault inside pledgeToProject: the general words, never the database's code ──────────────────
    // A TEMP trigger refuses the pledge's own transactions row (as the deciding review of #2500 measured it): better-sqlite3
    // throws a SqliteError with code SQLITE_CONSTRAINT_TRIGGER from inside the pledge's transaction, which rolls back.
    db.exec(`CREATE TEMP TRIGGER test_pledge_fault BEFORE INSERT ON transactions WHEN NEW.memo = 'Forced fault'
             BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END`);
    try {
        for (const [door, path] of [
            ['treasury', `/api/treasury/${noDeadlineId}/pledge`],
            ['crowdfund', `/api/crowdfund/projects/${noDeadlineId}/pledge`],
        ] as const) {
            const before = moneyNow(backer.pubKeyHex, noDeadlineId);
            const fault = await signedPost(path, { amount: 1, memo: 'Forced fault' }, backer);
            assert(fault.status === 400 && fault.body?.error === SERVER_FAULT_TEXT,
                `${door} pledge hit by a server fault answers the general words (got ${fault.status} "${fault.body?.error}")`);
            assert(fault.body !== undefined && !('code' in fault.body),
                `${door} pledge hit by a server fault answers no code (got ${JSON.stringify(fault.body)})`);
            assertNothingMoved(before, moneyNow(backer.pubKeyHex, noDeadlineId), `${door} pledge hit by a server fault`);
        }
    } finally {
        db.exec('DROP TRIGGER IF EXISTS temp.test_pledge_fault');
    }

    // ── 10. The deadline refusal pledgeToProject throws itself keeps its code through the route's catch ─────────
    // The treasury door reads the enterprise's deadline first and pledgeToProject the crowdfund project's, so with the
    // first still open and the second over only pledgeToProject refuses, and the catch answers its refusal.
    db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(futureDeadline, todayId);
    db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(dayAndAnHourAgo, todayId);
    const beforeInner = moneyNow(backer.pubKeyHex, todayId);
    const innerRefusal = await signedPost(`/api/treasury/${todayId}/pledge`, { amount: 1, memo: 'Refused inside pledgeToProject' }, backer);
    assert(innerRefusal.status === 409 && innerRefusal.body?.code === REFUSAL_CODE && innerRefusal.body?.error === REFUSAL_TEXT,
        `pledgeToProject's own deadline refusal answers 409 ${REFUSAL_CODE} with its words (got ${innerRefusal.status} ${JSON.stringify(innerRefusal.body)})`);
    assertNothingMoved(beforeInner, moneyNow(backer.pubKeyHex, todayId), "pledgeToProject's own deadline refusal");

    console.log(`\n${passed}/${run} assertions passed`);
    if (passed < run) process.exit(1);
    process.exit(0);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});
