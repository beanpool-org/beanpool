/**
 * Revoke an invite, and one live invite per names-list entry (scratch/fable-design/DESIGN-invites-vouching-review-fable.md
 * slice I2; Marty, 10 Nov: revoke by the invite's maker and any owner; a second live invite on the same entry is refused).
 * Through the real HTTPS stack and its signature middleware:
 *
 *  1. DELETE /api/invite/:code by its maker: the vouch it held comes back (budget left rises by the preset, one `return`
 *     line, actor the revoker, ref the code), the row is gone (a tombstone for a standby), the card's count drops, and the
 *     budget's history says "invite revoked".
 *  2. A bound invite promising a voucher budget: one `voucher_promise_ended` line; an owner's hold closed, no budget moved.
 *  3. A used code: 409 `invite_used`, and nothing moves.
 *  4. An owner revokes another member's code; a plain member and an admin who is no owner can't (404 `no_invite`, the same
 *     answer as a code that doesn't exist); unsigned is 401.
 *  5. A second bind on an entry with a live invite: 409 `invite_out` with the maker's callsign and days left, nothing written;
 *     `replace: true` from another admin 403 `not_yours`; from the maker, the old one gone and the new one bound in one
 *     transaction; an owner replaces an admin's; a voucher replaces a 100 with a 100 from a budget of 100; a replace that
 *     fails leaves the old invite and its hold as they were.
 *  6. The prune and a revoke on the same code never return its vouch twice, in either order.
 *  7. DELETE /api/names/entries/:id/invite: the entry's line revokes by maker or owner; another admin 403; none out 404; a
 *     plain member never reaches it.
 *  8. A standby refuses (409 `standby`).
 *  9. No Bean moved: the ledger audit sums to zero and no transaction was written.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import {
    newNamesEntryId, sealNamesEntry, makeNamesGenerationFor, syncNames, namesSharesToSend, checkNamesKeyInPerson, emptyNamesPin, namesRingKeys,
    type NamesEntryText, type NamesPin, type NamesPlan, type NamesShare,
} from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, runLedgerAudit } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { budgetOf, returnLapsedHolds, voucherSummary } from './engine/vouchers.js';
import { pruneUnusedInvites } from './engine/writer-bounds.js';

let BASE = '';
const ADMIN_PW = 'Invite-Revoke-Pw-83!';
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
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100), the voucher budget's fields and the
 * vouchAmount / voucherLevel / level bodies included (they keep their names): `hc` turns a Beans figure into hundredths.
 */
const hc = (beans: number) => Math.round(beans * 100);

const generate = (id: Id, extra: Record<string, unknown> = {}) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk, ...extra });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const revoke = (id: Id | null, code: string) => call(id, 'DELETE', `/api/invite/${encodeURIComponent(code)}`);

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
const linesFor = (ref: string) => db.prepare('SELECT member_pubkey, kind, amount_c, actor, ref FROM voucher_allocations WHERE ref = ? ORDER BY rowid').all(ref) as
    { member_pubkey: string; kind: string; amount_c: number; actor: string; ref: string }[];
