/**
 * Writing off a stranded negative escrow from the Commons, recorded (engine/escrow-write-off.ts).
 *
 * WHY THIS SUITE EXISTS. The test node's ledger audit reads FAILED on "stranded escrows=2": `escrow_96656bea…` at -5
 * and `escrow_70003252…` at -10, each with exactly one transaction ever, an "Escrow refund for removed post" at
 * 2026-09-20T11:06:43Z, from escrows that never held anything. #1099 stops new ones. Marty decided on 2026-09-24 to
 * write them off from the Commons, recorded, through a reviewed admin action on the running node — and any
 * self-hosted node that ran the old code can carry the same state.
 *
 * THE FIXTURE IS RAW SQL, DELIBERATELY. The state being cleared up can no longer be produced through the ledger:
 * #1099 made an escrow unable to pay out more than it holds, at the core. So each legacy hole is written the way
 * the old code left it on disk — the escrow row below zero, the buyer's row credited, the one refund row — and the
 * in-memory ledger is reloaded from the rows, exactly as a node booting on that database would.
 *
 * Verifies:
 *   Part 1: holes at -5 and -10 with the Commons already in deficit at -11.68 (the test node today). Without
 *           confirmation each is refused with the Commons before and after, touching nothing. With it: both land
 *           at exactly 0, in memory and on disk; the Commons drops by exactly 15 to -26.68; SUM(balances) does not
 *           move; one Commons row per write-off, carrying the memo (write-off, reason, admin, trade id) and the
 *           admin on auth_signer; the audit reads clean. A restart then runs the hygiene sweep, which treats an
 *           exactly-0 escrow as settled and removes it; the audit stays clean, the deficit survives the restart,
 *           and a second write-off of the same escrow is still refused.
 *   Part 2: a funded Commons needs no confirmation, including one that covers the hole exactly.
 *   Part 3: refusals, each leaving the ledger untouched: a pending or requested trade, a positive balance, a zero
 *           or dust balance, non-escrow accounts, no such escrow, a missing, short or over-long reason, a non-owner
 *           actor, a standby node, memory and disk disagreeing.
 *   Part 4: HTTP through the REAL checkAdminAuth: no or wrong credentials are refused on both routes, an admin
 *           and a moderator key session are refused the write-off, an owner key session and the password work,
 *           an actor in the body is ignored, `confirmDeficit` must be literally true, the deficit refusal carries
 *           both Commons figures, and the admin log records the write-off.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-escrow-write-off.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import Koa from 'koa';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { runLedgerAudit } from './engine/audit.js';
import { listStrandedEscrows, writeOffStrandedEscrow, WRITE_OFF_REASON_MAX } from './engine/escrow-write-off.js';
import {
    initStateEngine,
    setNodeRole,
    seedGenesisMember,
    grantNodeRole,
    transfer,
    moveToCommons,
    payFromCommons,
    reconcileLedgerFromDb,
    getCommonsBalanceExact,
} from './state-engine.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { createAdminRoutes } from './routes/admin.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const PW = 'EscrowWriteOff123!';
const REASON = 'Legacy refund from an unfunded escrow (pre-#1099)';
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function sumBalances(): number {
    return (db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts`).get() as any).s as number;
}

/** Everything a refused write-off must leave exactly as it was. */
function ledgerState(): string {
    const rows = db.prepare(`SELECT public_key, balance FROM accounts ORDER BY public_key`).all();
    const txCount = (db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get() as any).c;
    const memory = (db.prepare(`SELECT public_key FROM accounts WHERE public_key LIKE 'escrow_%' ORDER BY public_key`).all() as any[])
        .map(r => [r.public_key, ledger.getAccount(r.public_key).balance]);
    return JSON.stringify({ rows, txCount, memory, commons: getCommonsBalanceExact() });
}

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { privateKey, pubKeyHex };
}
type Keypair = ReturnType<typeof makeKeypair>;

