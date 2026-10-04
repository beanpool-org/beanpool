/**
 * Debts and a second chance (community modes slice 5; engine/names-debts.ts, design §4.2 and §4.5) over HTTPS, through
 * the real middleware, on a local community with the known floor's dial on:
 *
 *   1. a removal Decision carried out for a confirmed member in debt: the Commons takes the debt (as always) and an open
 *      record is written on their entry, by entry id only; every admin reads it; a member doesn't
 *   2. a confirmed member deleting their own account in debt: a record too; an unconfirmed member leaving in debt, or a
 *      confirmed one leaving with nothing owed, writes none
 *   3. confirming any key against an entry with an open debt is refused (409 `open_debt`), and nothing is written; a
 *      clean entry still confirms
 *   4. pay back: a member pays the Commons only what they hold, for the debt; an admin confirms the payment and the record is
 *      settled; a payment too small, or one used already, is refused; the entry confirms again
 *   5. work off: an admin confirms a member with a known floor of 0 and the repayment flag; Beans they receive above 0
 *      go to the Commons, exactly the surplus, and stop when the debt is cleared; the record is settled, the flag clears
 *      and the member reads why
 *   6. forgiven by a community Decision: the record stays, marked forgiven; nothing moves
 *   7. the 3-year sweep, with a moved clock: a day short keeps every record; past 3 years every one goes, with a tombstone
 *   8. a repayment's event reaches the repaying member's own sockets alone, never another member's or an unsigned one
 *   9. the sweep runs only for a live confirmation against the debt's entry: a revoked work-off ends the flag and the 0
 *      floor (the member keeps what comes in); with two admins, nothing is swept until the second agrees
 *  10. a payment settles only the debt it was made for (linked when it was paid), once: never a sweep's row, never one
 *      made for another debt or for none
 *  11. a member pays any amount to the cent (0.29, 1.13, 0.57), never a part of one (0.291); one within float noise of
 *      a cent (1.0000000001, 0.1 + 0.2) is paid, stored and linked to its debt as that whole cent
 *  12. a sale an admin's dispute ruling releases to a repaying seller is swept (transfer's after-commit hook), as a sale
 *      completed by the buyer is; half a cent above 0 sweeps nothing
 *  13. a revoked work-off puts back only the known floor it lowered: nothing for one revoked before a second admin
 *      agreed (the owner's 0, or a 0 kept after an earlier settled work-off, stands); exactly the floor the member had
 *      for a live one; an admin's floor set during the work-off (even 0) stands, logged as kept
 *  14. an invite bound to an entry (#1589) obeys the rule: one for an entry with an open debt is refused (409
 *      `open_debt`), and none is written; one made (or an offline ticket signed) while the entry was clean and redeemed
 *      after a debt opened makes its joiner a member, unconfirmed (outcome `open_debt`); once the debt is settled, a
 *      new one confirms its joiner
 *   Every step: conservation, the whole node sums to what it summed to before
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-names-debts-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'NamesDebts123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, createPost, completePostTransaction, getCommonsBalanceExact, acceptPost, resolveEscrowDispute, sweepRepayment } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { createDecision, executeDecision, tickDecisions } from './decisions-engine.js';
import { grantNodeRole } from './engine/node-roles.js';
import { sweepExpiredDebts, DEBT_RECORD_KEPT_MS } from './engine/names-debts.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { buildInviteTicket } from '@beanpool/core';
import WebSocket from 'ws';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans = 0): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

/** The names list as the admins' phones left it: one key, made by Ada, and sealed entries under it (fixture rows). */
const KEY_ID = hex(32);
function makeEntry(): string {
    const id = hex(16);
    db.prepare('INSERT INTO names_entries (id, ciphertext, key_id, created_by) VALUES (?, ?, ?, ?)').run(id, 'sealed:' + hex(24), KEY_ID, 'fixture');
    return id;
}

