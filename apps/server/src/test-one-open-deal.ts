/**
 * One open deal per member per listing (scratch/fable-design/DESIGN-deals-fable.md §0.2 D, slice S2; Marty, 25 Oct: "I shouldn't
 * be able to buy twice — but it should let me know"), over HTTPS through the real signature middleware, and at the engine:
 *
 *   1. A recurring Offer taken up twice by the same member: the second is refused, 409 `deal_open`, the member's deal named
 *      beside the words; one deal and one hold; every balance as before the refusal, and the node's total too (ledger audit).
 *      The refusal is plain, not a rollback: a row moved behind the ledger's back stays out of memory (a failed
 *      conservingTransaction resyncs memory from the rows).
 *   2. Another member takes it up while the first deal runs: it stays on the board, each member with their own deal.
 *   3. One open deal, not one deal ever: after a release the same member takes it up again at once; after a cancel, again.
 *   4. A request still waiting is an open deal too: an accept is refused, nothing held; withdrawn, the accept goes through.
 *      A request while a deal is held in trust is refused the same way.
 *   5. A one-off Offer as before: taken, a second accept (the same member or another) is the 400 `post_gone` it always was;
 *      cancelled, taken again.
 *   6. A recurring Need: a helper's request waiting is answered with itself, as before; once approved (held in trust) a new
 *      request is refused, `deal_open`, while another helper may still ask; after the release, the helper may ask again.
 *   7. An enterprise taking up its own keeper's recurring Offer: a second accept while the first is held is refused before
 *      the keeper-pay check, so no deferred wage claim is recorded for a deal that was never made.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-one-open-deal.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, createPost, acceptPost, getCommonsBalanceExact, runLedgerAudit } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { ledger } from './engine/ledger.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** The code and the words the apps read (engine/escrow.ts DEAL_OPEN_CODE, DEAL_OPEN_ERROR), written out: they are the contract. */
const DEAL_OPEN = 'deal_open';
const DEAL_OPEN_WORDS = 'You already have a deal under way on this. Finish or cancel it first.';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, beans: number, opts: { treasury?: boolean } = {}): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'TEST', 'active', ?)`).run(id.pk, name, opts.treasury ? 1 : 0);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    if (beans > 0) transfer('genesis', id.pk, beans, `seed ${name}`, 'direct', true);
    return id;
}

/** A listed Offer of their own, so the contribution gate lets them take one up. */
function listSomething(id: Id): void {
    createPost('offer', 'general', `${id.name}'s jam`, 'A jar of plum jam', 5, 'fixed', id.pk);
}

async function call(id: Id, path: string, body: Record<string, unknown>): Promise<Res> {
    resetGatewayRateLimit();
    const bodyString = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: bodyString });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const accept = (id: Id, postId: string) => call(id, '/api/marketplace/posts/accept', { postId, buyerPublicKey: id.pk });
const ask = (id: Id, postId: string) => call(id, '/api/marketplace/posts/request', { postId, buyerPublicKey: id.pk });
const release = (id: Id, transactionId: string) => call(id, '/api/marketplace/transactions/complete', { transactionId, confirmerPublicKey: id.pk });
const cancel = (id: Id, transactionId: string) => call(id, '/api/marketplace/transactions/cancel', { transactionId, cancellerPublicKey: id.pk });
const withdraw = (id: Id, transactionId: string) => call(id, '/api/marketplace/transactions/cancel-request', { transactionId, buyerPublicKey: id.pk });
const approve = (id: Id, transactionId: string) => call(id, '/api/marketplace/transactions/approve', { transactionId, authorPublicKey: id.pk });

const isDealOpen = (r: Res, txId: string) => r.status === 409 && r.body?.code === DEAL_OPEN && r.body?.transactionId === txId && r.body?.error === DEAL_OPEN_WORDS;

