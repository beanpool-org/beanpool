/**
 * Vouchers V1 (engine/vouchers.ts; scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §2 to §7 V1, Marty's
 * decisions §9 to §11). Through the real HTTPS stack and its signature middleware for every route and refusal; in this
 * process for the property test and the thousand vouches.
 *
 *  1. Role budgets: an owner and an admin hold 1,000 by role from the grant, with no entry; a member holds none.
 *  2. The vouchers block is the committee's; an owner puts an admin on it.
 *  3. Making a voucher from a confirmed entry: 150 and 2,100 refused, 500 made; unconfirmed, waiting, self refused; a role
 *     voucher made one from their entry gets nothing new.
 *  4. The vouch on an invite: a non-voucher's, a 60, and a 100 with 75 left each refused with the sentence; a preset held.
 *  5. Set to a level: 150 and 2,100 refused, below what is held refused, a raise and a lower written as the difference, a
 *     lower leaves room already given untouched, left + held at 2,000 at most.
 *  6. The profile vouch: a second separate vouch refused, a raise to 100 passes, past 100 refused; a fourth voucher refused;
 *     a member below zero refused; an invite's vouch is that pair's one vouch; the credit line it gives (one offer).
 *  7. A demoted admin's held code redeems with no vouch and the sentence; the committee flag clears with the role.
 *  8. A revoked confirmation stops a list budget; a held code comes back at expiry, a redeemed one never.
 *  9. Both departure paths: the Commons pays exactly as before (memo, amount) and the room is stamped written off.
 * 10. The password session is refused on every writer; Beans off (before any Bean moves) refuses every writer and writes no
 *     role budget.
 * 11. The boot's grant (migration:vouchers) to an owner or admin who never had a budget, once.
 * 12. Property test: across random sequences no voucher's lines sum below zero and left + held never passes 2,000.
 * 13. A thousand vouches: the ledger audit sums to zero, and no Bean moved.
 * 14. A standby's copy carries the three tables.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import {
    initStateEngine, exportSyncState, getBalance, adminPruneUser, purgeMemberSelf, transfer, createPost as rawCreatePost,
    generateInvite, redeemInvite, runLedgerAudit, usableFloor, COMMUNITY_DECISION_ACTOR,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride, getProfileSwitches } from './config/node-profile.js';
import { wrapCreatePost } from './post-test-helper.js';
import { TABLES } from './engine/replication-manifest.js';
import { setMemberPhoto } from '@beanpool/engine';
import { pruneUnusedInvites } from './engine/writer-bounds.js';
import {
    VOUCHER_WORDS, VOUCHERS_MIGRATION_ACTOR, budgetOf, grantMissingRoleBudgets, makeVoucher, setBudgetLevel, stopVoucher,
    vouchFromProfile, returnLapsedHolds,
} from './engine/vouchers.js';

const createPost = wrapCreatePost(rawCreatePost);
let BASE = '';
const ADMIN_PW = 'Vouchers-Suite-Admin-Pw-77!';
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
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
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

const generate = (id: Id, vouchAmount?: unknown) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk, ...(vouchAmount === undefined ? {} : { vouchAmount }) });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const vouch = (by: Id, who: Id, vouchAmount: unknown, raise?: boolean) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, vouchAmount, ...(raise ? { raise: true } : {}) });
const setLevel = (by: Id, who: Id, level: unknown) => call(by, 'POST', `/api/names/vouchers/${who.pk}/budget`, { level });

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const lines = (pk: string) => db.prepare('SELECT kind, amount, actor, ref FROM voucher_allocations WHERE member_pubkey = ? ORDER BY rowid').all(pk) as { kind: string; amount: number; actor: string; ref: string | null }[];
const sumLines = (pk: string) => count('SELECT COALESCE(SUM(amount), 0) AS n FROM voucher_allocations WHERE member_pubkey = ?', pk);
const allLines = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
const roomOf = (pk: string) => count("SELECT COALESCE(SUM(amount), 0) AS n FROM room_gifts WHERE to_pubkey = ?", pk);
const sumBalances = () => count('SELECT ROUND(COALESCE(SUM(balance), 0), 2) AS n FROM accounts');

/** A confirmation on a fresh entry, written as the names list's confirmMember writes it (setup only: the list's crypto is its own suite's). */
function confirm(member: Id, by: Id, awaitingSecond = false): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk, awaitingSecond ? 1 : 0);
    return entryId;
}

