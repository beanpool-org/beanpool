/**
 * The giver's sight, slice C1 (scratch/fable-design/DESIGN-credit-list-fable.md §8 and its amendment 1 §8): who reads each
 * member's credit, what each answer carries, and the log of looks. Through the real HTTPS stack and its signature
 * middleware for every route and refusal. Each check says the change that turns it red.
 *
 *  3. The sight matrix: member and moderator 403 on people, people/:member and looks; a voucher reads balances, 403 on
 *     looks; a stopped voucher 403 at the next request; a plain admin and an owner the full answer; `me` for any member;
 *     unsigned, a key session and an automation token 401; Beans off 404 everywhere; a standby 409 on every read that
 *     records a look.
 *  4. A balance only to givers: a member at −437.13 reads balance_c −43713 to a voucher, an admin and an owner; nothing a
 *     member or a moderator gets from any credit route, or from the profile routes, holds 43713 or a balance key.
 *  5. The voucher answer for a ring-flagged, disputed member owing 900 of 1,000 with no sale for 90 days: the balance, the
 *     level high, the one giver reason with its figures, `more`; no parts, nobody who stands behind, no freeze, no admins'
 *     reason. The owner's answer has them all. A frozen member: the voucher reads only "can't give".
 *  6. Rob: no credit, 4 live Offers, first under All, in No credit yet and Has Offers; Balance 0. An owner vouches 500:
 *     line 500, usable 500. With no Offer, the same vouch is asleep: usable 0.
 *  7. Looks: a page writes one `list` line per person (actor, subject, sight, day) before the body; the same page again
 *     that day none; the card one `card` line a day; with the insert failing the read answers 500 and no body; a line
 *     366 days old goes on the tidy and by the manifest's age rule; a re-key moves both columns; `me` writes none.
 * 13. The told sentence: the known-rule answer says creditSight on a Beans node and not with Beans off; every answer
 *     that shows a balance carries the core sentence, and the route module imports its constant.
 * 16. Cost: a 1,000-member fixture, the first page of No credit yet works out at most 300 lines (30 here), timed.
 * 17. A look moves no Bean: members at +1,000 last read 60 days ago keep their stored and in-memory balance and fee epoch,
 *     and the Commons its balance, after a page, a card and `me`.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_SIGHT_WORDS, t } from '@beanpool/core';
import { clearWashTradingCache } from '@beanpool/engine';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, redeemInvite, broadcast, reconcileLedgerFromDb, getCommonsBalanceExact } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { registerMemberInternal } from './engine/members.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
import { linesComputed } from './engine/credit-sight.js';
import { pruneOldLooks } from './engine/credit-looks.js';
import { pruneAgedOut } from './engine/plain-tables.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { ledger } from './engine/ledger.js';
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
async function call(id: Id | null, method: 'GET' | 'POST' | 'DELETE', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 240)}` : '-');
const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const hc = (beans: number) => Math.round(beans * 100);
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** A confirmation on a fresh entry, as the names list's confirmMember writes it (setup only). */
function confirm(member: Id, by: Id): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk);
    return entryId;
}
/** `n` live Offers of `who`'s own (setup only). */
function offers(who: Id, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = crypto.randomBytes(8).toString('hex');
        db.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, active, status) VALUES (?, 'offer', 'general', 'Offer', '', 0, ?, 1, 'active')").run(id, who.pk);
        ids.push(id);
    }
    return ids;
}
/** A completed deal (setup only): `buyer` bought `post` from `seller`, `daysAgo`. */
function deal(buyer: Id, seller: Id, amount_c: number, daysAgo: number, extra: { status?: string; resolution?: string } = {}): void {
    const post = offers(seller, 1)[0]!;
    db.prepare('UPDATE posts SET active = 0, status = ? WHERE id = ?').run('completed', post);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, created_at, completed_at, dispute_resolution, dispute_resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomBytes(8).toString('hex'), post, buyer.pk, seller.pk, amount_c, extra.status ?? 'completed',
        iso(daysAgo * DAY), extra.status && extra.status !== 'completed' ? null : iso(daysAgo * DAY), extra.resolution ?? null, extra.resolution ? iso(daysAgo * DAY) : null);
}
/** The stored balance set for a fixture, and the in-memory ledger read back from it (setup only, never a route). */
function storedBalance(who: Id, balance_c: number, epochDaysAgo?: number): void {
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(who.pk);
    if (epochDaysAgo === undefined) db.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(balance_c, who.pk);
    else db.prepare('UPDATE accounts SET balance_c = ?, last_demurrage_epoch = ? WHERE public_key = ?').run(balance_c, Math.floor(Date.now() / DAY) - epochDaysAgo, who.pk);
    reconcileLedgerFromDb();
}
const looksOf = (actor: Id) => db.prepare('SELECT subject_pubkey, surface, sight, day, at FROM credit_look_log WHERE actor_pubkey = ? ORDER BY subject_pubkey, surface').all(actor.pk) as { subject_pubkey: string; surface: string; sight: string; day: string; at: string }[];
const allLooks = () => count('SELECT COUNT(*) AS n FROM credit_look_log');

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
    const [ada, mo, val, mel, rob, deb, ria, wes, fay, ned, pat] = ['Ada', 'Mo', 'Val', 'Mel', 'Rob', 'Deb', 'Ria', 'Wes', 'Fay', 'Ned', 'Pat'].map(newId);
    for (const who of [ada, mo, val, mel, rob, deb, ria, wes, fay, ned, pat]) enter(who);
    grantNodeRole(ada.pk, 'admin', owen.pk);
    grantNodeRole(mo.pk, 'moderator', owen.pk);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(val, owen), amount_c: hc(500) })).status === 201, 'Val is made a voucher with 500');

    // Beans off (as on global), before any trade or vouch: a node whose ledger has moved keeps Beans on.
    const ruleOn = await call(null, 'GET', '/api/community/known-rule');
    setSwitchOverride('beans', false);
    const off = await Promise.all(['/api/credit/people', `/api/credit/people/${deb.pk}`, '/api/credit/looks', '/api/credit/me'].map((p) => call(owen, 'GET', p)));
    const ruleOff = await call(null, 'GET', '/api/community/known-rule');
    setSwitchOverride('beans', true);
    assert(off.every((r) => r.status === 404 && r.body?.code === 'beans_off'), `3. Beans off (as on global): every credit route 404 (${off.map((r) => r.status).join(' ')})`);

    // Rob: no credit, 4 live Offers. Deb: a line of 1,000 granted, 3 Offers, at −437.13. Ria: a line of 1,000, 3 Offers, owes
    // 900, last sold 90 days ago, a wash pair with Wes, and a dispute decided against her as a seller 10 days ago. Fay: frozen.
    offers(rob, 4);
    for (const who of [deb, ria]) { db.prepare('UPDATE members SET earned_credit_c = ? WHERE public_key = ?').run(hc(1000), who.pk); offers(who, 3); }
    storedBalance(deb, -43713);
    deal(ria, wes, hc(300), 90);
    deal(wes, ria, hc(300), 90);
    deal(mel, ria, hc(20), 10, { status: 'cancelled', resolution: 'refund_to_buyer' });
    storedBalance(ria, -90000);
    db.prepare('UPDATE members SET credit_frozen = 1, earned_credit_c = ? WHERE public_key = ?').run(hc(500), fay.pk);
    clearWashTradingCache(db);

    // ── 3. The sight matrix ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 3. who sees —');
    for (const [who, label] of [[mel, 'a member'], [mo, 'a moderator']] as const) {
        const people = await call(who, 'GET', '/api/credit/people');
        const one = await call(who, 'GET', `/api/credit/people/${deb.pk}`);
        const looks = await call(who, 'GET', '/api/credit/looks');
        assert(people.status === 403 && people.body?.code === 'not_a_giver' && one.status === 403 && looks.status === 403,
            `3. ${label}: 403 on people, people/:member and looks (red when giverSight is widened) (${show(people)} | ${show(one)} | ${show(looks)})`);
    }
    const valPeople = await call(val, 'GET', '/api/credit/people');
    const valLooks = await call(val, 'GET', '/api/credit/looks');
    assert(valPeople.status === 200 && valPeople.body?.sight === 'voucher' && valLooks.status === 403 && valLooks.body?.code === 'owners_admins_only',
        `3. a voucher reads the list as a voucher and is refused the looks (red when looks admits a voucher) (${show(valPeople)} | ${show(valLooks)})`);
    const adaPeople = await call(ada, 'GET', '/api/credit/people');
    const owenPeople = await call(owen, 'GET', '/api/credit/people');
    const adaDeb = adaPeople.body?.people?.find((p: any) => p.memberPubkey === deb.pk);
    const owenDeb = owenPeople.body?.people?.find((p: any) => p.memberPubkey === deb.pk);
    assert(adaPeople.body?.sight === 'admin' && !!adaDeb?.parts && !!adaDeb?.standsBehind && owenPeople.body?.sight === 'owner' && !!owenDeb?.parts,
        `3. a plain admin and an owner read the full answer, parts and who stands behind (${show(adaPeople)})`);
    const melMe = await call(mel, 'GET', '/api/credit/me');
    assert(melMe.status === 200 && melMe.body?.me?.memberPubkey === mel.pk && melMe.body?.me?.parts === undefined,
        `3. \`me\` answers any member, their own, the voucher answer (${show(melMe)})`);
    const unsigned = await call(null, 'GET', '/api/credit/people');
    const session = await call(null, 'GET', '/api/credit/people', undefined, ownerSessionHeaders(owen.pk));
    const token = await call(null, 'GET', '/api/credit/people', undefined, ownerTokenHeaders('admin', owen.pk));
    const tokenMe = await call(null, 'GET', '/api/credit/me', undefined, ownerTokenHeaders('read', owen.pk));
    assert(unsigned.status === 401 && session.status === 401 && token.status === 401 && tokenMe.status === 401,
        `3. unsigned, an owner's key session and automation tokens: 401 (red when a route is mounted behind the Settings session) (${show(session)} | ${show(token)})`);

    // ── 4. A balance only to givers ──────────────────────────────────────────────────────────────────────────────
    console.log('\n— 4. a balance only to givers —');
    const valDeb = valPeople.body?.people?.find((p: any) => p.memberPubkey === deb.pk);
    const owenDebCard = await call(owen, 'GET', `/api/credit/people/${deb.pk}`);
    assert(valDeb?.balance_c === -43713 && adaDeb?.balance_c === -43713 && owenDeb?.balance_c === -43713 && owenDebCard.body?.person?.balance_c === -43713,
        `4. Deb at −437.13 reads balance_c −43713 to a voucher, an admin and an owner, list and card (${show(owenDebCard)})`);
    const nonGiverTexts: string[] = [];
    for (const who of [mel, mo]) {
        for (const p of ['/api/credit/people', `/api/credit/people/${deb.pk}`, '/api/credit/looks', '/api/credit/people?filter=no_credit']) nonGiverTexts.push((await call(who, 'GET', p)).text);
        nonGiverTexts.push((await call(who, 'GET', `/api/profile/${deb.pk}`)).text);
        nonGiverTexts.push((await call(who, 'POST', '/api/trust/profile', { targetPubkey: deb.pk })).text);
    }
    assert(nonGiverTexts.length === 12 && nonGiverTexts.every((s) => !s.includes('43713') && !/"[a-z_]*balance[a-z_]*"\s*:/i.test(s)),
        `4. nothing a member or a moderator reads from a credit route or the profile routes holds 43713 or a balance key (red when a balance reaches a non-giver)`);
    const debMe = await call(deb, 'GET', '/api/credit/me');
    assert(debMe.body?.me?.balance_c === -43713, `4. Deb reads her own position in \`me\` (${show(debMe)})`);

    // ── 5. The voucher answer is built without the admins' facts ─────────────────────────────────────────────────
    console.log('\n— 5. the voucher answer —');
    const valRia = (await call(val, 'GET', `/api/credit/people/${ria.pk}`)).body?.person;
    const owenRia = (await call(owen, 'GET', `/api/credit/people/${ria.pk}`)).body?.person;
    const valCodes = (valRia?.risk?.reasons ?? []).map((r: any) => r.code);
    const owenCodes = (owenRia?.risk?.reasons ?? []).map((r: any) => r.code);
    assert(valRia?.balance_c === -90000 && valRia?.owed_c === 90000 && valRia?.line_c === 100000 && valRia?.risk?.level === 'high' && valRia?.risk?.more === true
        && JSON.stringify(valCodes) === JSON.stringify(['over_half']) && valRia.risk.reasons[0].values.owed === 90000 && valRia.risk.reasons[0].values.line === 100000,
        `5. Ria to a voucher: owes 900 of 1,000, level high, the one giver reason with its figures, more (${JSON.stringify(valRia?.risk)})`);
    assert(valRia && !('parts' in valRia) && !('standsBehind' in valRia) && !('frozen' in valRia)
        && (valRia.risk.reasons as any[]).every((r) => r.mark !== 'admins') && !JSON.stringify(valRia).match(/ring|dispute|quiet|frozen/),
        `5. no parts, nobody who stands behind, no freeze, no ring, dispute or no-sale reason in the voucher's answer (red when the trim moves to an app)`);
    assert(['ring', 'almost_all_quiet', 'dispute', 'over_half', 'below_zero_quiet'].every((c) => owenCodes.includes(c)) && owenRia?.risk?.level === 'high' && owenRia?.parts?.granted_c === 100000,
        `5. the owner's answer has every reason and the parts (${JSON.stringify(owenCodes)})`);
    const valFay = (await call(val, 'GET', `/api/credit/people/${fay.pk}`)).body?.person;
    const owenFay = (await call(owen, 'GET', `/api/credit/people/${fay.pk}`)).body?.person;
    assert(valFay?.canGive === false && !('frozen' in valFay) && !JSON.stringify(valFay).includes('frozen') && owenFay?.frozen?.credit === true && owenFay?.canGive === false,
        `5. Fay frozen: the voucher reads only that credit can't be given; the owner reads the freeze (${JSON.stringify(valFay)})`);

    // ── 6. Rob, and the order ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 6. Rob —');
    const first = owenPeople.body?.people?.[0];
    const noCredit = await call(owen, 'GET', '/api/credit/people?filter=no_credit');
    const hasOffers = await call(owen, 'GET', '/api/credit/people?filter=has_offers');
    assert(first?.memberPubkey === rob.pk && first.line_c === 0 && first.liveOffers === 4 && first.balance_c === 0,
        `6. Rob first under All: no credit, 4 live Offers, Balance 0 (red when the order reads the usable line) (${JSON.stringify(first)})`);
    assert(noCredit.body?.people?.some((p: any) => p.memberPubkey === rob.pk) && !noCredit.body?.people?.some((p: any) => p.memberPubkey === deb.pk)
        && JSON.stringify(hasOffers.body?.people?.map((p: any) => p.memberPubkey)) === JSON.stringify([rob.pk]),
        `6. Rob is in No credit yet and alone in Has Offers; Deb, with a line, in neither (${show(hasOffers)})`);
    require_((await call(owen, 'POST', '/api/vouch', { memberPubkey: rob.pk, vouchAmount: hc(500) })).status === 200, 'Owen vouches 500 for Rob');
    require_((await call(owen, 'POST', '/api/vouch', { memberPubkey: ned.pk, vouchAmount: hc(500) })).status === 200, 'Owen vouches 500 for Ned, who has no Offer');
    const robAfter = (await call(owen, 'GET', `/api/credit/people/${rob.pk}`)).body?.person;
    const nedAfter = (await call(owen, 'GET', `/api/credit/people/${ned.pk}`)).body?.person;
    assert(robAfter?.line_c === 50000 && robAfter?.usable_c === 50000 && nedAfter?.line_c === 50000 && nedAfter?.usable_c === 0,
        `6. after 500: Rob's line 500, usable 500; Ned's 500 asleep, usable 0 (red when the sentence reads the limit as usable) (${JSON.stringify({ rob: robAfter?.usable_c, ned: nedAfter?.usable_c })})`);
    const hasOffersAfter = await call(owen, 'GET', '/api/credit/people?filter=has_offers');
    assert(!hasOffersAfter.body?.people?.some((p: any) => p.memberPubkey === rob.pk), `6. Rob, given credit, leaves Has Offers (${show(hasOffersAfter)})`);

    // ── 7. The log of looks ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 7. the looks —');
    const today = new Date().toISOString().slice(0, 10);
    const adaList = looksOf(ada).filter((l) => l.surface === 'list');
    const adaSeen = (adaPeople.body?.people ?? []).map((p: any) => p.memberPubkey).filter((pk: string) => pk !== ada.pk);
    assert(adaList.length === adaSeen.length && adaList.length > 0 && adaList.every((l) => l.sight === 'admin' && l.day === today) && !adaList.some((l) => l.subject_pubkey === ada.pk),
        `7. Ada's page wrote one list line per person she saw, not her own (${adaList.length} lines, ${adaSeen.length} people)`);
    const before = allLooks();
    await call(ada, 'GET', '/api/credit/people');
    assert(allLooks() === before, `7. the same page again that day writes none (red when the key loses the day) (${before} → ${allLooks()})`);
    await call(ada, 'GET', `/api/credit/people/${deb.pk}`);
    await call(ada, 'GET', `/api/credit/people/${deb.pk}`);
    assert(looksOf(ada).filter((l) => l.surface === 'card' && l.subject_pubkey === deb.pk).length === 1, '7. the card writes one card line a day, however often it opens');
    const meBefore = allLooks();
    await call(deb, 'GET', '/api/credit/me');
    assert(allLooks() === meBefore, '7. `me` writes no look');
    // The insert fails: the read answers 500 and no body.
    db.exec("CREATE TEMP TRIGGER credit_look_refused BEFORE INSERT ON credit_look_log BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    const refusedList = await call(owen, 'GET', '/api/credit/people?filter=mine');
    const refusedCard = await call(val, 'GET', `/api/credit/people/${pat.pk}`);
    db.exec('DROP TRIGGER credit_look_refused');
    assert(refusedList.status === 500 && refusedList.body?.people === undefined && !refusedList.text.includes(rob.pk)
        && refusedCard.status === 500 && refusedCard.body?.person === undefined && !refusedCard.text.includes('balance'),
        `7. a look that can't be recorded is not answered: 500, no body (red when the write moves after the answer) (${show(refusedList)} | ${show(refusedCard)})`);
    // 12 months, then the line goes: by the tidy and by the manifest's age rule.
    const insertOld = (actor: string, subject: string, daysAgo: number) => db.prepare('INSERT INTO credit_look_log (actor_pubkey, subject_pubkey, surface, day, sight, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(actor, subject, 'list', iso(daysAgo * DAY).slice(0, 10), 'voucher', iso(daysAgo * DAY));
    insertOld('a'.repeat(64), 'b'.repeat(64), 366);
    insertOld('a'.repeat(64), 'c'.repeat(64), 364);
    const tidied = pruneOldLooks();
    insertOld('a'.repeat(64), 'd'.repeat(64), 400);
    const aged = pruneAgedOut();
    assert(tidied === 1 && aged.credit_look_log === 1 && count("SELECT COUNT(*) AS n FROM credit_look_log WHERE actor_pubkey = ?", 'a'.repeat(64)) === 1
        && count("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'credit_look_log'") === 0,
        `7. lines past 12 months go on the tidy and by the manifest's age rule, with no tombstone; a 364-day line stays (red when the age rule is dropped)`);
    // A re-key moves both columns.
    const [oldKey, newKey, other] = ['e', 'f', '9'].map((c) => c.repeat(64));
    db.prepare("INSERT INTO credit_look_log (actor_pubkey, subject_pubkey, surface, day, sight, at) VALUES (?, ?, 'list', ?, 'owner', ?), (?, ?, 'card', ?, 'voucher', ?)")
        .run(oldKey, other, today, iso(0), other, oldKey, today, iso(0));
    db.transaction(() => moveMemberKeyRows(oldKey, newKey, iso(0), { keepStamps: false }))();
    assert(count('SELECT COUNT(*) AS n FROM credit_look_log WHERE actor_pubkey = ? OR subject_pubkey = ?', oldKey, oldKey) === 0
        && count("SELECT COUNT(*) AS n FROM credit_look_log WHERE (actor_pubkey = ? AND subject_pubkey = ?) OR (actor_pubkey = ? AND subject_pubkey = ?)", newKey, other, other, newKey) === 2,
        '7. a re-key moves the looker and the looked-at to the new key (red when key-move leaves a column)');
    // Who reads the log: grouped, one looker's day, and one member's lookers.
    const groups = await call(owen, 'GET', '/api/credit/looks');
    const adaDay = await call(owen, 'GET', `/api/credit/looks?actor=${ada.pk}&day=${today}`);
    const debLookers = await call(ada, 'GET', `/api/credit/looks?member=${deb.pk}`);
    assert(groups.status === 200 && groups.body?.groups?.some((g: any) => g.actorPubkey === ada.pk && g.people >= adaList.length && g.callsign === 'Ada')
        && adaDay.body?.looks?.length >= adaList.length && debLookers.body?.looks?.some((l: any) => l.actorPubkey === val.pk) && !groups.text.includes('43713'),
        `7. owners and admins read the looks: by looker and day, one day's names, one member's lookers; no figure in it (${show(groups)})`);

    // ── 3 (cont.). A stopped voucher, a standby, Beans off ────────────────────────────────────────────────────────
    console.log('\n— 3. the sight ends —');
    require_((await call(owen, 'DELETE', `/api/names/vouchers/${val.pk}`)).status === 200, 'Owen stops Val vouching');
    const stopped = await call(val, 'GET', '/api/credit/people');
    assert(stopped.status === 403 && stopped.body?.code === 'not_a_giver', `3. a voucher stopped reads nothing at the next request (red when the gate reads a cached role) (${show(stopped)})`);
    setNodeRole('backup');
    const standbyList = await call(owen, 'GET', '/api/credit/people');
    const standbyCard = await call(owen, 'GET', `/api/credit/people/${deb.pk}`);
    const standbyLooks = await call(owen, 'GET', '/api/credit/looks');
    setNodeRole('primary');
    assert(standbyList.status === 409 && standbyList.body?.code === 'standby' && standbyCard.status === 409 && standbyLooks.status === 200,
        `3. a standby answers no look (409) and still reads the log (${show(standbyList)} | ${show(standbyLooks)})`);
    // ── 13. The told sentence ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 13. the told sentence —');
    const told = t(CREDIT_SIGHT_WORDS.told);
    assert(ruleOn.body?.creditSight === true && ruleOff.body?.creditSight === false,
        `13. the known-rule answer says creditSight with Beans on, and not with them off (red when the sentence is dropped while the route answers) (${show(ruleOn)} | ${show(ruleOff)})`);
    assert(owenPeople.body?.told === told && owenDebCard.body?.told === told && melMe.body?.told === told,
        '13. every answer that shows a balance carries the told sentence');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const routeSource = fs.readFileSync(path.join(here, 'routes/credit-sight.ts'), 'utf8');
    assert(/import \{[^}]*\bCREDIT_SIGHT_WORDS\b[^}]*\} from '@beanpool\/core'/.test(routeSource) && routeSource.includes('t(CREDIT_SIGHT_WORDS.told)'),
        '13. the route module imports the sentence\'s constant and answers with it');

    // ── 17. A look moves no Bean ─────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 17. no fee booked —');
    storedBalance(pat, hc(1000), 60);
    storedBalance(mel, hc(1000), 60);
    const epochs = () => JSON.stringify(ledger.getAllAccounts().map((a) => [a.id, a.balance_c, a.lastDemurrageEpoch]).sort());
    const stored = () => JSON.stringify(db.prepare('SELECT public_key, balance_c, last_demurrage_epoch FROM accounts ORDER BY public_key').all());
    const [memBefore, rowsBefore, commonsBefore] = [epochs(), stored(), getCommonsBalanceExact()];
    const patList = await call(owen, 'GET', '/api/credit/people?q=Pat');
    const patCard = await call(ada, 'GET', `/api/credit/people/${pat.pk}`);
    const patMe = await call(pat, 'GET', '/api/credit/me');
    assert(patList.body?.people?.[0]?.balance_c === hc(1000) && patCard.body?.person?.balance_c === hc(1000) && patMe.body?.me?.balance_c === hc(1000),
        `17. Pat reads +1,000 on the list, the card and \`me\` (${show(patCard)})`);
    assert(epochs() === memBefore && stored() === rowsBefore && getCommonsBalanceExact() === commonsBefore,
        '17. every account\'s balance and fee epoch, in memory and stored, and the Commons, are as before (red when the stored read is swapped for getBalance)');

    // ── 16. Cost ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 16. cost —');
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, ?, 'fixture')`);
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)');
    db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
            const pk = crypto.randomBytes(32).toString('hex');
            insertMember.run(pk, `fixture${String(i).padStart(4, '0')}`, iso(i * 60_000), owen.pk);
            insertAccount.run(pk);
        }
    })();
    const lines0 = linesComputed();
    const t0 = performance.now();
    const big = await call(owen, 'GET', '/api/credit/people?filter=no_credit');
    const ms = performance.now() - t0;
    const computedNow = linesComputed() - lines0;
    const lineBytes = Buffer.byteLength(JSON.stringify(db.prepare('SELECT * FROM credit_look_log WHERE actor_pubkey = ? LIMIT 1').get(owen.pk)));
    assert(big.status === 200 && big.body?.people?.length === 30 && computedNow <= 300 && computedNow === 30 && typeof big.body?.next === 'string',
        `16. 1,011 members: the first page of No credit yet worked out ${computedNow} lines (at most 300), in ${ms.toFixed(0)} ms; one look line ~${lineBytes} bytes (red when the filter computes every member)`);
    const second = await call(owen, 'GET', `/api/credit/people?filter=no_credit&after=${encodeURIComponent(big.body?.next ?? '')}`);
    const firstKeys = new Set((big.body?.people ?? []).map((p: any) => p.memberPubkey));
    assert(second.status === 200 && second.body?.people?.length === 30 && second.body.people.every((p: any) => !firstKeys.has(p.memberPubkey)),
        `16. the next page follows on, no person twice (${show(second)})`);
    const bad = await call(owen, 'GET', '/api/credit/people?filter=everyone');
    assert(bad.status === 400 && bad.body?.code === 'bad_filter', `a filter that isn't one is refused (${show(bad)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
