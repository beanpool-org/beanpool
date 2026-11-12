/**
 * Vouchers' budgets on the view, slice C3 (scratch/fable-design/DESIGN-credit-list-amend-fable.md §3.5, §3.6, §6, §8 tests 3,
 * 18, 19 and 20): the Vouchers chip, a voucher's budget line on their row, the top-up offer, Ask for more and the ask
 * cleared when a budget is set. Through the real HTTPS stack and its signature middleware for every route and refusal. Each
 * check says the change that turns it red. (The hundredth thresholds, 99.99 and 24.99, are core's: credit-budgets.test.ts.)
 *
 *  3. Who reads budgets: owners and committee admins get the Vouchers chip and a voucher's budget line on their row; a plain
 *     admin, a voucher, a member and a moderator get no budget field anywhere (403 `committee_only` or `not_a_giver` on
 *     the chip; no field on a page or a card).
 * 18. Running low: left 100 no flag; 75 flagged; 0 "nothing left"; a frozen voucher no button, the reason; an owner "no
 *     limit", never flagged.
 * 19. The top-up offer: last set 500 with 150 in hand → 500; 500 in hand (100 of it held) → 1,000; 2,000 in hand → none;
 *     no log line → the community's setting. The tap is today's route with exactly `{ level }`: one `top_up` line, one
 *     `budget_topup` line, one `voucher_budget` / `raised` notice and no other. `'top_up'` is written in setBudgetLevel alone.
 * 20. Ask for more: one `budget_asked` line; one kept notice and one bell row for each owner and committee admin, none for
 *     the asker, a plain admin, another voucher or a member; the body carries left, level and the five facts; title, body
 *     and data inside 80, 400 and 300 at the longest callsign and the largest figures; a second ask inside 7 days 409 and
 *     nothing written; an owner 409; a non-voucher 403; a frozen voucher 409; a body with words or an amount 400; a
 *     standby 409; after a top-up the row's ask is gone and every recipient's copy is marked, kept and bell, and nobody
 *     else's notice is; a week on, they may ask again, and an unanswered ask lapses.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, redeemInvite, broadcast } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { registerMemberInternal } from './engine/members.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { keepNotice, NOTICE_LIMITS } from './engine/kept-notices.js';
import { askNoticeBody, VOUCHER_WORDS } from './engine/vouchers.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
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
async function call(id: Id | null, method: 'GET' | 'POST' | 'DELETE', urlPath: string, body?: unknown, rawBody?: string): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : rawBody ?? JSON.stringify(body ?? {});
    const h: Record<string, string> = {};
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 240)}` : '-');
const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const hc = (beans: number) => Math.round(beans * 100);
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A confirmation on a fresh entry, as the names list's confirmMember writes it (setup only). */
function confirm(member: Id, by: Id, daysAgo = 0): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second, confirmed_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk, new Date(Date.now() - daysAgo * DAY).toISOString());
    return entryId;
}

interface Kept { id: string; recipient: string; title: string; body: string; data: string; seen_at: string | null }
interface Row { id: string; recipient: string; kind: string; data: string; seen_at: number | null }
const keptAll = () => db.prepare('SELECT id, recipient, title, body, data, seen_at FROM moderation_notices').all() as Kept[];
const rowsAll = () => db.prepare('SELECT id, recipient, kind, data, seen_at FROM push_notices').all() as Row[];
const dataOf = (raw: string) => { try { return JSON.parse(raw); } catch { return {}; } };
/** What `act` added: kept notices and bell rows, every recipient. */
async function added(act: () => Promise<Res>): Promise<{ res: Res; kept: Kept[]; rows: Row[] }> {
    const k0 = new Set(keptAll().map((k) => k.id));
    const r0 = new Set(rowsAll().map((r) => r.id));
    const res = await act();
    await sleep(80);
    return { res, kept: keptAll().filter((k) => !k0.has(k.id)), rows: rowsAll().filter((r) => !r0.has(r.id)) };
}
const logLines = (action: string, member: Id) => db.prepare('SELECT actor_pubkey, old_value, new_value, at FROM known_floor_log WHERE action = ? AND member_pubkey = ? ORDER BY at, rowid')
    .all(action, member.pk) as { actor_pubkey: string; old_value: string | null; new_value: string | null; at: string }[];
