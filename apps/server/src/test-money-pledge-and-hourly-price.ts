/**
 * Money: a late pledge is never stranded; an open deal's price is frozen (FABLE-sec-money MEDIUM 1 and 2, 2026-10-01).
 *
 *   Part 1, the boot step: pledges a FUNDED project took before this change (planted here exactly as the old
 *           pledgeToProject wrote them) go back to their backers when the node starts: exactly what each pledged, the
 *           project's account untouched, the node's total unchanged. An escrow whose pledges can't be worked out exactly
 *           (a history that doesn't add up; a backer who was pruned) is left as it is, for the operator. Once only.
 *   Part 2, both pledge routes: a pledge to a project that has reached its goal is refused, and nothing moves. The
 *           enterprise door already refused a funded enterprise (its row reads 'funded'); a FUNDED project under an
 *           enterprise row that reads active (planted) reached pledgeToProject through it.
 *   Part 3, hourly deals: the author of an Offer can't raise its rate, nor the author of a Need lower it, while a deal on
 *           it is asked for or held; and even with the price forced in the database, the completion pays the rate the deal
 *           was struck at, for the hours confirmed. A deal that is over frees the price again.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-money-pledge-and-hourly-price.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initAdminPassword } from './config/local-config.js';
import { db, initSchema, createCrowdfundProject, pledgeToProject, getCrowdfundProject } from './db/db.js';
import {
    initStateEngine, transfer, conservingTransaction, createPost, acceptPost, requestPost, approvePostRequest,
    completePostTransaction, cancelPostTransaction, getBalance, runLedgerAudit,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';

// Loaded so that this suite runs to the end on a tree without the boot step (it fails there, with a count, rather than
// stopping at the import). The refusals are matched by their words for the same reason.
type StrandedModule = typeof import('./engine/stranded-pledges.js');
let stranded: StrandedModule | null = null;
const FUNDED_REFUSAL = /already reached its goal, so it is not taking more pledges\. Your Beans have not moved\./;
const PRICE_FROZEN = /has a deal in progress, so its price can’t change until that deal is finished\. To change the price, cancel or decline the deal first\./;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const EPOCH_NOW = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
const r4 = (n: number) => Math.round(n * 10000) / 10000;
let BASE = '';

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

// ── Before the node starts: rows only ────────────────────────────────────────────────────────────────────────────

/** A member with a balance, written as rows, before the ledger is loaded. The window closed now, so nothing decays. */
function plantMember(callsign: string, balance: number): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active')`)
        .run(pk, callsign, AVATAR);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(pk, balance, EPOCH_NOW);
    return pk;
}

/**
 * A pledge to a project that had already reached its goal, written exactly as pledgeToProject wrote one before this
 * change (db.ts, origin/main 62935339): backer debited, escrow credited, the pledge row naming the project, the raised
 * figure up. No sweep: the project was FUNDED already. The code refuses it now, so the stranded state is planted.
 */
function plantLatePledge(projectId: string, backer: string, amount: number): string {
    const id = crypto.randomUUID();
    const escrow = `escrow_${projectId}`;
    db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_updated_at, last_demurrage_epoch) VALUES (?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0)`).run(escrow);
        db.prepare(`UPDATE accounts SET balance = balance - ? WHERE public_key = ?`).run(amount, backer);
        db.prepare(`UPDATE accounts SET balance = balance + ? WHERE public_key = ?`).run(amount, escrow);
        db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id) VALUES (?, ?, ?, ?, 'Project Pledge', ?)`)
            .run(id, backer, escrow, amount, projectId);
        db.prepare(`UPDATE projects SET current_amount = current_amount + ? WHERE id = ?`).run(amount, projectId);
    })();
    return id;
}

