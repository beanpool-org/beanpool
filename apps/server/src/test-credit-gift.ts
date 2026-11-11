/**
 * A member gives part of their credit line (slice G1; engine/credit-gift.ts; scratch/fable-design/
 * DESIGN-invites-and-names-list-amend2-fable.md §5 pick (a), §6, §7 G1). Through the real HTTPS stack and its signature
 * middleware for the routes and every refusal; in this process for the property test.
 *
 *  1. Beans off (before any Bean moves): the gift is refused and the tab isn't offered.
 *  2. What the signer may give (GET /api/credit/gift): offered with room someone gave them, never without.
 *  3. Refusals, each with its sentence and nothing written: unsigned and an owner's admin session, no trade yet, 101 over the
 *     setting of 100, not whole Beans, to yourself, to a key that never joined, to an enterprise, to a paused and to a
 *     frozen member (one sentence for both), from a frozen giver, from earned credit alone, from the known floor; all of
 *     it passed on, a sentence true for someone who gave theirs away (round 2, finding 4).
 *  4. Oldest first, with roots: two vouches held (Owen's, then Ada's), a gift of 75 writes two rows, 50 rooted at Owen
 *     and 25 at Ada, each naming the piece it was split from; the recipient's notice is kept; no `accounts` row moves.
 *  5. Only room the giver isn't using: below zero, a gift past what their line still covers is refused with the number,
 *     and that number is given.
 * 5b. The line their offers unlock, not the whole line (round 2, the deciding review's finding 1): one live offer, 400
 *     granted, 100 vouched, 250 owed: 50 is free, not 100; 51 refused; after 30 given a 1-Bean purchase still goes
 *     through; the most the tab then offers is given and he is never paused (`frozen`), only at his limit.
 *  6. The recipient's line within the cap: one Bean past it refused, up to it given.
 *  7. The voucher card's Passed on line: what sits with the people it was passed on to, how many, how much of it below
 *     zero; a ring passing the same 100 round (A → B → C → A) reads "passed on 100, held by 1 person" (§5).
 *  8. The owner's setting, a Core setting changed in Core settings only: the names list's settings route refuses it whole
 *     (round 2, finding 2); 0 turns the gift off (refused, and the tab not offered), members told, a line in each log;
 *     back on, it gives again; locked, no change without the owner's fresh proof, and with it the unlock line and an alert.
 *  9. Property test over random gift trees: Σ room rooted at each voucher never above their grants and top-ups; every
 *     gift row has a root and splits a piece of the giver's with that root; each member's room is their pieces' open
 *     parts; no piece is split past its amount; no gift pauses its giver (four givers owe on one offer's line); no
 *     `accounts` row moves.
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
import { seedOwnerForTests, ownerSessionHeaders, ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride, getProfileSwitches } from './config/node-profile.js';
import { wrapCreatePost } from './post-test-helper.js';
import { setMemberPhoto, roomHeldOf, creditCap } from '@beanpool/engine';
import { vouchFromProfile, voucherSettings, VOUCHER_WORDS } from './engine/vouchers.js';
import { CORE_SETTINGS_LOCK_KEY, coreLockRow } from './config/core-settings.js';
import { setSecurityAlertHandler } from './services/security-signal.js';
import { CREDIT_GIFT_WORDS, CreditGiftError, giveCreditLine } from './engine/credit-gift.js';
import { checkKnownFloorSettings, writeKnownFloorSettings } from './config/known-floor.js';
import { listKeptNotices } from './engine/kept-notices.js';
import { formatHundredths } from '@beanpool/core';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100): balances, room, vouches, the gift and its
 * setting alike. `hc` turns a Beans figure into hundredths; `words` writes one as the node's sentences do.
 */
const hc = (beans: number) => Math.round(beans * 100);
const words = (c: number) => formatHundredths(c, 'en');
let BASE = '';
/** The owner who opens the community (the node has no admin password: an owner signs in with their key). */
let OWNER = '';
/** That owner's fresh proof: the phone's Manage hand-off, just unlocked, which passes every owner gate. */
const asOwner = () => ownerPhoneSessionHeaders(OWNER);

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
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
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

/** A gift of `amount` (whole hundredths, or whatever a test sends) of the signer's credit line. */
const gift = (from: Id, to: Id | string, amount: unknown) => call(from, 'POST', '/api/credit/gift', { memberPubkey: typeof to === 'string' ? to : to.pk, amount_c: amount });
const offerOf = (who: Id) => call(who, 'GET', '/api/credit/gift');

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const giftRows = () => count("SELECT COUNT(*) AS n FROM room_gifts WHERE kind = 'gift'");
/** Every account row as it stands: a gift moves none of them. */
const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance_c, last_demurrage_epoch FROM accounts ORDER BY public_key').all());
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
    const post = createPost('offer', 'general', `${seller.name} sells`, 'A deal for the gift suite', hc(10), 'fixed', seller.pk);
    require_(!!post?.id, `${seller.name} lists an offer`);
    db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, 'completed')")
        .run(crypto.randomBytes(16).toString('hex'), post!.id, buyer.pk, seller.pk, hc(10));
}
/** Below zero the real way: a live offer and a marketplace spend of `amount` Beans within the usable floor. */
function spendBelowZero(who: Id, to: Id, amount: number): void {
    setMemberPhoto(db, who.pk, FACE);
    createPost('offer', 'general', `${who.name}'s offer`, 'An offer to keep a line open', hc(10), 'fixed', who.pk);
    const tx = transfer(who.pk, to.pk, hc(amount), 'A purchase for the suite', 'escrow');
    require_(!!tx && getBalance(who.pk).balance_c < 0, `${who.name} spends ${amount} within their line and is below zero (${getBalance(who.pk).balance_c} hundredths)`);
}

