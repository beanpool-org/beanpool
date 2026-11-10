/**
 * An enterprise's limit is its keepers' pledges, never its opening line stacked on them (Marty, 21 Oct; #2313's residuals 1
 * and 2), over HTTPS through the real middleware. The spend check (getEnterpriseUnderlyingFloor, getBalance's floor and
 * usableFloor) reads the engine's computation (engine enterpriseAllowance): it used to add the enterprise's own
 * members.earned_credit, which createTreasury sets to its opening line, so at spending the line stacked on the pledges.
 * Since E29 (Marty's yes, 10 Nov 2026) the grandfathered line is gone altogether: the bigger-of-the-two rule this suite was
 * written for is now "the pledges alone", and every check below reads that rule on the same scenarios. An opening line is
 * still written, as the enterprise's own earned_credit_c, and no floor reads it.
 *
 *   1. the three measured rows, an opening line of 200 (createTreasury, the real path): 0 pledged is 0, 100 pledged is
 *      -100 (never -300 the two added, nor the -200 line), 300 pledged is -300 (never -500), in the spend check, the balance
 *      read and the engine alike; no legacy_credit_floor column is left
 *   2. a spend the old rules allowed: 200 line + 100 pledged, a 150-Bean spend (the old bigger-of-two -200 let it, the
 *      stacked -300 too) is refused with the balance check's words and moves nothing; 100 goes through and one Bean more
 *      doesn't
 *   3. an enterprise already deeper than its limit (it owes 280 on a pledge of 100, as the old stacked -300 let it):
 *      nothing is clawed back, it is spend-frozen, a spend is refused, and it can still receive: a sale moves it up
 *   4. a known pledge with no line behind it: a confirmed keeper joins with a known 200 (bindApprovedKeeper) and tops up 100
 *      (pledgeEnterpriseBacking): -200, then -300 with the dial on, and 0 with it off (no line holds it at -200 any more)
 *   5. an earned pledge: a keeper's earned 205.71 (with a known 100 beside it) reads its pledges, beside a stored 200 line
 *      that counts nothing, and so does an earned pledge of 300 (row 1's third enterprise)
 *   6. a line a known pledge cleared before (as origin/main wrote it): there is no line to restore and nothing to count
 *      (openingLinesClearedByKnownPledges is gone with the line); the known pledges read as pledges
 *   7. conservation: the balances still add up to exactly zero
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-enterprise-limit-bigger-of-two.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import * as se from './state-engine.js';
import {
    initStateEngine, seedGenesisMember, createPost as rawCreatePost, createTreasury, getBalance, getEnterpriseUnderlyingFloor,
    getMemberTrustProfile, adminAssignTreasuryOperator, getCommonsBalanceExact,
} from './state-engine.js';
import { wrapCreatePost, TEST_PHOTOS } from './post-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto, getEnterpriseFloor, clearEnterpriseFloorCache } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100). `hc` turns a Beans figure into hundredths
 * at the door and `beansOf` turns one back for a message: exact for every figure here, each being whole hundredths.
 */
const hc = (beans: number) => Math.round(beans * 100);
const beansOf = (hundredths: number) => hundredths / 100;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/**
 * An enterprise as an admin starts one, with an opening line of `line` Beans (createTreasury writes it as its own
 * earned_credit_c, which no floor reads since E29), and five live offers (the most the offer bands let it spend).
 */