/** Every account's balance on disk, and the Commons pot in memory: what a refusal must leave exactly as it was. */
function ledgerSnapshot(): string {
    const rows = db.prepare(`SELECT public_key, balance FROM accounts WHERE public_key != 'COMMONS_POOL' ORDER BY public_key`).all() as { public_key: string; balance: number }[];
    return JSON.stringify([...rows.map(r => [r.public_key, r4(r.balance)]), ['COMMONS', r4(getCommonsBalanceExact())]]);
}
function nodeTotal(): number {
    const accounts = (db.prepare(`SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as any).t;
    return r4(accounts + getCommonsBalanceExact());
}
function assertConserved(step: string): void {
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.0001 && Math.abs(nodeTotal()) < 0.0001,
        `${step}: the node's Beans are conserved (audit ${audit.ok ? 'ok' : 'FAILED'}, drift ${audit.drift}, total ${nodeTotal()})`);
}
const dealsOf = (postId: string, buyer: string, seller?: string) => (seller
    ? db.prepare(`SELECT id, status FROM marketplace_transactions WHERE post_id = ? AND buyer_pubkey = ? AND seller_pubkey = ? ORDER BY created_at`).all(postId, buyer, seller)
    : db.prepare(`SELECT id, status FROM marketplace_transactions WHERE post_id = ? AND buyer_pubkey = ? ORDER BY created_at`).all(postId, buyer)) as { id: string; status: string }[];
const escrowHolds = (txIds: string[]) => txIds.map(id => r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(`escrow_${id}`) as any)?.balance ?? 0));
const memoryBalance = (pk: string) => r4(ledger.getAccount(pk).balance);

/**
 * A refused step, measured for being plain: a hand-moved row (the ledger never told) is out of memory before, and stays out
 * after, unless the refusal unwound a conservingTransaction, whose failure path reloads memory from the rows. The row is put
 * back after, so the ledger audit sees nothing.
 */
async function refusedPlainly<T>(probe: Id, step: () => Promise<T>): Promise<{ result: T; plain: boolean }> {
    const before = memoryBalance(probe.pk);
    db.prepare('UPDATE accounts SET balance = balance + 7 WHERE public_key = ?').run(probe.pk);
    try {
        const result = await step();
        return { result, plain: memoryBalance(probe.pk) === before };
    } finally {
        db.prepare('UPDATE accounts SET balance = balance - 7 WHERE public_key = ?').run(probe.pk);
    }
}

