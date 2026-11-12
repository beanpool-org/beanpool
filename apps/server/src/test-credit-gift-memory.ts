/**
 * A gift of Beans can't wash the credit-risk word, slice C8 (scratch/fable-design/DESIGN-credit-list-amend2-fable.md §2, §4,
 * §9): for core GIFT_DAYS days the five rules built from what someone owes read what they would owe by their own trading,
 * walked back from the stored balance over their own ledger rows. Through the real HTTPS stack and its signature
 * middleware for every answer and every send. Each check says the change that turns it red.
 *
 * 27. Each way Beans reach a member who owes, one at a time, through the writer's own transfer() call: Send Beans and a
 *     parting gift count; a sale released from escrow, a standing period, a paid bill, a deferred wage, a refunded hold
 *     and a grant from the Commons do not. Every fee-free transfer() call site in the server is classified, and so is
 *     every account core calls synthetic.
 * 28. The director's case over HTTP: Sam owes 900 of 1,000 with no sale for 90 days: high. A friend sends 900 through
 *     POST /api/ledger/transfer. The owner's, the voucher's and Sam's own answers: balance 0, owed 0, not paused, high,
 *     the same codes with gift 90000; the voucher's `more` and no admins' reason. The gift's row 31 days old: no owed
 *     reason and no gift; 29 days old: still counted. Sam then takes a 900 Offer and cancels it himself: the hold and
 *     its refund net to nothing, and every sight still reads high with gift 90000 (the deciding review's case).
 * 29. The walk rebuilds, before each row, the stored balance read at that step, for a member taken through every
 *     writer of 27 and a circulation fee.
 * 30. Rob (line 0, balance 0) is sent 100 and spends it; Pia at +50 is sent 1 Bean: levels and reasons as before.
 * 31. After the gift, POST /api/vouch for Sam is accepted (refused before it, below zero); the Vouchers row and a
 *     branch_below reason count only who is below zero now.
 * 32. No sender key or callsign, no timestamp, no row id in any sight's answer; no "90000" in what a member or a
 *     moderator reads; the look lines are as any look's; no notice or push is written by a look.
 * 33. Cost and no Bean moved: a page of 30 where 2 were sent gifts runs one gift statement and 2 walks; a member with
 *     5,000 rows walks only the last 30 days' rows; after the looks every account's balance and fee epoch, the pending
 *     fee queue and the Commons are unchanged; engine/credit-sight.ts calls neither getBalance nor getAccount.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIFT_DAYS, SYNTHETIC_ACCOUNT_IDS, SYNTHETIC_ACCOUNT_PREFIXES, riskReasonSentence } from '@beanpool/core';
import { clearWashTradingCache, setMemberPhoto } from '@beanpool/engine';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, redeemInvite, broadcast, reconcileLedgerFromDb, getCommonsBalanceExact, transfer, payFromCommons, createPost as rawCreatePost } from './state-engine.js';
import { wrapCreatePost } from './post-test-helper.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { registerMemberInternal } from './engine/members.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { GIFT_ROW_SQL, balanceMoveOf, balanceMovesSince, creditPerson, giftRowsWalked, giftStatements, giftWalks, isGiftRow, type LedgerMoveRow } from './engine/credit-sight.js';
import { ledger } from './engine/ledger.js';
import { localFetch } from './keepalive-test-fetch.js';

const createPost = wrapCreatePost(rawCreatePost);
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
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
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
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const storedOf = (pk: string) => Math.trunc(Number((db.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(pk) as { balance_c: number } | undefined)?.balance_c) || 0);

/** `n` live Offers of `who`'s own (setup only). */
function offers(who: Id, n: number): void {
    for (let i = 0; i < n; i++) {
        db.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, active, status) VALUES (?, 'offer', 'general', 'Offer', '', 0, ?, 1, 'active')")
            .run(crypto.randomBytes(8).toString('hex'), who.pk);
    }
}
/** A completed deal (setup only): `buyer` bought from `seller`, `daysAgo`. */
function deal(buyer: string, seller: string, amount_c: number, daysAgo: number): void {
    const post = crypto.randomBytes(8).toString('hex');
    db.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, active, status) VALUES (?, 'offer', 'general', 'Offer', '', ?, ?, 0, 'completed')").run(post, amount_c, seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`).run(crypto.randomBytes(8).toString('hex'), post, buyer, seller, amount_c, iso(daysAgo * DAY), iso(daysAgo * DAY));
}
/** The stored balance set for a fixture, its fee epoch today unless given, and memory read back from it (setup only). */
function storedBalance(pk: string, balance_c: number, epochDaysAgo = 0): void {
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
    db.prepare('UPDATE accounts SET balance_c = ?, last_demurrage_epoch = ? WHERE public_key = ?').run(balance_c, Math.floor(Date.now() / DAY) - epochDaysAgo, pk);
    reconcileLedgerFromDb();
}
/** A line of `line` Beans granted, and 3 live Offers so all of it is usable (setup only). */
function lined(who: Id, line = 1000): void {
    db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(line), who.pk);
    offers(who, 3);
}
const codesOf = (person: any): string[] => (person?.risk?.reasons ?? []).map((r: any) => r.code);
const giftsOf = (person: any): number[] => (person?.risk?.reasons ?? []).filter((r: any) => 'gift' in (r.values ?? {})).map((r: any) => r.values.gift);
/** The five rules built from what someone owes (amendment 2 F14). */
const OWED = ['over', 'paused', 'almost_all_quiet', 'over_half', 'below_zero_quiet'];

