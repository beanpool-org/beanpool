/**
 * Owners vouch with no limit (Marty, 9 Nov ~21:00: "owners can have unlimited allocation ... they also get to vouch 200 and
 * 500 floor. admins stay the same"; and one person's vouches come to 500 at most once an owner vouched for them, 300
 * otherwise). engine/vouchers.ts OWNER_VOUCH_ACTOR. Through the real HTTPS stack and its signature middleware for every
 * route and refusal.
 *
 *  1. An owner's read: no limit, the six presets (25 to 500), 500 for one person; an admin's: the four, 100, a budget.
 *  2. An owner's 500 from a profile: accepted, no budget change, the hold line written (who, on whom, how much).
 *  3. An owner's 200 on an invite: accepted, no budget change, its hold recorded; it lands on the joiner at the redeem.
 *  4. An admin's 200 and 500 refused with the sentence, a 60 refused, a 100 drawn from their budget as before.
 *  5. The person cap: 500 with an owner's vouch (an admin's 25 on top refused, the sentence), 300 without (a fourth
 *     voucher refused), and an owner tops three vouchers' 300 up to 500 and no further.
 *  6. Nobody sets an owner's budget: a committee admin and another owner refused (409 no_limit), nothing written; nor stops it.
 *  7. The vouchers block and the card: an owner's row says no limit, with every vouch counted in `vouched`.
 *  8. An owner's held invite that lapses goes back without touching the budget; a demoted owner keeps the budget the role
 *     gave them whole, picks from the four presets again, and their invite made as an owner still lands its 500.
 *  9. No Bean moved, and every vouch is a room_gifts row with its hold.
 * 10. A raise is a target (invites-vouching I6): an owner at 100 raises to 200, then 500; the difference lands and is held
 *     (an owner's hold, no budget drawn); 300 is no preset; a target at or below the total, an unvouched person, and a vouch
 *     amount sent with a target are refused with nothing written; an admin's 200 is an owner's alone.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, redeemInvite } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { VOUCHER_WORDS, budgetOf, returnLapsedHolds } from './engine/vouchers.js';
// Read by name from the whole module: a missing export is a failed check, not a load error (as test-vouchers.ts does).
import * as vouchersModule from './engine/vouchers.js';

const OWNER_VOUCH_ACTOR = String((vouchersModule as Record<string, unknown>).OWNER_VOUCH_ACTOR);
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
const ADMIN_PW = 'Owner-Vouch-Suite-Admin-Pw-91!';
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
type Method = 'GET' | 'POST' | 'DELETE';
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
    const res = await localFetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const generate = (id: Id, vouchAmount?: unknown) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk, ...(vouchAmount === undefined ? {} : { vouchAmount }) });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const vouch = (by: Id, who: Id, vouchAmount: unknown) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, vouchAmount });
/** A raise names the total it ends at (slice I6), never an amount to add. */
const raiseTo = (by: Id, who: Id, target: unknown) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, raiseTo: target });
const setLevel = (by: Id, who: Id, level: unknown) => call(by, 'POST', `/api/names/vouchers/${who.pk}/budget`, { level });

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const lines = (pk: string) => db.prepare('SELECT kind, amount, actor, ref FROM voucher_allocations WHERE member_pubkey = ? ORDER BY rowid').all(pk) as { kind: string; amount: number; actor: string; ref: string | null }[];
const allLines = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
const roomOf = (pk: string) => count("SELECT COALESCE(SUM(amount), 0) AS n FROM room_gifts WHERE to_pubkey = ? AND kind = 'vouch'", pk);
const sumBalances = () => count('SELECT ROUND(COALESCE(SUM(balance), 0), 2) AS n FROM accounts');
const budgetSlim = (pk: string) => { const b = budgetOf(pk); return { left: b.left, held: b.held, level: b.level }; };