async function main(): Promise<void> {
    console.log('One open deal per member per listing\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const damo = makeMember('Damo', 50);
    const marty = makeMember('Marty', 200);
    const ana = makeMember('Ana', 200);
    const ben = makeMember('Ben', 200);
    const kofi = makeMember('Kofi', 200);
    const hana = makeMember('Hana', 20);
    const mia = makeMember('Mia', 20);
    const probe = makeMember('Probe', 100);
    for (const m of [marty, ana, ben, kofi, hana, mia]) listSomething(m);
    assertConserved('set up');

    // ── 1. A recurring Offer, taken up twice ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. A recurring Offer taken up twice by the same member ---');
    const course = createPost('offer', 'education', 'Pottery course', 'Six weeks on the wheel', 45, 'fixed', damo.pk, undefined, undefined, undefined, true)!;
    const first = await accept(marty, course.id);
    const firstId = first.body?.transaction?.id as string;
    assert(first.status === 200 && first.body?.transaction?.status === 'pending', `the first accept holds 45 Beans in trust (${show(first)})`);
    assertConserved('after the first accept');

    const held = ledgerSnapshot();
    const { result: second, plain } = await refusedPlainly(probe, () => accept(marty, course.id));
    assert(isDealOpen(second, firstId),
        `the second is refused: 409 deal_open, naming the deal under way, with the words (${show(second)})`);
    assert(plain, 'the refusal is plain: no rollback, so memory was not resynced from the rows');
    assert(JSON.stringify(dealsOf(course.id, marty.pk)) === JSON.stringify([{ id: firstId, status: 'pending' }]),
        `one deal for the member on the listing, still held (${JSON.stringify(dealsOf(course.id, marty.pk))})`);
    assert(JSON.stringify(escrowHolds([firstId])) === JSON.stringify([45]) && ledgerSnapshot() === held,
        'one hold of 45 Beans, and every balance exactly as before the refusal');
    assertConserved('after the refused second accept');

    // ── 2. Another member, meanwhile ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Another member takes it up while the first deal runs ---');
    const anas = await accept(ana, course.id);
    assert(anas.status === 200 && anas.body?.transaction?.status === 'pending', `another member takes it up: their own deal (${show(anas)})`);
    const courseRow = db.prepare('SELECT status FROM posts WHERE id = ?').get(course.id) as { status: string };
    assert(courseRow.status === 'active', `the recurring Offer stays on the board (${courseRow.status})`);

    // ── 3. After a release, again; after a cancel, again ──────────────────────────────────────────────────────────────
    console.log('\n--- 3. One open deal, not one deal ever ---');
    const released = await release(marty, firstId);
    assert(released.status === 200 && released.body?.transaction?.status === 'completed', `the member releases the first deal (${show(released)})`);
    const again = await accept(marty, course.id);
    const againId = again.body?.transaction?.id as string;
    assert(again.status === 200 && again.body?.transaction?.status === 'pending' && againId !== firstId,
        `after the release the member takes it up again at once (${show(again)})`);
    const cancelled = await cancel(marty, againId);
    assert(cancelled.status === 200 && cancelled.body?.transaction?.status === 'cancelled', `the member cancels it (${show(cancelled)})`);
    const third = await accept(marty, course.id);
    const thirdId = third.body?.transaction?.id as string;
    assert(third.status === 200 && third.body?.transaction?.status === 'pending', `after the cancel, again (${show(third)})`);
    assertConserved('after the release and the cancel');

    // ── 4. A request waiting is open too; a request while a deal is held is refused ─────────────────────────────────
    console.log('\n--- 4. A request waiting, and a request while a deal is held ---');
    const asked = await ask(ben, course.id);
    const askedId = asked.body?.transaction?.id as string;
    assert(asked.status === 200 && asked.body?.transaction?.status === 'requested', `a member asks for the recurring Offer, nothing held (${show(asked)})`);
    const bensBefore = ledgerSnapshot();
    const bensAccept = await accept(ben, course.id);
    assert(isDealOpen(bensAccept, askedId), `their accept while the request waits is refused, naming the request (${show(bensAccept)})`);
    assert(ledgerSnapshot() === bensBefore && dealsOf(course.id, ben.pk).length === 1, 'nothing held, and no second deal');
    const withdrawn = await withdraw(ben, askedId);
    assert(withdrawn.status === 200, `the request withdrawn (${show(withdrawn)})`);
    const bensSecond = await accept(ben, course.id);
    assert(bensSecond.status === 200 && bensSecond.body?.transaction?.status === 'pending', `then the accept goes through (${show(bensSecond)})`);

    const martysBefore = ledgerSnapshot();
    const askWhileHeld = await ask(marty, course.id);
    assert(isDealOpen(askWhileHeld, thirdId), `a request while the member's deal is held is refused the same way (${show(askWhileHeld)})`);
    assert(ledgerSnapshot() === martysBefore && JSON.stringify(dealsOf(course.id, marty.pk).map(d => d.status)) === JSON.stringify(['completed', 'cancelled', 'pending']),
        'no request written, nothing moved');
    assertConserved('after the refused accept and request');

    // ── 5. A one-off Offer, as before ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. A one-off Offer is as it was ---');
    const bowl = createPost('offer', 'household', 'Wheel-thrown bowl', 'One glazed bowl', 10, 'fixed', damo.pk)!;
    const taken = await accept(marty, bowl.id);
    const takenId = taken.body?.transaction?.id as string;
    assert(taken.status === 200 && taken.body?.transaction?.status === 'pending', `a one-off Offer is taken (${show(taken)})`);
    const bowlBefore = ledgerSnapshot();
    const sameAgain = await accept(marty, bowl.id);
    const someoneElse = await accept(ana, bowl.id);
    assert(sameAgain.status === 400 && sameAgain.body?.code === 'post_gone' && someoneElse.status === 400 && someoneElse.body?.code === 'post_gone',
        `a second accept, by the same member or another, is the 400 post_gone it always was (${show(sameAgain)} / ${show(someoneElse)})`);
    assert(ledgerSnapshot() === bowlBefore, 'nothing moved');
    const bowlCancelled = await cancel(marty, takenId);
    const takenAgain = await accept(ana, bowl.id);
    assert(bowlCancelled.status === 200 && takenAgain.status === 200 && takenAgain.body?.transaction?.status === 'pending',
        `cancelled, it is back on the board and taken again (${show(bowlCancelled)} / ${show(takenAgain)})`);
    assertConserved('after the one-off Offer');

    // ── 6. A recurring Need ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. A recurring Need ---');
    const stall = createPost('need', 'labour', 'Help at the market stall', 'Saturday mornings, setting up', 20, 'fixed', kofi.pk, undefined, undefined, undefined, true)!;
    const offered = await ask(hana, stall.id);
    const offeredId = offered.body?.transaction?.id as string;
    const offeredAgain = await ask(hana, stall.id);
    assert(offered.status === 200 && offered.body?.transaction?.status === 'requested'
        && offeredAgain.status === 200 && offeredAgain.body?.transaction?.id === offeredId,
        `a helper's offer to help waits, and asking again is answered with it, as before (${show(offered)} / ${show(offeredAgain)})`);
    const approved = await approve(kofi, offeredId);
    assert(approved.status === 200 && approved.body?.transaction?.status === 'pending', `the Need's author approves: 20 Beans held (${show(approved)})`);
    const stallBefore = ledgerSnapshot();
    const { result: askWhileHelping, plain: stallPlain } = await refusedPlainly(probe, () => ask(hana, stall.id));
    assert(isDealOpen(askWhileHelping, offeredId), `the helper asks again while their deal is held: refused, naming it (${show(askWhileHelping)})`);
    assert(stallPlain && ledgerSnapshot() === stallBefore && dealsOf(stall.id, kofi.pk, hana.pk).length === 1,
        'plain, nothing moved, no new request');
    const miasOffer = await ask(mia, stall.id);
    assert(miasOffer.status === 200 && miasOffer.body?.transaction?.status === 'requested',
        `another helper may still offer: the Need's author pays for every deal on it, and only the helper's own counts (${show(miasOffer)})`);
    const stallReleased = await release(kofi, offeredId);
    const offeredAfter = await ask(hana, stall.id);
    assert(stallReleased.status === 200 && offeredAfter.status === 200 && offeredAfter.body?.transaction?.status === 'requested'
        && offeredAfter.body?.transaction?.id !== offeredId,
        `after the release the helper may offer again (${show(stallReleased)} / ${show(offeredAfter)})`);
    assertConserved('after the recurring Need');

    // ── 7. An enterprise paying its own keeper ────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. An enterprise taking up its own keeper\'s recurring Offer ---');
    const keeper = makeMember('Keeper', 0);
    const otherKeeper = makeMember('OtherKeeper', 0);
    const farm = makeMember('Farm Co-op', 100, { treasury: true });
    for (const k of [keeper, otherKeeper]) {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(farm.pk, k.pk);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pk);
    }
    db.prepare('UPDATE members SET earned_surplus = 30 WHERE public_key = ?').run(farm.pk);
    listSomething(farm);
    const books = createPost('offer', 'services', 'Bookkeeping', 'The month\'s books, done', 30, 'fixed', keeper.pk, undefined, undefined, undefined, true)!;
    const wages = () => (db.prepare('SELECT COUNT(*) c FROM deferred_wage_claims WHERE enterprise_pubkey = ?').get(farm.pk) as { c: number }).c;
    let farmDeal: { id: string; status: string } | null = null;
    try { farmDeal = acceptPost(books.id, farm.pk, undefined, { authSigner: otherKeeper.pk }); } catch (e: any) { console.error(e?.message); }
    assert(farmDeal?.status === 'pending' && wages() === 0, `the enterprise takes up its keeper's Offer, paid from its earned surplus (${farmDeal?.status}, claims ${wages()})`);
    const farmBefore = ledgerSnapshot();
    let refusal: any = null;
    try { acceptPost(books.id, farm.pk, undefined, { authSigner: otherKeeper.pk }); } catch (e) { refusal = e; }
    assert(refusal?.code === DEAL_OPEN && refusal?.transactionId === farmDeal?.id && refusal?.status === 409,
        `a second accept while it is held is refused, deal_open (${refusal?.status} ${refusal?.code} ${refusal?.message})`);
    assert(wages() === 0 && ledgerSnapshot() === farmBefore,
        `no deferred wage claim recorded for a deal never made, nothing moved (claims ${wages()})`);
    assertConserved('after the enterprise');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => { console.error(e); process.exit(1); });
