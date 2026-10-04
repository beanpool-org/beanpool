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
import { initStateEngine, transfer, seedGenesisMember, createPost, acceptPost, completePostTransaction, getBalance } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
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
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
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
    return { status: res.status, body: json };
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