/** A confirmation on a fresh entry, written as the names list's confirmMember writes it (setup only). */
function confirm(member: Id, by: Id): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk);
    return entryId;
}

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
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const enter = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    const [ada, dan, jane, ora, mel, sam, tom, kai, uma] = ['Ada', 'Dan', 'Jane', 'Ora', 'Mel', 'Sam', 'Tom', 'Kai', 'Uma'].map(newId);
    for (const who of [ada, dan, jane, ora, mel, sam, tom, kai, uma]) enter(who);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: owen.pk, role: 'owner' }, PASSWORD())).status === 200, 'Owen is made owner');
    grantNodeRole(ada.pk, 'admin', owen.pk);
    grantNodeRole(dan.pk, 'admin', owen.pk);
    grantNodeRole(ora.pk, 'owner', owen.pk);
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: true })).status === 200, 'Ada is on the credit committee');
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(jane, owen), amount: 500 })).status === 201, 'Jane is made a voucher with 500');
    require_(budgetOf(owen.pk).left === 1000 && budgetOf(ada.pk).left === 1000 && budgetOf(ora.pk).left === 1000, 'every owner and admin holds 1,000 by the role');
    const balancesBefore = sumBalances();

    // ── 1. The reads ─────────────────────────────────────────────────────────────────────────────────────────────
    const owenMe = await call(owen, 'GET', '/api/vouchers/me');
    assert(owenMe.status === 200 && owenMe.body?.voucher === true && owenMe.body?.noLimit === true
        && JSON.stringify(owenMe.body?.presets) === '[25,50,75,100,200,500]' && owenMe.body?.vouchMax === 500,
        `1. an owner's own read: no limit, the six presets 25 to 500, 500 for one person (${show(owenMe)})`);
    const adaMe = await call(ada, 'GET', '/api/vouchers/me');
    assert(adaMe.status === 200 && adaMe.body?.voucher === true && adaMe.body?.noLimit === false
        && JSON.stringify(adaMe.body?.presets) === '[25,50,75,100]' && adaMe.body?.vouchMax === 100 && adaMe.body?.budget?.left === 1000,
        `1. an admin's: the four presets, 100 for one person, a budget of 1,000 (${show(adaMe)})`);
    const janeMe = await call(jane, 'GET', '/api/vouchers/me');
    assert(janeMe.body?.noLimit === false && JSON.stringify(janeMe.body?.presets) === '[25,50,75,100]' && janeMe.body?.budget?.left === 500,
        `1. a names-list voucher's: the four, a budget of 500 (${show(janeMe)})`);
    const melMe = await call(mel, 'GET', '/api/vouchers/me');
    assert(melMe.body?.voucher === false && melMe.body?.noLimit === false && JSON.stringify(melMe.body?.presets) === '[25,50,75,100]',
        `1. a member's: no voucher, no limit false (${show(melMe)})`);

    // ── 2. An owner's 500 from a profile ────────────────────────────────────────────────────────────────────────
    const owenBefore = budgetSlim(owen.pk);
    const owen500 = await vouch(owen, mel, 500);
    const owenHold = lines(owen.pk).at(-1);
    const melRow = db.prepare("SELECT id, from_pubkey, amount FROM room_gifts WHERE to_pubkey = ? AND kind = 'vouch'").get(mel.pk) as { id: string; from_pubkey: string; amount: number } | undefined;
    assert(owen500.status === 200 && owen500.body?.amount === 500 && owen500.body?.total === 500 && roomOf(mel.pk) === 500,
        `2. an owner vouches 500 for Mel from her profile (${show(owen500)})`);
    assert(JSON.stringify(budgetSlim(owen.pk)) === JSON.stringify(owenBefore),
        `2. the owner's budget is untouched: ${JSON.stringify(owenBefore)} before, ${JSON.stringify(budgetSlim(owen.pk))} after`);
    assert(owenHold?.kind === 'hold' && owenHold.amount === -500 && owenHold.actor === OWNER_VOUCH_ACTOR && owenHold.ref === melRow?.id && melRow?.from_pubkey === owen.pk,
        `2. the allocation ledger records it: a hold of 500 on Owen's ledger, its ref Mel's room_gifts row, marked an owner's (${JSON.stringify(owenHold)})`);

    // ── 3. An owner's 200 on an invite ─────────────────────────────────────────────────────────────────────────────
    const owenInvite = await generate(owen, 200);
    const inviteHold = lines(owen.pk).at(-1);
    assert(owenInvite.status === 200 && owenInvite.body?.invite?.vouchAmount === 200 && JSON.stringify(budgetSlim(owen.pk)) === JSON.stringify(owenBefore)
        && inviteHold?.kind === 'hold' && inviteHold.amount === -200 && inviteHold.actor === OWNER_VOUCH_ACTOR && inviteHold.ref === owenInvite.body?.invite?.code,
        `3. an owner's invite carries 200, held on the ledger as an owner's, the budget untouched (${show(owenInvite)})`);
    const lia = newId('Lia');
    const liaRedeem = await redeem(lia, owenInvite.body?.invite?.code);
    assert(liaRedeem.status === 200 && liaRedeem.body?.vouch?.landed === 200 && roomOf(lia.pk) === 200,
        `3. it lands 200 on the joiner at the redeem (${show(liaRedeem)})`);
    const owen5000 = [] as Res[];
    for (const who of [tom, kai]) owen5000.push(await vouch(owen, who, 500));
    assert(owen5000.every((r) => r.status === 200) && JSON.stringify(budgetSlim(owen.pk)) === JSON.stringify(owenBefore),
        `3. more 500s past the 1,000 the role gave: never refused for budget, the budget the same (${owen5000.map(show).join(' | ')})`);

    // ── 4. An admin's amounts ────────────────────────────────────────────────────────────────────────────────────
    const linesBefore4 = allLines();
    const invitesBefore4 = count('SELECT COUNT(*) AS n FROM invite_codes');
    const ada200 = await vouch(ada, sam, 200);
    const ada500invite = await generate(ada, 500);
    const jane200 = await vouch(jane, sam, 200);
    const ada60 = await vouch(ada, sam, 60);
    const owen300 = await vouch(owen, sam, 300);
    assert(ada200.status === 403 && ada200.body?.code === 'owner_amount' && ada200.body?.error === VOUCHER_WORDS.ownerAmountOnly
        && ada500invite.status === 403 && ada500invite.body?.code === 'owner_amount' && jane200.status === 403 && jane200.body?.code === 'owner_amount'
        && allLines() === linesBefore4 && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore4,
        `4. an admin's 200, an admin's invite with 500 and a names-list voucher's 200 are refused: "${ada200.body?.error}", nothing written (${[ada200, ada500invite, jane200].map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    assert(ada60.status === 400 && ada60.body?.error === VOUCHER_WORDS.badAmount && owen300.status === 400 && owen300.body?.error === VOUCHER_WORDS.badOwnerAmount,
        `4. a 60 from an admin and a 300 from an owner are not presets, each with its sentence (${show(ada60)} | ${show(owen300)})`);
    const ada100 = await vouch(ada, sam, 100);
    assert(ada100.status === 200 && budgetOf(ada.pk).left === 900 && lines(ada.pk).at(-1)?.actor === ada.pk,
        `4. an admin's 100 is drawn from her budget as before: 900 left, the hold hers (${show(ada100)})`);

    // ── 5. The person cap ───────────────────────────────────────────────────────────────────────────────────────
    const adaOnMel = await vouch(ada, mel, 25);
    assert(adaOnMel.status === 409 && adaOnMel.body?.code === 'over_person_max' && adaOnMel.body?.personMax === 500
        && adaOnMel.body?.error === '@Mel has 500 Beans of vouches already, and one person’s vouches come to 500 at most.',
        `5. Mel holds 500 from an owner: an admin's 25 on top is refused, "${adaOnMel.body?.error}"`);
    require_((await vouch(jane, sam, 100)).status === 200 && (await vouch(dan, sam, 100)).status === 200, 'Jane and Dan vouch 100 each for Sam: 300 from three vouchers');
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(uma, owen), amount: 500 })).status === 201, 'Uma is made a voucher');
    const fourth = await vouch(uma, sam, 25);
    assert(fourth.status === 409 && fourth.body?.code === 'three_vouches', `5. without an owner, 300 from three vouchers: a fourth voucher refused (${show(fourth)})`);
    const owenTops500 = await vouch(owen, sam, 500);
    assert(owenTops500.status === 409 && owenTops500.body?.code === 'over_person_max' && owenTops500.body?.personTotal === 300,
        `5. an owner's 500 on Sam's 300 would pass 500: refused (${show(owenTops500)})`);
    const owenTops200 = await vouch(owen, sam, 200);
    assert(owenTops200.status === 200 && roomOf(sam.pk) === 500, `5. an owner tops Sam's 300 up to 500 with a 200, past the three vouchers (${show(owenTops200)})`);
    const owenRaise = await raiseTo(owen, sam, 500);
    const danRaise = await raiseTo(dan, sam, 100);
    const danRaiseHigh = await raiseTo(dan, sam, 200);
    assert(owenRaise.body?.code === 'over_person_max' && danRaise.body?.code === 'raise_not_above' && danRaiseHigh.body?.code === 'owner_amount' && roomOf(sam.pk) === 500,
        `5. and no further: the owner's raise to 500 is refused at 500 for the person, Dan's to 100 is no raise and a 200 is not his to give (${show(owenRaise)} | ${show(danRaise)} | ${show(danRaiseHigh)})`);
    const owenRaiseTom = await raiseTo(owen, tom, 500);
    assert(owenRaiseTom.status === 409 && owenRaiseTom.body?.code === 'raise_not_above' && owenRaiseTom.body?.error === 'You’ve vouched 500 Beans for @Tom already. Pick a higher total to raise it to.',
        `5. an owner's own vouch for one person comes to 500 at most: Tom's 500 has no higher total to raise to (${show(owenRaiseTom)})`);

    // ── 6. Nobody sets an owner's budget ────────────────────────────────────────────────────────────────────────
    const linesBefore6 = allLines();
    const adaSetsOwen = await setLevel(ada, owen, 2000);
    const oraSetsOwen = await setLevel(ora, owen, 500);
    const adaStopsOwen = await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`);
    assert(adaSetsOwen.status === 409 && adaSetsOwen.body?.code === 'no_limit' && oraSetsOwen.status === 409 && oraSetsOwen.body?.code === 'no_limit'
        && adaSetsOwen.body?.error === '@Owen is an owner: owners vouch with no limit, so there is no budget to set.'
        && adaStopsOwen.status === 409 && adaStopsOwen.body?.code === 'role_voucher' && /with no limit, so there is no budget to stop or set/.test(adaStopsOwen.body?.error ?? '')
        && allLines() === linesBefore6,
        `6. a committee admin and another owner can't set an owner's budget, nor stop it, nothing written (${[adaSetsOwen, oraSetsOwen, adaStopsOwen].map(show).join(' | ')})`);
    const owenSetsAda = await setLevel(owen, ada, 1500);
    assert(owenSetsAda.status === 200 && budgetOf(ada.pk).level === 1500, `6. an admin's budget is set as before (${owenSetsAda.status})`);

    // ── 7. The block and the card ───────────────────────────────────────────────────────────────────────────────
    const block = await call(ada, 'GET', '/api/names/vouchers');
    const owenRow = block.body?.vouchers?.find((v: any) => v.memberPubkey === owen.pk);
    const adaRow = block.body?.vouchers?.find((v: any) => v.memberPubkey === ada.pk);
    assert(block.status === 200 && owenRow?.noLimit === true && owenRow?.vouched === 500 + 200 + 500 + 500 + 200 && owenRow?.peopleVouched === 5
        && adaRow?.noLimit === false && JSON.stringify(block.body?.settings?.ownerPresets) === '[25,50,75,100,200,500]',
        `7. the block: Owen's row says no limit, every vouch counted (${owenRow?.vouched} to ${owenRow?.peopleVouched} people); Ada's doesn't (${show(block)})`);
    const card = await call(ada, 'GET', `/api/names/vouchers/${owen.pk}`);
    assert(card.status === 200 && card.body?.noLimit === true && card.body?.history?.some((h: any) => h.kind === 'hold' && h.amount === -500 && h.person?.memberPubkey === mel.pk),
        `7. the card: no limit, and its history names the 500 vouched for Mel (${card.status})`);

    // ── 8. A lapsed owner's invite; an owner steps down ─────────────────────────────────────────────────────────
    const lapsing = await generate(owen, 500);
    require_(lapsing.status === 200, 'Owen makes an invite with 500');
    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(lapsing.body?.invite?.code);
    returnLapsedHolds(owen.pk);
    assert(count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", lapsing.body?.invite?.code) === 1
        && JSON.stringify(budgetSlim(owen.pk)) === JSON.stringify(owenBefore),
        `8. an owner's invite that lapsed is returned on the ledger, and the budget is still ${JSON.stringify(budgetSlim(owen.pk))}`);
    const oraInvite = await generate(ora, 500);
    const oraVouch = await vouch(ora, uma, 200);
    require_(oraInvite.status === 200 && oraVouch.status === 200, `Ora, an owner, holds 500 on an invite and vouches 200 for Uma (${show(oraInvite)} | ${show(oraVouch)})`);
    grantNodeRole(ora.pk, 'admin', owen.pk);
    const oraAfter = budgetSlim(ora.pk);
    assert(oraAfter.left === 1000 && oraAfter.held === 0 && oraAfter.level === 1000,
        `8. Ora steps down to admin: the 1,000 the role gave her is whole, her owner's vouches drew none of it (${JSON.stringify(oraAfter)})`);
    const oraMe = await call(ora, 'GET', '/api/vouchers/me');
    const ora200 = await vouch(ora, sam, 200);
    assert(oraMe.body?.noLimit === false && JSON.stringify(oraMe.body?.presets) === '[25,50,75,100]' && ora200.status === 403 && ora200.body?.code === 'owner_amount',
        `8. as an admin she picks from the four again, and a 200 is refused (${show(oraMe)} | ${show(ora200)})`);
    const vic = newId('Vic');
    const vicRedeem = await redeem(vic, oraInvite.body?.invite?.code);
    assert(vicRedeem.status === 200 && vicRedeem.body?.vouch?.landed === 500 && roomOf(vic.pk) === 500 && JSON.stringify(budgetSlim(ora.pk)) === JSON.stringify(oraAfter),
        `8. her invite made as an owner still lands its 500, and her admin budget is untouched (${show(vicRedeem)})`);
    const setOra = await setLevel(owen, ora, 600);
    assert(setOra.status === 200 && budgetOf(ora.pk).level === 600, `8. now an admin, her budget is set as any admin's (${setOra.status})`);

    // ── 9. No Bean moved; every vouch has its hold ──────────────────────────────────────────────────────────────
    assert(sumBalances() === balancesBefore, `9. no Bean moved (${balancesBefore} before, ${sumBalances()} after)`);
    const unheld = count(`SELECT COUNT(*) AS n FROM room_gifts g WHERE g.kind = 'vouch' AND NOT EXISTS (SELECT 1 FROM voucher_allocations h
        WHERE h.member_pubkey = g.from_pubkey AND h.kind = 'hold' AND h.ref IN (g.id, g.invite_code))`);
    const ownerHolds = count(`SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'hold' AND actor = ?`, OWNER_VOUCH_ACTOR);
    assert(unheld === 0 && ownerHolds === 8, `9. every vouch is a room_gifts row with its hold in the allocation ledger (${unheld} without), ${ownerHolds} of them an owner's`);

    // ── 10. A raise is a target (invites-vouching I6) ───────────────────────────────────────────────────────────
    const [rae, ned, ivy] = [newId('Rae'), newId('Ned'), newId('Ivy')];
    for (const who of [rae, ned, ivy]) enter(who);
    require_((await vouch(owen, rae, 100)).status === 200 && roomOf(rae.pk) === 100, 'Owen vouches 100 for Rae');
    const owenBudget10 = JSON.stringify(budgetSlim(owen.pk));
    const to200 = await raiseTo(owen, rae, 200);
    const owenLast = lines(owen.pk).at(-1);
    assert(to200.status === 200 && to200.body?.amount === 100 && to200.body?.total === 200 && roomOf(rae.pk) === 200
        && owenLast?.kind === 'hold' && owenLast.amount === -100 && owenLast.actor === OWNER_VOUCH_ACTOR && JSON.stringify(budgetSlim(owen.pk)) === owenBudget10,
        `10. an owner at 100 raises to 200: the difference (100) lands and is held as an owner's, drawing no budget (${show(to200)} | ${JSON.stringify(owenLast)})`);
    const linesBefore10 = allLines();
    const refused10 = [
        ['300 is no preset', await raiseTo(owen, rae, 300), 400, 'bad_amount'],
        ['the same total again', await raiseTo(owen, rae, 200), 409, 'raise_not_above'],
        ['a total below', await raiseTo(owen, rae, 100), 409, 'raise_not_above'],
        ['someone never vouched for', await raiseTo(owen, ned, 200), 409, 'no_vouch_yet'],
        ['a vouch amount sent with a target', await call(owen, 'POST', '/api/vouch', { memberPubkey: rae.pk, vouchAmount: 25, raiseTo: 500 }), 400, 'bad_body'],
        ['a target that is a string', await raiseTo(owen, rae, '500'), 400, 'bad_amount'],
    ] as const;
    for (const [what, res, status, code] of refused10) {
        assert(res.status === status && res.body?.code === code, `10. ${what}: ${status} ${code} (${show(res)})`);
    }
    assert(allLines() === linesBefore10 && roomOf(rae.pk) === 200, '10. none of the refused raises wrote a line or a room');
    const to500 = await raiseTo(owen, rae, 500);
    assert(to500.status === 200 && to500.body?.amount === 300 && to500.body?.total === 500 && roomOf(rae.pk) === 500
        && count("SELECT COUNT(*) AS n FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ? AND kind = 'vouch'", owen.pk, rae.pk) === 3,
        `10. then 200 to 500: 300 lands as a third room row (${show(to500)})`);
    // An admin's raise: a first vouch of 25, then 100 draws the 75 from the budget; 200 is not hers to give.
    require_((await vouch(dan, ivy, 25)).status === 200, 'Dan vouches 25 for Ivy');
    const danBefore = budgetOf(dan.pk).left;
    const danTo100 = await raiseTo(dan, ivy, 100);
    const danTo200 = await raiseTo(dan, ivy, 200);
    assert(danTo100.status === 200 && danTo100.body?.amount === 75 && budgetOf(dan.pk).left === danBefore - 75 && danTo200.status === 403 && danTo200.body?.code === 'owner_amount' && roomOf(ivy.pk) === 100,
        `10. an admin raises 25 to 100 (75 drawn from the budget) and is refused an owner's 200 (${show(danTo100)} | ${show(danTo200)})`);
    assert(sumBalances() === balancesBefore, `10. no Bean moved by any raise (${balancesBefore} before, ${sumBalances()} after)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