const returnsFor = (ref: string) => linesFor(ref).filter((l) => l.kind === 'return');
const allLines = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
const allInvites = () => count('SELECT COUNT(*) AS n FROM invite_codes');
const allLog = () => count('SELECT COUNT(*) AS n FROM known_floor_log');
const floorLog = (action: string) => db.prepare('SELECT * FROM known_floor_log WHERE action = ? ORDER BY rowid').all(action) as Record<string, any>[];
const tombstoned = (code: string) => count("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'invite_codes' AND row_key = ?", code) === 1;
const liveOn = (entryId: string) => db.prepare('SELECT code, created_by FROM invite_codes WHERE names_entry_id = ? AND used_by IS NULL').all(entryId) as { code: string; created_by: string }[];
const sumBalances = () => count('SELECT COALESCE(SUM(balance_c), 0) AS n FROM accounts');
const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
    const COMMUNITY = (await ensureGenesis()).communityId;
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── Setup: Owen an owner, Ada an admin (a voucher by role), Mel and Nia members ──────────────────────────────
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, mel, nia] = ['Ada', 'Mel', 'Nia'].map(newId);
    for (const who of [ada, mel, nia]) {
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
    const addEntry = async (name: string) => {
        const id = newNamesEntryId();
        const r = await call(owen, 'POST', '/api/names/entries', { id, ciphertext: sealNamesEntry(owenP.key(), id, owenP.head(), { name, note: '' } as NamesEntryText), keyId: owenP.head() });
        require_(r.status === 201, `Owen adds ${name} to the list (${show(r)})`);
        return id;
    };
    const bind = (id: Id, entryId: string, body: Record<string, unknown> = {}) => call(id, 'POST', `/api/names/entries/${entryId}/invite`, body);
    // An admin is a voucher only when an owner makes them one (invites-vouching I5): Owen makes Ada one, no entry needed.
    require_((await call(owen, 'POST', '/api/names/vouchers', { memberPubkey: ada.pk })).status === 201, 'Owen makes Ada, an admin, a voucher');
    require_(budgetOf(ada.pk).left === hc(1000), `Ada holds 1,000 (${budgetOf(ada.pk).left} hundredths)`);
    const txBefore = count('SELECT COUNT(*) AS n FROM transactions');
    const balancesBefore = sumBalances();

    // ── 1. The maker revokes: the hold comes back, one return line, the row gone ─────────────────────────────────
    const a1 = await generate(ada, { vouchAmount: hc(100) });
    const c1 = a1.body?.invite?.code as string;
    require_(a1.status === 200 && budgetOf(ada.pk).left === hc(900) && budgetOf(ada.pk).held === hc(100), `Ada makes an invite with a 100 vouch: 900 left, 100 held (${show(a1)})`);
    const sentBefore = voucherSummary(ada.pk).invitesWithVouch;
    const r1 = await revoke(ada, c1);
    assert(r1.status === 200 && r1.body?.revoked === 1 && r1.body?.returned === hc(100) && r1.body?.promiseEnded === false && !r1.text.includes(c1),
        `1. Ada revokes it: 200, 100 back, and the answer never repeats the code (${show(r1)})`);
    const b1 = budgetOf(ada.pk);
    assert(b1.left === hc(1000) && b1.held === 0, `1. budget left rises by the preset: 900 → ${b1.left} hundredths, held ${b1.held}`);
    const ret1 = returnsFor(c1);
    assert(ret1.length === 1 && ret1[0].amount_c === hc(100) && ret1[0].actor === ada.pk && ret1[0].member_pubkey === ada.pk,
        `1. exactly one return line, +100, actor the revoker, ref the code (${JSON.stringify(ret1)})`);
    assert(!codeRow(c1) && tombstoned(c1), '1. the row is deleted, with a tombstone so a standby drops it too');
    assert(voucherSummary(ada.pk).invitesWithVouch === sentBefore - 1, `1. "Invites sent with a vouch" leaves the revoked one out (${sentBefore} → ${voucherSummary(ada.pk).invitesWithVouch})`);
    const revokedLog = floorLog('invite_revoked');
    assert(revokedLog.length === 1 && revokedLog[0].actor_pubkey === ada.pk && revokedLog[0].member_pubkey === ada.pk && revokedLog[0].new_value === String(hc(100))
        && !JSON.stringify(revokedLog).includes(c1), `1. one invite_revoked line in the log, never the code (${JSON.stringify(revokedLog.map((l) => [l.action, l.new_value]))})`);
    const me1 = await call(ada, 'GET', '/api/vouchers/me');
    const hist = (me1.body?.history ?? []) as { kind: string; amount_c: number; why?: string }[];
    assert(hist.some((h) => h.kind === 'return' && h.amount_c === hc(100) && h.why === 'revoked'), `1. Ada's budget history says the 100 came back because the invite was revoked (${JSON.stringify(hist.slice(0, 3))})`);
    const again = await revoke(ada, c1);
    assert(again.status === 404 && again.body?.code === 'no_invite' && returnsFor(c1).length === 1, `1. revoking it again: 404, still one return line (${show(again)})`);

    // ── 2. A bound invite promising a voucher budget: the promise ends; an owner's hold closes, no budget moves ───
    const e2 = await addEntry('Wren Calloway');
    const owenBefore = budgetOf(owen.pk);
    const b2 = await bind(owen, e2, { vouchAmount: hc(25), voucherLevel: hc(1000) });
    const c2 = b2.body?.invite?.code as string;
    require_(b2.status === 201 && c2, `Owen binds an invite to Wren's entry with a 25 vouch and a 1,000 voucher budget (${show(b2)})`);
    const r2 = await revoke(owen, c2);
    const ended = floorLog('voucher_promise_ended');
    assert(r2.status === 200 && r2.body?.returned === hc(25) && r2.body?.promiseEnded === true, `2. Owen revokes it: 200, the 25 back, the promise ended (${show(r2)})`);
    assert(ended.length === 1 && ended[0].actor_pubkey === owen.pk && ended[0].old_value === e2 && ended[0].new_value === String(hc(1000)) && !JSON.stringify(ended).includes(c2),
        `2. one voucher_promise_ended line: who, which entry, what level, never the code (${JSON.stringify(ended.map((l) => [l.old_value, l.new_value]))})`);
    const owenAfter = budgetOf(owen.pk);
    assert(returnsFor(c2).length === 1 && returnsFor(c2)[0].actor === owen.pk && owenAfter.left === owenBefore.left && owenAfter.held === owenBefore.held && !codeRow(c2),
        `2. the owner's hold is closed by one return line, his budget untouched (left ${owenBefore.left} → ${owenAfter.left}), the row gone`);

    // ── 3. A used code: refused, nothing moves ───────────────────────────────────────────────────────────────────
    const a3 = await generate(ada, { vouchAmount: hc(50) });
    const c3 = a3.body?.invite?.code as string;
    const joiner = newId('Joss');
    require_(a3.status === 200 && (await redeem(joiner, c3)).status === 200, 'Joss joins with Ada\'s invite carrying 50');
    let linesBefore = allLines(), invitesBefore = allInvites(), logBefore = allLog();
    const left3 = budgetOf(ada.pk).left;
    const r3 = await revoke(ada, c3);
    const r3owner = await revoke(owen, c3);
    assert(r3.status === 409 && r3.body?.code === 'invite_used' && r3owner.status === 409 && r3owner.body?.code === 'invite_used',
        `3. a used code: 409 invite_used, for its maker and an owner (${show(r3)} | ${show(r3owner)})`);
    assert(allLines() === linesBefore && allInvites() === invitesBefore && allLog() === logBefore && budgetOf(ada.pk).left === left3 && codeRow(c3)?.used_by === joiner.pk,
        '3. nothing moved: no budget line, no log line, the row kept and still used');

    // ── 4. An owner revokes anyone's; a plain member or a plain admin can't; unsigned is 401 ─────────────────────
    const m4 = await generate(mel);
    const c4 = m4.body?.invite?.code as string;
    require_(m4.status === 200 && c4, "Mel makes a plain invite");
    invitesBefore = allInvites();
    const byNia = await revoke(nia, c4);
    const byAda = await revoke(ada, c4);
    const missing = await revoke(nia, 'NOSUCHCODE1');
    assert(byNia.status === 404 && byNia.body?.code === 'no_invite' && byAda.status === 404 && byAda.body?.code === 'no_invite' && !!codeRow(c4) && allInvites() === invitesBefore,
        `4. another member and an admin who is no owner can't revoke Mel's code: 404 no_invite, the row kept (${show(byNia)} | ${show(byAda)})`);
    assert(missing.status === 404 && missing.text === byNia.text, `4. the answer is word for word the one for a code that doesn't exist, so it says nothing about Mel's (${show(missing)})`);
    const unsigned = await revoke(null, c4);
    assert(unsigned.status === 401 && !!codeRow(c4), `4. unsigned: 401, the row kept (${show(unsigned)})`);
    const byOwen = await revoke(owen, c4.toLowerCase());
    assert(byOwen.status === 200 && byOwen.body?.returned === 0 && !codeRow(c4), `4. Owen, an owner, revokes Mel's code (typed in small letters): 200, gone (${show(byOwen)})`);
    const m4b = await generate(mel);
    const byMel = await revoke(mel, m4b.body?.invite?.code);
    assert(byMel.status === 200 && !codeRow(m4b.body?.invite?.code), `4. Mel revokes her own plain invite: 200 (${show(byMel)})`);

    // ── 5. One live invite per entry ─────────────────────────────────────────────────────────────────────────────
    const e5 = await addEntry('Tamsin Hollow');
    const first = await bind(owen, e5, { vouchAmount: hc(25) });
    const c5 = first.body?.invite?.code as string;
    require_(first.status === 201 && c5, `Owen binds an invite to Tamsin's entry (${show(first)})`);
    linesBefore = allLines(); invitesBefore = allInvites(); logBefore = allLog();
    const second = await bind(owen, e5, { vouchAmount: hc(25) });
    assert(second.status === 409 && second.body?.code === 'invite_out' && second.body?.madeByCallsign === 'Owen' && second.body?.madeBy === owen.pk && second.body?.daysLeft === 30
        && /@Owen/.test(second.body?.error ?? '') && !second.text.includes(c5),
        `5. a second bind on the entry: 409 invite_out with the maker's callsign and 30 days left, never the code (${show(second)})`);
    const byAdmin = await bind(ada, e5, { replace: true });
    assert(byAdmin.status === 403 && byAdmin.body?.code === 'not_yours', `5. Ada, an admin who didn't make it, replacing: 403 not_yours (${show(byAdmin)})`);
    const notTrue = await bind(owen, e5, { replace: 'yes' });
    assert(notTrue.status === 409 && notTrue.body?.code === 'invite_out', `5. replace must be true itself, not any truthy value (${show(notTrue)})`);
    assert(allLines() === linesBefore && allInvites() === invitesBefore && allLog() === logBefore && liveOn(e5).length === 1, '5. none of those wrote anything; one invite still out');
    const replaced = await bind(owen, e5, { vouchAmount: hc(50), replace: true });
    const c5b = replaced.body?.invite?.code as string;
    const live5 = liveOn(e5);
    assert(replaced.status === 201 && c5b && c5b !== c5 && !codeRow(c5) && live5.length === 1 && live5[0].code === c5b && codeRow(c5b)?.vouch_amount_c === hc(50),
        `5. Owen replaces it: 201, the old row gone, the new one bound with its 50 (${show(replaced)})`);
    assert(returnsFor(c5).length === 1 && returnsFor(c5)[0].actor === owen.pk && linesFor(c5b).filter((l) => l.kind === 'hold').length === 1 && tombstoned(c5),
        '5. the old hold came back (one return line) and the new one is held, in the same request');

    // An owner replaces an admin's.
    const e5c = await addEntry('Ivo Marchetti');
    const adaLeftBefore = budgetOf(ada.pk).left;
    const adaBound = await bind(ada, e5c, { vouchAmount: hc(100) });
    require_(adaBound.status === 201 && budgetOf(ada.pk).left === adaLeftBefore - hc(100), `Ada binds one to Ivo's entry holding 100 (${show(adaBound)})`);
    const owenOver = await bind(owen, e5c, { replace: true });
    assert(owenOver.status === 201 && !codeRow(adaBound.body?.invite?.code) && liveOn(e5c).length === 1 && liveOn(e5c)[0].created_by === owen.pk && budgetOf(ada.pk).left === adaLeftBefore,
        `5. an owner replaces an admin's: Ada's invite gone and her 100 back (${adaLeftBefore} → ${budgetOf(ada.pk).left}), Owen's bound (${show(owenOver)})`);
    assert(returnsFor(adaBound.body?.invite?.code)[0]?.actor === owen.pk && returnsFor(adaBound.body?.invite?.code)[0]?.member_pubkey === ada.pk,
        "5. the return is on Ada's budget, by Owen, the one who revoked it");

    // A voucher replaces a 100 with a 100 from a budget of 100: the old hold comes back before the new one is checked.
    require_((await call(owen, 'POST', `/api/names/vouchers/${ada.pk}/budget`, { level: hc(100) })).status === 200 && budgetOf(ada.pk).left === hc(100), "Owen sets Ada's budget to 100");
    const e5d = await addEntry('Pell Ashworth');
    const tight = await bind(ada, e5d, { vouchAmount: hc(100) });
    require_(tight.status === 201 && budgetOf(ada.pk).left === 0, `Ada binds one to Pell's entry with all 100 (${show(tight)})`);
    const tightAgain = await bind(ada, e5d, { vouchAmount: hc(100), replace: true });
    assert(tightAgain.status === 201 && !codeRow(tight.body?.invite?.code) && budgetOf(ada.pk).left === 0 && budgetOf(ada.pk).held === hc(100),
        `5. Ada replaces her own 100 with a new 100: 201, still 0 left and 100 held (${show(tightAgain)})`);

    // A replace that fails leaves both as they were.
    const cTight = tightAgain.body?.invite?.code as string;
    linesBefore = allLines(); invitesBefore = allInvites(); logBefore = allLog();
    const badPreset = await bind(ada, e5d, { vouchAmount: hc(60), replace: true });
    const overBudget = await bind(ada, e5d, { vouchAmount: hc(25), replace: true, voucherLevel: hc(500) });
    assert(badPreset.status === 400 && badPreset.body?.code === 'bad_amount', `5. a replace whose vouch is refused (60): 400 bad_amount (${show(badPreset)})`);
    assert(overBudget.status === 403, `5. a replace with a voucher budget from an admin off the credit committee: refused (${show(overBudget)})`);
    assert(allLines() === linesBefore && allInvites() === invitesBefore && allLog() === logBefore && !!codeRow(cTight) && liveOn(e5d).length === 1
        && returnsFor(cTight).length === 0 && budgetOf(ada.pk).held === hc(100),
        '5. both failed replaces left the old invite, its hold and the log exactly as they were');

    // ── 6. The prune and a revoke on the same code never return twice ──────────────────────────────────────────
    require_((await call(owen, 'POST', `/api/names/vouchers/${ada.pk}/budget`, { level: hc(1000) })).status === 200, "Owen sets Ada's budget back to 1,000");
    const age = (code: string) => db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date(Date.now() - 31 * DAY).toISOString(), code);
    // (a) the prune's return first (a budget writer's returnLapsedHolds), then the revoke.
    const p1 = (await generate(ada, { vouchAmount: hc(25) })).body?.invite?.code as string;
    age(p1);
    returnLapsedHolds(ada.pk);
    require_(returnsFor(p1).length === 1 && returnsFor(p1)[0].actor === 'node', 'the lapsed hold is returned by the node first');
    const leftA = budgetOf(ada.pk).left;
    const rA = await revoke(ada, p1);
    assert(rA.status === 200 && rA.body?.returned === 0 && returnsFor(p1).length === 1 && budgetOf(ada.pk).left === leftA && !codeRow(p1),
        `6. returned by the node, then revoked: 0 back, still one return line, left unchanged (${show(rA)})`);
    // (b) the revoke first, then the prune.
    const p2 = (await generate(ada, { vouchAmount: hc(25) })).body?.invite?.code as string;
    age(p2);
    const rB = await revoke(ada, p2);
    const leftB = budgetOf(ada.pk).left;
    pruneUnusedInvites();
    returnLapsedHolds();
    assert(rB.status === 200 && rB.body?.returned === hc(25) && returnsFor(p2).length === 1 && returnsFor(p2)[0].actor === ada.pk && budgetOf(ada.pk).left === leftB,
        `6. revoked, then the prune: one return line (the revoker's), left unchanged by the prune (${show(rB)})`);

    // ── 7. The entry's line: DELETE /api/names/entries/:id/invite ─────────────────────────────────────────────
    const e7 = await addEntry('Oona Feld');
    const o7 = await bind(owen, e7, { vouchAmount: hc(25) });
    require_(o7.status === 201, 'Owen binds one to Oona\'s entry');
    const melTries = await call(mel, 'DELETE', `/api/names/entries/${e7}/invite`);
    const adaTries = await call(ada, 'DELETE', `/api/names/entries/${e7}/invite`);
    assert(melTries.status === 403 && adaTries.status === 403 && adaTries.body?.code === 'not_yours' && liveOn(e7).length === 1,
        `7. a plain member never reaches it, and an admin who didn't make it gets 403 not_yours (${show(melTries)} | ${show(adaTries)})`);
    const owenRevokes = await call(owen, 'DELETE', `/api/names/entries/${e7}/invite`);
    assert(owenRevokes.status === 200 && owenRevokes.body?.revoked === 1 && owenRevokes.body?.returned === hc(25) && liveOn(e7).length === 0 && !owenRevokes.text.includes(o7.body?.invite?.code),
        `7. its maker revokes it from the entry: 200, gone, never the code (${show(owenRevokes)})`);
    const none = await call(owen, 'DELETE', `/api/names/entries/${e7}/invite`);
    assert(none.status === 404 && none.body?.code === 'no_invite', `7. nothing out: 404 no_invite (${show(none)})`);
    const a7 = await bind(ada, e7, { vouchAmount: hc(25) });
    const ownerRevokes = await call(owen, 'DELETE', `/api/names/entries/${e7}/invite`);
    assert(a7.status === 201 && ownerRevokes.status === 200 && returnsFor(a7.body?.invite?.code)[0]?.member_pubkey === ada.pk && liveOn(e7).length === 0,
        `7. an owner revokes an admin's from the entry; the 25 goes back to Ada (${show(ownerRevokes)})`);
    const fresh = await bind(owen, e7);
    assert(fresh.status === 201, `7. with nothing out, a new invite binds again (${show(fresh)})`);

    // ── 8. A standby refuses ───────────────────────────────────────────────────────────────────────────────────
    const c8 = (await generate(ada)).body?.invite?.code as string;
    setNodeRole('backup');
    const onStandby = await revoke(ada, c8);
    const entryOnStandby = await call(owen, 'DELETE', `/api/names/entries/${e7}/invite`);
    setNodeRole('primary');
    assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && entryOnStandby.status === 409 && !!codeRow(c8) && liveOn(e7).length === 1,
        `8. a standby: 409 standby, nothing deleted (${show(onStandby)} | ${show(entryOnStandby)})`);

    // ── 9. No Bean moved ───────────────────────────────────────────────────────────────────────────────────────
    const audit = runLedgerAudit();
    assert(audit.ok && audit.sumBalances === 0 && sumBalances() === balancesBefore && count('SELECT COUNT(*) AS n FROM transactions') === txBefore,
        `9. the ledger audit sums to zero (${audit.sumBalances}), no balance moved and no transaction was written`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
