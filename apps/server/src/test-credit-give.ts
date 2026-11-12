/**
 * Giving from the apps, slice C2 (scratch/fable-design/DESIGN-credit-list-fable.md §6, §8 tests 8 and 9, and its amendment 1
 * §6, §7, §8): POST /api/credit/known-floor (engine/credit-give.ts) and the vouch refused for a frozen member (Q5,
 * engine/vouchers.ts vouchFromProfile). Through the real HTTPS stack and its signature middleware for every route and
 * refusal. Each check says the change that turns it red.
 *
 *  8. The raise: an owner raises Dee 1,000 → 1,500, writing `exception_raised` and Dee's `credit_known_floor` notice (one kept
 *     copy and one bell row, hers alone, asserted by its kind, not rebuilt); a plain admin raises too (Q4: every admin);
 *     a training limit under the community's floor (300) is raised from what the member holds, never back down.
 *     Refused, with nothing written and nobody told: their own 403; at or below what Dee holds now 409; above the cap 400;
 *     a member not confirmed, or waiting for a second admin, 409; the dial off 409; a frozen line or known floor 409 (the
 *     floor stays frozen); a work-off's 0 409 (the work-off keeps it); a voucher, a moderator and a member 403; unsigned, a
 *     key session and a token 401; Beans off 404; a standby 409. No `accounts` row moves, no transaction is written, the
 *     ledger audit sums to zero, and the engine module writes no account, opens no conservingTransaction and keeps no notice
 *     of its own.
 *  9. Q5: a profile vouch for Fay (her whole line frozen) and for Kit (only his known floor frozen), a first vouch and a
 *     raise, a voucher's and an owner's: refused 409 `not_receiving` with exactly the sentence a credit-line gift to them
 *     gets; no hold, no room row, the budget as it was. A vouch for an unfrozen member still lands.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_CAP_DEFAULT, KNOWN_FLOOR_DEFAULT } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, generateInvite, redeemInvite, broadcast, runLedgerAudit, getMemberTrustProfile } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { registerMemberInternal } from './engine/members.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { setKnownFloorException, setKnownFloorSettings } from './config/known-floor.js';
import { budgetOf } from './engine/vouchers.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
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
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A confirmation on a fresh entry, as the names list's confirmMember writes it (setup only). `waiting`: for a second admin. */
function confirm(member: Id, by: Id, waiting = false): string {
    const entryId = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entryId, by.pk, waiting ? 1 : 0);
    return entryId;
}

