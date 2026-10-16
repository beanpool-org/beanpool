/**
 * The verified ledger review (scratch/reviews/verify-audit-ledger.md), its reproductions on a real local HTTPS node:
 *   NEW-1  a hardship grant to a member working off a debt is not swept by the next payment they receive; spent and
 *          earned back, it counts toward the debt again; several payments in one commit do not read the grant as spent.
 *   NEW-2  an open crowdfund's escrow holding pledges is not a stranded escrow (the audit stays ok); a truly stranded one is.
 *   NEW-3  a goal pledged in full in whole cents (0.70 + 0.10 + 0.10 + 0.10 of 1) is funded.
 *   LED-05 pledges and member-to-member sends are to the cent, as a payment to the Commons is; float noise of a cent passes.
 * Fix round 1 (the deciding review, scratch/reviews/opus-2042.md):
 *   B1     the shield is its work-off's: it ends when the work-off is revoked or settles, and never shields the next member's.
 *   B2     while the work-off waits for a second admin, spending the grant still shrinks the shield (several payments in one
 *          commit together); what is earned in the wait is swept once it is live, what is left of the grant is not.
 *   N2     a sweep's count of what it took ahead lasts one batch of after-commit hooks, not the event-loop turn.
 *   N1/N5  the admin's stranded-escrow list is the audit's count; a projects row with a NULL id hides nothing.
 *   N4     a grant, and a keeper's surplus sweep, are to the cent.
 * Fix round 2: a balance holding a part of a cent (older data) still sends, pledges and sweeps its whole cents.
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
    moveToCommons, conservingTransaction, createTreasury,
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
import { listStrandedEscrows } from './engine/escrow-write-off.js';
import { db, createCrowdfundProject, pledgeToProject, WHOLE_CENTS_ERROR } from './db/db.js';
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
const debtById = (id: string) => db.prepare('SELECT * FROM names_debts WHERE id = ?').get(id) as any;
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

    // ═══════════════ Fix round 1: the shield is its work-off's, and only the grant still unspent ═══════════════
    console.log('\n── B1/B2/N2 the shield ends with its work-off and shrinks as the grant is spent ──');
    const grantTo = (who: Id, amount: number) => executeDecision(createDecision({ authorPubkey: proposer().pk, title: `Help ${who.name}`,
        description: 'Hardship', touches: 'pool', effect: 'grant_hardship', subject: who.pk, params: { amount } }).id);
    /** A debt of `beans` on a fresh entry: a confirmed member buys from Sam to -beans and deletes their account. */
    const leftDebt = async (name: string, beans: number) => {
        const entry = makeEntry();
        const m = makeMember(name);
        createPost('offer', 'produce', `${name} mends things`, 'Repairs', 20, 'fixed', m.pk);
        db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`).run(hex(16), m.pk, entry, ada.pk);
        const post = createPost('offer', 'produce', `Sam's ${beans}-Bean basket`, 'Veg', beans, 'fixed', sam.pk)!.id;
        const b = await call('POST', m, '/api/marketplace/posts/accept', { postId: post, buyerPublicKey: m.pk });
        if (b.body?.transaction?.id) completePostTransaction(b.body.transaction.id, m.pk);
        const purged = await call('POST', m, '/api/member/purge', { action: 'purge_account' });
        const debt = debtOf(entry);
        assert(debt?.status === 'open' && debt.amount === beans, `setup: ${name} leaves a ${beans} debt (${show(b)}; ${show(purged)})`);
        return debt as { id: string };
    };
    const workOffBy = async (debtId: string, who: Id) => {
        const r = await call('POST', ada, `/api/names/debts/${debtId}/work-off`, { memberPubkey: who.pk });
        assert(r.status === 201, `setup: ${who.name} is confirmed to work it off (${show(r)})`);
        return r.body as { id: string; status: string };
    };

    // B1: Ivy is granted 50 while working off a 300 debt, then Ada revokes her work-off. Jon holds 60 he earned and is
    // confirmed to work the same debt off; he is paid 1. Ivy's grant shields nothing of Jon's: 61 go (on ec18657b, 11).
    {
        const debt = await leftDebt('Old Ivy', 300);
        const ivy = makeMember('Ivy');
        const c1 = await workOffBy(debt.id, ivy);
        const t0 = nodeTotalExact();
        grantTo(ivy, 50);
        assert(debtById(debt.id).hardship_held === 50, `setup: Ivy's grant is shielded (${debtById(debt.id).hardship_held})`);
        const rv = await call('POST', ada, `/api/names/confirmations/${c1.id}/revoke`);
        const afterRevoke = debtById(debt.id);
        assert(rv.status === 200 && afterRevoke.repaying_pubkey === null && afterRevoke.hardship_held === 0,
            `revoking Ivy's work-off ends its shield (${show(rv)}; shield ${afterRevoke.hardship_held})`);
        const jon = makeMember('Jon', 60);
        await workOffBy(debt.id, jon);
        transfer('genesis', jon.pk, 1, 'one', 'direct', true);
        assert(debtById(debt.id).repaid === 61 && r2(rowBal(jon.pk)) === 0 && r2(rowBal(ivy.pk)) === 50,
            `Jon's next payment sweeps all 61 he holds; Ivy keeps her 50 (repaid ${debtById(debt.id).repaid}, Jon ${rowBal(jon.pk)}, Ivy ${rowBal(ivy.pk)})`);
        conserved(t0, 'a grant, a revoke, another member working the debt off');
    }

    // B1: the work-off settles; its shield goes with it.
    {
        const debt = await leftDebt('Old Ena', 200);
        const ena = makeMember('Ena');
        await workOffBy(debt.id, ena);
        const t0 = nodeTotalExact();
        grantTo(ena, 50);
        transfer('genesis', ena.pk, 300, 'a big job', 'direct', true);
        const d = debtById(debt.id);
        assert(d.status === 'settled' && d.repaid === 200 && r2(rowBal(ena.pk)) === 150 && d.hardship_held === 0,
            `300 earned settles the 200 debt; the grant's 50 stay hers and the settled debt holds no shield (${d.status}, repaid ${d.repaid}, balance ${rowBal(ena.pk)}, shield ${d.hardship_held})`);
        conserved(t0, 'a grant and the payment that settles the debt');
    }

    // Two admins needed: a work-off waits for the second one's agreement before it sweeps.
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('names_two_admins', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'`).run();
    const bea = makeMember('Bea');
    grantNodeRole(bea.pk, 'admin', 'SYSTEM');
    db.prepare(`INSERT INTO names_shares (from_pubkey, to_pubkey, head_id, key_ids, trusts, sealed_ring, ring_iv, ring_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
                VALUES (?, ?, ?, ?, '', '', '', '', '', '', '', '', '')`).run(ada.pk, bea.pk, KEY_ID, KEY_ID);

    // B2: Kim is granted 50 while her work-off waits, pledges all of it, then earns 40. Once Bea agrees and Kim is paid 1,
    // the 40 earned in the wait and the 1 go (§9: what she holds above 0): 41 (on ec18657b, 1; the spent grant shielded 40).
    {
        const debt = await leftDebt('Old Kim', 300);
        const kim = makeMember('Kim');
        const c = await workOffBy(debt.id, kim);
        assert(c.status === 'awaiting_second', `setup: Kim's work-off waits for a second admin (${c.status})`);
        const t0 = nodeTotalExact();
        grantTo(kim, 50);
        assert(debtById(debt.id).hardship_held === 50, `a grant while the work-off waits is shielded (${debtById(debt.id).hardship_held})`);
        const sp = await call('POST', kim, `/api/crowdfund/projects/${tank}/pledge`, { amount: 50 });
        transfer('genesis', kim.pk, 40, 'earned in the wait', 'direct', true);
        assert(sp.status === 200 && r2(rowBal(kim.pk)) === 40 && debtById(debt.id).repaid === 0 && debtById(debt.id).hardship_held === 0,
            `the grant spent in the wait, 40 earned: nothing swept yet, and no shield left (${show(sp)}; balance ${rowBal(kim.pk)}, repaid ${debtById(debt.id).repaid}, shield ${debtById(debt.id).hardship_held})`);
        const sec = await call('POST', bea, `/api/names/confirmations/${c.id}/second`);
        transfer('genesis', kim.pk, 1, 'the first payment once live', 'direct', true);
        assert(sec.status === 200 && debtById(debt.id).repaid === 41 && r2(rowBal(kim.pk)) === 0,
            `once Bea agrees, the next payment sweeps the 40 earned in the wait and the 1 (${show(sec)}; repaid ${debtById(debt.id).repaid}, balance ${rowBal(kim.pk)})`);
        conserved(t0, 'a grant spent in the wait, earnings, the second admin, the sweep');
    }

    // B2, the other side: Lou spends 30 of a 50 grant in the wait, then two payments of 5 come in one commit. The shield
    // is the 20 left of the grant, not less and not more (one payment's own 5 alone would leave 25; ec18657b left 50).
    // Once live, the 10 earned in the wait and the next 1 go; the 20 stay.
    {
        const debt = await leftDebt('Old Lou', 300);
        const lou = makeMember('Lou');
        const c = await workOffBy(debt.id, lou);
        const t0 = nodeTotalExact();
        grantTo(lou, 50);
        const sp = await call('POST', lou, `/api/crowdfund/projects/${tank}/pledge`, { amount: 30 });
        conservingTransaction(() => {
            transfer(sam.pk, lou.pk, 5, 'first half', 'direct', true);
            transfer(sam.pk, lou.pk, 5, 'second half', 'direct', true);
        });
        assert(sp.status === 200 && r2(rowBal(lou.pk)) === 30 && debtById(debt.id).repaid === 0 && debtById(debt.id).hardship_held === 20,
            `two payments in one commit in the wait: the shield is the 20 left of the grant (${show(sp)}; balance ${rowBal(lou.pk)}, shield ${debtById(debt.id).hardship_held})`);
        const sec = await call('POST', bea, `/api/names/confirmations/${c.id}/second`);
        transfer(sam.pk, lou.pk, 1, 'the first payment once live', 'direct', true);
        assert(sec.status === 200 && debtById(debt.id).repaid === 11 && r2(rowBal(lou.pk)) === 20,
            `once live, the 10 earned in the wait and the 1 go; the 20 left of the grant stay (repaid ${debtById(debt.id).repaid}, balance ${rowBal(lou.pk)})`);
        conserved(t0, 'a grant partly spent in the wait, a two-payment commit, the sweep once live');
    }

    // N2: an over-sweep (a payment once live sweeps what was earned in the wait), then a pledge of 30 and a payment of 10
    // in the same synchronous stretch, no transaction around them. The 10 is read on its own: all of it goes, and 20 of
    // the grant stay (on ec18657b the first sweep's count was still read: 0 swept, 30 held).
    {
        const debt = await leftDebt('Old Mia', 400);
        const mia = makeMember('Mia');
        const c = await workOffBy(debt.id, mia);
        grantTo(mia, 50);
        transfer('genesis', mia.pk, 40, 'earned in the wait', 'direct', true);
        const sec = await call('POST', bea, `/api/names/confirmations/${c.id}/second`);
        assert(sec.status === 200, `setup: Bea agrees to Mia's work-off (${show(sec)})`);
        const t0 = nodeTotalExact();
        transfer('genesis', mia.pk, 1, 'payment A', 'direct', true);
        const afterA = { balance: r2(rowBal(mia.pk)), repaid: debtById(debt.id).repaid };
        pledgeToProject(crypto.randomUUID(), tank, mia.pk, 30, 'spends 30 of the grant');
        transfer('genesis', mia.pk, 10, 'payment B', 'direct', true);
        assert(afterA.balance === 50 && afterA.repaid === 41, `payment A sweeps the 40 earned in the wait and the 1; the grant's 50 stay (${JSON.stringify(afterA)})`);
        assert(r2(rowBal(mia.pk)) === 20 && debtById(debt.id).repaid === 51,
            `after a pledge of 30, payment B's 10 all go in the same turn (balance ${rowBal(mia.pk)}, repaid ${debtById(debt.id).repaid})`);
        conserved(t0, 'an over-sweep, a pledge and a payment in one turn');
    }
    db.prepare(`UPDATE node_config SET value = 'false' WHERE key = 'names_two_admins'`).run();

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

    // N4: a grant is proposed to the cent; so is a keeper's sweep of an enterprise's surplus to the Commons.
    const totalN4 = nodeTotalExact();
    const lee = makeMember('Lee');
    let refusal = '';
    try {
        createDecision({ authorPubkey: proposer().pk, title: 'Help Lee', description: 'Hardship', touches: 'pool', effect: 'grant_hardship', subject: lee.pk, params: { amount: 0.005 } });
    } catch (e: any) { refusal = e.message; }
    assert(refusal === WHOLE_CENTS_ERROR, `a hardship grant of 0.005 is refused in words when it is proposed (${refusal || 'it was opened'})`);
    const leeGrant = createDecision({ authorPubkey: proposer().pk, title: 'Help Lee', description: 'Hardship', touches: 'pool', effect: 'grant_hardship', subject: lee.pk, params: { amount: 12.5 } });
    assert(!!leeGrant.id, 'a hardship grant of 12.50 is proposed');
    const { publicKey: farm } = createTreasury('CentFarm', AVATAR, 100);
    const keeper = makeMember('Keeper');
    db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'keeper', 'admin')`).run(farm, keeper.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(keeper.pk);
    transfer('genesis', farm, 10, 'a sale', 'direct', true);
    const sliver = await call('POST', keeper, `/api/treasury/${farm}/sweep`, { amount: 1.005 });
    assert(sliver.status === 400 && sliver.body?.error === WHOLE_CENTS_ERROR && r2(rowBal(farm)) === 10, `a keeper's sweep of 1.005 is refused in words, nothing moved (${show(sliver)})`);
    const whole = await call('POST', keeper, `/api/treasury/${farm}/sweep`, { amount: 1.25 });
    assert(whole.status === 200 && r2(rowBal(farm)) === 8.75, `a keeper's sweep of 1.25 goes (${show(whole)}; ${rowBal(farm)})`);
    conserved(totalN4, 'refused and taken grant proposals and sweeps');

    // Round 2: older data. A balance holding a part of a cent (made before the cent rule) locks nothing: its whole cents
    // are sent, pledged and swept as ever, and the part of a cent stays where it was.
    const totalOld = nodeTotalExact();
    const oldSender = makeMember('OldSender');
    // Past the first-trade gate on sends: a sale of hers, completed.
    const oldBuyer = makeMember('OldBuyer', 20);
    createPost('offer', 'produce', 'OldBuyer mends things', 'Repairs', 20, 'fixed', oldBuyer.pk);
    const jam = createPost('offer', 'produce', "OldSender's jam", 'Jam', 5, 'fixed', oldSender.pk)!.id;
    const sold = await call('POST', oldBuyer, '/api/marketplace/posts/accept', { postId: jam, buyerPublicKey: oldBuyer.pk });
    if (sold.body?.transaction?.id) completePostTransaction(sold.body.transaction.id, oldBuyer.pk);
    assert(rowBal(oldSender.pk) > 0, `setup: OldSender sells her jam (${show(sold)})`);
    const oldBacker = makeMember('OldBacker');
    const { publicKey: oldFarm } = createTreasury('OldFarm', AVATAR, 100);
    db.prepare(`INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'keeper', 'admin')`).run(oldFarm, keeper.pk);
    for (const pk of [oldSender.pk, oldBacker.pk, oldFarm]) transfer('genesis', pk, 10.333 - rowBal(pk), 'older data', 'direct', true);
    assert([oldSender.pk, oldBacker.pk, oldFarm].every(pk => Math.abs(rowBal(pk) - 10.333) < 1e-9), 'setup: a member, a backer and an enterprise each hold 10.333');
    const oldSend = await call('POST', oldSender, '/api/ledger/transfer', { from: oldSender.pk, to: friend.pk, amount: 10.33, memo: 'all but the sliver' });
    assert(oldSend.status === 200 && Math.abs(rowBal(oldSender.pk) - 0.003) < 1e-9, `a balance of 10.333 still sends 10.33, the part of a cent left (${show(oldSend)}; ${rowBal(oldSender.pk)})`);
    const oldPledge = await call('POST', oldBacker, `/api/crowdfund/projects/${shade}/pledge`, { amount: 10.33 });
    assert(oldPledge.status === 200 && Math.abs(rowBal(oldBacker.pk) - 0.003) < 1e-9, `a balance of 10.333 still pledges 10.33 (${show(oldPledge)}; ${rowBal(oldBacker.pk)})`);
    const oldSweep = await call('POST', keeper, `/api/treasury/${oldFarm}/sweep`, { amount: 10.33 });
    assert(oldSweep.status === 200 && Math.abs(rowBal(oldFarm) - 0.003) < 1e-9, `an enterprise holding 10.333 still sweeps 10.33 (${show(oldSweep)}; ${rowBal(oldFarm)})`);
    conserved(totalOld, 'sends, pledges and sweeps from balances with a part of a cent');

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
    // N1: the admin's list is the audit's count (on ec18657b it listed the open crowdfunds as stranded).
    const list0 = listStrandedEscrows().escrows.map((e) => e.escrowId);
    assert(list0.length === 0, `the admin's stranded-escrow list shows no open crowdfund either (${JSON.stringify(list0)})`);
    // A project that closed with Beans still in its escrow is stranded, and so is an escrow tied to no open deal.
    const totalA0 = nodeTotalExact();
    db.prepare(`UPDATE projects SET status = 'CANCELLED' WHERE id = ?`).run(shade);
    transfer('genesis', `escrow_${hex(16)}`, 5, 'an escrow no deal holds', 'direct', true);
    const audit2 = runLedgerAudit();
    assert(audit2.strandedEscrows === 2 && !audit2.ok, `a closed project's escrow and an orphan escrow still count as stranded (${audit2.strandedEscrows})`);
    const list2 = listStrandedEscrows().escrows.map((e) => e.escrowId);
    assert(list2.length === 2 && list2.includes(`escrow_${shade}`), `the admin's list shows the same two (${JSON.stringify(list2)})`);
    // N5: a projects row with a NULL id (corrupt: no code writes one) and a deal with one hide no stranded escrow.
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, goal_amount, status) VALUES (NULL, ?, 'A corrupt row', 1, 'ACTIVE')`).run(creator.pk);
    const nullIds = (db.prepare('SELECT COUNT(*) c FROM projects WHERE id IS NULL').get() as { c: number }).c;
    const audit3 = runLedgerAudit();
    const list3 = listStrandedEscrows().escrows.length;
    assert(nullIds === 1 && audit3.strandedEscrows === 2 && !audit3.ok && list3 === 2,
        `a NULL project id hides nothing: the audit and the list still count 2 (null rows ${nullIds}, audit ${audit3.strandedEscrows}, list ${list3})`);
    conserved(totalA0, 'the audit checks');

    console.log(`\n${passed}/${run} checks passed.`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