// ── Every fee-free transfer() call in the server, classified (test 27) ──────────────────────────────────────────────

/** The top-level arguments of the call that opens at `open` (the index of its "("), with comments dropped. */
function argsAt(src: string, open: number): string[] {
    const out: string[] = [];
    let depth = 0, cur = '', quote: string | null = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i]!;
        if (quote) {
            cur += c;
            if (c === '\\') { cur += src[++i]; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
        if (c === '(' || c === '{' || c === '[') { depth++; if (depth === 1 && c === '(') continue; }
        if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) { out.push(cur.trim()); return out; } }
        if (c === ',' && depth === 1) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    return out;
}
function serverSources(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : serverSources(p);
        return /\.ts$/.test(name) && !/^test-|-test-harness\.ts$|-test-helper\.ts$|test-fetch\.ts$/.test(name) ? [p] : [];
    });
}
/** Every transfer() call that moves Beans with no fee: a method other than 'escrow' (and not a Decision's pay-out), or isFeeExempt true. */
function feeFreeTransferCalls(srcDir: string): string[] {
    const found: string[] = [];
    for (const file of serverSources(srcDir)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/(?<![\w.]|ledger\.)(?:cb\.|hooks\.)?transfer\(/g)) {
            const before = src.slice(Math.max(0, m.index! - 9), m.index!);
            if (/function $|ledger\.$/.test(before)) continue;
            // A comment that names a call is not one.
            const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, m.index!).trim();
            if (line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue;
            const args = argsAt(src, m.index! + m[0].length - 1);
            if (args.length < 3 || args[0]!.startsWith('...')) continue;
            const method = args[4] ?? 'undefined';
            const exempt = (args[5] ?? 'false') === 'true';
            const payOut = /decisionPayOut:\s*true/.test(args[6] ?? '');
            if ((method === "'escrow'" && !exempt) || payOut) continue;
            found.push(`${path.relative(srcDir, file)}: ${args[0]} → ${args[1]}`);
        }
    }
    return found.sort();
}
/**
 * Each fee-free path, and why it is or is not a gift of Beans by isGiftRow's rule (amendment 2 F17). A new one must be
 * added here, with its class, or this test is red: a new fee-free path from a member's own account is a new way to wash.
 */
