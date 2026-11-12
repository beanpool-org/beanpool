/**
 * A member is told when they have been given credit, or when it changes (Marty, 12 Nov 2026: "we need to let people know
 * when they have been given credit"; engine/credit-notices.ts). Over HTTPS through the real signature middleware and the
 * admin routes, on a fresh local community (the known floor's dial on by default, known floor 1,000 Beans). Each event is
 * checked as exactly one kept notice (moderation_notices, the bell's alert) and one bell row (push_notices, kind
 * community.notice, naming the kept copy) for the member, and none for anyone else:
 *
 *   1. a confirmation with no second admin needed: who confirmed them, "You can now spend up to 1,000 Beans.", and "Your
 *      credit opens when you post an Offer." while they have no live offer; a member with a live offer is not told that
 *   2. two admins to confirm: the first half tells nobody; the second admin's second tells the member, once
 *   3. a work-off confirmation says the work-off (a known floor of 0, Beans above 0 to the Commons), never "spend up to"
 *   4. a revoked confirmation tells the member it gives no credit now and nothing spent is taken back; revoking one still
 *      waiting for a second admin tells nobody
 *   5. an admin's exception on a confirmed member: raised, lowered, frozen, unfrozen, cleared, each one notice with the new
 *      figure and who changed it; a lowering and a freeze say nothing spent is taken back; never a balance
 *   6. silent: the same exception again (a no-op writes nothing), and any exception on a member who isn't confirmed
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-credit-notices)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.EXPO_ACCESS_TOKEN;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { wrapCreatePost } from './post-test-helper.js';
import { initStateEngine, seedGenesisMember, createPost as rawCreatePost } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, seedOwnerForTests } from './admin-auth-test-harness.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { grantNodeRole } from './engine/node-roles.js';
import { setKnownFloorSettings } from './config/known-floor.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const createPost = wrapCreatePost(rawCreatePost);

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const hc = (beans: number) => Math.round(beans * 100);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/** The names list as the admins' phones left it: one key, made by Ada and shared with Ben (fixture rows). */
const KEY_ID = hex(32);
function makeEntry(): string {
    const id = hex(16);
    db.prepare('INSERT INTO names_entries (id, ciphertext, key_id, created_by) VALUES (?, ?, ?, ?)').run(id, 'sealed:' + hex(24), KEY_ID, 'fixture');
    return id;
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = hex(16);
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

interface Kept { id: string; recipient: string; title: string; body: string; data: string }
interface Row { id: string; recipient: string; kind: string; title: string; body: string; data: string }
const keptIds = () => new Set((db.prepare('SELECT id FROM moderation_notices').all() as { id: string }[]).map((r) => r.id));
const rowIds = () => new Set((db.prepare('SELECT id FROM push_notices').all() as { id: string }[]).map((r) => r.id));

/**
 * What `act` told: the kept notices and bell rows it added, all recipients. `told` is the member's one kept notice (with its
 * data read) when exactly one kept notice and one bell row were added, both theirs, the row naming the kept copy; else null.
 */
async function noticesOf(act: () => Promise<Res>): Promise<{ res: Res; kept: Kept[]; rows: Row[] }> {
    const keptBefore = keptIds();
    const rowsBefore = rowIds();
    const res = await act();
    await sleep(80);
    const kept = (db.prepare('SELECT id, recipient, title, body, data FROM moderation_notices').all() as Kept[]).filter((k) => !keptBefore.has(k.id));
    const rows = (db.prepare('SELECT id, recipient, kind, title, body, data FROM push_notices').all() as Row[]).filter((r) => !rowsBefore.has(r.id));
    return { res, kept, rows };
}

/** Exactly one kept notice and one bell row, both for `who`, the row naming the kept copy and carrying its words. */
function toldOnly(label: string, who: Id, out: { res: Res; kept: Kept[]; rows: Row[] }, kind: string): { body: string; data: any } {
    const k = out.kept[0];
    const r = out.rows[0];
    const kData = (() => { try { return JSON.parse(k?.data ?? '{}'); } catch { return {}; } })();
    const rData = (() => { try { return JSON.parse(r?.data ?? '{}'); } catch { return {}; } })();
    assert(out.res.status < 300, `${label}: the change is made (${out.res.status} ${show(out.res.body)})`);
    assert(out.kept.length === 1 && k.recipient === who.pk && kData.kind === kind,
        `${label}: exactly one kept notice, for ${who.name} alone, kind ${kind} (${show(out.kept.map((x) => [x.recipient.slice(0, 6), x.data]))})`);
    assert(out.rows.length === 1 && r.recipient === who.pk && r.kind === 'community.notice' && rData.noticeId === k?.id && r.body === k?.body,
        `${label}: exactly one bell row, ${who.name}'s, a community.notice naming the kept copy, with its words (${show(out.rows.map((x) => [x.recipient.slice(0, 6), x.kind, x.data]))})`);
    return { body: k?.body ?? '', data: kData };
}

function silent(label: string, out: { res: Res; kept: Kept[]; rows: Row[] }): void {
    assert(out.res.status < 300, `${label}: the request is answered (${out.res.status} ${show(out.res.body)})`);
    assert(out.kept.length === 0 && out.rows.length === 0, `${label}: nobody is told (${show({ kept: out.kept.map((k) => k.body), rows: out.rows.map((r) => r.body) })})`);
}

const NOT_TAKEN_BACK = 'Beans you already spent are not taken back.';
const NO_OFFER = 'Your credit opens when you post an Offer.';

async function main(): Promise<void> {
    console.log('Credit notices to the member (engine/credit-notices.ts), over HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const olivePk = seedOwnerForTests('Olive');
    const olive = { pk: olivePk, name: 'Olive' } as Id;
    const ownerSession = ownerSessionHeaders(olivePk);
    const ada = makeMember('Ada');
    const ben = makeMember('Ben');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    grantNodeRole(ben.pk, 'admin', 'SYSTEM');
    db.prepare(`INSERT INTO names_generations (id, n, parent_id, maker, drops, statement, signature) VALUES (?, 1, NULL, ?, '', 'fixture', 'fixture')`).run(KEY_ID, ada.pk);
    db.prepare(`INSERT INTO names_shares (from_pubkey, to_pubkey, head_id, key_ids, trusts, sealed_ring, ring_iv, ring_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
                VALUES (?, ?, ?, ?, '', 'x', 'x', 'x', 'x', 'x', 'x', 'fixture', 'fixture')`).run(ada.pk, ben.pk, KEY_ID, KEY_ID);
    const twoAdmins = (on: boolean) => {
        if (on) db.prepare(`INSERT INTO node_config (key, value) VALUES ('names_two_admins', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'`).run();
        else db.prepare(`DELETE FROM node_config WHERE key = 'names_two_admins'`).run();
    };
    const confirm = (by: Id, member: Id, entryId = makeEntry()) => call('POST', by, '/api/names/confirmations', { memberPubkey: member.pk, entryId });
    const exception = (body: Record<string, unknown>) => call('POST', null, '/api/local/admin/known-floor/exception', body, ownerSession);

    // ── 1. A confirmation that takes effect at once ─────────────────────────────────────────────────────────────────
    const cal = makeMember('Cal');
    const calConfirm = await noticesOf(() => confirm(ada, cal));
    const calTold = toldOnly('Ada confirms Cal (no second admin)', cal, calConfirm, 'credit_confirmed');
    assert(calTold.body === `@Ada confirmed you on the names list. You can now spend up to 1,000 Beans. ${NO_OFFER}`,
        `the words: who confirmed them, the credit it gives (the community's known floor), and the Offer that opens it (${calTold.body})`);
    assert(calTold.data.amount === hc(1000) && calTold.data.by === ada.pk && !('balance' in calTold.data) && !('balance_c' in calTold.data),
        `its data: the member's own known grant and who, never a balance (${show(calTold.data)})`);

    const dee = makeMember('Dee');
    const offer = createPost('offer', 'produce', "Dee's jam", 'Plum jam', hc(5), 'fixed', dee.pk);
    assert(!!offer?.id, `setup: Dee has a live offer (${show(offer?.id)})`);
    const deeTold = toldOnly('Ben confirms Dee, who has a live offer', dee, await noticesOf(() => confirm(ben, dee)), 'credit_confirmed');
    assert(deeTold.body === '@Ben confirmed you on the names list. You can now spend up to 1,000 Beans.',
        `with a live offer there is no "post an Offer" line (${deeTold.body})`);

    // ── 2. Two admins to confirm: told only at the second ───────────────────────────────────────────────────────────
    twoAdmins(true);
    const eve = makeMember('Eve');
    const firstHalf = await noticesOf(() => confirm(ada, eve));
    silent('two admins: Ada confirms Eve, the first half', firstHalf);
    assert(firstHalf.res.body?.status === 'awaiting_second', `setup: Eve's confirmation waits for a second admin (${show(firstHalf.res.body)})`);
    const second = await noticesOf(() => call('POST', ben, `/api/names/confirmations/${firstHalf.res.body?.id}/second`));
    const eveTold = toldOnly('Ben seconds Eve', eve, second, 'credit_confirmed');
    assert(eveTold.body.startsWith('@Ada confirmed you on the names list. You can now spend up to 1,000 Beans.'), `the second tells Eve what the confirmation gives (${eveTold.body})`);

    // ── 4b. A revocation of one still waiting for a second admin: nobody ─────────────────────────────────────────────
    const fay = makeMember('Fay');
    const fayHalf = await confirm(ada, fay);
    assert(fayHalf.body?.status === 'awaiting_second', `setup: Fay's waits for a second admin (${show(fayHalf.body)})`);
    silent("Ben revokes Fay's confirmation before any second", await noticesOf(() => call('POST', ben, `/api/names/confirmations/${fayHalf.body?.id}/revoke`)));
    // A work-off waiting for a second admin: nobody at the first half; the second says the work-off.
    const ivyDebt = hex(16);
    db.prepare(`INSERT INTO names_debts (id, entry_id, amount_c, reason, removed_at) VALUES (?, ?, ?, 'removed', ?)`).run(ivyDebt, makeEntry(), hc(25), ago(10 * DAY));
    const ivy = makeMember('Ivy');
    const ivyHalf = await noticesOf(() => call('POST', ada, `/api/names/debts/${ivyDebt}/work-off`, { memberPubkey: ivy.pk }));
    silent('two admins: Ada confirms Ivy to work off a debt, the first half', ivyHalf);
    const ivyTold = toldOnly('Ben seconds Ivy\'s work-off', ivy, await noticesOf(() => call('POST', ben, `/api/names/confirmations/${ivyHalf.res.body?.id}/second`)), 'credit_confirmed');
    assert(ivyTold.body.startsWith('@Ada confirmed you on the names list to work off the debt') && ivyTold.data.workOff === true && !ivyTold.body.includes('spend up to'),
        `the second of a work-off says the work-off (${ivyTold.body})`);
    twoAdmins(false);

    // ── 3. A work-off confirmation ──────────────────────────────────────────────────────────────────────────────────
    const debtEntry = makeEntry();
    const debtId = hex(16);
    db.prepare(`INSERT INTO names_debts (id, entry_id, amount_c, reason, removed_at) VALUES (?, ?, ?, 'removed', ?)`).run(debtId, debtEntry, hc(40), ago(10 * DAY));
    const gus = makeMember('Gus');
    const gusTold = toldOnly('Ada confirms Gus to work off a debt', gus, await noticesOf(() => call('POST', ada, `/api/names/debts/${debtId}/work-off`, { memberPubkey: gus.pk })), 'credit_confirmed');
    assert(gusTold.body === '@Ada confirmed you on the names list to work off the debt still open on your entry. Until it is paid, your known floor is 0 Beans and every Bean you receive above 0 goes to the Commons.'
        && gusTold.data.workOff === true && gusTold.data.amount === 0,
        `the work-off's words, never "spend up to" (${gusTold.body} ${show(gusTold.data)})`);

    // ── 4. A revocation of a live confirmation ──────────────────────────────────────────────────────────────────────
    const calRow = db.prepare('SELECT id FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(cal.pk) as { id: string };
    const calRevoked = toldOnly("Ben revokes Cal's confirmation", cal, await noticesOf(() => call('POST', ben, `/api/names/confirmations/${calRow.id}/revoke`)), 'credit_confirmation_revoked');
    assert(calRevoked.body === `@Ben revoked your confirmation on the names list, so it gives you no credit now. ${NOT_TAKEN_BACK} If you owe more than your credit now allows, your spending pauses until you are back within it.`,
        `the revoke's words: no credit now, nothing spent taken back (${calRevoked.body})`);

    // ── 5. An admin's exception on a confirmed member ──────────────────────────────────────────────────────────────
    setKnownFloorSettings(olive.pk, { creditCap_c: hc(2000) });
    const raise = toldOnly("Olive raises Dee's known floor to 1,500", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, amount_c: hc(1500) })), 'credit_known_floor');
    assert(raise.body === '@Olive raised your known floor to 1,500 Beans. You can now spend up to 1,500 Beans.' && raise.data.amount === hc(1500) && raise.data.change === 'amount',
        `raised: the new figure and who (${raise.body} ${show(raise.data)})`);
    silent('the same 1,500 again (a no-op)', await noticesOf(() => exception({ memberPubkey: dee.pk, amount_c: hc(1500) })));
    const lower = toldOnly("Olive lowers Dee's known floor to 300", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, amount_c: hc(300) })), 'credit_known_floor');
    assert(lower.body.startsWith('@Olive lowered your known floor to 300 Beans. ') && lower.body.includes(NOT_TAKEN_BACK) && lower.data.amount === hc(300),
        `lowered: the new figure, and nothing spent is taken back (${lower.body})`);
    const freeze = toldOnly("Olive freezes Dee's known floor", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, frozen: true })), 'credit_known_floor');
    assert(freeze.body.startsWith('@Olive froze your known floor, so it gives you no credit for now. ') && freeze.body.includes(NOT_TAKEN_BACK) && freeze.data.amount === 0 && freeze.data.change === 'frozen',
        `frozen: no credit for now, nothing spent taken back (${freeze.body})`);
    silent('a freeze of a frozen floor (a no-op)', await noticesOf(() => exception({ memberPubkey: dee.pk, frozen: true })));
    const thaw = toldOnly("Olive unfreezes Dee's known floor", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, frozen: false })), 'credit_known_floor');
    assert(thaw.body === '@Olive unfroze your known floor. You can now spend up to 300 Beans.' && thaw.data.change === 'unfrozen' && thaw.data.amount === hc(300),
        `unfrozen: back to the kept 300 (${thaw.body})`);
    const back = toldOnly("Olive clears Dee's exception", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, clear: true })), 'credit_known_floor');
    assert(back.body === "@Olive set your known floor back to this community’s, 1,000 Beans. You can now spend up to 1,000 Beans." && back.data.change === 'cleared',
        `cleared: back to the community's 1,000 (${back.body})`);
    silent('a clear with no exception (a no-op)', await noticesOf(() => exception({ memberPubkey: dee.pk, clear: true })));
    // Lower to a figure, then back to the community's: a clear that lowers says nothing spent is taken back.
    await exception({ memberPubkey: dee.pk, amount_c: hc(1800) });
    const backDown = toldOnly("Olive clears Dee's 1,800", dee, await noticesOf(() => exception({ memberPubkey: dee.pk, clear: true })), 'credit_known_floor');
    assert(backDown.body.startsWith("@Olive set your known floor back to this community’s, 1,000 Beans. ") && backDown.body.includes(NOT_TAKEN_BACK),
        `a clear that lowers: nothing spent is taken back (${backDown.body})`);

    // ── 6. An unconfirmed member: an exception changes nothing they can spend ──────────────────────────────────────
    const hal = makeMember('Hal');
    for (const [what, body] of [
        ['raised', { amount_c: hc(1500) }], ['lowered', { amount_c: hc(200) }], ['frozen', { frozen: true }], ['unfrozen', { frozen: false }], ['cleared', { clear: true }],
    ] as const) {
        silent(`Hal, unconfirmed: his exception ${what}`, await noticesOf(() => exception({ memberPubkey: hal.pk, ...body })));
    }
    // Cal was revoked: unconfirmed now, so his exception tells nobody either.
    silent('Cal, revoked: his exception raised', await noticesOf(() => exception({ memberPubkey: cal.pk, amount_c: hc(1500) })));

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
