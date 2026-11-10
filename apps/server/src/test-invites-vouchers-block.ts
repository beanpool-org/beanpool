/**
 * The Vouchers block and the profile button (scratch/fable-design/DESIGN-invites-vouching-review-fable.md slice I4; Marty,
 * 10 Nov: owners are vouchers by role and sit first with no limit, a promised budget shows as "waiting to join", the card
 * puts its numbers first, the profile's button follows the person's state, and the invite_out words say what this viewer
 * can do). Through the real HTTPS stack and its signature middleware:
 *
 *  1. GET /api/names/vouchers lists the owner first (though "Ada" sorts before "Owen"), as a no-limit voucher; no balance figure.
 *  2. `waiting`: every unused, in-date bound invite that promises a voucher budget, by entry id (never the code, never the name);
 *     an invite with no budget, a lapsed one, a revoked one and a used one are not in it; an admin off the committee gets no block.
 *  3. The card's `vouchedLast30Days`: vouches that landed in the window; one from 40 days ago is in "vouched" but not in it.
 *  4. POST /api/trust/profile `voucherButton`: add (not on the list) / make (confirmed, viewer on the committee) / voucher
 *     (left, noLimit); a plain admin sees Add and the voucher card but never Make; a plain member and your own profile see none.
 *  5. 409 `invite_out`: its maker and any owner are told "Revoke it first to make a new one."; anyone else is told "Ask @maker
 *     or an owner to revoke it first."
 *  6. No Bean moved: the ledger audit sums to zero and no transaction was written.
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
import { voucherSummary } from './engine/vouchers.js';

let BASE = '';
const ADMIN_PW = 'Invites-Vouchers-Block-Pw-47!';
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

const generate = (id: Id, extra: Record<string, unknown> = {}) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk, ...extra });
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
const sumBalances = () => count('SELECT COALESCE(SUM(balance), 0) AS n FROM accounts');
const DAY = 24 * 60 * 60 * 1000;

/** A confirmation on a fresh entry, written as the names list's confirmMember writes it (setup only: the list's crypto is its own suite's). */
function confirm(member: Id, by: Id, awaitingSecond = false): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk, awaitingSecond ? 1 : 0);
    return entryId;
}

