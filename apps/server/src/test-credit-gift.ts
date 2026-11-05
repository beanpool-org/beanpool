/**
 * A member gives part of their credit line (slice G1; engine/credit-gift.ts; scratch/fable-design/
 * DESIGN-invites-and-names-list-amend2-fable.md §5 pick (a), §6, §7 G1). Through the real HTTPS stack and its signature
 * middleware for the routes and every refusal; in this process for the property test.
 *
 *  1. Beans off (before any Bean moves): the gift is refused and the tab isn't offered.
 *  2. What the signer may give (GET /api/credit/gift): offered with room someone gave them, never without.
 *  3. Refusals, each with its sentence and nothing written: unsigned and the password session, no trade yet, 101 over the
 *     setting of 100, not whole Beans, to yourself, to a key that never joined, to an enterprise, to a paused and to a
 *     frozen member (one sentence for both), from a frozen giver, from earned credit alone, from the known floor.
 *  4. Oldest first, with roots: two vouches held (Owen's, then Ada's), a gift of 75 writes two rows, 50 rooted at Owen
 *     and 25 at Ada, each naming the piece it was split from; the recipient's notice is kept; no `accounts` row moves.
 *  5. Only room the giver isn't using: below zero, a gift past what their line still covers is refused with the number,
 *     and that number is given.
 *  6. The recipient's line within the cap: one Bean past it refused, up to it given.
 *  7. The voucher card's Passed on line: what sits with the people it was passed on to, how many, how much of it below
 *     zero; a ring passing the same 100 round (A → B → C → A) reads "passed on 100, held by 1 person" (§5).
 *  8. The owner's setting: 0 turns the gift off (refused, and the tab not offered); back on, it gives again.
 *  9. Property test over random gift trees: Σ room rooted at each voucher never above their grants and top-ups; every
 *     gift row has a root and splits a piece of the giver's with that root; each member's room is their pieces' open
 *     parts; no piece is split past its amount; no `accounts` row moves.
 * 10. The ledger audit sums to zero, and the balances are what they were before the first gift.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import {
    initStateEngine, getBalance, transfer, createPost as rawCreatePost, generateInvite, redeemInvite, runLedgerAudit,
    adminSetCreditFrozen, adminSetUserStatus, getMemberTrustProfile,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride, getProfileSwitches } from './config/node-profile.js';
import { wrapCreatePost } from './post-test-helper.js';
import { setMemberPhoto, roomHeldOf, creditCap } from '@beanpool/engine';
import { vouchFromProfile } from './engine/vouchers.js';
import { CREDIT_GIFT_WORDS, CreditGiftError, giveCreditLine } from './engine/credit-gift.js';
import { checkKnownFloorSettings, writeKnownFloorSettings } from './config/known-floor.js';
import { listKeptNotices } from './engine/kept-notices.js';

const createPost = wrapCreatePost(rawCreatePost);
let BASE = '';
const ADMIN_PW = 'Credit-Gift-Suite-Admin-Pw-58!';
let twoFa: ReturnType<typeof turnOn2faForTests>;
const PASSWORD = () => twoFa.headers();

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
type Method = 'GET' | 'POST';
async function call(id: Id | null, method: Method, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const gift = (from: Id, to: Id | string, amount: unknown) => call(from, 'POST', '/api/credit/gift', { memberPubkey: typeof to === 'string' ? to : to.pk, amount });
const offerOf = (who: Id) => call(who, 'GET', '/api/credit/gift');

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const giftRows = () => count("SELECT COUNT(*) AS n FROM room_gifts WHERE kind = 'gift'");
/** Every account row as it stands: a gift moves none of them. */
const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance, last_demurrage_epoch FROM accounts ORDER BY public_key').all());
const txCount = () => count('SELECT COUNT(*) AS n FROM transactions');

