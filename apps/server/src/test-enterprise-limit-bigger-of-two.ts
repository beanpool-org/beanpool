/**
 * An enterprise's limit is the bigger of its opening line or its keepers' pledges, never both (Marty, 21 Oct; #2313's
 * residuals 1 and 2), over HTTPS through the real middleware. The spend check (getEnterpriseUnderlyingFloor, getBalance's
 * floor and usableFloor) reads the engine's computation (engine enterpriseAllowance): it used to add the enterprise's own
 * members.earned_credit, which createTreasury sets to its opening line, so at spending the line stacked on the pledges. And
 * only earned pledges clear a line for good (clearOpeningLineOncePledged): a known pledge counts only with the confirmation
 * dial on, so a line it cleared left the enterprise with neither once the dial went off.
 *
 *   1. the three measured rows, an opening line of 200 (createTreasury, the real path): 0 pledged is -200, 100 pledged is
 *      -200 (never -300), 300 pledged is -300 (never -500), in the spend check, the balance read and the engine alike
 *   2. a spend the old rule allowed: 200 line + 100 pledged, a 250-Bean spend is refused with the balance check's words
 *      and moves nothing; 200 goes through and one Bean more doesn't
 *   3. an enterprise already deeper than its new limit (it owes 280 on 200 + 100, as the old -300 let it): nothing is
 *      clawed back, it is spend-frozen, a spend is refused, and it can still receive: a sale moves it up
 *   4. a known pledge no longer clears a line: a confirmed keeper joins with a known 200 (bindApprovedKeeper) and tops up
 *      100 (pledgeEnterpriseBacking): the line stays, -300 with the dial on, and -200 (the line, never 0) with it off
 *   5. an earned pledge still does: a keeper's earned 205 (with a known 100 beside it) clears a 200 line, and so does an
 *      earned pledge of 300 (row 1's third enterprise, pledgeEnterpriseBacking)
 *   6. a stored line a known pledge cleared before (as origin/main wrote it): nothing is restored, and
 *      openingLinesClearedByKnownPledges counts it (and one more that may have held the grandfathered 200), never the
 *      lines cleared by earned pledges or still standing
 *   7. conservation: the balances still add up to zero
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-enterprise-limit-bigger-of-two.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'BiggerOfTwo123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import * as se from './state-engine.js';
import {
    initStateEngine, seedGenesisMember, createPost, createTreasury, getBalance, getEnterpriseUnderlyingFloor,
    getMemberTrustProfile, adminAssignTreasuryOperator, getCommonsBalanceExact,
} from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
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

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/**
 * An enterprise as an admin starts one, with an opening line (createTreasury writes it as the legacy floor and as its own
 * earned_credit), and five live offers (the most the offer bands let it spend).
 */