function makeEnterprise(name: string, line: number): { pk: string; offer: string } {
    const { publicKey: pk } = createTreasury(name, AVATAR, hc(line));
    let offer = '';
    for (let i = 0; i < 5; i++) offer = createPost('offer', 'produce', `${name} goods ${i}`, 'Goods', hc(10), 'fixed', pk)!.id;
    return { pk, offer };
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

/** Completed trades of 100 Beans with `n` different members: earned credit (whole hundredths), as the derived-floor suite builds it. */
function earnByTrading(member: Id, n: number): number {
    for (let i = 0; i < n; i++) {
        const peer = makeMember(`${member.name}'s peer ${i}`);
        const post = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'goods', ?, ?, 'completed')`)
            .run(post, hc(100), peer.pk);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
            .run(`mtx-${crypto.randomUUID()}`, post, member.pk, peer.pk, hc(100));
    }
    return getMemberTrustProfile(member.pk).earnedCredit;
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
        const nonce = crypto.randomBytes(16).toString('hex');
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

async function main(): Promise<void> {
    console.log('An enterprise\'s limit is the bigger of its opening line or its pledges, over HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sink = makeMember('Sink');
    for (let i = 0; i < 2; i++) createPost('offer', 'produce', `Sink goods ${i}`, 'Goods', hc(10), 'fixed', sink.pk);
    const dial = async (on: boolean) => {
        const r = await call('POST', null, '/api/local/admin/community-shape', { changes: { knownFloor: { on: on } } }, owner);
        assert(r.status === 200 && r.body?.shape?.settings?.knownFloor?.value?.on === on, `the owner turns the confirmation dial ${on ? 'on' : 'off'} (${show(r)})`);
    };

    // The figures every check reads (whole hundredths): the spend check's floor, the balance read over HTTPS (any member
    // may read an enterprise's), the engine's (the badge, the enterprise page), and the floor a spend is held to.
    const floors = async (co: string) => {
        clearEnterpriseFloorCache(db, co);
        const read = await call('GET', sink, `/api/ledger/balance/${co}`);
        return {
            spend: getEnterpriseUnderlyingFloor(co).floor, http: read.body?.floor_c, httpUsable: read.body?.usableFloor_c,
            httpFrozen: read.body?.frozen, engine: getEnterpriseFloor(db, co).floor, balance: getBalance(co).balance_c,
        };
    };
    const allAt = (f: Awaited<ReturnType<typeof floors>>, floor: number) =>
        f.spend === floor && f.http === floor && f.httpUsable === floor && f.engine === floor;
    // A keeper spends for their enterprise as the app does, signed, through the real routes: the enterprise's Need of
    // `beans`, Sink offers to do it (refused there when the enterprise can't pay it), and the keeper approves, which puts
    // the Beans in escrow. A refusal counts only as the floor's: the Need was posted, the words are the balance check's,
    // and nothing moved.
    const spendAs = async (keeper: Id, co: string, beans: number) => {
        const need = await call('POST', keeper, `/api/treasury/${co}/need`, { title: `Help wanted ${crypto.randomUUID().slice(0, 6)}`, category: 'work', price_c: hc(beans), photos: TEST_PHOTOS });
        const before = getBalance(co).balance_c;
        const bid = await call('POST', sink, '/api/marketplace/posts/request', { postId: need.body?.post?.id, buyerPublicKey: sink.pk });
        const approved = bid.status === 200 ? await call('POST', keeper, `/api/treasury/${co}/approve`, { transactionId: bid.body?.transaction?.id }) : null;
        const stop = approved && approved.status !== 200 ? approved : bid.status !== 200 ? bid : null;
        return { posted: need.status === 200, ok: approved?.status === 200, why: stop ? show(stop) : '', moved: before - getBalance(co).balance_c };
    };
    type Spend = Awaited<ReturnType<typeof spendAs>>;
    const refused = (s: Spend) => s.posted && !s.ok && /Insufficient balance to request this post/.test(s.why) && s.moved === 0;
    const spent = (s: Spend, beans: number) => s.posted && s.ok && s.moved === hc(beans);
    const said = (s: Spend) => `${s.posted ? '' : 'NOT POSTED '}${s.ok ? 'approved' : s.why}, moved ${beansOf(s.moved)}`;
    const pledge = (keeper: Id, co: string, amount: number) => call('POST', keeper, `/api/enterprise/${co}/backing`, { amount_c: hc(amount) });
    /** A join by request with a pledge of `pledged` hundredths, approved by `approver`. */
    const join = async (member: Id, co: string, pledged: number, approver: Id) => {
        const asked = await call('POST', member, `/api/enterprise/${co}/keepers/request`, { pledgedBacking_c: pledged });
        assert(asked.status === 200 && typeof asked.body?.request?.id === 'string', `${member.name} asks to join, pledging ${beansOf(pledged)} (${show(asked)})`);
        return call('POST', approver, `/api/enterprise/${co}/keepers/requests/${asked.body?.request?.id}/approve`, {});
    };
    /** Does `table` still have the column `column`? */
    const hasColumn = (table: string, column: string) => !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column);
    const ownLine = (co: string) => (db.prepare('SELECT earned_credit_c AS e FROM members WHERE public_key = ?').get(co) as { e: number | null }).e;
    const pledgeRows = (co: string) => (db.prepare('SELECT id, amount_c FROM enterprise_pledges WHERE enterprise = ? AND released_at IS NULL ORDER BY id').all(co) as { id: string; amount_c: number }[])
        .map(r => `${r.id.startsWith('known:') ? 'known' : 'earned'} ${beansOf(r.amount_c)}`).sort();

    const eve = makeMember('Eve');
    const eveEarned = earnByTrading(eve, 10);
    const finn = makeMember('Finn');
    const finnEarned = earnByTrading(finn, 10);
    assert(eveEarned >= hc(300) && finnEarned >= hc(300), `Eve and Finn each have at least 300 of earned credit from their trades (${beansOf(eveEarned)}, ${beansOf(finnEarned)})`);

    // ── 1. the three measured rows ───────────────────────────────────────────────────────────────
    console.log('── 1. a 200 line with 0, 100 and 300 pledged: the pledges alone ──');
    const lineCo = makeEnterprise('Line Co', 200);
    adminAssignTreasuryOperator(lineCo.pk, eve.pk, 'admin');
    assert(!hasColumn('members', 'legacy_credit_floor') && ownLine(lineCo.pk) === hc(200),
        `createTreasury writes the opening line once, as the enterprise's own earned_credit_c 200; the legacy floor is gone (E29) (${ownLine(lineCo.pk)})`);
    const r0 = await floors(lineCo.pk);
    assert(allAt(r0, 0), `200 line, 0 pledged: 0 in the spend check, the balance read and the engine: the line counts nothing (${JSON.stringify(r0)})`);

    const eggs = makeEnterprise('Eggs Co', 200);
    adminAssignTreasuryOperator(eggs.pk, eve.pk, 'admin');
    const eggsPledge = await pledge(eve, eggs.pk, 100);
    const r1 = await floors(eggs.pk);
    assert(eggsPledge.status === 200 && ownLine(eggs.pk) === hc(200) && JSON.stringify(pledgeRows(eggs.pk)) === JSON.stringify(['earned 100']),
        `Eve pledges 100 of earned credit to Eggs Co, beside its stored 200 line (${show(eggsPledge)}; own line ${ownLine(eggs.pk)})`);
    assert(allAt(r1, hc(-100)), `200 line, 100 pledged: -100, the pledge, never -300 the two added nor the -200 line (${JSON.stringify(r1)})`);

    const big = makeEnterprise('Big Co', 200);
    adminAssignTreasuryOperator(big.pk, finn.pk, 'admin');
    const bigPledge = await pledge(finn, big.pk, 300);
    const r3 = await floors(big.pk);
    assert(bigPledge.status === 200 && allAt(r3, hc(-300)), `200 line, 300 pledged: -300, the pledges, never -500 (${show(bigPledge)}; ${JSON.stringify(r3)})`);

    // ── 2. a spend the old rules allowed ─────────────────────────────────────────────────────────
    console.log('── 2. a spend past the pledges ──');
    const s150 = await spendAs(eve, eggs.pk, 150);
    assert(refused(s150) && getBalance(eggs.pk).balance_c === 0, `a 150-Bean spend for Eggs Co is refused and moves nothing: the old -200 and -300 let it through (${said(s150)})`);
    const s100 = await spendAs(eve, eggs.pk, 100);
    assert(spent(s100, 100), `a 100-Bean spend, to its limit, goes through (${said(s100)})`);
    const s1 = await spendAs(eve, eggs.pk, 1);
    assert(refused(s1) && getBalance(eggs.pk).balance_c === hc(-100), `one Bean more is refused: Eggs Co owes 100, no more (${said(s1)}; ${getBalance(eggs.pk).balance_c} hundredths)`);
    const sBig = await spendAs(finn, big.pk, 301);
    const sBigOk = await spendAs(finn, big.pk, 300);
    assert(refused(sBig) && spent(sBigOk, 300), `Big Co may spend 300 and not 301 (${said(sBig)}; ${said(sBigOk)})`);

    // ── 3. already deeper than its limit ─────────────────────────────────────────────────────────
    console.log('── 3. an enterprise that owes more than its limit ──');
    const deep = makeEnterprise('Deep Co', 200);
    adminAssignTreasuryOperator(deep.pk, eve.pk, 'admin');
    assert((await pledge(eve, deep.pk, 100)).status === 200, 'Eve pledges 100 to Deep Co, beside its 200 line');
    // It owes 280, as the old stacked -300 let it: Eve's pledge row at 300 stands in for that limit here, then goes back to 100.
    const evePledgeTo = (co: string, amount_c: number) => db.prepare('UPDATE enterprise_pledges SET amount_c = ? WHERE enterprise = ? AND keeper = ? AND released_at IS NULL').run(amount_c, co, eve.pk);
    evePledgeTo(deep.pk, hc(300));
    clearEnterpriseFloorCache(db, deep.pk);
    const sOld = await spendAs(eve, deep.pk, 280);
    evePledgeTo(deep.pk, hc(100));
    const f3 = await floors(deep.pk);
    assert(spent(sOld, 280) && allAt(f3, hc(-100)) && f3.balance === hc(-280) && f3.httpFrozen === true && getBalance(deep.pk).frozen === true,
        `Deep Co reads -100 and still owes 280: spend-frozen, nothing clawed back (${said(sOld)}; ${JSON.stringify(f3)})`);
    const sDeep = await spendAs(eve, deep.pk, 1);
    assert(refused(sDeep) && getBalance(deep.pk).balance_c === hc(-280), `a 1-Bean spend is refused (${said(sDeep)}; ${getBalance(deep.pk).balance_c} hundredths)`);
    const bea = makeMember('Bea');
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(500), bea.pk);
    for (let i = 0; i < 5; i++) createPost('offer', 'produce', `Bea goods ${i}`, 'Goods', hc(10), 'fixed', bea.pk);
    const bought = await call('POST', bea, '/api/marketplace/posts/accept', { postId: deep.offer, buyerPublicKey: bea.pk });
    const done = await call('POST', bea, '/api/marketplace/transactions/complete', { transactionId: bought.body?.transaction?.id, confirmerPublicKey: bea.pk });
    const afterSale = getBalance(deep.pk);
    assert(bought.status === 200 && done.status === 200 && afterSale.balance_c > hc(-280) && afterSale.balance_c < hc(-100) && afterSale.frozen === true,
        `it can still receive: Bea buys one of its offers and it climbs to ${beansOf(afterSale.balance_c)}, still spend-frozen below -100 (${show(bought)}; ${show(done)})`);

    // ── 4. a known pledge with no line behind it ─────────────────────────────────────────────────
    console.log('── 4. a known pledge, and no line behind it ──');
    await dial(true);
    const gus = makeMember('Gus');
    confirm(gus, ada);
    createPost('offer', 'produce', 'Gus mends fences', 'Fences', hc(10), 'fixed', gus.pk);
    const known = makeEnterprise('Known Co', 200);
    const gusIn = await join(gus, known.pk, hc(200), ada);
    assert(gusIn.status === 200 && gusIn.body?.applied === true && JSON.stringify(pledgeRows(known.pk)) === JSON.stringify(['known 200']),
        `an admin approves Gus at once: one known row of 200 (${show(gusIn)}; ${pledgeRows(known.pk)})`);
    assert(ownLine(known.pk) === hc(200), `its 200 opening line is still written as its own earned_credit_c, and nothing reads it (${ownLine(known.pk)})`);
    const f4 = await floors(known.pk);
    assert(allAt(f4, hc(-200)), `Known Co reads -200, its known 200 (${JSON.stringify(f4)})`);
    const gusTop = await pledge(gus, known.pk, 100);
    const f4b = await floors(known.pk);
    assert(gusTop.status === 200 && allAt(f4b, hc(-300)),
        `Gus tops up 100 (known): -300, its pledges (${show(gusTop)}; ${JSON.stringify(f4b)})`);
    await dial(false);
    const f4c = await floors(known.pk);
    assert(allAt(f4c, 0), `with the dial off the known 300 counts 0 and no line holds it: 0, never the old -200 (${JSON.stringify(f4c)})`);
    await dial(true);

    // ── 5. an earned pledge still does ───────────────────────────────────────────────────────────
    console.log('── 5. an earned pledge clears the line ──');
    const hal = makeMember('Hal');
    confirm(hal, ada);
    const halEarned = earnByTrading(hal, 6);
    assert(halEarned >= hc(200) && halEarned < hc(300), `Hal has ${beansOf(halEarned)} of earned credit from his trades`);
    const earned = makeEnterprise('Earned Co', 200);
    const halIn = await join(hal, earned.pk, halEarned + hc(100), ada);
    assert(halIn.status === 200 && JSON.stringify(pledgeRows(earned.pk)) === JSON.stringify([`earned ${beansOf(halEarned)}`, 'known 100']),
        `Hal joins Earned Co with ${beansOf(halEarned + hc(100))}: ${beansOf(halEarned)} earned, 100 known (${show(halIn)}; ${pledgeRows(earned.pk)})`);
    const f5 = await floors(earned.pk);
    assert(ownLine(earned.pk) === hc(200) && allAt(f5, -(halEarned + hc(100))),
        `Earned Co reads -${beansOf(halEarned + hc(100))}, his pledges, beside a stored 200 line that counts nothing (own line ${ownLine(earned.pk)}; ${JSON.stringify(f5)})`);
    const bigNow = await floors(big.pk);
    assert(ownLine(big.pk) === hc(200) && bigNow.spend === hc(-300) && bigNow.engine === hc(-300),
        `Finn's earned pledge of 300 (POST /backing) is Big Co's whole limit beside its stored 200 line (${ownLine(big.pk)}; ${JSON.stringify(bigNow)})`);

    // ── 6. a line a known pledge cleared before ──────────────────────────────────────────────────
    console.log('── 6. a stored line from before: nothing to restore, nothing to count ──');
    // The count of lines lost to known pledges went with the line (E29): no line is restored, so none is counted.
    const count = (se as Record<string, unknown>).openingLinesClearedByKnownPledges;
    assert(count === undefined, 'openingLinesClearedByKnownPledges is gone with the legacy line: there is nothing left to count');
    // What origin/main's persisted clear wrote for a known 200 joining pledge to a 200 line: the line gone (now: no line at all).
    const ivy = makeMember('Ivy');
    confirm(ivy, ada);
    const lost = makeEnterprise('Lost Co', 200);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing_c) VALUES (?, ?, 'keeper', ?, ?)").run(lost.pk, ivy.pk, ada.pk, hc(200));
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(ivy.pk);
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount_c, pledged_at) VALUES (?, ?, ?, ?, ?)').run(`known:${crypto.randomUUID()}`, ivy.pk, lost.pk, hc(200), ago(DAY));
    // And one from before Slice 4 with nothing on record for its line (the grandfathered 200, or none at all).
    const old = makeEnterprise('Old Co', 0);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing_c) VALUES (?, ?, 'keeper', ?, ?)").run(old.pk, ivy.pk, ada.pk, hc(250));
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount_c, pledged_at) VALUES (?, ?, ?, ?, ?)').run(`known:${crypto.randomUUID()}`, ivy.pk, old.pk, hc(250), ago(DAY));
    const f6 = await floors(lost.pk);
    assert(allAt(f6, hc(-200)), `nothing to restore: Lost Co reads -200, its known pledge (${JSON.stringify(f6)})`);
    const f6old = await floors(old.pk);
    assert(allAt(f6old, hc(-250)), `and Old Co reads -250, its known pledge, whatever line it once had (${JSON.stringify(f6old)})`);

    // ── 7. conservation ─────────────────────────────────────────────────────────────────────────
    console.log('── 7. conservation ──');
    const sum = (db.prepare("SELECT COALESCE(SUM(balance_c), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'").get() as { s: number }).s;
    assert(sum + getCommonsBalanceExact() === 0, `every balance and the commons still add up to exactly zero (${sum + getCommonsBalanceExact()} hundredths)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