function confirmFixture(member: Id, entryId: string, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(hex(16), member.pk, entryId, by.pk);
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = hex(16);
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

type Sock = { ws: WebSocket; events: any[] };
/** A member's signed /ws socket (test-blocks-on-beans.ts socket), or an unsigned one for `null`. */
function socket(id: Id | null): Promise<Sock> {
    let url = `${BASE.replace('https', 'wss')}/ws`;
    if (id) {
        const ts = Date.now();
        const nonce = hex(16);
        const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
        url += `?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = () => new Promise((r) => setTimeout(r, 400));

/** The whole node as one number (test-commons-conservation.ts nodeTotal): every account but the pot's shadow, plus the pot. */
const nodeTotal = () => r2((db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t + getCommonsBalanceExact());
const balanceRow = (who: Id) => r2((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(who.pk) as { balance: number } | undefined)?.balance ?? 0);
const debtsOf = (entryId: string) => db.prepare('SELECT * FROM names_debts WHERE entry_id = ? ORDER BY removed_at').all(entryId) as any[];

async function main(): Promise<void> {
    console.log('Debts and a second chance over HTTPS\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    db.prepare(`INSERT INTO names_generations (id, n, parent_id, maker, drops, statement, signature) VALUES (?, 1, NULL, ?, '', 'fixture', 'fixture')`).run(KEY_ID, ada.pk);
    const on = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(on.status === 200 && on.body?.confirmation === true, `setup: the owner turns the known floor's dial on (${show(on)})`);

    const sam = makeMember('Sam', 50);
    /** A member with earned standing, as one who has traded has, so they may propose a Decision (one open at a time each). */
    let proposers = 0;
    const proposer = (): Id => {
        const m = makeMember(`Proposer${++proposers}`, 0);
        db.prepare('UPDATE members SET earned_credit = 50 WHERE public_key = ?').run(m.pk);
        return m;
    };
    const shop = (who: Id, beans: number) => createPost('offer', 'produce', `Sam's ${beans}-Bean basket for ${who.name}`, 'Veg', beans, 'fixed', sam.pk)!.id;
    const buy = async (who: Id, beans: number) => call('POST', who, '/api/marketplace/posts/accept', { postId: shop(who, beans), buyerPublicKey: who.pk });
    const debtor = async (name: string, beans: number, entry: string | null): Promise<Id> => {
        const m = makeMember(name);
        createPost('offer', 'produce', `${name} mends things`, 'Repairs', 20, 'fixed', m.pk);
        if (entry) confirmFixture(m, entry, ada);
        const bought = await buy(m, beans);
        if (bought.body?.transaction?.id) completePostTransaction(bought.body.transaction.id, m.pk);
        assert(bought.status === 200 && balanceRow(m) === -beans, `setup: ${name} spends to -${beans} on the known floor (${show(bought)}, ${balanceRow(m)})`);
        return m;
    };

    // ── 1. a removal Decision ──────────────────────────────────────────────────────────────────
    console.log('── 1. a removal Decision ──');
    const robEntry = makeEntry();
    const rob = await debtor('Rob', 300, robEntry);
    const total = nodeTotal();
    const commonsBefore = getCommonsBalanceExact();
    const removal = createDecision({ authorPubkey: proposer().pk, title: 'Remove Rob', description: 'Rob left owing and went quiet', touches: 'member', effect: 'remove_member', subject: rob.pk });
    executeDecision(removal.id);
    tickDecisions(Date.now() + 8 * DAY);
    const robStatus = (db.prepare('SELECT status FROM members WHERE public_key = ?').get(rob.pk) as any)?.status;
    const robDebt = debtsOf(robEntry);
    assert(robStatus === 'pruned', `setup: the removal is carried out after its grace (${robStatus})`);
    assert(robDebt.length === 1 && robDebt[0].amount === 300 && robDebt[0].status === 'open' && robDebt[0].reason === 'removed',
        `an open record of 300 Beans is written on Rob's entry (${JSON.stringify(robDebt)})`);
    assert(!JSON.stringify(robDebt).includes(rob.pk) && !JSON.stringify(robDebt).includes('Rob'), 'and it names the entry only: no key, no name');
    assert(r2(getCommonsBalanceExact()) === r2(commonsBefore - 300), `the Commons took the 300 Beans, as always (${commonsBefore} → ${getCommonsBalanceExact()})`);
    assert(nodeTotal() === total, `every Bean is still counted (${total} → ${nodeTotal()})`);
    const adaReads = await call('GET', ada, '/api/names/debts');
    assert(adaReads.status === 200 && adaReads.body?.debts?.some((d: any) => d.entry_id === robEntry && d.amount === 300), `an admin reads the record (${show(adaReads)})`);
    const samReads = await call('GET', sam, '/api/names/debts');
    assert(samReads.status === 403, `a member doesn't (${show(samReads)})`);

    // ── 2. deleting an account in debt ─────────────────────────────────────────────────────────
    console.log('── 2. deleting an account in debt ──');
    const deeEntry = makeEntry();
    const dee = await debtor('Dee', 200, deeEntry);
    const del = await call('POST', dee, '/api/member/purge', { action: 'purge_account' });
    const deeDebt = debtsOf(deeEntry);
    assert(del.status === 200 && deeDebt.length === 1 && deeDebt[0].amount === 200 && deeDebt[0].reason === 'account_deleted' && deeDebt[0].status === 'open',
        `Dee deletes her account at -200: an open record of 200 Beans (${show(del)}; ${JSON.stringify(deeDebt)})`);
    const una = makeMember('Una');
    createPost('offer', 'produce', 'Una bakes', 'Bread', 10, 'fixed', una.pk);
    const before = (db.prepare('SELECT COUNT(*) n FROM names_debts').get() as any).n;
    const unaDel = await call('POST', una, '/api/member/purge', { action: 'purge_account' });
    const zoeEntry = makeEntry();
    const zoe = makeMember('Zoe', 5);
    confirmFixture(zoe, zoeEntry, ada);
    const zoeDel = await call('POST', zoe, '/api/member/purge', { action: 'purge_account' });
    const after = (db.prepare('SELECT COUNT(*) n FROM names_debts').get() as any).n;
    assert(unaDel.status === 200 && zoeDel.status === 200 && after === before, `an unconfirmed member leaving, or a confirmed one owing nothing, writes no record (${before} → ${after})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 3. confirming against an entry with an open debt ───────────────────────────────────────
    console.log('── 3. the rule ──');
    const rob2 = makeMember('Rob again');
    const refused = await call('POST', ada, '/api/names/confirmations', { memberPubkey: rob2.pk, entryId: robEntry });
    assert(refused.status === 409 && refused.body?.code === 'open_debt' && refused.body?.debtId === robDebt[0].id && /300 Beans/.test(refused.body?.error ?? ''),
        `confirming a new key against Rob's entry is refused, saying why (${show(refused)})`);
    assert(!db.prepare('SELECT 1 FROM confirmations WHERE member_pubkey = ?').get(rob2.pk), 'and no confirmation is written');
    const clean = makeEntry();
    const fine = await call('POST', ada, '/api/names/confirmations', { memberPubkey: makeMember('Newcomer').pk, entryId: clean });
    assert(fine.status === 201, `a clean entry still confirms (${show(fine)})`);

    // ── 4. pay back ────────────────────────────────────────────────────────────────────────────
    console.log('── 4. pay back ──');
    transfer('genesis', rob2.pk, 250, 'Rob again earns', 'direct', true);
    const tooMuch = await call('POST', rob2, '/api/commons/pay', { amount: 251 });
    assert(tooMuch.status === 409 && balanceRow(rob2) === 250, `a member pays the Commons only what they hold (${show(tooMuch)})`);
    const part = await call('POST', rob2, '/api/commons/pay', { amount: 250, debtId: robDebt[0].id });
    assert(part.status === 200 && balanceRow(rob2) === 0 && typeof part.body?.transactionId === 'string', `Rob pays 250 Beans to the Commons (${show(part)})`);
    const short = await call('POST', ada, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: part.body?.transactionId });
    assert(short.status === 409 && short.body?.code === 'too_little' && debtsOf(robEntry)[0].status === 'open', `250 Beans don't settle 300 (${show(short)})`);
    transfer('genesis', rob2.pk, 300, 'Rob again earns more', 'direct', true);
    const whole = await call('POST', rob2, '/api/commons/pay', { amount: 300, debtId: robDebt[0].id });
    const memberSettles = await call('POST', rob2, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: whole.body?.transactionId });
    assert(memberSettles.status === 403, `a member can't mark it settled (${show(memberSettles)})`);
    const settled = await call('POST', ada, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: whole.body?.transactionId, note: 'paid in full' });
    assert(settled.status === 200 && settled.body?.status === 'settled' && settled.body?.settled_how === 'pay_back' && settled.body?.settle_ref === whole.body?.transactionId,
        `Ada links the 300-Bean payment: settled, with the payment named (${show(settled)})`);
    const again = await call('POST', ada, `/api/names/debts/${deeDebt[0].id}/settle`, { transactionId: whole.body?.transactionId });
    assert(again.status === 409 && again.body?.code === 'not_for_this_debt' && debtsOf(deeEntry)[0].status === 'open', `the same payment settles nothing else (${show(again)})`);
    const nowConfirms = await call('POST', ada, '/api/names/confirmations', { memberPubkey: rob2.pk, entryId: robEntry });
    assert(nowConfirms.status === 201, `and Rob's entry confirms his new key now (${show(nowConfirms)})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 5. work off ────────────────────────────────────────────────────────────────────────────
    console.log('── 5. work off ──');
    const dee2 = makeMember('Dee again');
    const notAdmin = await call('POST', sam, `/api/names/debts/${deeDebt[0].id}/work-off`, { memberPubkey: dee2.pk });
    assert(notAdmin.status === 403, `a member can't start a work-off (${show(notAdmin)})`);
    const workOff = await call('POST', ada, `/api/names/debts/${deeDebt[0].id}/work-off`, { memberPubkey: dee2.pk });
    const flag = debtsOf(deeEntry)[0];
    const exc = db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(dee2.pk) as any;
    assert(workOff.status === 201 && flag.repaying_pubkey === dee2.pk && exc?.amount === 0 && exc?.frozen === 0,
        `Ada confirms Dee's new key to work it off: the repayment flag, and a known floor of 0 (${show(workOff)}; ${JSON.stringify(exc)})`);
    const why = await call('GET', dee2, '/api/commons/repayment');
    assert(why.status === 200 && why.body?.repayment?.amount === 200 && why.body?.repayment?.left === 200, `Dee reads why her Beans go to the Commons (${show(why)})`);
    const commonsAtStart = getCommonsBalanceExact();
    transfer('genesis', dee2.pk, 120, 'Dee mends a fence', 'direct', true);
    assert(balanceRow(dee2) === 0 && debtsOf(deeEntry)[0].repaid === 120 && debtsOf(deeEntry)[0].status === 'open',
        `120 Beans in: all 120 go to the Commons, 80 left (${balanceRow(dee2)}, ${JSON.stringify(debtsOf(deeEntry)[0])})`);
    const gate = createPost('offer', 'produce', 'Dee mends a gate', 'Repairs', 100, 'fixed', dee2.pk)!;
    const gateSale = await call('POST', sam, '/api/marketplace/posts/accept', { postId: gate.id, buyerPublicKey: sam.pk });
    completePostTransaction(gateSale.body?.transaction?.id, sam.pk);
    const done = debtsOf(deeEntry)[0];
    assert(balanceRow(dee2) === 18.5 && done.repaid === 200 && done.status === 'settled' && done.settled_how === 'work_off',
        `a 100-Bean sale through escrow: exactly the 80 left goes, Dee keeps the other 18.5 (after the 1.5 fee), and the record is settled (${balanceRow(dee2)}, ${JSON.stringify(done)})`);
    const repaidRows = r2((db.prepare(`SELECT COALESCE(SUM(amount), 0) t FROM transactions WHERE from_pubkey = ? AND to_pubkey = 'COMMONS_POOL' AND memo = 'Working off a debt to the Commons'`).get(dee2.pk) as any).t);
    assert(repaidRows === 200 && r2(getCommonsBalanceExact() - commonsAtStart) === 201.5, `the Commons got exactly 200 of repayment, plus the sale's 1.5 fee (${repaidRows}, ${r2(getCommonsBalanceExact() - commonsAtStart)})`);
    transfer('genesis', dee2.pk, 30, 'Dee mends a shed', 'direct', true);
    assert(balanceRow(dee2) === 48.5, `and it stops there: the next 30 stay hers (${balanceRow(dee2)})`);
    const cleared = await call('GET', dee2, '/api/commons/repayment');
    assert(cleared.status === 200 && cleared.body?.repayment === null, `the flag cleared (${show(cleared)})`);
    assert(nodeTotal() === total, `every Bean is still counted, the seeding from genesis too (${total} → ${nodeTotal()})`);

    // ── 6. forgiven by a community Decision ────────────────────────────────────────────────────
    console.log('── 6. forgiven ──');
    const kyEntry = makeEntry();
    const ky = await debtor('Ky', 150, kyEntry);
    const kyRemoval = createDecision({ authorPubkey: proposer().pk, title: 'Remove Ky', description: 'Ky left the community owing', touches: 'member', effect: 'remove_member', subject: ky.pk });
    executeDecision(kyRemoval.id);
    tickDecisions(Date.now() + 8 * DAY);
    const kyDebt = debtsOf(kyEntry)[0];
    assert(kyDebt?.status === 'open' && kyDebt.amount === 150, `setup: Ky's record is open (${JSON.stringify(kyDebt)})`);
    let badSubject = '';
    try { createDecision({ authorPubkey: proposer().pk, title: 'Forgive', description: 'Forgive a settled one', touches: 'pool', effect: 'forgive_debt', subject: robDebt[0].id }); } catch (e: any) { badSubject = e.message; }
    assert(/open debt/.test(badSubject), `a Decision can't forgive a settled debt (${badSubject})`);
    const totalBefore = nodeTotal();
    const forgive = createDecision({ authorPubkey: proposer().pk, title: 'Forgive Ky', description: 'Ky had a hard year', touches: 'pool', effect: 'forgive_debt', subject: kyDebt.id });
    const ran = executeDecision(forgive.id);
    const kyAfter = debtsOf(kyEntry)[0];
    assert(ran.success && kyAfter.status === 'forgiven' && kyAfter.settled_how === 'forgiven' && kyAfter.settle_ref === forgive.id && kyAfter.amount === 150,
        `the Decision forgives it: the record stays, marked forgiven, naming the Decision (${JSON.stringify(ran)}; ${JSON.stringify(kyAfter)})`);
    assert(nodeTotal() === totalBefore, `nothing moved (${totalBefore} → ${nodeTotal()})`);
    const kyConfirms = await call('POST', ada, '/api/names/confirmations', { memberPubkey: makeMember('Ky again').pk, entryId: kyEntry });
    assert(kyConfirms.status === 201, `and Ky's entry confirms a new key (${show(kyConfirms)})`);

    // ── 8. a repayment is the member's own business ────────────────────────────────────────────
    console.log('── 8. a repayment reaches the member alone ──');
    const vicEntry = makeEntry();
    const vicOld = await debtor('Vic', 300, vicEntry);
    await call('POST', vicOld, '/api/member/purge', { action: 'purge_account' });
    const vicDebt = debtsOf(vicEntry)[0];
    const vic = makeMember('Vic again');
    const vicWork = await call('POST', ada, `/api/names/debts/${vicDebt?.id}/work-off`, { memberPubkey: vic.pk });
    assert(vicDebt?.status === 'open' && vicWork.status === 201, `setup: Vic's new key works off a 300-Bean debt (${show(vicWork)})`);
    const samSock = await socket(sam);
    const vicSock = await socket(vic);
    const anonSock = await socket(null);
    await settle();
    transfer('genesis', vic.pk, 120, 'Vic digs a bed', 'direct', true);
    await settle();
    const heard = (s: Sock) => s.events.filter((e) => e?.type === 'debt_repaid' || JSON.stringify(e).includes('Working off a debt'));
    assert(debtsOf(vicEntry)[0].repaid === 120, `setup: 120 Beans in are swept (${JSON.stringify(debtsOf(vicEntry)[0])})`);
    assert(heard(samSock).length === 0, `another member's socket hears nothing of it (${JSON.stringify(heard(samSock))})`);
    assert(heard(anonSock).length === 0, `an unsigned socket hears nothing of it (${JSON.stringify(heard(anonSock))})`);
    assert(vicSock.events.some((e) => e?.type === 'debt_repaid' && e.amount === 120), `Vic's own socket hears it (${JSON.stringify(vicSock.events.map((e) => e?.type))})`);
    for (const s of [samSock, vicSock, anonSock]) s.ws.close();

    // ── 9. the sweep runs only for a live confirmation bound to the debt's entry ───────────────
    console.log('── 9. a revoked or unseconded work-off sweeps nothing ──');
    const wrenEntry = makeEntry();
    const wrenOld = await debtor('Wren', 160, wrenEntry);
    await call('POST', wrenOld, '/api/member/purge', { action: 'purge_account' });
    const wrenDebt = debtsOf(wrenEntry)[0];
    const wil = makeMember('Wil');
    const wrong = await call('POST', ada, `/api/names/debts/${wrenDebt?.id}/work-off`, { memberPubkey: wil.pk });
    const revoked = await call('POST', ada, `/api/names/confirmations/${wrong.body?.id}/revoke`);
    assert(wrong.status === 201 && revoked.status === 200, `setup: Ada confirms Wil against Wren's entry to work it off, then revokes it (${show(wrong)}; ${show(revoked)})`);
    transfer('genesis', wil.pk, 40, 'Wil weeds a bed', 'direct', true);
    const wilFloor = db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(wil.pk) as any;
    const wilWhy = await call('GET', wil, '/api/commons/repayment');
    assert(balanceRow(wil) === 40 && debtsOf(wrenEntry)[0].repaid === 0, `40 Beans in after the revoke: Wil keeps all 40, nothing repaid (${balanceRow(wil)}, ${JSON.stringify(debtsOf(wrenEntry)[0])})`);
    assert(debtsOf(wrenEntry)[0].repaying_pubkey === null && !wilFloor && wilWhy.body?.repayment === null,
        `the flag and the 0 floor ended with the confirmation (${JSON.stringify(wilFloor)}; ${show(wilWhy)})`);
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('names_two_admins', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'`).run();
    const bea = makeMember('Bea');
    grantNodeRole(bea.pk, 'admin', 'SYSTEM');
    db.prepare(`INSERT INTO names_shares (from_pubkey, to_pubkey, head_id, key_ids, trusts, sealed_ring, ring_iv, ring_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
                VALUES (?, ?, ?, ?, '', '', '', '', '', '', '', '', '')`).run(ada.pk, bea.pk, KEY_ID, KEY_ID);
    const wren = makeMember('Wren again');
    const right = await call('POST', ada, `/api/names/debts/${wrenDebt?.id}/work-off`, { memberPubkey: wren.pk });
    assert(right.status === 201 && right.body?.status === 'awaiting_second', `the right person can be confirmed to work it off now, awaiting a second admin (${show(right)})`);
    transfer('genesis', wren.pk, 40, 'Wren sweeps a path', 'direct', true);
    const early = db.prepare('SELECT amount FROM known_floor_exceptions WHERE member_pubkey = ?').get(wren.pk) as any;
    assert(balanceRow(wren) === 40 && debtsOf(wrenEntry)[0].repaid === 0 && !early, `before the second admin agrees, nothing is swept and no 0 floor is set (${balanceRow(wren)}, ${JSON.stringify(early)})`);
    const second = await call('POST', bea, `/api/names/confirmations/${right.body?.id}/second`);
    const live = db.prepare('SELECT amount FROM known_floor_exceptions WHERE member_pubkey = ?').get(wren.pk) as any;
    assert(second.status === 200 && live?.amount === 0, `Bea seconds it: now the 0 floor (${show(second)}; ${JSON.stringify(live)})`);
    transfer('genesis', wren.pk, 10, 'Wren sweeps another path', 'direct', true);
    assert(balanceRow(wren) === 0 && debtsOf(wrenEntry)[0].repaid === 50, `and the sweep: what she holds above 0 goes (${balanceRow(wren)}, ${JSON.stringify(debtsOf(wrenEntry)[0])})`);
    db.prepare(`UPDATE node_config SET value = 'false' WHERE key = 'names_two_admins'`).run();
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 10. a payment settles only the debt it was made for, once ──────────────────────────────
    console.log('── 10. a payment settles the one debt it was made for ──');
    const sweepTx = db.prepare(`SELECT id, amount FROM transactions WHERE from_pubkey = ? AND to_pubkey = 'COMMONS_POOL' AND memo = 'Working off a debt to the Commons'`).get(vic.pk) as { id: string; amount: number };
    const left = (e: string) => r2(debtsOf(e)[0].amount - debtsOf(e)[0].repaid);
    assert(sweepTx?.amount === 120 && sweepTx.amount >= left(wrenEntry), `setup: Vic's debt X swept 120 Beans (${JSON.stringify(sweepTx)}); Wren's debt Y has ${left(wrenEntry)} left`);
    const ySweep = await call('POST', ada, `/api/names/debts/${wrenDebt?.id}/settle`, { transactionId: sweepTx?.id });
    assert(ySweep.status === 409 && ySweep.body?.code === 'not_for_this_debt' && debtsOf(wrenEntry)[0].status === 'open',
        `X's sweep, already counted as repaid toward X, settles nothing of Y (${show(ySweep)})`);
    transfer('genesis', wil.pk, 300, 'Wil is paid for a season', 'direct', true);
    const plain = await call('POST', wil, '/api/commons/pay', { amount: 150 });
    const plainSettle = await call('POST', ada, `/api/names/debts/${wrenDebt?.id}/settle`, { transactionId: plain.body?.transactionId });
    assert(plain.status === 200 && plainSettle.status === 409 && plainSettle.body?.code === 'not_for_this_debt', `a payment made for no debt settles none (${show(plain)}; ${show(plainSettle)})`);
    const forX = await call('POST', wil, '/api/commons/pay', { amount: left(vicEntry), debtId: vicDebt.id });
    const xOnY = await call('POST', ada, `/api/names/debts/${wrenDebt?.id}/settle`, { transactionId: forX.body?.transactionId });
    assert(forX.status === 200 && xOnY.status === 409 && xOnY.body?.code === 'not_for_this_debt' && debtsOf(wrenEntry)[0].status === 'open',
        `a payment made for X doesn't settle Y (${show(forX)}; ${show(xOnY)})`);
    const xSettles = await call('POST', ada, `/api/names/debts/${vicDebt.id}/settle`, { transactionId: forX.body?.transactionId });
    assert(xSettles.status === 200 && xSettles.body?.settled_how === 'pay_back', `it settles X (${show(xSettles)})`);
    const settledDebt = await call('POST', wil, '/api/commons/pay', { amount: 1, debtId: vicDebt.id });
    const noDebt = await call('POST', wil, '/api/commons/pay', { amount: 1, debtId: 'zz' });
    assert(settledDebt.status === 409 && noDebt.status === 400, `a payment names an open debt or none (${show(settledDebt)}; ${show(noDebt)})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 11. paying back to the cent ────────────────────────────────────────────────────────────
    console.log('── 11. any amount to the cent ──');
    const cy = makeMember('Cy', 50);
    for (const amount of [0.29, 1.13, 0.57]) {
        const paid = await call('POST', cy, '/api/commons/pay', { amount });
        assert(paid.status === 200 && paid.body?.amount === amount, `Cy pays exactly ${amount} Beans (${show(paid)})`);
    }
    const tooFine = await call('POST', cy, '/api/commons/pay', { amount: 0.291 });
    assert(tooFine.status === 400 && balanceRow(cy) === 48.01, `a part of a cent is refused (${show(tooFine)}, ${balanceRow(cy)})`);
    const exactBalance = (who: Id) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(who.pk) as { balance: number }).balance;
    for (const [amount, cents] of [[1.0000000001, 1], [0.1 + 0.2, 0.3]]) {
        const before = exactBalance(cy);
        const paid = await call('POST', cy, '/api/commons/pay', { amount });
        const stored = (db.prepare('SELECT amount FROM transactions WHERE id = ?').get(paid.body?.transactionId) as { amount: number } | undefined)?.amount;
        assert(paid.status === 200 && paid.body?.amount === cents && stored === cents && exactBalance(cy) === Math.round((before - cents) * 100) / 100,
            `${amount}, within float noise of ${cents}, is paid and stored as whole cents: ${cents} (${show(paid)}; stored ${stored}; balance ${before} → ${exactBalance(cy)})`);
    }
    const cyEntry = makeEntry();
    await call('POST', await debtor('Cy old', 5, cyEntry), '/api/member/purge', { action: 'purge_account' });
    const cyDebt = debtsOf(cyEntry)[0];
    const forDebt = await call('POST', cy, '/api/commons/pay', { amount: 2.0000000001, debtId: cyDebt.id });
    const link = db.prepare('SELECT amount FROM names_debt_payments WHERE transaction_id = ?').get(forDebt.body?.transactionId) as { amount: number } | undefined;
    assert(forDebt.status === 200 && link?.amount === 2, `a payment made for a debt is linked as whole cents too (${show(forDebt)}; ${JSON.stringify(link)})`);
    const tooFineStill = await call('POST', cy, '/api/commons/pay', { amount: 0.291 });
    assert(tooFineStill.status === 400, `0.291 is still refused (${show(tooFineStill)})`);

    // ── 12. a sale released by an admin's dispute ruling is swept too; never half a cent ─────────
    console.log('── 12. an escrow dispute released to a repaying seller; rounding ──');
    const zedEntry = makeEntry();
    const zedOld = await debtor('Zed', 50, zedEntry);
    await call('POST', zedOld, '/api/member/purge', { action: 'purge_account' });
    const zedDebt = debtsOf(zedEntry)[0];
    const zed = makeMember('Zed again');
    const zedWork = await call('POST', ada, `/api/names/debts/${zedDebt?.id}/work-off`, { memberPubkey: zed.pk });
    assert(zedWork.status === 201 && zedWork.body?.status === 'confirmed', `setup: Zed's new key works off 50 Beans (${show(zedWork)})`);
    transfer('genesis', sam.pk, 100, 'Sam is paid', 'direct', true);
    const table = createPost('offer', 'produce', 'Zed builds a table', 'Furniture', 100, 'fixed', zed.pk)!;
    const held = acceptPost(table.id, sam.pk);
    const ruled = resolveEscrowDispute(held!.id, 'release_to_seller', ada.pk, { reason: 'the table came' });
    const zedAfter = debtsOf(zedEntry)[0];
    assert(ruled?.status === 'completed' && zedAfter.repaid === 50 && zedAfter.status === 'settled' && balanceRow(zed) === 48.5,
        `released to Zed by a ruling: the 50 left go to the Commons, Zed keeps 48.5 after the fee (${ruled?.status}, ${balanceRow(zed)}, ${JSON.stringify(zedAfter)})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);
    const qiEntry = makeEntry();
    const qiOld = await debtor('Qi', 40, qiEntry);
    await call('POST', qiOld, '/api/member/purge', { action: 'purge_account' });
    const qi = makeMember('Qi again');
    await call('POST', ada, `/api/names/debts/${debtsOf(qiEntry)[0]?.id}/work-off`, { memberPubkey: qi.pk });
    db.prepare('UPDATE accounts SET balance = 0.005 WHERE public_key = ?').run(qi.pk);
    initStateEngine();
    const swept = sweepRepayment(qi.pk);
    const qiBal = (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(qi.pk) as any).balance;
    assert(swept === 0 && qiBal === 0.005 && debtsOf(qiEntry)[0].repaid === 0, `half a cent above 0 sweeps nothing: never rounded up below 0 (${swept}, ${qiBal})`);

    // ── 13. a revoked work-off puts back only the floor it lowered ─────────────────────────────
    console.log('── 13. a revoked work-off puts back only what it lowered ──');
    const floorOf = (who: Id) => db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(who.pk) as { amount: number | null; frozen: number } | undefined;
    const floorLog = (who: Id) => db.prepare('SELECT action, old_value, new_value FROM known_floor_log WHERE member_pubkey = ? ORDER BY at, rowid').all(who.pk) as { action: string; old_value: string; new_value: string }[];
    const setFloor = (who: Id, amount: number) => call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: who.pk, amount }, owner);
    const twoAdmins = (on: boolean) => db.prepare(`INSERT INTO node_config (key, value) VALUES ('names_two_admins', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(on ? 'true' : 'false');
    const leftOwing = async (name: string, beans: number): Promise<any> => {
        const entry = makeEntry();
        await call('POST', await debtor(name, beans, entry), '/api/member/purge', { action: 'purge_account' });
        return debtsOf(entry)[0];
    };
    const workOffAs = (debt: any, who: Id) => call('POST', ada, `/api/names/debts/${debt?.id}/work-off`, { memberPubkey: who.pk });
    const revoke = (c: Res) => call('POST', ada, `/api/names/confirmations/${c.body?.id}/revoke`);
    // The deciding review's sequence (R1): the floor an older work-off lowered is no business of a later one.
    const niaDebt = await leftOwing('Nia', 30);
    const nia = makeMember('Nia again');
    const nia300 = await setFloor(nia, 300);
    const niaFirst = await workOffAs(niaDebt, nia);
    const niaFirstFloor = floorOf(nia);
    const niaFirstRevoke = await revoke(niaFirst);
    assert(nia300.status === 200 && niaFirst.body?.status === 'confirmed' && niaFirstFloor?.amount === 0 && niaFirstRevoke.status === 200 && floorOf(nia)?.amount === 300,
        `setup: Nia's floor of 300 goes to 0 for a work-off and back to 300 when it is revoked (${show(niaFirst)}; ${JSON.stringify(niaFirstFloor)} → ${JSON.stringify(floorOf(nia))})`);
    const nia0 = await setFloor(nia, 0);
    twoAdmins(true);
    const niaSecond = await workOffAs(niaDebt, nia);
    const niaLogBefore = floorLog(nia).length;
    const niaSecondRevoke = await revoke(niaSecond);
    twoAdmins(false);
    assert(nia0.status === 200 && niaSecond.body?.status === 'awaiting_second' && niaSecondRevoke.status === 200,
        `setup: the owner sets Nia's floor to 0; with two admins, Ada confirms her against the debt again and revokes it before a second (${show(niaSecond)}; ${show(niaSecondRevoke)})`);
    assert(floorOf(nia)?.amount === 0 && floorOf(nia)?.frozen === 0 && floorLog(nia).length === niaLogBefore,
        `that work-off never set a floor, so its revoke puts nothing back: the owner's 0 stands, never the 300 an older work-off lowered (${JSON.stringify(floorOf(nia))}; ${JSON.stringify(floorLog(nia).slice(niaLogBefore))})`);
    // Two work-offs for one member over time (R1b): a 0 kept after a settled work-off is not the next one's to undo.
    const moFirstDebt = await leftOwing('Mo', 10);
    const mo = makeMember('Mo again');
    const moFirst = await workOffAs(moFirstDebt, mo);
    transfer('genesis', mo.pk, 10, 'Mo stacks wood', 'direct', true);
    const moFirstRevoke = await revoke(moFirst);
    assert(moFirst.body?.status === 'confirmed' && debtsOf(moFirstDebt.entry_id)[0].settled_how === 'work_off' && moFirstRevoke.status === 200 && floorOf(mo)?.amount === 0,
        `setup: Mo works a 10-Bean debt off; his floor stays 0 once it is settled, and revoking that confirmation leaves it at 0 (${JSON.stringify(debtsOf(moFirstDebt.entry_id)[0])}; ${JSON.stringify(floorOf(mo))})`);
    const moSecondDebt = await leftOwing('Mo two', 20);
    twoAdmins(true);
    const moSecond = await workOffAs(moSecondDebt, mo);
    const moLogBefore = floorLog(mo).length;
    const moSecondRevoke = await revoke(moSecond);
    twoAdmins(false);
    assert(moSecond.body?.status === 'awaiting_second' && moSecondRevoke.status === 200 && floorOf(mo)?.amount === 0 && floorLog(mo).length === moLogBefore,
        `a second work-off revoked before a second admin agreed: Mo's 0 stays, never the community's default from the first work-off (${JSON.stringify(floorOf(mo))}; ${JSON.stringify(floorLog(mo).slice(moLogBefore))})`);
    const mo200 = await setFloor(mo, 200);
    const moThird = await workOffAs(moSecondDebt, mo);
    const moThirdFloor = floorOf(mo);
    const moThirdRevoke = await revoke(moThird);
    const moLast = floorLog(mo).at(-1);
    assert(mo200.status === 200 && moThird.body?.status === 'confirmed' && moThirdFloor?.amount === 0 && moThirdRevoke.status === 200 && floorOf(mo)?.amount === 200
        && moLast?.action === 'exception_restored' && /^200 /.test(moLast.new_value),
        `the owner sets Mo's floor to 200; a live work-off lowers it to 0, and its revoke puts back exactly the 200 this work-off lowered (${JSON.stringify(moThirdFloor)} → ${JSON.stringify(floorOf(mo))}; ${JSON.stringify(moLast)})`);
    // An admin's exception set during a work-off stands: even a 0, which looks like the work-off's own.
    const otDebt = await leftOwing('Ot', 30);
    const ot = makeMember('Ot again');
    const otWork = await workOffAs(otDebt, ot);
    const otMid = await setFloor(ot, 0);
    const otRevoke = await revoke(otWork);
    const otLast = floorLog(ot).at(-1);
    assert(otWork.body?.status === 'confirmed' && otMid.status === 200 && otRevoke.status === 200 && floorOf(ot)?.amount === 0
        && otLast?.action === 'exception_kept' && /admin/.test(otLast.new_value),
        `the owner sets Ot's floor to 0 during his work-off: the revoke keeps the owner's 0, not the default he had before, and the log says why (${JSON.stringify(floorOf(ot))}; ${JSON.stringify(otLast)})`);
    const pipDebt = await leftOwing('Pip', 30);
    const pip = makeMember('Pip again');
    const pip300 = await setFloor(pip, 300);
    const pipWork = await workOffAs(pipDebt, pip);
    const pipMid = await setFloor(pip, 50);
    const pipRevoke = await revoke(pipWork);
    const pipLast = floorLog(pip).at(-1);
    assert(pip300.status === 200 && pipWork.body?.status === 'confirmed' && pipMid.status === 200 && pipRevoke.status === 200 && floorOf(pip)?.amount === 50
        && pipLast?.action === 'exception_kept' && /^50 /.test(pipLast.new_value),
        `the owner sets Pip's floor to 50 during her work-off: the revoke keeps 50, never back up to her 300, and the log says why (${JSON.stringify(floorOf(pip))}; ${JSON.stringify(pipLast)})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 14. an invite bound to an entry obeys the rule (#1589 × debts) ─────────────────────────
    console.log('── 14. an invite bound to an entry with a debt ──');
    const bindInvite = (entryId: string) => call('POST', ada, `/api/names/entries/${entryId}/invite`, {});
    const redeem = (who: Id, code: string) => call('POST', who, '/api/invite/redeem', { code, publicKey: who.pk, callsign: who.name });
    const redeemTicket = (who: Id, ticketB64: string) => call('POST', who, '/api/invite/redeem-offline', { ticketB64, publicKey: who.pk, callsign: who.name });
    const adaSigns = async (b: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(b), ada.priv));
    const invitesTo = (entryId: string) => db.prepare('SELECT used_by, names_bind_outcome FROM invite_codes WHERE names_entry_id = ? ORDER BY created_at').all(entryId) as { used_by: string | null; names_bind_outcome: string | null }[];
    const usedBy = (who: Id) => db.prepare('SELECT names_entry_id, names_bind_outcome FROM invite_codes WHERE used_by = ?').get(who.pk) as { names_entry_id: string | null; names_bind_outcome: string | null } | undefined;
    const liveEntryOf = (who: Id) => (db.prepare('SELECT entry_id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(who.pk) as { entry_id: string } | undefined)?.entry_id;
    const statusOf = (who: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(who.pk) as { status: string } | undefined)?.status;
    const inviteCount = () => (db.prepare('SELECT COUNT(*) n FROM invite_codes').get() as any).n as number;

    // (a) Made for an entry with an open debt: refused, as confirmMember refuses, and nothing is written.
    const ivyDebt = await leftOwing('Ivy', 40);
    const invitesBefore = inviteCount();
    const ivyInvite = await bindInvite(ivyDebt?.entry_id);
    assert(ivyDebt?.status === 'open' && ivyInvite.status === 409 && ivyInvite.body?.code === 'open_debt' && ivyInvite.body?.debtId === ivyDebt.id && /40 Beans/.test(ivyInvite.body?.error ?? ''),
        `an invite bound to an entry with an open debt is refused, saying why (${show(ivyInvite)})`);
    assert(inviteCount() === invitesBefore && invitesTo(ivyDebt.entry_id).length === 0, 'and no invite is written');

    // (b) Made while the entry was clean; its person then left owing. The joiner is a member, unconfirmed, never stranded.
    const jonEntry = makeEntry();
    const jonInvite = await bindInvite(jonEntry);
    assert(jonInvite.status === 201 && /^INV-/.test(jonInvite.body?.invite?.code ?? ''), `setup: Ada makes an invite bound to a clean entry (${show(jonInvite)})`);
    await call('POST', await debtor('Jon', 60, jonEntry), '/api/member/purge', { action: 'purge_account' });
    const jonDebt = debtsOf(jonEntry)[0];
    assert(jonDebt?.status === 'open' && jonDebt.amount === 60, `setup: then Jon, confirmed against it, deletes his account at -60 (${JSON.stringify(jonDebt)})`);
    const jon2 = keypair('Jon again');
    const jonJoins = await redeem(jon2, jonInvite.body?.invite?.code);
    assert(jonJoins.status === 200 && jonJoins.body?.success === true && statusOf(jon2) === 'active', `the invite still makes its joiner an active member (${show(jonJoins)}, ${statusOf(jon2)})`);
    assert(!liveEntryOf(jon2) && invitesTo(jonEntry)[0]?.used_by === jon2.pk && invitesTo(jonEntry)[0]?.names_bind_outcome === 'open_debt',
        `but doesn't confirm them, and the invite says why (${JSON.stringify(invitesTo(jonEntry))})`);
    assert(debtsOf(jonEntry)[0].status === 'open' && debtsOf(jonEntry)[0].repaying_pubkey === null, 'the debt stays open, and nobody is working it off');

    // (c) An offline ticket bound to the entry, signed while it was clean, redeemed after a debt opened: the same.
    const kitEntry = makeEntry();
    const kitTicket = await buildInviteTicket(BASE, ada.pk, adaSigns, { namesEntryId: kitEntry });
    await call('POST', await debtor('Kit', 70, kitEntry), '/api/member/purge', { action: 'purge_account' });
    const kitDebt = debtsOf(kitEntry)[0];
    assert(kitDebt?.status === 'open' && kitDebt.amount === 70, `setup: Ada signs a ticket bound to a clean entry; then Kit, confirmed against it, deletes her account at -70 (${JSON.stringify(kitDebt)})`);
    const kit2 = keypair('Kit again');
    const kitJoins = await redeemTicket(kit2, kitTicket);
    assert(kitJoins.status === 200 && kitJoins.body?.success === true && statusOf(kit2) === 'active', `the ticket still makes its joiner an active member (${show(kitJoins)}, ${statusOf(kit2)})`);
    assert(!liveEntryOf(kit2) && usedBy(kit2)?.names_entry_id === kitEntry && usedBy(kit2)?.names_bind_outcome === 'open_debt',
        `but doesn't confirm them, and the ticket's row says why (${JSON.stringify(usedBy(kit2))})`);

    // (d) Once the debt is settled, a bound invite (or ticket) for the entry is made and confirms its joiner.
    transfer('genesis', jon2.pk, 60, 'Jon again earns', 'direct', true);
    const jonPays = await call('POST', jon2, '/api/commons/pay', { amount: 60, debtId: jonDebt.id });
    const jonSettled = await call('POST', ada, `/api/names/debts/${jonDebt.id}/settle`, { transactionId: jonPays.body?.transactionId });
    assert(jonPays.status === 200 && jonSettled.status === 200 && jonSettled.body?.status === 'settled', `setup: Jon pays the 60 back and Ada settles it (${show(jonPays)}; ${show(jonSettled)})`);
    const jonAgain = await bindInvite(jonEntry);
    assert(jonAgain.status === 201 && /^INV-/.test(jonAgain.body?.invite?.code ?? ''), `a new invite bound to the entry is made now (${show(jonAgain)})`);
    const jon3 = keypair('Jon third');
    const jon3Joins = await redeem(jon3, jonAgain.body?.invite?.code);
    assert(jon3Joins.status === 200 && liveEntryOf(jon3) === jonEntry && invitesTo(jonEntry)[1]?.names_bind_outcome === 'confirmed',
        `and redeeming it confirms the joiner against the entry (${show(jon3Joins)}; ${JSON.stringify(invitesTo(jonEntry))})`);
    const kitForgive = createDecision({ authorPubkey: proposer().pk, title: 'Forgive Kit', description: 'Kit had a hard year', touches: 'pool', effect: 'forgive_debt', subject: kitDebt.id });
    assert(executeDecision(kitForgive.id).success && debtsOf(kitEntry)[0].status === 'forgiven', `setup: a Decision forgives Kit's debt (${JSON.stringify(debtsOf(kitEntry)[0])})`);
    const kit3 = keypair('Kit third');
    const kit3Joins = await redeemTicket(kit3, await buildInviteTicket(BASE, ada.pk, adaSigns, { namesEntryId: kitEntry }));
    assert(kit3Joins.status === 200 && liveEntryOf(kit3) === kitEntry && usedBy(kit3)?.names_bind_outcome === 'confirmed',
        `a new ticket bound to the entry confirms its joiner (${show(kit3Joins)}; ${JSON.stringify(usedBy(kit3))})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 15. a stale pay-back link; paying all one holds ────────────────────────────────────────
    console.log('── 15. a stale pay-back link meets what is left; all one holds, to the cent ──');
    const louEntry = makeEntry();
    const louOld = await debtor('Lou', 300, louEntry);
    await call('POST', louOld, '/api/member/purge', { action: 'purge_account' });
    const louDebt = debtsOf(louEntry)[0];
    const lou = makeMember('Lou again');
    const louWork = await call('POST', ada, `/api/names/debts/${louDebt?.id}/work-off`, { memberPubkey: lou.pk });
    transfer('genesis', lou.pk, 100, 'Lou digs a drain', 'direct', true);
    const louRevoke = await call('POST', ada, `/api/names/confirmations/${louWork.body?.id}/revoke`);
    transfer('genesis', lou.pk, 560, 'Lou is paid for a season', 'direct', true);
    const louWhy = await call('GET', lou, '/api/commons/repayment');
    assert(louWork.status === 201 && louRevoke.status === 200 && debtsOf(louEntry)[0].repaid === 100 && balanceRow(lou) === 560 && louWhy.body?.repayment === null,
        `setup: a 300-Bean debt shared as a link, then 100 worked off and the work-off ended; Lou holds 560 and his app can't see the debt (${JSON.stringify(debtsOf(louEntry)[0])}; ${show(louWhy)})`);
    const louCommons = getCommonsBalanceExact();
    const staleId = hex(16);
    const stale = await call('POST', lou, '/api/commons/pay', { amount: 300, debtId: louDebt.id, requestId: staleId });
    assert(stale.status === 409 && /^Only 200 Beans are left on that debt\./.test(stale.body?.error ?? '') && balanceRow(lou) === 560 && getCommonsBalanceExact() === louCommons,
        `the link's 300 is refused in plain words with the true 200 left, and nothing moves (${show(stale)}; ${balanceRow(lou)})`);
    const staleRow = db.prepare('SELECT 1 FROM money_requests WHERE payer_pubkey = ? AND request_id = ?').get(lou.pk, staleId);
    const staleAgain = await call('POST', lou, '/api/commons/pay', { amount: 300, debtId: louDebt.id, requestId: staleId });
    assert(!staleRow && staleAgain.status === 409 && staleAgain.body?.error === stale.body?.error && balanceRow(lou) === 560,
        `a refusal records nothing: the same id sent again is refused again, in the same words (${show(staleAgain)})`);
    const linkCount = () => (db.prepare('SELECT COUNT(*) n FROM names_debt_payments WHERE debt_id = ?').get(louDebt.id) as any).n as number;
    assert(linkCount() === 0, 'and no payment is linked to the debt');
    const louPays = await call('POST', lou, '/api/commons/pay', { amount: 200, debtId: louDebt.id, requestId: hex(16) });
    const louSettled = await call('POST', ada, `/api/names/debts/${louDebt.id}/settle`, { transactionId: louPays.body?.transactionId });
    assert(louPays.status === 200 && louPays.body?.left === 200 && balanceRow(lou) === 360 && louSettled.status === 200 && louSettled.body?.settled_how === 'pay_back' && debtsOf(louEntry)[0].status === 'settled',
        `200, what is left, is paid and settles the debt: Lou keeps 360 (${show(louPays)}; ${show(louSettled)})`);
    // Decay leaves fractions of a cent, and getBalance rounds: Ivy holds 4.996, shown as 5. The check before the
    // transaction tests what ledger.moveToCommons tests inside it, so 5 is refused there, in plain words.
    const ivy = makeMember('Ivy');
    db.prepare('UPDATE accounts SET balance = 4.996 WHERE public_key = ?').run(ivy.pk);
    db.prepare("UPDATE accounts SET balance = balance - 4.996 WHERE public_key = 'genesis'").run();
    initStateEngine();
    const ivyShown = await call('GET', ivy, `/api/ledger/balance/${ivy.pk}`);
    const ivyAll = await call('POST', ivy, '/api/commons/pay', { amount: 5 });
    assert(ivyAll.status === 409 && ivyAll.body?.error === 'You hold 4.99 Beans: you can pay the Commons only what you hold.',
        `holding 4.996 (shown as ${ivyShown.body?.balance}), paying 5 is refused before the transaction, saying 4.99 (${show(ivyAll)})`);
    const ivyHeld = await call('POST', ivy, '/api/commons/pay', { amount: 4.99 });
    assert(ivyHeld.status === 200 && r2(balanceRow(ivy)) === 0.01, `4.99 is paid (${show(ivyHeld)}; ${balanceRow(ivy)})`);
    assert(nodeTotal() === total, `every Bean is still counted (${nodeTotal()})`);

    // ── 7. the 3-year sweep ────────────────────────────────────────────────────────────────────
    console.log('── 7. the 3-year sweep ──');
    const count = () => (db.prepare('SELECT COUNT(*) n FROM names_debts').get() as any).n as number;
    const kept = count();
    assert(sweepExpiredDebts(Date.now() + DEBT_RECORD_KEPT_MS - DAY) === 0 && count() === kept, `a day short of 3 years, every record stays (${kept})`);
    const ids = (db.prepare('SELECT id FROM names_debts').all() as { id: string }[]).map((r) => r.id);
    const gone = sweepExpiredDebts(Date.now() + DEBT_RECORD_KEPT_MS + DAY);
    const tombs = db.prepare(`SELECT COUNT(*) n FROM tombstones WHERE table_name = 'names_debts'`).get() as any;
    assert(gone === kept && count() === 0 && tombs.n === ids.length, `past 3 years every record goes, each with a tombstone for a standby (${gone}, ${tombs.n})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
