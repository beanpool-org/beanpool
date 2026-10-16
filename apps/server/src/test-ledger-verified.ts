/**
 * The verified ledger review (scratch/reviews/verify-audit-ledger.md), its reproductions on a real local HTTPS node:
 *   NEW-1  a hardship grant to a member working off a debt is not swept by the next payment they receive; spent and
 *          earned back, it counts toward the debt again; several payments in one commit do not read the grant as spent.
 *   NEW-2  an open crowdfund's escrow holding pledges is not a stranded escrow (the audit stays ok); a truly stranded one is.
 *   NEW-3  a goal pledged in full in whole cents (0.70 + 0.10 + 0.10 + 0.10 of 1) is funded.
 *   LED-05 pledges and member-to-member sends are to the cent, as a payment to the Commons is; float noise of a cent passes.
 * Every check that moves Beans asserts conservation: the node's total (every account plus the pot) changes by 0.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'VerifyLedger123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, transfer, seedGenesisMember, createPost, completePostTransaction, getCommonsBalanceExact,
    moveToCommons, conservingTransaction,
} from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { createDecision, executeDecision, tickDecisions } from './decisions-engine.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { runLedgerAudit } from './engine/audit.js';
import { db, createCrowdfundProject, WHOLE_CENTS_ERROR } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

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
const KEY_ID = hex(32);
function makeEntry(): string {
    const id = hex(16);
    db.prepare('INSERT INTO names_entries (id, ciphertext, key_id, created_by) VALUES (?, ?, ?, ?)').run(id, 'sealed:' + hex(24), KEY_ID, 'fixture');
    return id;
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

/** The whole node, exact: every account but the pot's shadow row, plus the pot. */
const nodeTotalExact = () => (db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t + getCommonsBalanceExact();
const conserved = (before: number, what: string) => {
    const delta = nodeTotalExact() - before;
    assert(Math.abs(delta) < 1e-9, `conservation: ${what} (Δ ${delta})`);
};
const rowBal = (pk: string) => (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0;
const debtOf = (entryId: string) => db.prepare('SELECT * FROM names_debts WHERE entry_id = ? ORDER BY removed_at').get(entryId) as any;
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
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
    assert(on.status === 200, `setup: known floor dial on (${show(on)})`);

    const sam = makeMember('Sam', 2000);
    let proposers = 0;
    const proposer = (): Id => {
        const m = makeMember(`Proposer${++proposers}`, 0);
        db.prepare('UPDATE members SET earned_credit = 50 WHERE public_key = ?').run(m.pk);
        return m;
    };
    const donor = makeMember('Donor', 5000);
    assert(!!moveToCommons(donor.pk, 4000, 'Seed the pot', { allowMemberDebit: true }), 'setup: the Commons holds 4000');

    // ═══════════════ NEW-1: a hardship grant and a debt being worked off ═══════════════
    console.log('\n── NEW-1 a hardship grant survives the next payment ──');
    const deeEntry = makeEntry();
    const dee = makeMember('Dee');
    createPost('offer', 'produce', 'Dee mends things', 'Repairs', 20, 'fixed', dee.pk);
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`).run(hex(16), dee.pk, deeEntry, ada.pk);
    const basket = createPost('offer', 'produce', "Sam's 200-Bean basket", 'Veg', 200, 'fixed', sam.pk)!.id;
    const bought = await call('POST', dee, '/api/marketplace/posts/accept', { postId: basket, buyerPublicKey: dee.pk });
    if (bought.body?.transaction?.id) completePostTransaction(bought.body.transaction.id, dee.pk);
    assert(r2(rowBal(dee.pk)) === -200, `setup: Dee spends to -200 (${show(bought)})`);
    executeDecision(createDecision({ authorPubkey: proposer().pk, title: 'Remove Dee', description: 'Left owing', touches: 'member', effect: 'remove_member', subject: dee.pk }).id);
    tickDecisions(Date.now() + 8 * DAY);
    const debt0 = debtOf(deeEntry);
    assert(debt0?.status === 'open' && debt0.amount === 200, `setup: an open 200 debt (${JSON.stringify(debt0)?.slice(0, 120)})`);
    const dee2 = makeMember('Dee again');
    const workOff = await call('POST', ada, `/api/names/debts/${debt0.id}/work-off`, { memberPubkey: dee2.pk });
    assert(workOff.status === 201, `setup: Ada confirms Dee's new key to work it off (${show(workOff)})`);

    const totalH0 = nodeTotalExact();
    const grant = executeDecision(createDecision({ authorPubkey: proposer().pk, title: 'Help Dee with the rent', description: 'Hardship',
        touches: 'pool', effect: 'grant_hardship', subject: dee2.pk, params: { amount: 50 } }).id);
    assert(grant.status === 'executed' && r2(rowBal(dee2.pk)) === 50 && debtOf(deeEntry).repaid === 0, `the hardship grant pays 50 and sweeps nothing (${grant.status}, ${rowBal(dee2.pk)})`);
    assert(debtOf(deeEntry).hardship_held === 50, `the debt records the grant's shield (${debtOf(deeEntry).hardship_held})`);
    conserved(totalH0, 'the grant');

    // The review's reproduction: Sam sends Dee 1 Bean. On main 51 was swept and Dee was left with 0.
    const totalH1 = nodeTotalExact();
    const one = await call('POST', sam, '/api/ledger/transfer', { from: sam.pk, to: dee2.pk, amount: 1, memo: 'thanks for the help' });
    const swept1 = db.prepare(`SELECT amount FROM transactions WHERE from_pubkey = ? AND to_pubkey = 'COMMONS_POOL'`).all(dee2.pk) as { amount: number }[];
    assert(one.status === 200, `Sam sends Dee 1 Bean (${show(one)})`);
    assert(r2(rowBal(dee2.pk)) === 50 && debtOf(deeEntry).repaid === 1, `only the 1 Bean earned is swept: balance 50, repaid 1 (balance ${rowBal(dee2.pk)}, repaid ${debtOf(deeEntry).repaid})`);
    assert(swept1.length === 1 && swept1[0].amount === 1, `one sweep row of 1 (${JSON.stringify(swept1)})`);
    conserved(totalH1, 'the send and its sweep');

    // Spent and earned back: Dee pledges 30 of the grant, then is paid 10. All 10 go to the debt; the 20 still held stay.
    const totalH2 = nodeTotalExact();
    const tank = 'proj-' + hex(6);
    createCrowdfundProject(tank, sam.pk, 'Water tank', 'A tank for the hall', [], 100000, null);
    const spend = await call('POST', dee2, `/api/crowdfund/projects/${tank}/pledge`, { amount: 30 });
    assert(spend.status === 200 && r2(rowBal(dee2.pk)) === 20, `Dee pledges 30 of the grant (${show(spend)}; balance ${rowBal(dee2.pk)})`);
    const ten = await call('POST', sam, '/api/ledger/transfer', { from: sam.pk, to: dee2.pk, amount: 10, memo: 'for the fence' });
    assert(ten.status === 200 && debtOf(deeEntry).repaid === 11 && r2(rowBal(dee2.pk)) === 20,
        `after spending 30 of it, the next 10 in all go to the debt (repaid ${debtOf(deeEntry).repaid}, balance ${rowBal(dee2.pk)})`);
    assert(debtOf(deeEntry).hardship_held === 20, `the shield shrank to what is left of the grant (${debtOf(deeEntry).hardship_held})`);
    conserved(totalH2, 'the pledge, the payment and its sweep');

    // Two payments to Dee in one commit: their sweeps run one after the other, after it. The first sweeps both; the
    // second must not read the grant as spent (it would sweep 5 of it).
    const totalH3 = nodeTotalExact();
    conservingTransaction(() => {
        transfer(sam.pk, dee2.pk, 5, 'first half', 'direct', true);
        transfer(sam.pk, dee2.pk, 5, 'second half', 'direct', true);
    });
    assert(debtOf(deeEntry).repaid === 21 && r2(rowBal(dee2.pk)) === 20,
        `two payments of 5 in one commit sweep 10, the grant's 20 stay (repaid ${debtOf(deeEntry).repaid}, balance ${rowBal(dee2.pk)})`);
    conserved(totalH3, 'two payments in one commit and their sweeps');
    await nextTick();
    // The batch is over: the next payment is read on its own again.
    const totalH4 = nodeTotalExact();
    transfer(sam.pk, dee2.pk, 4, 'later', 'direct', true);
    assert(debtOf(deeEntry).repaid === 25 && r2(rowBal(dee2.pk)) === 20, `a later payment of 4 is swept whole (repaid ${debtOf(deeEntry).repaid}, balance ${rowBal(dee2.pk)})`);
    conserved(totalH4, 'a later payment and its sweep');

    // ═══════════════ LED-05: pledges and sends to the cent ═══════════════
    console.log('\n── LED-05 pledges and sends to the cent ──');
    const shade = 'proj-' + hex(6);
    const creator = makeMember('Creator');
    createCrowdfundProject(shade, creator.pk, 'Shade house', 'A shade house for seedlings', [], 100000, null);
    const backer = makeMember('Backer', 10);
    const friend = makeMember('Friend');
    const totalS0 = nodeTotalExact();
    for (const amt of [0.0001, 1.00000005, 1.005, 5e-324]) {
        const r = await call('POST', backer, `/api/crowdfund/projects/${shade}/pledge`, { amount: amt });
        assert(r.status === 400 && r.body?.error === WHOLE_CENTS_ERROR, `a pledge of ${amt} is refused in words (${show(r)})`);
    }
    assert(r2(rowBal(backer.pk)) === 10, `nothing moved for the refused pledges (balance ${rowBal(backer.pk)})`);
    const noisy = await call('POST', backer, `/api/crowdfund/projects/${shade}/pledge`, { amount: 0.1 + 0.2 });
    assert(noisy.status === 200, `a pledge of 0.1 + 0.2 (float noise of 30 cents) is taken (${show(noisy)})`);
    const cents = await call('POST', backer, `/api/crowdfund/projects/${shade}/pledge`, { amount: 1.25 });
    assert(cents.status === 200, `a pledge of 1.25 is taken (${show(cents)})`);
    for (const amt of [0.0001, 2.345]) {
        const r = await call('POST', sam, '/api/ledger/transfer', { from: sam.pk, to: friend.pk, amount: amt, memo: 'sliver' });
        assert(r.status === 400 && r.body?.error === WHOLE_CENTS_ERROR, `a send of ${amt} is refused in words (${show(r)})`);
    }
    const sendCents = await call('POST', sam, '/api/ledger/transfer', { from: sam.pk, to: friend.pk, amount: 2.35, memo: 'to the cent' });
    assert(sendCents.status === 200, `a send of 2.35 goes (${show(sendCents)})`);
    conserved(totalS0, 'refused and taken pledges and sends');

    // ═══════════════ NEW-3: a goal pledged in full in whole cents ═══════════════
    console.log('\n── NEW-3 a goal pledged in full in cents is funded ──');
    const seeds = 'proj-' + hex(6);
    createCrowdfundProject(seeds, creator.pk, 'Seed library', 'Seeds', [], 1, null);
    const backer4 = makeMember('Backer4', 10);
    const totalG0 = nodeTotalExact();
    for (const amt of [0.7, 0.1, 0.1, 0.1]) {
        const r = await call('POST', backer4, `/api/crowdfund/projects/${seeds}/pledge`, { amount: amt });
        assert(r.status === 200, `pledge ${amt} (${show(r)})`);
    }
    const p = db.prepare('SELECT status, current_amount FROM projects WHERE id = ?').get(seeds) as any;
    assert(p.status === 'FUNDED', `a goal of 1 pledged as 0.70 + 0.10 + 0.10 + 0.10 is funded (${p.status}, ${p.current_amount})`);
    assert(Math.abs(rowBal(`escrow_${seeds}`)) < 1e-9, `its escrow swept to the project (${rowBal(`escrow_${seeds}`)})`);
    conserved(totalG0, 'the pledges and the sweep at the goal');

    // ═══════════════ NEW-2: the audit and an open crowdfund ═══════════════
    console.log('\n── NEW-2 an open crowdfund is not a stranded escrow ──');
    assert(rowBal(`escrow_${tank}`) > 0.01 && rowBal(`escrow_${shade}`) > 0.01, 'setup: two open projects hold pledges in their escrows');
    const audit = runLedgerAudit();
    assert(audit.strandedEscrows === 0 && audit.ok, `the ledger audit passes with open crowdfunds holding pledges (${JSON.stringify(audit)})`);
    // A project that closed with Beans still in its escrow is stranded, and so is an escrow tied to no open deal.
    const totalA0 = nodeTotalExact();
    db.prepare(`UPDATE projects SET status = 'CANCELLED' WHERE id = ?`).run(shade);
    transfer('genesis', `escrow_${hex(16)}`, 5, 'an escrow no deal holds', 'direct', true);
    const audit2 = runLedgerAudit();
    assert(audit2.strandedEscrows === 2 && !audit2.ok, `a closed project's escrow and an orphan escrow still count as stranded (${audit2.strandedEscrows})`);
    conserved(totalA0, 'the audit checks');

    console.log(`\n${passed}/${run} checks passed.`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