const rowBalance = (pk: string): number => Number((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0);
const sumBalances = (): number => r4(Number((db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s));
const projectStatus = (id: string): string | undefined => (db.prepare('SELECT status FROM projects WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const ledgerRowsFor = (pk: string): number => (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?').get(pk, pk) as { n: number }).n;

// ── Once the node is up: signed members and requests ─────────────────────────────────────────────────────────────

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

/** A member who can sign, trade (a photo, a name, an Offer listed) and pay. */
function makeMember(callsign: string, beans: number): Id {
    const id = keypair(callsign);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pk, callsign, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, EPOCH_NOW);
    transfer('genesis', id.pk, beans, `seed ${callsign}`, 'direct', true);
    createPost('offer', 'general', `${callsign} odd jobs`, 'Help around the place', 5, 'fixed', id.pk, undefined, undefined, undefined, true);
    return id;
}

async function signedFetch(method: 'POST', path: string, id: Id, body: unknown) {
    const bodyString = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': id.pk,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const bal = (pk: string): number => r4(getBalance(pk).balance);
const refusedWith = (res: { status: number; body: any }, words: RegExp): boolean => res.status === 400 && words.test(String(res.body?.error));
const postCredits = (id: string): number => Number((db.prepare('SELECT credits FROM posts WHERE id = ?').get(id) as { credits: number }).credits);

async function main(): Promise<void> {
    console.log('Money: a late pledge is never stranded; an open deal\'s price is frozen\n');
    initAdminPassword();
    await initTls();
    stranded = await import('./engine/stranded-pledges.js').catch(() => null);
    assert(stranded !== null, 'the boot step\'s module is there (engine/stranded-pledges.ts)');
    const findStranded = () => stranded?.findStrandedProjectEscrows() ?? [];

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Part 1: the boot step
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── Part 1: pledges stranded before this change go back at boot ──');
    initSchema();
    const onFresh = findStranded();
    console.log(`   the audit query on a fresh database finds: ${JSON.stringify(onFresh)}`);
    assert(onFresh.length === 0, 'on a fresh database the query finds no stranded project escrow');

    const creator = plantMember('RoofCreator', 0);
    const ann = plantMember('AnnBacker', 500);
    const ben = plantMember('BenBacker', 500);
    const cal = plantMember('CalBacker', 500);
    const dee = plantMember('DeeBacker', 500);

    // Roof: reaches its goal of 100 the ordinary way (60 + 40, the second sweeps the escrow to the enterprise), then
    // takes three pledges after it: Ann 30 and 5, Ben 20.
    const roof = crypto.randomUUID();
    createCrowdfundProject(roof, creator, 'New roof', 'For the hall', [], 100, null);
    pledgeToProject(crypto.randomUUID(), roof, ann, 60, 'Project Pledge');
    pledgeToProject(crypto.randomUUID(), roof, ben, 40, 'Project Pledge');
    assert(projectStatus(roof) === 'FUNDED' && rowBalance(roof) === 100 && rowBalance(`escrow_${roof}`) === 0,
        'the roof reached its goal: FUNDED, 100 in its account, its escrow swept to 0');
    const annLate1 = plantLatePledge(roof, ann, 30);
    const benLate = plantLatePledge(roof, ben, 20);
    const annLate2 = plantLatePledge(roof, ann, 5);

    // Oven: funded, one late pledge, and 3 Beans in its escrow that no ledger row explains.
    const oven = crypto.randomUUID();
    createCrowdfundProject(oven, creator, 'Bread oven', 'For the market', [], 50, null);
    pledgeToProject(crypto.randomUUID(), oven, cal, 50, 'Project Pledge');
    plantLatePledge(oven, cal, 10);
    db.prepare('UPDATE accounts SET balance = balance - 3 WHERE public_key = ?').run(cal);
    db.prepare('UPDATE accounts SET balance = balance + 3 WHERE public_key = ?').run(`escrow_${oven}`);

    // Bench: funded, one late pledge from a member since pruned.
    const bench = crypto.randomUUID();
    createCrowdfundProject(bench, creator, 'Park bench', 'By the creek', [], 20, null);
    pledgeToProject(crypto.randomUUID(), bench, dee, 20, 'Project Pledge');
    plantLatePledge(bench, dee, 7);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(dee);

    const planted = findStranded();
    assert(planted.length === 3, `the query finds the three planted escrows (${planted.map(s => s.projectId.slice(0, 8)).join(', ')})`);
    const roofFound = planted.find(s => s.projectId === roof);
    assert(!!roofFound && roofFound.ok && roofFound.held === 55
        && roofFound.returns.find(o => o.backer === ann)?.amount === 35 && roofFound.returns.find(o => o.backer === ben)?.amount === 20,
        `the roof's 55 is Ann's 35 and Ben's 20 (${JSON.stringify(roofFound)})`);
    const ovenFound = planted.find(s => s.projectId === oven);
    assert(!!ovenFound && !ovenFound.ok, `the oven can't be worked out exactly (${ovenFound && !ovenFound.ok ? ovenFound.reason : 'found ok'})`);
    const benchFound = planted.find(s => s.projectId === bench);
    assert(!!benchFound && !benchFound.ok && /can't be paid here/.test(benchFound.reason),
        `the bench's backer was pruned (${benchFound && !benchFound.ok ? benchFound.reason : 'found ok'})`);

    const totalBefore = sumBalances();
    db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('ledger_audit_baseline', ?)`).run(String(totalBefore));
    const annBefore = rowBalance(ann), benBefore = rowBalance(ben), calBefore = rowBalance(cal), deeBefore = rowBalance(dee);
    assert(annBefore === 405 && benBefore === 440, `the backers are down their late pledges (Ann ${annBefore}, Ben ${benBefore})`);

    // The node starts: the boot step runs inside initStateEngine, before the boot audit.
    initStateEngine();

    assert(rowBalance(ann) === annBefore + 35, `Ann gets back exactly her 35 (${rowBalance(ann)})`);
    assert(rowBalance(ben) === benBefore + 20, `Ben gets back exactly his 20 (${rowBalance(ben)})`);
    assert(bal(ann) === annBefore + 35 && bal(ben) === benBefore + 20, 'and the in-memory ledger agrees');
    assert(rowBalance(`escrow_${roof}`) === 0, `the roof's escrow is empty (${rowBalance(`escrow_${roof}`)})`);
    assert(rowBalance(roof) === 100, `the roof's own account is untouched (${rowBalance(roof)})`);
    assert(sumBalances() === totalBefore, `the node's total is unchanged (${sumBalances()} vs ${totalBefore})`);
    const returns = db.prepare(`SELECT to_pubkey, amount, memo, project_id, tax_fee FROM transactions WHERE from_pubkey = ? ORDER BY to_pubkey`)
        .all(`escrow_${roof}`) as { to_pubkey: string; amount: number; memo: string; project_id: string; tax_fee: number }[];
    const toAnn = returns.find(r => r.to_pubkey === ann);
    const toBen = returns.find(r => r.to_pubkey === ben);
    assert(!!toAnn && toAnn.amount === 35 && !!toBen && toBen.amount === 20 && returns.every(r => !r.tax_fee),
        `one ledger row each, fee-free, out of the escrow (${JSON.stringify(returns.map(r => [r.to_pubkey.slice(0, 6), r.amount]))})`);
    const returnRows = returns.filter(r => r.to_pubkey !== roof);
    assert(returnRows.length === 2 && returnRows.every(r => r.project_id === roof && /^Pledge returned: "New roof"/.test(r.memo)),
        `each names the project and says why ("${toAnn?.memo}")`);
    assert(getCrowdfundProject(roof)?.current_amount === 100, `the roof shows 100 raised, not 155 (${getCrowdfundProject(roof)?.current_amount})`);
    assert(!!annLate1 && !!annLate2 && !!benLate, 'the late pledges themselves stay on the ledger');

    assert(rowBalance(`escrow_${oven}`) === 13 && rowBalance(cal) === calBefore, 'the oven is left exactly as it was, for the operator');
    assert(rowBalance(`escrow_${bench}`) === 7 && rowBalance(dee) === deeBefore, 'the bench is left exactly as it was, for the operator');
    const auditAfterBoot = runLedgerAudit();
    assert(Math.abs(auditAfterBoot.drift) < 0.0001 && auditAfterBoot.strandedEscrows === 2,
        `the audit: no drift, and only the two left for the operator still stranded (drift ${auditAfterBoot.drift}, stranded ${auditAfterBoot.strandedEscrows})`);

    const again = stranded?.returnStrandedPledges({ transfer, conservingTransaction }) ?? { returned: -1, left: -1 };
    assert(again.returned === 0 && again.left === 2, `a second run returns nothing more (${JSON.stringify(again)})`);
    assert(rowBalance(ann) === annBefore + 35 && rowBalance(ben) === benBefore + 20 && sumBalances() === totalBefore,
        'and moves nothing');

    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Part 2: both pledge routes refuse a pledge to a project that has reached its goal
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 2: a pledge to a funded project is refused, on both routes ──');
    const wellCreator = makeMember('WellCreator', 50);
    const early = makeMember('EarlyBacker', 200);
    const late = makeMember('LateBacker', 200);

    const well = crypto.randomUUID();
    createCrowdfundProject(well, wellCreator.pk, 'Village well', 'Clean water', [], 20, null);
    const funding = await signedFetch('POST', `/api/crowdfund/projects/${well}/pledge`, early, { amount: 20 });
    assert(funding.status === 200 && projectStatus(well) === 'FUNDED' && bal(well) === 20,
        `the well reaches its goal through the project door (${funding.status}, ${projectStatus(well)}, ${bal(well)})`);

    const snapshot = () => ({ late: bal(late.pk), escrow: rowBalance(`escrow_${well}`), well: bal(well), rows: ledgerRowsFor(`escrow_${well}`),
        raised: Number((db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(well) as any).current_amount) });
    const before = snapshot();
    const byProjectDoor = await signedFetch('POST', `/api/crowdfund/projects/${well}/pledge`, late, { amount: 5 });
    assert(refusedWith(byProjectDoor, FUNDED_REFUSAL),
        `the project door refuses it, saying why (${byProjectDoor.status} ${JSON.stringify(byProjectDoor.body)})`);
    assert(JSON.stringify(snapshot()) === JSON.stringify(before), `and nothing moves (${JSON.stringify(snapshot())})`);

    const byEnterpriseDoor = await signedFetch('POST', `/api/enterprise/${well}/pledge`, late, { amount: 5, memo: 'Late' });
    assert(byEnterpriseDoor.status >= 400 && JSON.stringify(snapshot()) === JSON.stringify(before),
        `the enterprise door refuses it too, and nothing moves (${byEnterpriseDoor.status} ${JSON.stringify(byEnterpriseDoor.body)})`);

    // A FUNDED project whose enterprise row reads active: the enterprise door's own status check passes it through.
    const hall = crypto.randomUUID();
    createCrowdfundProject(hall, wellCreator.pk, 'Hall chairs', 'Forty chairs', [], 10, null);
    db.prepare("UPDATE projects SET status = 'FUNDED' WHERE id = ?").run(hall);
    const lateBefore = bal(late.pk);
    for (const path of [`/api/treasury/${hall}/pledge`, `/api/enterprise/${hall}/pledge`, `/api/crowdfund/projects/${hall}/pledge`]) {
        const res = await signedFetch('POST', path, late, { amount: 5, memo: 'Late' });
        assert(refusedWith(res, FUNDED_REFUSAL),
            `${path.replace(hall, ':id')} refuses a pledge to a FUNDED project (${res.status} ${JSON.stringify(res.body)})`);
    }
    assert(bal(late.pk) === lateBefore && rowBalance(`escrow_${hall}`) === 0 && ledgerRowsFor(`escrow_${hall}`) === 0,
        `and nothing moves (backer ${bal(late.pk)}, escrow ${rowBalance(`escrow_${hall}`)})`);

    const open = crypto.randomUUID();
    createCrowdfundProject(open, wellCreator.pk, 'Seed library', 'Shelves', [], 100, null);
    const stillOpen = await signedFetch('POST', `/api/crowdfund/projects/${open}/pledge`, late, { amount: 5 });
    assert(stillOpen.status === 200 && rowBalance(`escrow_${open}`) === 5, `a project still raising takes a pledge as before (${stillOpen.status})`);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Part 3: an hourly deal is paid at the rate it was struck at
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── Part 3: an open deal holds its listing\'s price, and completion pays the deal\'s own rate ──');
    const seller = makeMember('TutorSeller', 50);
    const buyer = makeMember('TutorBuyer', 300);

    // (a) An Offer at 10 an hour, 3 hours booked. The seller tries to raise the rate.
    const tutoring = createPost('offer', 'education', 'Maths tutoring', 'By the hour', 10, 'hourly', seller.pk)!;
    const dealA = acceptPost(tutoring.id, buyer.pk, 3);
    assert(bal(`escrow_${dealA.id}`) === 30, 'the buyer\'s 30 (3 hours at 10) is held');
    const raise = await signedFetch('POST', '/api/marketplace/posts/update', seller, { id: tutoring.id, authorPublicKey: seller.pk, credits: 20 });
    assert(refusedWith(raise, PRICE_FROZEN), `the seller can't raise the rate while it is held (${raise.status} ${JSON.stringify(raise.body)})`);
    const unit = await signedFetch('POST', '/api/marketplace/posts/update', seller, { id: tutoring.id, authorPublicKey: seller.pk, priceType: 'fixed' });
    assert(refusedWith(unit, PRICE_FROZEN), `nor turn it into a fixed price (${unit.status})`);
    assert(postCredits(tutoring.id) === 10, 'the listing still says 10');
    const wording = await signedFetch('POST', '/api/marketplace/posts/update', seller,
        { id: tutoring.id, authorPublicKey: seller.pk, title: 'Maths tutoring, years 7-10', credits: 10, priceType: 'hourly' });
    assert(wording.status === 200 && wording.body?.post?.title === 'Maths tutoring, years 7-10',
        `an edit that sends the same price back goes through (${wording.status} ${JSON.stringify(wording.body?.error)})`);

    // Forced anyway: the price in the database doubled under the held deal.
    db.prepare('UPDATE posts SET credits = 20 WHERE id = ?').run(tutoring.id);
    const buyerBeforeA = bal(buyer.pk), sellerBeforeA = bal(seller.pk);
    completePostTransaction(dealA.id, buyer.pk, 3);
    assert(bal(buyer.pk) === buyerBeforeA, `the buyer pays nothing more at completion (${bal(buyer.pk)} vs ${buyerBeforeA})`);
    assert(bal(seller.pk) === r4(sellerBeforeA + 30 * 0.985), `the seller is paid the agreed 30, less the fee (${bal(seller.pk)})`);
    assert(bal(`escrow_${dealA.id}`) === 0, 'the escrow is empty');

    // (b) More hours than booked, still at the deal's rate: 2 booked at 10, 3 worked, the rate forced to 25.
    const gardening = createPost('offer', 'garden', 'Gardening', 'By the hour', 10, 'hourly', seller.pk)!;
    const dealB = acceptPost(gardening.id, buyer.pk, 2);
    db.prepare('UPDATE posts SET credits = 25 WHERE id = ?').run(gardening.id);
    const buyerBeforeB = bal(buyer.pk), sellerBeforeB = bal(seller.pk);
    completePostTransaction(dealB.id, buyer.pk, 3);
    assert(bal(buyer.pk) === buyerBeforeB - 10, `the extra hour costs the buyer the deal's 10, not 25 × 3 − 20 (${bal(buyer.pk)} vs ${buyerBeforeB})`);
    assert(bal(seller.pk) === r4(sellerBeforeB + 30 * 0.985), `the seller is paid 3 hours at 10 (${bal(seller.pk)})`);
    const rowB = db.prepare('SELECT credits, hours FROM marketplace_transactions WHERE id = ?').get(dealB.id) as { credits: number; hours: number };
    assert(rowB.credits === 30 && rowB.hours === 3, `the deal records 30 for 3 hours (${JSON.stringify(rowB)})`);

    // (c) A Need at 10 an hour, 2 hours. Its author (who pays) tries to lower the rate: refused once asked for, and
    //     once held.
    const author = makeMember('FenceOwner', 300);
    const helper = makeMember('FenceHelper', 20);
    const fence = createPost('need', 'work', 'Fence repair', 'By the hour', 10, 'hourly', author.pk)!;
    const dealC = requestPost(fence.id, helper.pk, 2);
    const lowerAsked = await signedFetch('POST', '/api/marketplace/posts/update', author, { id: fence.id, authorPublicKey: author.pk, credits: 5 });
    assert(refusedWith(lowerAsked, PRICE_FROZEN),
        `the Need's author can't lower the rate once help is asked for (${lowerAsked.status} ${JSON.stringify(lowerAsked.body)})`);
    approvePostRequest(dealC.id, author.pk);
    assert(bal(`escrow_${dealC.id}`) === 20, 'the author\'s 20 (2 hours at 10) is held');
    const lowerHeld = await signedFetch('POST', '/api/marketplace/posts/update', author, { id: fence.id, authorPublicKey: author.pk, credits: 5 });
    assert(refusedWith(lowerHeld, PRICE_FROZEN), `nor while it is held (${lowerHeld.status})`);
    assert(postCredits(fence.id) === 10, 'the listing still says 10');

    db.prepare('UPDATE posts SET credits = 5 WHERE id = ?').run(fence.id);
    const authorBeforeC = bal(author.pk), helperBeforeC = bal(helper.pk);
    completePostTransaction(dealC.id, author.pk, 2);
    assert(bal(helper.pk) === r4(helperBeforeC + 20 * 0.985), `the helper is paid the agreed 20, less the fee (${bal(helper.pk)})`);
    assert(bal(author.pk) === authorBeforeC, `the author gets nothing back that was agreed (${bal(author.pk)} vs ${authorBeforeC})`);

    // (d) A deal that is over frees the price.
    const lessons = createPost('offer', 'education', 'Guitar lessons', 'By the hour', 12, 'hourly', seller.pk)!;
    const dealD = acceptPost(lessons.id, buyer.pk, 1);
    cancelPostTransaction(dealD.id, buyer.pk);
    const freed = await signedFetch('POST', '/api/marketplace/posts/update', seller, { id: lessons.id, authorPublicKey: seller.pk, credits: 15 });
    assert(freed.status === 200 && postCredits(lessons.id) === 15, `once the deal is cancelled the price can change (${freed.status} ${JSON.stringify(freed.body?.error)})`);

    const audit = runLedgerAudit();
    assert(Math.abs(audit.drift) < 0.0001, `the ledger has no drift at the end (${audit.drift})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