async function join(owner: Id, who: Id): Promise<void> {
    const made = await generate(owner);
    require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with ${owner.name}'s invite (${show(made)})`);
}

/** A member below zero the real way: a live offer and a marketplace spend within their usable floor (a ledger move). */
const FACE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** A live offer, as the marketplace asks for one: a member with a profile photo posts it. */
function offer(who: Id): void {
    setMemberPhoto(db, who.pk, FACE);
    createPost('offer', 'general', `${who.name}'s offer`, 'An offer to keep a line open', 10, 'fixed', who.pk);
}

function spendBelowZero(who: Id, to: Id, amount: number): void {
    offer(who);
    const tx = transfer(who.pk, to.pk, amount, 'A purchase for the suite', 'escrow');
    require_(!!tx && getBalance(who.pk).balance < 0, `${who.name} spends ${amount} within their line and is below zero (${getBalance(who.pk).balance})`);
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
    const [ada, dan, mel, jane, bea, sam, tom, uma, vic, kai, lou] = ['Ada', 'Dan', 'Mel', 'Jane', 'Bea', 'Sam', 'Tom', 'Uma', 'Vic', 'Kai', 'Lou'].map(newId);
    for (const who of [ada, dan, mel, jane, bea, sam, tom, kai, lou]) await join(owen, who);

    // ── 1. Role budgets ──────────────────────────────────────────────────────────────────────────────────────
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [dan, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }
    const owenLines = lines(owen.pk);
    assert(owenLines.length === 1 && owenLines[0].kind === 'grant' && owenLines[0].amount === 1000 && owenLines[0].actor === 'owner:password',
        `1. the owner holds a budget of 1,000 by role from the grant, its actor the granting owner (${JSON.stringify(owenLines)})`);
    assert(budgetOf(ada.pk).left === 1000 && (db.prepare('SELECT source, entry_id FROM vouchers WHERE member_pubkey = ?').get(ada.pk) as any)?.source === 'role',
        '1. an admin holds 1,000 by role too, with no entry');
    const melMe = await call(mel, 'GET', '/api/vouchers/me');
    const owenMe = await call(owen, 'GET', '/api/vouchers/me');
    assert(melMe.status === 200 && melMe.body?.voucher === false && owenMe.body?.voucher === true && owenMe.body?.budget?.left === 1000
        && JSON.stringify(owenMe.body?.presets) === '[25,50,75,100]', `1. /api/vouchers/me: a member is no voucher, the owner is, with 1,000 left (${show(owenMe)})`);
    const owenInvite = await generate(owen, 100);
    const kaiId = newId('Kai2');
    const owenRedeem = await redeem(kaiId, owenInvite.body?.invite?.code);
    assert(owenInvite.status === 200 && owenRedeem.status === 200 && owenRedeem.body?.vouch?.landed === 100 && roomOf(kaiId.pk) === 100,
        `1. an owner vouches with no entry: an invite with 100 lands on the joiner (${show(owenRedeem)})`);

    // ── 2. The block is the committee's ─────────────────────────────────────────────────────────────────────────
    const adaBlock = await call(ada, 'GET', '/api/names/vouchers');
    assert(adaBlock.status === 403 && adaBlock.body?.code === 'committee_only' && adaBlock.body?.error === VOUCHER_WORDS.committeeOnly,
        `2. an admin not on the credit committee is refused the vouchers block, with the sentence (${show(adaBlock)})`);
    const melBlock = await call(mel, 'GET', '/api/names/vouchers');
    assert(melBlock.status === 403, `2. a member is refused it (${show(melBlock)})`);
    const onCommittee = await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: true });
    const adaBlock2 = await call(ada, 'GET', '/api/names/vouchers');
    assert(onCommittee.status === 200 && onCommittee.body?.committee === true && adaBlock2.status === 200
        && adaBlock2.body?.vouchers?.some((v: any) => v.memberPubkey === owen.pk && v.left === 900 && v.vouched === 100),
        `2. an owner puts Ada on the committee, and she reads the block: Owen 900 left, 100 vouched (${show(adaBlock2)})`);
    const adaPutsDan = await call(ada, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true });
    assert(adaPutsDan.status === 403 && adaPutsDan.body?.code === 'owner_only', `2. only an owner puts admins on the committee (${show(adaPutsDan)})`);

    // ── 10a. Beans off, before any Bean moves (a node whose ledger moved keeps Beans on: node-profile lockToLedger) ────
    const janeEntryOff = confirm(jane, owen);
    setSwitchOverride('beans', false);
    require_(!getProfileSwitches().beans, 'Beans are switched off (no Bean has moved yet)');
    const linesBeforeOff = allLines();
    const off = [
        await call(owen, 'POST', `/api/names/vouchers/${ada.pk}/budget`, { level: 500 }), await vouch(owen, mel, 25), await generate(owen, 25),
        await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntryOff, amount: 500 }), await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`),
        await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: 500 }), await call(owen, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true }),
    ];
    assert(off.every((r) => r.status === 403 && r.body?.code === 'profile_no_beans') && allLines() === linesBeforeOff,
        `10. with Beans off every writer is refused, nothing written (${off.map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: lou.pk, role: 'admin' }, PASSWORD())).status === 200, 'Lou is made an admin while Beans are off');
    assert(!db.prepare('SELECT 1 FROM vouchers WHERE member_pubkey = ?').get(lou.pk), '10. a role granted with Beans off writes no budget');
    setSwitchOverride('beans', true);
    require_(getProfileSwitches().beans, 'Beans are on again');
    db.prepare('UPDATE confirmations SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE entry_id = ?').run(new Date().toISOString(), owen.pk, 'admin', janeEntryOff);

    // ── 3. Making a voucher from a confirmed entry ─────────────────────────────────────────────────────────────
    const janeEntry = confirm(jane, owen);
    const before3 = allLines();
    const m150 = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount: 150 });
    const m2100 = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount: 2100 });
    assert(m150.status === 400 && m2100.status === 400 && m150.body?.code === 'bad_level' && m150.body?.error === VOUCHER_WORDS.badLevel && allLines() === before3,
        `3. an allocation of 150 or 2,100 is refused with the sentence, nothing written (${show(m150)} | ${show(m2100)})`);
    const unconfirmed = await call(owen, 'POST', '/api/names/vouchers', { entryId: crypto.randomBytes(16).toString('hex'), amount: 500 });
    const waiting = await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(lou, ada, true), amount: 500 });
    const adaEntry = confirm(ada, owen);
    const self = await call(ada, 'POST', '/api/names/vouchers', { entryId: adaEntry, amount: 500 });
    const byMember = await call(mel, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount: 500 });
    assert(unconfirmed.body?.code === 'not_confirmed' && waiting.body?.code === 'awaiting_second' && self.body?.code === 'own_budget' && byMember.status === 403,
        `3. an entry nobody is confirmed on, one waiting for a second admin, your own, and a member's ask are refused (${unconfirmed.body?.code} ${waiting.body?.code} ${self.body?.code} ${byMember.status})`);
    const made = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount: 500 });
    assert(made.status === 201 && made.body?.left === 500 && made.body?.source === 'entry' && lines(jane.pk).length === 1,
        `3. Owen makes Jane a voucher from her entry with 500 (${show(made)})`);
    const again = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount: 500 });
    assert(again.status === 409 && again.body?.code === 'already_voucher', `3. not twice (${show(again)})`);
    const adaLinesBefore = lines(ada.pk).length;
    const flip = await call(owen, 'POST', '/api/names/vouchers', { entryId: adaEntry, amount: 500 });
    assert(flip.status === 201 && flip.body?.source === 'entry' && flip.body?.left === 1000 && lines(ada.pk).length === adaLinesBefore,
        `3. a role voucher made one from her entry gets nothing new: the source moves to the entry (${show(flip)})`);
    const logMade = count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_made' AND member_pubkey = ?", jane.pk);
    assert(logMade === 1, '3. the appointment is a line in the known floor’s log');

    // ── 4. The vouch on an invite ───────────────────────────────────────────────────────────────────────────────
    const invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    const nonVoucher = await generate(mel, 25);
    assert(nonVoucher.status === 403 && nonVoucher.body?.code === 'not_a_voucher' && nonVoucher.body?.error === VOUCHER_WORDS.notAVoucher
        && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore, `4. a non-voucher's vouchAmount is refused with the sentence, no invite made (${show(nonVoucher)})`);
    const sixty = await generate(jane, 60);
    assert(sixty.status === 400 && sixty.body?.error === VOUCHER_WORDS.badAmount, `4. a 60 is refused with the sentence (${show(sixty)})`);
    require_((await setLevel(owen, jane, 100)).status === 200 && budgetOf(jane.pk).left === 100, 'Jane’s budget is set down to 100');
    const held25 = await generate(jane, 25);
    require_(held25.status === 200 && held25.body?.invite?.vouchAmount === 25 && budgetOf(jane.pk).left === 75 && budgetOf(jane.pk).held === 25,
        `4. a 25 is held from Jane's budget with the code (${show(held25)})`);
    const hundred = await generate(jane, 100);
    assert(hundred.status === 409 && hundred.body?.code === 'not_enough' && /You have 75 Beans of budget left/.test(hundred.body?.error ?? ''),
        `4. a 100 with 75 left is refused with the sentence (${show(hundred)})`);

    // ── 5. Set to a level ───────────────────────────────────────────────────────────────────────────────────────
    const l150 = await setLevel(owen, jane, 150);
    const l2100 = await setLevel(owen, jane, 2100);
    assert(l150.body?.code === 'bad_level' && l2100.body?.code === 'bad_level' && l2100.body?.error === VOUCHER_WORDS.badLevel,
        `5. a level of 150, or 2,100 (left + held over 2,000), is refused (${show(l2100)})`);
    require_((await setLevel(owen, jane, 500)).status === 200, 'Jane is set to 500');
    const h100a = await generate(jane, 100);
    const h100b = await generate(jane, 100);
    require_(h100a.status === 200 && h100b.status === 200 && budgetOf(jane.pk).held === 225, `Jane holds 225 on three invites (${JSON.stringify(budgetOf(jane.pk))})`);
    const belowHeld = await setLevel(owen, jane, 200);
    assert(belowHeld.status === 409 && belowHeld.body?.code === 'below_held' && /225 Beans held/.test(belowHeld.body?.error ?? ''),
        `5. a lower below what is held is refused (${show(belowHeld)})`);
    const toMax = await setLevel(owen, jane, 2000);
    const jb = budgetOf(jane.pk);
    assert(toMax.status === 200 && jb.left + jb.held === 2000 && jb.left === 1775 && lines(jane.pk).at(-1)?.kind === 'top_up' && lines(jane.pk).at(-1)?.amount === 1500,
        `5. a raise to 2,000 writes top_up +1,500: left 1,775 + held 225 (${JSON.stringify(jb)})`);
    const same = await setLevel(owen, jane, 2000);
    assert(same.status === 200 && same.body?.changed === false && lines(jane.pk).at(-1)?.amount === 1500, '5. the same level again writes nothing');
    const own = await setLevel(ada, ada, 2000);
    assert(own.status === 403 && own.body?.code === 'own_budget', `5. nobody sets their own (${show(own)})`);
    // Room given, then a lower: the room stays exactly as it was.
    require_((await vouch(jane, sam, 25)).status === 200, 'Jane vouches 25 for Sam from his profile');
    const samRoom = roomOf(sam.pk);
    const lower = await setLevel(owen, jane, 1000);
    const jl = lines(jane.pk).at(-1);
    assert(lower.status === 200 && jl?.kind === 'lower' && jl.amount === -975 && roomOf(sam.pk) === samRoom && budgetOf(jane.pk).vouched === 25,
        `5. a lower writes lower −975 and leaves the room already given untouched (${JSON.stringify(jl)}, Sam ${roomOf(sam.pk)})`);

    // ── 6. The profile vouch ─────────────────────────────────────────────────────────────────────────────────────
    const second = await vouch(jane, sam, 25);
    assert(second.status === 409 && second.body?.code === 'already_vouched' && second.body?.error === 'You’ve already vouched for @Sam.',
        `6. a second separate vouch by the same voucher is refused: "${second.body?.error}"`);
    const raise100 = await vouch(jane, sam, 75, true);
    assert(raise100.status === 200 && raise100.body?.total === 100 && count("SELECT COUNT(*) AS n FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ?", jane.pk, sam.pk) === 2,
        `6. a raise to 100 passes: a further hold and room_gifts row on the same pair (${show(raise100)})`);
    const past = await vouch(jane, sam, 25, true);
    assert(past.status === 409 && past.body?.code === 'over_max', `6. a raise past 100 is refused (${show(past)})`);
    require_((await vouch(owen, sam, 25)).status === 200 && (await vouch(ada, sam, 25)).status === 200, 'Owen and Ada vouch for Sam too: three vouchers');
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(bea, owen), amount: 500 })).status === 201, 'Bea is made a voucher');
    const fourth = await vouch(bea, sam, 25);
    assert(fourth.status === 409 && fourth.body?.code === 'three_vouches' && fourth.body?.error === '@Sam has three vouches.',
        `6. a fourth voucher's vouch is refused: "${fourth.body?.error}"`);
    const raiseOfThree = await vouch(owen, sam, 25, true);
    assert(raiseOfThree.status === 200, `6. one of the three may still raise theirs (${show(raiseOfThree)})`);
    // The credit line it gives: one live offer unlocks it whole; the badge ignores it.
    const samBal = getBalance(sam.pk);
    assert(samBal.roomHeld === 175 && samBal.floor === -175 && samBal.usableFloor === 0 && samBal.tierCredit === 0,
        `6. Sam's line is the room people gave him (175), none usable without a live offer, never his badge (${JSON.stringify({ r: samBal.roomHeld, f: samBal.floor, u: samBal.usableFloor, t: samBal.tierCredit })})`);
    offer(sam);
    assert(usableFloor(sam.pk) === -175, `6. one live offer unlocks all of it (${usableFloor(sam.pk)})`);
    const samLedger = await call(sam, 'GET', `/api/ledger/balance/${sam.pk}`);
    assert(samLedger.status === 200 && samLedger.body?.vouchedBy?.length === 3 && samLedger.body.vouchedBy[0].memberPubkey === jane.pk && samLedger.body.vouchedBy[0].amount === 100,
        `6. Sam's own Ledger names who vouched for him and how much (${JSON.stringify(samLedger.body?.vouchedBy)})`);
    const samProfile = await call(mel, 'GET', `/api/profile/${sam.pk}`);
    assert(!samProfile.text.includes('vouchedBy') && !samProfile.text.includes(jane.pk), '6. never on his public profile');
    // Below zero.
    require_((await vouch(owen, tom, 100)).status === 200, 'Owen vouches 100 for Tom');
    spendBelowZero(tom, mel, 30);
    const below = await vouch(jane, tom, 25);
    assert(below.status === 409 && below.body?.code === 'below_zero' && below.body?.error === '@Tom is below zero: a credit-line gift or a Decision can help.',
        `6. a vouch for a member below zero is refused: "${below.body?.error}"`);
    // An invite's vouch is that pair's one vouch.
    const janeForUma = await generate(jane, 50);
    const umaJoins = await redeem(uma, janeForUma.body?.invite?.code);
    require_(umaJoins.status === 200 && umaJoins.body?.vouch?.landed === 50 && roomOf(uma.pk) === 50, `Uma joins on Jane's invite with a 50 vouch (${show(umaJoins)})`);
    const umaSecond = await vouch(jane, uma, 25);
    const umaRaise = await vouch(jane, uma, 50, true);
    assert(umaSecond.body?.code === 'already_vouched' && umaRaise.status === 200 && umaRaise.body?.total === 100,
        `6. an invite vouch counts as that pair's one vouch: a separate one refused, a raise to 100 passes (${umaSecond.body?.code} ${show(umaRaise)})`);
    const selfVouch = await vouch(jane, jane, 25);
    assert(selfVouch.status === 403 && selfVouch.body?.code === 'own_vouch', '6. never for yourself');

    // ── 7. A demoted admin's held code; the committee flag clears with the role ─────────────────────────────
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true })).status === 200, 'Dan is put on the committee');
    const danHeld = await generate(dan, 50);
    require_(danHeld.status === 200 && budgetOf(dan.pk).held === 50, 'Dan, an admin, holds 50 on an invite');
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: dan.pk, role: 'moderator' }, PASSWORD())).status === 200, 'Dan is made a moderator');
    const danRow = db.prepare('SELECT stopped_at, stop_reason FROM vouchers WHERE member_pubkey = ?').get(dan.pk) as any;
    const danCommittee = (db.prepare('SELECT credit_committee FROM members WHERE public_key = ?').get(dan.pk) as any)?.credit_committee;
    assert(danRow?.stop_reason === 'role_lost' && sumLines(dan.pk) === 0 && danCommittee === 0
        && count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'committee' AND member_pubkey = ? AND new_value = 'off'", dan.pk) === 1,
        `7. losing the role stops the budget (holds back, a stop line, 0 left) and clears the committee flag (${JSON.stringify(danRow)}, committee ${danCommittee})`);
    const vicJoins = await redeem(vic, danHeld.body?.invite?.code);
    assert(vicJoins.status === 200 && vicJoins.body?.vouch?.ended === VOUCHER_WORDS.voucherEnded && roomOf(vic.pk) === 0,
        `7. the demoted admin's held code still redeems, with no vouch and the sentence (${show(vicJoins)})`);
    const danVouch = await vouch(dan, mel, 25);
    assert(danVouch.status === 403 && danVouch.body?.code === 'not_a_voucher', '7. and he vouches no more');

    // ── 8. A revoked confirmation; expiry ───────────────────────────────────────────────────────────────────────
    const beaConf = db.prepare('SELECT id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(bea.pk) as { id: string };
    require_((await call(owen, 'POST', `/api/names/confirmations/${beaConf.id}/revoke`, {})).status === 200, 'Bea’s confirmation is revoked');
    assert((db.prepare('SELECT stop_reason FROM vouchers WHERE member_pubkey = ?').get(bea.pk) as any)?.stop_reason === 'revoked' && sumLines(bea.pk) === 0,
        '8. a revoked confirmation stops a list budget');
    const roleStop = await call(owen, 'DELETE', `/api/names/vouchers/${ada.pk}`);
    const ownerStop = await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`);
    assert(roleStop.status === 200 && ownerStop.status === 409 && ownerStop.body?.code === 'role_voucher',
        `8. Stop vouching stops a list budget (Ada's, moved to her entry) and refuses a role's (${roleStop.status} ${show(ownerStop)})`);
    const janeHeldBefore = budgetOf(jane.pk);
    const heldCode = h100a.body?.invite?.code as string;
    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(heldCode);
    const usedReturnsBefore = count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", janeForUma.body?.invite?.code);
    pruneUnusedInvites();
    const janeAfter = budgetOf(jane.pk);
    assert(janeAfter.left === janeHeldBefore.left + 100 && janeAfter.held === janeHeldBefore.held - 100
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", heldCode) === 1
        && !db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(heldCode),
        `8. a held code past its 30 days comes back to the budget as the prune deletes it (${JSON.stringify(janeHeldBefore)} → ${JSON.stringify(janeAfter)})`);
    assert(usedReturnsBefore === 0 && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", janeForUma.body?.invite?.code) === 0,
        '8. a redeemed code never comes back');

    // ── 9. Departures ───────────────────────────────────────────────────────────────────────────────────────────
    spendBelowZero(sam, mel, 40);
    const samDebt = Math.abs(getBalance(sam.pk).balance);
    // The community's removal vote carried out (decisions-engine remove_member), as on a node where members vote.
    adminPruneUser(sam.pk, COMMUNITY_DECISION_ACTOR);
    const settle = db.prepare("SELECT amount, memo FROM transactions WHERE to_pubkey = ? AND memo LIKE 'Settle bad debt for pruned user:%'").get(sam.pk) as { amount: number; memo: string } | undefined;
    assert(settle?.memo === `Settle bad debt for pruned user: ${sam.pk.slice(0, 8)}` && Math.abs((settle?.amount ?? 0) - samDebt) < 0.005,
        `9. a prune pays the Commons exactly as before: the same memo and amount (${JSON.stringify(settle)}, debt ${samDebt})`);
    const stamped = db.prepare('SELECT amount, written_off FROM room_gifts WHERE to_pubkey = ? ORDER BY at, id').all(sam.pk) as { amount: number; written_off: number | null }[];
    const writtenOff = stamped.reduce((n, r) => n + (r.written_off ?? 0), 0);
    assert(stamped.every((r) => r.written_off !== null) && Math.abs(writtenOff - samDebt) < 0.005 && stamped[0].written_off === Math.min(samDebt, stamped[0].amount),
        `9. and stamps the room he held with the debt, oldest first (${JSON.stringify(stamped)})`);
    const janeCard = await call(owen, 'GET', `/api/names/vouchers/${jane.pk}`);
    assert(janeCard.status === 200 && janeCard.body?.writtenOff > 0 && janeCard.body?.people?.some((p: any) => p.memberPubkey === sam.pk && p.left === true && p.raised === true),
        `9. Jane's card sums what was written off and marks Sam gone and raised (${show(janeCard)})`);
    assert(count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_looked' AND member_pubkey = ?", jane.pk) === 1, '9. opening the card is a logged look');
    spendBelowZero(uma, mel, 10);
    const umaDebt = Math.abs(getBalance(uma.pk).balance);
    purgeMemberSelf(uma.pk);
    const umaStamped = db.prepare('SELECT COALESCE(SUM(written_off), 0) AS n FROM room_gifts WHERE to_pubkey = ?').get(uma.pk) as { n: number };
    assert(Math.abs(umaStamped.n - umaDebt) < 0.005 && !!db.prepare("SELECT 1 FROM transactions WHERE to_pubkey = ? AND memo LIKE 'Settle bad debt for self-purged user:%'").get(uma.pk),
        `9. a member's own account deletion stamps the room too, the Commons paying as before (${umaStamped.n} of ${umaDebt})`);

    // ── 10. The password, and Beans off ─────────────────────────────────────────────────────────────────────────
    const linesBefore10 = allLines();
    const writers: Array<[Method, string, unknown]> = [
        ['POST', '/api/names/vouchers', { entryId: janeEntry, amount: 500 }], ['DELETE', `/api/names/vouchers/${jane.pk}`, undefined],
        ['POST', `/api/names/vouchers/${jane.pk}/budget`, { level: 500 }], ['POST', '/api/names/vouchers/settings', { voucherBudget: 500 }],
        ['POST', '/api/names/committee', { memberPubkey: ada.pk, on: false }], ['POST', '/api/vouch', { memberPubkey: mel.pk, vouchAmount: 25 }],
    ];
    const byPassword = await Promise.all(writers.map(([m, p, b]) => call(null, m, p, b, PASSWORD())));
    assert(byPassword.every((r) => r.status === 401 || r.status === 403) && allLines() === linesBefore10,
        `10. the password session is refused on every writer, nothing written (${byPassword.map((r) => r.status).join(' ')})`);

    // ── 11. The boot's grant to an owner or admin who never had a budget ──────────────────────────────────────
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'shell')").run(kai.pk);
    const granted = grantMissingRoleBudgets();
    const kaiLines = lines(kai.pk);
    assert(granted === 2 && kaiLines.length === 1 && kaiLines[0].amount === 1000 && kaiLines[0].actor === VOUCHERS_MIGRATION_ACTOR
        && lines(lou.pk).length === 1 && lines(lou.pk)[0].actor === VOUCHERS_MIGRATION_ACTOR,
        `11. at boot an admin made outside grantNodeRole gets 1,000, actor migration:vouchers, and so does one made while Beans were off (${granted}: ${JSON.stringify(kaiLines)})`);
    assert(grantMissingRoleBudgets() === 0, '11. once: the next boot grants nothing');

    // ── 12. Property test ───────────────────────────────────────────────────────────────────────────────────────
    let seedN = 0x5eed;
    const rand = (n: number) => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN % n; };
    const pv = newId('Pia');
    await join(owen, pv);
    const pvEntry = confirm(pv, owen);
    makeVoucher(owen.pk, { entryId: pvEntry, amount: 1000 });
    const targets: string[] = [];
    for (let i = 0; i < 12; i++) {
        const k = newId(`T${i}`);
        const inv = generateInvite(owen.pk)!;
        redeemInvite(inv.code, k.pk, k.name);
        targets.push(k.pk);
    }
    const levels = [50, 100, 150, 300, 500, 900, 1000, 1500, 1800, 2000, 2100];
    let violations: string[] = [];
    let ops = 0;
    for (let step = 0; step < 400; step++) {
        const op = rand(6);
        try {
            if (op === 0) setBudgetLevel(owen.pk, pv.pk, { level: levels[rand(levels.length)] });
            else if (op === 1) generateInvite(pv.pk, undefined, undefined, undefined, [25, 50, 75, 100, 60][rand(5)]);
            else if (op === 2) {
                const open = db.prepare("SELECT code FROM invite_codes WHERE created_by = ? AND used_by IS NULL AND vouch_amount IS NOT NULL").all(pv.pk) as { code: string }[];
                if (open.length) { const k = newId(`R${step}`); redeemInvite(open[rand(open.length)].code, k.pk, k.name); }
            } else if (op === 3) {
                const open = db.prepare("SELECT code FROM invite_codes WHERE created_by = ? AND used_by IS NULL").all(pv.pk) as { code: string }[];
                if (open.length) {
                    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(open[rand(open.length)].code);
                    returnLapsedHolds();
                }
            } else if (op === 4) vouchFromProfile(pv.pk, { memberPubkey: targets[rand(targets.length)], vouchAmount: [25, 50, 75, 100][rand(4)], raise: rand(2) === 1 });
            else if (rand(8) === 0) { stopVoucher(owen.pk, pv.pk); makeVoucher(owen.pk, { entryId: pvEntry, amount: levels[rand(levels.length - 1)] }); }
            ops++;
        } catch { /* a refusal is a step too: the invariants must hold after it */ }
        const b = budgetOf(pv.pk);
        const sum = sumLines(pv.pk);
        if (sum < 0) violations.push(`step ${step}: the lines sum to ${sum}`);
        if (b.left + b.held > 2000) violations.push(`step ${step}: left ${b.left} + held ${b.held}`);
        const pair = db.prepare("SELECT to_pubkey, SUM(amount) AS n FROM room_gifts WHERE from_pubkey = ? AND kind = 'vouch' GROUP BY to_pubkey HAVING n > 100").get(pv.pk);
        if (pair) violations.push(`step ${step}: a pair above 100 ${JSON.stringify(pair)}`);
        const off = db.prepare("SELECT amount FROM room_gifts WHERE from_pubkey = ? AND amount NOT IN (25, 50, 75, 100)").get(pv.pk);
        if (off) violations.push(`step ${step}: an amount outside the set ${JSON.stringify(off)}`);
    }
    const perPerson = db.prepare("SELECT to_pubkey, COUNT(DISTINCT from_pubkey) AS n FROM room_gifts WHERE kind = 'vouch' GROUP BY to_pubkey HAVING n > 3").get();
    assert(violations.length === 0 && !perPerson && ops > 100,
        `12. property: over 400 random steps (${ops} taken), no voucher's lines sum below zero, left + held never passes 2,000, no pair passes 100, no amount leaves the set, nobody has more than 3 vouchers${violations.length ? ` — ${violations.slice(0, 4).join(' | ')}` : ''}`);
    const everySum = db.prepare('SELECT member_pubkey, SUM(amount) AS n FROM voucher_allocations GROUP BY member_pubkey HAVING n < 0').get();
    assert(!everySum, '12. and no voucher anywhere in this suite has lines summing below zero');

    // ── 13. A thousand vouches ──────────────────────────────────────────────────────────────────────────────────
    const vouchers = [owen, newId('Vee'), newId('Wes')];
    for (const v of vouchers.slice(1)) { await join(owen, v); makeVoucher(owen.pk, { entryId: confirm(v, owen), amount: 2000 }); }
    const people: string[] = [];
    for (let i = 0; i < 84; i++) {
        const inv = generateInvite(owen.pk)!;
        const k = newId(`P${i}`);
        redeemInvite(inv.code, k.pk, k.name);
        people.push(k.pk);
    }
    const balancesBefore = sumBalances();
    const commonsRowsBefore = count('SELECT COUNT(*) AS n FROM transactions');
    let vouches = 0;
    for (const p of people) {
        for (const v of vouchers) {
            for (let r = 0; r < 4; r++) {
                if (budgetOf(v.pk).left < 25) setBudgetLevel(v.pk === owen.pk ? ada.pk : owen.pk, v.pk, { level: 2000 });
                vouchFromProfile(v.pk, { memberPubkey: p, vouchAmount: 25, raise: r > 0 });
                vouches++;
            }
        }
    }
    const audit = runLedgerAudit();
    assert(vouches >= 1000 && audit.ok && Math.abs(audit.sumBalances) < 0.01 && sumBalances() === balancesBefore && count('SELECT COUNT(*) AS n FROM transactions') === commonsRowsBefore,
        `13. after ${vouches} vouches the ledger audit sums to zero (${audit.sumBalances}), no balance moved and no transaction was written`);

    // ── 14. A standby's copy carries the three tables ──────────────────────────────────────────────────────────
    const payload = await exportSyncState('vouchers-suite') as { plainTables?: Record<string, unknown[]> };
    const carried = ['vouchers', 'voucher_allocations', 'room_gifts'].map((t) => [t, payload.plainTables?.[t]?.length ?? 0, count(`SELECT COUNT(*) AS n FROM ${t}`)]);
    assert(carried.every(([, sent, have]) => sent === have && (have as number) > 0)
        && ['vouchers', 'voucher_allocations', 'room_gifts'].every((t) => (TABLES as any)[t]?.plain === true)
        && JSON.stringify(TABLES.invite_codes).includes('vouch_amount') && JSON.stringify(TABLES.members).includes('credit_committee'),
        `14. a standby's whole copy carries every row of the three tables, and the two columns (${JSON.stringify(carried)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