/** A confirmation on a fresh entry, as the names list's confirmMember writes it (setup only: the list has its own suites). */
function confirm(member: Id, by: Id): void {
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

const FACE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** A completed deal, as the marketplace records one, on the seller's live offer: each side's first completed trade (setup). */
function deal(seller: Id, buyer: Id): void {
    setMemberPhoto(db, seller.pk, FACE);
    const post = createPost('offer', 'general', `${seller.name} sells`, 'A deal for the gift suite', 10, 'fixed', seller.pk);
    require_(!!post?.id, `${seller.name} lists an offer`);
    db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, 10, 'completed')")
        .run(crypto.randomBytes(16).toString('hex'), post!.id, buyer.pk, seller.pk);
}
/** Below zero the real way: a live offer and a marketplace spend within the usable floor. */
function spendBelowZero(who: Id, to: Id, amount: number): void {
    setMemberPhoto(db, who.pk, FACE);
    createPost('offer', 'general', `${who.name}'s offer`, 'An offer to keep a line open', 10, 'fixed', who.pk);
    const tx = transfer(who.pk, to.pk, amount, 'A purchase for the suite', 'escrow');
    require_(!!tx && getBalance(who.pk).balance < 0, `${who.name} spends ${amount} within their line and is below zero (${getBalance(who.pk).balance})`);
}

/** Room a member holds that traces to `root`: what they received rooted there less what they passed on rooted there. */
const heldRooted = (pk: string, root: string) =>
    count('SELECT COALESCE(SUM(amount), 0) AS n FROM room_gifts WHERE to_pubkey = ? AND root_pubkey = ?', pk, root)
    - count("SELECT COALESCE(SUM(amount), 0) AS n FROM room_gifts WHERE from_pubkey = ? AND kind = 'gift' AND root_pubkey = ?", pk, root);