const FEE_FREE_PATHS: Record<string, string> = {
    'routes/community.ts: from → to': 'GIFT: Send Beans, member to member',
    'engine/member-wizards.ts: cleanPub → recipientPub': 'GIFT: a leaving member\'s parting gift',
    'engine/escrow.ts: h.parties.payer → `escrow_${h.txId}`': 'not to a member: a hold into escrow',
    'engine/escrow.ts: row.buyer_pubkey → `escrow_${row.id}`': 'not to a member: a hold topped up into escrow',
    'engine/escrow.ts: `escrow_${row.id}` → row.buyer_pubkey': 'not a gift: a refund from escrow (synthetic sender)',
    'engine/unfunded-pledges.ts: s.escrow → o.backer': 'not a gift: a pledge back from the project\'s escrow (synthetic sender)',
    'federation-settlement-exchange.ts: from → to': 'not a gift: settlement legs between escrow_ and bridge_ accounts (synthetic)',
    'federation-settlement-exchange.ts: input.buyerPublicKey → escrowAccount': 'not to a member: a cross-community hold into escrow',
};

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
    const names = ['Ada', 'Mo', 'Val', 'Mel', 'Sam', 'Fred', 'Rob', 'Pia', 'Kim', 'Lou', 'Pay', 'Buy', 'Lea', 'Tia', 'Zed'];
    const [ada, mo, val, mel, sam, fred, rob, pia, kim, lou, pay, buy, lea, tia, zed] = names.map(newId) as Id[];
    for (const who of [ada, mo, val, mel, sam, fred, rob, pia, kim, lou, pay, buy, lea, tia, zed]) enter(who!);
    grantNodeRole(ada!.pk, 'admin', owen.pk);
    grantNodeRole(mo!.pk, 'moderator', owen.pk);
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)').run(crypto.randomBytes(16).toString('hex'), val!.pk, entryId, owen.pk);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId, amount_c: hc(500) })).status === 201, 'Val is made a voucher with 500');

    // Fred and Pay hold Beans and have sold once (a send needs a completed trade); Sam has a line of 1,000 and last sold
    // 90 days ago, for a hundredth of a Bean (so it earns no line of its own); Zed is who they sold to.
    for (const who of [fred!, pay!, buy!, lea!]) { deal(zed!.pk, who.pk, hc(200), 100); storedBalance(who.pk, hc(20000)); }
    lined(sam!);
    deal(zed!.pk, sam!.pk, 1, 90);
    storedBalance(sam!.pk, -hc(900));
    clearWashTradingCache(db);

    // ── 28. The director's case ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 28. a friend sends Sam 900 —');
    const looks = async () => ({
        owner: (await call(owen, 'GET', `/api/credit/people/${sam!.pk}`)).body?.person,
        voucher: (await call(val!, 'GET', `/api/credit/people/${sam!.pk}`)).body?.person,
        me: (await call(sam!, 'GET', '/api/credit/me')).body?.me,
    });
    const before = await looks();
    assert(before.owner?.risk?.level === 'high' && before.voucher?.risk?.level === 'high' && before.me?.risk?.level === 'high'
        && JSON.stringify(codesOf(before.owner)) === JSON.stringify(['almost_all_quiet', 'over_half', 'below_zero_quiet']) && giftsOf(before.owner).length === 0,
        `28. before: Sam owes 900 of 1,000, no sale for 90 days: high to the owner, the voucher and Sam (${JSON.stringify(codesOf(before.owner))})`);
    const refusedVouch = await call(owen, 'POST', '/api/vouch', { memberPubkey: sam!.pk, vouchAmount: hc(100) });
    const sent = await call(fred!, 'POST', '/api/ledger/transfer', { from: fred!.pk, to: sam!.pk, amount_c: hc(900), memo: 'for you' });
    require_(sent.status === 200 && sent.body?.transaction?.id, `Fred sends Sam 900 through POST /api/ledger/transfer (${show(sent)})`);
    const giftRow = db.prepare('SELECT id, timestamp, fee_c FROM transactions WHERE id = ?').get(sent.body.transaction.id) as { id: string; timestamp: string; fee_c: number };
    const after = await looks();
    for (const [sight, p] of Object.entries(after)) {
        assert(p?.balance_c === 0 && p?.owed_c === 0 && p?.paused === false && p?.risk?.level === 'high',
            `28. after, ${sight}: balance 0, owed 0, not paused (the stored balance, straight), and still high (red when riskFacts stops passing the figure) (${JSON.stringify({ b: p?.balance_c, level: p?.risk?.level })})`);
    }
    assert(JSON.stringify(codesOf(after.owner)) === JSON.stringify(codesOf(before.owner)) && giftsOf(after.owner).length === 3 && giftsOf(after.owner).every((g) => g === 90000)
        && after.owner.risk.reasons.every((r: any) => r.values.giftDays === GIFT_DAYS),
        `28. the owner reads the same three codes, each with gift 90000 and giftDays ${GIFT_DAYS} (red when the walk misses the send) (${JSON.stringify(after.owner?.risk?.reasons)})`);
    assert(JSON.stringify(codesOf(after.voucher)) === JSON.stringify(['over_half']) && after.voucher.risk.more === true && after.voucher.risk.reasons[0].values.gift === 90000
        && after.voucher.risk.reasons.every((r: any) => r.mark !== 'admins') && JSON.stringify(after.me?.risk) === JSON.stringify(after.voucher?.risk),
        `28. the voucher (and Sam's own answer, the same builder) reads over_half with the gift, more, and no admins' reason (${JSON.stringify(after.voucher?.risk)})`);
    assert(riskReasonSentence(after.voucher.risk.reasons[0]) === 'By their own trading they would owe 900 of 1,000: more than half. A gift of Beans paid 900 of it in the last 30 days.',
        `28. core draws the voucher's reason in its second form: "${riskReasonSentence(after.voucher.risk.reasons[0])}"`);
    // The 30 days: a row 29 days old still counts; 31 days old it is simply their Beans.
    db.prepare('UPDATE transactions SET timestamp = ? WHERE id = ?').run(iso(29 * DAY), giftRow.id);
    const day29 = (await call(owen, 'GET', `/api/credit/people/${sam!.pk}`)).body?.person;
    db.prepare('UPDATE transactions SET timestamp = ? WHERE id = ?').run(iso(31 * DAY), giftRow.id);
    const day31 = await looks();
    db.prepare('UPDATE transactions SET timestamp = ? WHERE id = ?').run(giftRow.timestamp, giftRow.id);
    assert(giftsOf(day29).length === 3 && Object.values(day31).every((p) => codesOf(p).every((c) => !OWED.includes(c)) && giftsOf(p).length === 0),
        `28. the gift's row 29 days back still counts; 31 days back no owed reason and no gift, to every sight (red when GIFT_DAYS moves) (${JSON.stringify(codesOf(day31.owner))})`);
    // The deciding review's case (#3091): Sam takes a 900 Offer and cancels it himself. The hold and its refund are both
    // inside the 30 days, so they net to nothing: a cancelled deal is not his own trading and earns back nothing.
    for (const who of [sam!, zed!]) setMemberPhoto(db, who.pk, 'data:image/png;base64,iVBORw0KGgo='); // the market asks both for a profile photo
    const zedOffer = createPost('offer', 'general', 'Zed\'s table', 'An oak table', hc(900), 'fixed', zed!.pk)!;
    const taken = await call(sam!, 'POST', '/api/marketplace/posts/accept', { postId: zedOffer.id, buyerPublicKey: sam!.pk });
    require_(taken.status === 200 && taken.body?.transaction?.id, `Sam takes Zed's 900 Offer through POST /api/marketplace/posts/accept (${show(taken)})`);
    const dealId = taken.body.transaction.id as string;
    require_(storedOf(sam!.pk) === -hc(900), `the hold took 900 from Sam (stored ${storedOf(sam!.pk)})`);
    const cancelled = await call(sam!, 'POST', '/api/marketplace/transactions/cancel', { transactionId: dealId, cancellerPublicKey: sam!.pk });
    require_(cancelled.status === 200, `Sam cancels it through POST /api/marketplace/transactions/cancel (${show(cancelled)})`);
    const legs = count('SELECT COUNT(*) AS n FROM transactions WHERE (from_pubkey = ? AND to_pubkey = ?) OR (from_pubkey = ? AND to_pubkey = ?)', sam!.pk, `escrow_${dealId}`, `escrow_${dealId}`, sam!.pk);
    const afterCancel = await looks();
    for (const [sight, p] of Object.entries(afterCancel)) {
        assert(legs === 2 && p?.balance_c === 0 && p?.risk?.level === 'high' && giftsOf(p).length > 0 && giftsOf(p).every((g) => g === 90000),
            `28. after Sam takes a 900 Offer and cancels it (${legs} escrow rows), ${sight}: balance 0, still high, gift 90000 (red when a refund earns back what a gift paid) (${JSON.stringify(p?.risk)})`);
    }
    assert(JSON.stringify(codesOf(afterCancel.owner)) === JSON.stringify(codesOf(after.owner)) && JSON.stringify(afterCancel.voucher?.risk) === JSON.stringify(after.voucher?.risk),
        `28. after the cancel the owner reads the same three codes and the voucher the same answer as before it (${JSON.stringify(afterCancel.voucher?.risk)})`);

    // ── 31. The hard rule and the counts read the balance as it is ───────────────────────────────────────────────
    console.log('\n— 31. the vouch and the counts —');
    const vouched = await call(owen, 'POST', '/api/vouch', { memberPubkey: sam!.pk, vouchAmount: hc(100) });
    assert(refusedVouch.status === 409 && refusedVouch.body?.code === 'below_zero' && vouched.status === 200,
        `31. a vouch for Sam: refused below zero before the gift, accepted at 0 after it, as today (red when the hard rule reads the counted figure) (${show(refusedVouch)} | ${show(vouched)})`);
    for (const who of [kim!, lou!]) require_((await call(val!, 'POST', '/api/vouch', { memberPubkey: who.pk, vouchAmount: hc(25) })).status === 200, `Val vouches 25 for ${who.name}`);
    storedBalance(kim!.pk, -hc(20));
    storedBalance(lou!.pk, -hc(20));
    const branchBefore = (await call(owen, 'GET', `/api/credit/people/${val!.pk}`)).body?.person;
    const rowBefore = (await call(owen, 'GET', '/api/credit/people?filter=vouchers')).body?.vouchers?.find((v: any) => v.memberPubkey === val!.pk);
    require_((await call(fred!, 'POST', '/api/ledger/transfer', { from: fred!.pk, to: kim!.pk, amount_c: hc(20) })).status === 200, 'Fred sends Kim 20: she is at 0');
    const branchAfter = (await call(owen, 'GET', `/api/credit/people/${val!.pk}`)).body?.person;
    const rowAfter = (await call(owen, 'GET', '/api/credit/people?filter=vouchers')).body?.vouchers?.find((v: any) => v.memberPubkey === val!.pk);
    const kimNow = (await call(owen, 'GET', `/api/credit/people/${kim!.pk}`)).body?.person;
    assert(codesOf(branchBefore).includes('branch_below') && !codesOf(branchAfter).includes('branch_below') && rowBefore?.belowZero === 2 && rowAfter?.belowZero === 1,
        `31. Val's branch: 2 of 2 below zero, then 1 after a gift lifts Kim to 0, in the reason and the Vouchers row (red when a count reads the counted figure) (${rowBefore?.belowZero} → ${rowAfter?.belowZero})`);
    assert(kimNow?.balance_c === 0 && giftsOf(kimNow).length > 0, `31. while Kim's own word still counts the gift (${JSON.stringify(kimNow?.risk?.reasons)})`);

    // ── 30. A gift can't make anyone's word worse ────────────────────────────────────────────────────────────────
    console.log('\n— 30. a gift never worsens a word —');
    storedBalance(pia!.pk, hc(50));
    const robBefore = (await call(owen, 'GET', `/api/credit/people/${rob!.pk}`)).body?.person;
    const piaBefore = (await call(owen, 'GET', `/api/credit/people/${pia!.pk}`)).body?.person;
    require_((await call(fred!, 'POST', '/api/ledger/transfer', { from: fred!.pk, to: rob!.pk, amount_c: hc(100) })).status === 200, 'Fred sends Rob 100');
    const robHold = `escrow_${crypto.randomBytes(8).toString('hex')}`;
    require_(!!transfer(rob!.pk, robHold, hc(100), 'Rob buys something', 'escrow', true) && !!transfer(robHold, zed!.pk, hc(100), 'Escrow payout', 'escrow', false), 'Rob spends the 100 on a purchase');
    require_((await call(fred!, 'POST', '/api/ledger/transfer', { from: fred!.pk, to: pia!.pk, amount_c: hc(1) })).status === 200, 'Fred sends Pia 1 Bean');
    const robAfter = (await call(owen, 'GET', `/api/credit/people/${rob!.pk}`)).body?.person;
    const piaAfter = (await call(owen, 'GET', `/api/credit/people/${pia!.pk}`)).body?.person;
    assert(robAfter?.balance_c === 0 && robAfter?.line_c === 0 && JSON.stringify(robAfter?.risk) === JSON.stringify(robBefore?.risk)
        && piaAfter?.balance_c === hc(51) && JSON.stringify(piaAfter?.risk) === JSON.stringify(piaBefore?.risk),
        `30. Rob (no line) sent 100 and spending it, Pia at +50 sent 1: level and reasons as before (red when the reading becomes "balance less gifts") (${JSON.stringify([robAfter?.risk, piaAfter?.risk])})`);

    // ── 27. Each way Beans reach a member who owes ───────────────────────────────────────────────────────────────
    console.log('\n— 27. which way in is a gift —');
    const ent = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury) VALUES (?, 'Workshop', 'active', ?, ?, 'fixture', 1)").run(ent, iso(DAY), owen.pk);
    storedBalance(ent, hc(5000));
    /** One member who owes 600 of a line of 1,000, then `pay` brings 600 in one way; the owner's card after. */
    const way = async (label: string, payIn: (to: string) => unknown): Promise<any> => {
        const who = newId(label);
        enter(who);
        lined(who);
        storedBalance(who.pk, -hc(600));
        require_(!!(await payIn(who.pk)), `${label}: 600 reaches them`);
        return { who, card: creditPerson(owen.pk, 'owner', who.pk) };
    };
    const hold = (from: string, amount_c: number) => {
        const e = `escrow_${crypto.randomBytes(8).toString('hex')}`;
        return transfer(from, e, amount_c, 'Escrow hold', 'escrow', true) ? e : null;
    };
    const ways: Array<[string, boolean, (to: string) => unknown]> = [
        // routes/community.ts POST /api/ledger/transfer: undefined method, fee-exempt.
        ['Send Beans', true, async (to) => (await call(fred!, 'POST', '/api/ledger/transfer', { from: fred!.pk, to, amount_c: hc(600) })).status === 200],
        // engine/member-wizards.ts: the offboarding wizard's gift, 'direct', the operator's override.
        ['Parting gift', true, (to) => transfer(lea!.pk, to, hc(600), 'Offboarding gift from Lea', 'direct', false, { signer: owen.pk, offboardOverride: true })],
        // engine/escrow.ts :631 then :1346: the buyer's hold, then the payout from the deal's escrow to the seller.
        ['Sale released', false, (to) => { const e = hold(buy!.pk, hc(600)); return e && transfer(e, to, hc(600), 'Escrow payout for completed post', 'escrow', false); }],
        // engine/escrow.ts :700: a standing deal's period, payer to payee, 'escrow', with the fee.
        ['Standing period', false, (to) => transfer(pay!.pk, to, hc(600), 'Standing deal period', 'escrow', false, { signer: pay!.pk })],
        // engine/bills.ts :439: a paid bill, payer to biller, 'escrow', with the fee.
        ['Paid bill', false, (to) => transfer(pay!.pk, to, hc(600), 'Bill', 'escrow', false, { signer: pay!.pk, payload: 'bill:x' })],
        // state-engine.ts deferred wage: the enterprise to its keeper, 'escrow', with the fee.
        ['Deferred wage', false, (to) => transfer(ent, to, hc(600), 'Deferred wage claim payout for keeper work', 'escrow', false)],
        // engine/escrow.ts :631 then :1656: their own hold of 300 (all their line allows), refunded from the deal's escrow.
        ['Refunded hold', false, (to) => { const e = hold(to, hc(300)); return e && transfer(e, to, hc(300), 'Escrow refund for cancelled post', 'escrow', true); }],
        // A grant from the Commons (payFromCommons; a hardship grant's row is written the same way, from COMMONS_POOL).
        ['Commons grant', false, (to) => payFromCommons(to, hc(600), 'Hardship grant', { allowDeficit: true })],
    ];
    for (const [label, isGift, payIn] of ways) {
        const { who, card } = await way(label, payIn);
        const gifts = giftsOf(card);
        const refunded = label === 'Refunded hold';
        assert(isGift ? gifts.length > 0 && gifts.every((g) => g === hc(600)) && card.balance_c === 0 : gifts.length === 0 && card.balance_c > (refunded ? -hc(601) : -hc(10)),
            `27. ${label}: ${isGift ? 'a gift, the word counts the 600 it paid' : 'not a gift, nothing counted'} (balance ${card.balance_c}, gift ${JSON.stringify(gifts)}) (red when ${isGift ? 'the walk misses it' : 'a fee rule or the synthetic list changes'})`);
        void who;
    }
    // The fee rule each not-a-gift way rests on, at its own call site: payer to payee by 'escrow' carries the fee.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = (f: string) => fs.readFileSync(path.join(here, f), 'utf8');
    assert(src('engine/escrow.ts').includes("cb.transfer(p.parties.payer, p.parties.payee, p.amount_c, p.memo, 'escrow', false, p.auth)")
        && src('engine/bills.ts').includes("hooks.transfer(payer, bill.biller_pubkey, bill.amount_c, billLines.memo(bill.what_for), 'escrow', false,")
        && src('state-engine.ts').includes("transfer(enterprisePubkey, claim.keeper_pubkey, claim.amount_c, memo, 'escrow', false)")
        && /INSERT INTO transactions \(id, from_pubkey, to_pubkey, amount_c, memo, timestamp, auth_signer\)\s*VALUES \(\?, 'COMMONS_POOL', \?, \?, \?, \?, \?\)[\s\S]{0,160}Hardship grant/.test(src('decisions-engine.ts')),
        '27. the standing period, the bill and the wage pay by \'escrow\' with the fee at their own call sites, and a hardship grant is written from COMMONS_POOL (red when a call site changes its fee rule)');
    const feeFree = feeFreeTransferCalls(here);
    const unclassified = feeFree.filter((k) => !(k in FEE_FREE_PATHS));
    const gone = Object.keys(FEE_FREE_PATHS).filter((k) => !feeFree.includes(k));
    assert(feeFree.length >= 8 && unclassified.length === 0 && gone.length === 0,
        `27. every fee-free transfer() call in the server is classified as a gift or not (red when a new fee-free path lands) (new: ${JSON.stringify(unclassified)}; gone: ${JSON.stringify(gone)})`);
    assert(JSON.stringify(SYNTHETIC_ACCOUNT_IDS) === JSON.stringify(['COMMONS_POOL', 'SYSTEM', 'system', 'genesis'])
        && JSON.stringify(SYNTHETIC_ACCOUNT_PREFIXES) === JSON.stringify(['escrow_', 'project_', 'bridge_']),
        '27. every account core calls synthetic is a sender whose Beans are never a gift: the Commons, the system, genesis, escrow, project and bridge accounts (red when one is added without a class)');

    // ── 29. The walk rebuilds the stored balance at every step ───────────────────────────────────────────────────
    console.log('\n— 29. the walk and the stored balance —');
    // Tia starts at +1,000 with her fee last booked 40 days ago: the first move books a circulation fee with its own row.
    storedBalance(tia!.pk, hc(1000), 40);
    lined(tia!);
    const maxRowid = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM transactions').get() as { n: number }).n;
    const steps: Array<{ label: string; cut: number; stored: number }> = [{ label: 'start', cut: maxRowid(), stored: storedOf(tia!.pk) }];
    const step = async (label: string, act: () => unknown) => {
        require_(!!(await act()), `Tia: ${label}`);
        steps.push({ label, cut: maxRowid(), stored: storedOf(tia!.pk) });
    };
    for (const [label, , payIn] of ways) await step(label, () => payIn(tia!.pk));
    await step('her own hold, released to a seller', () => { const e = hold(tia!.pk, hc(300)); return e && transfer(e, zed!.pk, hc(300), 'Escrow payout', 'escrow', false); });
    const feeRows = count("SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey = ? AND to_pubkey = 'COMMONS_POOL' AND fee_c = 0 AND memo LIKE 'Circulation fee%'", tia!.pk);
    const since = new Date(Date.now() - GIFT_DAYS * DAY).toISOString();
    const rows = db.prepare(`SELECT rowid AS rid, from_pubkey, to_pubkey, amount_c, fee_c FROM transactions WHERE (from_pubkey = @pk OR to_pubkey = @pk) AND timestamp >= @since
        ORDER BY timestamp DESC, rowid DESC`).all({ pk: tia!.pk, since }) as Array<LedgerMoveRow & { rid: number }>;
    const walkMoves = balanceMovesSince(tia!.pk, since);
    // Rebuild from the stored balance now, back through the rows: after step i, the stored balance less every later row.
    const rebuilt = steps.map((s) => storedOf(tia!.pk) - rows.filter((r) => r.rid > s.cut).reduce((sum, r) => sum + balanceMoveOf(r, tia!.pk).delta_c, 0));
    const mismatched = steps.map((s, i) => (rebuilt[i] === s.stored ? null : `${s.label}: stored ${s.stored}, rebuilt ${rebuilt[i]}`)).filter(Boolean);
    assert(feeRows >= 1 && steps.length === ways.length + 2 && JSON.stringify(walkMoves) === JSON.stringify(rows.map((r) => balanceMoveOf(r, tia!.pk))) && mismatched.length === 0,
        `29. through ${steps.length - 1} writers and ${feeRows} circulation fee: the walk's rows rebuild the stored balance at every step (red when a writer changes a stored balance without a row) (${JSON.stringify(mismatched)})`);

    // ── 27 (cont.). One rule decides a gift, in both its forms ───────────────────────────────────────────────────
    // Tia's rows by their writer: only Send Beans (Fred) and the parting gift (Lea) are gifts; the walk reads them so.
    const tiaIn = rows.filter((r) => r.to_pubkey === tia!.pk);
    const giftSenders = [...new Set(tiaIn.filter((r) => isGiftRow(r, tia!.pk)).map((r) => r.from_pubkey))].sort();
    const notGifts = tiaIn.filter((r) => !isGiftRow(r, tia!.pk));
    assert(JSON.stringify(giftSenders) === JSON.stringify([fred!.pk, lea!.pk].sort()) && notGifts.length === ways.length - 2
        && notGifts.every((r) => Number(r.fee_c) > 0 || /^(escrow_|COMMONS_POOL$)/.test(r.from_pubkey)),
        `27. of the ${tiaIn.length} ways Beans reached Tia, the gifts are Fred's send and Lea's parting gift; the other ${notGifts.length} carry the fee or come from escrow or the Commons (red when the fee rule leaves isGiftRow)`);
    // The page's statement and isGiftRow give one answer on every row in the ledger, both ways round.
    const everyRow = db.prepare(`SELECT t.from_pubkey, t.to_pubkey, t.amount_c, t.fee_c, (${GIFT_ROW_SQL}) AS sql_gift FROM transactions t`).all() as Array<LedgerMoveRow & { sql_gift: number }>;
    const disagree = everyRow.filter((r) => isGiftRow(r, r.to_pubkey) !== (r.sql_gift === 1));
    assert(everyRow.length >= 20 && everyRow.some((r) => r.sql_gift === 1) && everyRow.some((r) => r.sql_gift === 0 && Number(r.fee_c) > 0) && disagree.length === 0,
        `27. the page's gift statement and isGiftRow agree on all ${everyRow.length} ledger rows (red when one changes without the other) (${JSON.stringify(disagree.slice(0, 3))})`);

    // ── 32. No sender, no date, no row id; the figure only to givers ─────────────────────────────────────────────
    console.log('\n— 32. what the answers never carry —');
    const looksBefore = db.prepare('SELECT * FROM credit_look_log ORDER BY rowid').all();
    const tablesBefore = count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
    const noticeRows = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%notice%' OR name LIKE '%push%')").all() as { name: string }[])
        .map((t) => `${t.name}:${count(`SELECT COUNT(*) AS n FROM "${t.name}"`)}`).join(',');
    const noticesAt = noticeRows();
    const givers = [
        await call(owen, 'GET', `/api/credit/people/${sam!.pk}`), await call(ada!, 'GET', `/api/credit/people/${sam!.pk}`),
        await call(val!, 'GET', `/api/credit/people/${sam!.pk}`), await call(sam!, 'GET', '/api/credit/me'),
        await call(owen, 'GET', '/api/credit/people?q=Sam'), await call(val!, 'GET', '/api/credit/people?q=Sam'),
    ];
    const leaks = (t: string) => [fred!.pk, 'Fred', giftRow.id, giftRow.timestamp, giftRow.timestamp.slice(0, 10), 'for you'].filter((s) => t.includes(s));
    assert(givers.every((r) => r.status === 200 && r.text.includes('90000') && leaks(r.text).length === 0),
        `32. the owner's, the admin's, the voucher's and Sam's own answers carry the figure and no sender key or callsign, no timestamp, no row id, no note (red when someone adds "sent by" or "on") (${JSON.stringify(givers.map((r) => leaks(r.text)))})`);
    const others: string[] = [];
    for (const who of [mel!, mo!]) {
        for (const p of ['/api/credit/people', `/api/credit/people/${sam!.pk}`, '/api/credit/people?q=Sam']) others.push((await call(who, 'GET', p)).text);
        others.push((await call(who, 'GET', `/api/profile/${sam!.pk}`)).text);
        others.push((await call(who, 'POST', '/api/trust/profile', { targetPubkey: sam!.pk })).text);
        others.push((await call(who, 'GET', '/api/credit/me')).text);
    }
    assert(others.length === 12 && others.every((t) => !t.includes('90000') && !t.includes('By their own trading')),
        '32. nothing a member or a moderator reads, from a credit route or the profile routes, holds 90000 (red when the figure leaks past the givers)');
    const looksAfter = db.prepare('SELECT * FROM credit_look_log ORDER BY rowid').all() as Record<string, unknown>[];
    const newLooks = looksAfter.slice(looksBefore.length);
    assert(newLooks.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(['actor_pubkey', 'at', 'day', 'sight', 'subject_pubkey', 'surface', 'updated_at']) && !JSON.stringify(l).includes('90000'))
        && noticeRows() === noticesAt && count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'") === tablesBefore,
        `32. the look lines are as any look's (no figure), and no notice or push row and no table is written by a look (${newLooks.length} new look lines; ${noticesAt})`);

    // ── 33. Cost, and no Bean moved ──────────────────────────────────────────────────────────────────────────────
    console.log('\n— 33. cost —');
    const insertMember = db.prepare("INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, ?, 'fixture')");
    const page: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < 30; i++) {
            const pk = crypto.randomBytes(32).toString('hex');
            insertMember.run(pk, `gp${String(i).padStart(2, '0')}`, iso(DAY), owen.pk);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, ?)').run(pk, Math.floor(Date.now() / DAY));
            page.push(pk);
        }
    })();
    reconcileLedgerFromDb();
    const [heavy, light] = [page[3]!, page[17]!];
    // Heavy: 5,000 rows older than the window (setup only), then two real moves in it.
    const old = db.prepare("INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, fee_c, memo, timestamp) VALUES (?, ?, ?, 100, 0, 'old', ?)");
    db.transaction(() => { for (let i = 0; i < 5000; i++) old.run(crypto.randomUUID(), i % 2 ? heavy : zed!.pk, i % 2 ? zed!.pk : heavy, iso((GIFT_DAYS + 1 + (i % 300)) * DAY)); })();
    require_(!!transfer(fred!.pk, heavy, hc(5), 'a gift', undefined, true) && !!transfer(fred!.pk, light, hc(5), 'a gift', undefined, true), 'Fred sends two of the page 5 Beans each');
    const inWindow = count('SELECT COUNT(*) AS n FROM transactions WHERE (from_pubkey = @a OR to_pubkey = @a OR from_pubkey = @b OR to_pubkey = @b) AND timestamp >= @since',
        { a: heavy, b: light, since: new Date(Date.now() - GIFT_DAYS * DAY).toISOString() });
    const epochs = () => JSON.stringify(ledger.getAllAccounts().map((a) => [a.id, a.balance_c, a.lastDemurrageEpoch]).sort());
    const stored = () => JSON.stringify(db.prepare('SELECT public_key, balance_c, last_demurrage_epoch FROM accounts ORDER BY public_key').all());
    const pending = () => (ledger as any).decayEvents?.length ?? -1;
    const [memBefore, rowsBefore, commonsBefore, pendingBefore, txBefore] = [epochs(), stored(), getCommonsBalanceExact(), pending(), count('SELECT COUNT(*) AS n FROM transactions')];
    const [s0, w0, r0] = [giftStatements(), giftWalks(), giftRowsWalked()];
    const gp = await call(owen, 'GET', '/api/credit/people?q=gp');
    const [s1, w1, r1] = [giftStatements() - s0, giftWalks() - w0, giftRowsWalked() - r0];
    assert(gp.status === 200 && gp.body?.people?.length === 30 && s1 === 1 && w1 === 2,
        `33. a page of 30 where 2 were sent gifts: ${s1} gift statement and ${w1} walks (red when every row walks) (${show(gp)})`);
    assert(count('SELECT COUNT(*) AS n FROM transactions WHERE from_pubkey = ? OR to_pubkey = ?', heavy, heavy) > 5000 && r1 === inWindow && r1 <= 4,
        `33. a member with 5,000 rows walks only the last ${GIFT_DAYS} days' rows: ${r1} rows walked for both (red when the window is dropped from the SQL)`);
    const card = await call(ada!, 'GET', `/api/credit/people/${tia!.pk}`);
    const me = await call(tia!, 'GET', '/api/credit/me');
    assert(card.status === 200 && me.status === 200 && epochs() === memBefore && stored() === rowsBefore && getCommonsBalanceExact() === commonsBefore && pending() === pendingBefore && pending() >= 0
        && count('SELECT COUNT(*) AS n FROM transactions') === txBefore,
        '33. after a page, a card and `me`: every account\'s balance and fee epoch, in memory and stored, the pending fee queue, the Commons and the ledger\'s rows are as before (red when the ledger is read through)');
    const sight = src('engine/credit-sight.ts');
    assert(!/\bgetBalance\s*\(|\bgetAccount\s*\(/.test(sight) && !/import[^;]*\b(getBalance|getAccount)\b[^;]*;/.test(sight) && !/\b(INSERT|UPDATE|DELETE|CREATE)\b/.test(sight.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
        '33. engine/credit-sight.ts calls neither getBalance nor getAccount, imports neither, and writes nothing (red when the ledger is read through)');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