function makeEnterprise(name: string, line: number): { pk: string; offer: string } {
    const { publicKey: pk } = createTreasury(name, AVATAR, line);
    let offer = '';
    for (let i = 0; i < 5; i++) offer = createPost('offer', 'produce', `${name} goods ${i}`, 'Goods', 10, 'fixed', pk)!.id;
    return { pk, offer };
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

/** Completed trades with `n` different members: earned credit, as the derived-floor suite builds it. */
function earnByTrading(member: Id, n: number): number {
    for (let i = 0; i < n; i++) {
        const peer = makeMember(`${member.name}'s peer ${i}`);
        const post = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'misc', 'goods', 'goods', 100, ?, 'completed')`)
            .run(post, peer.pk);
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 100, 'completed')`)
            .run(`mtx-${crypto.randomUUID()}`, post, member.pk, peer.pk);
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
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sink = makeMember('Sink');
    for (let i = 0; i < 2; i++) createPost('offer', 'produce', `Sink goods ${i}`, 'Goods', 10, 'fixed', sink.pk);
    const dial = async (on: boolean) => {
        const r = await call('POST', null, '/api/local/admin/known-floor', { confirmation: on }, owner);
        assert(r.status === 200 && r.body?.confirmation === on, `the owner turns the confirmation dial ${on ? 'on' : 'off'} (${show(r)})`);
    };

    // The figures every check reads: the spend check's floor, the balance read over HTTPS (any member may read an
    // enterprise's), the engine's (the badge, the enterprise page), and the floor a spend is held to.
    const floors = async (co: string) => {
        clearEnterpriseFloorCache(db, co);
        const read = await call('GET', sink, `/api/ledger/balance/${co}`);
        return {
            spend: getEnterpriseUnderlyingFloor(co).floor, http: read.body?.floor, httpUsable: read.body?.usableFloor,
            httpFrozen: read.body?.frozen, engine: getEnterpriseFloor(db, co).floor, balance: getBalance(co).balance,
        };
    };
    const allAt = (f: Awaited<ReturnType<typeof floors>>, floor: number) =>
        f.spend === floor && f.http === floor && f.httpUsable === floor && f.engine === floor;
    // A keeper spends for their enterprise as the app does, signed, through the real routes: the enterprise's Need of
    // `beans`, Sink offers to do it (refused there when the enterprise can't pay it), and the keeper approves, which puts
    // the Beans in escrow. A refusal counts only as the floor's: the Need was posted, the words are the balance check's,
    // and nothing moved.
    const spendAs = async (keeper: Id, co: string, beans: number) => {
        const need = await call('POST', keeper, `/api/treasury/${co}/need`, { title: `Help wanted ${crypto.randomUUID().slice(0, 6)}`, category: 'work', credits: beans });
        const before = getBalance(co).balance;
        const bid = await call('POST', sink, '/api/marketplace/posts/request', { postId: need.body?.post?.id, buyerPublicKey: sink.pk });
        const approved = bid.status === 200 ? await call('POST', keeper, `/api/treasury/${co}/approve`, { transactionId: bid.body?.transaction?.id }) : null;
        const stop = approved && approved.status !== 200 ? approved : bid.status !== 200 ? bid : null;
        return { posted: need.status === 200, ok: approved?.status === 200, why: stop ? show(stop) : '', moved: Math.round((before - getBalance(co).balance) * 100) / 100 };
    };
    type Spend = Awaited<ReturnType<typeof spendAs>>;
    const refused = (s: Spend) => s.posted && !s.ok && /Insufficient balance to request this post/.test(s.why) && s.moved === 0;
    const spent = (s: Spend, beans: number) => s.posted && s.ok && s.moved === beans;
    const said = (s: Spend) => `${s.posted ? '' : 'NOT POSTED '}${s.ok ? 'approved' : s.why}, moved ${s.moved}`;
    const pledge = (keeper: Id, co: string, amount: number) => call('POST', keeper, `/api/enterprise/${co}/backing`, { amount });
    const join = async (member: Id, co: string, pledged: number, approver: Id) => {
        const asked = await call('POST', member, `/api/enterprise/${co}/keepers/request`, { pledgedBacking: pledged });
        assert(asked.status === 200 && typeof asked.body?.request?.id === 'string', `${member.name} asks to join, pledging ${pledged} (${show(asked)})`);
        return call('POST', approver, `/api/enterprise/${co}/keepers/requests/${asked.body?.request?.id}/approve`, {});
    };
    const line = (co: string) => (db.prepare('SELECT legacy_credit_floor AS l FROM members WHERE public_key = ?').get(co) as { l: number | null }).l;
    const ownLine = (co: string) => (db.prepare('SELECT earned_credit AS e FROM members WHERE public_key = ?').get(co) as { e: number | null }).e;
    const pledgeRows = (co: string) => (db.prepare('SELECT id, amount FROM enterprise_pledges WHERE enterprise = ? AND released_at IS NULL ORDER BY id').all(co) as { id: string; amount: number }[])
        .map(r => `${r.id.startsWith('known:') ? 'known' : 'earned'} ${r.amount}`).sort();

    const eve = makeMember('Eve');
    const eveEarned = earnByTrading(eve, 10);
    const finn = makeMember('Finn');
    const finnEarned = earnByTrading(finn, 10);
    assert(eveEarned >= 300 && finnEarned >= 300, `Eve and Finn each have at least 300 of earned credit from their trades (${eveEarned}, ${finnEarned})`);

    // ── 1. the three measured rows ───────────────────────────────────────────────────────────────
    console.log('── 1. a 200 line with 0, 100 and 300 pledged ──');
    const lineCo = makeEnterprise('Line Co', 200);
    adminAssignTreasuryOperator(lineCo.pk, eve.pk, 'admin');
    assert(line(lineCo.pk) === 200 && ownLine(lineCo.pk) === 200,
        `createTreasury writes the opening line twice: the legacy floor 200 and the enterprise's own earned_credit 200 (${line(lineCo.pk)}, ${ownLine(lineCo.pk)})`);
    const r0 = await floors(lineCo.pk);
    assert(allAt(r0, -200), `200 line, 0 pledged: -200 in the spend check, the balance read and the engine (${JSON.stringify(r0)})`);

    const eggs = makeEnterprise('Eggs Co', 200);
    adminAssignTreasuryOperator(eggs.pk, eve.pk, 'admin');
    const eggsPledge = await pledge(eve, eggs.pk, 100);
    const r1 = await floors(eggs.pk);
    assert(eggsPledge.status === 200 && line(eggs.pk) === 200 && JSON.stringify(pledgeRows(eggs.pk)) === JSON.stringify(['earned 100']),
        `Eve pledges 100 of earned credit to Eggs Co: below its line, which stays (${show(eggsPledge)}; line ${line(eggs.pk)})`);
    assert(allAt(r1, -200), `200 line, 100 pledged: -200, the bigger of the two, never -300 the two added (${JSON.stringify(r1)})`);

    const big = makeEnterprise('Big Co', 200);
    adminAssignTreasuryOperator(big.pk, finn.pk, 'admin');
    const bigPledge = await pledge(finn, big.pk, 300);
    const r3 = await floors(big.pk);
    assert(bigPledge.status === 200 && allAt(r3, -300), `200 line, 300 pledged: -300, the pledges, never -500 (${show(bigPledge)}; ${JSON.stringify(r3)})`);

    // ── 2. a spend the old rule allowed ──────────────────────────────────────────────────────────
    console.log('── 2. a spend past the bigger of the two ──');
    const s250 = await spendAs(eve, eggs.pk, 250);
    assert(refused(s250) && getBalance(eggs.pk).balance === 0, `a 250-Bean spend for Eggs Co is refused and moves nothing: the old -300 let it through (${said(s250)})`);
    const s200 = await spendAs(eve, eggs.pk, 200);
    assert(spent(s200, 200), `a 200-Bean spend, to its limit, goes through (${said(s200)})`);
    const s1 = await spendAs(eve, eggs.pk, 1);
    assert(refused(s1) && getBalance(eggs.pk).balance === -200, `one Bean more is refused: Eggs Co owes 200, no more (${said(s1)}; ${getBalance(eggs.pk).balance})`);
    const sBig = await spendAs(finn, big.pk, 301);
    const sBigOk = await spendAs(finn, big.pk, 300);
    assert(refused(sBig) && spent(sBigOk, 300), `Big Co may spend 300 and not 301 (${said(sBig)}; ${said(sBigOk)})`);

    // ── 3. already deeper than its new limit ─────────────────────────────────────────────────────
    console.log('── 3. an enterprise that owes more than its new limit ──');
    const deep = makeEnterprise('Deep Co', 200);
    adminAssignTreasuryOperator(deep.pk, eve.pk, 'admin');
    assert((await pledge(eve, deep.pk, 100)).status === 200, 'Eve pledges 100 to Deep Co, beside its 200 line');
    // It owes 280, as the old -300 let it: a line of 300 stands in for that limit here, then goes back to 200.
    db.prepare('UPDATE members SET legacy_credit_floor = 300 WHERE public_key = ?').run(deep.pk);
    const sOld = await spendAs(eve, deep.pk, 280);
    db.prepare('UPDATE members SET legacy_credit_floor = 200 WHERE public_key = ?').run(deep.pk);
    const f3 = await floors(deep.pk);
    assert(spent(sOld, 280) && allAt(f3, -200) && f3.balance === -280 && f3.httpFrozen === true && getBalance(deep.pk).frozen === true,
        `Deep Co reads -200 and still owes 280: spend-frozen, nothing clawed back (${said(sOld)}; ${JSON.stringify(f3)})`);
    const sDeep = await spendAs(eve, deep.pk, 1);
    assert(refused(sDeep) && getBalance(deep.pk).balance === -280, `a 1-Bean spend is refused (${said(sDeep)}; ${getBalance(deep.pk).balance})`);
    const bea = makeMember('Bea');
    db.prepare('UPDATE members SET earned_credit = 500 WHERE public_key = ?').run(bea.pk);
    for (let i = 0; i < 5; i++) createPost('offer', 'produce', `Bea goods ${i}`, 'Goods', 10, 'fixed', bea.pk);
    const bought = await call('POST', bea, '/api/marketplace/posts/accept', { postId: deep.offer, buyerPublicKey: bea.pk });
    const done = await call('POST', bea, '/api/marketplace/transactions/complete', { transactionId: bought.body?.transaction?.id, confirmerPublicKey: bea.pk });
    const afterSale = getBalance(deep.pk);
    assert(bought.status === 200 && done.status === 200 && afterSale.balance > -280 && afterSale.balance < -200 && afterSale.frozen === true,
        `it can still receive: Bea buys one of its offers and it climbs to ${afterSale.balance}, still spend-frozen below -200 (${show(bought)}; ${show(done)})`);

    // ── 4. a known pledge no longer clears a line ────────────────────────────────────────────────
    console.log('── 4. a known pledge leaves the line standing ──');
    await dial(true);
    const gus = makeMember('Gus');
    confirm(gus, ada);
    createPost('offer', 'produce', 'Gus mends fences', 'Fences', 10, 'fixed', gus.pk);
    const known = makeEnterprise('Known Co', 200);
    const gusIn = await join(gus, known.pk, 200, ada);
    assert(gusIn.status === 200 && gusIn.body?.applied === true && JSON.stringify(pledgeRows(known.pk)) === JSON.stringify(['known 200']),
        `an admin approves Gus at once: one known row of 200 (${show(gusIn)}; ${pledgeRows(known.pk)})`);
    assert(line(known.pk) === 200, `the known 200 reaches the line but doesn't clear it: the line is still 200 (${line(known.pk)})`);
    const f4 = await floors(known.pk);
    assert(allAt(f4, -200), `Known Co reads -200, the bigger of its line and its known 200 (${JSON.stringify(f4)})`);
    const gusTop = await pledge(gus, known.pk, 100);
    const f4b = await floors(known.pk);
    assert(gusTop.status === 200 && line(known.pk) === 200 && allAt(f4b, -300),
        `Gus tops up 100 (known): -300, its pledges, and the line still stands at 200 (${show(gusTop)}; line ${line(known.pk)}; ${JSON.stringify(f4b)})`);
    await dial(false);
    const f4c = await floors(known.pk);
    assert(allAt(f4c, -200), `with the dial off the known 300 counts 0 and the line is still there: -200, never 0 (${JSON.stringify(f4c)})`);
    await dial(true);

    // ── 5. an earned pledge still does ───────────────────────────────────────────────────────────
    console.log('── 5. an earned pledge clears the line ──');
    const hal = makeMember('Hal');
    confirm(hal, ada);
    const halEarned = earnByTrading(hal, 6);
    assert(halEarned >= 200 && halEarned < 300, `Hal has ${halEarned} of earned credit from his trades`);
    const earned = makeEnterprise('Earned Co', 200);
    const halIn = await join(hal, earned.pk, halEarned + 100, ada);
    assert(halIn.status === 200 && JSON.stringify(pledgeRows(earned.pk)) === JSON.stringify([`earned ${halEarned}`, 'known 100']),
        `Hal joins Earned Co with ${halEarned + 100}: ${halEarned} earned, 100 known (${show(halIn)}; ${pledgeRows(earned.pk)})`);
    const f5 = await floors(earned.pk);
    assert(line(earned.pk) === null && allAt(f5, -(halEarned + 100)),
        `his earned ${halEarned} reaches the line and clears it: -${halEarned + 100}, his pledges (line ${line(earned.pk)}; ${JSON.stringify(f5)})`);
    assert(line(big.pk) === null, `Finn's earned pledge of 300 (POST /backing) cleared Big Co's line too (${line(big.pk)})`);

    // ── 6. a line a known pledge cleared before ──────────────────────────────────────────────────
    console.log('── 6. a stored line from before ──');
    // origin/main has no openingLinesClearedByKnownPledges: looked up by name so the rest of this suite still runs there.
    const count = (se as Record<string, unknown>).openingLinesClearedByKnownPledges as undefined | (() => { enterprises: number; maybe: number });
    const before = count?.() ?? { enterprises: NaN, maybe: NaN };
    assert(before.enterprises === 0 && before.maybe === 0,
        `no line has been lost to a known pledge yet: Known Co's stands, Earned Co's and Big Co's went to earned pledges (${JSON.stringify(before)})`);
    // What origin/main's persisted clear wrote for a known 200 joining pledge to a 200 line: the line gone.
    const ivy = makeMember('Ivy');
    confirm(ivy, ada);
    const lost = makeEnterprise('Lost Co', 200);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing) VALUES (?, ?, 'keeper', ?, 200)").run(lost.pk, ivy.pk, ada.pk);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(ivy.pk);
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, 200, ?)').run(`known:${crypto.randomUUID()}`, ivy.pk, lost.pk, ago(DAY));
    db.prepare('UPDATE members SET legacy_credit_floor = NULL WHERE public_key = ?').run(lost.pk);
    // And one from before Slice 4 with nothing on record for its line (the grandfathered 200, or none at all).
    const old = makeEnterprise('Old Co', 0);
    db.prepare("INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing) VALUES (?, ?, 'keeper', ?, 250)").run(old.pk, ivy.pk, ada.pk);
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, 250, ?)').run(`known:${crypto.randomUUID()}`, ivy.pk, old.pk, ago(DAY));
    const after = count?.() ?? { enterprises: NaN, maybe: NaN };
    assert(after.enterprises === 1 && after.maybe === 1,
        `openingLinesClearedByKnownPledges counts Lost Co, and Old Co as one that may have held the grandfathered 200 (${JSON.stringify(after)})`);
    const f6 = await floors(lost.pk);
    assert(line(lost.pk) === null && allAt(f6, -200), `nothing is restored: Lost Co's line is still gone, -200 from the known pledge (${JSON.stringify(f6)})`);

    // ── 7. conservation ─────────────────────────────────────────────────────────────────────────
    console.log('── 7. conservation ──');
    const sum = (db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'").get() as { s: number }).s;
    assert(Math.abs(sum + getCommonsBalanceExact()) < 1e-6, `every balance and the commons still add up to zero (${sum + getCommonsBalanceExact()})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
