/**
 * Vouchers V1 (engine/vouchers.ts; scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §2 to §7 V1, Marty's
 * decisions §9 to §11). Through the real HTTPS stack and its signature middleware for every route and refusal; in this
 * process for the property test and the thousand vouches.
 *
 *  1. Role budgets: an owner holds 1,000 by role from the grant, with no entry; a new admin holds none until an owner makes
 *     them a voucher with no names-list entry (invites-vouching I5: source the role, the grant the owner's); a member none.
 *  2. The vouchers block is the committee's; an owner puts an admin on it.
 *  3. Making a voucher from a confirmed entry: 150 and 2,100 refused, 500 made; unconfirmed, waiting, self refused; a role
 *     voucher made one from their entry gets nothing new.
 *  4. The vouch on an invite: a non-voucher's, a 60, and a 100 with 75 left each refused with the sentence; a preset held.
 *  5. Set to a level: 150 and 2,100 refused, below what is held refused, a raise and a lower written as the difference, a
 *     lower leaves room already given untouched, left + held at 2,000 at most.
 *  6. The profile vouch: a second separate vouch refused, a raise to 100 passes (the difference lands), a target at or below the
 *     total or past 100 refused; a fourth voucher refused;
 *     a member below zero refused; an invite's vouch is that pair's one vouch; the credit line it gives (one offer).
 *  7. A demoted admin's held code redeems with no vouch and the sentence; the committee flag clears with the role.
 *  8. A revoked confirmation stops a list budget; a held code comes back at expiry, a redeemed one never. A budget the role
 *     gave an admin before I5 stays until an owner stops it by hand from the card: a committee admin can't; the owner's
 *     stop returns its holds and writes one stop line, its code still lets its person in with no vouch; no Bean moves.
 *  9. Both departure paths: the Commons pays exactly as before (memo, amount) and the room is stamped written off.
 * 10. An owner's key session (an admin credential, no member's signature) is refused on every member writer, and an admin
 *     who is no voucher on a seed invite's vouch; Beans off (before any Bean moves) refuses every writer (an ask's and a
 *     knock's answer with a vouch included) and writes no role budget.
 * 11. The boot gives an admin made outside grantNodeRole no budget (I5); an owner the shell made gets one (11b), once.
 * 12. Property test: across random sequences no voucher's lines sum below zero and left + held never passes 2,000.
 * 13. A thousand vouches: the ledger audit sums to zero, and no Bean moved.
 * 14. A standby's copy carries the three tables.
 * 15. The ask's answer and the knock's answer carry a vouch, refused with the sentence as any invite's is.
 * 16. A hold whose code lapsed is back in the budget at once: a read and a vouch don't wait for the hourly prune.
 * 17. A frozen voucher (known floor or whole line): no vouch, a held code's vouch goes back at the redeem, no raise; a
 *     paused one's budget isn't raised either; both may be lowered.
 * 18. Each change the committee makes to a budget (made, raised, lowered, stopped) is a notice kept for the voucher, told
 *     live and pushed once it has committed.
 * 23. A raise is a target (invites-vouching I6): the difference is drawn from the budget, a target the budget can't cover, a
 *     never-vouched person, a vouch amount sent with it, and the retired raise flag each refused with nothing written.
 * Round 2 of the deciding review (PR #2911):
 * 19. No voucher answer carries an invite code, nor a piece of one, nor anything that redeems: the card to an admin off the
 *     committee, to a committee admin and to an owner, the block, a set-to's and a stop's answers, the voucher's own read.
 *     Each history line says what it was for instead: held for an invite, vouched on whom, back (expired, stopped).
 * 20. An owner's or admin's budget made from their entry falls back to the role on a step-back or a revoke (same left and
 *     held, one log line); a committee admin can't make an admin a voucher from their entry, an owner can (I5); Stop vouching
 *     refuses an owner's whatever its source; nobody sets an owner's (no limit).
 * 21. The committee flag clears when an admin is made owner, logged, and stays off when they are made admin again.
 * 22. The card's Trading line: per person, completed trades with someone outside the voucher's own, only inside, or none.
 * 23. I5, "+ Make someone a voucher": the block's candidates offer an owner the admins with no budget and the members
 *     confirmed on the names list, and nobody else (no voucher, no owner, no one unconfirmed or waiting for a second admin,
 *     never the viewer); a committee admin is offered no admins. Making an admin one is an owner's: a committee admin's ask
 *     is refused, a member is no admin, an entry and a key together are refused, and not twice.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import {
    initStateEngine, exportSyncState, getBalance, adminPruneUser, purgeMemberSelf, transfer, createPost as rawCreatePost,
    generateInvite, redeemInvite, runLedgerAudit, usableFloor, COMMUNITY_DECISION_ACTOR, adminSetCreditFrozen, adminSetUserStatus, broadcast,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ownerPhoneSessionHeaders, ownerSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride, getProfileSwitches } from './config/node-profile.js';
import { wrapCreatePost } from './post-test-helper.js';
import { TABLES } from './engine/replication-manifest.js';
import { setMemberPhoto } from '@beanpool/engine';
import { pruneUnusedInvites } from './engine/writer-bounds.js';
import {
    VOUCHER_WORDS, VOUCHERS_MIGRATION_ACTOR, CLAIM_ACTOR, budgetOf, grantMissingRoleBudgets, makeVoucher, setBudgetLevel, stopVoucher,
    vouchFromProfile, returnLapsedHolds, isOnCreditCommittee, vouchingAfterRoleChange,
} from './engine/vouchers.js';
import { deliverRecoverNotices, RECOVER_ACTOR } from './recover-command.js';
import { grantNodeRole } from './engine/node-roles.js';
import { issueAutomationToken } from './automation-tokens.js';
// The whole module too, for one export read by name (tellVoucherNotice): a missing one is a failed check, not a load error.
import * as vouchersModule from './engine/vouchers.js';
import { getDoor, setDoor, DEFAULT_DOOR } from './config/door.js';
import { listKeptNotices } from './engine/kept-notices.js';
import { setKnownFloorException, readKnownFloorLogFor } from './config/known-floor.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);
let BASE = '';
/** The owner's admin calls: Owen's key session from the phone's Manage hand-off, opened for each call (it passes every owner gate). */
let OWNER: () => Record<string, string> = () => ({});

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
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
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
/**
 * The story's figures are Beans; the node's are whole hundredths (a budget, a vouch and the room it gives too: the presets
 * read 25, 50, 75, 100 and are 2500, 5000, 7500, 10000). `hc` turns a Beans figure into hundredths at the door, exact for
 * every figure here.
 */
const hc = (beans: number) => Math.round(beans * 100);
/** The door back as it was: only a community's doors are stored (an open door is never one set on a node). */
const restoreDoor = (d: ReturnType<typeof getDoor>) => setDoor(d === 'open' ? DEFAULT_DOOR : d);

/** `vouchBeans`, `beans`, `level`: Beans, sent as whole hundredths (`vouchAmount` and `level` keep their names, their values hundredths). */
const generate = (id: Id, vouchBeans?: number) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk, ...(vouchBeans === undefined ? {} : { vouchAmount: hc(vouchBeans) }) });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const vouch = (by: Id, who: Id, beans: number) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, vouchAmount: hc(beans) });
/**
 * A raise names the total it ends at (slice I6), never an amount to add: `target` in Beans, sent as whole hundredths
 * (`raiseTo`); anything but a number goes as it is, for the refusals.
 */
const raiseTo = (by: Id, who: Id, target: unknown) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, raiseTo: typeof target === 'number' ? hc(target) : target });
const setLevel = (by: Id, who: Id, level: number) => call(by, 'POST', `/api/names/vouchers/${who.pk}/budget`, { level: hc(level) });

const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const lines = (pk: string) => db.prepare('SELECT kind, amount_c, actor, ref FROM voucher_allocations WHERE member_pubkey = ? ORDER BY rowid').all(pk) as { kind: string; amount_c: number; actor: string; ref: string | null }[];
const sumLines = (pk: string) => count('SELECT COALESCE(SUM(amount_c), 0) AS n FROM voucher_allocations WHERE member_pubkey = ?', pk);
const allLines = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
const roomOf = (pk: string) => count("SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE to_pubkey = ?", pk);
// Whole hundredths sum exactly: no rounding.
const sumBalances = () => count('SELECT COALESCE(SUM(balance_c), 0) AS n FROM accounts');

/** A confirmation on a fresh entry, written as the names list's confirmMember writes it (setup only: the list's crypto is its own suite's). */
function confirm(member: Id, by: Id, awaitingSecond = false): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk, awaitingSecond ? 1 : 0);
    return entryId;
}

/** The code an engine call refused with, or '' when it went through. */
function vouchOrRefusal(fn: () => unknown): string {
    try { fn(); return ''; } catch (e) { return (e as { code?: string }).code ?? String(e); }
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
    createPost('offer', 'general', `${who.name}'s offer`, 'An offer to keep a line open', hc(10), 'fixed', who.pk);
}