const allocLines = (member: Id, kind: string) => count('SELECT COUNT(*) AS n FROM voucher_allocations WHERE member_pubkey = ? AND kind = ?', member.pk, kind);

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community');
    grantNodeRole(owen.pk, 'owner', claim);
    const enter = (who: Id) => {
        const inv = generateInvite(owen.pk)!;
        require_(redeemInvite(inv.code, who.pk, who.name).success === true, `${who.name} joins`);
    };
    // The longest callsign a member can hold (members.ts: 32 characters).
    const longName = 'W'.repeat(32);
    const [ola, ada, pam, mo, jane, val, kim, lee, max, zed, fay, mel, rob, deb, sue, tom] =
        ['Ola', 'Ada', 'Pam', 'Mo', 'Jane', 'Val', 'Kim', 'Lee', 'Max', 'Zed', 'Fay', 'Mel', 'Rob', 'Deb', 'Sue', 'Tom'].map(newId);
    const wil = newId(longName);
    for (const who of [ola, ada, pam, mo, jane, val, kim, lee, max, zed, fay, mel, rob, deb, sue, tom, wil]) enter(who);
    grantNodeRole(ola.pk, 'owner', owen.pk);
    grantNodeRole(ada.pk, 'admin', owen.pk);
    grantNodeRole(pam.pk, 'admin', owen.pk);
    grantNodeRole(mo.pk, 'moderator', owen.pk);
    require_((await call(owen, 'POST', '/api/names/committee', { memberPubkey: ada.pk, on: true })).status === 200, 'Ada is put on the credit committee; Pam is a plain admin');
    const make = async (who: Id, beans: number, confirmedDaysAgo = 0) =>
        require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(who, owen, confirmedDaysAgo), amount_c: hc(beans) })).status === 201, `${who.name} is made a voucher with ${beans}`);
    await make(jane, 1000, 41);
    await make(val, 100);
    await make(kim, 500);
    await make(lee, 500);
    await make(max, 2000);
    await make(zed, 500);
    await make(fay, 500);
    await make(wil, 2000);
    const vouch = (by: Id, who: Id, beans: number) => call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, vouchAmount: hc(beans) });
    // Jane: 400 to 4 people (100 each, the most one voucher gives one person), so 600 of 1,000 left.
    for (const who of [mel, rob, deb, sue]) require_((await vouch(jane, who, 100)).status === 200, `Jane vouches 100 for ${who.name}`);
    // Kim: 350 vouched of a 500 grant, so 150 in hand.
    for (const [who, b] of [[mel, 100], [rob, 100], [deb, 100], [sue, 50]] as const) require_((await vouch(kim, who, b)).status === 200, `Kim vouches ${b} for ${who.name}`);
    // Lee: 100 held on an invite not used yet: 400 left, 500 in hand.
    const leeInvite = await call(lee, 'POST', '/api/invite/generate', { publicKey: lee.pk, vouchAmount: hc(100) });
    require_(leeInvite.status === 200 && leeInvite.body?.invite?.vouchAmount === hc(100), `Lee holds 100 on an invite (${show(leeInvite)})`);
    // Zed: 100 vouched, 400 in hand, and the log of his grant gone (as at the 1.4.0 step): the community's setting, 1,500.
    require_((await vouch(zed, tom, 100)).status === 200, 'Zed vouches 100 for Tom');
    db.prepare("DELETE FROM known_floor_log WHERE member_pubkey = ? AND action IN ('budget_grant', 'budget_topup', 'budget_lower')").run(zed.pk);
    require_((await call(owen, 'POST', '/api/names/vouchers/settings', { voucherBudget: hc(1500) })).status === 200, "The community's voucher budget setting is 1,500");
    // Fay: her credit line frozen by an admin.
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(fay.pk);

    // ── 3. Who reads budgets ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. who reads budgets —');
    const owenChip = await call(owen, 'GET', '/api/credit/people?filter=vouchers');
    const adaChip = await call(ada, 'GET', '/api/credit/people?filter=vouchers');
    assert(owenChip.status === 200 && adaChip.status === 200 && Array.isArray(owenChip.body?.vouchers) && Array.isArray(adaChip.body?.vouchers) && owenChip.body.next === null,
        `3. an owner and a committee admin read the Vouchers chip (${show(adaChip)})`);
    for (const [who, label, code] of [[pam, 'a plain admin', 'committee_only'], [jane, 'a voucher', 'committee_only'], [mel, 'a member', 'not_a_giver'], [mo, 'a moderator', 'not_a_giver']] as const) {
        const chip = await call(who, 'GET', '/api/credit/people?filter=vouchers');
        assert(chip.status === 403 && chip.body?.code === code && !chip.text.includes('topUpTo_c') && !chip.text.includes('runningLow'),
            `3. ${label}: 403 ${code} on the Vouchers chip, no budget row (red when isNodeAdmin stands in for isOnCreditCommittee) (${show(chip)})`);
    }
    const budgetKeys = /voucherBudget|runningLow|nothingLeft|topUpTo_c|topUpBlocked|askedAt/;
    const pamPage = await call(pam, 'GET', '/api/credit/people');
    const pamCard = await call(pam, 'GET', `/api/credit/people/${jane.pk}`);
    const janePage = await call(jane, 'GET', '/api/credit/people');
    const janeCard = await call(jane, 'GET', `/api/credit/people/${val.pk}`);
    assert(pamPage.status === 200 && pamCard.status === 200 && janePage.status === 200 && janeCard.status === 200
        && ![pamPage, pamCard, janePage, janeCard].some((r) => budgetKeys.test(r.text)),
        `3. a plain admin's and a voucher's pages and cards carry no budget field (red when the budget line is added outside the committee)`);
    const owenPage = await call(owen, 'GET', '/api/credit/people');
    const adaCard = await call(ada, 'GET', `/api/credit/people/${jane.pk}`);
    const owenJane = owenPage.body?.people?.find((p: any) => p.memberPubkey === jane.pk);
    const owenMel = owenPage.body?.people?.find((p: any) => p.memberPubkey === mel.pk);
    const owenSelf = owenPage.body?.people?.find((p: any) => p.memberPubkey === owen.pk);
    assert(owenJane?.voucherBudget?.left_c === hc(600) && owenJane.voucherBudget.level_c === hc(600) && owenJane.voucherBudget.setLevel_c === hc(1000) && owenJane.voucherBudget.runningLow === false
        && adaCard.body?.person?.voucherBudget?.left_c === hc(600) && owenMel && !('voucherBudget' in owenMel)
        && owenSelf?.voucherBudget?.noLimit === true && owenSelf.voucherBudget.left_c === null,
        `3. an owner's and a committee admin's rows: a voucher's budget in one line, an owner "no limit", none on a member who is no voucher (${JSON.stringify(owenJane?.voucherBudget)})`);
    const melMe = await call(mel, 'GET', '/api/vouchers/me');
    const owenMe = await call(owen, 'GET', '/api/vouchers/me');
    assert(melMe.status === 200 && melMe.body?.ask === null && owenMe.body?.ask === null,
        `3. a member and an owner have no Ask for more state of their own (${show(melMe)})`);
    const pamBlock = await call(pam, 'GET', '/api/names/vouchers');
    const adaBlock = await call(ada, 'GET', '/api/names/vouchers');
    assert(pamBlock.status === 403 && adaBlock.status === 200 && adaBlock.body?.vouchers?.every((v: any) => 'topUpTo_c' in v && 'runningLow' in v && 'confirmedSince' in v && 'memberSince' in v),
        `3. the Invites block, the committee's alone, carries the same budget sight and the two new branch-health facts (${show(pamBlock)})`);

    // ── 18. Running low ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 18. running low —');
    const rowOf = (chip: Res, who: Id) => chip.body?.vouchers?.find((v: any) => v.memberPubkey === who.pk);
    const chipNow = () => call(owen, 'GET', '/api/credit/people?filter=vouchers');
    let chip = owenChip;
    const valAt100 = rowOf(chip, val);
    assert(valAt100?.left === hc(100) && valAt100.runningLow === false && valAt100.nothingLeft === false,
        `18. Val with 100 left: not running low (red when the threshold moves above VOUCH_MAX) (${JSON.stringify(valAt100)})`);
    require_((await vouch(val, mel, 25)).status === 200, 'Val vouches 25 for Mel');
    chip = await chipNow();
    const valAt75 = rowOf(chip, val);
    assert(valAt75?.left === hc(75) && valAt75.runningLow === true && valAt75.nothingLeft === false,
        `18. Val with 75 left: running low, not "nothing left" (${JSON.stringify(valAt75)})`);
    for (const who of [rob, deb, sue]) require_((await vouch(val, who, 25)).status === 200, `Val vouches 25 for ${who.name}`);
    chip = await chipNow();
    const valAt0 = rowOf(chip, val);
    assert(valAt0?.left === 0 && valAt0.runningLow === true && valAt0.nothingLeft === true,
        `18. Val with 0 left: nothing left to vouch with (${JSON.stringify(valAt0)})`);
    const fayRow = rowOf(chip, fay);
    assert(fayRow?.topUpTo_c === null && fayRow.topUpBlocked === 'frozen',
        `18. Fay frozen: no top-up, the reason "frozen" (red when a frozen voucher is offered a raise) (${JSON.stringify(fayRow)})`);
    const owenRow = rowOf(chip, owen);
    const olaRow = rowOf(chip, ola);
    const last = chip.body?.vouchers?.slice(-2).map((v: any) => v.memberPubkey).sort();
    assert(owenRow?.noLimit === true && owenRow.runningLow === false && owenRow.nothingLeft === false && owenRow.topUpBlocked === 'no_limit'
        && olaRow?.noLimit === true && JSON.stringify(last) === JSON.stringify([owen.pk, ola.pk].sort()),
        `18. owners: "no limit", never flagged, last in the chip (${JSON.stringify(owenRow && { noLimit: owenRow.noLimit, runningLow: owenRow.runningLow, topUpBlocked: owenRow.topUpBlocked })})`);
    const order = chip.body?.vouchers?.filter((v: any) => !v.noLimit).map((v: any) => v.callsign);
    assert(order?.[0] === 'Val' && order.indexOf('Val') < order.indexOf('Kim') && order.indexOf('Kim') < order.indexOf('Jane'),
        `18. running low first, then least left (${JSON.stringify(order)})`);

    // ── 19. The top-up offer ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 19. the top-up offer —');
    const kimRow = rowOf(chip, kim);
    const leeRow = rowOf(chip, lee);
    const maxRow = rowOf(chip, max);
    const zedRow = rowOf(chip, zed);
    assert(kimRow?.level === hc(150) && kimRow.topUpTo_c === hc(500) && kimRow.topUpBlocked === null,
        `19. Kim, last set 500, 150 in hand: Top up to 500 (red when the offer ignores the level last set) (${JSON.stringify(kimRow && { level: kimRow.level, topUpTo_c: kimRow.topUpTo_c })})`);
    assert(leeRow?.left === hc(400) && leeRow.held === hc(100) && leeRow.topUpTo_c === hc(1000),
        `19. Lee, 500 in hand with 100 of it held: Top up to 1,000 (red when "in hand" reads only what is left) (${JSON.stringify(leeRow && { left: leeRow.left, held: leeRow.held, topUpTo_c: leeRow.topUpTo_c })})`);
    assert(maxRow?.level === hc(2000) && maxRow.topUpTo_c === null && maxRow.topUpBlocked === 'at_most',
        `19. Max, 2,000 in hand: no Top up, "at the most" (${JSON.stringify(maxRow && { topUpTo_c: maxRow.topUpTo_c, topUpBlocked: maxRow.topUpBlocked })})`);
    assert(zedRow?.level === hc(400) && zedRow.topUpTo_c === hc(1500),
        `19. Zed, no log line: the community's setting, 1,500 (${JSON.stringify(zedRow && { level: zedRow.level, topUpTo_c: zedRow.topUpTo_c })})`);
    const adaOwnRow = rowOf(await call(ada, 'GET', '/api/credit/people?filter=vouchers'), ada);
    assert(adaOwnRow === undefined || adaOwnRow.topUpBlocked === 'own', `19. a committee admin is never offered their own top-up`);

    const kimTopUp = await added(() => call(ada, 'POST', `/api/names/vouchers/${kim.pk}/budget`, { level: kimRow.topUpTo_c }));
    const kimNotice = kimTopUp.kept[0];
    assert(kimTopUp.res.status === 200 && allocLines(kim, 'top_up') === 1 && logLines('budget_topup', kim).length === 1
        && kimTopUp.kept.length === 1 && kimNotice?.recipient === kim.pk && dataOf(kimNotice.data).kind === 'voucher_budget' && dataOf(kimNotice.data).change === 'raised'
        && kimTopUp.rows.length === 1 && kimTopUp.rows[0]!.recipient === kim.pk,
        `19. the tap is today's route with exactly { level }: one top_up line, one budget_topup line, one voucher_budget raised notice to Kim and no other (${show(kimTopUp.res)})`);
    chip = await chipNow();
    assert(rowOf(chip, kim)?.level === hc(500) && rowOf(chip, kim)?.topUpTo_c === hc(1000), `19. topped up to 500, the next offer is 1,000`);
    const overMax = await call(ada, 'POST', `/api/names/vouchers/${max.pk}/budget`, { level: hc(2100) });
    assert(overMax.status === 400 && overMax.body?.code === 'bad_level' && overMax.body?.error === VOUCHER_WORDS.badLevel,
        `19. past the ceiling: the node's sentence (${show(overMax)})`);
    // The source: 'top_up' is written in setBudgetLevel, and nowhere else in the server.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcFiles: string[] = [];
    const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (/\.ts$/.test(name) && !/^test-|\.test\.ts$|test-harness/.test(name)) srcFiles.push(full);
        }
    };
    walk(here);
    const vouchersSrc = fs.readFileSync(path.join(here, 'engine', 'vouchers.ts'), 'utf8');
    const setStart = vouchersSrc.indexOf('export function setBudgetLevel(');
    const setEnd = vouchersSrc.indexOf('\n}\n', setStart);
    const outside = vouchersSrc.slice(0, setStart) + vouchersSrc.slice(setEnd);
    const topUpOutside = (outside.match(/'top_up'/g) ?? []).length;
    const otherWriters = srcFiles.filter((f) => !f.endsWith(path.join('engine', 'vouchers.ts')))
        .filter((f) => { const t = fs.readFileSync(f, 'utf8'); return t.includes("'top_up'") || /INSERT\s+INTO\s+voucher_allocations/i.test(t); });
    const inserts = (vouchersSrc.match(/INSERT\s+INTO\s+voucher_allocations/gi) ?? []).length;
    assert(setStart > 0 && vouchersSrc.slice(setStart, setEnd).includes("'top_up'") && topUpOutside === 1 && otherWriters.length === 0 && inserts === 1,
        `19. 'top_up' is written in setBudgetLevel alone (outside it: addLine's type only), one INSERT into the allocations, no other file (red when a second top-up writer appears) (${topUpOutside} ${otherWriters.join(', ')})`);

    // ── 20. Ask for more ─────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 20. Ask for more —');
    const other = keepNotice(owen.pk, 'Something else', 'A notice about something else.', { kind: 'other' });
    const asked = await added(() => call(jane, 'POST', '/api/vouchers/ask', {}));
    const askLines = logLines('budget_asked', jane);
    const askRecipients = asked.kept.map((k) => k.recipient).sort();
    assert(asked.res.status === 200 && typeof asked.res.body?.askedAt === 'string' && typeof asked.res.body?.askAgainAt === 'string'
        && askLines.length === 1 && askLines[0]!.actor_pubkey === jane.pk && askLines[0]!.old_value === String(hc(600)) && askLines[0]!.new_value === String(hc(1000)),
        `20. Jane asks: 200, one budget_asked line (old: left 600, new: the level last set, 1,000) (${show(asked.res)})`);
    assert(JSON.stringify(askRecipients) === JSON.stringify([owen.pk, ola.pk, ada.pk].sort())
        && asked.kept.every((k) => dataOf(k.data).kind === 'voucher_ask' && dataOf(k.data).by === jane.pk && dataOf(k.data).screen === 'credit' && k.title === VOUCHER_WORDS.askTitle),
        `20. one kept notice each for both owners and the committee admin; none for Jane, Pam (a plain admin), another voucher or a member (red when the ask goes to every admin) (${asked.kept.map((k) => k.recipient.slice(0, 6)).join(' ')})`);
    const keptById = new Map(asked.kept.map((k) => [k.id, k]));
    assert(asked.rows.length === 3 && asked.rows.every((r) => r.kind === 'community.notice' && keptById.get(dataOf(r.data).noticeId)?.recipient === r.recipient),
        `20. one bell row each, naming its own kept copy (${asked.rows.length})`);
    const askText = asked.kept[0]?.body ?? '';
    assert(askText.includes('@Jane asks for a bigger budget to vouch from.') && askText.includes('They have 600 of 1,000 Beans left.')
        && askText.includes('Vouched 400 to 4 people: 0 below zero, written off 0 (0%), 0 trading only inside their own circle.')
        && askText.includes('A voucher for 0 days.') && askText.includes('Confirmed for 41 days.') && !/balance/i.test(askText),
        `20. the body: left, level and the five facts, no balance (${askText})`);
    const longest = askNoticeBody({ callsign: longName, left: hc(2000), level: hc(2000), vouched: 999_999_999, people: 99_999, belowZero: 99_999,
        writtenOff: 999_999_999, insideOnly: 99_999, voucherDays: 99_999, confirmedDays: 99_999 });
    const longestData = JSON.stringify({ kind: 'voucher_ask', by: 'f'.repeat(64), screen: 'credit' });
    assert(longest.length <= NOTICE_LIMITS.body && VOUCHER_WORDS.askTitle.length <= NOTICE_LIMITS.title && longestData.length <= NOTICE_LIMITS.data,
        `20. at the longest callsign and the largest figures: title ${VOUCHER_WORDS.askTitle.length}/80, body ${longest.length}/400, data ${longestData.length}/300`);
    const wilAsk = await added(() => call(wil, 'POST', '/api/vouchers/ask', {}));
    assert(wilAsk.res.status === 200 && wilAsk.kept.length === 3 && wilAsk.kept.every((k) => k.body.startsWith(`@${longName} asks`)),
        `20. a voucher with a 32-character callsign: every copy kept (${show(wilAsk.res)})`);

    const again = await added(() => call(jane, 'POST', '/api/vouchers/ask', {}));
    assert(again.res.status === 409 && again.res.body?.code === 'asked_this_week' && /^You asked on \d{1,2} [A-Z][a-z]{2}\. You can ask again on \d{1,2} [A-Z][a-z]{2}\.$/.test(again.res.body?.error ?? '')
        && again.res.body?.askedAt === asked.res.body.askedAt && again.kept.length === 0 && again.rows.length === 0 && logLines('budget_asked', jane).length === 1,
        `20. a second ask inside 7 days: 409 with its sentence, nothing written (red when the weekly rule is removed) (${show(again.res)})`);
    const ownerAsk = await call(owen, 'POST', '/api/vouchers/ask', {});
    const memberAsk = await call(mel, 'POST', '/api/vouchers/ask', {});
    const frozenAsk = await call(fay, 'POST', '/api/vouchers/ask', {});
    assert(ownerAsk.status === 409 && ownerAsk.body?.code === 'no_limit' && memberAsk.status === 403 && memberAsk.body?.code === 'not_a_voucher'
        && frozenAsk.status === 409 && frozenAsk.body?.code === 'frozen' && frozenAsk.body?.error === VOUCHER_WORDS.askFrozen,
        `20. an owner 409, a member 403, a frozen voucher 409 with its sentence (${show(ownerAsk)} | ${show(memberAsk)} | ${show(frozenAsk)})`);
    const words = await call(kim, 'POST', '/api/vouchers/ask', { note: 'please' });
    const amount = await call(kim, 'POST', '/api/vouchers/ask', { level: hc(2000) });
    const unsigned = await call(null, 'POST', '/api/vouchers/ask', {});
    assert(words.status === 400 && words.body?.code === 'no_body' && amount.status === 400 && amount.body?.code === 'no_body' && unsigned.status === 401
        && logLines('budget_asked', kim).length === 0,
        `20. an ask with words or an amount: 400, nothing written (red when the ask takes text or an amount); unsigned 401 (${show(words)} | ${show(amount)})`);
    setNodeRole('backup');
    const standby = await call(kim, 'POST', '/api/vouchers/ask', {});
    setNodeRole('primary');
    setSwitchOverride('beans', false);
    const beansOff = await call(kim, 'POST', '/api/vouchers/ask', {});
    setSwitchOverride('beans', true);
    assert(standby.status === 409 && beansOff.status === 404 && logLines('budget_asked', kim).length === 0,
        `20. a standby refuses the ask (409), Beans off 404 (${show(standby)} | ${show(beansOff)})`);

    chip = await chipNow();
    const janeAsked = rowOf(chip, jane);
    const janeMe = await call(jane, 'GET', '/api/vouchers/me');
    assert(janeAsked?.askedAt === asked.res.body.askedAt && chip.body?.vouchers?.[0]?.memberPubkey === jane.pk
        && janeMe.body?.ask?.askedAt === asked.res.body.askedAt && janeMe.body?.ask?.askAgainAt === asked.res.body.askAgainAt && janeMe.body?.ask?.blocked === null,
        `20. Jane's row reads her ask, first in the chip; her own read says when she asked and when she may ask again (${JSON.stringify(janeMe.body?.ask)})`);
    const janeLine = (await call(owen, 'GET', '/api/credit/people')).body?.people?.find((p: any) => p.memberPubkey === jane.pk)?.voucherBudget;
    assert(janeLine?.askedAt === asked.res.body.askedAt, `20. her budget line on her row in every chip says she asked`);

    const askIds = asked.kept.map((k) => k.id);
    const janeTopUp = await added(() => call(ada, 'POST', `/api/names/vouchers/${jane.pk}/budget`, { level: janeAsked.topUpTo_c }));
    await sleep(80);
    const keptAfter = keptAll().filter((k) => askIds.includes(k.id));
    const rowsAfter = rowsAll().filter((r) => askIds.includes(dataOf(r.data).noticeId));
    const otherKept = keptAll().find((k) => k.id === other);
    const wilKeptAfter = keptAll().filter((k) => wilAsk.kept.some((w) => w.id === k.id));
    chip = await chipNow();
    assert(janeTopUp.res.status === 200 && janeAsked.topUpTo_c === hc(1000) && rowOf(chip, jane)?.askedAt === null && rowOf(chip, jane)?.level === hc(1000),
        `20. Ada tops Jane up to 1,000: her row's ask is gone (${show(janeTopUp.res)})`);
    assert(keptAfter.length === 3 && keptAfter.every((k) => k.seen_at !== null) && rowsAfter.length === 3 && rowsAfter.every((r) => r.seen_at !== null),
        `20. every recipient's copy of Jane's ask is marked, kept and bell, Ada's and the two owners' (red when a top-up leaves the ask in other bells)`);
    assert(otherKept?.seen_at === null && wilKeptAfter.length === 3 && wilKeptAfter.every((k) => k.seen_at === null),
        `20. nobody else's notice is touched: Owen's other notice and the other voucher's ask stay unseen`);
    const afterTopUp = await call(jane, 'POST', '/api/vouchers/ask', {});
    assert(afterTopUp.status === 409 && afterTopUp.body?.code === 'asked_this_week', `20. one ask in 7 days, topped up or not (${show(afterTopUp)})`);

    // A week on: the ask lines moved 8 days back. Jane may ask again; Wil's unanswered ask has lapsed.
    db.prepare("UPDATE known_floor_log SET at = ? WHERE action = 'budget_asked'").run(new Date(Date.now() - 8 * DAY).toISOString());
    chip = await chipNow();
    assert(rowOf(chip, wil)?.askedAt === null, `20. an ask nobody answered lapses after the week`);
    const weekOn = await added(() => call(jane, 'POST', '/api/vouchers/ask', {}));
    assert(weekOn.res.status === 200 && weekOn.kept.length === 3 && logLines('budget_asked', jane).length === 2,
        `20. a week on, Jane may ask again (${show(weekOn.res)})`);
    // Stopping a voucher answers an open ask too.
    const stop = await call(owen, 'DELETE', `/api/names/vouchers/${jane.pk}`);
    const stopKept = keptAll().filter((k) => weekOn.kept.some((w) => w.id === k.id));
    assert(stop.status === 200 && stopKept.every((k) => k.seen_at !== null), `20. a stop takes her open ask off every bell (${show(stop)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
