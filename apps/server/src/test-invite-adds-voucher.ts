/**
 * The admins' invite adds the person, the name and a voucher budget (scratch/fable-design/DESIGN-invites-and-names-list-amend3-
 * fable.md slice A1, with Marty's decisions of 8 Nov: Q1 allow both, Q3 keep). Through the real HTTPS stack and its signature
 * middleware:
 *
 *  1. Q1: an invite bound to a names-list entry may carry a vouch preset too: 100 held from the maker's budget when it is
 *     made, landing on the joiner at the redeem, with the known floor. The two add up on the joiner's floor (measured).
 *  2. Q1: every vouch rule still refuses on a bound invite: a non-preset, more than is left, a maker who is no voucher.
 *  3. `voucherLevel`: promised at creation (one `voucher_promised` line, no budget row, no allocation line); at the redeem
 *     the joiner is confirmed and made a voucher in the redeem's one transaction (one `grant`, one `voucher_made`, a kept
 *     notice); GET /api/names/invites shows the level and the outcome, with the words.
 *  4. Refused before anything is written: 2,100, 150, an admin off the credit committee, Beans off.
 *  5. A code that expires: its vouch comes back, and no voucher line is written.
 *  6. Two admins to confirm: nothing lands until the second admin confirms; then the voucher lands.
 *  7. The maker left the credit committee: the joiner is confirmed, not made a voucher, and the words say why.
 *  8. The maker demoted: neither.
 *  9. Nothing that reaches a joiner before they join (/api/invite/check) or their card at the redeem carries the level,
 *     the vouch or the entry.
 * 10. An automation token and a password session reach the route not at all (401); a standby refuses it (409).
 * 11. No Bean moved: the ledger audit sums to zero and no transaction was written.
 * 12. The replication manifest carries the two new columns, and the hashes' version moved.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import {
    newNamesEntryId, sealNamesEntry, makeNamesGenerationFor, syncNames, namesSharesToSend, checkNamesKeyInPerson, emptyNamesPin, namesRingKeys,
    boundInviteLine, type NamesEntryText, type NamesPin, type NamesPlan, type NamesShare,
} from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, getBalance, runLedgerAudit } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setSwitchOverride } from './config/node-profile.js';
import { setNodeRole } from './config/node-role.js';
import { TABLES } from './engine/replication-manifest.js';
import { TABLE_HASHES_VERSION } from './engine/replica-hashes.js';
import { budgetOf, returnLapsedHolds } from './engine/vouchers.js';
import { listKeptNotices } from './engine/kept-notices.js';
import { issueAutomationToken } from './automation-tokens.js';

let BASE = '';
const ADMIN_PW = 'Invite-Adds-Voucher-Pw-71!';
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

interface Id { pk: string; priv: crypto.KeyObject; seedHex: string; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seedHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, seedHex, name };
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

const generate = (id: Id) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });

class Phone {
    pin: NamesPin | null = null;
    constructor(public id: Id) {}
    get signer() { return { publicKey: this.id.pk, privateKey: this.id.seedHex }; }
    async sync(): Promise<{ plan: NamesPlan; state: any }> {
        const s = await call(this.id, 'GET', '/api/names/state');
        if (s.status !== 200) throw new Error(`${this.id.name}'s state: ${show(s)}`);
        const r = syncNames({ pin: this.pin, state: s.body, me: this.signer });
        this.pin = r.pin;
        return { plan: r.plan, state: s.body };
    }
    async open(): Promise<NamesPlan> {
        let r = await this.sync();
        if (r.plan.kind === 'make_first' || r.plan.kind === 'make_new') {
            const m = makeNamesGenerationFor(this.pin!, this.signer, r.plan.kind === 'make_new' ? r.plan.drops : []);
            this.pin = m.pin;
            await call(this.id, 'POST', '/api/names/generations', { statement: m.generation.statement, signature: m.generation.signature });
            r = await this.sync();
        }
        if (r.plan.kind === 'ready') {
            for (const s of namesSharesToSend(this.pin!, r.state, this.signer) as NamesShare[]) {
                await call(this.id, 'POST', '/api/names/shares', { header: s.header, signature: s.signature, box: s.box });
            }
        }
        return r.plan;
    }
    head(): string { return this.pin!.chain[this.pin!.chain.length - 1].id; }
    key(id = this.head()): Uint8Array { return namesRingKeys(this.pin!)[id]; }
}

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const codeRow = (code: string) => db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as Record<string, any> | undefined;
const liveConfirmation = (pk: string) => db.prepare('SELECT entry_id, confirmed_by, needs_second, id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(pk) as
    { entry_id: string; confirmed_by: string; needs_second: number; id: string } | undefined;
const voucherRow = (pk: string) => db.prepare('SELECT * FROM vouchers WHERE member_pubkey = ?').get(pk) as Record<string, any> | undefined;
const linesOf = (pk: string) => db.prepare('SELECT kind, amount_c, actor, ref FROM voucher_allocations WHERE member_pubkey = ? ORDER BY rowid').all(pk) as { kind: string; amount: number; actor: string; ref: string | null }[];
const allLines = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
const floorLog = (action: string) => db.prepare('SELECT * FROM known_floor_log WHERE action = ? ORDER BY rowid').all(action) as Record<string, any>[];
const roomOf = (pk: string) => count(`SELECT COALESCE(SUM(amount_c), 0) AS n FROM room_gifts WHERE to_pubkey = ? AND kind = 'vouch'`, pk);
const voucherNotices = (pk: string) => listKeptNotices(pk).filter((n) => n.data.kind === 'voucher_budget');
const sumBalances = () => count('SELECT COALESCE(SUM(balance_c), 0) AS n FROM accounts');

async function main(): Promise<void> {
    const COMMUNITY = (await ensureGenesis()).communityId;
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── Setup: Owen an owner (on the credit committee by role), Ada an admin (not on it), Mel a member ───────────────
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, mel] = ['Ada', 'Mel'].map(newId);
    for (const who of [ada, mel]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }
    const owenP = new Phone(owen);
    const adaP = new Phone(ada);
    owenP.pin = checkNamesKeyInPerson(emptyNamesPin(COMMUNITY, owen.pk), ada.pk);
    adaP.pin = checkNamesKeyInPerson(emptyNamesPin(COMMUNITY, ada.pk), owen.pk);
    require_((await owenP.open()).kind === 'ready', "Owen's phone makes the list's first key");
    await owenP.open();
    require_((await adaP.open()).kind === 'ready', "Ada's phone takes the list's key from Owen's");
    require_((await call(null, 'POST', '/api/local/admin/community-shape', { changes: { knownFloor: { on: true } } }, PASSWORD())).status === 200, 'the community turns on the known floor');
    const addEntry = async (name: string) => {
        const id = newNamesEntryId();
        const r = await call(owen, 'POST', '/api/names/entries', { id, ciphertext: sealNamesEntry(owenP.key(), id, owenP.head(), { name, note: '' } as NamesEntryText), keyId: owenP.head() });
        require_(r.status === 201, `Owen adds ${name} to the list (${show(r)})`);
        return id;
    };
    const bind = (id: Id, entryId: string, body: Record<string, unknown> = {}) => call(id, 'POST', `/api/names/entries/${entryId}/invite`, body);
    require_(budgetOf(owen.pk).left === 1000 && budgetOf(ada.pk).left === 1000, `Owen and Ada each hold 1,000 by role (${budgetOf(owen.pk).left}, ${budgetOf(ada.pk).left})`);
    const txBefore = count('SELECT COUNT(*) AS n FROM transactions');
    const balancesBefore = sumBalances();

    // ── 1. Q1: a bound invite carries a vouch too ────────────────────────────────────────────────────────────────
    const e1 = await addEntry('Jory Pendlebury');
    const b1 = await bind(owen, e1, { vouchAmount: 100 });
    assert(b1.status === 201 && b1.body?.invite?.namesEntryId === e1 && b1.body?.invite?.vouchAmount === 100, `1. a bound invite with vouchAmount 100: 201, bound and carrying the vouch (${show(b1)})`);
    const c1 = b1.body?.invite?.code as string;
    const owenAfterHold = budgetOf(owen.pk);
    // Owen is an owner: he vouches with no limit (Marty, 9 Nov; test-owner-vouch.ts), so the hold is recorded on his ledger as
    // an owner's and drawn from no budget. Ada, an admin, holds from hers below (2.).
    assert(codeRow(c1)?.vouch_amount === 100 && owenAfterHold.held === 0 && owenAfterHold.left === 1000
        && linesOf(owen.pk).some((l) => l.kind === 'hold' && l.amount === -100 && l.ref === c1 && l.actor === 'role:owner'),
        `1. 100 is recorded as an owner's hold on Owen's ledger when the code is made, his budget untouched (left ${owenAfterHold.left}, held ${owenAfterHold.held}, row ${codeRow(c1)?.vouch_amount})`);
    const jory = newId('Jory');
    const j1 = await redeem(jory, c1);
    assert(j1.status === 200 && j1.body?.vouch?.landed === 100 && liveConfirmation(jory.pk)?.entry_id === e1 && codeRow(c1)?.names_bind_outcome === 'confirmed',
        `1. the redeem confirms Jory against the entry and lands the vouch (${show(j1)})`);
    assert(roomOf(jory.pk) === 100 && budgetOf(owen.pk).vouched === 100 && budgetOf(owen.pk).held === 0 && budgetOf(owen.pk).left === 1000,
        `1. the vouch is room on Jory from Owen, and no longer held (${JSON.stringify(budgetOf(owen.pk))})`);
    // The measurement Marty asked for: how the vouch and the known floor combine on the joiner's floor.
    const jb = getBalance(jory.pk);
    console.log(`   MEASURED: Jory knownGrant ${jb.knownGrant}, roomHeld ${jb.roomHeld}, floor ${jb.floor}, usableFloor ${jb.usableFloor}, liveOffers ${jb.liveOffers}`);
    assert(jb.knownGrant === 1000 && jb.roomHeld === 100 && jb.floor === -1100,
        `1. on Jory's floor the two add up: known 1,000 + vouch 100 = limit 1,100 (known ${jb.knownGrant}, room ${jb.roomHeld}, floor ${jb.floor})`);

    // ── 2. Q1: every vouch rule still refuses on a bound invite ─────────────────────────────────────────────────
    const e2 = await addEntry('Hollis Merriweather');
    let invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    let linesBefore = allLines();
    const notPreset = await bind(owen, e2, { vouchAmount: 60 });
    assert(notPreset.status === 400 && notPreset.body?.code === 'bad_amount' && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore && allLines() === linesBefore,
        `2. a vouch of 60 on a bound invite: 400 bad_amount, nothing written (${show(notPreset)})`);
    require_((await call(owen, 'POST', `/api/names/vouchers/${ada.pk}/budget`, { level: 100 })).status === 200 && budgetOf(ada.pk).left === 100, "Owen sets Ada's budget to 100");
    const adaFirst = await bind(ada, e2, { vouchAmount: 100 });
    require_(adaFirst.status === 201 && budgetOf(ada.pk).held === 100 && budgetOf(ada.pk).left === 0, `Ada's bound invite holds all 100 of hers (${show(adaFirst)})`);
    invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    linesBefore = allLines();
    const overBudget = await bind(ada, e2, { vouchAmount: 25 });
    assert(overBudget.status === 409 && overBudget.body?.code === 'not_enough', `2. a vouch past what is left on a bound invite: 409 not_enough with the sentence (${show(overBudget)})`);
    db.prepare("UPDATE vouchers SET stopped_at = '2026-01-01T00:00:00.000Z' WHERE member_pubkey = ?").run(ada.pk);
    const notVoucher = await bind(ada, e2, { vouchAmount: 25 });
    db.prepare('UPDATE vouchers SET stopped_at = NULL WHERE member_pubkey = ?').run(ada.pk);
    assert(notVoucher.status === 403 && notVoucher.body?.code === 'not_a_voucher', `2. a maker who is no voucher: 403 not_a_voucher (${show(notVoucher)})`);
    assert(count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore && allLines() === linesBefore, '2. none of those wrote an invite or a budget line');

    // ── 3. voucherLevel: promised at creation, landed at the redeem ─────────────────────────────────────────────
    const e3 = await addEntry('Jane Albury');
    linesBefore = allLines();
    const vouchersBefore = count('SELECT COUNT(*) AS n FROM vouchers');
    const b3 = await bind(owen, e3, { vouchAmount: 25, voucherLevel: 1000 });
    assert(b3.status === 201 && b3.body?.invite?.voucherLevel === 1000 && b3.body?.invite?.vouchAmount === 25, `3. a bound invite with voucherLevel 1,000 and a vouch of 25: 201 (${show(b3)})`);
    const c3 = b3.body?.invite?.code as string;
    const promised = floorLog('voucher_promised').filter((l) => l.old_value === e3);
    assert(codeRow(c3)?.voucher_level === 1000 && promised.length === 1 && promised[0].actor_pubkey === owen.pk && promised[0].new_value === '1000' && promised[0].member_pubkey === null,
        `3. the code keeps the level, and one voucher_promised line says who promised what for which entry (${JSON.stringify(promised)})`);
    assert(count('SELECT COUNT(*) AS n FROM vouchers') === vouchersBefore && allLines() === linesBefore + 1,
        `3. no voucher row and no grant yet: the only budget line is the 25 held from Owen's (${allLines() - linesBefore})`);
    const jane = newId('Jane');
    const j3 = await redeem(jane, c3);
    assert(j3.status === 200 && liveConfirmation(jane.pk)?.entry_id === e3 && codeRow(c3)?.names_bind_outcome === 'confirmed' && j3.body?.vouch?.landed === 25,
        `3. Jane joins, confirmed against the entry, with Owen's vouch of 25 (${show(j3)})`);
    const janeBudget = budgetOf(jane.pk);
    const janeLines = linesOf(jane.pk);
    const janeRow = voucherRow(jane.pk);
    assert(janeBudget.level === 1000 && janeBudget.left === 1000 && janeLines.length === 1 && janeLines[0].kind === 'grant' && janeLines[0].amount === 1000 && janeLines[0].actor === owen.pk,
        `3. and is made a voucher with 1,000: one grant line, by Owen (${JSON.stringify(janeLines)})`);
    assert(janeRow?.source === 'entry' && janeRow?.entry_id === e3 && janeRow?.made_by === owen.pk && janeRow?.stopped_at === null, `3. her budget's source is the entry, made by Owen (${JSON.stringify(janeRow)})`);
    const made = floorLog('voucher_made').filter((l) => l.member_pubkey === jane.pk);
    assert(made.length === 1 && made[0].actor_pubkey === owen.pk, `3. one voucher_made line, by Owen (${JSON.stringify(made)})`);
    const janeNotices = voucherNotices(jane.pk);
    assert(janeNotices.length === 1 && janeNotices[0].data.change === 'made' && /budget of 1,?000 Beans/.test(janeNotices[0].body), `3. a notice is kept for Jane (${JSON.stringify(janeNotices.map((n) => n.body))})`);
    assert(codeRow(c3)?.voucher_outcome === 'made', `3. the invite keeps the outcome (${codeRow(c3)?.voucher_outcome})`);
    const listed = await call(ada, 'GET', '/api/names/invites');
    const l3 = listed.body?.invites?.find((i: any) => i.entryId === e3);
    assert(listed.status === 200 && l3?.voucherLevel === 1000 && l3?.voucherOutcome === 'made' && !('code' in l3), `3. GET /api/names/invites shows the level and the outcome, never the code (${JSON.stringify(l3)})`);
    const line3 = boundInviteLine(l3, (pk) => (pk === jane.pk ? '@Jane' : pk === owen.pk ? '@Owen' : 'Someone'));
    assert(line3 === '@Jane joined and was confirmed; made a voucher with a budget of 1000 Beans', `3. the entry's line says so: "${line3}"`);

    // ── 4. Refused before anything is written ────────────────────────────────────────────────────────────────────
    const e4 = await addEntry('Morwenna Treleaven');
    invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    linesBefore = allLines();
    const promisedBefore = floorLog('voucher_promised').length;
    const too = [await bind(owen, e4, { voucherLevel: 2100 }), await bind(owen, e4, { voucherLevel: 150 }), await bind(owen, e4, { voucherLevel: '1000' })];
    assert(too.every((r) => r.status === 400 && r.body?.code === 'bad_level'), `4. 2,100, 150 and "1000": 400 bad_level (${too.map(show).join(' | ')})`);
    const byAda = await bind(ada, e4, { voucherLevel: 1000 });
    assert(byAda.status === 403 && byAda.body?.code === 'committee_only', `4. an admin off the credit committee: 403 committee_only with the sentence (${show(byAda)})`);
    setSwitchOverride('beans', false);
    const beansOff = await bind(owen, e4, { voucherLevel: 1000 });
    setSwitchOverride('beans', true);
    assert(beansOff.status === 403 && beansOff.body?.code === 'profile_no_beans', `4. Beans off: refused (${show(beansOff)})`);
    assert(count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore && allLines() === linesBefore && floorLog('voucher_promised').length === promisedBefore,
        '4. none of those wrote an invite, a budget line or a promise');

    // ── 5. A code that expires: the vouch comes back, no voucher line ───────────────────────────────────────────
    const b5 = await bind(owen, e4, { vouchAmount: 50, voucherLevel: 500 });
    require_(b5.status === 201, `Owen makes a bound invite with a vouch of 50 and a level of 500 (${show(b5)})`);
    const c5 = b5.body.invite.code as string;
    const withIt = budgetOf(owen.pk);
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), c5);
    // An owner's 50 was never held from a budget (Marty, 9 Nov), so its lapse moves none of it.
    assert(withIt.held === 0 && budgetOf(owen.pk).held === 0 && budgetOf(owen.pk).left === withIt.left,
        `5. once the code lapses nothing moves in the owner's budget, which never held its 50 (held ${withIt.held} → ${budgetOf(owen.pk).held}, left ${withIt.left} → ${budgetOf(owen.pk).left})`);
    returnLapsedHolds(owen.pk);
    assert(linesOf(owen.pk).some((l) => l.kind === 'return' && l.amount === 50 && l.ref === c5), '5. and the prune writes its return line');
    const late = newId('Late');
    const lateJoin = await redeem(late, c5);
    assert(lateJoin.status === 400 && /expired/i.test(lateJoin.body?.error ?? ''), `5. the expired code joins nobody (${show(lateJoin)})`);
    assert(floorLog('voucher_made').every((l) => l.member_pubkey !== late.pk) && floorLog('voucher_not_made').every((l) => l.old_value !== e4) && !voucherRow(late.pk),
        '5. no voucher line and no budget: the promise died with the code');

    // ── 6. Two admins to confirm: nothing lands until the second ────────────────────────────────────────────────
    require_((await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: true })).status === 200, 'Owen turns on two admins to confirm');
    const e6 = await addEntry('Tamsin Rowe');
    const b6 = await bind(owen, e6, { voucherLevel: 800 });
    require_(b6.status === 201, `Owen makes a bound invite with a level of 800 (${show(b6)})`);
    const tamsin = newId('Tamsin');
    const j6 = await redeem(tamsin, b6.body.invite.code);
    const conf6 = liveConfirmation(tamsin.pk);
    assert(j6.status === 200 && conf6?.needs_second === 1 && codeRow(b6.body.invite.code)?.names_bind_outcome === 'awaiting_second' && !voucherRow(tamsin.pk)
        && codeRow(b6.body.invite.code)?.voucher_outcome === 'awaiting_second', `6. Tamsin joins waiting for a second admin, and no budget lands yet (${show(j6)})`);
    const nameOf6 = (pk: string) => (pk === tamsin.pk ? '@Tamsin' : pk === owen.pk ? '@Owen' : 'Someone');
    const waiting6 = (await call(ada, 'GET', '/api/names/invites')).body?.invites?.find((i: any) => i.entryId === e6);
    assert(waiting6?.outcome === 'awaiting_second' && boundInviteLine(waiting6, nameOf6) === '@Tamsin joined; the confirmation waits for a second admin; made a voucher once a second admin confirms them',
        `6. while it waits, the entry's line says so (${JSON.stringify(waiting6)})`);
    const seconded = await call(ada, 'POST', `/api/names/confirmations/${conf6?.id}/second`, {});
    assert(seconded.status === 200 && seconded.body?.status === 'confirmed', `6. Ada confirms her again (${show(seconded)})`);
    // #2970's review, note 3: the bound invite reads the confirmation as it stands now, not the redeem's 'awaiting_second'
    // (which stays in the row as what the redeem did).
    const after6 = (await call(ada, 'GET', '/api/names/invites')).body?.invites?.find((i: any) => i.entryId === e6);
    const line6 = boundInviteLine(after6, nameOf6);
    assert(after6?.outcome === 'confirmed' && after6?.voucherOutcome === 'made' && codeRow(b6.body.invite.code)?.names_bind_outcome === 'awaiting_second'
        && line6 === '@Tamsin joined and was confirmed; made a voucher with a budget of 800 Beans',
        `6. once seconded, GET /api/names/invites reads confirmed, and the line says so: "${line6}" (${JSON.stringify(after6)})`);
    assert(budgetOf(tamsin.pk).level === 800 && voucherRow(tamsin.pk)?.made_by === owen.pk && codeRow(b6.body.invite.code)?.voucher_outcome === 'made'
        && floorLog('voucher_made').filter((l) => l.member_pubkey === tamsin.pk).length === 1 && voucherNotices(tamsin.pk).length === 1,
        `6. then the voucher lands, made by Owen, with its line and its notice (${JSON.stringify(budgetOf(tamsin.pk))})`);
    const e6b = await addEntry('Wynn Carrow');
    const b6b = await bind(owen, e6b, { voucherLevel: 600 });
    const wynn = newId('Wynn');
    require_(b6b.status === 201 && (await redeem(wynn, b6b.body.invite.code)).status === 200 && codeRow(b6b.body.invite.code)?.voucher_outcome === 'awaiting_second',
        'Wynn joins with another, waiting for a second admin');
    const revoked = await call(ada, 'POST', `/api/names/confirmations/${liveConfirmation(wynn.pk)?.id}/revoke`, {});
    const wynnNotMade = floorLog('voucher_not_made').filter((l) => l.member_pubkey === wynn.pk);
    assert(revoked.status === 200 && !voucherRow(wynn.pk) && codeRow(b6b.body.invite.code)?.voucher_outcome === 'not_confirmed'
        && wynnNotMade.length === 1 && wynnNotMade[0].actor_pubkey === ada.pk && wynnNotMade[0].old_value === e6b,
        `6. revoked before the second admin confirms: the promise ends, one voucher_not_made line by Ada, no budget (${show(revoked)} ${JSON.stringify(wynnNotMade)})`);
    const wynnRow = (await call(ada, 'GET', '/api/names/invites')).body?.invites?.find((i: any) => i.entryId === e6b);
    const wynnLine = boundInviteLine(wynnRow, (pk) => (pk === wynn.pk ? '@Wynn' : 'Someone'));
    assert(wynnRow?.outcome === null && wynnRow?.voucherOutcome === 'not_confirmed' && wynnLine === '@Wynn joined; not made a voucher',
        `6. revoked before the second: the line no longer says it waits: "${wynnLine}" (${JSON.stringify(wynnRow)})`);
    require_((await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: false })).status === 200, 'two admins to confirm goes back off');

    // ── 7. The maker left the credit committee ───────────────────────────────────────────────────────────────────
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: true })).status === 200, 'Owen puts Ada on the credit committee');
    const e7 = await addEntry('Kit Fairweather');
    const b7 = await bind(ada, e7, { voucherLevel: 500 });
    require_(b7.status === 201, `Ada makes a bound invite with a level of 500 (${show(b7)})`);
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: false })).status === 200, 'Owen takes Ada off the committee');
    const kit = newId('Kit');
    const j7 = await redeem(kit, b7.body.invite.code);
    assert(j7.status === 200 && liveConfirmation(kit.pk)?.entry_id === e7 && !voucherRow(kit.pk) && codeRow(b7.body.invite.code)?.voucher_outcome === 'maker_not_committee',
        `7. Kit joins confirmed, and is not made a voucher (${show(j7)} ${codeRow(b7.body.invite.code)?.voucher_outcome})`);
    const notMade = floorLog('voucher_not_made').filter((l) => l.member_pubkey === kit.pk);
    assert(notMade.length === 1 && notMade[0].actor_pubkey === ada.pk && notMade[0].new_value === 'maker_not_committee', `7. one voucher_not_made line says why (${JSON.stringify(notMade)})`);
    const l7 = (await call(owen, 'GET', '/api/names/invites')).body?.invites?.find((i: any) => i.entryId === e7);
    const line7 = boundInviteLine(l7, (pk) => (pk === kit.pk ? '@Kit' : pk === ada.pk ? '@Ada' : 'Someone'));
    assert(line7 === '@Kit joined and was confirmed; not made a voucher: @Ada is no longer on the credit committee', `7. the words: "${line7}"`);

    // ── 8. The maker demoted: neither ────────────────────────────────────────────────────────────────────────────
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: true })).status === 200, 'Ada back on the committee');
    const e8 = await addEntry('Ned Ashworth');
    const b8 = await bind(ada, e8, { voucherLevel: 500 });
    require_(b8.status === 201, `Ada makes another (${show(b8)})`);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ada.pk, role: 'moderator' }, PASSWORD())).status === 200, 'Ada is made a moderator');
    const ned = newId('Ned');
    const j8 = await redeem(ned, b8.body.invite.code);
    assert(j8.status === 200 && !liveConfirmation(ned.pk) && !voucherRow(ned.pk) && codeRow(b8.body.invite.code)?.names_bind_outcome === 'maker_not_admin'
        && codeRow(b8.body.invite.code)?.voucher_outcome === 'not_confirmed', `8. Ned joins, neither confirmed nor made a voucher (${show(j8)} ${JSON.stringify(codeRow(b8.body.invite.code)?.voucher_outcome)})`);

    // ── 9. Nothing a joiner reads before joining carries the level, the vouch or the entry ──────────────────────
    require_((await owenP.open()).kind === 'ready', "with Ada no admin, Owen's phone makes the list a new key");
    const e9 = await addEntry('Pell Quarry');
    const b9 = await bind(owen, e9, { vouchAmount: 75, voucherLevel: 1500 });
    require_(b9.status === 201, `Owen makes a bound invite with both (${show(b9)})`);
    const c9 = b9.body.invite.code as string;
    const checked = await call(null, 'GET', `/api/invite/check?code=${encodeURIComponent(c9)}`);
    assert(checked.status === 200 && checked.body?.valid === true && Object.keys(checked.body).sort().join(',') === 'communityName,inviterCallsign,valid'
        && !checked.text.includes(e9) && !/voucher|vouch|entry|1500/i.test(checked.text), `9. /api/invite/check: valid, the inviter and the community, nothing else (${show(checked)})`);
    const pell = newId('Pell');
    const j9 = await redeem(pell, c9);
    const card = JSON.stringify(j9.body?.member ?? {});
    assert(j9.status === 200 && !card.includes(e9) && !/voucherLevel|voucher_level|namesEntry|names_entry/i.test(j9.text), `9. nor the joiner's card at the redeem (${show(j9)})`);

    // ── 10. Who may call it ──────────────────────────────────────────────────────────────────────────────────────
    const e10 = await addEntry('Rosalind Teague');
    invitesBefore = count('SELECT COUNT(*) AS n FROM invite_codes');
    const token = issueAutomationToken({ name: 'adds-voucher-suite', scope: 'admin', createdBy: owen.pk });
    require_(token.ok, 'Owen makes an admin automation token');
    const byToken = await call(null, 'POST', `/api/names/entries/${e10}/invite`, { voucherLevel: 1000 }, { Authorization: `Bearer ${token.ok ? token.token : ''}` });
    const byPassword = await call(null, 'POST', `/api/names/entries/${e10}/invite`, { voucherLevel: 1000 }, PASSWORD());
    assert(byToken.status === 401 && byPassword.status === 401 && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore,
        `10. an automation token and a password session: 401, nothing written (${show(byToken)} | ${show(byPassword)})`);
    setNodeRole('backup');
    const onStandby = await bind(owen, e10, { voucherLevel: 1000 });
    setNodeRole('primary');
    assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && count('SELECT COUNT(*) AS n FROM invite_codes') === invitesBefore, `10. a standby: 409 standby (${show(onStandby)})`);

    // ── 11. No Bean moved ────────────────────────────────────────────────────────────────────────────────────────
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.sumBalances) < 0.01 && sumBalances() === balancesBefore && count('SELECT COUNT(*) AS n FROM transactions') === txBefore,
        `11. the ledger audit sums to zero (${audit.sumBalances}), no balance moved and no transaction was written`);

    // ── 12. Replication ──────────────────────────────────────────────────────────────────────────────────────────
    const cols = JSON.stringify(TABLES.invite_codes);
    // 23 raised the version for these two columns; a later raise (24: standing deals) still hashes them. Which columns each
    // version hashes is pinned exactly in test-replica-hashes (COLUMNS_OF_VERSION), as test-vouch-reset reads "21 or later".
    assert(cols.includes('voucher_level') && cols.includes('voucher_outcome') && TABLE_HASHES_VERSION >= 23, `12. the manifest carries both columns as plain, hashes version 23 or later (${TABLE_HASHES_VERSION})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