/** Room a member holds that traces to `root`: what they received rooted there less what they passed on rooted there. */
const heldRooted = (pk: string, root: string) =>
    count('SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE to_pubkey = ? AND root_pubkey = ?', pk, root)
    - count("SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE from_pubkey = ? AND kind = 'gift' AND root_pubkey = ?", pk, root);
/** A member's pieces' open parts: each received piece less what was split from it. */
const openParts = (pk: string) => count(`SELECT COALESCE(SUM(g.amount_c - COALESCE((SELECT SUM(c.amount_c) FROM room_gifts c WHERE c.source_gift_id = g.id), 0)), 0) AS n
    FROM room_gifts g WHERE g.to_pubkey = ?`, pk);

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    OWNER = seedOwnerForTests('Olga');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, asOwner());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await call(owen, 'POST', '/api/invite/redeem', { code: seed.body?.code, publicKey: owen.pk, callsign: 'Owen' })).status === 200,
        `Owen joins with the seed invite (${show(seed)})`);
    const enter = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    const names = ['Ada', 'Dan', 'Mel', 'Sam', 'Kim', 'Lea', 'Kay', 'Ned', 'Pia', 'Fay', 'Ent', 'Zoe', 'Rin', 'Ria', 'Rex', 'Gus'];
    const [ada, dan, mel, sam, kim, lea, kay, ned, pia, fay, ent, zoe, rin, ria, rex, gus] = names.map(newId);
    for (const who of [ada, dan, mel, sam, kim, lea, kay, ned, pia, fay, ent, zoe, rin, ria, rex, gus]) enter(who);
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [dan, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, asOwner())).status === 200, `${who.name} is made ${role}`);
    }
    // An admin is a voucher only when an owner makes them one (invites-vouching I5): Owen makes Ada and Dan vouchers.
    require_((await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ada.pk })).status === 201 && (await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: dan.pk })).status === 201, 'Owen makes Ada and Dan, admins, vouchers');

    // ── 1. Beans off, before any Bean moves ─────────────────────────────────────────────────────────────────────────
    // vouchAmount keeps its name and carries whole hundredths.
    vouchFromProfile(owen.pk, { memberPubkey: sam.pk, vouchAmount: hc(50) });
    setSwitchOverride('beans', false);
    require_(!getProfileSwitches().beans, 'Beans are switched off (no Bean has moved yet)');
    const offGift = await gift(sam, kim, hc(10));
    const offOffer = await offerOf(sam);
    assert(offGift.status === 403 && offGift.body?.code === 'profile_no_beans' && giftRows() === 0 && offOffer.body?.offered === false,
        `1. with Beans off a gift is refused and the tab isn't offered (${show(offGift)} | ${show(offOffer)})`);
    setSwitchOverride('beans', true);
    require_(getProfileSwitches().beans, 'Beans are on again');

    // Two vouches on Sam, Owen's first; a vouch each on Lea and Kay; trades for everyone who gives below.
    require_(vouchFromProfile(ada.pk, { memberPubkey: sam.pk, vouchAmount: hc(50) }).amount === hc(50), 'Ada vouches 50 for Sam, after Owen');
    vouchFromProfile(owen.pk, { memberPubkey: lea.pk, vouchAmount: hc(50) });
    vouchFromProfile(owen.pk, { memberPubkey: kay.pk, vouchAmount: hc(25) });
    for (const who of [sam, kim, kay, ned, zoe]) deal(who, mel);
    require_(getMemberTrustProfile(sam.pk).earnedCredit > 0 && getMemberTrustProfile(lea.pk).earnedCredit === 0, 'Sam has a completed trade, Lea none');

    // ── 2. What the signer may give (max, room and canGive keep their names and carry whole hundredths) ─────────────
    const samOffer = await offerOf(sam);
    assert(samOffer.status === 200 && samOffer.body?.offered === true && samOffer.body?.max === hc(100) && samOffer.body?.room === hc(100)
        && samOffer.body?.canGive === hc(100) && samOffer.body?.why === null,
        `2. Sam is offered the tab: 100 held from two vouches, up to 100 to give (${show(samOffer)})`);
    const leaOffer = await offerOf(lea);
    assert(leaOffer.body?.offered === true && leaOffer.body?.canGive === 0 && leaOffer.body?.why === CREDIT_GIFT_WORDS.noTrade,
        `2. Lea holds room but has no trade yet: offered, nothing to give, and the sentence why (${show(leaOffer)})`);
    const melOffer = await offerOf(mel);
    assert(melOffer.body?.offered === false && melOffer.body?.room === 0, `2. Mel holds no room someone gave him: no tab (${show(melOffer)})`);

    // ── 3. Refusals, each with its sentence, nothing written ───────────────────────────────────────────────────────
    const before3 = giftRows();
    const unsigned = await call(null, 'POST', '/api/credit/gift', { memberPubkey: kim.pk, amount_c: hc(10) });
    const adminSession = await call(null, 'POST', '/api/credit/gift', { memberPubkey: kim.pk, amount_c: hc(10) }, ownerSessionHeaders(OWNER));
    assert(unsigned.status === 401 && adminSession.status === 401, `3. unsigned, and an owner's admin session, are refused 401 (${show(unsigned)} | ${show(adminSession)})`);
    const noTrade = await gift(lea, kim, hc(10));
    assert(noTrade.status === 403 && noTrade.body?.code === 'no_trade_yet' && noTrade.body?.error === CREDIT_GIFT_WORDS.noTrade,
        `3. no trade yet is refused with the sentence (${show(noTrade)})`);
    const over = await gift(sam, kim, hc(101));
    assert(over.status === 400 && over.body?.code === 'over_setting' && over.body?.error === 'You can give up to 100 Beans of your credit line at once here.',
        `3. 101 is refused: the setting is 100 (${show(over)})`);
    // Not whole Beans (12.5 Beans), not even whole hundredths (12.5 hundredths), none, a numeric string, below zero.
    const notWhole = [await gift(sam, kim, hc(12.5)), await gift(sam, kim, 12.5), await gift(sam, kim, 0), await gift(sam, kim, String(hc(10))), await gift(sam, kim, hc(-5))];
    assert(notWhole.every((r) => r.status === 400 && r.body?.code === 'bad_amount' && r.body?.error === CREDIT_GIFT_WORDS.badAmount),
        `3. 12.5 Beans, 12.5 hundredths, 0, "1000" and -5 are refused: whole Beans, 1 or more (${notWhole.map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    const own = await gift(sam, sam, hc(10));
    assert(own.status === 403 && own.body?.code === 'own_gift' && own.body?.error === CREDIT_GIFT_WORDS.ownGift, `3. never to yourself (${show(own)})`);
    const stranger = await gift(sam, newId('Nobody').pk, hc(10));
    assert(stranger.status === 404 && stranger.body?.code === 'not_member' && stranger.body?.error === CREDIT_GIFT_WORDS.notMember,
        `3. never to a key that never joined (${show(stranger)})`);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(ent.pk); // setup: an enterprise's account
    const toEnt = await gift(sam, ent, hc(10));
    assert(toEnt.status === 409 && toEnt.body?.code === 'enterprise' && toEnt.body?.error === CREDIT_GIFT_WORDS.enterprise, `3. never to an enterprise (${show(toEnt)})`);
    adminSetUserStatus(pia.pk, 'disabled');
    adminSetCreditFrozen(fay.pk, true);
    const toPaused = await gift(sam, pia, hc(10));
    const toFrozen = await gift(sam, fay, hc(10));
    assert(toPaused.status === 409 && toPaused.body?.code === 'not_receiving' && toPaused.body?.error === '@Pia can’t be given part of a credit line right now.'
        && toFrozen.status === 409 && toFrozen.body?.code === 'not_receiving' && toFrozen.body?.error === '@Fay can’t be given part of a credit line right now.',
        `3. never to a paused or a frozen member, in one sentence that doesn't say which (${show(toPaused)} | ${show(toFrozen)})`);
    const strangerSigner = newId('Stranger');
    const fromStranger = await gift(strangerSigner, pia, hc(10));
    assert(fromStranger.status === 403 && fromStranger.body?.code !== 'not_receiving' && !fromStranger.text.includes('Pia'),
        `3. a key that may give nothing learns nothing about the member it names (${show(fromStranger)})`);
    adminSetCreditFrozen(sam.pk, true);
    const frozenGiver = await gift(sam, kim, hc(10));
    adminSetCreditFrozen(sam.pk, false);
    assert(frozenGiver.status === 409 && frozenGiver.body?.code === 'frozen' && frozenGiver.body?.error === CREDIT_GIFT_WORDS.giverFrozen,
        `3. a giver whose credit line is frozen is refused (${show(frozenGiver)})`);
    const fromEarned = await gift(ned, kim, hc(1));
    const nedOffer = await offerOf(ned);
    assert(getMemberTrustProfile(ned.pk).earnedCredit > 0 && fromEarned.status === 409 && fromEarned.body?.code === 'no_room'
        && fromEarned.body?.error === CREDIT_GIFT_WORDS.noRoom && nedOffer.body?.offered === false,
        `3. earned credit alone is never given: refused, and no tab (${show(fromEarned)})`);
    // The known floor: Kay is confirmed (1,000) and holds 25 of Owen's room. Only the 25 can go.
    writeKnownFloorSettings('owner:password', checkKnownFloorSettings({ confirmation: true, knownFloor_c: hc(1000) }));
    confirm(kay, owen);
    const kayKnown = getMemberTrustProfile(kay.pk).knownGrant;
    require_(kayKnown === hc(1000), `Kay holds the known floor (${kayKnown} hundredths)`);
    const fromKnown = await gift(kay, kim, hc(50));
    assert(fromKnown.status === 409 && fromKnown.body?.code === 'not_enough_room'
        && fromKnown.body?.error === 'You hold 25 Beans of credit line someone gave you, so you can’t give 50.',
        `3. a gift from the known floor is refused: only the 25 someone gave her can go (${show(fromKnown)})`);
    assert(giftRows() === before3, `3. no refusal wrote a row (${giftRows()} gift rows)`);
    const kayGives = await gift(kay, kim, hc(25));
    // The answer's amount keeps its name and carries whole hundredths.
    assert(kayGives.status === 200 && kayGives.body?.amount === hc(25) && getMemberTrustProfile(kay.pk).knownGrant === hc(1000) && roomHeldOf(db, kay.pk) === 0,
        `3. the 25 is given, and her known floor is still 1,000 (${show(kayGives)})`);
    // All of hers passed on: no tab, and the sentence is true of someone who gave theirs away (round 2, the review's
    // finding 4: it said "nobody has given you any"), on the next read and on another try alike.
    const kayAfter = await offerOf(kay);
    const kayAgain = await gift(kay, kim, hc(1));
    const NO_ROOM_NOW = 'You’ve no credit line left to give: only credit line someone gave you can be passed on. Your known floor and the credit you earned stay yours.';
    assert(kayAfter.body?.offered === false && kayAfter.body?.room === 0 && kayAfter.body?.why === NO_ROOM_NOW
        && kayAgain.status === 409 && kayAgain.body?.code === 'no_room' && kayAgain.body?.error === NO_ROOM_NOW && CREDIT_GIFT_WORDS.noRoom === NO_ROOM_NOW,
        `3. all of hers given: no tab, and a sentence true for someone who passed theirs on (${show(kayAfter)} | ${show(kayAgain)})`);

    // ── 4. Oldest first, with roots; no Bean moves ──────────────────────────────────────────────────────────────────
    const accountsBefore = accountsNow();
    const txBefore = txCount();
    const auditBefore = runLedgerAudit();
    const owenPiece = db.prepare("SELECT id FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ? AND kind = 'vouch'").get(owen.pk, sam.pk) as { id: string };
    const adaPiece = db.prepare("SELECT id FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ? AND kind = 'vouch'").get(ada.pk, sam.pk) as { id: string };
    const split = await gift(sam, kim, hc(75));
    const rows = db.prepare("SELECT from_pubkey, to_pubkey, root_pubkey, amount_c, source_gift_id, kind FROM room_gifts WHERE kind = 'gift' AND from_pubkey = ? ORDER BY rowid")
        .all(sam.pk) as { from_pubkey: string; to_pubkey: string; root_pubkey: string; amount_c: number; source_gift_id: string; kind: string }[];
    assert(split.status === 200 && split.body?.amount === hc(75) && split.body?.pieces === 2 && rows.length === 2
        && rows[0].amount_c === hc(50) && rows[0].root_pubkey === owen.pk && rows[0].source_gift_id === owenPiece.id
        && rows[1].amount_c === hc(25) && rows[1].root_pubkey === ada.pk && rows[1].source_gift_id === adaPiece.id
        && rows.every((r) => r.to_pubkey === kim.pk),
        `4. Sam gives 75: two rows, 50 rooted at Owen from his older piece, 25 rooted at Ada from hers (${JSON.stringify(rows.map((r) => [r.amount_c, r.root_pubkey === owen.pk ? 'Owen' : r.root_pubkey === ada.pk ? 'Ada' : '?']))})`);
    assert(roomHeldOf(db, sam.pk) === hc(25) && roomHeldOf(db, kim.pk) === hc(100) && split.body?.room === hc(25) && split.body?.canGive === hc(25),
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
    const debt = -getBalance(sam.pk).balance_c;
    // Whole hundredths throughout, and a gift is whole Beans: what his line still covers past his debt, floored to a whole
    // Bean (a multiple of 100), at most his room.
    const wholeBeansDown = (c: number) => c - (((c % 100) + 100) % 100);
    const free = Math.min(roomHeldOf(db, sam.pk), wholeBeansDown(p.knownGrant + p.roomHeld + p.otherAllowance - debt));
    require_(free > 0 && free < hc(25), `Sam owes ${words(debt)}: ${words(free)} of his 25 is free (earned ${words(p.earnedCredit)})`);
    const tooMuch = await gift(sam, kim, free + 100); // one whole Bean more than is free
    assert(tooMuch.status === 409 && tooMuch.body?.code === 'in_use'
        && tooMuch.body?.error === `You’re using part of your credit line, so you can give ${words(free)} Beans of it at most now.`,
        `5. a gift that would leave his line short of his debt is refused, with what is free (${show(tooMuch)})`);
    const samOffer2 = await offerOf(sam);
    const justEnough = await gift(sam, kim, free);
    const lineAfter = Math.min(creditCap(db), getMemberTrustProfile(sam.pk).knownGrant + getMemberTrustProfile(sam.pk).roomHeld + getMemberTrustProfile(sam.pk).otherAllowance);
    assert(samOffer2.body?.canGive === free && justEnough.status === 200 && lineAfter >= debt,
        `5. the tab offered ${samOffer2.body?.canGive}, and ${free} is given: his line ${lineAfter} still covers his debt ${debt} (${show(justEnough)})`);
    const allInUse = await offerOf(sam);
    assert(allInUse.body?.canGive === 0 && allInUse.body?.why === CREDIT_GIFT_WORDS.allInUse,
        `5. what is left of his room is in use: nothing to give, and why (${show(allInUse)})`);

    // ── 5b. The line his offers unlock, not his whole line (round 2, the deciding review's finding 1) ───────────────────
    // The reviewer's case: one live offer, 400 granted and a trade's earned credit, 100 vouched by Owen, 250 owed. His whole
    // line is 100 + 403, but one offer unlocks the 100 and 200 of the rest: 300. So 50 of the 100 is free, never all of it:
    // all of it would leave him owing 250 on a line of 200, "Spending paused" (getBalance's `frozen`).
    vouchFromProfile(owen.pk, { memberPubkey: gus.pk, vouchAmount: hc(100) });
    deal(mel, gus);
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(400), gus.pk); // setup: a granted line, as 6 does
    spendBelowZero(gus, mel, 250);
    const gp = getMemberTrustProfile(gus.pk);
    const gb = getBalance(gus.pk);
    require_(gb.liveOffers === 1 && gb.balance_c === hc(-250) && gb.usableFloor_c === hc(-300) && !gb.frozen && gp.roomHeld === hc(100) && gp.earnedCredit > 0 && gp.otherAllowance > hc(200),
        `Gus: one live offer, owes 250, usable floor -300, 100 vouched, ${words(gp.otherAllowance)} earned and granted (${JSON.stringify({ live: gb.liveOffers, balance: gb.balance_c, usable: gb.usableFloor_c, frozen: gb.frozen })})`);
    const gusOffer = await offerOf(gus);
    assert(gusOffer.status === 200 && gusOffer.body?.canGive === hc(50) && gusOffer.body?.room === hc(100),
        `5b. the tab offers 50 of his 100: what his one offer unlocks less what he owes (${show(gusOffer)})`);
    const gusRows = giftRows();
    const gus51 = await gift(gus, kim, hc(51));
    assert(gus51.status === 409 && gus51.body?.code === 'in_use' && gus51.body?.error === 'You’re using part of your credit line, so you can give 50 Beans of it at most now.'
        && giftRows() === gusRows && roomHeldOf(db, gus.pk) === hc(100),
        `5b. 51 is refused with the 50 that is free, nothing written (${show(gus51)})`);
    // A gift is not a spend, but it shrinks what he may spend by itself, never by more: 30 given, 20 still his to spend.
    const gus30 = await gift(gus, kim, hc(30));
    const g30 = getBalance(gus.pk);
    const bought = transfer(gus.pk, mel.pk, hc(1), 'A purchase after a gift', 'escrow');
    const g31 = getBalance(gus.pk);
    assert(gus30.status === 200 && !g30.frozen && g30.usableFloor_c === hc(-270) && !!bought && g31.balance_c === hc(-251) && !g31.frozen,
        `5b. after giving 30 he isn't paused (usable floor ${g30.usableFloor_c} hundredths), and a 1-Bean purchase still goes through (balance ${g31.balance_c} hundredths) (${show(gus30)})`);
    // The most the tab offers now, given whole: never past what his offers unlock, so never paused; he is at his limit.
    const gusMost = await offerOf(gus);
    const most = gusMost.body?.canGive;
    const gusAll = await gift(gus, kim, most);
    const gAll = getBalance(gus.pk);
    assert(most === hc(19) && gusAll.status === 200 && !gAll.frozen && gAll.balance_c === hc(-251) && gAll.usableFloor_c === hc(-251),
        `5b. the most the tab offers (${most} hundredths) is given and he is not paused: balance ${gAll.balance_c}, usable floor ${gAll.usableFloor_c} (${show(gusAll)})`);
    const gusNone = await offerOf(gus);
    const gusOne = await gift(gus, kim, hc(1));
    assert(gusNone.body?.canGive === 0 && gusNone.body?.why === CREDIT_GIFT_WORDS.allInUse && gusOne.status === 409 && gusOne.body?.code === 'in_use'
        && roomHeldOf(db, gus.pk) === hc(51) && !getBalance(gus.pk).frozen,
        `5b. the 51 left is all in use: nothing to give and why, 1 more refused, still not paused (${show(gusNone)} | ${show(gusOne)})`);

    // ── 6. The recipient's line within the cap ──────────────────────────────────────────────────────────────────────
    vouchFromProfile(dan.pk, { memberPubkey: rin.pk, vouchAmount: hc(100) });
    deal(rin, mel);
    const cap = creditCap(db);
    const zp = getMemberTrustProfile(zoe.pk);
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(cap - hc(40) - zp.earnedCredit - zp.knownGrant - zp.roomHeld, zoe.pk); // setup: a granted line
    const zr = getMemberTrustProfile(zoe.pk);
    require_(zr.knownGrant + zr.roomHeld + zr.otherAllowance === cap - hc(40), `Zoe's line is ${words(cap - hc(40))}, 40 under the cap`);
    const pastCap = await gift(rin, zoe, hc(41));
    // Zoe's line is in no form in the refusal: neither its hundredths nor its words.
    assert(pastCap.status === 409 && pastCap.body?.code === 'over_cap'
        && typeof pastCap.body?.error === 'string' && pastCap.body.error.startsWith('This gift would take @Zoe’s credit line past the most this community allows (')
        && !pastCap.text.includes(String(cap - hc(40))) && !pastCap.text.includes(words(cap - hc(40))),
        `6. one Bean past the cap is refused (${show(pastCap)})`);
    const toCap = await gift(rin, zoe, hc(40));
    assert(toCap.status === 200 && roomHeldOf(db, zoe.pk) === hc(40), `6. up to the cap is given (${show(toCap)})`);

    // ── 7. The voucher card's Passed on line, and a ring ────────────────────────────────────────────────────────────
    const card = async (of: Id) => (await call(owen, 'GET', `/api/names/vouchers/${of.pk}`)).body;
    let owenCard = await card(owen);
    let adaCard = await card(ada);
    const kimFromOwen = heldRooted(kim.pk, owen.pk);
    // passedOn is { amount_c, people, belowZero }, its figures whole hundredths.
    assert(JSON.stringify(owenCard?.passedOn) === JSON.stringify({ amount_c: kimFromOwen, people: 1, belowZero: 0 })
        && JSON.stringify(adaCard?.passedOn) === JSON.stringify({ amount_c: hc(25) + free, people: 1, belowZero: 0 }),
        `7. the cards: Owen's room passed on sits with Kim (${words(kimFromOwen)}), Ada's too (25 + ${words(free)}), none below zero (${JSON.stringify([owenCard?.passedOn, adaCard?.passedOn])})`);
    spendBelowZero(kim, mel, 30);
    owenCard = await card(owen);
    adaCard = await card(ada);
    assert(owenCard?.passedOn?.belowZero === kimFromOwen && adaCard?.passedOn?.belowZero === hc(25) + free && !JSON.stringify(owenCard?.passedOn).includes('-'),
        `7. Kim below zero: all of it is marked below zero, with no balance figure (${JSON.stringify([owenCard?.passedOn, adaCard?.passedOn])})`);
    // The ring: Rin (Dan vouched 100, gave Zoe 40) → Ria → Rex → Rin, the same 60 each time.
    for (const who of [ria, rex]) deal(who, mel);
    const ring = [await gift(rin, ria, hc(60)), await gift(ria, rex, hc(60)), await gift(rex, rin, hc(60))];
    const danCard = await card(dan);
    assert(ring.every((r) => r.status === 200) && count("SELECT COUNT(*) AS n FROM room_gifts WHERE kind = 'gift' AND root_pubkey = ?", dan.pk) === 4
        && JSON.stringify(danCard?.passedOn) === JSON.stringify({ amount_c: hc(100), people: 2, belowZero: 0 })
        && heldRooted(rin.pk, dan.pk) === hc(60) && heldRooted(ria.pk, dan.pk) === 0 && heldRooted(rex.pk, dan.pk) === 0,
        `7. a ring passing the same 60 round is three rows rooted at Dan, and the card reads passed on 100 (Zoe's 40 and the ring's 60), held by 2 people (${JSON.stringify(danCard?.passedOn)})`);

    // ── 7b. Never back to its root (Marty, 6 Nov: "Block it") ───────────────────────────────────────────────────────
    // A voucher can't pool their budget into their own line through people they vouched for: a piece rooted at the
    // recipient stays out of the split, whoever passed it on.
    const [ivy, jon] = ['Ivy', 'Jon'].map(newId);
    for (const who of [ivy, jon]) { enter(who); deal(who, mel); }
    vouchFromProfile(ada.pk, { memberPubkey: ivy.pk, vouchAmount: hc(50) });
    const rowsBefore7b = giftRows();
    const straightBack = await gift(ivy, ada, hc(10));
    assert(straightBack.status === 409 && straightBack.body?.code === 'back_to_root'
        && straightBack.body?.error === 'The credit line someone gave you started as @Ada’s vouch, so none of it can go to them.' && giftRows() === rowsBefore7b,
        `7b. Ivy's line came from Ada's vouch: none of it goes back to Ada, nothing written (${show(straightBack)})`);
    vouchFromProfile(owen.pk, { memberPubkey: ivy.pk, vouchAmount: hc(25) });
    const partBack = await gift(ivy, ada, hc(30));
    assert(partBack.status === 409 && partBack.body?.code === 'back_to_root'
        && partBack.body?.error === 'Part of the credit line someone gave you started as @Ada’s vouch and can’t go to them, so you can give them 25 Beans at most.' && giftRows() === rowsBefore7b,
        `7b. with Owen's 25 too: past the 25 not rooted at Ada is refused, with the most she may give Ada (${show(partBack)})`);
    const owensPart = await gift(ivy, ada, hc(25));
    const toAda = db.prepare("SELECT root_pubkey AS root, amount_c FROM room_gifts WHERE kind = 'gift' AND from_pubkey = ? AND to_pubkey = ?").all(ivy.pk, ada.pk) as { root: string; amount_c: number }[];
    assert(owensPart.status === 200 && toAda.length === 1 && toAda[0].root === owen.pk && toAda[0].amount_c === hc(25) && heldRooted(ivy.pk, ada.pk) === hc(50),
        `7b. the 25 rooted at Owen goes to Ada, skipping Ada's older piece; Ivy keeps Ada's 50 (${JSON.stringify(toAda)})`);
    const passedOn = await gift(ivy, jon, hc(20));
    const roundBack = await gift(jon, ada, hc(20));
    assert(passedOn.status === 200 && roundBack.status === 409 && roundBack.body?.code === 'back_to_root' && heldRooted(jon.pk, ada.pk) === hc(20),
        `7b. passed on to Jon, Ada's piece still can't reach Ada (${show(roundBack)})`);
    // Before the cap (#2927's review): with Ada 10 under the cap, Jon's 20 all rooted at her answers back_to_root, never
    // over_cap, so refusals that write nothing can't measure her line.
    const adaColumn = (db.prepare('SELECT earned_credit_c AS c FROM members WHERE public_key = ?').get(ada.pk) as { c: number }).c;
    const ap = getMemberTrustProfile(ada.pk);
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(cap - hc(10) - ap.earnedCredit - ap.knownGrant - ap.roomHeld, ada.pk); // setup: a granted line, as 6 does
    const ar = getMemberTrustProfile(ada.pk);
    require_(ar.knownGrant + ar.roomHeld + ar.otherAllowance === cap - hc(10), `Ada's line is ${words(cap - hc(10))}, 10 under the cap (${words(ar.knownGrant + ar.roomHeld + ar.otherAllowance)})`);
    const nearCap = await gift(jon, ada, hc(20));
    assert(nearCap.status === 409 && nearCap.body?.code === 'back_to_root' && !nearCap.text.includes(String(cap)) && !nearCap.text.includes(words(cap)),
        `7b. near the cap the root rule answers first, saying nothing of Ada's line (${show(nearCap)})`);
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(adaColumn, ada.pk); // setup: back as it was

    // ── 8. The owner's setting: a Core setting, changed in Core settings only ────────────────────────────────────────
    const SHAPE = '/api/local/admin/community-shape';
    const shapeSet = (memberGift: unknown, headers: Record<string, string> = asOwner()) => call(null, 'POST', SHAPE, { changes: { memberGift } }, headers);
    /** Every line either log keeps of the gift's setting, an unlock naming it included. */
    const giftLines = () => count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'gift_setting'")
        + count("SELECT COUNT(*) AS n FROM community_settings_log WHERE setting = 'memberGift' OR (setting = 'core.unlock' AND new_value = 'memberGift')");
    const shapeBefore = await call(null, 'GET', SHAPE, undefined, asOwner());
    // The community-shape keys keep their names; memberGift's value is whole hundredths.
    assert(shapeBefore.status === 200 && JSON.stringify(shapeBefore.body?.settings?.memberGift) === JSON.stringify({ value: hc(100), configured: hc(100), source: 'default', lock: null })
        && shapeBefore.body?.core?.settings?.includes('memberGift'),
        `8. Core settings read the gift: 100, the default, and it is a core setting (${JSON.stringify(shapeBefore.body?.settings?.memberGift)})`);
    // The names list's settings route takes the voucher budget only (round 2, the deciding review's finding 2: the gift set
    // there skipped the lock's fresh proof, both logs, the owners' alert and the members' notice). Sent there, alone or
    // beside the budget, the whole request is refused and nothing is written.
    const listBefore = JSON.stringify(voucherSettings());
    const linesBefore = giftLines();
    const viaList = await call(owen, 'POST', '/api/names/vouchers/settings', { memberGift: 0 });
    const viaListBoth = await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(1500), memberGift: 0 });
    assert(viaList.status === 400 && viaList.body?.code === 'moved_to_community_shape' && viaList.body?.error === VOUCHER_WORDS.giftInCoreSettings
        && viaListBoth.status === 400 && viaListBoth.body?.code === 'moved_to_community_shape'
        && JSON.stringify(voucherSettings()) === listBefore && giftLines() === linesBefore && (await offerOf(rin)).body?.offered === true,
        `8. the names list's settings route refuses the gift, alone or beside the budget, and writes nothing (${show(viaList)} | ${show(viaListBoth)})`);
    const budgetOnly = await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(1500) });
    const budgetBack = await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(1000) });
    assert(budgetOnly.status === 200 && budgetOnly.body?.voucherBudget === hc(1500) && budgetOnly.body?.memberGift === hc(100) && budgetBack.body?.voucherBudget === hc(1000),
        `8. the voucher budget alone is still set there (${show(budgetOnly)})`);
    const bad101 = await shapeSet(hc(101));
    const badHalf = await shapeSet(hc(2.5));
    const badHundredth = await shapeSet(2.5);
    assert(bad101.status === 400 && badHalf.status === 400 && badHundredth.status === 400 && bad101.body?.error === 'A member’s credit-line gift is 0 (off) to 100 Beans.',
        `8. Core settings refuse 101, 2.5 and 2.5 hundredths with the sentence (${show(bad101)} | ${show(badHalf)} | ${show(badHundredth)})`);
    const coreOff = await shapeSet(0);
    const offerOff = await offerOf(rin);
    const giftOff = await gift(rin, kim, hc(10));
    const twin = db.prepare("SELECT c.at AS at FROM community_settings_log c WHERE c.setting = 'memberGift' ORDER BY c.id DESC LIMIT 1").get() as { at: string } | undefined;
    // The logs keep the setting's figures as their hundredths' text, as node_config does.
    const twinLines = count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'gift_setting' AND at = ? AND old_value = ? AND new_value = '0'", twin?.at ?? '', String(hc(100)));
    // Its line read once: the known floor's twin of it (stamped alike) is not a second line.
    const logged = (coreOff.body?.shape?.log as any[] | undefined)?.filter((l) => l.setting === 'memberGift') ?? [];
    assert(coreOff.status === 200 && coreOff.body?.told === 'members' && coreOff.body?.shape?.settings?.memberGift?.value === 0
        && offerOff.body?.offered === false && offerOff.body?.max === 0
        && giftOff.status === 403 && giftOff.body?.code === 'gift_off' && giftOff.body?.error === CREDIT_GIFT_WORDS.off
        && twinLines === 1 && logged.length === 1 && logged[0].kept === 'community_settings_log' && logged[0].at === twin?.at,
        `8. 0 in Core settings turns it off: the tab isn't offered, a gift is refused, members told, one line in each log, read once (${JSON.stringify({ status: coreOff.status, told: coreOff.body?.told, offered: offerOff.body?.offered, gift: giftOff.body?.code, twinLines, logged: logged.length })})`);
    const setTen = await shapeSet(hc(10));
    const overTen = await gift(rin, kim, hc(11));
    const ten = await gift(rin, kim, hc(10));
    const coreOn = await shapeSet(hc(100));
    assert(setTen.status === 200 && overTen.status === 400 && overTen.body?.error === 'You can give up to 10 Beans of your credit line at once here.' && ten.status === 200,
        `8. set to 10: 11 is refused with the new most, 10 is given (${show(overTen)})`);
    assert(coreOn.status === 200 && (await offerOf(rin)).body?.offered === true && coreOn.body?.shape?.settings?.memberGift?.source === 'default',
        `8. back to 100: the tab is offered again, and the row is gone (the default) (${show(coreOn)})`);
    // Confirmed and locked: the names list's route still changes nothing, Core settings refuse without the owner's fresh
    // proof, and with it write the unlock line before the change, alert the owners and tell the members, as every Core
    // setting (config/community-shape-write.ts).
    const alerts: string[] = [];
    setSecurityAlertHandler((n) => { if (n.key === 'sec.settings') alerts.push(n.detail); });
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(CORE_SETTINGS_LOCK_KEY, coreLockRow(new Date().toISOString(), owen.pk)); // setup: Confirm and lock's row
    const lockedBefore = { settings: JSON.stringify(voucherSettings()), lines: giftLines() };
    const lockedList = await call(owen, 'POST', '/api/names/vouchers/settings', { memberGift: 0 });
    const lockedBudget = await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(1500) });
    assert(lockedBudget.status === 403 && lockedBudget.body?.code === 'core_locked',
        `8. locked: names list route refuses voucher budget with core_locked (${show(lockedBudget)})`);
    // Without the fresh proof: an owner's computer session (key sign-in), which the phone's unlock is asked for.
    const noProof = await shapeSet(0, ownerSessionHeaders(OWNER));
    assert(lockedList.status === 400 && lockedList.body?.code === 'moved_to_community_shape' && noProof.status === 403 && noProof.body?.code === 'phone_required'
        && JSON.stringify(voucherSettings()) === lockedBefore.settings && giftLines() === lockedBefore.lines && alerts.length === 0,
        `8. locked: the names list's route refuses, Core settings without the fresh proof refuse, nothing written, no alert (${show(lockedList)} | ${show(noProof)})`);
    const proven = await shapeSet(hc(50));
    const unlockLines = db.prepare("SELECT setting, old_value, new_value, at FROM community_settings_log ORDER BY id DESC LIMIT 2").all().reverse() as { setting: string; old_value: string | null; new_value: string; at: string }[];
    assert(proven.status === 200 && proven.body?.told === 'members' && voucherSettings().memberGift === hc(50)
        && unlockLines[0]?.setting === 'core.unlock' && unlockLines[0]?.new_value === 'memberGift' && unlockLines[1]?.setting === 'memberGift'
        && unlockLines[1]?.old_value === String(hc(100)) && unlockLines[1]?.new_value === String(hc(50)) && unlockLines[0]?.at === unlockLines[1]?.at
        && alerts.length === 1 && alerts[0].includes('Members giving part of their credit line (100 → 50)'),
        `8. locked, with the fresh proof: written after a core.unlock line naming it, one owners' alert, members told (${JSON.stringify({ status: proven.status, lines: unlockLines.map((l) => [l.setting, l.old_value, l.new_value]), alerts })})`);
    require_((await shapeSet(hc(100))).status === 200 && voucherSettings().memberGift === hc(100), 'back to 100, with the proof');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(CORE_SETTINGS_LOCK_KEY); // setup: unlocked again for the rest
    setSecurityAlertHandler(null);

    // ── 9. Property test over random gift trees ─────────────────────────────────────────────────────────────────────
    const vouchers = [owen, ada, dan];
    const crowd = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map(newId);
    for (const who of crowd) { enter(who); deal(who, mel); }
    // Four of them owe on a line their one offer meters, as Gus did in 5b: 400 granted, 100 vouched, 250 spent. A gift may
    // take only the room their offer's line doesn't need, so no gift below ever pauses its giver (checked at every step).
    for (const [i, who] of crowd.slice(0, 4).entries()) {
        db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(400), who.pk); // setup: a granted line, as 6 does
        vouchFromProfile(vouchers[i % vouchers.length].pk, { memberPubkey: who.pk, vouchAmount: hc(100) });
        require_(!!transfer(who.pk, mel.pk, hc(250), 'A purchase for the suite', 'escrow') && getBalance(who.pk).balance_c === hc(-250) && !getBalance(who.pk).frozen,
            `${who.name} owes 250 on one offer's line (usable floor ${getBalance(who.pk).usableFloor_c} hundredths)`);
    }
    const people = [...crowd, sam, kim, rin, ria, rex];
    const allocated = (v: Id) => count("SELECT COALESCE(SUM(amount_c), 0) AS n FROM voucher_allocations WHERE member_pubkey = ? AND kind IN ('grant', 'top_up')", v.pk);
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
            try { vouchFromProfile(v.pk, { memberPubkey: to.pk, vouchAmount: hc([25, 50, 75, 100][rnd(4)]) }); vouched++; } catch { /* a vouch rule refused it */ }
        } else {
            const from = people[rnd(people.length)];
            const to = [...people, ...vouchers][rnd(people.length + vouchers.length)];
            const pausedBefore = getBalance(from.pk).frozen;
            try {
                giveCreditLine(from.pk, { memberPubkey: to.pk, amount_c: hc(1 + rnd(100)) });
                given++;
                if (!pausedBefore && getBalance(from.pk).frozen) broken.push(`step ${step}: a gift paused ${from.name}'s spending`);
            } catch (e) {
                if (!(e instanceof CreditGiftError)) throw e;
                refused++;
            }
        }
        for (const v of vouchers) {
            const rooted = people.concat([lea, kay, zoe, gus, owen, ada, dan, mel]).reduce((s, who) => s + heldRooted(who.pk, v.pk), 0);
            if (rooted > allocated(v)) broken.push(`step ${step}: ${rooted} rooted at ${v.name} > ${allocated(v)} granted and topped up`);
            const negative = people.find((who) => heldRooted(who.pk, v.pk) < 0);
            if (negative) broken.push(`step ${step}: ${negative.name} holds less than nothing rooted at ${v.name}`);
        }
        for (const who of people) if (roomHeldOf(db, who.pk) !== openParts(who.pk)) broken.push(`step ${step}: ${who.name}'s room ${roomHeldOf(db, who.pk)} != open parts ${openParts(who.pk)}`);
        const overSplit = count('SELECT COUNT(*) AS n FROM room_gifts g WHERE (SELECT COALESCE(SUM(c.amount_c), 0) FROM room_gifts c WHERE c.source_gift_id = g.id) > g.amount_c');
        if (overSplit > 0) broken.push(`step ${step}: ${overSplit} piece(s) split past their amount`);
        const rootless = count(`SELECT COUNT(*) AS n FROM room_gifts g WHERE g.kind = 'gift' AND (g.root_pubkey IS NULL OR NOT EXISTS
            (SELECT 1 FROM room_gifts s WHERE s.id = g.source_gift_id AND s.to_pubkey = g.from_pubkey AND s.root_pubkey = g.root_pubkey))`);
        if (rootless > 0) broken.push(`step ${step}: ${rootless} gift row(s) without their piece's root`);
        const home = count("SELECT COUNT(*) AS n FROM room_gifts WHERE kind = 'gift' AND to_pubkey = root_pubkey");
        if (home > 0) broken.push(`step ${step}: ${home} gift row(s) landed on their own root`);
    }
    assert(broken.length === 0 && given > 30 && refused > 0,
        `9. over 300 random steps (${given} gifts, ${refused} refused, ${vouched} vouches): room rooted at each voucher never above their grants and top-ups, every row rooted, no piece split past its amount, none landed on its root, each member's room their pieces' open parts, no giver paused by a gift${broken.length ? ` — ${broken.slice(0, 3).join(' | ')}` : ''}`);
    assert(accountsNow() === accountsAtStart, '9. no accounts row moved across the random gifts');

    // ── 10. The audit ───────────────────────────────────────────────────────────────────────────────────────────────
    const audit = runLedgerAudit();
    assert(audit.ok && audit.drift === 0, `10. the ledger audit sums to zero after every gift (${JSON.stringify(audit)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