async function main(): Promise<void> {
    const COMMUNITY = (await ensureGenesis()).communityId;
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── Setup: Owen an owner, Ada an admin (a voucher by role, off the committee), Mel, Nia and Pam members ───────
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, mel, nia, pam] = ['Ada', 'Mel', 'Nia', 'Pam'].map(newId);
    for (const who of [ada, mel, nia, pam]) {
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
    const block = () => call(owen, 'GET', '/api/names/vouchers');
    const profile = (viewer: Id, target: Id) => call(viewer, 'POST', '/api/trust/profile', { targetPubkey: target.pk });
    const txBefore = count('SELECT COUNT(*) AS n FROM transactions');
    const balancesBefore = sumBalances();

    // ── 1. Owners first, with no budget words; everyone else after, by callsign ───────────────────────────────────
    const b1 = await block();
    const rows1 = (b1.body?.vouchers ?? []) as { memberPubkey: string; callsign: string; noLimit?: boolean }[];
    assert(b1.status === 200 && rows1.length >= 2 && rows1[0].memberPubkey === owen.pk && rows1[0].noLimit === true,
        `1. the block lists the owner first, as a no-limit voucher, though "Ada" sorts before "Owen" (${rows1.map((r) => `${r.callsign}:${r.noLimit ? 'owner' : 'voucher'}`).join(', ')})`);
    assert(rows1.slice(1).every((r) => r.noLimit !== true) && rows1.some((r) => r.memberPubkey === ada.pk),
        '1. no owner after the first non-owner; Ada, an admin, is among the others');
    assert(Array.isArray(b1.body?.waiting) && b1.body.waiting.length === 0, `1. nobody is waiting to join yet (${JSON.stringify(b1.body?.waiting)})`);
    assert(!/balance/i.test(b1.text), '1. the block carries no balance figure anywhere (no key or word "balance")');

    // ── 2. Waiting to join: an unused, in-date invite that promises a voucher budget, by entry id ────────────────
    const eWren = await addEntry('Wren Calloway');
    const wren = await bind(owen, eWren, { vouchAmount: 25, voucherLevel: 1000 });
    const cWren = wren.body?.invite?.code as string;
    require_(wren.status === 201 && cWren, `Owen binds an invite to Wren's entry with a 25 vouch and a 1,000 voucher budget (${show(wren)})`);
    const ePlain = await addEntry('Plain Bound');
    require_((await bind(owen, ePlain, { vouchAmount: 25 })).status === 201, 'Owen binds an invite with a vouch but no voucher budget to another entry');
    const b2 = await block();
    const waiting = (b2.body?.waiting ?? []) as { entryId: string; level: number; vouchAmount: number | null; madeBy: string; madeByCallsign: string; madeAt: string; expiresAt: string }[];
    assert(waiting.length === 1 && waiting[0].entryId === eWren && waiting[0].level === 1000 && waiting[0].vouchAmount === 25 && waiting[0].madeBy === owen.pk && waiting[0].madeByCallsign === 'Owen',
        `2. one row waits to join: Wren's entry, budget 1,000, vouch 25, made by Owen; the invite with no budget does not (${JSON.stringify(waiting)})`);
    const lifeMs = Date.parse(waiting[0].expiresAt) - Date.parse(waiting[0].madeAt);
    assert(Math.abs(lifeMs - 30 * DAY) < 1000, `2. it ends 30 days after it was made (${lifeMs / DAY} days)`);
    assert(!b2.text.includes(cWren) && !/Wren/i.test(b2.text) && !/Calloway/i.test(b2.text), '2. neither the code nor the name is in the answer: the name is sealed, opened on the phone');
    assert(!/balance/i.test(b2.text), '2. still no balance figure anywhere in the block');
    const adaBlock = await call(ada, 'GET', '/api/names/vouchers');
    assert(adaBlock.status === 403 && adaBlock.body?.code === 'committee_only', `2. an admin off the committee still gets no block (${show(adaBlock)})`);
    // Lapsed: past its 30 days it joins nobody, and leaves the list before the hourly prune deletes it.
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date(Date.now() - 31 * DAY).toISOString(), cWren);
    const b2lapsed = await block();
    assert(b2lapsed.body?.waiting?.length === 0, '2. an invite past its 30 days no longer waits');
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date().toISOString(), cWren);
    assert((await block()).body?.waiting?.length === 1, '2. back in date, it waits again');
    // Revoked: gone.
    const revoked = await call(owen, 'DELETE', `/api/invite/${encodeURIComponent(cWren)}`);
    assert(revoked.status === 200 && (await block()).body?.waiting?.length === 0, `2. revoked, it leaves the list (${show(revoked)})`);
    // Used: gone, and Wren is a member.
    const eJoin = await addEntry('Joss Marlowe');
    const joinInv = await bind(owen, eJoin, { voucherLevel: 500 });
    const cJoin = joinInv.body?.invite?.code as string;
    require_(joinInv.status === 201 && (await block()).body?.waiting?.length === 1, 'Owen binds a fresh invite with a 500 budget: it waits');
    const joss = newId('Joss');
    require_((await redeem(joss, cJoin)).status === 200, 'Joss joins with it');
    assert((await block()).body?.waiting?.length === 0, '2. used, it no longer waits');

    // ── 3. The card's last-30-days figure: vouches that landed in the window, never a balance ─────────────────────
    const v1 = await call(ada, 'POST', '/api/vouch', { memberPubkey: mel.pk, vouchAmount: 25 });
    require_(v1.status === 200 || v1.status === 201, `Ada vouches 25 for Mel (${show(v1)})`);
    assert(voucherSummary(ada.pk).vouchedLast30Days === 25 && voucherSummary(ada.pk).vouched === 25, `3. 25 in the last 30 days of 25 vouched (${voucherSummary(ada.pk).vouchedLast30Days})`);
    db.prepare("UPDATE room_gifts SET at = ? WHERE from_pubkey = ? AND kind = 'vouch'").run(new Date(Date.now() - 40 * DAY).toISOString(), ada.pk);
    assert(voucherSummary(ada.pk).vouchedLast30Days === 0 && voucherSummary(ada.pk).vouched === 25, '3. a vouch from 40 days ago is in "vouched" but not in the last 30 days');
    const v2 = await call(ada, 'POST', '/api/vouch', { memberPubkey: nia.pk, vouchAmount: 50 });
    require_(v2.status === 200 || v2.status === 201, `Ada vouches 50 for Nia (${show(v2)})`);
    const adaRow = ((await block()).body?.vouchers as { memberPubkey: string; vouchedLast30Days: number; vouched: number; peopleVouched: number }[]).find((r) => r.memberPubkey === ada.pk);
    assert(adaRow?.vouchedLast30Days === 50 && adaRow?.vouched === 75 && adaRow?.peopleVouched === 2, `3. the block's row says 50 of 75 to 2 people (${JSON.stringify(adaRow)})`);
    const card = await call(owen, 'GET', `/api/names/vouchers/${ada.pk}`);
    assert(card.status === 200 && card.body?.vouchedLast30Days === 50 && !/balance/i.test(card.text), `3. the card carries it too, and no balance figure (${show(card)})`);

    // ── 4. The profile's button follows the person's state ────────────────────────────────────────────────────────
    const buttonOf = async (viewer: Id, target: Id) => {
        const r = await profile(viewer, target);
        require_(r.status === 200, `${viewer.name} reads ${target.name}'s profile (${show(r)})`);
        return r.body?.voucherButton as Record<string, unknown> | undefined;
    };
    assert(JSON.stringify(await buttonOf(owen, pam)) === JSON.stringify({ state: 'add' }), '4. an owner sees "Add to the names list" on someone who is not on it');
    assert(JSON.stringify(await buttonOf(ada, pam)) === JSON.stringify({ state: 'add' }), '4. a plain admin sees Add too');
    assert((await buttonOf(mel, pam)) === undefined && (await buttonOf(pam, nia)) === undefined, '4. a plain member sees no button on anyone');
    assert((await buttonOf(owen, owen)) === undefined, '4. nobody has a button on their own profile');
    // Awaiting a second admin: neither Make nor Add.
    const waitingSecond = confirm(pam, owen, true);
    assert((await buttonOf(owen, pam)) === undefined, '4. a confirmation still waiting for its second admin offers nothing');
    db.prepare('DELETE FROM confirmations WHERE entry_id = ?').run(waitingSecond);
    const pamEntry = confirm(pam, owen);
    assert(JSON.stringify(await buttonOf(owen, pam)) === JSON.stringify({ state: 'make' }), '4. confirmed, an owner (on the committee) sees "Make a voucher"');
    assert((await buttonOf(ada, pam)) === undefined, '4. confirmed, a plain admin sees Add before and nothing after: Make is the committee\'s');
    const made = await call(owen, 'POST', '/api/names/vouchers', { entryId: pamEntry, amount: 500 });
    require_(made.status === 201, `Owen makes Pam a voucher with 500 (${show(made)})`);
    const pamButton = await buttonOf(owen, pam);
    assert(pamButton?.state === 'voucher' && pamButton.left === 500 && pamButton.noLimit === false && Object.keys(pamButton).sort().join() === 'left,noLimit,state',
        `4. a voucher: "Voucher · 500 left ›", and the button carries those three fields only (${JSON.stringify(pamButton)})`);
    const adaSeesPam = await buttonOf(ada, pam);
    assert(adaSeesPam?.state === 'voucher' && adaSeesPam.left === 500, '4. a plain admin sees the voucher button too (admins read a voucher\'s card)');
    const owenButton = await buttonOf(ada, owen);
    assert(owenButton?.state === 'voucher' && owenButton.noLimit === true, `4. an owner is "Voucher · No limit ›" (${JSON.stringify(owenButton)})`);
    assert(!/balance/i.test(JSON.stringify(pamButton) + JSON.stringify(owenButton)), '4. no balance figure in the button');

    // ── 5. invite_out words say what this viewer can do ───────────────────────────────────────────────────────────
    const eOut = await addEntry('Tamsin Hollow');
    const first = await bind(ada, eOut, { vouchAmount: 25 });
    require_(first.status === 201, `Ada binds an invite to Tamsin's entry (${show(first)})`);
    const byMaker = await bind(ada, eOut);
    const byOwner = await bind(owen, eOut);
    assert(byMaker.status === 409 && byMaker.body?.code === 'invite_out' && /Revoke it first to make a new one\.$/.test(byMaker.body?.error ?? '') && !/Ask /.test(byMaker.body?.error ?? ''),
        `5. its maker is told to revoke it first (${show(byMaker)})`);
    assert(byOwner.status === 409 && byOwner.body?.code === 'invite_out' && /Revoke it first to make a new one\.$/.test(byOwner.body?.error ?? ''),
        `5. an owner is told to revoke it first (${show(byOwner)})`);
    const eOwn = await addEntry('Orla Finch');
    require_((await bind(owen, eOwn)).status === 201, "Owen binds an invite to Orla's entry");
    const byOther = await bind(ada, eOwn);
    assert(byOther.status === 409 && byOther.body?.code === 'invite_out'
        && (byOther.body?.error ?? '').endsWith('Ask @Owen or an owner to revoke it first.') && !/Revoke it first to make a new one/.test(byOther.body?.error ?? ''),
        `5. another admin is told to ask the maker or an owner (${show(byOther)})`);
    assert(byOther.body?.madeByCallsign === 'Owen' && byOther.body?.daysLeft === 30, '5. the answer still names its maker and the days left, as before');

    // ── 6. No Bean moved ──────────────────────────────────────────────────────────────────────────────────────────
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.sumBalances) < 0.01 && sumBalances() === balancesBefore && count('SELECT COUNT(*) AS n FROM transactions') === txBefore,
        `6. the ledger audit sums to zero (${audit.sumBalances}), no balance moved and no transaction was written`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