/** Everything a raise could write or move: the exceptions, the log, the kept notices, the bell rows, the accounts, the ledger. */
const exceptionOf = (who: Id) => db.prepare('SELECT amount_c, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(who.pk) as { amount_c: number | null; frozen: number } | undefined;
const snapshot = () => JSON.stringify({
    exceptions: db.prepare('SELECT member_pubkey, amount_c, frozen, set_by FROM known_floor_exceptions ORDER BY member_pubkey').all(),
    log: count('SELECT COUNT(*) AS n FROM known_floor_log'),
    kept: count('SELECT COUNT(*) AS n FROM moderation_notices'),
    rows: count('SELECT COUNT(*) AS n FROM push_notices'),
});
const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance_c, last_demurrage_epoch FROM accounts ORDER BY public_key').all());
const txCount = () => count('SELECT COUNT(*) AS n FROM transactions');

interface Kept { id: string; recipient: string; body: string; data: string }
interface Row { id: string; recipient: string; kind: string; body: string; data: string }
/** What `act` told: the kept notices and bell rows it added, every recipient. */
async function noticesOf(act: () => Promise<Res>): Promise<{ res: Res; kept: Kept[]; rows: Row[] }> {
    const keptBefore = new Set((db.prepare('SELECT id FROM moderation_notices').all() as { id: string }[]).map((r) => r.id));
    const rowsBefore = new Set((db.prepare('SELECT id FROM push_notices').all() as { id: string }[]).map((r) => r.id));
    const res = await act();
    await sleep(80);
    const kept = (db.prepare('SELECT id, recipient, body, data FROM moderation_notices').all() as Kept[]).filter((k) => !keptBefore.has(k.id));
    const rows = (db.prepare('SELECT id, recipient, kind, body, data FROM push_notices').all() as Row[]).filter((r) => !rowsBefore.has(r.id));
    return { res, kept, rows };
}
const parse = (s: string | undefined) => { try { return JSON.parse(s ?? '{}'); } catch { return {}; } };

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
    const [ada, mo, val, mel, dee, hal, sam, fay, kit, wil, gus, pia, kat] = ['Ada', 'Mo', 'Val', 'Mel', 'Dee', 'Hal', 'Sam', 'Fay', 'Kit', 'Wil', 'Gus', 'Pia', 'Kat'].map(newId);
    for (const who of [ada, mo, val, mel, dee, hal, sam, fay, kit, wil, gus, pia, kat]) enter(who);
    grantNodeRole(ada.pk, 'admin', owen.pk);
    grantNodeRole(mo.pk, 'moderator', owen.pk);
    require_((await call(owen, 'POST', '/api/names/vouchers', { entryId: confirm(val, owen), amount_c: hc(500) })).status === 201, 'Val is made a voucher with 500');
    // Confirmed: Dee, Pia, Fay, Kit, Wil, Kat (and Ada, so her own floor is a real one). Sam waits for a second admin. Hal is not.
    for (const who of [dee, pia, fay, kit, wil, kat, ada]) confirm(who, owen);
    confirm(sam, owen, true);
    const raise = (by: Id, who: Id, beans: number | unknown) => call(by, 'POST', '/api/credit/known-floor', { memberPubkey: who.pk, raiseTo_c: typeof beans === 'number' ? hc(beans) : beans });

    // Q5's fixtures first, while Kit is not frozen: Val vouches 25 for Kit and 25 for Gus (each lands: the positive control).
    const valKit = await call(val, 'POST', '/api/vouch', { memberPubkey: kit.pk, vouchAmount: hc(25) });
    const valGus = await call(val, 'POST', '/api/vouch', { memberPubkey: gus.pk, vouchAmount: hc(25) });
    assert(valKit.status === 200 && valGus.status === 200, `9. a vouch for a member nobody froze still lands (${show(valKit)} | ${show(valGus)})`);
    // Fay: her whole line frozen by an admin. Kit: only his known floor (Settings' writer). Wil: a work-off holds his floor at 0.
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(fay.pk);
    setKnownFloorException(owen.pk, { memberPubkey: kit.pk, frozen: true });
    const workOffAt = '2026-11-01T00:00:00.000Z';
    db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount_c, frozen, set_by, set_at) VALUES (?, 0, 0, ?, ?)`).run(wil.pk, owen.pk, workOffAt);
    db.prepare(`INSERT INTO names_debts (id, entry_id, amount_c, reason, removed_at, status, repaying_pubkey, work_off_floor_before, work_off_floor_set_at)
        VALUES (?, ?, ?, 'removed', ?, 'open', ?, 'default', ?)`).run(crypto.randomBytes(8).toString('hex'), crypto.randomBytes(8).toString('hex'), hc(300), workOffAt, wil.pk, workOffAt);
    // Kat: a training limit of 300 under the community's 1,000, set in Settings.
    setKnownFloorException(owen.pk, { memberPubkey: kat.pk, amount_c: hc(300) });

    const accountsAtStart = accountsNow();
    const txAtStart = txCount();
    const auditAtStart = runLedgerAudit();

    // ── 8. The raise ────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n— 8. the raise —');
    require_(KNOWN_FLOOR_DEFAULT === hc(1000) && CREDIT_CAP_DEFAULT === hc(2000), 'the community runs the default known floor (1,000) and cap (2,000)');
    const logBefore = count('SELECT COUNT(*) AS n FROM known_floor_log');
    const owenDee = await noticesOf(() => raise(owen, dee, 1500));
    assert(owenDee.res.status === 200 && owenDee.res.body?.memberPubkey === dee.pk && owenDee.res.body?.was_c === hc(1000) && owenDee.res.body?.knownFloor_c === hc(1500),
        `8. Owen raises Dee 1,000 → 1,500: 200, was 1,000, now 1,500 (${show(owenDee.res)})`);
    const line = db.prepare("SELECT actor_pubkey, action, old_value, new_value FROM known_floor_log WHERE member_pubkey = ? ORDER BY rowid DESC LIMIT 1").get(dee.pk) as any;
    assert(count('SELECT COUNT(*) AS n FROM known_floor_log') === logBefore + 1 && line?.action === 'exception_raised' && line.actor_pubkey === owen.pk && line.old_value === 'default' && line.new_value === String(hc(1500))
        && exceptionOf(dee)?.amount_c === hc(1500) && exceptionOf(dee)?.frozen === 0,
        `8. one \`exception_raised\` line, Owen's, default → 1,500, and Dee's exception 1,500 (red when the route writes beside Settings' writer) (${JSON.stringify(line)})`);
    const k = owenDee.kept[0];
    const r = owenDee.rows[0];
    assert(owenDee.kept.length === 1 && k.recipient === dee.pk && parse(k.data).kind === 'credit_known_floor' && parse(k.data).amount === hc(1500) && parse(k.data).by === owen.pk
        && owenDee.rows.length === 1 && r.recipient === dee.pk && r.kind === 'community.notice' && parse(r.data).noticeId === k.id && r.body === k.body,
        `8. Dee alone is told, by the lane's \`credit_known_floor\` notice: one kept copy and one bell row naming it (red when the tell is dropped or a second notice is built) (${JSON.stringify({ kept: owenDee.kept.map((x) => [x.recipient.slice(0, 6), x.data]), rows: owenDee.rows.map((x) => [x.recipient.slice(0, 6), x.kind]) })})`);
    const adaDee = await noticesOf(() => raise(ada, dee, 1800));
    assert(adaDee.res.status === 200 && adaDee.res.body?.was_c === hc(1500) && adaDee.res.body?.knownFloor_c === hc(1800) && adaDee.kept.length === 1 && adaDee.kept[0].recipient === dee.pk,
        `8. Ada, a plain admin, raises Dee 1,500 → 1,800, and Dee is told (Q4: every admin; red when the gate needs an owner or the committee) (${show(adaDee.res)})`);

    // Each refusal: its status and code, nothing written, nobody told.
    // `code` null: refused before the handler (the signature middleware answers an unsigned write with its own 401).
    const refused = async (label: string, act: () => Promise<Res>, status: number, code: string | null) => {
        const before = snapshot();
        const out = await noticesOf(act);
        assert(out.res.status === status && (code === null || out.res.body?.code === code) && typeof out.res.body?.error === 'string' && out.res.body.error.length > 0
            && snapshot() === before && out.kept.length === 0 && out.rows.length === 0,
            `${label}: ${status}${code ? ` \`${code}\`` : ''} with the node's sentence, nothing written, nobody told (${show(out.res)})`);
        return out.res;
    };
    await refused('8. Ada raises her own known floor', () => raise(ada, ada, 1500), 403, 'own_floor');
    await refused('8. Owen raises his own known floor', () => raise(owen, owen, 1500), 403, 'own_floor');
    await refused('8. a raise to what Dee holds now (1,800), a repeated tap', () => raise(owen, dee, 1800), 409, 'not_above');
    const lower = await refused('8. a "raise" to 1,200, below what Dee holds (red when the route accepts a lower figure)', () => raise(owen, dee, 1200), 409, 'not_above');
    assert(/1,800/.test(lower.body?.error ?? ''), `8. the refusal says what Dee holds now (${lower.body?.error})`);
    await refused('8. a raise past the cap (2,000.01)', () => raise(owen, dee, 2000.01), 400, 'above_cap');
    await refused('8. Hal, not confirmed', () => raise(owen, hal, 1500), 409, 'not_confirmed');
    await refused('8. Sam, whose confirmation waits for a second admin', () => raise(owen, sam, 1500), 409, 'not_confirmed');
    await refused("8. Fay, her whole credit line frozen", () => raise(owen, fay, 1500), 409, 'frozen');
    await refused("8. Kit, his known floor frozen (red when the frozen check goes: Settings' writer would unfreeze it)", () => raise(owen, kit, 1500), 409, 'frozen');
    assert(exceptionOf(kit)?.frozen === 1, `8. Kit's known floor stays frozen (${JSON.stringify(exceptionOf(kit))})`);
    await refused("8. Wil, working off a debt (red when the work-off's 0 can be raised over from an app)", () => raise(ada, wil, 1500), 409, 'work_off');
    assert(exceptionOf(wil)?.amount_c === 0, `8. the work-off still holds Wil's floor at 0 (${JSON.stringify(exceptionOf(wil))})`);
    await refused('8. Val, a voucher (red when the gate admits a voucher)', () => raise(val, pia, 1500), 403, 'owners_admins_only');
    await refused('8. Mo, a moderator', () => raise(mo, pia, 1500), 403, 'owners_admins_only');
    await refused('8. Mel, a member', () => raise(mel, pia, 1500), 403, 'owners_admins_only');
    await refused('8. no figure', () => call(owen, 'POST', '/api/credit/known-floor', { memberPubkey: pia.pk }), 400, 'bad_body');
    await refused('8. a figure that is not whole hundredths', () => raise(owen, pia, { not: 'a number' }), 400, 'bad_body');
    await refused('8. a figure past the cent', () => call(owen, 'POST', '/api/credit/known-floor', { memberPubkey: pia.pk, raiseTo_c: 150000.5 }), 400, 'bad_body');
    await refused('8. a key that is nobody here', () => call(owen, 'POST', '/api/credit/known-floor', { memberPubkey: newId('Nobody').pk, raiseTo_c: hc(1500) }), 404, 'not_member');
    await refused('8. unsigned', () => call(null, 'POST', '/api/credit/known-floor', { memberPubkey: pia.pk, raiseTo_c: hc(1500) }), 401, null);
    await refused("8. an owner's key session (red when the route is mounted behind the Settings session)", () => call(null, 'POST', '/api/credit/known-floor', { memberPubkey: pia.pk, raiseTo_c: hc(1500) }, ownerSessionHeaders(owen.pk)), 401, null);
    await refused('8. an automation token', () => call(null, 'POST', '/api/credit/known-floor', { memberPubkey: pia.pk, raiseTo_c: hc(1500) }, ownerTokenHeaders('admin', owen.pk)), 401, null);
    setKnownFloorSettings(owen.pk, { confirmation: false });
    await refused('8. the confirmation dial off: a known floor gives nobody anything', () => raise(owen, pia, 1500), 409, 'dial_off');
    setKnownFloorSettings(owen.pk, { confirmation: true });
    setSwitchOverride('beans', false);
    await refused('8. Beans off (as on global)', () => raise(owen, pia, 1500), 404, 'beans_off');
    setSwitchOverride('beans', true);
    setNodeRole('backup');
    await refused('8. a standby', () => raise(owen, pia, 1500), 409, 'standby');
    setNodeRole('primary');
    const piaOk = await raise(owen, pia, 1100);
    assert(piaOk.status === 200 && piaOk.body?.knownFloor_c === hc(1100), `8. after every refusal Pia's raise still lands: the refusals were the rules, not a broken route (${show(piaOk)})`);
    // A training limit under the community's floor (Settings set Kat 300): the app raises it to 800, still under 1,000. What
    // she holds is the 300, so 800 is a raise; Settings' writer labels the line by the community's floor, as it does there.
    const katUp = await noticesOf(() => raise(ada, kat, 800));
    const katLine = db.prepare('SELECT action, old_value, new_value FROM known_floor_log WHERE member_pubkey = ? ORDER BY rowid DESC LIMIT 1').get(kat.pk) as any;
    assert(katUp.res.status === 200 && katUp.res.body?.was_c === hc(300) && katUp.res.body?.knownFloor_c === hc(800) && exceptionOf(kat)?.amount_c === hc(800)
        && katLine?.old_value === String(hc(300)) && katLine?.new_value === String(hc(800)) && katLine?.action === 'exception_lowered'
        && katUp.kept.length === 1 && katUp.kept[0].recipient === kat.pk && /raised your known floor to 800 Beans/.test(katUp.kept[0].body),
        `8. Kat's training limit 300 → 800: a raise from what she holds, the writer's own line (300 → 800, labelled by the community's floor) and "raised" in her notice (${show(katUp.res)} ${JSON.stringify(katLine)})`);
    await refused("8. Kat back down to 500 from the app (red when the route compares with the community's floor, not what she holds)", () => raise(ada, kat, 500), 409, 'not_above');

    // No Bean moved, and the module can't move one.
    assert(accountsNow() === accountsAtStart && txCount() === txAtStart, '8. no `accounts` row moved and no transaction was written (red when a writer touches `accounts`)');
    const audit = runLedgerAudit();
    assert(audit.ok && audit.drift === 0 && audit.sumBalances === auditAtStart.sumBalances, `8. the ledger audit sums to zero (${JSON.stringify(audit)})`);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, 'engine', 'credit-give.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/conservingTransaction|\baccounts\b|getBalance|ledger\.|keepNotice|known_floor_log|\b(INSERT|UPDATE|DELETE)\b/i.test(source) && /setKnownFloorException\(/.test(source),
        '8. engine/credit-give.ts writes through setKnownFloorException alone: no account, no conservingTransaction, no balance read, no log line or notice of its own (the STOP conditions)');

    // ── 9. Q5: a vouch for a frozen member ──────────────────────────────────────────────────────────────────────────
    console.log('\n— 9. a vouch for a frozen member —');
    // The sentence a credit-line gift to each gets: Gus holds Val's 25 and a completed sale's earned credit, so his gift reaches
    // the recipient check (the gift checks the giver first).
    const sold = crypto.randomBytes(8).toString('hex');
    db.prepare("INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, active, status) VALUES (?, 'offer', 'general', 'Offer', '', ?, ?, 0, 'completed')").run(sold, hc(10), gus.pk);
    db.prepare("INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, amount_c, status, completed_at) VALUES (?, ?, ?, ?, ?, 'completed', ?)")
        .run(crypto.randomBytes(8).toString('hex'), sold, mel.pk, gus.pk, hc(10), new Date().toISOString());
    require_(getMemberTrustProfile(gus.pk).earnedCredit > 0, 'Gus has earned credit from a completed sale');
    const giftFay = await call(gus, 'POST', '/api/credit/gift', { memberPubkey: fay.pk, amount_c: hc(1) });
    const giftKit = await call(gus, 'POST', '/api/credit/gift', { memberPubkey: kit.pk, amount_c: hc(1) });
    require_(giftFay.status === 409 && giftFay.body?.code === 'not_receiving' && giftKit.status === 409 && giftKit.body?.code === 'not_receiving',
        `a gift to Fay and to Kit is refused as not receiving (${show(giftFay)} | ${show(giftKit)})`);
    const holds = () => count('SELECT COUNT(*) AS n FROM voucher_allocations');
    const roomTo = (who: Id) => count('SELECT COUNT(*) AS n FROM room_gifts WHERE to_pubkey = ?', who.pk);
    const before = { holds: holds(), fay: roomTo(fay), kit: roomTo(kit), valLeft: budgetOf(val.pk).left, accounts: accountsNow() };
    const cases: Array<[string, Id, Id, Record<string, unknown>, Res]> = [
        ["Val's first vouch for Fay", val, fay, { vouchAmount: hc(25) }, giftFay],
        ["Val's raise of his vouch for Kit to 50", val, kit, { raiseTo: hc(50) }, giftKit],
        ["Owen's owner vouch of 500 for Fay", owen, fay, { vouchAmount: hc(500) }, giftFay],
        ["Owen's owner vouch of 100 for Kit", owen, kit, { vouchAmount: hc(100) }, giftKit],
    ];
    for (const [label, by, who, body, gift] of cases) {
        const res = await call(by, 'POST', '/api/vouch', { memberPubkey: who.pk, ...body });
        assert(res.status === 409 && res.body?.code === 'not_receiving' && res.body?.error === gift.body?.error,
            `9. ${label}: 409 \`not_receiving\`, word for word the gift's sentence (red when the recipient check goes, or its sentence differs from the gift's) (${show(res)})`);
    }
    assert(holds() === before.holds && roomTo(fay) === before.fay && roomTo(kit) === before.kit && budgetOf(val.pk).left === before.valLeft && accountsNow() === before.accounts,
        `9. no hold, no room row, Val's budget as it was (${budgetOf(val.pk).left}), no Bean moved`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