/** A member's pieces' open parts: each received piece less what was split from it. */
const openParts = (pk: string) => count(`SELECT COALESCE(SUM(g.amount - COALESCE((SELECT SUM(c.amount) FROM room_gifts c WHERE c.source_gift_id = g.id), 0)), 0) AS n
    FROM room_gifts g WHERE g.to_pubkey = ?`, pk);

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await call(owen, 'POST', '/api/invite/redeem', { code: seed.body?.code, publicKey: owen.pk, callsign: 'Owen' })).status === 200,
        `Owen joins with the seed invite (${show(seed)})`);
    const enter = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    const names = ['Ada', 'Dan', 'Mel', 'Sam', 'Kim', 'Lea', 'Kay', 'Ned', 'Pia', 'Fay', 'Ent', 'Zoe', 'Rin', 'Ria', 'Rex'];
    const [ada, dan, mel, sam, kim, lea, kay, ned, pia, fay, ent, zoe, rin, ria, rex] = names.map(newId);
    for (const who of [ada, dan, mel, sam, kim, lea, kay, ned, pia, fay, ent, zoe, rin, ria, rex]) enter(who);
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [dan, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }

    // ── 1. Beans off, before any Bean moves ─────────────────────────────────────────────────────────────────────────
    vouchFromProfile(owen.pk, { memberPubkey: sam.pk, vouchAmount: 50 });
    setSwitchOverride('beans', false);
    require_(!getProfileSwitches().beans, 'Beans are switched off (no Bean has moved yet)');
    const offGift = await gift(sam, kim, 10);
    const offOffer = await offerOf(sam);
    assert(offGift.status === 403 && offGift.body?.code === 'profile_no_beans' && giftRows() === 0 && offOffer.body?.offered === false,
        `1. with Beans off a gift is refused and the tab isn't offered (${show(offGift)} | ${show(offOffer)})`);
    setSwitchOverride('beans', true);
    require_(getProfileSwitches().beans, 'Beans are on again');

    // Two vouches on Sam, Owen's first; a vouch each on Lea and Kay; trades for everyone who gives below.
    require_(vouchFromProfile(ada.pk, { memberPubkey: sam.pk, vouchAmount: 50 }).amount === 50, 'Ada vouches 50 for Sam, after Owen');
    vouchFromProfile(owen.pk, { memberPubkey: lea.pk, vouchAmount: 50 });
    vouchFromProfile(owen.pk, { memberPubkey: kay.pk, vouchAmount: 25 });
    for (const who of [sam, kim, kay, ned, zoe]) deal(who, mel);
    require_(getMemberTrustProfile(sam.pk).earnedCredit > 0 && getMemberTrustProfile(lea.pk).earnedCredit === 0, 'Sam has a completed trade, Lea none');

    // ── 2. What the signer may give ────────────────────────────────────────────────────────────────────────────────
    const samOffer = await offerOf(sam);
    assert(samOffer.status === 200 && samOffer.body?.offered === true && samOffer.body?.max === 100 && samOffer.body?.room === 100
        && samOffer.body?.canGive === 100 && samOffer.body?.why === null,
        `2. Sam is offered the tab: 100 held from two vouches, up to 100 to give (${show(samOffer)})`);
    const leaOffer = await offerOf(lea);
    assert(leaOffer.body?.offered === true && leaOffer.body?.canGive === 0 && leaOffer.body?.why === CREDIT_GIFT_WORDS.noTrade,
        `2. Lea holds room but has no trade yet: offered, nothing to give, and the sentence why (${show(leaOffer)})`);
    const melOffer = await offerOf(mel);
    assert(melOffer.body?.offered === false && melOffer.body?.room === 0, `2. Mel holds no room someone gave him: no tab (${show(melOffer)})`);

    // ── 3. Refusals, each with its sentence, nothing written ───────────────────────────────────────────────────────
    const before3 = giftRows();
    const unsigned = await call(null, 'POST', '/api/credit/gift', { memberPubkey: kim.pk, amount: 10 });
    const password = await call(null, 'POST', '/api/credit/gift', { memberPubkey: kim.pk, amount: 10 }, PASSWORD());
    assert(unsigned.status === 401 && password.status === 401, `3. unsigned, and the password session, are refused 401 (${show(unsigned)} | ${show(password)})`);
    const noTrade = await gift(lea, kim, 10);
    assert(noTrade.status === 403 && noTrade.body?.code === 'no_trade_yet' && noTrade.body?.error === CREDIT_GIFT_WORDS.noTrade,
        `3. no trade yet is refused with the sentence (${show(noTrade)})`);
    const over = await gift(sam, kim, 101);
    assert(over.status === 400 && over.body?.code === 'over_setting' && over.body?.error === 'You can give up to 100 Beans of your credit line at once here.',
        `3. 101 is refused: the setting is 100 (${show(over)})`);
    const notWhole = [await gift(sam, kim, 12.5), await gift(sam, kim, 0), await gift(sam, kim, '10'), await gift(sam, kim, -5)];
    assert(notWhole.every((r) => r.status === 400 && r.body?.code === 'bad_amount' && r.body?.error === CREDIT_GIFT_WORDS.badAmount),
        `3. 12.5, 0, "10" and -5 are refused: whole Beans, 1 or more (${notWhole.map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    const own = await gift(sam, sam, 10);
    assert(own.status === 403 && own.body?.code === 'own_gift' && own.body?.error === CREDIT_GIFT_WORDS.ownGift, `3. never to yourself (${show(own)})`);
    const stranger = await gift(sam, newId('Nobody').pk, 10);
    assert(stranger.status === 404 && stranger.body?.code === 'not_member' && stranger.body?.error === CREDIT_GIFT_WORDS.notMember,
        `3. never to a key that never joined (${show(stranger)})`);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(ent.pk); // setup: an enterprise's account
    const toEnt = await gift(sam, ent, 10);
    assert(toEnt.status === 409 && toEnt.body?.code === 'enterprise' && toEnt.body?.error === CREDIT_GIFT_WORDS.enterprise, `3. never to an enterprise (${show(toEnt)})`);
    adminSetUserStatus(pia.pk, 'disabled');
    adminSetCreditFrozen(fay.pk, true);
    const toPaused = await gift(sam, pia, 10);
    const toFrozen = await gift(sam, fay, 10);
    assert(toPaused.status === 409 && toPaused.body?.code === 'not_receiving' && toPaused.body?.error === '@Pia can’t be given part of a credit line right now.'
        && toFrozen.status === 409 && toFrozen.body?.code === 'not_receiving' && toFrozen.body?.error === '@Fay can’t be given part of a credit line right now.',
        `3. never to a paused or a frozen member, in one sentence that doesn't say which (${show(toPaused)} | ${show(toFrozen)})`);
    const strangerSigner = newId('Stranger');
    const fromStranger = await gift(strangerSigner, pia, 10);
    assert(fromStranger.status === 403 && fromStranger.body?.code !== 'not_receiving' && !fromStranger.text.includes('Pia'),
        `3. a key that may give nothing learns nothing about the member it names (${show(fromStranger)})`);
    adminSetCreditFrozen(sam.pk, true);
    const frozenGiver = await gift(sam, kim, 10);
    adminSetCreditFrozen(sam.pk, false);
    assert(frozenGiver.status === 409 && frozenGiver.body?.code === 'frozen' && frozenGiver.body?.error === CREDIT_GIFT_WORDS.giverFrozen,
        `3. a giver whose credit line is frozen is refused (${show(frozenGiver)})`);
    const fromEarned = await gift(ned, kim, 1);
    const nedOffer = await offerOf(ned);
    assert(getMemberTrustProfile(ned.pk).earnedCredit > 0 && fromEarned.status === 409 && fromEarned.body?.code === 'no_room'
        && fromEarned.body?.error === CREDIT_GIFT_WORDS.noRoom && nedOffer.body?.offered === false,
        `3. earned credit alone is never given: refused, and no tab (${show(fromEarned)})`);
    // The known floor: Kay is confirmed (1,000) and holds 25 of Owen's room. Only the 25 can go.
    writeKnownFloorSettings('owner:password', checkKnownFloorSettings({ confirmation: true, knownFloor: 1000 }));
    confirm(kay, owen);
    const kayKnown = getMemberTrustProfile(kay.pk).knownGrant;
    require_(kayKnown === 1000, `Kay holds the known floor (${kayKnown})`);
    const fromKnown = await gift(kay, kim, 50);
    assert(fromKnown.status === 409 && fromKnown.body?.code === 'not_enough_room'
        && fromKnown.body?.error === 'You hold 25 Beans of credit line someone gave you, so you can’t give 50.',
        `3. a gift from the known floor is refused: only the 25 someone gave her can go (${show(fromKnown)})`);
    assert(giftRows() === before3, `3. no refusal wrote a row (${giftRows()} gift rows)`);
    const kayGives = await gift(kay, kim, 25);
    assert(kayGives.status === 200 && kayGives.body?.amount === 25 && getMemberTrustProfile(kay.pk).knownGrant === 1000 && roomHeldOf(db, kay.pk) === 0,
        `3. the 25 is given, and her known floor is still 1,000 (${show(kayGives)})`);

    // ── 4. Oldest first, with roots; no Bean moves ──────────────────────────────────────────────────────────────────
    const accountsBefore = accountsNow();
    const txBefore = txCount();
    const auditBefore = runLedgerAudit();
    const owenPiece = db.prepare("SELECT id FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ? AND kind = 'vouch'").get(owen.pk, sam.pk) as { id: string };
    const adaPiece = db.prepare("SELECT id FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ? AND kind = 'vouch'").get(ada.pk, sam.pk) as { id: string };
    const split = await gift(sam, kim, 75);
    const rows = db.prepare("SELECT from_pubkey, to_pubkey, root_pubkey, amount, source_gift_id, kind FROM room_gifts WHERE kind = 'gift' AND from_pubkey = ? ORDER BY rowid")
        .all(sam.pk) as { from_pubkey: string; to_pubkey: string; root_pubkey: string; amount: number; source_gift_id: string; kind: string }[];
    assert(split.status === 200 && split.body?.amount === 75 && split.body?.pieces === 2 && rows.length === 2
        && rows[0].amount === 50 && rows[0].root_pubkey === owen.pk && rows[0].source_gift_id === owenPiece.id
        && rows[1].amount === 25 && rows[1].root_pubkey === ada.pk && rows[1].source_gift_id === adaPiece.id
        && rows.every((r) => r.to_pubkey === kim.pk),
        `4. Sam gives 75: two rows, 50 rooted at Owen from his older piece, 25 rooted at Ada from hers (${JSON.stringify(rows.map((r) => [r.amount, r.root_pubkey === owen.pk ? 'Owen' : r.root_pubkey === ada.pk ? 'Ada' : '?']))})`);
    assert(roomHeldOf(db, sam.pk) === 25 && roomHeldOf(db, kim.pk) === 100 && split.body?.room === 25 && split.body?.canGive === 25,
        `4. Sam's line holds 25 of room now, Kim's 100 (25 from Kay) (${JSON.stringify({ sam: roomHeldOf(db, sam.pk), kim: roomHeldOf(db, kim.pk) })})`);
    const kimNotice = listKeptNotices(kim.pk).find((n: any) => n.body === '@Sam gave you 75 Beans of their credit line. It’s yours for good.');
    assert(!!kimNotice && (kimNotice as any).title === CREDIT_GIFT_WORDS.noticeTitle, `4. Kim's notice is kept: who gave, how much, for good`);
    assert(accountsNow() === accountsBefore && txCount() === txBefore && runLedgerAudit().sumBalances === auditBefore.sumBalances,
        '4. no accounts row and no transaction moved');
    // A piece's root can't be lost on the way: every gift row names one, and the piece it came from, with the same root.
    const orphan = count(`SELECT COUNT(*) AS n FROM room_gifts g WHERE g.kind = 'gift' AND (g.root_pubkey IS NULL OR g.root_pubkey = '' OR g.source_gift_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM room_gifts s WHERE s.id = g.source_gift_id AND s.to_pubkey = g.from_pubkey AND s.root_pubkey = g.root_pubkey))`);
    assert(orphan === 0, `4. every gift row has a root and splits a piece of its giver's with that root (${orphan} not)`);

    // ── 5. Only room the giver isn't using ──────────────────────────────────────────────────────────────────────────
    spendBelowZero(sam, mel, 20);
    const p = getMemberTrustProfile(sam.pk);
    const debt = -getBalance(sam.pk).balance;
    const free = Math.min(roomHeldOf(db, sam.pk), Math.floor(p.knownGrant + p.roomHeld + p.otherAllowance - debt));
    require_(free > 0 && free < 25, `Sam owes ${debt}: ${free} of his 25 is free (earned ${p.earnedCredit})`);
    const tooMuch = await gift(sam, kim, free + 1);
    assert(tooMuch.status === 409 && tooMuch.body?.code === 'in_use'
        && tooMuch.body?.error === `You’re using part of your credit line, so you can give ${free} Beans of it at most now.`,
        `5. a gift that would leave his line short of his debt is refused, with what is free (${show(tooMuch)})`);
    const samOffer2 = await offerOf(sam);
    const justEnough = await gift(sam, kim, free);
    const lineAfter = Math.min(creditCap(db), getMemberTrustProfile(sam.pk).knownGrant + getMemberTrustProfile(sam.pk).roomHeld + getMemberTrustProfile(sam.pk).otherAllowance);
    assert(samOffer2.body?.canGive === free && justEnough.status === 200 && lineAfter >= debt,
        `5. the tab offered ${samOffer2.body?.canGive}, and ${free} is given: his line ${lineAfter} still covers his debt ${debt} (${show(justEnough)})`);
    const allInUse = await offerOf(sam);
    assert(allInUse.body?.canGive === 0 && allInUse.body?.why === CREDIT_GIFT_WORDS.allInUse,
        `5. what is left of his room is in use: nothing to give, and why (${show(allInUse)})`);

    // ── 6. The recipient's line within the cap ──────────────────────────────────────────────────────────────────────
    vouchFromProfile(dan.pk, { memberPubkey: rin.pk, vouchAmount: 100 });
    deal(rin, mel);
    const cap = creditCap(db);
    const zp = getMemberTrustProfile(zoe.pk);
    db.prepare('UPDATE members SET earned_credit = ? WHERE public_key = ?').run(cap - 40 - zp.earnedCredit - zp.knownGrant - zp.roomHeld, zoe.pk); // setup: a granted line
    const zr = getMemberTrustProfile(zoe.pk);
    require_(zr.knownGrant + zr.roomHeld + zr.otherAllowance === cap - 40, `Zoe's line is ${cap - 40}, 40 under the cap`);
    const pastCap = await gift(rin, zoe, 41);
    assert(pastCap.status === 409 && pastCap.body?.code === 'over_cap'
        && typeof pastCap.body?.error === 'string' && pastCap.body.error.startsWith('This gift would take @Zoe’s credit line past the most this community allows (')
        && !pastCap.text.includes(String(cap - 40)),
        `6. one Bean past the cap is refused (${show(pastCap)})`);
    const toCap = await gift(rin, zoe, 40);
    assert(toCap.status === 200 && roomHeldOf(db, zoe.pk) === 40, `6. up to the cap is given (${show(toCap)})`);

    // ── 7. The voucher card's Passed on line, and a ring ────────────────────────────────────────────────────────────
    const card = async (of: Id) => (await call(owen, 'GET', `/api/names/vouchers/${of.pk}`)).body;
    let owenCard = await card(owen);
    let adaCard = await card(ada);
    const kimFromOwen = heldRooted(kim.pk, owen.pk);
    assert(JSON.stringify(owenCard?.passedOn) === JSON.stringify({ amount: kimFromOwen, people: 1, belowZero: 0 })
        && JSON.stringify(adaCard?.passedOn) === JSON.stringify({ amount: 25 + free, people: 1, belowZero: 0 }),
        `7. the cards: Owen's room passed on sits with Kim (${kimFromOwen}), Ada's too (25 + ${free}), none below zero (${JSON.stringify([owenCard?.passedOn, adaCard?.passedOn])})`);
    spendBelowZero(kim, mel, 30);
    owenCard = await card(owen);
    adaCard = await card(ada);
    assert(owenCard?.passedOn?.belowZero === kimFromOwen && adaCard?.passedOn?.belowZero === 25 + free && !JSON.stringify(owenCard?.passedOn).includes('-'),
        `7. Kim below zero: all of it is marked below zero, with no balance figure (${JSON.stringify([owenCard?.passedOn, adaCard?.passedOn])})`);
    // The ring: Rin (Dan vouched 100, gave Zoe 40) → Ria → Rex → Rin, the same 60 each time.
    for (const who of [ria, rex]) deal(who, mel);
    const ring = [await gift(rin, ria, 60), await gift(ria, rex, 60), await gift(rex, rin, 60)];
    const danCard = await card(dan);
    assert(ring.every((r) => r.status === 200) && count("SELECT COUNT(*) AS n FROM room_gifts WHERE kind = 'gift' AND root_pubkey = ?", dan.pk) === 4
        && JSON.stringify(danCard?.passedOn) === JSON.stringify({ amount: 100, people: 2, belowZero: 0 })
        && heldRooted(rin.pk, dan.pk) === 60 && heldRooted(ria.pk, dan.pk) === 0 && heldRooted(rex.pk, dan.pk) === 0,
        `7. a ring passing the same 60 round is three rows rooted at Dan, and the card reads passed on 100 (Zoe's 40 and the ring's 60), held by 2 people (${JSON.stringify(danCard?.passedOn)})`);

    // ── 8. The owner's setting ──────────────────────────────────────────────────────────────────────────────────────
    const setOff = await call(owen, 'POST', '/api/names/vouchers/settings', { memberGift: 0 });
    const offerOff = await offerOf(rin);
    const giftOff = await gift(rin, kim, 10);
    assert(setOff.status === 200 && setOff.body?.memberGift === 0 && offerOff.body?.offered === false && offerOff.body?.max === 0
        && giftOff.status === 403 && giftOff.body?.code === 'gift_off' && giftOff.body?.error === CREDIT_GIFT_WORDS.off,
        `8. 0 turns it off: the tab isn't offered and a gift is refused (${show(offerOff)} | ${show(giftOff)})`);
    const setTen = await call(owen, 'POST', '/api/names/vouchers/settings', { memberGift: 10 });
    const overTen = await gift(rin, kim, 11);
    const ten = await gift(rin, kim, 10);
    await call(owen, 'POST', '/api/names/vouchers/settings', { memberGift: 100 });
    assert(setTen.status === 200 && overTen.status === 400 && overTen.body?.error === 'You can give up to 10 Beans of your credit line at once here.' && ten.status === 200,
        `8. set to 10: 11 is refused with the new most, 10 is given (${show(overTen)})`);

    // ── 9. Property test over random gift trees ─────────────────────────────────────────────────────────────────────
    const vouchers = [owen, ada, dan];
    const crowd = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map(newId);
    for (const who of crowd) { enter(who); deal(who, mel); }
    const people = [...crowd, sam, kim, rin, ria, rex];
    const allocated = (v: Id) => count("SELECT COALESCE(SUM(amount), 0) AS n FROM voucher_allocations WHERE member_pubkey = ? AND kind IN ('grant', 'top_up')", v.pk);
    const accountsAtStart = accountsNow();
    // mulberry32, in 32-bit integer steps (a plain LCG in floats loses its low bits past 2^53 and repeats).
    let seedN = 0x5eed;
    const rnd = (n: number) => {
        seedN = (seedN + 0x6d2b79f5) | 0;
        let x = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    let given = 0, refused = 0, vouched = 0;
    const broken: string[] = [];
    for (let step = 0; step < 300 && broken.length === 0; step++) {
        if (rnd(4) === 0) {
            const v = vouchers[rnd(vouchers.length)];
            const to = people[rnd(people.length)];
            try { vouchFromProfile(v.pk, { memberPubkey: to.pk, vouchAmount: [25, 50, 75, 100][rnd(4)] }); vouched++; } catch { /* a vouch rule refused it */ }
        } else {
            const from = people[rnd(people.length)];
            const to = people[rnd(people.length)];
            try { giveCreditLine(from.pk, { memberPubkey: to.pk, amount: 1 + rnd(100) }); given++; } catch (e) {
                if (!(e instanceof CreditGiftError)) throw e;
                refused++;
            }
        }
        for (const v of vouchers) {
            const rooted = people.concat([lea, kay, zoe, owen, ada, dan, mel]).reduce((s, who) => s + heldRooted(who.pk, v.pk), 0);
            if (rooted > allocated(v)) broken.push(`step ${step}: ${rooted} rooted at ${v.name} > ${allocated(v)} granted and topped up`);
            const negative = people.find((who) => heldRooted(who.pk, v.pk) < 0);
            if (negative) broken.push(`step ${step}: ${negative.name} holds less than nothing rooted at ${v.name}`);
        }
        for (const who of people) if (roomHeldOf(db, who.pk) !== openParts(who.pk)) broken.push(`step ${step}: ${who.name}'s room ${roomHeldOf(db, who.pk)} != open parts ${openParts(who.pk)}`);
        const overSplit = count('SELECT COUNT(*) AS n FROM room_gifts g WHERE (SELECT COALESCE(SUM(c.amount), 0) FROM room_gifts c WHERE c.source_gift_id = g.id) > g.amount');
        if (overSplit > 0) broken.push(`step ${step}: ${overSplit} piece(s) split past their amount`);
        const rootless = count(`SELECT COUNT(*) AS n FROM room_gifts g WHERE g.kind = 'gift' AND (g.root_pubkey IS NULL OR NOT EXISTS
            (SELECT 1 FROM room_gifts s WHERE s.id = g.source_gift_id AND s.to_pubkey = g.from_pubkey AND s.root_pubkey = g.root_pubkey))`);
        if (rootless > 0) broken.push(`step ${step}: ${rootless} gift row(s) without their piece's root`);
    }
    assert(broken.length === 0 && given > 30 && refused > 0,
        `9. over 300 random steps (${given} gifts, ${refused} refused, ${vouched} vouches): room rooted at each voucher never above their grants and top-ups, every row rooted, no piece split past its amount, each member's room their pieces' open parts${broken.length ? ` — ${broken.slice(0, 3).join(' | ')}` : ''}`);
    assert(accountsNow() === accountsAtStart, '9. no accounts row moved across the random gifts');

    // ── 10. The audit ───────────────────────────────────────────────────────────────────────────────────────────────
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.005, `10. the ledger audit sums to zero after every gift (${JSON.stringify(audit)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