function addMember(pubkey: string, callsign: string, invitedBy: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(pubkey, callsign, new Date().toISOString(), invitedBy, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubkey);
    ledger.initializeGenesisAccount(pubkey);
}

/** Key sign-in as the app does it: challenge → signature → handshake token → session. */
function keySession(kp: Keypair): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) throw new Error(`challenge refused: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`handshake refused: ${ex.error}`);
    return ex.sessionId!;
}

/**
 * An escrow as the pre-#1099 removal refund left it: the escrow `balance` (negative for a hole), the other side of
 * that on `counterparty`'s row so the node still sums to what it did, and the one refund row. See the header for
 * why this is SQL.
 */
function seedEscrow(balance: number, counterparty: string, tradeStatus: string | null, seller: string): { escrowId: string; tradeId: string } {
    const tradeId = crypto.randomUUID();
    const escrowId = `escrow_${tradeId}`;
    db.transaction(() => {
        if (tradeStatus) {
            db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                        VALUES (?, ?, ?, ?, ?, ?, '2026-05-14T09:30:00.000Z', ?)`)
                .run(tradeId, `legacy-post-${tradeId.slice(0, 8)}`, counterparty, seller, Math.abs(balance), tradeStatus,
                    tradeStatus === 'cancelled' ? '2026-09-20T11:06:43.000Z' : null);
        }
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(escrowId, balance);
        db.prepare(`UPDATE accounts SET balance = balance - ? WHERE public_key = ?`).run(balance, counterparty);
        if (balance < 0) {
            db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, ?, ?, 0, ?, ?)`)
                .run(crypto.randomUUID(), escrowId, counterparty, -balance, 'Escrow refund for removed post', '2026-09-20T11:06:43.000Z');
        }
    })();
    reconcileLedgerFromDb();
    return { escrowId, tradeId };
}

/** Put the Commons at exactly `target`, through the ledger primitives (a deficit is a prune's write-off). */
function setCommonsTo(target: number, funder: string, sink: string): void {
    const now = getCommonsBalanceExact();
    if (target > now) {
        const need = r4(target - now);
        transfer('genesis', funder, need, 'seed the Commons funder', 'direct', true);
        assert(Boolean(moveToCommons(funder, need, 'fund the Commons for the test', { allowMemberDebit: true })), `Commons funded by ${need}`);
    } else if (target < now) {
        assert(Boolean(payFromCommons(sink, r4(now - target), 'drive the Commons into deficit for the test', { allowDeficit: true })), `Commons drawn by ${r4(now - target)}`);
    }
    assert(near(getCommonsBalanceExact(), target), `the Commons reads ${target} (${getCommonsBalanceExact()})`);
}

function escrowRow(escrowId: string): number | null {
    const row = db.prepare(`SELECT balance FROM accounts WHERE public_key = ?`).get(escrowId) as any;
    return row ? row.balance : null;
}

function commonsRows(escrowId: string): any[] {
    return db.prepare(`SELECT * FROM transactions WHERE from_pubkey = 'COMMONS_POOL' AND to_pubkey = ?`).all(escrowId) as any[];
}

async function main() {
    console.log('Testing the stranded-escrow write-off from the Commons...\n');
    initStateEngine();
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false } as any);

    const olive = makeKeypair(); // owner
    const ada = makeKeypair();   // admin, not an owner
    const mo = makeKeypair();    // moderator
    seedGenesisMember(olive.pubKeyHex, 'Olive');
    addMember(ada.pubKeyHex, 'Ada', olive.pubKeyHex);
    addMember(mo.pubKeyHex, 'Mo', olive.pubKeyHex);
    grantNodeRole(ada.pubKeyHex, 'admin', olive.pubKeyHex);
    grantNodeRole(mo.pubKeyHex, 'moderator', olive.pubKeyHex);
    const buyer1 = crypto.randomBytes(32).toString('hex');
    const buyer2 = crypto.randomBytes(32).toString('hex');
    const seller = crypto.randomBytes(32).toString('hex');
    const funder = crypto.randomBytes(32).toString('hex');
    const debtor = crypto.randomBytes(32).toString('hex');
    addMember(buyer1, 'Buyer1', olive.pubKeyHex);
    addMember(buyer2, 'Buyer2', olive.pubKeyHex);
    addMember(seller, 'Seller', olive.pubKeyHex);
    addMember(funder, 'Funder', olive.pubKeyHex);
    addMember(debtor, 'Debtor', olive.pubKeyHex);

    const startAudit = runLedgerAudit();
    assert(startAudit.ok, 'a fresh node audits clean');

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 1: the test node's two holes, with the Commons already in deficit
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 1: -5 and -10 written off, the Commons at -11.68 ──');
    setCommonsTo(-11.68, funder, debtor);
    const five = seedEscrow(-5, buyer1, 'cancelled', seller);
    const ten = seedEscrow(-10, buyer2, 'cancelled', seller);
    const sumBefore = sumBalances();

    const auditBefore = runLedgerAudit();
    assert(auditBefore.strandedEscrows === 2 && !auditBefore.ok, `the audit sees 2 stranded escrows (${auditBefore.strandedEscrows})`);
    assert(Math.abs(auditBefore.drift) < 0.0001, `with no drift (${auditBefore.drift}) — the holes were paid out, not minted from nowhere`);

    const list = listStrandedEscrows();
    assert(list.escrows.length === 2, `the list shows both (${list.escrows.length})`);
    assert(list.commonsBalance === -11.68, `the list shows the Commons now (${list.commonsBalance})`);
    const tenRow = list.escrows.find(e => e.escrowId === ten.escrowId)!;
    const fiveRow = list.escrows.find(e => e.escrowId === five.escrowId)!;
    assert(list.escrows[0].escrowId === ten.escrowId, 'the deepest hole is listed first');
    assert(tenRow.balance === -10 && tenRow.tradeId === ten.tradeId && tenRow.trade?.status === 'cancelled'
        && tenRow.trade?.createdAt === '2026-05-14T09:30:00.000Z', 'each row carries its balance and its trade id, status and date');
    assert(tenRow.transactionCount === 1 && tenRow.lastTransaction?.memo === 'Escrow refund for removed post',
        'and the one refund that dug the hole');
    assert(tenRow.writeOff.eligible && tenRow.writeOff.commonsAfter === -21.68 && tenRow.writeOff.wouldDeficit,
        `-10 alone would leave the Commons at -21.68 (${tenRow.writeOff.commonsAfter})`);
    assert(fiveRow.writeOff.eligible && fiveRow.writeOff.commonsAfter === -16.68, `-5 alone would leave it at -16.68 (${fiveRow.writeOff.commonsAfter})`);
    assert(list.commonsAfterAll === -26.68 && list.eligibleCount === 2, `both would leave it at -26.68 (${list.commonsAfterAll})`);

    // Without confirmation: refused with both figures, and nothing moves.
    {
        const before = ledgerState();
        const res = writeOffStrandedEscrow(five.escrowId, 'owner:password', REASON);
        assert(!res.ok && res.status === 409 && res.code === 'deficit_unconfirmed', `unconfirmed deficit refused (${!res.ok && res.code})`);
        assert(!res.ok && res.commonsBalance === -11.68 && res.commonsAfter === -16.68,
            `the refusal states the Commons now and after (${!res.ok && res.commonsBalance} → ${!res.ok && res.commonsAfter})`);
        assert(!res.ok && /-11\.68/.test(res.error) && /-16\.68/.test(res.error), 'and says both in words');
        const falsy = writeOffStrandedEscrow(five.escrowId, 'owner:password', REASON, { confirmDeficit: false });
        assert(!falsy.ok && falsy.code === 'deficit_unconfirmed', 'confirmDeficit: false is no confirmation');
        assert(ledgerState() === before, 'the ledger is untouched');
    }

    // With confirmation.
    const w5 = writeOffStrandedEscrow(five.escrowId, olive.pubKeyHex, REASON, { confirmDeficit: true });
    assert(w5.ok, `-5 written off (${!w5.ok ? w5.error : 'ok'})`);
    assert(ledger.getAccount(five.escrowId).balance === 0 && escrowRow(five.escrowId) === 0, 'the -5 escrow is at exactly 0, in memory and on disk');
    assert(near(getCommonsBalanceExact(), -16.68), `the Commons is at -16.68 (${getCommonsBalanceExact()})`);
    const w10 = writeOffStrandedEscrow(ten.escrowId, 'owner:password', REASON, { confirmDeficit: true });
    assert(w10.ok, `-10 written off (${!w10.ok ? w10.error : 'ok'})`);
    assert(ledger.getAccount(ten.escrowId).balance === 0 && escrowRow(ten.escrowId) === 0, 'the -10 escrow is at exactly 0, in memory and on disk');

    assert(near(getCommonsBalanceExact(), -26.68), `the Commons dropped by exactly 15, to -26.68 (${getCommonsBalanceExact()})`);
    const commonsRow = (db.prepare(`SELECT balance FROM accounts WHERE public_key = 'COMMONS_POOL'`).get() as any).balance;
    assert(near(commonsRow, -26.68), `and its persisted row agrees (${commonsRow})`);
    assert(near(sumBalances(), sumBefore), `SUM(balances) is unchanged (${sumBefore} → ${sumBalances()})`);

    for (const [hole, amount, signer, name] of [[five, 5, olive.pubKeyHex, 'Olive'], [ten, 10, 'owner:password', 'a community admin']] as const) {
        const rows = commonsRows(hole.escrowId);
        assert(rows.length === 1, `one Commons row for the ${amount} write-off (${rows.length})`);
        const r = rows[0];
        assert(r.amount === amount && r.tax_fee === 0, `for exactly ${amount} Beans, no fee`);
        assert(r.memo.includes('Stranded escrow written off from the Commons') && r.memo.includes(hole.tradeId)
            && r.memo.includes(REASON) && r.memo.includes(`by ${name}`), `the memo names the write-off, trade, reason and admin: "${r.memo}"`);
        assert(r.auth_signer === signer, `auth_signer records the admin (${r.auth_signer})`);
        assert(!r.memo.includes('owner:password') && !r.memo.includes(olive.pubKeyHex), 'and the memo never carries a key or the password marker');
    }

    const auditAfter = runLedgerAudit();
    assert(auditAfter.strandedEscrows === 0, `the audit's stranded count is 0 (${auditAfter.strandedEscrows})`);
    assert(Math.abs(auditAfter.drift) < 0.0001 && auditAfter.ok, `and it reads clean (drift ${auditAfter.drift})`);
    assert(listStrandedEscrows().escrows.length === 0, 'the list is empty');

    // Written off once, never twice.
    {
        const before = ledgerState();
        const again = writeOffStrandedEscrow(five.escrowId, 'owner:password', REASON, { confirmDeficit: true });
        assert(!again.ok && again.status === 409 && again.code === 'already_written_off' && !!again.writtenOffAt,
            `a second write-off is refused (${!again.ok && again.code})`);
        assert(ledgerState() === before, 'the ledger is untouched');
    }

    // A restart: the hygiene sweep treats an exactly-0 escrow as settled and removes it.
    initStateEngine();
    assert(escrowRow(five.escrowId) === null && escrowRow(ten.escrowId) === null, 'the boot sweep removed both zeroed escrows');
    assert(near(getCommonsBalanceExact(), -26.68), `the deficit survived the restart (${getCommonsBalanceExact()})`);
    const auditRestart = runLedgerAudit();
    assert(auditRestart.ok && auditRestart.strandedEscrows === 0 && Math.abs(auditRestart.drift) < 0.0001, 'the audit still reads clean after the restart');
    {
        const before = ledgerState();
        const gone = writeOffStrandedEscrow(ten.escrowId, 'owner:password', REASON, { confirmDeficit: true });
        assert(!gone.ok && gone.code === 'already_written_off', `after the sweep a second write-off is still "already written off" (${!gone.ok && gone.code})`);
        assert(ledgerState() === before, 'the ledger is untouched');
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 2: a funded Commons needs no confirmation
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 2: the Commons can cover it ──');
    setCommonsTo(20, funder, debtor);
    {
        const hole = seedEscrow(-7.5, buyer1, 'cancelled', seller);
        const sum = sumBalances();
        const res = writeOffStrandedEscrow(hole.escrowId, 'owner:password', REASON);
        assert(res.ok && res.commonsBefore === 20 && res.commonsAfter === 12.5, `written off with no confirmation (${res.ok ? `${res.commonsBefore} → ${res.commonsAfter}` : res.error})`);
        assert(ledger.getAccount(hole.escrowId).balance === 0 && escrowRow(hole.escrowId) === 0 && near(sumBalances(), sum), 'at exactly 0, sum unchanged');
    }
    {
        // Exactly what the Commons holds, to the last bit, so "covers it exactly" is tested rather than float noise.
        const exact = getCommonsBalanceExact();
        const hole = seedEscrow(-exact, buyer2, null, seller); // a legacy escrow whose trade row is gone
        const listed = listStrandedEscrows().escrows.find(e => e.escrowId === hole.escrowId);
        assert(!!listed && listed.trade === null && listed.writeOff.eligible && listed.writeOff.commonsAfter === 0 && !listed.writeOff.wouldDeficit,
            'an escrow with no trade row is listed, eligible, and would leave the Commons at exactly 0');
        const res = writeOffStrandedEscrow(hole.escrowId, 'owner:password', REASON);
        assert(res.ok && getCommonsBalanceExact() === 0, `a Commons that covers the hole exactly needs no confirmation, and ends at 0 (${res.ok ? getCommonsBalanceExact() : res.error})`);
    }
    assert(runLedgerAudit().ok, 'the audit reads clean');

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 3: refusals, each leaving the ledger untouched
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 3: refusals ──');
    setCommonsTo(100, funder, debtor);
    const pending = seedEscrow(-3, buyer1, 'pending', seller);
    const requested = seedEscrow(-3, buyer1, 'requested', seller);
    const positive = seedEscrow(4, buyer2, 'completed', seller);
    const zero = seedEscrow(0, buyer2, 'cancelled', seller);
    const dust = seedEscrow(-5e-7, buyer2, 'cancelled', seller);
    const hole = seedEscrow(-6, buyer1, 'cancelled', seller);
    const positiveListed = listStrandedEscrows().escrows.find(e => e.escrowId === positive.escrowId);
    assert(!!positiveListed && !positiveListed.writeOff.eligible && positiveListed.writeOff.commonsAfter === null,
        'a positive stranded escrow is listed (the audit counts it) but not eligible');
    assert(!listStrandedEscrows().escrows.some(e => e.escrowId === pending.escrowId || e.escrowId === requested.escrowId),
        'escrows of open trades are not listed as stranded');

    const refusals: { label: string; id: string; actor?: string; reason?: unknown; status: number; code: string }[] = [
        { label: 'a pending trade', id: pending.escrowId, status: 409, code: 'trade_open' },
        { label: 'a requested trade', id: requested.escrowId, status: 409, code: 'trade_open' },
        { label: 'a positive balance', id: positive.escrowId, status: 409, code: 'positive_balance' },
        { label: 'a zero balance', id: zero.escrowId, status: 409, code: 'nothing_to_write_off' },
        { label: 'a dust balance', id: dust.escrowId, status: 409, code: 'nothing_to_write_off' },
        { label: 'a member account', id: buyer1, status: 400, code: 'not_escrow' },
        { label: 'the Commons itself', id: 'COMMONS_POOL', status: 400, code: 'not_escrow' },
        { label: 'a project account', id: 'project_abc', status: 400, code: 'not_escrow' },
        { label: 'a bare escrow_ prefix', id: 'escrow_', status: 400, code: 'not_escrow' },
        { label: 'no such escrow', id: `escrow_${crypto.randomUUID()}`, status: 404, code: 'not_found' },
        { label: 'a missing reason', id: hole.escrowId, reason: undefined, status: 400, code: 'reason_required' },
        { label: 'an empty reason', id: hole.escrowId, reason: '   \n\t ', status: 400, code: 'reason_required' },
        { label: 'a reason that is not a string', id: hole.escrowId, reason: { why: REASON }, status: 400, code: 'reason_required' },
        { label: 'a too-short reason', id: hole.escrowId, reason: 'too short', status: 400, code: 'reason_required' },
        { label: 'an over-long reason', id: hole.escrowId, reason: 'x'.repeat(WRITE_OFF_REASON_MAX + 1), status: 400, code: 'reason_too_long' },
        { label: 'an admin who is not an owner', id: hole.escrowId, actor: ada.pubKeyHex, status: 403, code: 'not_owner' },
        { label: 'a moderator', id: hole.escrowId, actor: mo.pubKeyHex, status: 403, code: 'not_owner' },
        { label: 'no actor', id: hole.escrowId, actor: '', status: 403, code: 'not_owner' },
    ];
    for (const r of refusals) {
        const before = ledgerState();
        const res = writeOffStrandedEscrow(r.id, r.actor ?? 'owner:password', 'reason' in r ? r.reason : REASON, { confirmDeficit: true });
        assert(!res.ok && res.status === r.status && res.code === r.code, `${r.label}: refused ${r.status} ${r.code} (${res.ok ? 'WRITTEN OFF' : `${res.status} ${res.code}`})`);
        assert(ledgerState() === before, `${r.label}: the ledger is untouched`);
    }

    // A standby's ledger is a copy of the main server's: refused there.
    {
        setNodeRole('backup');
        const before = ledgerState();
        const res = writeOffStrandedEscrow(hole.escrowId, 'owner:password', REASON);
        setNodeRole('primary');
        assert(!res.ok && res.status === 409 && res.code === 'standby', `on a standby: refused (${!res.ok && res.code})`);
        assert(ledgerState() === before, 'the ledger is untouched');
    }
    // Memory and disk disagreeing: paying |memory| would land the row elsewhere than 0, so it is refused.
    {
        db.prepare(`UPDATE accounts SET balance = -6.5 WHERE public_key = ?`).run(hole.escrowId);
        const before = ledgerState();
        const res = writeOffStrandedEscrow(hole.escrowId, 'owner:password', REASON);
        assert(!res.ok && res.status === 409 && res.code === 'ledger_mismatch', `memory and disk disagreeing: refused (${!res.ok && res.code})`);
        assert(ledgerState() === before, 'the ledger is untouched');
        db.prepare(`UPDATE accounts SET balance = -6 WHERE public_key = ?`).run(hole.escrowId);
    }
    // Control characters in a reason are flattened before they reach the memo.
    {
        const res = writeOffStrandedEscrow(hole.escrowId, 'owner:password', 'Legacy hole\r\nFAKE LOG LINE\x1b[31m red');
        assert(res.ok, `a reason with control characters is accepted (${!res.ok ? res.error : 'ok'})`);
        const memo = commonsRows(hole.escrowId)[0].memo as string;
        // eslint-disable-next-line no-control-regex
        assert(!/[\x00-\x1F\x7F]/.test(memo) && memo.includes('Legacy hole FAKE LOG LINE'), `with them flattened: "${memo}"`);
    }
    // The positive one is the member's to settle, not the Commons': it pays back out through the ledger like any escrow.
    assert(Boolean(transfer(positive.escrowId, buyer2, 4, 'Escrow refund (test cleanup)', 'escrow', true)), 'the positive escrow is settled back to its buyer');
    assert(runLedgerAudit().ok, 'the audit reads clean after Part 3');

    // ─────────────────────────────────────────────────────────────────────────────
    // Part 4: over HTTP, through the real checkAdminAuth
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 4: HTTP through the real admin auth ──');
    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method !== 'GET') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
            const str = Buffer.concat(chunks).toString('utf8');
            try { (ctx as any).requestBody = str ? JSON.parse(str) : {}; } catch { (ctx as any).requestBody = {}; }
        }
        await next();
    });
    const deps: any = {
        checkAdminAuth,
        rateLimit: () => true,
        clampLimit: (v: unknown, d = 50) => Math.max(1, Math.min(Number(v) || d, 500)),
        clampOffset: (v: unknown) => Math.max(0, Number(v) || 0),
        enforceReadAuth: false,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        broadcast: () => { /* nobody listening */ },
    };
    const router = createAdminRoutes(deps);
    app.use(router.routes()).use(router.allowedMethods());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    async function call(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown) {
        resetAdminAuthTarpit();
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
            signal: AbortSignal.timeout(10_000),
        });
        let b: any = {};
        try { b = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, body: b };
    }

    try {
        setCommonsTo(-11.68, funder, debtor);
        const h1 = seedEscrow(-5, buyer1, 'cancelled', seller);
        const h2 = seedEscrow(-10, buyer2, 'cancelled', seller);
        const writeOffPath = (id: string) => `/api/local/admin/stranded-escrows/${encodeURIComponent(id)}/write-off`;
        const asPassword = { 'x-admin-password': PW };

        // The list.
        const listNone = await call('GET', '/api/local/admin/stranded-escrows', {});
        assert(listNone.status === 401, `list with no credentials: 401 (${listNone.status})`);
        const listWrong = await call('GET', '/api/local/admin/stranded-escrows', { 'x-admin-password': 'not-the-password' });
        assert(listWrong.status === 401, `list with the wrong password: 401 (${listWrong.status})`);
        const listed = await call('GET', '/api/local/admin/stranded-escrows', asPassword);
        assert(listed.status === 200 && listed.body.success === true, `list with the password: 200 (${listed.status})`);
        const listedIds = (listed.body.escrows ?? []).map((e: any) => e.escrowId).sort();
        assert(JSON.stringify(listedIds) === JSON.stringify([h1.escrowId, h2.escrowId].sort()) && listed.body.eligibleCount === 2
            && listed.body.commonsBalance === -11.68 && listed.body.commonsAfterAll === -26.68,
            `it lists both holes and the Commons now and after all (${listedIds.length}, ${listed.body.commonsBalance} → ${listed.body.commonsAfterAll})`);
        const listAdmin = await call('GET', '/api/local/admin/stranded-escrows', { 'x-admin-session': keySession(ada) });
        assert(listAdmin.status === 200, `an admin may read the list, as they may run the audit (${listAdmin.status})`);

        // The write-off: refused without the right credentials, the ledger untouched each time.
        const before = ledgerState();
        const cases: [string, Record<string, string>, number][] = [
            ['no credentials', {}, 401],
            ['the wrong password', { 'x-admin-password': 'not-the-password' }, 401],
            ['a forged session', { 'x-admin-session': 'not-a-real-session' }, 401],
            ['an admin who is not an owner', { 'x-admin-session': keySession(ada) }, 403],
            ['a moderator', { 'x-admin-session': keySession(mo) }, 403],
        ];
        for (const [label, headers, status] of cases) {
            const res = await call('POST', writeOffPath(h1.escrowId), headers, { reason: REASON, confirmDeficit: true });
            assert(res.status === status, `write-off with ${label}: ${status} (${res.status} ${JSON.stringify(res.body).slice(0, 90)})`);
        }
        assert(ledgerState() === before, 'none of them touched the ledger');

        // The deficit refusal over HTTP carries both figures; "true" as a string is not a confirmation.
        const unconfirmed = await call('POST', writeOffPath(h1.escrowId), asPassword, { reason: REASON });
        assert(unconfirmed.status === 409 && unconfirmed.body.code === 'deficit_unconfirmed'
            && unconfirmed.body.commonsBalance === -11.68 && unconfirmed.body.commonsAfter === -16.68,
            `unconfirmed deficit: 409 with the Commons now and after (${unconfirmed.status} ${unconfirmed.body.commonsBalance} → ${unconfirmed.body.commonsAfter})`);
        const stringly = await call('POST', writeOffPath(h1.escrowId), asPassword, { reason: REASON, confirmDeficit: 'true' });
        assert(stringly.status === 409 && stringly.body.code === 'deficit_unconfirmed', `confirmDeficit: "true" is not a confirmation (${stringly.status})`);
        const noReason = await call('POST', writeOffPath(h1.escrowId), asPassword, { confirmDeficit: true });
        assert(noReason.status === 400 && noReason.body.code === 'reason_required', `no reason: 400 (${noReason.status})`);
        assert(ledgerState() === before, 'still untouched');

        // An owner's key session works, and is the recorded admin.
        const byOwner = await call('POST', writeOffPath(h1.escrowId), { 'x-admin-session': keySession(olive) },
            { reason: REASON, confirmDeficit: true, actor: ada.pubKeyHex });
        assert(byOwner.status === 200 && byOwner.body.success === true && byOwner.body.amount === 5 && byOwner.body.commonsAfter === -16.68,
            `an owner key session writes off -5 (${byOwner.status} ${JSON.stringify(byOwner.body).slice(0, 120)})`);
        assert(commonsRows(h1.escrowId)[0]?.auth_signer === olive.pubKeyHex, 'recorded against the owner, not the actor in the body');

        // The password works too, and is recorded as the password.
        const byPassword = await call('POST', writeOffPath(h2.escrowId), asPassword, { reason: REASON, confirmDeficit: true, actor: olive.pubKeyHex });
        assert(byPassword.status === 200 && byPassword.body.amount === 10 && byPassword.body.commonsAfter === -26.68,
            `the password writes off -10 (${byPassword.status} ${JSON.stringify(byPassword.body).slice(0, 120)})`);
        assert(commonsRows(h2.escrowId)[0]?.auth_signer === 'owner:password', 'recorded as the password, whatever the body says');

        const twice = await call('POST', writeOffPath(h2.escrowId), asPassword, { reason: REASON, confirmDeficit: true });
        assert(twice.status === 409 && twice.body.code === 'already_written_off', `a second write-off over HTTP: 409 (${twice.status})`);

        const logged = db.prepare(`SELECT * FROM system_logs WHERE category = 'ADMIN' AND message LIKE 'Wrote off stranded%' ORDER BY id`).all() as any[];
        assert(logged.length === 2, `the admin log has one entry per write-off (${logged.length})`);
        const meta = JSON.parse(logged[1].metadata || '{}');
        const metaOwner = JSON.parse(logged[0].metadata || '{}');
        assert(meta.escrowId === h2.escrowId && meta.transactionId && meta.actor === 'owner:password' && meta.commonsAfter === -26.68,
            'each carrying the escrow, the ledger row, the admin and the Commons after');
        assert(metaOwner.actor === olive.pubKeyHex.substring(0, 12), `a key session is logged by its short key, which the redactor leaves readable (${metaOwner.actor})`);

        const finalAudit = runLedgerAudit();
        assert(finalAudit.ok && finalAudit.strandedEscrows === 0, `the audit reads clean at the end (stranded ${finalAudit.strandedEscrows}, drift ${finalAudit.drift})`);
    } finally {
        server.close();
    }

    console.log(`\n${passed}/${run} assertions passed`);
}

main().then(() => process.exit(0)).catch(err => {
    console.error(`\n✗ FAILED after ${passed}/${run} assertions:`, err?.message || err);
    process.exit(1);
});