function spendBelowZero(who: Id, to: Id, amount: number): void {
    offer(who);
    const tx = transfer(who.pk, to.pk, hc(amount), 'A purchase for the suite', 'escrow');
    require_(!!tx && getBalance(who.pk).balance_c < 0, `${who.name} spends ${amount} within their line and is below zero (${getBalance(who.pk).balance_c} hundredths)`);
}

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // The node has no admin password: Owen claims the community as its claim code lets the first phone do (claim-code.ts
    // claimNode: his member row, then the owner role), and makes the other roles with his key.
    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    OWNER = () => ownerPhoneSessionHeaders(owen.pk);
    const [ada, dan, mel, jane, bea, sam, tom, uma, vic, kai, lou] = ['Ada', 'Dan', 'Mel', 'Jane', 'Bea', 'Sam', 'Tom', 'Uma', 'Vic', 'Kai', 'Lou'].map(newId);
    for (const who of [ada, dan, mel, jane, bea, sam, tom, kai, lou]) await join(owen, who);

    // ── 1. Role budgets ──────────────────────────────────────────────────────────────────────────────────────
    for (const [who, role] of [[ada, 'admin'], [dan, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, OWNER())).status === 200, `${who.name} is made ${role}`);
    }
    const owenLines = lines(owen.pk);
    assert(owenLines.length === 1 && owenLines[0].kind === 'grant' && owenLines[0].amount_c === hc(1000) && owenLines[0].actor === CLAIM_ACTOR,
        `1. the owner holds a budget of 1,000 by role from the grant, its actor the grant's: the claim that made him owner, as node:claim (${JSON.stringify(owenLines)})`);
    const roleRow = (pk: string) => db.prepare('SELECT source, entry_id, made_by FROM vouchers WHERE member_pubkey = ?').get(pk) as { source: string; entry_id: string | null; made_by: string } | undefined;
    assert(!roleRow(ada.pk) && !roleRow(dan.pk) && lines(ada.pk).length === 0 && lines(dan.pk).length === 0,
        '1. a new admin holds no budget: an owner makes an admin a voucher by hand (Marty, 10 Nov; I5)');
    // I5: Owen makes Ada and Dan vouchers with no names-list entry: the role is his vouch for them, so its source is the role.
    const adaMade = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ada.pk });
    const danMade = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: dan.pk, amount_c: hc(1000) });
    const adaGrant = lines(ada.pk);
    assert(adaMade.status === 201 && danMade.status === 201 && adaMade.body?.source === 'role' && adaMade.body?.entryId === null && adaMade.body?.left === hc(1000)
        && roleRow(ada.pk)?.made_by === owen.pk && adaGrant.length === 1 && adaGrant[0].kind === 'grant' && adaGrant[0].amount_c === hc(1000) && adaGrant[0].actor === owen.pk
        && count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_made' AND member_pubkey = ? AND actor_pubkey = ? AND new_value = 'role'", ada.pk, owen.pk) === 1,
        `1. an owner makes an admin a voucher with no names-list entry: the community's 1,000, source the role, the grant and the log line his (${show(adaMade)})`);
    const melMe = await call(mel, 'GET', '/api/vouchers/me');
    const owenMe = await call(owen, 'GET', '/api/vouchers/me');
    assert(melMe.status === 200 && melMe.body?.voucher === false && owenMe.body?.voucher === true && owenMe.body?.budget?.left === hc(1000)
        && JSON.stringify(owenMe.body?.presets) === JSON.stringify([25, 50, 75, 100, 200, 500].map(hc)) && JSON.stringify(melMe.body?.presets) === JSON.stringify([25, 50, 75, 100].map(hc)),
        `1. /api/vouchers/me: a member is no voucher, the owner is, with 1,000 left and an owner's six presets (Marty, 9 Nov) (${show(owenMe)})`);
    const owenInvite = await generate(owen, 100);
    const kaiId = newId('Kai2');
    const owenRedeem = await redeem(kaiId, owenInvite.body?.invite?.code);
    assert(owenInvite.status === 200 && owenRedeem.status === 200 && owenRedeem.body?.vouch?.landed === hc(100) && roomOf(kaiId.pk) === hc(100),
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
        && adaBlock2.body?.vouchers?.some((v: any) => v.memberPubkey === owen.pk && v.noLimit === true && v.left === hc(1000) && v.vouched === hc(100)),
        `2. an owner puts Ada on the committee, and she reads the block: Owen vouches with no limit (Marty, 9 Nov), his 100 vouched drawn from no budget (${show(adaBlock2)})`);
    const adaPutsDan = await call(ada, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true });
    assert(adaPutsDan.status === 403 && adaPutsDan.body?.code === 'owner_only', `2. only an owner puts admins on the committee (${show(adaPutsDan)})`);

    // ── 23. I5: "+ Make someone a voucher" offers admins and confirmed names, and nobody else ───────────────────────────
    // People join on invites the engine makes here: Owen's HTTP invites are counted against the owners' daily limit (see 15).
    const enterNow = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    const [ike, liz, wyn] = [newId('Ike'), newId('Liz'), newId('Wyn')];
    for (const who of [ike, liz, wyn]) enterNow(who);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ike.pk, role: 'admin' }, OWNER())).status === 200 && !roleRow(ike.pk), 'Ike is made an admin, with no budget');
    const lizEntry = confirm(liz, owen);
    confirm(wyn, owen, true);
    const sheetOf = async (who: Id) => {
        const b = await call(who, 'GET', '/api/names/vouchers');
        const c = b.body?.candidates;
        return { status: b.status, admins: (c?.admins ?? []).map((x: any) => x.memberPubkey), confirmed: (c?.confirmed ?? []).map((x: any) => `${x.memberPubkey}:${x.entryId}`), adminsOffered: c?.adminsOffered, raw: c };
    };
    const owenSheet = await sheetOf(owen);
    const adaSheet = await sheetOf(ada);
    assert(owenSheet.status === 200 && JSON.stringify(owenSheet.admins) === JSON.stringify([ike.pk]) && JSON.stringify(owenSheet.confirmed) === JSON.stringify([`${liz.pk}:${lizEntry}`])
        && owenSheet.raw?.admins?.[0]?.callsign === 'Ike' && owenSheet.raw?.confirmed?.[0]?.callsign === 'Liz',
        `23. an owner's sheet offers Ike (an admin with no budget) and Liz (confirmed on the list), and nobody else: no voucher, no owner, not Mel (unconfirmed), not Wyn (waiting for a second admin) (${JSON.stringify(owenSheet.raw)})`);
    assert(adaSheet.status === 200 && adaSheet.admins.length === 0 && JSON.stringify(adaSheet.confirmed) === JSON.stringify([`${liz.pk}:${lizEntry}`]),
        `23. a committee admin's sheet offers no admins (an owner's to make) and the same confirmed names (${JSON.stringify(adaSheet.raw)})`);
    assert(owenSheet.adminsOffered === true && adaSheet.adminsOffered === false,
        `23. the sheet says whether admins are offered at all, so an empty admins list is read right: an owner true, a committee admin false (${JSON.stringify(owenSheet.raw?.adminsOffered)} | ${JSON.stringify(adaSheet.raw?.adminsOffered)})`);
    const before23 = allLines();
    const adaMakesIke = await call(ada, 'POST', '/api/names/vouchers', { memberPubkey: ike.pk });
    const owenMakesMel = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: mel.pk });
    const both = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ike.pk, entryId: lizEntry });
    assert(adaMakesIke.status === 403 && adaMakesIke.body?.code === 'owner_only' && adaMakesIke.body?.error === VOUCHER_WORDS.adminOwnerOnly
        && owenMakesMel.status === 409 && owenMakesMel.body?.code === 'not_admin' && owenMakesMel.body?.error === VOUCHER_WORDS.notAdminToMake
        && both.status === 400 && both.body?.code === 'entry_or_member' && allLines() === before23 && !roleRow(ike.pk) && !roleRow(mel.pk),
        `23. a committee admin can't make an admin a voucher, a member is made one only from the list, an entry and a key together are refused, nothing written (${show(adaMakesIke)} | ${show(owenMakesMel)} | ${show(both)})`);
    const ikeMade = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ike.pk, amount_c: hc(300) });
    const ikeAgain = await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ike.pk });
    const lizMade = await call(owen, 'POST', '/api/names/vouchers', { entryId: owenSheet.raw?.confirmed?.[0]?.entryId, amount_c: hc(400) });
    const owenSheet2 = await sheetOf(owen);
    assert(ikeMade.status === 201 && ikeMade.body?.left === hc(300) && ikeMade.body?.source === 'role' && ikeAgain.status === 409 && ikeAgain.body?.code === 'already_voucher'
        && lizMade.status === 201 && lizMade.body?.source === 'entry' && lizMade.body?.left === hc(400)
        && owenSheet2.admins.length === 0 && owenSheet2.confirmed.length === 0 && owenSheet2.adminsOffered === true,
        `23. Owen makes Ike a voucher with 300 (not twice) and Liz from the entry the sheet named with 400, and the sheet offers neither any more (${show(ikeMade)} | ${show(ikeAgain)} | ${show(lizMade)})`);

    // ── 10a. Beans off, before any Bean moves (a node whose ledger moved keeps Beans on: node-profile lockToLedger) ────
    const janeEntryOff = confirm(jane, owen);
    const madeBeforeOff = await generate(owen, 25);
    require_(madeBeforeOff.status === 200 && madeBeforeOff.body?.invite?.vouchAmount === hc(25), 'Owen holds 25 on an invite while Beans are on');
    setSwitchOverride('beans', false);
    require_(!getProfileSwitches().beans, 'Beans are switched off (no Bean has moved yet)');
    // An ask (taken where only admins invite) and a knock waiting, for their answers with a vouch below.
    const doorBeforeOff = getDoor();
    setDoor('admins');
    const offAsk = await call(mel, 'POST', '/api/invite/asks', { firstName: 'Ona', howKnown: 'Ona mends nets at the harbour' });
    const offKnocker = newId('Oz');
    const offKnocked = await call(offKnocker, 'POST', '/api/join/knock', { callsign: 'Oz', message: 'Hello from Oz, I live up the hill.' });
    require_(offAsk.status === 201 && offKnocked.status === 201, `an ask and a knock wait while Beans are off (${show(offAsk)} | ${show(offKnocked)})`);
    const offKnock = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(offKnocker.pk) as { id: string }).id;
    const linesBeforeOff = allLines();
    const invitesBeforeOff = count('SELECT COUNT(*) AS n FROM invite_codes');
    const off = [
        await call(owen, 'POST', `/api/names/vouchers/${ada.pk}/budget`, { level: hc(500) }), await vouch(owen, mel, 25), await generate(owen, 25),
        await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntryOff, amount_c: hc(500) }), await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`),
        await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(500) }), await call(owen, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true }),
        await call(owen, 'POST', `/api/invite/asks/${offAsk.body?.ask?.id}/send`, { vouchAmount: hc(25) }), await call(owen, 'POST', `/api/join/knocks/${offKnock}/approve`, { vouchAmount: hc(25) }),
    ];
    restoreDoor(doorBeforeOff);
    assert(off.every((r) => r.status === 403 && r.body?.code === 'profile_no_beans') && allLines() === linesBeforeOff
        && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBeforeOff,
        `10. with Beans off every writer is refused, an ask's and a knock's answer with a vouch included, nothing written (${off.map((r) => `${r.status} ${r.body?.code}`).join(', ')})`);
    const offJoiner = newId('Ola');
    const offRedeem = await redeem(offJoiner, madeBeforeOff.body?.invite?.code);
    assert(offRedeem.status === 200 && offRedeem.body?.vouch?.ended === VOUCHER_WORDS.voucherEnded && roomOf(offJoiner.pk) === 0
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", madeBeforeOff.body?.invite?.code) === 1,
        `10. a vouched invite redeemed with Beans off joins with no room, its hold back to its maker (${show(offRedeem)})`);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: lou.pk, role: 'admin' }, OWNER())).status === 200, 'Lou is made an admin while Beans are off');
    assert(!db.prepare('SELECT 1 FROM vouchers WHERE member_pubkey = ?').get(lou.pk), '10. a role granted with Beans off writes no budget');
    setSwitchOverride('beans', true);
    require_(getProfileSwitches().beans, 'Beans are on again');
    db.prepare('UPDATE confirmations SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE entry_id = ?').run(new Date().toISOString(), owen.pk, 'admin', janeEntryOff);

    // ── 3. Making a voucher from a confirmed entry ─────────────────────────────────────────────────────────────
    const janeEntry = confirm(jane, owen);
    const before3 = allLines();
    const m150 = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(150) });
    const m2100 = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(2100) });
    assert(m150.status === 400 && m2100.status === 400 && m150.body?.code === 'bad_level' && m150.body?.error === VOUCHER_WORDS.badLevel && allLines() === before3,
        `3. an allocation of 150 or 2,100 is refused with the sentence, nothing written (${show(m150)} | ${show(m2100)})`);
    const unconfirmed = await call(owen, 'POST', '/api/names/vouchers', { entryId: crypto.randomBytes(16).toString('hex'), amount_c: hc(500) });
    const waiting = await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(lou, ada, true), amount_c: hc(500) });
    const adaEntry = confirm(ada, owen);
    const self = await call(ada, 'POST', '/api/names/vouchers', { entryId: adaEntry, amount_c: hc(500) });
    const byMember = await call(mel, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(500) });
    assert(unconfirmed.body?.code === 'not_confirmed' && waiting.body?.code === 'awaiting_second' && self.body?.code === 'own_budget' && byMember.status === 403,
        `3. an entry nobody is confirmed on, one waiting for a second admin, your own, and a member's ask are refused (${unconfirmed.body?.code} ${waiting.body?.code} ${self.body?.code} ${byMember.status})`);
    const made = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(500) });
    assert(made.status === 201 && made.body?.left === hc(500) && made.body?.source === 'entry' && lines(jane.pk).length === 1,
        `3. Owen makes Jane a voucher from her entry with 500 (${show(made)})`);
    const again = await call(owen, 'POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(500) });
    assert(again.status === 409 && again.body?.code === 'already_voucher', `3. not twice (${show(again)})`);
    const adaLinesBefore = lines(ada.pk).length;
    const flip = await call(owen, 'POST', '/api/names/vouchers', { entryId: adaEntry, amount_c: hc(500) });
    assert(flip.status === 201 && flip.body?.source === 'entry' && flip.body?.left === hc(1000) && lines(ada.pk).length === adaLinesBefore,
        `3. a role voucher (Ada, made one by Owen in 1) made one from her entry gets nothing new: the source moves to the entry (${show(flip)})`);
    const logMade = count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_made' AND member_pubkey = ?", jane.pk);
    assert(logMade === 1, '3. the appointment is a line in the known floor’s log');

    // ── 4. The vouch on an invite ───────────────────────────────────────────────────────────────────────────────
    const invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    const nonVoucher = await generate(mel, 25);
    assert(nonVoucher.status === 403 && nonVoucher.body?.code === 'not_a_voucher' && nonVoucher.body?.error === VOUCHER_WORDS.notAVoucher
        && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore, `4. a non-voucher's vouchAmount is refused with the sentence, no invite made (${show(nonVoucher)})`);
    const sixty = await generate(jane, 60);
    assert(sixty.status === 400 && sixty.body?.error === VOUCHER_WORDS.badAmount, `4. a 60 is refused with the sentence (${show(sixty)})`);
    require_((await setLevel(owen, jane, 100)).status === 200 && budgetOf(jane.pk).left === hc(100), 'Jane’s budget is set down to 100');
    const held25 = await generate(jane, 25);
    require_(held25.status === 200 && held25.body?.invite?.vouchAmount === hc(25) && budgetOf(jane.pk).left === hc(75) && budgetOf(jane.pk).held === hc(25),
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
    require_(h100a.status === 200 && h100b.status === 200 && budgetOf(jane.pk).held === hc(225), `Jane holds 225 on three invites (${JSON.stringify(budgetOf(jane.pk))})`);
    const belowHeld = await setLevel(owen, jane, 200);
    assert(belowHeld.status === 409 && belowHeld.body?.code === 'below_held' && /225 Beans held/.test(belowHeld.body?.error ?? ''),
        `5. a lower below what is held is refused (${show(belowHeld)})`);
    const toMax = await setLevel(owen, jane, 2000);
    const jb = budgetOf(jane.pk);
    assert(toMax.status === 200 && jb.left + jb.held === hc(2000) && jb.left === hc(1775) && lines(jane.pk).at(-1)?.kind === 'top_up' && lines(jane.pk).at(-1)?.amount_c === hc(1500),
        `5. a raise to 2,000 writes top_up +1,500: left 1,775 + held 225 (${JSON.stringify(jb)})`);
    const same = await setLevel(owen, jane, 2000);
    assert(same.status === 200 && same.body?.changed === false && lines(jane.pk).at(-1)?.amount_c === hc(1500), '5. the same level again writes nothing');
    const own = await setLevel(ada, ada, 2000);
    assert(own.status === 403 && own.body?.code === 'own_budget', `5. nobody sets their own (${show(own)})`);
    // Room given, then a lower: the room stays exactly as it was.
    require_((await vouch(jane, sam, 25)).status === 200, 'Jane vouches 25 for Sam from his profile');
    const samRoom = roomOf(sam.pk);
    const lower = await setLevel(owen, jane, 1000);
    const jl = lines(jane.pk).at(-1);
    assert(lower.status === 200 && jl?.kind === 'lower' && jl.amount_c === -hc(975) && roomOf(sam.pk) === samRoom && budgetOf(jane.pk).vouched === hc(25),
        `5. a lower writes lower −975 and leaves the room already given untouched (${JSON.stringify(jl)}, Sam ${roomOf(sam.pk)})`);

    // ── 6. The profile vouch ─────────────────────────────────────────────────────────────────────────────────────
    const second = await vouch(jane, sam, 25);
    assert(second.status === 409 && second.body?.code === 'already_vouched' && second.body?.error === 'You’ve already vouched for @Sam.',
        `6. a second separate vouch by the same voucher is refused: "${second.body?.error}"`);
    // The apps read the person's total from this figure (the raise card then offers the totals above it), and guess nothing without it.
    assert(second.body?.prior === hc(25), `6. the already_vouched refusal carries the voucher's earlier vouch as prior (${show(second)})`);
    const budgetBeforeRaise = budgetOf(jane.pk).left;
    const raise100 = await raiseTo(jane, sam, 100);
    assert(raise100.status === 200 && raise100.body?.total === hc(100) && raise100.body?.amount === hc(75) && count("SELECT COUNT(*) AS n FROM room_gifts WHERE from_pubkey = ? AND to_pubkey = ?", jane.pk, sam.pk) === 2,
        `6. a raise to 100 passes: a further hold and room_gifts row on the same pair, for the difference (${show(raise100)})`);
    const raiseLine = lines(jane.pk).at(-1);
    assert(raiseLine?.kind === 'hold' && raiseLine.amount_c === -hc(75) && budgetOf(jane.pk).left === budgetBeforeRaise - hc(75),
        `6. the target is the total: 100 on 25 holds 75 from the budget, not 100 (${JSON.stringify(raiseLine)}, left ${budgetBeforeRaise} to ${budgetOf(jane.pk).left} hundredths)`);
    const linesAfterRaise = allLines();
    const past = await raiseTo(jane, sam, 100);
    assert(past.status === 409 && past.body?.code === 'raise_not_above' && past.body?.error === 'You’ve vouched 100 Beans for @Sam already. Pick a higher total to raise it to.',
        `6. a target at the total is refused with the sentence, so a repeated tap lands once (${show(past)})`);
    assert(past.body?.prior === hc(100), `6. the refusal carries the pair's total so far as prior (${show(past)})`);
    const belowTotal = await raiseTo(jane, sam, 50);
    assert(belowTotal.status === 409 && belowTotal.body?.code === 'raise_not_above', `6. a target below the total is refused (${show(belowTotal)})`);
    const pastHundred = await raiseTo(jane, sam, 200);
    assert(pastHundred.status === 403 && pastHundred.body?.code === 'owner_amount', `6. past 100 is an owner's total, refused for a voucher (${show(pastHundred)})`);
    const notPreset = await raiseTo(jane, sam, 90);
    assert(notPreset.status === 400 && notPreset.body?.code === 'bad_amount', `6. a target that is no preset is refused (${show(notPreset)})`);
    assert(allLines() === linesAfterRaise && roomOf(sam.pk) === hc(100), '6. none of the refused raises wrote a line or a room');
    require_((await vouch(owen, sam, 25)).status === 200 && (await vouch(ada, sam, 25)).status === 200, 'Owen and Ada vouch for Sam too: three vouchers');
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(bea, owen), amount_c: hc(500) })).status === 201, 'Bea is made a voucher');
    const fourth = await vouch(bea, sam, 25);
    assert(fourth.status === 409 && fourth.body?.code === 'three_vouches' && fourth.body?.error === '@Sam has three vouches.',
        `6. a fourth voucher's vouch is refused: "${fourth.body?.error}"`);
    const raiseOfThree = await raiseTo(owen, sam, 50);
    assert(raiseOfThree.status === 200 && raiseOfThree.body?.amount === hc(25) && raiseOfThree.body?.total === hc(50), `6. one of the three may still raise theirs (${show(raiseOfThree)})`);
    // The credit line it gives: one live offer unlocks it whole; the badge ignores it.
    const samBal = getBalance(sam.pk);
    assert(samBal.roomHeld_c === hc(175) && samBal.floor_c === -hc(175) && samBal.usableFloor_c === 0 && samBal.tierCredit_c === 0,
        `6. Sam's line is the room people gave him (175), none usable without a live offer, never his badge (${JSON.stringify({ r: samBal.roomHeld_c, f: samBal.floor_c, u: samBal.usableFloor_c, t: samBal.tierCredit_c })})`);
    offer(sam);
    assert(usableFloor(sam.pk) === -hc(175), `6. one live offer unlocks all of it (${usableFloor(sam.pk)} hundredths)`);
    const samLedger = await call(sam, 'GET', `/api/ledger/balance/${sam.pk}`);
    assert(samLedger.status === 200 && samLedger.body?.vouchedBy?.length === 3 && samLedger.body.vouchedBy[0].memberPubkey === jane.pk && samLedger.body.vouchedBy[0].amount_c === hc(100),
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
    require_(umaJoins.status === 200 && umaJoins.body?.vouch?.landed === hc(50) && roomOf(uma.pk) === hc(50), `Uma joins on Jane's invite with a 50 vouch (${show(umaJoins)})`);
    const umaSecond = await vouch(jane, uma, 25);
    const umaRaise = await raiseTo(jane, uma, 100);
    assert(umaSecond.body?.code === 'already_vouched' && umaSecond.body?.prior === hc(50) && umaRaise.status === 200 && umaRaise.body?.total === hc(100) && umaRaise.body?.amount === hc(50),
        `6. an invite vouch counts as that pair's one vouch: a separate one refused, a raise to 100 passes (${umaSecond.body?.code} ${show(umaRaise)})`);
    const selfVouch = await vouch(jane, jane, 25);
    assert(selfVouch.status === 403 && selfVouch.body?.code === 'own_vouch', '6. never for yourself');

    // ── 7. A demoted admin's held code; the committee flag clears with the role ─────────────────────────────
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: dan.pk, on: true })).status === 200, 'Dan is put on the committee');
    const danHeld = await generate(dan, 50);
    require_(danHeld.status === 200 && budgetOf(dan.pk).held === hc(50), 'Dan, an admin, holds 50 on an invite');
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: dan.pk, role: 'moderator' }, OWNER())).status === 200, 'Dan is made a moderator');
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

    // ── 7b. A paused voucher: no vouch while it lasts, and the committee still reaches the budget ─────────────────
    const lou2 = newId('Nia');
    await join(owen, lou2);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(lou2, owen), amount_c: hc(500) })).status === 201, 'Nia is made a voucher');
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(lou2.pk);
    const pausedVouch = vouchOrRefusal(() => vouchFromProfile(lou2.pk, { memberPubkey: mel.pk, vouchAmount: hc(25) }));
    const pausedLower = await setLevel(owen, lou2, 100);
    const pausedStop = await call(owen, 'DELETE', `/api/names/vouchers/${lou2.pk}`);
    assert(pausedVouch === 'not_a_voucher' && pausedLower.status === 200 && pausedStop.status === 200 && sumLines(lou2.pk) === 0,
        `7. a paused voucher can't vouch, and the committee can still lower and stop their budget (${pausedVouch} ${pausedLower.status} ${pausedStop.status})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(lou2.pk);

    // ── 8. A revoked confirmation; expiry ───────────────────────────────────────────────────────────────────────
    const beaConf = db.prepare('SELECT id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(bea.pk) as { id: string };
    require_((await call(owen, 'POST', `/api/names/confirmations/${beaConf.id}/revoke`, {})).status === 200, 'Bea’s confirmation is revoked');
    assert((db.prepare('SELECT stop_reason FROM vouchers WHERE member_pubkey = ?').get(bea.pk) as any)?.stop_reason === 'revoked' && sumLines(bea.pk) === 0,
        '8. a revoked confirmation stops a list budget');
    // An owner vouches by the role whatever the source (amend2 §2(b)): Stop vouching refuses theirs. An admin's budget is an
    // owner's to stop since I5 (Marty, 10 Nov), whatever its source: see the next lines.
    const ownerStop = await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`);
    const owenRow8 = db.prepare('SELECT stopped_at FROM vouchers WHERE member_pubkey = ?').get(owen.pk) as { stopped_at: string | null };
    assert(ownerStop.status === 409 && ownerStop.body?.code === 'role_voucher' && owenRow8.stopped_at === null,
        `8. Stop vouching refuses an owner's budget, nothing stopped (${ownerStop.status} ${ownerStop.body?.code})`);
    // I5, no conversion code: a budget the role gave an admin before the rule (as the boot's migration:vouchers grant wrote
    // Byron's) stays until an owner stops it by hand. Ed holds one, written here as that grant wrote it, with 50 held.
    const ed = newId('Ed');
    enterNow(ed);
    grantNodeRole(ed.pk, 'admin', owen.pk);
    require_(!roleRow(ed.pk), 'Ed, made an admin, is given no budget');
    const edAt = new Date().toISOString();
    db.prepare("INSERT INTO vouchers (member_pubkey, source, entry_id, made_by, made_at) VALUES (?, 'role', NULL, ?, ?)").run(ed.pk, VOUCHERS_MIGRATION_ACTOR, edAt);
    db.prepare("INSERT INTO voucher_allocations (id, member_pubkey, kind, amount_c, actor, ref, at) VALUES (?, ?, 'grant', ?, ?, NULL, ?)").run(crypto.randomBytes(16).toString('hex'), ed.pk, hc(1000), VOUCHERS_MIGRATION_ACTOR, edAt);
    const edHeld = await generate(ed, 50);
    require_(edHeld.status === 200 && budgetOf(ed.pk).left === hc(950) && budgetOf(ed.pk).held === hc(50), `Ed, an admin with a budget from before I5, holds 50 on an invite (${show(edHeld)})`);
    const edCardByAda = await call(ada, 'GET', `/api/names/vouchers/${ed.pk}`);
    const edCardByOwen = await call(owen, 'GET', `/api/names/vouchers/${ed.pk}`);
    const owenCardByAda = await call(ada, 'GET', `/api/names/vouchers/${owen.pk}`);
    const lizCardByAda = await call(ada, 'GET', `/api/names/vouchers/${liz.pk}`);
    assert(edCardByAda.body?.canStop === false && edCardByOwen.body?.canStop === true && owenCardByAda.body?.canStop === false && lizCardByAda.body?.canStop === true,
        `8. the card says who may stop: an admin's budget an owner only, an owner's nobody, a member's the committee (${[edCardByAda, edCardByOwen, owenCardByAda, lizCardByAda].map((r) => r.body?.canStop).join(' ')})`);
    const linesBeforeEdStop = allLines();
    const adaStopsEd = await call(ada, 'DELETE', `/api/names/vouchers/${ed.pk}`);
    assert(adaStopsEd.status === 403 && adaStopsEd.body?.code === 'owner_only' && adaStopsEd.body?.error === VOUCHER_WORDS.adminOwnerOnly
        && allLines() === linesBeforeEdStop && roleRow(ed.pk) && budgetOf(ed.pk).left === hc(950),
        `8. a committee admin can't stop an admin's budget, nothing written (${show(adaStopsEd)})`);
    const balancesBeforeEdStop = sumBalances();
    const edLinesBefore = lines(ed.pk).length;
    const owenStopsEd = await call(owen, 'DELETE', `/api/names/vouchers/${ed.pk}`);
    const edNew = lines(ed.pk).slice(edLinesBefore);
    const edRow = db.prepare('SELECT stopped_at, stopped_by, stop_reason FROM vouchers WHERE member_pubkey = ?').get(ed.pk) as { stopped_at: string | null; stopped_by: string; stop_reason: string };
    const edStopAudit = runLedgerAudit();
    assert(owenStopsEd.status === 200 && JSON.stringify(edNew.map((l) => [l.kind, l.amount_c, l.actor, l.ref]))
            === JSON.stringify([['return', hc(50), owen.pk, edHeld.body?.invite?.code], ['stop', -hc(1000), owen.pk, null]])
        && sumLines(ed.pk) === 0 && edRow.stopped_at !== null && edRow.stopped_by === owen.pk && edRow.stop_reason === 'stopped'
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'stop'", ed.pk) === 1
        && count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_stopped' AND member_pubkey = ? AND actor_pubkey = ?", ed.pk, owen.pk) === 1
        && sumBalances() === balancesBeforeEdStop && edStopAudit.ok && edStopAudit.sumBalances === 0 && edStopAudit.drift === 0,
        `8. an owner stops an admin's budget from before I5 by hand: its 50 held comes back, then one stop line for the 1,000 left (950 and the 50), the row stopped, no Bean moved and the audit sums to zero (${JSON.stringify(edNew)})`);
    const edsJoiner = newId('Edna');
    const edsJoinerJoins = await redeem(edsJoiner, edHeld.body?.invite?.code);
    const edAfter = await generate(ed, 25);
    assert(edsJoinerJoins.status === 200 && edsJoinerJoins.body?.vouch?.ended === VOUCHER_WORDS.voucherEnded && roomOf(edsJoiner.pk) === 0
        && edAfter.status === 403 && edAfter.body?.code === 'not_a_voucher',
        `8. the code Ed gave out still lets its person in, with no vouch, and Ed vouches no more (${show(edsJoinerJoins)} | ${show(edAfter)})`);
    const janeHeldBefore = budgetOf(jane.pk);
    const heldCode = h100a.body?.invite?.code as string;
    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(heldCode);
    const usedReturnsBefore = count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", janeForUma.body?.invite?.code);
    pruneUnusedInvites();
    const janeAfter = budgetOf(jane.pk);
    assert(janeAfter.left === janeHeldBefore.left + hc(100) && janeAfter.held === janeHeldBefore.held - hc(100)
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", heldCode) === 1
        && !db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(heldCode),
        `8. a held code past its 30 days comes back to the budget as the prune deletes it (${JSON.stringify(janeHeldBefore)} → ${JSON.stringify(janeAfter)})`);
    assert(usedReturnsBefore === 0 && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", janeForUma.body?.invite?.code) === 0,
        '8. a redeemed code never comes back');

    // ── 9. Departures ───────────────────────────────────────────────────────────────────────────────────────────
    spendBelowZero(sam, mel, 40);
    const samDebt = Math.abs(getBalance(sam.pk).balance_c);
    // The community's removal vote carried out (decisions-engine remove_member), as on a node where members vote.
    adminPruneUser(sam.pk, COMMUNITY_DECISION_ACTOR);
    const settle = db.prepare("SELECT amount_c, memo FROM transactions WHERE to_pubkey = ? AND memo LIKE 'Settle bad debt for pruned user:%'").get(sam.pk) as { amount_c: number; memo: string } | undefined;
    assert(settle?.memo === `Settle bad debt for pruned user: ${sam.pk.slice(0, 8)}` && samDebt > 0 && settle?.amount_c === samDebt,
        `9. a prune pays the Commons exactly as before: the same memo and amount (${JSON.stringify(settle)}, debt ${samDebt})`);
    const stamped = db.prepare('SELECT amount_c, written_off_c FROM room_gifts WHERE to_pubkey = ? ORDER BY at, id').all(sam.pk) as { amount_c: number; written_off_c: number | null }[];
    const writtenOff = stamped.reduce((n, r) => n + (r.written_off_c ?? 0), 0);
    assert(stamped.every((r) => r.written_off_c !== null) && writtenOff === samDebt && stamped[0].written_off_c === Math.min(samDebt, stamped[0].amount_c),
        `9. and stamps the room he held with the debt, oldest first (${JSON.stringify(stamped)})`);
    const janeCard = await call(owen, 'GET', `/api/names/vouchers/${jane.pk}`);
    assert(janeCard.status === 200 && janeCard.body?.writtenOff > 0 && janeCard.body?.people?.some((p: any) => p.memberPubkey === sam.pk && p.left === true && p.raised === true),
        `9. Jane's card sums what was written off and marks Sam gone and raised (${show(janeCard)})`);
    assert(count("SELECT COUNT(*) AS n FROM known_floor_log WHERE action = 'voucher_looked' AND member_pubkey = ?", jane.pk) === 1, '9. opening the card is a logged look');
    assert(!readKnownFloorLogFor(jane.pk).some((l: { action: string }) => l.action === 'voucher_looked'),
        "9. the look stays out of the member's known-floor panel, so it can't push real changes out of its window (#2923)");
    spendBelowZero(uma, mel, 10);
    const umaDebt = Math.abs(getBalance(uma.pk).balance_c);
    purgeMemberSelf(uma.pk);
    const umaStamped = db.prepare('SELECT COALESCE(SUM(written_off_c), 0) AS n FROM room_gifts WHERE to_pubkey = ?').get(uma.pk) as { n: number };
    assert(umaDebt > 0 && umaStamped.n === umaDebt && !!db.prepare("SELECT 1 FROM transactions WHERE to_pubkey = ? AND memo LIKE 'Settle bad debt for self-purged user:%'").get(uma.pk),
        `9. a member's own account deletion stamps the room too, the Commons paying as before (${umaStamped.n} of ${umaDebt})`);

    // ── 10. An owner's key session is no member's signature; an admin who is no voucher; Beans off ──────────────
    const linesBefore10 = allLines();
    const writers: Array<[Method, string, unknown]> = [
        ['POST', '/api/names/vouchers', { entryId: janeEntry, amount_c: hc(500) }], ['DELETE', `/api/names/vouchers/${jane.pk}`, undefined],
        ['POST', `/api/names/vouchers/${jane.pk}/budget`, { level: hc(500) }], ['POST', '/api/names/vouchers/settings', { voucherBudget: hc(500) }],
        ['POST', '/api/names/committee', { memberPubkey: ada.pk, on: false }], ['POST', '/api/vouch', { memberPubkey: mel.pk, vouchAmount: hc(25) }],
    ];
    const bySession = await Promise.all(writers.map(([m, p, b]) => call(null, m, p, b, OWNER())));
    assert(bySession.every((r) => r.status === 401 || r.status === 403) && allLines() === linesBefore10,
        `10. an owner's key session (no member's signature) is refused on every member writer, nothing written (${bySession.map((r) => r.status).join(' ')})`);
    // Lou is an admin with no budget (made one while Beans were off): no voucher, so his seed invite carries no vouch.
    const louSeed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard', vouchAmount: hc(25) }, ownerSessionHeaders(lou.pk));
    assert(louSeed.status === 403 && (louSeed.body as any)?.code === 'not_a_voucher' && allLines() === linesBefore10,
        `10. seed-invite with vouchAmount under the key session of an admin who is no voucher is refused 403 not_a_voucher, nothing written (${show(louSeed)})`);

    // A signed voucher owner/admin CAN vouch via seed-invite:
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const owenAdminSession = { 'x-admin-session': consumeHandshakeToken(mintHandshakeToken(owen.pk, 'owner').handshakeToken).sessionId! };
    const owenBudgetBefore = count('SELECT COALESCE(SUM(amount_c), 0) AS n FROM voucher_allocations WHERE member_pubkey = ?', owen.pk);
    const owenSeed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard', vouchAmount: hc(25) }, owenAdminSession);
    assert(owenSeed.status === 200 && owenSeed.body?.vouchAmount === hc(25), `10. voucher admin can vouch on seed-invite (${show(owenSeed)})`);
    const owenBudgetAfter = count('SELECT COALESCE(SUM(amount_c), 0) AS n FROM voucher_allocations WHERE member_pubkey = ?', owen.pk);
    assert(owenBudgetBefore - owenBudgetAfter === hc(25), `10. 25 Beans held from voucher's budget for seed-invite (${owenBudgetBefore} -> ${owenBudgetAfter} hundredths)`);

    // Redeeming the seed invite lands the vouch from the issuing admin/owner (owen):
    const rita = newId('rita');
    const ritaRedeem = await redeem(rita, owenSeed.body.code);
    assert(ritaRedeem.status === 200 && ritaRedeem.body?.success === true, `10. seed invite with vouch redeems successfully (${show(ritaRedeem)})`);
    const ritaVouchGift = db.prepare("SELECT amount_c, from_pubkey, to_pubkey FROM room_gifts WHERE invite_code = ? AND kind = 'vouch'").get(owenSeed.body.code) as { amount_c: number; from_pubkey: string; to_pubkey: string } | undefined;
    assert(ritaVouchGift && ritaVouchGift.amount_c === hc(25) && ritaVouchGift.from_pubkey === owen.pk && ritaVouchGift.to_pubkey === rita.pk,
        `10. seed invite vouch lands from issuing admin owen (${JSON.stringify(ritaVouchGift)})`);

    // Manager admin endpoints:
    const meAdmin = await call(null, 'GET', '/api/local/admin/vouchers/me', undefined, owenAdminSession);
    assert(meAdmin.status === 200 && meAdmin.body?.voucher === true && meAdmin.body?.budget?.left === budgetOf(owen.pk).left,
        `10. /api/local/admin/vouchers/me under key session returns voucher status (${show(meAdmin)})`);
    const cardAdmin = await call(null, 'GET', `/api/local/admin/known-floor/vouchers/member/${owen.pk}`, undefined, owenAdminSession);
    assert(cardAdmin.status === 200 && cardAdmin.body?.memberPubkey === owen.pk && cardAdmin.body?.left === budgetOf(owen.pk).left,
        `10. /api/local/admin/known-floor/vouchers/member/:pubkey returns voucher card (${show(cardAdmin)})`);

    // ── 11. The boot's grant: to an owner who never had a budget, never to an admin (I5) ─────────────────────────────
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'shell')").run(kai.pk);
    const granted = grantMissingRoleBudgets();
    assert(granted === 0 && lines(kai.pk).length === 0 && lines(lou.pk).length === 0 && !roleRow(kai.pk) && !roleRow(lou.pk),
        `11. at boot an admin made outside grantNodeRole, and one made while Beans were off, get no budget: an owner makes an admin a voucher (I5) (${granted})`);

    // ── 11b. A role the server's shell changed (beanpool recover / claim write node_roles on their own connection) ──
    const committeeOf = (pk: string) => (db.prepare('SELECT credit_committee AS c FROM members WHERE public_key = ?').get(pk) as { c: number | null }).c;
    const committeeLine = (pk: string, actor: string) => !!db.prepare("SELECT 1 FROM known_floor_log WHERE action = 'committee' AND member_pubkey = ? AND actor_pubkey = ? AND old_value = 'on' AND new_value = 'off'").get(pk, actor);
    const rbob = newId('Bob'); await join(owen, rbob);
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'shell')").run(rbob.pk);
    grantMissingRoleBudgets();
    db.prepare('UPDATE members SET credit_committee = 1 WHERE public_key = ?').run(rbob.pk);
    db.prepare("UPDATE node_roles SET role = 'owner', granted_by = ? WHERE member_pubkey = ?").run(RECOVER_ACTOR, rbob.pk);
    const noticeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vouchers-recover-'));
    fs.writeFileSync(path.join(noticeDir, `recover-notice-${Date.now()}-0001.json`), JSON.stringify({ pubkey: rbob.pk, callsign: 'Bob', alreadyOwner: false, at: new Date().toISOString() }));
    const delivered = deliverRecoverNotices({ announce: () => {}, log: () => {}, roleChanged: (pk) => vouchingAfterRoleChange(pk, RECOVER_ACTOR) }, noticeDir);
    fs.rmSync(noticeDir, { recursive: true, force: true });
    assert(delivered === 1 && committeeOf(rbob.pk) === 0 && committeeLine(rbob.pk, RECOVER_ACTOR),
        `11b. a committee admin made owner by beanpool recover leaves the committee when the node delivers the notice, with its line (flag ${committeeOf(rbob.pk)})`);

    const rcy = newId('Cy'); await join(owen, rcy);
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'shell')").run(rcy.pk);
    grantMissingRoleBudgets();
    db.prepare('UPDATE members SET credit_committee = 1 WHERE public_key = ?').run(rcy.pk);
    db.prepare("UPDATE node_roles SET role = 'owner', granted_by = ? WHERE member_pubkey = ?").run(RECOVER_ACTOR, rcy.pk);
    grantMissingRoleBudgets();
    assert(committeeOf(rcy.pk) === 0 && committeeLine(rcy.pk, VOUCHERS_MIGRATION_ACTOR),
        `11b. the boot clears the committee flag of an owner the shell made with no notice delivered, with its line (flag ${committeeOf(rcy.pk)})`);

    const rdee = newId('Dee'); await join(owen, rdee);
    db.prepare("INSERT INTO vouchers (member_pubkey, source, entry_id, made_by, made_at, stopped_at, stopped_by, stop_reason) VALUES (?, 'entry', NULL, ?, datetime('now'), datetime('now'), ?, 'stopped')").run(rdee.pk, owen.pk, owen.pk);
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', ?)").run(rdee.pk, RECOVER_ACTOR);
    const deeGranted = grantMissingRoleBudgets();
    const deeRow = db.prepare('SELECT stopped_at, source FROM vouchers WHERE member_pubkey = ?').get(rdee.pk) as { stopped_at: string | null; source: string };
    const deeLines = lines(rdee.pk);
    assert(deeGranted === 1 && deeRow.stopped_at === null && deeRow.source === 'role' && deeLines.length === 1 && deeLines[0].kind === 'grant'
        && deeLines[0].amount_c === hc(1000) && deeLines[0].actor === VOUCHERS_MIGRATION_ACTOR,
        `11b. a stopped list voucher made owner by the shell gets an owner's 1,000 at the next boot (${deeGranted}: ${JSON.stringify(deeRow)} ${JSON.stringify(deeLines)})`);
    assert(grantMissingRoleBudgets() === 0, '11b. once: the boot after grants nothing more');

    // ── 12. Property test ───────────────────────────────────────────────────────────────────────────────────────
    let seedN = 0x5eed;
    const rand = (n: number) => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN % n; };
    const pv = newId('Pia');
    await join(owen, pv);
    const pvEntry = confirm(pv, owen);
    makeVoucher(owen.pk, { entryId: pvEntry, amount_c: hc(1000) });
    const targets: string[] = [];
    for (let i = 0; i < 12; i++) {
        const k = newId(`T${i}`);
        const inv = generateInvite(owen.pk)!;
        redeemInvite(inv.code, k.pk, k.name);
        targets.push(k.pk);
    }
    const levels = [50, 100, 150, 300, 500, 900, 1000, 1500, 1800, 2000, 2100].map(hc);
    const violations: string[] = [];
    let ops = 0;
    for (let step = 0; step < 400; step++) {
        const op = rand(6);
        try {
            if (op === 0) setBudgetLevel(owen.pk, pv.pk, { level: levels[rand(levels.length)] });
            else if (op === 1) generateInvite(pv.pk, undefined, undefined, undefined, hc([25, 50, 75, 100, 60][rand(5)]));
            else if (op === 2) {
                const open = db.prepare("SELECT code FROM invite_codes WHERE created_by = ? AND used_by IS NULL AND vouch_amount_c IS NOT NULL").all(pv.pk) as { code: string }[];
                if (open.length) { const k = newId(`R${step}`); redeemInvite(open[rand(open.length)].code, k.pk, k.name); }
            } else if (op === 3) {
                const open = db.prepare("SELECT code FROM invite_codes WHERE created_by = ? AND used_by IS NULL").all(pv.pk) as { code: string }[];
                if (open.length) {
                    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(open[rand(open.length)].code);
                    returnLapsedHolds();
                }
            } else if (op === 4) {
                const person = targets[rand(targets.length)];
                const preset = hc([25, 50, 75, 100][rand(4)]);
                vouchFromProfile(pv.pk, rand(2) === 1 ? { memberPubkey: person, raiseTo: preset } : { memberPubkey: person, vouchAmount: preset });
            }
            else if (rand(8) === 0) { stopVoucher(owen.pk, pv.pk); makeVoucher(owen.pk, { entryId: pvEntry, amount_c: levels[rand(levels.length - 1)] }); }
            ops++;
        } catch { /* a refusal is a step too: the invariants must hold after it */ }
        const b = budgetOf(pv.pk);
        const sum = sumLines(pv.pk);
        if (sum < 0) violations.push(`step ${step}: the lines sum to ${sum}`);
        if (b.left + b.held > hc(2000)) violations.push(`step ${step}: left ${b.left} + held ${b.held}`);
        const pair = db.prepare("SELECT to_pubkey, SUM(amount_c) AS n FROM room_gifts WHERE from_pubkey = ? AND kind = 'vouch' GROUP BY to_pubkey HAVING n > ?").get(pv.pk, hc(100));
        if (pair) violations.push(`step ${step}: a pair above 100 ${JSON.stringify(pair)}`);
        const off = db.prepare("SELECT amount_c FROM room_gifts WHERE from_pubkey = ? AND amount_c NOT IN (?, ?, ?, ?)").get(pv.pk, ...[25, 50, 75, 100].map(hc));
        if (off) violations.push(`step ${step}: an amount outside the set ${JSON.stringify(off)}`);
    }
    const perPerson = db.prepare("SELECT to_pubkey, COUNT(DISTINCT from_pubkey) AS n FROM room_gifts WHERE kind = 'vouch' GROUP BY to_pubkey HAVING n > 3").get();
    assert(violations.length === 0 && !perPerson && ops > 100,
        `12. property: over 400 random steps (${ops} taken), no voucher's lines sum below zero, left + held never passes 2,000, no pair passes 100, no amount leaves the set, nobody has more than 3 vouchers${violations.length ? ` — ${violations.slice(0, 4).join(' | ')}` : ''}`);
    const everySum = db.prepare('SELECT member_pubkey, SUM(amount_c) AS n FROM voucher_allocations GROUP BY member_pubkey HAVING n < 0').get();
    assert(!everySum, '12. and no voucher anywhere in this suite has lines summing below zero');

    // ── 13. A thousand vouches ──────────────────────────────────────────────────────────────────────────────────
    const vouchers = [owen, newId('Vee'), newId('Wes')];
    for (const v of vouchers.slice(1)) { await join(owen, v); makeVoucher(owen.pk, { entryId: confirm(v, owen), amount_c: hc(2000) }); }
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
                if (budgetOf(v.pk).left < hc(25)) setBudgetLevel(v.pk === owen.pk ? ada.pk : owen.pk, v.pk, { level: hc(2000) });
                // A first vouch of 25, then raises to 50, 75 and 100: each lands 25.
                vouchFromProfile(v.pk, r === 0 ? { memberPubkey: p, vouchAmount: hc(25) } : { memberPubkey: p, raiseTo: hc(25 * (r + 1)) });
                vouches++;
            }
        }
    }
    const audit = runLedgerAudit();
    assert(vouches >= 1000 && audit.ok && audit.sumBalances === 0 && audit.drift === 0 && sumBalances() === balancesBefore && count('SELECT COUNT(*) AS n FROM transactions') === commonsRowsBefore,
        `13. after ${vouches} vouches the ledger audit sums to zero (${audit.sumBalances}), no balance moved and no transaction was written`);

    // ── 14. A standby's copy carries the three tables ──────────────────────────────────────────────────────────
    const payload = await exportSyncState('vouchers-suite') as { plainTables?: Record<string, unknown[]> };
    const carried = ['vouchers', 'voucher_allocations', 'room_gifts'].map((t) => [t, payload.plainTables?.[t]?.length ?? 0, count(`SELECT COUNT(*) AS n FROM ${t}`)]);
    assert(carried.every(([, sent, have]) => sent === have && (have as number) > 0)
        && ['vouchers', 'voucher_allocations', 'room_gifts'].every((t) => (TABLES as any)[t]?.plain === true)
        && JSON.stringify(TABLES.invite_codes).includes('vouch_amount_c') && JSON.stringify(TABLES.members).includes('credit_committee'),
        `14. a standby's whole copy carries every row of the three tables, and the two columns (${JSON.stringify(carried)})`);

    // ── 15. The ask's answer and the knock's answer carry a vouch (the design §2's four places; amend2 §4) ─────────
    // Owen's HTTP invites above reached the owners' daily invite limit: from here people join on invites the engine makes
    // (as §12 and §13 do), and Lou, an admin Owen makes a voucher with the community's 1,000 (I5), answers through the routes.
    const enter = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    makeVoucher(owen.pk, { memberPubkey: lou.pk });
    require_(budgetOf(lou.pk).left === hc(1000), `Lou, an admin, holds 1,000 (${JSON.stringify(budgetOf(lou.pk))})`);
    // An admin with no budget: one no owner made a voucher (the shell's here, outside grantNodeRole; §11, I5).
    const ned = newId('Ned');
    enter(ned);
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'shell')").run(ned.pk);
    require_(!db.prepare('SELECT 1 FROM vouchers WHERE member_pubkey = ?').get(ned.pk), 'Ned, an admin the shell made, has no budget');
    const doorBefore = getDoor();
    setDoor('admins');
    const asked = await call(mel, 'POST', '/api/invite/asks', { firstName: 'Ivy', howKnown: 'Ivy keeps the stall by the station' });
    require_(asked.status === 201 && typeof asked.body?.ask?.id === 'string', `Mel asks an admin to invite Ivy (${show(asked)})`);
    const askId = asked.body.ask.id as string;
    const askWaiting = () => count('SELECT COUNT(*) AS n FROM invite_asks WHERE id = ?', askId);
    const invitesBefore15 = count('SELECT COUNT(*) AS n FROM invite_codes');
    const askSixty = await call(lou, 'POST', `/api/invite/asks/${askId}/send`, { vouchAmount: hc(60) });
    const askByNed = await call(ned, 'POST', `/api/invite/asks/${askId}/send`, { vouchAmount: hc(25) });
    assert(askSixty.status === 400 && askSixty.body?.error === VOUCHER_WORDS.badAmount && askByNed.status === 403 && askByNed.body?.code === 'not_a_voucher'
        && askByNed.body?.error === VOUCHER_WORDS.notAVoucher && askWaiting() === 1 && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore15,
        `15. an ask's answer with a 60, or from an admin with no budget, is refused with the sentence; the ask still waits, no invite made (${show(askSixty)} | ${show(askByNed)})`);
    const askAnswered = await call(lou, 'POST', `/api/invite/asks/${askId}/send`, { vouchAmount: hc(50) });
    const askCode = (db.prepare('SELECT code, vouch_amount_c FROM invite_codes WHERE created_by = ? ORDER BY rowid DESC LIMIT 1').get(lou.pk) as { code: string; vouch_amount_c: number | null } | undefined)
        ?? { code: '', vouch_amount_c: null };
    assert(askAnswered.status === 200 && askWaiting() === 0 && askCode.vouch_amount_c === hc(50)
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE member_pubkey = ? AND kind = 'hold' AND ref = ?", lou.pk, askCode.code) === 1,
        `15. Lou answers the ask with a 50: the invite carries it, held from his budget with the code (${show(askAnswered)})`);
    restoreDoor(doorBefore);
    const ivy = newId('Ivy');
    const ivyJoins = await redeem(ivy, askCode.code);
    assert(ivyJoins.status === 200 && ivyJoins.body?.vouch?.landed === hc(50) && roomOf(ivy.pk) === hc(50), `15. and it lands on whoever joins with it (${show(ivyJoins)})`);
    const kit = newId('Kit');
    const knocked = await call(kit, 'POST', '/api/join/knock', { callsign: 'Kit', message: 'Hello from Kit, I live nearby and bake bread.' });
    require_(knocked.status === 201, `Kit asks to join (${show(knocked)})`);
    const knockId = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(kit.pk) as { id: string }).id;
    const knockSixty = await call(lou, 'POST', `/api/join/knocks/${knockId}/approve`, { vouchAmount: hc(60) });
    const knockStill = (db.prepare('SELECT status FROM join_requests WHERE id = ?').get(knockId) as { status: string }).status;
    assert(knockSixty.status === 400 && knockSixty.body?.error === VOUCHER_WORDS.badAmount && knockStill === 'pending',
        `15. a knock's answer with a 60 is refused with the sentence, and the request still waits (${show(knockSixty)}, ${knockStill})`);
    const knockAnswered = await call(lou, 'POST', `/api/join/knocks/${knockId}/approve`, { vouchAmount: hc(75) });
    const kitJoins = await redeem(kit, knockAnswered.body?.invite?.code);
    assert(knockAnswered.status === 200 && knockAnswered.body?.invite?.vouchAmount === hc(75) && kitJoins.status === 200 && kitJoins.body?.vouch?.landed === hc(75) && roomOf(kit.pk) === hc(75),
        `15. Lou answers Kit's knock with a 75: the answer says so, and it lands when Kit joins (${show(knockAnswered)} | ${show(kitJoins)})`);
    const plainKnocker = newId('Pip');
    require_((await call(plainKnocker, 'POST', '/api/join/knock', { callsign: 'Pip', message: 'Hello from Pip, I live nearby too.' })).status === 201, 'Pip asks to join');
    const pipKnock = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(plainKnocker.pk) as { id: string }).id;
    const pipAnswered = await call(lou, 'POST', `/api/join/knocks/${pipKnock}/approve`, {});
    assert(pipAnswered.status === 200 && pipAnswered.body?.invite?.code && !('vouchAmount' in (pipAnswered.body?.invite ?? {})),
        `15. a knock answered with no vouch says none (${show(pipAnswered)})`);

    // ── 16. A hold whose code lapsed is back at once, before the hourly prune writes its return ─────────────────────
    const [quin, rae] = [newId('Quin'), newId('Rae')];
    for (const q of [quin, rae]) { enter(q); makeVoucher(owen.pk, { entryId: confirm(q, owen), amount_c: hc(100) }); }
    const quinHeld = await generate(quin, 100);
    const raeHeld = await generate(rae, 100);
    require_(quinHeld.status === 200 && raeHeld.status === 200 && budgetOf(quin.pk).left === 0 && budgetOf(rae.pk).left === 0, 'Quin and Rae each hold their whole 100 on an invite');
    for (const r of [quinHeld, raeHeld]) db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(r.body?.invite?.code);
    const quinMe = await call(quin, 'GET', '/api/vouchers/me');
    assert(quinMe.body?.budget?.left === hc(100) && quinMe.body?.budget?.held === 0 && sumLines(quin.pk) === 0,
        `16. a hold whose code lapsed reads as back in the budget at once, its return line not written yet (${show(quinMe)})`);
    const quinAgain = await generate(quin, 50);
    const raeVouch = await vouch(rae, mel, 25);
    assert(quinAgain.status === 200 && raeVouch.status === 200,
        `16. so an invite with a vouch, or a profile vouch, from it passes without waiting for the prune (${show(quinAgain)} | ${show(raeVouch)})`);
    assert(count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", quinHeld.body?.invite?.code) === 1
        && budgetOf(quin.pk).left === hc(50) && budgetOf(quin.pk).held === hc(50) && sumLines(quin.pk) === hc(50),
        `16. the writer wrote the lapsed hold's return first, once: 50 left, 50 held (${JSON.stringify(budgetOf(quin.pk))})`);

    // ── 17. A frozen voucher: nothing more out of the budget, no raise; a lower still passes (design §5.2, §5.6) ─────
    const [fay, gus, hal] = [newId('Fay'), newId('Gus'), newId('Hal')];
    for (const v of [fay, gus, hal]) { enter(v); makeVoucher(owen.pk, { entryId: confirm(v, owen), amount_c: hc(500) }); }
    const gusHeld = await generate(gus, 50);
    require_(gusHeld.status === 200 && budgetOf(gus.pk).held === hc(50), 'Gus holds 50 on an invite before any freeze');
    setKnownFloorException(owen.pk, { memberPubkey: fay.pk, frozen: true });
    const linesBefore17 = allLines();
    const invitesBefore17 = count('SELECT COUNT(*) AS n FROM invite_codes');
    const fayVouch = await vouch(fay, mel, 25);
    const fayInvite = await generate(fay, 25);
    assert(fayVouch.status === 409 && fayVouch.body?.code === 'frozen' && fayVouch.body?.error === VOUCHER_WORDS.frozen && fayInvite.status === 409 && fayInvite.body?.code === 'frozen'
        && allLines() === linesBefore17 && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore17,
        `17. with Fay's known floor frozen she can't vouch from a profile or on an invite: the sentence, nothing written (${show(fayVouch)} | ${show(fayInvite)})`);
    const fayRaise = await setLevel(owen, fay, 1000);
    const fayLower = await setLevel(owen, fay, 200);
    assert(fayRaise.status === 409 && fayRaise.body?.code === 'frozen' && /credit line is frozen/.test(fayRaise.body?.error ?? '') && fayLower.status === 200 && budgetOf(fay.pk).left === hc(200),
        `17. her budget can't be raised while it lasts, and can still be lowered (${show(fayRaise)} | ${fayLower.status})`);
    adminSetCreditFrozen(gus.pk, true);
    const gusJoiner = newId('Gil');
    const gilJoins = await redeem(gusJoiner, gusHeld.body?.invite?.code);
    assert(gilJoins.status === 200 && gilJoins.body?.vouch?.ended === VOUCHER_WORDS.voucherEnded && roomOf(gusJoiner.pk) === 0
        && count("SELECT COUNT(*) AS n FROM voucher_allocations WHERE kind = 'return' AND ref = ?", gusHeld.body?.invite?.code) === 1 && budgetOf(gus.pk).left === hc(500),
        `17. a code Gus held before his whole line was frozen joins with no vouch while it lasts, the 50 back in his budget (${show(gilJoins)})`);
    adminSetCreditFrozen(gus.pk, false);
    const gusLater = await vouch(gus, gusJoiner, 25);
    assert(gusLater.status === 200 && roomOf(gusJoiner.pk) === hc(25), `17. unfrozen, Gus may vouch for Gil from his profile: the pair has no vouch yet (${show(gusLater)})`);
    adminSetUserStatus(hal.pk, 'disabled');
    const halRaise = await setLevel(owen, hal, 1000);
    const halLower = await setLevel(owen, hal, 300);
    assert(halRaise.status === 409 && halRaise.body?.code === 'paused' && halLower.status === 200 && budgetOf(hal.pk).left === hc(300),
        `17. a paused voucher's budget can't be raised while it lasts, and can be lowered (${show(halRaise)} | ${halLower.status})`);
    adminSetUserStatus(hal.pk, 'active');

    // ── 18. Each change the committee makes to a budget is a notice to its voucher (Marty's §10.2) ─────────────────
    const jen = newId('Jen');
    enter(jen);
    const voucherNotices = () => listKeptNotices(jen.pk).filter((n) => n.data.kind === 'voucher_budget');
    const jenMade = await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(jen, owen), amount_c: hc(800) });
    const jenUp = await setLevel(owen, jen, 1500);
    const jenSame = await setLevel(owen, jen, 1500);
    const jenBad = await setLevel(owen, jen, 150);
    const jenDown = await setLevel(owen, jen, 600);
    const jenStop = await call(owen, 'DELETE', `/api/names/vouchers/${jen.pk}`);
    const told = voucherNotices();
    assert(jenMade.status === 201 && jenUp.status === 200 && jenSame.body?.changed === false && jenBad.status === 400 && jenDown.status === 200 && jenStop.status === 200
        && JSON.stringify(told.map((n) => n.data.change)) === '["made","raised","lowered","stopped"]'
        && told.every((n) => n.title === VOUCHER_WORDS.noticeTitle)
        && told[0].body === 'You’re a voucher now: you have a budget of 800 Beans to vouch for people, up to 100 each.'
        && told[1].body === 'Your vouching budget was raised to 1,500 Beans. You have 1,500 of it left to vouch with.'
        && told[2].body === 'Your vouching budget was lowered to 600 Beans. You have 600 of it left to vouch with.'
        && told[3].body === VOUCHER_WORDS.noticeStopped,
        `18. made, raised, lowered and stopped are each a notice kept for Jen; the same level and a refused one are none (${JSON.stringify(told.map((n) => [n.data.change, n.body]))})`);
    const heard: { live: unknown[][]; pushed: unknown[][] } = { live: [], pushed: [] };
    const hooks = { broadcast: (...a: unknown[]) => { heard.live.push(a); }, dispatchPushNotification: (...a: unknown[]) => { heard.pushed.push(a); } };
    const tellFn = vouchersModule.tellVoucherNotice as ((n: unknown, h: typeof hooks) => void) | undefined;
    tellFn?.({ to: jen.pk, title: told[1].title, body: told[1].body, id: told[1].id, data: told[1].data }, hooks);
    const live = heard.live[0] as [{ type: string; title: string; body: string; noticeId?: string }, string[]] | undefined;
    const pushed = heard.pushed[0] as unknown[] | undefined;
    assert(typeof tellFn === 'function' && live?.[0]?.type === 'system_announcement' && live[0].body === told[1].body && live[0].noticeId === told[1].id && JSON.stringify(live[1]) === JSON.stringify([jen.pk])
        && JSON.stringify(pushed?.[0]) === JSON.stringify([jen.pk]) && pushed?.[6] === 'community.notice' && pushed?.[3] === told[1].body,
        `18. once the change has committed it goes live to Jen's own sockets with her kept copy's id, and out as a community.notice push (${JSON.stringify(heard).slice(0, 300)})`);

    // ── 19. No invite code in any voucher answer (deciding review round 2, finding 1) ──────────────────────────────────
    // An unused code is a bearer key to join that lands its vouch from the voucher's budget; the invites route keeps a
    // member's codes to that member (GET /api/invite/mine). No message here prints a code: only counts and yes or no.
    const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
        if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
        return out;
    };
    const stringsOf = (v: unknown, out = new Set<string>()): Set<string> => {
        if (typeof v === 'string') out.add(v);
        else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
        else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsOf(x, out));
        return out;
    };
    /** The code whole, in any case, or either of its two random parts (each has a letter, so no hex key or date holds one). */
    const carries = (r: Res, code: string) => {
        const parts = code.split('-').slice(1).filter((p) => /[A-Z]/.test(p));
        return r.text.toUpperCase().includes(code.toUpperCase()) || r.text.toUpperCase().replace(/[^0-9A-Z]/g, '').includes(code.split('-').slice(1).join(''))
            || parts.some((p) => r.text.includes(p));
    };
    const CODE_KEYS = ['code', 'ref', 'inviteCode', 'invite_code'];
    const historyLine = (r: Res, kind: string, pred: (l: any) => boolean = () => true) => (r.body?.history as any[] | undefined)?.find((l) => l.kind === kind && pred(l));
    const wren = newId('Wren');
    const xan = newId('Xan');
    enter(wren);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(wren, owen), amount_c: hc(500) })).status === 201, 'Wren is made a voucher');
    const wrenHeld = await generate(wren, 100);
    const wrenCode = (wrenHeld.body?.invite?.code ?? '') as string;
    require_(wrenHeld.status === 200 && /^INV-/.test(wrenCode) && budgetOf(wren.pk).held === hc(100), `Wren holds 100 on an invite not used yet (${wrenHeld.status})`);
    require_((await call(lou, 'GET', '/api/names/vouchers')).status === 403 && !isOnCreditCommittee(lou.pk) && isOnCreditCommittee(ada.pk), 'Lou, an admin, is off the committee; Ada is on it');
    const answers: Array<[string, Res]> = [
        ['the card to an admin off the committee', await call(lou, 'GET', `/api/names/vouchers/${wren.pk}`)],
        ['the card to a committee admin', await call(ada, 'GET', `/api/names/vouchers/${wren.pk}`)],
        ['the card to an owner', await call(owen, 'GET', `/api/names/vouchers/${wren.pk}`)],
        ['the vouchers block', await call(ada, 'GET', '/api/names/vouchers')],
        ['a set-to answer', await setLevel(ada, wren, 600)],
        ['the voucher’s own read', await call(wren, 'GET', '/api/vouchers/me')],
    ];
    const leaked = answers.filter(([, r]) => r.status !== 200 || carries(r, wrenCode) || CODE_KEYS.some((k) => keysOf(r.body).has(k))).map(([what, r]) => `${what} (${r.status})`);
    assert(leaked.length === 0, `19. no answer carries the unused code, a piece of it, or a code or ref field: the card to an admin off the committee, a committee admin and an owner, the block, a set-to, the voucher's own read${leaked.length ? ` — leaked: ${leaked.join('; ')}` : ''}`);
    const tried = [...new Set(answers.flatMap(([, r]) => [...stringsOf(r.body)]))];
    const redeemedBy = tried.filter((s) => {
        const probe = newId('Probe');
        try { return redeemInvite(s, probe.pk, probe.name).success === true; } catch { return false; }
    });
    assert(tried.length > 20 && redeemedBy.length === 0 && budgetOf(wren.pk).held === hc(100),
        `19. and nothing in them redeems: ${tried.length} strings tried, ${redeemedBy.length} joined, Wren's 100 still held`);
    const heldLine = historyLine(answers[1][1], 'hold');
    assert(heldLine?.for === 'invite' && heldLine.outcome === 'held' && heldLine.amount_c === -hc(100) && typeof heldLine.inviteMadeAt === 'string' && heldLine.person === null,
        `19. the history says what the hold is: held for an invite made ${heldLine?.inviteMadeAt?.slice(0, 10)}, not used yet (${JSON.stringify([heldLine?.kind, heldLine?.amount_c, heldLine?.for, heldLine?.outcome])})`);
    const xanJoins = await redeem(xan, wrenCode);
    const afterUse = await call(owen, 'GET', `/api/names/vouchers/${wren.pk}`);
    const usedLine = historyLine(afterUse, 'hold', (l) => l.amount_c === -hc(100));
    assert(xanJoins.status === 200 && xanJoins.body?.vouch?.landed === hc(100) && usedLine?.outcome === 'vouched' && usedLine.person?.callsign === 'Xan' && !carries(afterUse, wrenCode),
        `19. once redeemed the line says whom it vouched for, still no code (${JSON.stringify(usedLine?.person)})`);
    const lapses = await generate(wren, 25);
    const lapsedCode = (lapses.body?.invite?.code ?? '') as string;
    db.prepare("UPDATE invite_codes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE code = ?").run(lapsedCode);
    returnLapsedHolds();
    const stopsOn = await generate(wren, 50);
    const stoppedCode = (stopsOn.body?.invite?.code ?? '') as string;
    const wrenStop = await call(owen, 'DELETE', `/api/names/vouchers/${wren.pk}`);
    const afterStop = await call(lou, 'GET', `/api/names/vouchers/${wren.pk}`);
    const expired = historyLine(afterStop, 'return', (l) => l.amount_c === hc(25));
    const stopped = historyLine(afterStop, 'return', (l) => l.amount_c === hc(50));
    const backLine = historyLine(afterStop, 'hold', (l) => l.amount_c === -hc(25));
    assert(lapses.status === 200 && stopsOn.status === 200 && wrenStop.status === 200
        && expired?.for === 'invite' && expired.why === 'expired' && typeof expired.inviteMadeAt === 'string' && backLine?.outcome === 'back'
        && stopped?.for === 'invite' && stopped.why === 'stopped' && historyLine(afterStop, 'stop')?.amount_c < 0
        && ![wrenStop, afterStop].some((r) => [wrenCode, lapsedCode, stoppedCode].some((c) => carries(r, c)) || CODE_KEYS.some((k) => keysOf(r.body).has(k))),
        `19. a lapsed hold reads "back, invite expired", a stop's "back, budget stopped"; neither the stop's answer nor the card after it carries a code (${JSON.stringify([expired?.why, backLine?.outcome, stopped?.why])})`);
    const stoppedStill = await redeem(newId('Yul'), stoppedCode);
    assert(stoppedStill.status === 200 && stoppedStill.body?.vouch?.ended === VOUCHER_WORDS.voucherEnded,
        `19. the code Wren gave out before the stop still lets its person in, with no vouch (${stoppedStill.status})`);

    // ── 20. An owner's or admin's budget from their entry (deciding review round 2, finding 2) ─────────────────────────
    // (a) Abe, an admin, is made a voucher from his entry by an owner (I5: never by a committee admin), then steps back from
    // it: he keeps the budget, by the role.
    const rowOf = (pk: string) => db.prepare('SELECT source, entry_id, stopped_at FROM vouchers WHERE member_pubkey = ?').get(pk) as { source: string; entry_id: string | null; stopped_at: string | null };
    const sourceLines = (pk: string) => db.prepare("SELECT actor_pubkey AS actor, old_value AS old, new_value AS new FROM known_floor_log WHERE action = 'voucher_source' AND member_pubkey = ?").all(pk) as { actor: string; old: string; new: string }[];
    const abe = newId('Abe');
    enter(abe);
    grantNodeRole(abe.pk, 'admin', owen.pk);
    const abeEntry = confirm(abe, owen);
    const adaMakesAbe = await call(ada, 'POST', '/api/names/vouchers', { entryId: abeEntry });
    assert(adaMakesAbe.status === 403 && adaMakesAbe.body?.code === 'owner_only' && !rowOf(abe.pk),
        `20. (a) a committee admin can't make an admin a voucher from his entry either (I5), nothing written (${show(adaMakesAbe)})`);
    const abeFlip = await call(owen, 'POST', '/api/names/vouchers', { entryId: abeEntry });
    require_(abeFlip.status === 201 && rowOf(abe.pk).source === 'entry' && budgetOf(abe.pk).left === hc(1000), `Owen makes Abe, an admin, a voucher from his entry (${abeFlip.status})`);
    const abeBudget = budgetOf(abe.pk);
    const abeLines = lines(abe.pk).length;
    const abeBack = await call(abe, 'POST', '/api/names/step-back', {});
    const abeMe = await call(abe, 'GET', '/api/vouchers/me');
    const abeInvite = await generate(abe, 25);
    const abeAfter = budgetOf(abe.pk);
    assert(abeBack.status === 200 && rowOf(abe.pk).source === 'role' && rowOf(abe.pk).entry_id === null && rowOf(abe.pk).stopped_at === null
        && lines(abe.pk).length === abeLines + 1 && abeAfter.left === abeBudget.left - hc(25) && abeAfter.held === abeBudget.held + hc(25)
        && JSON.stringify(sourceLines(abe.pk)) === JSON.stringify([{ actor: abe.pk, old: 'entry', new: 'role' }])
        && abeMe.body?.voucher === true && abeInvite.status === 200,
        `20. (a) an admin who steps back from the entry his budget came from keeps it by the role: the same left and held, one log line, still a voucher (${abeBack.status}, ${JSON.stringify(rowOf(abe.pk))}, invite ${abeInvite.status})`);
    // (b) Eve, a member voucher with 500, is made an admin; Lou, an admin off the committee, revokes her confirmation.
    const eve = newId('Eve');
    enter(eve);
    const eveEntry = confirm(eve, owen);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: eveEntry, amount_c: hc(500) })).status === 201, 'Eve is made a voucher with 500');
    grantNodeRole(eve.pk, 'admin', owen.pk);
    require_(lines(eve.pk).length === 1, 'made an admin, Eve gets no second budget');
    const eveConf = db.prepare('SELECT id FROM confirmations WHERE entry_id = ?').get(eveEntry) as { id: string };
    const eveRevoked = await call(lou, 'POST', `/api/names/confirmations/${eveConf.id}/revoke`, {});
    const eveRow = rowOf(eve.pk);
    assert(eveRevoked.status === 200 && eveRow.stopped_at === null && eveRow.source === 'role' && eveRow.entry_id === null && budgetOf(eve.pk).left === hc(500)
        && lines(eve.pk).length === 1 && JSON.stringify(sourceLines(eve.pk)) === JSON.stringify([{ actor: lou.pk, old: 'entry', new: 'role' }])
        && (await call(eve, 'GET', '/api/vouchers/me')).body?.voucher === true,
        `20. (b) a member voucher later made an admin keeps her 500 when an admin revokes her confirmation, by the role now (${eveRevoked.status}, ${JSON.stringify(eveRow)})`);
    // (c) Ada, on the committee, makes Owen a voucher from his entry, then tries to stop and to lower his budget.
    const ora = newId('Ora');
    enter(ora);
    grantNodeRole(ora.pk, 'owner', owen.pk);
    require_(budgetOf(ora.pk).left === hc(1000), 'Ora is made an owner, with a budget by the role');
    const owenEntry = confirm(owen, ada);
    const owenFlip = await call(ada, 'POST', '/api/names/vouchers', { entryId: owenEntry });
    require_(owenFlip.status === 201 && owenFlip.body?.source === 'entry', `Ada makes Owen a voucher from his entry: nothing new, the source moves (${owenFlip.status})`);
    // An owner vouches with no limit (Marty, 9 Nov; test-owner-vouch.ts): before that, another owner could set an owner's
    // budget and a committee admin raise it. Now nobody sets it while they hold the role (409 no_limit), whatever its source.
    const owenLinesBefore = lines(owen.pk).length;
    const oraSetsOwen = await setLevel(ora, owen, 2000);
    const adaStopsOwen = await call(ada, 'DELETE', `/api/names/vouchers/${owen.pk}`);
    const adaLowersOwen = await setLevel(ada, owen, 500);
    const adaRaisesOwen = await setLevel(ada, owen, 1100);
    const oraStopsOwen = await call(ora, 'DELETE', `/api/names/vouchers/${owen.pk}`);
    const linesAfterRefusals = lines(owen.pk).length;
    const owenRow = db.prepare('SELECT stopped_at FROM vouchers WHERE member_pubkey = ?').get(owen.pk) as { stopped_at: string | null };
    assert(adaStopsOwen.status === 409 && adaStopsOwen.body?.code === 'role_voucher' && /with no limit, so there is no budget to stop or set/.test(adaStopsOwen.body?.error ?? '')
        && oraSetsOwen.status === 409 && oraSetsOwen.body?.code === 'no_limit' && adaLowersOwen.status === 409 && adaLowersOwen.body?.code === 'no_limit'
        && adaRaisesOwen.status === 409 && adaRaisesOwen.body?.code === 'no_limit' && linesAfterRefusals === owenLinesBefore
        && oraStopsOwen.status === 409 && oraStopsOwen.body?.code === 'role_voucher' && owenRow.stopped_at === null,
        `20. (c) with Owen's budget moved to his entry, nobody sets it, another owner or a committee admin, nor stops it, nothing written (${[oraSetsOwen, adaStopsOwen, adaLowersOwen, adaRaisesOwen, oraStopsOwen].map((r) => `${r.status} ${r.body?.code ?? ''}`).join(' | ')}: "${adaStopsOwen.body?.error ?? ''}")`);

    // Who acts is the signer: an automation token acts for the owner who made it (admin-auth.ts), and the owner-only rules on
    // the admin routes are asked through adminActionNeedsOwner for that reason (memory owner-only-rules-need-
    // adminactionneedsowner). No token reaches these routes at all: nothing to ask there.
    const madeToken = issueAutomationToken({ name: 'vouchers-suite', scope: 'admin', createdBy: owen.pk });
    require_(madeToken.ok, 'Owen makes an admin automation token');
    const bearer = { Authorization: `Bearer ${madeToken.ok ? madeToken.token : ''}` };
    const linesBeforeToken = allLines();
    const byToken = [
        await call(null, 'POST', `/api/names/vouchers/${ora.pk}/budget`, { level: hc(100) }, bearer), await call(null, 'DELETE', `/api/names/vouchers/${ora.pk}`, undefined, bearer),
        await call(null, 'POST', '/api/names/vouchers', { entryId: crypto.randomBytes(16).toString('hex') }, bearer), await call(null, 'GET', `/api/names/vouchers/${ora.pk}`, undefined, bearer),
    ];
    assert(byToken.every((r) => r.status === 401) && allLines() === linesBeforeToken && budgetOf(ora.pk).level === hc(1000),
        `20. (c) an owner's automation token reaches no voucher route: set-to, stop, make and the card each answer 401, nothing written (${byToken.map((r) => r.status).join(' ')})`);

    // ── 21. The committee flag clears with a promotion to owner (deciding review round 2, finding 3) ─────────────────────
    const bob = newId('Bob');
    enter(bob);
    grantNodeRole(bob.pk, 'admin', owen.pk);
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: bob.pk, on: true })).status === 200 && isOnCreditCommittee(bob.pk), 'Owen puts Bob, an admin, on the committee');
    const bobFlag = () => (db.prepare('SELECT credit_committee FROM members WHERE public_key = ?').get(bob.pk) as { credit_committee: number }).credit_committee;
    const bobLines = () => db.prepare("SELECT actor_pubkey AS actor, old_value AS old, new_value AS new FROM known_floor_log WHERE action = 'committee' AND member_pubkey = ? ORDER BY rowid").all(bob.pk) as { actor: string; old: string; new: string }[];
    grantNodeRole(bob.pk, 'owner', owen.pk);
    const flagAsOwner = bobFlag();
    grantNodeRole(bob.pk, 'admin', owen.pk);
    const bobBlock = await call(bob, 'GET', '/api/names/vouchers');
    assert(flagAsOwner === 0 && bobFlag() === 0 && !isOnCreditCommittee(bob.pk) && bobBlock.status === 403 && bobBlock.body?.code === 'committee_only'
        && JSON.stringify(bobLines().map((l) => [l.actor, l.old, l.new])) === JSON.stringify([[owen.pk, 'off', 'on'], [owen.pk, 'on', 'off']]),
        `21. made owner, Bob's committee flag clears with a line in the log; made admin again he is off it until an owner puts him back (${JSON.stringify({ flagAsOwner, now: bobFlag(), block: bobBlock.status, lines: bobLines().length })})`);

    // ── 22. The Trading line (deciding review round 2, finding 4; amend2 §5) ────────────────────────────────────────────
    const [tia, tx, ty, tz] = [newId('Tia'), newId('Tex'), newId('Ty'), newId('Zed')];
    for (const p of [tia, tx, ty, tz]) enter(p);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(tia, owen), amount_c: hc(500) })).status === 201, 'Tia is made a voucher');
    for (const p of [tx, ty, tz]) require_((await vouch(tia, p, 25)).status === 200, `Tia vouches 25 for ${p.name}`);
    /** A deal as the marketplace records one, on the seller's live offer: setup only (the marketplace's own suites drive it). */
    const deal = (seller: Id, buyer: Id, status: 'completed' | 'pending') => {
        setMemberPhoto(db, seller.pk, FACE);
        const post = createPost('offer', 'general', `${seller.name} sells`, 'A deal for the trading line', hc(10), 'fixed', seller.pk);
        require_(!!post?.id, `${seller.name} lists an offer`);
        db.prepare('INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status) VALUES (?, ?, ?, ?, ?, ?)')
            .run(crypto.randomBytes(16).toString('hex'), post!.id, buyer.pk, seller.pk, hc(10), status);
    };
    deal(tx, mel, 'completed');
    deal(ty, tx, 'completed');
    deal(tz, mel, 'pending');
    const tiaCard = await call(owen, 'GET', `/api/names/vouchers/${tia.pk}`);
    const markOf = (p: Id) => (tiaCard.body?.people as any[] | undefined)?.find((x) => x.memberPubkey === p.pk)?.trading;
    const tiaRow = (await call(owen, 'GET', '/api/names/vouchers')).body?.vouchers?.find((v: any) => v.memberPubkey === tia.pk);
    assert(tiaCard.status === 200 && JSON.stringify(tiaCard.body?.trading) === JSON.stringify({ withOthers: 1, insideOnly: 1 })
        && markOf(tx) === 'others' && markOf(ty) === 'inside' && markOf(tz) === 'none' && JSON.stringify(tiaRow?.trading) === JSON.stringify({ withOthers: 1, insideOnly: 1 })
        && !tiaCard.text.includes(mel.pk),
        `22. Tia's card: "Trading: 1 with others · 1 inside only": Tex traded with Mel, Ty only with Tex, Zed's deal isn't done; no name of whom they traded with (${JSON.stringify({ trading: tiaCard.body?.trading, marks: [markOf(tx), markOf(ty), markOf(tz)] })})`);
    // Each person's vouch is `amount_c`, whole hundredths, the name the web's card reads (the deciding review of #3033:
    // the node sent `amount`, so the card read "— Beans" for everyone).
    const tiaPeople = (tiaCard.body?.people as any[] | undefined) ?? [];
    assert(tiaPeople.length === 3 && tiaPeople.every((p) => p.amount_c === hc(25) && !('amount' in p)),
        `22. on Tia's card each person she vouched for carries amount_c ${hc(25)} (25 Beans), and no other name for it (${JSON.stringify(tiaPeople.map((p) => ({ amount_c: p.amount_c, amount: p.amount })))})`);

    // ── 23. A raise is a target (invites-vouching I6; DESIGN-invites-vouching-review-fable.md §4) ─────────────────────────
    // A voucher with a budget of 100 vouches 25 for one person and 50 for another (25 left): raising the first to 100 would
    // draw 75, more than is left, so it is refused with the budget sentence for that difference and nothing is written.
    const [pam, pat, pia] = [newId('Pam'), newId('Pat'), newId('Pia')];
    for (const p of [pam, pat, pia]) enter(p);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(pam, owen), amount_c: hc(100) })).status === 201, 'Pam is made a voucher with a budget of 100');
    require_((await vouch(pam, pat, 25)).status === 200 && (await vouch(pam, pia, 50)).status === 200 && budgetOf(pam.pk).left === hc(25), 'Pam vouches 25 for Pat and 50 for Pia: 25 left');
    const linesBefore23 = allLines();
    const roomBefore23 = roomOf(pat.pk);
    const tooMuch = await raiseTo(pam, pat, 100);
    assert(tooMuch.status === 409 && tooMuch.body?.code === 'not_enough'
        && tooMuch.body?.error === 'You have 25 Beans of budget left, so you can’t vouch 75. Pick a smaller vouch, or ask an owner for more.'
        && allLines() === linesBefore23 && roomOf(pat.pk) === roomBefore23,
        `23. a raise to 100 on 25 draws 75, more than the 25 left: refused with the budget sentence, nothing written (${show(tooMuch)})`);
    const fits = await raiseTo(pam, pat, 50);
    assert(fits.status === 200 && fits.body?.amount === hc(25) && fits.body?.total === hc(50) && budgetOf(pam.pk).left === 0 && roomOf(pat.pk) === roomBefore23 + hc(25),
        `23. a raise to 50 draws the 25 that is left (${show(fits)})`);
    // Never vouched for: nothing to raise. Both fields at once: refused. Raising a vouch that is not yours: nothing to raise.
    const noVouch = await raiseTo(pam, tz, 50);
    assert(noVouch.status === 409 && noVouch.body?.code === 'no_vouch_yet', `23. a raise for someone you never vouched for is refused (${show(noVouch)})`);
    const linesBeforeBoth = allLines();
    const amountAndTarget = await call(pam, 'POST', '/api/vouch', { memberPubkey: pat.pk, vouchAmount: hc(25), raiseTo: hc(75) });
    assert(amountAndTarget.status === 400 && amountAndTarget.body?.code === 'bad_body' && amountAndTarget.body?.error === VOUCHER_WORDS.vouchOrRaise && allLines() === linesBeforeBoth,
        `23. a vouch amount and a raise target together are refused, nothing written (${show(amountAndTarget)})`);
    // The retired boolean is not read: with only an amount, a second vouch for the same person is the plain already_vouched.
    const oldShape = await call(tia, 'POST', '/api/vouch', { memberPubkey: tx.pk, vouchAmount: hc(25), raise: true });
    assert(oldShape.status === 409 && oldShape.body?.code === 'already_vouched', `23. the old raise flag adds nothing: an amount is a first vouch only (${show(oldShape)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
