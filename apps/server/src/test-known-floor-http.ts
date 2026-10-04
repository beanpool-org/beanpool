/**
 * The known floor (community modes slice 4, config/known-floor.ts) over HTTPS, through the real middleware:
 *
 *   1. the dial off (every community today): a confirmed member's floor and usable floor are what main gives, 0, and a
 *      marketplace spend past it is refused
 *   2. only an owner sets the dial, the known floor and the cap; an admin is refused; a known floor above the cap, a cap
 *      above 5,000 or below 2,000 is refused and nothing is written; every change is a line in the log
 *   3. the dial on: a confirmed member with one live offer may spend to -1,000 and no further; with no live offer, none;
 *      an unconfirmed member's floor is unchanged
 *   4. an admin's exception: lowering is logged and never deducts (the member is spend-frozen); a raise only up to the
 *      cap; an admin can't set their own; a member who is no admin is refused
 *   5. the dial off again: the known grant stops applying, nothing is deducted, the member is spend-frozen
 *   6. a cap saved with the dial off changes nothing: a member's and an enterprise's floors are main's (-2,000)
 *   7. a keeper backs an enterprise from their known grant only by a recorded pledge (at most half the grant, off their
 *      own line 1:1): 6 enterprises in turn back 500 in all, not 1,224; a keeper can't step down from, or be unbound
 *      off, the debt their known pledge backs; a lowered floor, a revoked confirmation or the dial off spend-freezes
 *   7b. a freeze never moves a keeper's tier: either freeze, or both, keeps the tier their own known line (the grant less
 *      their counted known pledges) gives them, on their own answer and on their cards
 *   7c. a freeze keeps the amount it froze: a lowered (50), raised (1,500) or default line, with or without known
 *      pledges, keeps its tier frozen, and unfreezing goes back to that amount; money is the frozen line's; restoring the
 *      default clears both; the log reads 50 → frozen → 50. Another member reading the board gets the badge (the tier's
 *      least credit) and the trust profile their Trust Points, never the line itself (50, 1,500, 1,000 less pledges)
 *   8. one member's exception needs an owner's or admin's own key session: no automation token, no node password
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-known-floor-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'KnownFloor123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { tierForCredit, TIER_LEVELS } from '@beanpool/core';
import { initStateEngine, transfer, seedGenesisMember, createPost, acceptPost, completePostTransaction, getBalance, getEnterpriseUnderlyingFloor, getAvailableBacking, pledgeEnterpriseBacking, stepDownAsKeeper, adminRevokeTreasuryOperator, getPosts } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, ownerTokenHeaders, turnOn2faForTests } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
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
type Res = { status: number; body: any; cacheControl?: string | null };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

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

function makeEnterprise(name: string, keepers: Id[], pledges: number[] = []): string {
    const pk = keypair(name).pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active', 1)`).run(pk, name, ago(DAY));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    setMemberPhoto(db, pk, AVATAR);
    keepers.forEach((k, i) => {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(pk, k.pk);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pk);
        if (pledges[i]) db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, ?, ?)')
            .run(crypto.randomUUID(), k.pk, pk, pledges[i], ago(DAY));
    });
    clearEnterpriseFloorCache(db);
    return pk;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
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
    return { status: res.status, body: json, cacheControl: res.headers.get('cache-control') };
}

function sessionHeaders(pub: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

async function main(): Promise<void> {
    console.log('The known floor over HTTPS\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const adaAdmin = sessionHeaders(ada.pk, 'admin');
    const sam = makeMember('Sam', 50);
    const kim = makeMember('Kim');
    const una = makeMember('Una');
    const kimOffer = createPost('offer', 'produce', 'Kim mends bikes', 'Bike repairs', 40, 'fixed', kim.pk)!;
    createPost('offer', 'produce', 'Una bakes', 'Bread', 10, 'fixed', una.pk);
    confirm(kim, ada);
    const samSells = (beans: number) => createPost('offer', 'produce', `Sam's ${beans}-Bean basket`, 'Veg', beans, 'fixed', sam.pk)!.id;
    const buy = (who: Id, postId: string) => call('POST', who, '/api/marketplace/posts/accept', { postId, buyerPublicKey: who.pk });
    const balanceOf = (who: Id) => call('GET', who, `/api/ledger/balance/${who.pk}`);
    const settings = (headers: Record<string, string>, body: unknown) => call('POST', null, '/api/local/admin/known-floor', body, headers);
    const exception = (headers: Record<string, string>, body: unknown) => call('POST', null, '/api/local/admin/known-floor/exception', body, headers);
    const read = () => call('GET', null, '/api/local/admin/known-floor', undefined, owner);

    // ── 1. the dial off: today's floor ─────────────────────────────────────────────────────────
    console.log('── 1. the dial off ──');
    const off = await balanceOf(kim);
    assert(off.status === 200 && off.body?.floor === 0 && off.body?.usableFloor === 0,
        `a confirmed member in a community with the dial off has main's floor, 0 (${show(off)})`);
    const offBuy = await buy(kim, samSells(100));
    assert(offBuy.status >= 400, `and a 100-Bean purchase with nothing held is refused (${show(offBuy)})`);
    const first = await read();
    assert(first.status === 200 && first.body?.confirmation === false && first.body?.knownFloor === 1000 && first.body?.creditCap === 2000 && first.body?.creditCapMax === 5000,
        `the settings read: dial off, known floor 1,000, cap 2,000, cap at most 5,000 (${show(first)})`);

    // ── 2. only an owner sets them; bad values are refused whole ───────────────────────────────
    console.log('── 2. who sets them ──');
    const adminTries = await settings(adaAdmin, { confirmation: true });
    assert(adminTries.status === 403, `an admin can't turn the dial on (${show(adminTries)})`);
    const memberTries = await call('POST', kim, '/api/local/admin/known-floor', { confirmation: true });
    assert(memberTries.status === 401 || memberTries.status === 403, `nor can a member who is no admin (${show(memberTries)})`);
    const aboveCap = await settings(owner, { confirmation: true, knownFloor: 2500 });
    assert(aboveCap.status === 400 && aboveCap.body?.code === 'floor_above_cap', `a known floor above the cap is refused (${show(aboveCap)})`);
    assert((await read()).body?.confirmation === false, 'and nothing in that request was written: the dial is still off');
    const capHigh = await settings(owner, { creditCap: 6000 });
    const capLow = await settings(owner, { creditCap: 1500 });
    assert(capHigh.status === 400 && capLow.status === 400, `a cap above 5,000 or below 2,000 is refused (${show(capHigh)}; ${show(capLow)})`);
    const on = await settings(owner, { confirmation: true });
    assert(on.status === 200 && on.body?.confirmation === true, `the owner turns the dial on (${show(on)})`);

    // ── 3. the dial on ─────────────────────────────────────────────────────────────────────────
    console.log('── 3. the dial on ──');
    const kimOn = await balanceOf(kim);
    assert(kimOn.body?.floor === -1000 && kimOn.body?.usableFloor === -1000,
        `a confirmed member with one live offer may use the whole known floor, -1,000 (${show(kimOn)})`);
    assert(kimOn.body?.knownFrozen === false && typeof kimOn.body?.tier?.name === 'string',
        `with no exception the line is not frozen, and the answer carries her tier (${show(kimOn)})`);
    const unaOn = await balanceOf(una);
    assert(unaOn.body?.floor === 0 && unaOn.body?.usableFloor === 0, `an unconfirmed member's floor is unchanged, 0 (${show(unaOn)})`);
    const b600 = await buy(kim, samSells(600));
    assert(b600.status === 200, `Kim buys a 600-Bean basket on the known floor (${show(b600)})`);
    const b500 = await buy(kim, samSells(500));
    assert(b500.status >= 400, `a 500-Bean one, past -1,000, is refused (${show(b500)})`);
    const b400 = await buy(kim, samSells(400));
    assert(b400.status === 200, `a 400-Bean one, to exactly -1,000, is not (${show(b400)})`);
    assert(Math.abs(getBalance(kim.pk).balance - -1000) < 1e-9, `Kim's balance is -1,000 (${getBalance(kim.pk).balance})`);
    // No live offer: Kim's offer is taken off the market, and no part of the known floor is usable.
    db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(kimOffer.id);
    const noOffer = await balanceOf(kim);
    assert(noOffer.body?.usableFloor === 0 && noOffer.body?.floor === -1000,
        `with no live offer the known floor is still Kim's limit but none of it is usable (${show(noOffer)})`);
    db.prepare("UPDATE posts SET status = 'active' WHERE id = ?").run(kimOffer.id);

    // ── 4. an admin's exception ────────────────────────────────────────────────────────────────
    console.log('── 4. exceptions ──');
    const lower = await exception(adaAdmin, { memberPubkey: kim.pk, amount: 300 });
    assert(lower.status === 200 && lower.body?.exception?.amount === 300, `an admin lowers Kim's known floor to 300 (${show(lower)})`);
    const kimLowered = getBalance(kim.pk);
    assert(Math.abs(kimLowered.balance - -1000) < 1e-9 && kimLowered.usableFloor === -300 && kimLowered.frozen === true,
        `nothing is deducted: Kim still holds -1,000 and is spend-frozen at a -300 floor (${JSON.stringify({ b: kimLowered.balance, u: kimLowered.usableFloor, f: kimLowered.frozen })})`);
    assert(kimLowered.knownFrozen === false, 'a lowered line is not an admin freeze: knownFrozen stays false');
    const frozenBuy = await buy(kim, samSells(10));
    assert(frozenBuy.status >= 400, `while frozen, Kim can't buy (${show(frozenBuy)})`);
    const overCap = await exception(adaAdmin, { memberPubkey: kim.pk, amount: 2500 });
    assert(overCap.status === 400 && overCap.body?.code === 'above_cap', `a raise above the cap is refused (${show(overCap)})`);
    const raise = await exception(adaAdmin, { memberPubkey: kim.pk, amount: 1800 });
    assert(raise.status === 200 && getBalance(kim.pk).usableFloor === -1800, `a raise up to the cap is taken: -1,800 (${show(raise)})`);
    const own = await exception(adaAdmin, { memberPubkey: ada.pk, amount: 2000 });
    assert(own.status === 403 && own.body?.code === 'own_floor', `an admin can't set their own (${show(own)})`);
    const kimTries = await call('POST', kim, '/api/local/admin/known-floor/exception', { memberPubkey: kim.pk, amount: 2000 });
    assert(kimTries.status === 401 || kimTries.status === 403, `a member who is no admin is refused (${show(kimTries)})`);
    const logged = (await read()).body?.log as Array<{ action: string; memberPubkey: string | null; actor: string; oldValue: string; newValue: string }>;
    const actions = logged.map(l => l.action);
    assert(actions.includes('confirmation') && actions.includes('exception_lowered') && actions.includes('exception_raised'),
        `the dial, the lowering and the raise are each a line in the log (${actions.join(',')})`);
    const raiseLine = logged.find(l => l.action === 'exception_raised');
    assert(raiseLine?.actor === ada.pk && raiseLine.memberPubkey === kim.pk && raiseLine.oldValue === '300' && raiseLine.newValue === '1800',
        `the raise names the admin, the member, and 300 → 1,800 (${JSON.stringify(raiseLine)})`);
    assert(!actions.includes('credit_cap') && logged.length === 3, `the refused requests wrote no line (${logged.length} lines)`);

    // An admin freezes Kim's line through the same route the manager's settings use (rehearsal 5 Oct, b): the member's own
    // answer says the admins froze it (knownFrozen), she has no line while it lasts, and her tier stays the one her line
    // gives her, the 1,800 it froze (tiers are merit badges; r4178445093): not "Newcomer", and not the default's.
    const kimRaised = await balanceOf(kim);
    const freeze = await exception(adaAdmin, { memberPubkey: kim.pk, frozen: true });
    assert(freeze.status === 200 && freeze.body?.exception?.frozen === true, `an admin freezes Kim's known floor (${show(freeze)})`);
    const kimFrozen = await balanceOf(kim);
    assert(kimFrozen.status === 200 && kimFrozen.body?.knownFrozen === true && kimFrozen.body?.floor === 0 && kimFrozen.body?.activated === false,
        `Kim's own answer: knownFrozen, no line while it lasts (${show(kimFrozen)})`);
    assert(kimFrozen.body?.tier?.name === kimRaised.body?.tier?.name && kimFrozen.body?.tier?.name !== 'Newcomer',
        `and her tier stays ${kimRaised.body?.tier?.name}, the one 1,800 gives, not Newcomer (${kimFrozen.body?.tier?.name})`);
    const unfreeze = await exception(adaAdmin, { memberPubkey: kim.pk, amount: 1800 });
    assert(unfreeze.status === 200 && getBalance(kim.pk).knownFrozen === false && getBalance(kim.pk).usableFloor === -1800,
        `an admin opens it again at 1,800 and the freeze is gone (${show(unfreeze)})`);
    // The manager's "Freeze" on a member is the other freeze (members.credit_frozen, the whole line): the same answer.
    const tierBefore = (await balanceOf(kim)).body?.tier?.name;
    const wholeFreeze = await call('POST', null, `/api/local/admin/users/${kim.pk}/freeze`, { freeze: true }, owner);
    const kimWhole = await balanceOf(kim);
    assert(wholeFreeze.status === 200 && kimWhole.body?.creditFrozen === true && kimWhole.body?.floor === 0 && kimWhole.body?.tier?.name === tierBefore,
        `the manager's Freeze: creditFrozen, no line, her tier still ${tierBefore} (${show(kimWhole)})`);
    const wholeOpen = await call('POST', null, `/api/local/admin/users/${kim.pk}/freeze`, { freeze: false }, owner);
    assert(wholeOpen.status === 200 && getBalance(kim.pk).creditFrozen === false && getBalance(kim.pk).usableFloor === -1800,
        `and unfreezing gives her line back (${show(wholeOpen)})`);

    // ── 5. the dial off again ──────────────────────────────────────────────────────────────────
    console.log('── 5. the dial off again ──');
    const offAgain = await settings(owner, { confirmation: false });
    assert(offAgain.status === 200 && offAgain.body?.confirmation === false, `the owner turns the dial off (${show(offAgain)})`);
    const kimOff = getBalance(kim.pk);
    assert(kimOff.floor === 0 && kimOff.usableFloor === 0 && Math.abs(kimOff.balance - -1000) < 1e-9 && kimOff.frozen === true,
        `the known grant stops; nothing is deducted; Kim is spend-frozen until she climbs back (${JSON.stringify({ f: kimOff.floor, u: kimOff.usableFloor, b: kimOff.balance })})`);
    // She can still receive, and selling climbs her back.
    completePostTransaction(acceptPost(kimOffer.id, sam.pk).id, sam.pk);
    assert(getBalance(kim.pk).balance > -1000, `she can still earn: a sale moves her up (${getBalance(kim.pk).balance})`);

    // ── 6. a cap saved with the dial off changes nothing ──────────────────────────────────────────
    console.log('── 6. a saved cap, the dial off ──');
    const capSaved = await settings(owner, { creditCap: 5000 });
    assert(capSaved.status === 200 && capSaved.body?.creditCap === 5000 && capSaved.body?.confirmation === false,
        `the owner saves a cap of 5,000 with the dial off (${show(capSaved)})`);
    const gil = makeMember('Gil');
    db.prepare('UPDATE members SET earned_credit = 2100 WHERE public_key = ?').run(gil.pk);
    const gilOff = getBalance(gil.pk);
    assert(gilOff.floor === -2000, `a member granted 2,100 reads main's floor, -2,000, not -2,100 (${gilOff.floor})`);
    const bea = makeMember('Bea');
    db.prepare('UPDATE members SET earned_credit = 2000 WHERE public_key = ?').run(bea.pk);
    const offCo = makeEnterprise('Off Co', [bea, gil], [2000, 500]);
    const offCoServer = getEnterpriseUnderlyingFloor(offCo).floor;
    const offCoEngine = getEnterpriseFloor(db, offCo).floor;
    assert(offCoServer === -2000 && offCoEngine === -2000,
        `an enterprise with 2,500 pledged reads main's -2,000 in the spend check and the engine (${offCoServer}, ${offCoEngine})`);
    db.prepare('DELETE FROM enterprise_pledges WHERE enterprise = ?').run(offCo);
    db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ?').run(offCo);

    // ── 7. a keeper backs an enterprise from their known grant only by a recorded pledge, locked like any pledge ────
    console.log('── 7. keepers ──');
    const dialBack = await settings(owner, { confirmation: true, creditCap: 2000 });
    assert(dialBack.status === 200 && dialBack.body?.confirmation === true, `the owner turns the dial on again (${show(dialBack)})`);
    const sink = makeMember('Sink');
    const offers = (pk: string) => { for (let i = 0; i < 5; i++) createPost('offer', 'produce', `Goods ${i}`, 'Goods', 10, 'fixed', pk); };
    // A marketplace buy (escrow), as the reviewer spent: true when the buyer's balance moved.
    const spend = (from: string, beans: number): boolean => {
        if (beans <= 0) return false;
        const before = getBalance(from).balance;
        try { acceptPost(createPost('offer', 'produce', `Sink's ${beans}-Bean basket`, 'Veg', beans, 'fixed', sink.pk)!.id, from); } catch { /* refused */ }
        return getBalance(from).balance < before;
    };
    const owed = (pk: string) => Math.max(0, -getBalance(pk).balance);
    const pledgeAll = (co: string, keeper: Id) => { const room = getAvailableBacking(keeper.pk); if (room > 0) pledgeEnterpriseBacking(co, keeper.pk, room); };

    // The dilution sequence (confirmation 1, r4176369080): Kai binds to one enterprise at a time, pledges all the room
    // left, and each enterprise spends to its floor before the next binding.
    const kai = makeMember('Kai');
    confirm(kai, ada);
    const kaiCos: string[] = [];
    for (let i = 1; i <= 6; i++) {
        const co = makeEnterprise(`Kai Co ${i}`, [kai]);
        offers(co);
        pledgeAll(co, kai);
        spend(co, -getEnterpriseUnderlyingFloor(co).floor);
        kaiCos.push(co);
    }
    const kaiDebts = kaiCos.map(owed);
    const kaiEnterpriseDebt = kaiDebts.reduce((a, b) => a + b, 0);
    const kaiOwn = -getBalance(kai.pk).floor;
    assert(kaiEnterpriseDebt === 500 && kaiDebts[0] === 500,
        `6 enterprises in turn: the debt Kai's known grant backs is 500 in all, not 500·H(6) = 1,224 (${kaiDebts.join(', ')})`);
    assert(kaiOwn === 500 && kaiOwn + kaiEnterpriseDebt <= 1000,
        `THE BOUND: Kai's own line (${kaiOwn}) + what his known pledges back (${kaiEnterpriseDebt}) is at most his grant, 1,000`);
    assert(getEnterpriseUnderlyingFloor(kaiCos[0]).floor === -500 && getEnterpriseFloor(db, kaiCos[0]).floor === -500,
        `binding to five more never shrank Kai Co 1's pledge: still -500 in the spend check and the engine`);
    let overPledge = 'pledged';
    try { pledgeEnterpriseBacking(kaiCos[1], kai.pk, 1); } catch (e) { overPledge = (e as Error).message; }
    assert(/exceeds what you can pledge/.test(overPledge), `one Bean more is refused (${overPledge})`);
    assert(!spend(kaiCos[1], 1), 'and an enterprise with none of it pledged spends nothing');

    // The step-down cycle (confirmation 1, r4176369102): Lia's known pledge backs Lia Co's debt, so she can't take it to a
    // second enterprise.
    const lia = makeMember('Lia');
    confirm(lia, ada);
    const bob = makeMember('Bob');
    const liaCo = makeEnterprise('Lia Co', [lia, bob]);
    offers(liaCo);
    pledgeAll(liaCo, lia);
    spend(liaCo, -getEnterpriseUnderlyingFloor(liaCo).floor);
    let stepped = 'stepped down';
    try { stepDownAsKeeper(liaCo, lia.pk); } catch (e) { stepped = (e as Error).message; }
    assert(owed(liaCo) === 500 && /in debt and your pledge is part of what covers it/.test(stepped),
        `Lia can't step down while her known pledge backs Lia Co's 500 of debt (${owed(liaCo)}; ${stepped})`);
    adminRevokeTreasuryOperator(liaCo, lia.pk);
    assert(getEnterpriseUnderlyingFloor(liaCo).floor === -500,
        `an admin unbind keeps the part of her pledge the debt needs locked: Lia Co still reads -500 (${getEnterpriseUnderlyingFloor(liaCo).floor})`);
    const liaCoTwo = makeEnterprise('Lia Co Two', [lia]);
    offers(liaCoTwo);
    pledgeAll(liaCoTwo, lia);
    assert(getEnterpriseUnderlyingFloor(liaCoTwo).floor === 0 && !spend(liaCoTwo, 1),
        `so Lia Co Two gets none of it and spends nothing: 500 of debt from a 500 half, never 1,000 (${getEnterpriseUnderlyingFloor(liaCoTwo).floor})`);

    // A bound that shrinks spend-freezes and claws nothing back: Kai Co 1 owes 500 on Kai's known pledge.
    const frozenAt = (label: string, floor: number, kaiFloor: number) => {
        const b = getBalance(kaiCos[0]);
        assert(getEnterpriseUnderlyingFloor(kaiCos[0]).floor === floor && b.balance === -500 && b.frozen && -getBalance(kai.pk).floor === kaiFloor
            && -getBalance(kai.pk).floor + -floor <= Math.max(0, kaiFloor * 2),
            `${label}: Kai Co 1 reads ${floor}, still owes 500 and is spend-frozen; Kai's own line ${kaiFloor} (${getEnterpriseUnderlyingFloor(kaiCos[0]).floor}, ${b.balance}, ${b.frozen}, ${getBalance(kai.pk).floor})`);
        assert(!spend(kaiCos[0], 1), `${label}: a spend one Bean more moves nothing`);
    };
    const lowered = await settings(owner, { knownFloor: 600 });
    assert(lowered.status === 200, `the owner lowers the known floor to 600 (${show(lowered)})`);
    frozenAt('known floor lowered to 600', -300, 300);
    await settings(owner, { knownFloor: 1000 });
    db.prepare("UPDATE confirmations SET revoked_at = ? WHERE member_pubkey = ?").run(new Date().toISOString(), kai.pk);
    frozenAt('confirmation revoked', 0, 0);
    db.prepare('UPDATE confirmations SET revoked_at = NULL WHERE member_pubkey = ?').run(kai.pk);
    await settings(owner, { confirmation: false });
    frozenAt('dial off', 0, 0);
    const dialOn = await settings(owner, { confirmation: true });
    assert(dialOn.status === 200 && getEnterpriseUnderlyingFloor(kaiCos[0]).floor === -500, 'the dial on again: the pledge, never released, counts again');

    // ── 7b. a freeze never moves a keeper's tier (r4178376530) ──────────────────────────────────
    // Unfrozen, a keeper's tier follows their own known line: the grant less their counted known pledges. Either freeze, or
    // both, keeps exactly that tier, on their own answer and on their cards: never higher (the full grant) and never lower.
    console.log('── 7b. a frozen keeper\'s tier ──');
    for (const [grant, pledged, tierName] of [[300, 150, 'Newcomer'], [1000, 500, 'Resident']] as const) {
        const set = await settings(owner, { knownFloor: grant });
        assert(set.status === 200, `the owner sets the known floor to ${grant} (${show(set)})`);
        const keeper = makeMember(`Keeper ${grant}`);
        confirm(keeper, ada);
        const card = createPost('offer', 'produce', `Keeper ${grant} mends shoes`, 'Shoes', 10, 'fixed', keeper.pk)!;
        pledgeEnterpriseBacking(makeEnterprise(`Keeper Co ${grant}`, [keeper]), keeper.pk, pledged);
        const tiers = async (label: string, frozen: { known: boolean; whole: boolean }) => {
            const own = await balanceOf(keeper);
            const cardTier = tierForCredit(getPosts({ id: card.id })[0]?.authorEnergyCycled ?? NaN).name;
            const line = frozen.known || frozen.whole ? 0 : -(grant - pledged);
            assert(own.status === 200 && own.body?.floor === line && own.body?.knownFrozen === frozen.known && own.body?.creditFrozen === frozen.whole
                && own.body?.tier?.name === tierName && cardTier === tierName,
                `known floor ${grant}, ${pledged} pledged, ${label}: floor ${line}, tier ${tierName} on their answer and their card (${own.body?.floor}, ${own.body?.tier?.name}, card ${cardTier})`);
        };
        await tiers('unfrozen', { known: false, whole: false });
        await exception(adaAdmin, { memberPubkey: keeper.pk, frozen: true });
        await tiers('known floor frozen', { known: true, whole: false });
        await call('POST', null, `/api/local/admin/users/${keeper.pk}/freeze`, { freeze: true }, owner);
        await tiers('both frozen', { known: true, whole: true });
        await exception(owner, { memberPubkey: keeper.pk, clear: true });
        await tiers('whole line frozen', { known: false, whole: true });
        await call('POST', null, `/api/local/admin/users/${keeper.pk}/freeze`, { freeze: false }, owner);
        await tiers('unfrozen again', { known: false, whole: false });
    }
    await settings(owner, { knownFloor: 1000 });

    // ── 7c. a freeze keeps the amount it froze (r4178445093) ────────────────────────────────────
    // An exception's freeze keeps its amount: their tier is the one that amount gives them, frozen or not, and unfreezing
    // goes back to it. Money is the freeze's: no known line while frozen.
    console.log('── 7c. a frozen exception keeps its amount ──');
    for (const [amount, pledged] of [[50, 0], [50, 20], [1500, 0], [1500, 600], [null, 0], [null, 400]] as const) {
        const grant = amount ?? 1000;
        const label = `${amount === null ? 'the default 1000' : amount === 50 ? 'lowered to 50' : 'raised to 1500'}, ${pledged} pledged`;
        const who = makeMember(`Kept ${grant} ${pledged}`);
        confirm(who, ada);
        const card = createPost('offer', 'produce', `Kept ${grant} ${pledged} bakes bread`, 'Bread', 10, 'fixed', who.pk)!;
        if (amount !== null) assert((await exception(adaAdmin, { memberPubkey: who.pk, amount })).status === 200, `${label}: set`);
        if (pledged) pledgeEnterpriseBacking(makeEnterprise(`Kept Co ${grant} ${pledged}`, [who]), who.pk, pledged);
        const look = async () => {
            const own = await balanceOf(who);
            const theirs = await call('POST', kim, '/api/trust/profile', { targetPubkey: who.pk });
            const board = await call('GET', kim, '/api/marketplace/posts');
            const boardCard = (Array.isArray(board.body) ? board.body : board.body?.posts ?? []).find((p: any) => p.id === card.id);
            const shown = boardCard?.authorEnergyCycled;
            assert(board.status === 200 && TIER_LEVELS.some(t => t.minCredit === shown) && tierForCredit(shown).name === own.body?.tier?.name
                && typeof theirs.body?.earnedCredit === 'number'
                // No number on the card is their line, unless the line happens to be a tier's least credit (600 = Steward's).
                && !Object.entries(boardCard ?? {}).some(([k, v]) => v === grant - pledged && !(k === 'authorEnergyCycled' && v === shown && TIER_LEVELS.some(t => t.minCredit === v))),
                `another member's board shows ${label}'s badge only: ${shown}, the least of ${own.body?.tier?.name}, never ${grant - pledged}; their profile, Trust Points ${theirs.body?.earnedCredit}`);
            return { floor: own.body?.floor, usable: own.body?.usableFloor, tier: own.body?.tier?.name, profileTier: theirs.body?.tier?.name,
                cardTier: tierForCredit(getPosts({ id: card.id })[0]?.authorEnergyCycled ?? NaN).name,
                row: db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(who.pk) as { amount: number | null; frozen: number } | undefined };
        };
        const before = await look();
        assert(before.floor === -(grant - pledged) && !!before.tier && before.profileTier === before.tier && before.cardTier === before.tier,
            `${label}, unfrozen: floor ${-(grant - pledged)}, one tier everywhere (${JSON.stringify(before)})`);
        const frz = await exception(adaAdmin, { memberPubkey: who.pk, frozen: true });
        const frozen = await look();
        assert(frz.status === 200 && frozen.row?.frozen === 1 && frozen.row?.amount === amount,
            `${label}: the freeze keeps the amount (${show(frz)}; row ${JSON.stringify(frozen.row)})`);
        assert(frozen.floor === 0 && frozen.usable === 0,
            `${label}, frozen: no known line, floor and usable 0 (${frozen.floor}, ${frozen.usable})`);
        assert(frozen.tier === before.tier && frozen.profileTier === before.tier && frozen.cardTier === before.tier,
            `${label}, frozen: the same tier ${before.tier} on their answer, another member's profile and their card (${frozen.tier}, ${frozen.profileTier}, ${frozen.cardTier})`);
        const unf = await exception(adaAdmin, { memberPubkey: who.pk, frozen: false });
        const after = await look();
        assert(unf.status === 200 && after.floor === before.floor && after.tier === before.tier && after.cardTier === before.tier
            && (amount === null ? after.row === undefined : after.row?.amount === amount && after.row?.frozen === 0),
            `${label}: unfreezing goes back to ${amount ?? 'the default'} (${show(unf)}; ${JSON.stringify(after)})`);
        if (amount === 50 && pledged === 0) {
            const lines = ((await read()).body?.log as any[]).filter(l => l.memberPubkey === who.pk).map(l => `${l.action} ${l.oldValue}→${l.newValue}`);
            assert(lines.includes('exception_frozen 50→frozen') && lines.includes('exception_unfrozen frozen→50'),
                `the log reads 50 → frozen → 50 (${lines.join('; ')})`);
            const again = await exception(adaAdmin, { memberPubkey: who.pk, frozen: false });
            assert(again.status === 409 && again.body?.code === 'not_frozen', `unfreezing a line that isn't frozen is refused (${show(again)})`);
            await exception(adaAdmin, { memberPubkey: who.pk, frozen: true });
            const cleared = await exception(owner, { memberPubkey: who.pk, clear: true });
            const def = await look();
            assert(cleared.status === 200 && def.row === undefined && def.floor === -1000,
                `restoring the default clears the freeze and the amount: floor -1000 (${show(cleared)}; ${def.floor})`);
        }
    }

    // ── 8. one member's exception needs an owner's or admin's own key session ────────────────────
    console.log('── 8. who sets an exception ──');
    const linesBefore = ((await read()).body?.log as unknown[]).length;
    const token = ownerTokenHeaders('admin');
    const byToken = await exception(token, { memberPubkey: kim.pk, amount: 2000 });
    assert(byToken.status === 403 && byToken.body?.code === 'key_session_only', `an automation token can't set one (${show(byToken)})`);
    const twoFa = turnOn2faForTests(process.env.ADMIN_PASSWORD!);
    const pwRead = await call('GET', null, '/api/local/admin/known-floor', undefined, twoFa.headers());
    const byPassword = await exception(twoFa.headers(), { memberPubkey: kim.pk, amount: 2000 });
    assert(pwRead.status === 200 && byPassword.status === 403 && byPassword.body?.code === 'key_session_only',
        `the node password reads the settings but can't set one: it names nobody, so nobody could be kept from setting their own (${pwRead.status}; ${show(byPassword)})`);
    assert(((await read()).body?.log as unknown[]).length === linesBefore, 'and neither wrote a line in the log');
    const byOwnerKey = await exception(owner, { memberPubkey: kim.pk, clear: true });
    assert(byOwnerKey.status === 200, `an owner's key session still can (${show(byOwnerKey)})`);

    // ── 9. one member's line, for the Manager's member screen ─────────────────────────────────────
    console.log('── 9. one member\'s line ──');
    const lineOf = (headers: Record<string, string>, who: Id) => call('GET', null, `/api/local/admin/known-floor/member/${who.pk}`, undefined, headers);
    const nowSettings = (await read()).body;
    const kimLine = await lineOf(adaAdmin, kim);
    assert(kimLine.status === 200 && kimLine.body?.confirmation === true && kimLine.body?.confirmed === true && kimLine.body?.exception === null
        && kimLine.body?.knownGrant === nowSettings?.knownFloor && kimLine.body?.creditCap === nowSettings?.creditCap,
        `an admin reads Kim's line: confirmed, no exception, the community's known floor (${show(kimLine)})`);
    assert(!/balance|frozen":true|transactions/i.test(JSON.stringify(kimLine.body)) && kimLine.cacheControl === 'no-store',
        `and it carries her credit line, never her balance, and isn't cached (${show(kimLine)})`);
    await exception(adaAdmin, { memberPubkey: kim.pk, frozen: true });
    const frozenLine = await lineOf(owner, kim);
    assert(frozenLine.status === 200 && frozenLine.body?.exception?.frozen === true && frozenLine.body?.knownGrant === 0,
        `frozen: the line reads frozen and her known grant is 0 (${show(frozenLine)})`);
    await exception(adaAdmin, { memberPubkey: kim.pk, amount: 300 });
    const lowLine = await lineOf(owner, kim);
    assert(lowLine.status === 200 && lowLine.body?.exception?.amount === 300 && lowLine.body?.exception?.frozen === false && lowLine.body?.knownGrant === 300,
        `lowered to 300: the line reads 300 (${show(lowLine)})`);
    await exception(adaAdmin, { memberPubkey: kim.pk, clear: true });
    // Her lines in the log come with her line (#1614 review r4178406925: "no screen shows that log"), newest first, each
    // naming who changed it and from what to what.
    const loggedLine = await lineOf(owner, kim);
    const kimLog = (loggedLine.body?.log ?? []) as Array<Record<string, unknown>>;
    assert(kimLog.length >= 3 && kimLog[0]?.action === 'exception_cleared' && kimLog[0]?.oldValue === '300' && kimLog[0]?.newValue === 'default'
        && kimLog[0]?.actor === ada.pk && kimLog[0]?.actorCallsign === 'Ada'
        && kimLog[1]?.action === 'exception_lowered' && kimLog[1]?.oldValue === 'frozen' && kimLog[1]?.newValue === '300'
        && kimLog[2]?.action === 'exception_frozen' && kimLog.every(l => typeof l.at === 'string' && !('memberPubkey' in l)),
        `her line carries her lines in the log: who changed it, from what to what, when (${JSON.stringify(kimLog.slice(0, 3))})`);
    // Where the node would refuse a change, the line says so first (#1614 review r4178406974), so the screen shows why in
    // place of the controls: the node password and a token name nobody, and nobody sets their own.
    const pwLine = await lineOf(twoFa.headers(), kim);
    const tokenLine = await lineOf(token, kim);
    const adaOwn = await lineOf(adaAdmin, ada);
    const adaOnKim = await lineOf(adaAdmin, kim);
    assert(pwLine.status === 200 && pwLine.body?.changeRefused === 'key_session_only' && tokenLine.status === 200 && tokenLine.body?.changeRefused === 'key_session_only',
        `the node password and a token read the line marked key_session_only (${show(pwLine)}; ${show(tokenLine)})`);
    assert(adaOwn.status === 200 && adaOwn.body?.changeRefused === 'own_floor' && adaOnKim.body?.changeRefused === null,
        `an admin's own line is marked own_floor, another member's isn't (${show(adaOwn)}; ${show(adaOnKim)})`);
    const adaSetsOwn = await exception(adaAdmin, { memberPubkey: ada.pk, amount: 10 });
    assert(adaSetsOwn.status === 403 && adaSetsOwn.body?.code === 'own_floor', `and the node refuses what the mark says (${show(adaSetsOwn)})`);
    const unaLine = await lineOf(owner, una);
    assert(unaLine.status === 200 && unaLine.body?.confirmed === false && unaLine.body?.knownGrant === 0,
        `Una isn't confirmed: her known grant is 0 (${show(unaLine)})`);
    const kimReads = await call('GET', kim, `/api/local/admin/known-floor/member/${kim.pk}`);
    assert(kimReads.status === 401 || kimReads.status === 403, `a member who isn't an admin can't read one (${show(kimReads)})`);
    const nobody = await lineOf(owner, keypair('Nobody'));
    assert(nobody.status === 404 && nobody.body?.code === 'not_member', `someone who isn't a member: 404 (${show(nobody)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
