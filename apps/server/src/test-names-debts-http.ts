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
 *   4. pay back: a member pays the Commons only what they hold; an admin links the payment and the record is settled;
 *      a payment too small, or one used already, is refused; the entry confirms again
 *   5. work off: an admin confirms a member with a known floor of 0 and the repayment flag; Beans they receive above 0
 *      go to the Commons, exactly the surplus, and stop when the debt is cleared; the record is settled, the flag clears
 *      and the member reads why
 *   6. forgiven by a community Decision: the record stays, marked forgiven; nothing moves
 *   7. the 3-year sweep, with a moved clock: a day short keeps every record; past 3 years every one goes, with a tombstone
 *   8. conservation: the whole node sums to what it summed to before every step
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
import { initStateEngine, transfer, seedGenesisMember, createPost, completePostTransaction, getCommonsBalanceExact } from './state-engine.js';
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
    const part = await call('POST', rob2, '/api/commons/pay', { amount: 250 });
    assert(part.status === 200 && balanceRow(rob2) === 0 && typeof part.body?.transactionId === 'string', `Rob pays 250 Beans to the Commons (${show(part)})`);
    const short = await call('POST', ada, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: part.body?.transactionId });
    assert(short.status === 409 && short.body?.code === 'too_little' && debtsOf(robEntry)[0].status === 'open', `250 Beans don't settle 300 (${show(short)})`);
    transfer('genesis', rob2.pk, 300, 'Rob again earns more', 'direct', true);
    const whole = await call('POST', rob2, '/api/commons/pay', { amount: 300 });
    const memberSettles = await call('POST', rob2, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: whole.body?.transactionId });
    assert(memberSettles.status === 403, `a member can't mark it settled (${show(memberSettles)})`);
    const settled = await call('POST', ada, `/api/names/debts/${robDebt[0].id}/settle`, { transactionId: whole.body?.transactionId, note: 'paid in full' });
    assert(settled.status === 200 && settled.body?.status === 'settled' && settled.body?.settled_how === 'pay_back' && settled.body?.settle_ref === whole.body?.transactionId,
        `Ada links the 300-Bean payment: settled, with the payment named (${show(settled)})`);
    const again = await call('POST', ada, `/api/names/debts/${deeDebt[0].id}/settle`, { transactionId: whole.body?.transactionId });
    assert(again.status === 409 && again.body?.code === 'payment_used', `the same payment settles nothing else (${show(again)})`);
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
