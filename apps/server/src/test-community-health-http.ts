/**
 * The Community health panel and the consent at joining (community modes slice 6, engine/community-health.ts) over
 * HTTPS, through the real middleware:
 *
 *   1. the totals: every owner and admin reads them (credit, debt, in debit, the Commons pot, this month's trades); a
 *      member, an unsigned request and a key that isn't a member's are refused
 *   2. the dial off: no exceptions at all (409 not_known), and nothing logged
 *   3. the dial on: only a confirmed member who consented is an exception: past the debt line (50% of their floor), or in
 *      debit with no sale for 60 days; an unconfirmed member who consented, a confirmed one who didn't, a revoked one and a
 *      new one are not; the open debts of members who left are listed; no callsign or name on the wire
 *   4. the owner sets the two lines (an admin can't); each change is a line in the known floor's log; the consent text
 *      follows them, and a member's consent to the old text is still theirs but a new consent needs the new one
 *   5. every opening of the exceptions writes a line; every admin and the owner reads the log; a member can't
 *   6b. a tightened line reaches only a member who agreed to it: each is seen within the less intrusive of their lines and now
 *   7. Settings (the manager): every owner and admin reads the totals, the lines and the access log; only an owner moves the
 *      lines; the exceptions are not in it (they open on an admin's phone, where the names are)
 *   6. the consent: the terms are public before joining; a member consents to the version they were shown; a stale
 *      version, a guest and an unsigned request are refused
 *   8b. a vote on removing a member: its balance and debt reach only those who can vote in it, through the admin
 *      Decisions list too; an admin or the owner who can't vote in it gets the Decision without them (balanceHidden)
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-community-health-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'HealthPanel123!';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, createPost, getBalance, injectSystemMessage, createDecision } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, ownerTokenHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { getNodeRole, setNodeRole } from './config/node-role.js';
import { setMemberPhoto, clearEnterpriseFloorCache } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; text: string };
const show = (r: Res) => `${r.status} ${r.text.slice(0, 200)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(200 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/** Confirmed against a fresh entry id, `daysAgo` days ago. Returns the entry id. */
function confirm(member: Id, by: Id, daysAgo = 120): string {
    const entry = crypto.randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, confirmed_at, needs_second) VALUES (?, ?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, entry, by.pk, ago(daysAgo * DAY));
    clearEnterpriseFloorCache(db);
    return entry;
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text };
}

const logRows = () => (db.prepare('SELECT COUNT(*) AS n FROM health_access_log').get() as { n: number }).n;

async function main(): Promise<void> {
    console.log('The Community health panel over HTTPS\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    grantNodeRole(founder.pk, 'owner', 'SYSTEM');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const bea = makeMember('Bea');
    grantNodeRole(bea.pk, 'admin', 'SYSTEM');
    const sam = makeMember('Samwise');    // sells; never in debit
    const kim = makeMember('Kimberly');   // confirmed, consents, 600 in debit: past the line
    const una = makeMember('Unaleigh');   // confirmed, never consents, 600 in debit
    const lea = makeMember('Leander');    // confirmed long ago, consents, 100 in debit, no sale: quiet
    const neo = makeMember('Neopolis');   // confirmed yesterday, consents, 100 in debit: too new to be quiet
    const ugo = makeMember('Ugolino');    // unconfirmed, consents, 600 in debit
    const rex = makeMember('Rexford');    // confirmed then revoked, consents, 600 in debit
    for (const m of [kim, una, lea, neo, ugo, rex]) createPost('offer', 'produce', `${m.name} mends things`, 'Repairs', 10, 'fixed', m.pk);
    const kimEntry = confirm(kim, ada);
    confirm(una, ada);
    const leaEntry = confirm(lea, ada);
    confirm(neo, ada, 1);
    confirm(rex, ada);
    // A member who left owing 300: the open record on their entry (engine/names-debts.ts).
    const goneEntry = crypto.randomBytes(16).toString('hex');
    db.prepare("INSERT INTO names_debts (id, entry_id, amount, reason, removed_at) VALUES (?, ?, 300, 'removed', ?)").run('debt-gone', goneEntry, ago(10 * DAY));
    const owner = ownerSessionHeaders();
    const health = (who: Id | null) => call('GET', who, '/api/names/health');
    const exceptions = (who: Id | null) => call('GET', who, '/api/names/health/exceptions');

    // ── 1. the totals ─────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the totals ──');
    transfer('genesis', sam.pk, 50, 'seed Samwise', 'direct', true);
    const t0 = await health(ada);
    assert(t0.status === 200 && t0.body?.totals?.sumOfCredit >= 50 && typeof t0.body?.totals?.commonsPot === 'number'
        && t0.body?.totals?.tradesThisMonth === 0 && t0.body?.known === false,
        `an admin reads the totals; the dial is off, so this is no known community (${show(t0)})`);
    const t0o = await health(founder);
    assert(t0o.status === 200 && t0o.body?.totals?.accounts === t0.body?.totals?.accounts, `and the owner reads them too (${show(t0o)})`);
    const t0m = await health(sam);
    assert(t0m.status === 403 && t0m.body?.code === 'admins_only', `a member is refused (${show(t0m)})`);
    const t0u = await health(null);
    assert(t0u.status === 401, `an unsigned request is refused (${show(t0u)})`);
    const t0g = await health(keypair('Stranger'));
    assert(t0g.status === 403, `a key that isn't a member's is refused (${show(t0g)})`);
    const t0p = await call('GET', null, '/api/names/health', undefined, owner);
    assert(t0p.status === 401, `the node password alone opens no panel: it is signed with an admin's own key (${show(t0p)})`);

    // ── 2. the dial off ───────────────────────────────────────────────────────────────────────────
    console.log('── 2. the dial off ──');
    const off = await exceptions(ada);
    assert(off.status === 409 && off.body?.code === 'not_known', `no exceptions while the community doesn't confirm members (${show(off)})`);
    assert(logRows() === 0, 'and nothing is logged');

    // ── 3. the dial on ────────────────────────────────────────────────────────────────────────────
    console.log('── 3. the dial on ──');
    const dial = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(dial.status === 200 && dial.body?.confirmation === true, `the owner turns the dial on (${show(dial)})`);
    // Each buys from Samwise through the marketplace, on their known floor; Ugolino and Rexford lose their confirmation after.
    const ugoConf = confirm(ugo, ada);
    for (const [m, beans] of [[kim, 600], [una, 600], [ugo, 600], [rex, 600], [lea, 100], [neo, 100]] as Array<[Id, number]>) {
        const post = createPost('offer', 'produce', `Samwise's ${beans}-Bean basket for ${m.name}`, 'Veg', beans, 'fixed', sam.pk)!;
        const buy = await call('POST', m, '/api/marketplace/posts/accept', { postId: post.id, buyerPublicKey: m.pk });
        assert(buy.status === 200 && getBalance(m.pk).balance === -beans, `${m.name} buys a ${beans}-Bean basket (${show(buy)})`);
    }
    db.prepare('DELETE FROM confirmations WHERE entry_id = ?').run(ugoConf);
    db.prepare('UPDATE confirmations SET revoked_at = ?, revoked_by = ? WHERE member_pubkey = ?').run(ago(DAY), ada.pk, rex.pk);
    assert(getBalance(kim.pk).balance === -600 && getBalance(kim.pk).floor !== 0, `Kimberly is 600 in debit with a known floor (${JSON.stringify(getBalance(kim.pk)).slice(0, 120)})`);
    const terms = await call('GET', null, '/api/community/consent-terms');
    assert(terms.status === 200 && terms.body?.known === true && /50%/.test(terms.body?.text) && /60 days/.test(terms.body?.text) && /any admin can see some of your trades: /.test(terms.body?.text) && /Every look at one of those trades is logged/.test(terms.body?.text) && /a look at the alerts that name you is logged the first time each admin opens them, and again at that admin's first look after 24 hours/.test(terms.body?.text),
        `the join screen's text, before joining, from the two settings (${show(terms)})`);
    for (const m of [kim, lea, neo, ugo, rex]) {
        const c = await call('POST', m, '/api/names/consent', { version: terms.body.version });
        assert(c.status === 200 && c.body?.consentedVersion === terms.body.version, `${m.name} consents (${show(c)})`);
    }
    const none = await exceptions(sam);
    assert(none.status === 403, `a member can't open the exceptions (${show(none)})`);
    assert(logRows() === 0, 'and a refused opening is no line');
    const ex = await exceptions(ada);
    const byKey = new Map<string, any>((ex.body?.exceptions ?? []).map((e: any) => [e.memberPubkey, e]));
    assert(ex.status === 200 && byKey.get(kim.pk)?.reasons?.includes('past_debt_line') && byKey.get(kim.pk)?.entryId === kimEntry,
        `Kimberly, confirmed and consenting, 600 past half her floor, is listed by key and entry id (${show(ex)})`);
    assert(byKey.get(lea.pk)?.reasons?.join() === 'quiet_in_debit' && byKey.get(lea.pk)?.entryId === leaEntry,
        'Leander, 100 in debit with no sale in 60 days, is listed as quiet');
    assert((ex.body?.exceptions ?? []).every((e: any) => Object.keys(e).sort().join() === 'balance,entryId,floor,memberPubkey,reasons'),
        `an exception says only which line was crossed: no trade fact (a last sale) on the wire (${show(ex)})`);
    assert(!byKey.has(una.pk), 'Unaleigh, confirmed but never consenting, is not listed');
    assert(!byKey.has(ugo.pk), 'Ugolino, consenting but never confirmed, is not listed');
    assert(!byKey.has(rex.pk), 'Rexford, whose confirmation was revoked, is not listed');
    assert(!byKey.has(neo.pk), 'Neopolis, confirmed yesterday, is not yet quiet');
    assert(!byKey.has(sam.pk), 'Samwise, in credit, is not listed');
    assert((ex.body?.departed ?? []).some((d: any) => d.id === 'debt-gone' && d.entryId === goneEntry && d.amount === 300),
        'the open debt of a member who left is listed by entry id');
    const names = [kim, una, lea, neo, ugo, rex, sam, ada].map(m => m.name);
    assert(!names.some(n => ex.text.includes(n)), 'no callsign or name of anyone is on the wire');
    assert(!/callsign|name"/i.test(ex.text), 'nor a field that could carry one');

    // ── 4. the owner's two lines ──────────────────────────────────────────────────────────────────
    console.log('── 4. the two lines ──');
    const byAdmin = await call('POST', ada, '/api/names/health/settings', { debtLinePct: 90 });
    assert(byAdmin.status === 403 && byAdmin.body?.code === 'owner_only', `an admin can't move the lines (${show(byAdmin)})`);
    const bad = await call('POST', founder, '/api/names/health/settings', { debtLinePct: 90, quietDays: 3 });
    assert(bad.status === 400 && bad.body?.code === 'bad_quiet_days', `3 days is refused, and nothing is written (${show(bad)})`);
    assert((db.prepare("SELECT COUNT(*) AS n FROM node_config WHERE key LIKE 'health_%'").get() as any).n === 0, 'the debt line is unchanged');
    const set = await call('POST', founder, '/api/names/health/settings', { debtLinePct: 90, quietDays: 30 });
    assert(set.status === 200 && set.body?.debtLinePct === 90 && set.body?.quietDays === 30, `the owner sets 90% and 30 days (${show(set)})`);
    const lines = db.prepare("SELECT action, old_value, new_value, actor_pubkey FROM known_floor_log WHERE action LIKE 'health_%' ORDER BY action").all() as any[];
    assert(lines.length === 2 && lines[0].action === 'health_debt_line' && lines[0].old_value === '50' && lines[0].new_value === '90'
        && lines[1].action === 'health_quiet_days' && lines.every(l => l.actor_pubkey === founder.pk),
        `each change is a line in the known floor's log, with the owner's key (${JSON.stringify(lines)})`);
    const ex2 = await exceptions(bea);
    const by2 = new Map<string, any>((ex2.body?.exceptions ?? []).map((e: any) => [e.memberPubkey, e]));
    assert(ex2.status === 200 && by2.get(kim.pk)?.reasons?.join() === 'quiet_in_debit' && by2.get(lea.pk)?.reasons?.join() === 'quiet_in_debit',
        `at 90%, Kimberly's 600 is past no line, only quiet (no sale in 30 days); Leander stays quiet (${show(ex2)})`);
    const terms2 = await call('GET', null, '/api/community/consent-terms');
    assert(/90%/.test(terms2.body?.text) && /30 days/.test(terms2.body?.text) && terms2.body?.version !== terms.body.version,
        `the consent text follows the lines, with a new version (${show(terms2)})`);
    const stale = await call('POST', una, '/api/names/consent', { version: terms.body.version });
    assert(stale.status === 409 && stale.body?.code === 'stale_text', `consenting to the old text is refused (${show(stale)})`);

    // ── 5. the access log ─────────────────────────────────────────────────────────────────────────
    console.log('── 5. the access log ──');
    assert(logRows() === 2, `two openings, two lines (${logRows()})`);
    const logA = await call('GET', ada, '/api/names/health/log');
    const logO = await call('GET', founder, '/api/names/health/log');
    assert(logA.status === 200 && logA.body?.log?.length === 2 && logA.body.log[0].actor === bea.pk && logA.body.log[1].actor === ada.pk
        && logA.body.log.every((l: any) => l.action === 'exceptions_opened' && l.at),
        `an admin reads who opened them and when, newest first (${show(logA)})`);
    assert(logO.status === 200 && logO.body?.log?.length === 2, `and the owner reads it (${show(logO)})`);
    const logM = await call('GET', kim, '/api/names/health/log');
    assert(logM.status === 403, `a member can't (${show(logM)})`);
    const exportTry = await call('GET', ada, '/api/names/health/exceptions?format=csv');
    assert(exportTry.status === 200 && !/text\/csv/.test(exportTry.text) && typeof exportTry.body === 'object', 'there is no CSV of balances: the same JSON answer, and it is logged');
    assert(logRows() === 3, 'that opening is a line too');

    // ── 6. the consent ────────────────────────────────────────────────────────────────────────────
    console.log('── 6. the consent ──');
    const mine = await call('GET', una, '/api/names/consent');
    assert(mine.status === 200 && mine.body?.confirmed === true && mine.body?.consentedAt === null && mine.body?.known === true,
        `a member who joined before the consent existed sees they haven't consented, and is offered it (${show(mine)})`);
    const now = await call('POST', una, '/api/names/consent', { version: terms2.body.version });
    assert(now.status === 200 && typeof now.body?.consentedAt === 'string', `Unaleigh consents to the current text (${show(now)})`);
    const ex3 = await exceptions(ada);
    assert((ex3.body?.exceptions ?? []).some((e: any) => e.memberPubkey === una.pk), 'and from then she can be an exception (600 in debit, no sale in 30 days)');
    const guest = await call('POST', keypair('Guest'), '/api/names/consent', { version: terms2.body.version });
    assert(guest.status === 403, `a key that isn't a member's can't consent (${show(guest)})`);
    const unsigned = await call('POST', null, '/api/names/consent', { version: terms2.body.version });
    assert(unsigned.status === 401, `nor can an unsigned request (${show(unsigned)})`);
    const row = db.prepare('SELECT version, consented_at FROM known_consents WHERE member_pubkey = ?').get(una.pk) as any;
    assert(row?.version === terms2.body.version && !!row?.consented_at, 'the consent row: the text version and when');

    // ── 6b. tightened lines reach only who agreed to them ────────────────────────────────────────
    const tight = await call('POST', founder, '/api/names/health/settings', { debtLinePct: 5, quietDays: 7 });
    assert(tight.status === 200 && tight.body?.debtLinePct === 5, `the owner tightens the line to 5% (${show(tight)})`);
    const ex4 = await exceptions(ada);
    const lea4 = (ex4.body?.exceptions ?? []).find((e: any) => e.memberPubkey === lea.pk);
    assert(lea4?.reasons?.join() === 'quiet_in_debit',
        `Leander agreed to 50%: his 100 of 1,000 is still no past-the-line exception at 5%, only quiet (${JSON.stringify(lea4)})`);
    const neo4 = (ex4.body?.exceptions ?? []).find((e: any) => e.memberPubkey === neo.pk);
    assert(!neo4, 'Neopolis, who agreed to 60 days, is not quiet after 7 days in debit');
    // Two wordings: Leander's row says he agreed to another text (wording 0) with the same lines. What he agreed to is
    // what that text said, not today's, so he is in no exception until he agrees to today's wording.
    const leaRow = db.prepare('SELECT version FROM known_consents WHERE member_pubkey = ?').get(lea.pk) as { version: string };
    const [wordingNow, ...leaLines] = leaRow.version.split(':');
    assert(wordingNow === '6', `he agreed to wording 6, so the one before is wording 5, the text that said "Every look at your balance is logged" (${leaRow.version})`);
    db.prepare('UPDATE known_consents SET version = ? WHERE member_pubkey = ?').run([Number(wordingNow) - 1, ...leaLines].join(':'), lea.pk);
    const ex5 = await exceptions(ada);
    const leaMine = await call('GET', lea, '/api/names/consent');
    assert(leaMine.status === 200 && leaMine.body?.consentedVersion === [Number(wordingNow) - 1, ...leaLines].join(':') && String(leaMine.body?.version).startsWith(`${wordingNow}:`),
        `his app reads that he agreed to wording ${Number(wordingNow) - 1}, not today's, so it asks him again (${show(leaMine)})`);
    assert(ex5.status === 200 && !(ex5.body?.exceptions ?? []).some((e: any) => e.memberPubkey === lea.pk),
        `Leander, who agreed to wording ${Number(wordingNow) - 1} and not today's ${wordingNow}, is not listed (${show(ex5)})`);
    db.prepare('UPDATE known_consents SET version = ? WHERE member_pubkey = ?').run(leaRow.version, lea.pk);
    const ex6 = await exceptions(ada);
    assert((ex6.body?.exceptions ?? []).some((e: any) => e.memberPubkey === lea.pk), 'with his consent to today\'s wording, he is listed again');

    // ── 6c. withdrawing consent: as easy as giving it, and at once ─────────────────────────────────
    console.log('── 6c. withdrawing ──');
    const listed = async () => new Set(((await exceptions(ada)).body?.exceptions ?? []).map((e: any) => e.memberPubkey));
    assert((await listed()).has(kim.pk), 'Kimberly, who consented, is listed before she withdraws');
    const withdrew = await call('POST', kim, '/api/names/consent', { withdraw: true });
    assert(withdrew.status === 200 && withdrew.body?.consentedAt === null && withdrew.body?.consentedVersion === null && typeof withdrew.body?.withdrawnAt === 'string',
        `Kimberly withdraws her consent with one signed request (${show(withdrew)})`);
    assert(!(await listed()).has(kim.pk), 'and from that moment she is in no exception');
    const mineOff = await call('GET', kim, '/api/names/consent');
    assert(mineOff.status === 200 && mineOff.body?.consentedAt === null && typeof mineOff.body?.withdrawnAt === 'string',
        `her Settings reads that she withdrew, and when (${show(mineOff)})`);
    const del = await call('DELETE', lea, '/api/names/consent');
    assert(del.status === 200 && del.body?.consentedAt === null, `DELETE withdraws too (Leander) (${show(del)})`);
    assert(!(await listed()).has(lea.pk), 'and Leander is out at once');
    const history = db.prepare('SELECT action, version FROM known_consent_log WHERE member_pubkey = ? ORDER BY at, rowid').all(kim.pk) as any[];
    assert(history.map(h => h.action).join() === 'agreed,withdrawn' && history[0].version === terms.body.version,
        `the withdrawal is kept in the consent history, after the agreement (${JSON.stringify(history)})`);
    const termsNow = await call('GET', null, '/api/community/consent-terms');
    assert(/take this back at any time/.test(termsNow.body?.text ?? ''), `the text a member agrees to says they can take it back (${show(termsNow)})`);
    const again = await call('POST', kim, '/api/names/consent', { version: termsNow.body.version });
    assert(again.status === 200 && again.body?.consentedVersion === termsNow.body.version && again.body?.withdrawnAt === null,
        `Kimberly can consent again (${show(again)})`);
    assert((await listed()).has(kim.pk), 'and she is listed again');
    assert((db.prepare('SELECT COUNT(*) AS n FROM known_consent_log WHERE member_pubkey = ?').get(kim.pk) as any).n === 3,
        'the history keeps all three: agreed, withdrawn, agreed');
    const guestOff = await call('POST', null, '/api/names/consent', { withdraw: true });
    assert(guestOff.status === 401, `an unsigned withdrawal is refused (${show(guestOff)})`);

    // ── 7. Settings (the manager) ────────────────────────────────────────────────────────────────
    console.log('── 7. Settings ──');
    const { handshakeToken } = mintHandshakeToken(ada.pk, 'admin');
    const s = consumeHandshakeToken(handshakeToken);
    const adaSession = { 'X-Admin-Session': s.sessionId! };
    const mgr = await call('GET', null, '/api/local/admin/community-health', undefined, adaSession);
    assert(mgr.status === 200 && mgr.body?.totals?.membersInDebit >= 6 && mgr.body?.settings?.debtLinePct === 5 && mgr.body?.log?.length === 11
        && mgr.body?.exceptions === undefined, `an admin's Settings reads the totals, the lines and the access log, and no exceptions (${show(mgr)})`);
    const mgrO = await call('GET', null, '/api/local/admin/community-health', undefined, owner);
    assert(mgrO.status === 200 && mgrO.body?.known === true, `and the owner's (${show(mgrO)})`);
    const mgrSetA = await call('POST', null, '/api/local/admin/community-health', { debtLinePct: 70 }, adaSession);
    assert(mgrSetA.status === 403, `an admin can't move the lines from Settings (${show(mgrSetA)})`);
    const mgrSet = await call('POST', null, '/api/local/admin/community-health', { debtLinePct: 70 }, owner);
    assert(mgrSet.status === 200 && mgrSet.body?.debtLinePct === 70 && mgrSet.body?.quietDays === 7, `the owner does (${show(mgrSet)})`);
    const mgrM = await call('GET', kim, '/api/local/admin/community-health');
    assert(mgrM.status === 401 || mgrM.status === 403, `a member's signed request is refused (${show(mgrM)})`);

    // ── 8. an admin's look at a member's balance while removing them is logged ──────────────────────
    console.log('── 8. removing a member: the look at their balance is logged ──');
    const lastLine = () => db.prepare('SELECT actor_pubkey, action, subject_pubkey FROM health_access_log ORDER BY at DESC, rowid DESC LIMIT 1').get() as any;
    const before8 = logRows();
    const prev = await call('GET', null, `/api/local/admin/members/${una.pk}/offboard/preview`, undefined, adaSession);
    assert(prev.status === 200 && typeof prev.body?.balance === 'number', `an admin starting to remove Unaleigh sees her balance, to settle it (${show(prev)})`);
    const l1 = lastLine();
    assert(logRows() === before8 + 1 && l1?.action === 'offboard_preview' && l1?.actor_pubkey === ada.pk && l1?.subject_pubkey === una.pk,
        `that look is a line in the access log: who, whose balance, why (${JSON.stringify(l1)})`);
    const prevO = await call('GET', null, `/api/local/admin/members/${sam.pk}/offboard/preview`, undefined, owner);
    const l2 = lastLine();
    assert(prevO.status === 200 && logRows() === before8 + 2 && l2?.action === 'offboard_preview' && typeof l2?.actor_pubkey === 'string'
        && l2.actor_pubkey !== ada.pk && l2?.subject_pubkey === sam.pk,
        `the owner's password session's look is logged too (${show(prevO)} ${JSON.stringify(l2)})`);
    const ott = makeMember('Ottoline');   // no trades, nothing owed: removed outright
    const done = await call('POST', null, `/api/local/admin/members/${ott.pk}/offboard`, { resolution: 'prune_zero_balance' }, owner);
    const l3 = lastLine();
    assert(done.status === 200 && typeof done.body?.balanceSettled === 'number' && logRows() === before8 + 3 && l3?.action === 'offboard_settled' && l3?.subject_pubkey === ott.pk,
        `removing Ottoline answers the balance it settled, and that is a line too (${show(done)} ${JSON.stringify(l3)})`);
    const logRead = await call('GET', ada, '/api/names/health/log');
    const top = logRead.body?.log?.[0];
    assert(logRead.status === 200 && top?.action === 'offboard_settled' && top?.subject === ott.pk && top?.subjectCallsign === 'Ottoline'
        && logRead.body.log[2]?.action === 'offboard_preview' && logRead.body.log[2]?.actor === ada.pk,
        `the admins and the owner read every such look: who, whose, when (${show(logRead)})`);
    const missing = await call('GET', null, `/api/local/admin/members/${'f'.repeat(64)}/offboard/preview`, undefined, adaSession);
    assert(missing.status === 404 && logRows() === before8 + 3, `no member, no balance, no line (${show(missing)})`);
    // The activity log carries no settled balance to anyone (review r4176631042): the removal's line names no number, and a
    // line a node wrote before this (planted here, as it was written) is answered without it, its search included.
    const ottLine = db.prepare("SELECT message FROM system_logs WHERE json_extract(metadata, '$.memberPubkey') = ?").get(ott.pk) as { message: string } | undefined;
    assert(!!ottLine && /offboarded/.test(ottLine.message) && !/settled balance/i.test(ottLine.message), `Ottoline's removal line names no balance (${JSON.stringify(ottLine)})`);
    const pip = 'ab'.repeat(32);
    db.prepare("INSERT INTO system_logs (timestamp, level, category, message, metadata) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'INFO', 'ADMIN', ?, ?)")
        .run(`Member Pipistrelle (${pip.slice(0, 10)}...) offboarded with resolution 'donate_to_commons' (settled balance: 37) by operator ${ada.pk}`,
            JSON.stringify({ memberPubkey: pip, callsign: 'Pipistrelle', operatorPubkey: ada.pk, resolution: 'donate_to_commons', balanceSettled: 37, giftRecipient: null }));
    const before8b = logRows();
    for (const [who, auth] of [['an admin', adaSession], ['the owner', owner]] as const) {
        const logs = await call('POST', null, '/api/local/admin/logs', { category: 'ADMIN', searchQuery: 'offboarded' }, auth);
        const rows = (logs.body?.logs ?? []) as any[];
        const pipRow = rows.find((r) => /Pipistrelle/.test(r.message));
        assert(logs.status === 200 && !!pipRow && rows.some((r) => /Ottoline/.test(r.message))
            && rows.every((r) => !/settled balance|\b37\b/i.test(r.message) && !/balanceSettled/.test(String(r.metadata)))
            && JSON.parse(pipRow.metadata).resolution === 'donate_to_commons',
            `${who} reads the removals in the activity log, and no settled balance with them (${show(logs)})`);
        const probe = await call('POST', null, '/api/local/admin/logs', { category: 'ADMIN', searchQuery: 'settled balance: 37' }, auth);
        assert(probe.status === 200 && probe.body?.logs?.length === 0, `${who}'s search can't find the number either (${show(probe)})`);
    }
    assert(logRows() === before8b, 'reading the activity log is no look at a balance, so it writes no line');

    // ── 8b. a vote on removing a member shows the balance to its voters only ──────────────────────────
    // #1610's deciding review, Question 2: the admin Decisions list served every admin and the owner the balance and debt
    // of a member up for removal, whether or not they could vote in it. The rule (Marty, 28 Sep): everyone who can vote in
    // it sees the balance, in that vote only. Being an admin is no reason to see it.
    console.log('── 8b. a vote on removing a member: its balance reaches its voters only ──');
    const removal = createDecision({ authorPubkey: founder.pk, title: 'Remove Kimberly', description: 'Owes 600 and gone quiet', touches: 'member', effect: 'remove_member', subject: kim.pk });
    const lateAdmin = makeMember('Latecomer');   // an admin who joined after the vote opened: can't vote in it
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() + 1000).toISOString(), lateAdmin.pk);
    grantNodeRole(lateAdmin.pk, 'admin', 'SYSTEM');
    const lateSession = { 'X-Admin-Session': consumeHandshakeToken(mintHandshakeToken(lateAdmin.pk, 'admin').handshakeToken).sessionId! };
    const before8c = logRows();
    const adminCard = (r: Res) => (r.body?.decisions ?? []).find((d: any) => d.id === removal.id);
    const asVoterAdmin = await call('POST', null, '/api/local/admin/decisions', {}, adaSession);
    const voterCard = adminCard(asVoterAdmin);
    assert(asVoterAdmin.status === 200 && voterCard?.params?.balance === -600 && voterCard?.params?.debt === 600 && !voterCard?.balanceHidden,
        `an admin who can vote in it sees the balance and the debt in the admin Decisions list (${show(asVoterAdmin)})`);
    const asLateAdmin = await call('POST', null, '/api/local/admin/decisions', {}, lateSession);
    const lateCard = adminCard(asLateAdmin);
    assert(asLateAdmin.status === 200 && !!lateCard && lateCard.balanceHidden === true && !('balance' in (lateCard.params ?? {})) && !('debt' in (lateCard.params ?? {}))
        && lateCard.params?.memberName === 'Kimberly' && lateCard.subjectName === 'Kimberly',
        `an admin who can't vote in it gets the vote without the balance or the debt, and is told it is hidden (${show(asLateAdmin)})`);
    assert(!/-600|"debt":600/.test(asLateAdmin.text), 'the number is nowhere in that answer');
    const asOwner = await call('POST', null, '/api/local/admin/decisions', {}, owner);
    assert(asOwner.status === 200 && adminCard(asOwner)?.params?.balance === -600 && !adminCard(asOwner)?.balanceHidden,
        `an owner who can vote in it sees it, as any voter does (${show(asOwner)})`);
    const lateOwner = makeMember('Lateowner');   // an owner who joined after the vote opened: can't vote in it
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(new Date(Date.now() + 1000).toISOString(), lateOwner.pk);
    grantNodeRole(lateOwner.pk, 'owner', 'SYSTEM');
    const asLateOwner = await call('POST', null, '/api/local/admin/decisions', {}, ownerSessionHeaders(lateOwner.pk));
    const ownerCard = adminCard(asLateOwner);
    assert(asLateOwner.status === 200 && ownerCard?.balanceHidden === true && !('balance' in (ownerCard?.params ?? {})) && !('debt' in (ownerCard?.params ?? {})),
        `being the owner is no reason either: an owner who can't vote in it gets it hidden (${show(asLateOwner)})`);
    const asSignedLate = await call('POST', lateAdmin, '/api/local/admin/decisions', {}, lateSession);
    assert(adminCard(asSignedLate)?.balanceHidden === true && !/-600/.test(asSignedLate.text), `signing the request as well changes nothing for an admin who can't vote (${show(asSignedLate)})`);
    // #1613's deciding review, finding 1: a token is a script, not a voter. One made by an owner who can vote in it
    // still gets the vote without the balance or the debt.
    const asVoterToken = await call('POST', null, '/api/local/admin/decisions', {}, ownerTokenHeaders('admin', founder.pk));
    const tokenCard = adminCard(asVoterToken);
    assert(asVoterToken.status === 200 && tokenCard?.balanceHidden === true && !('balance' in (tokenCard?.params ?? {})) && !('debt' in (tokenCard?.params ?? {}))
        && !/-600|"debt":600/.test(asVoterToken.text),
        `an automation token gets it hidden, even one made by an owner who can vote in it (${show(asVoterToken)})`);
    const asVoter = await call('GET', sam, `/api/commons/decisions/${removal.id}`);
    assert(asVoter.status === 200 && asVoter.body?.decision?.params?.balance === -600 && asVoter.body?.decision?.params?.debt === 600,
        `a plain member who can vote in it still sees the balance and the debt (${show(asVoter)})`);
    const asLateMember = await call('GET', lateAdmin, `/api/commons/decisions/${removal.id}`);
    assert(asLateMember.status === 200 && !('balance' in (asLateMember.body?.decision?.params ?? {})), `nor through the members' route (${show(asLateMember)})`);
    assert(logRows() === before8c, 'a look at the balance in a vote is not a line in the access log, as the texts say (section 9)');

    // ── 9. the texts say what the node does ────────────────────────────────────────────────────────
    console.log('── 9. the privacy policy and the guide say what the node does ──');
    const policy = fs.readFileSync(new URL('../../website/privacy.html', import.meta.url), 'utf8');
    const guide = fs.readFileSync(new URL('../../../packages/beanpool-guide/content/settings/what-the-admins-can-see.md', import.meta.url), 'utf8');
    assert(!/no admin sees your balance/i.test(policy) && !/admins never see your balance/i.test(guide),
        'neither says no admin ever sees a balance: an admin removing a member sees it (section 8)');
    assert(/removes your account/.test(policy) && /removes your account/.test(guide), 'both say an admin removing your account sees your balance');
    assert(/votes on removing you/.test(policy) && /votes on removing you/.test(guide), 'both say a vote on removing you shows it to the voters');
    assert(/sees your balance while removing you, it records who, whose and when/.test(policy) && /can see who looked, at whose balance, and when/.test(guide),
        'both say that look is logged where the admins and the owner read it (section 8)');
    assert(/opens the list of balances, the node records who and when;/.test(policy) && /can see who opened it and when/.test(guide),
        'both say an opening of the list records who and when, not whose (section 6: exceptions_opened has no subject)');
    assert(/except in the four cases below/.test(policy) && (policy.match(/<h2>8\.[\s\S]*?<\/ul>/)?.[0].match(/<li><strong>(Only with your consent|When an admin removes|When the community votes|The server's operator)/g) ?? []).length === 4,
        'the policy counts its cases as it lists them: consent, removal, a vote, the operator');
    assert(/sees your balance and how many trades you have open/.test(policy) && /sees your balance and how many trades you have open/.test(guide),
        'both name the open-trade count the removal preview answers (pendingEscrowsCount)');
    assert(/take your consent back at any time/.test(policy) && /take your consent back at any time/.test(guide), 'both say consent can be withdrawn at any time (section 6c)');
    // What every admin sees of trades, whatever a member agreed to (review r4176931267): /api/local/admin/disputes (a pending
    // trade, or one an admin settled: both members, the listing, the price, their shared chat), /admin/data memberStats
    // (finished and cancelled counts, the finished ones' total) and the health flags naming members. Since queue item 29
    // (Marty, 4 Oct: "Keep disputes, log every look, totals only in member stats"), every look at the disputes and at the
    // alerts is logged, and memberStats carries only the community's trade totals.
    const notSeen = /never sees your trades|never your trades|No admin ever sees your trades|can't see your trades|Nobody's trades are shown/;
    const operatorPage = fs.readFileSync(new URL('../../../packages/beanpool-guide/operators/people/running-a-known-community.md', import.meta.url), 'utf8');
    const privacyPage = fs.readFileSync(new URL('../../../packages/beanpool-guide/content/settings/privacy.md', import.meta.url), 'utf8');
    // The built-in page's button that shows who the alerts name says the 24-hour rule too (r4177719409).
    const builtInPage = fs.readFileSync(new URL('../static/settings.js', import.meta.url), 'utf8');
    assert(builtInPage.split('Show who the alerts name (your first look at each member in 24 hours is logged)').length === 3
        && !builtInPage.includes('(this look is logged)'),
        "the built-in page's two buttons that show who the alerts name say an admin's first look at each member in 24 hours is logged");
    const terms9 = await call('GET', null, '/api/community/consent-terms');
    const consentText = String(terms9.body?.text ?? '');
    assert(![policy, guide, operatorPage, privacyPage, consentText].some((t) => notSeen.test(t)),
        'no text says an admin never sees a trade: every admin sees some (disputes, memberStats, fraud flags)');
    // Wording 3 (round 4): memberStats' posts and messages counts, the ring alert (names, no Beans), the inactivity alert,
    // the pair's one-to-one chat only, and the operator's whole database with its backups, snapshots and standby copies.
    const tradeList = "a trade that isn't finished yet or that an admin settled (both members, the listing, the price, and the messages in the two members' one-to-one chat, which an admin can't read if it is private), so that a stuck trade can be settled; a trade whose Beans were left stuck when a member was removed on an older server (the trade's status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one's amount and note); a fraud alert that names two members who buy from each other back and forth, about evenly, past a limit, with the Beans in total and how evenly they went each way; a fraud alert that names a member and the members they invited when those members send them Beans past a limit within a set number of days, with the Beans in total and how many of the members they invited have traded with no one but them; a fraud alert that names a group of members, at least half of them new, who trade mostly with each other, with how much of the group's trading is with each other but no Beans; and an alert that names the members who have had no Beans move in or out for a set number of days";
    // Fix round 2 (r4177719409): a look at a trade is logged every time; a look at the alerts that name a member once in
    // 24 hours per admin and member (the first look), so no text says every alerts look is logged.
    const loggedTrades = "Every look at one of those trades is logged, with who looked, when, and at which trades";
    const loggedAlerts = "a look at the alerts that name a member is logged the first time each admin opens them, and again at that admin's first look after 24 hours, and the looks in between add no line";
    const statsTotals = "The member stats the admins see show how many posts each member has up and messages they have sent, and of trades only the whole community's totals, never one member's.";
    // Fix round 1 (r4177560405; Marty 2026-09-29: trust numbers stay visible to every member): every text names what the
    // trust profile (POST /api/trust/profile) shows of a member's trades, to every member, admins included, unlogged.
    const trustProfile = "Every member, admins included, sees each member's trust profile: how many of their trades were finished and how many were cancelled, and the share finished, how many Bean payments they have sent to or received from members plus the trades they have finished, with how many different members they have paid, been paid by or traded with, how many payments and trades they have done with the member looking, and their Trust Points. It isn't logged, because every member can see it.";
    assert(policy.includes(`<li><strong>What any admin can see of trades,</strong> in any community and whatever you agreed to: ${tradeList}. ${loggedTrades}; ${loggedAlerts}. The owner and the admins can see that log. ${statsTotals} ${trustProfile} Nothing else of anyone's trades.</li>`),
        'the policy lists what any admin sees of trades (the stranded escrows too), says every look at a trade is logged and an alerts look once in 24 hours per admin and member, the owner sees the log, member stats carry only totals, every member sees the trust profile, and nothing else');
    assert(operatorPage.includes(`What every admin can see of trades, in any community, is: ${tradeList}. ${loggedTrades}; ${loggedAlerts}. Both go in Community health, as a list of its own beside the one where the owner and the admins see who opened the exceptions and who looked at a balance; a background check of the alerts, which shows no names, isn't a look and isn't logged. The member stats show how many posts each member has up and messages they have sent, and of trades only the whole community's totals, never one member's. ${trustProfile}`),
        'the operator page lists the same, logged in its own list where the owner reads it, the background check unlogged, totals only in member stats, the trust profile');
    assert(![policy, operatorPage, guide].some((t) => /how many trades each member has finished or cancelled/.test(t)) && !/how many trades you have finished or cancelled/.test(consentText + privacyPage),
        'no text says an admin sees one member\'s finished or cancelled trades any more');
    // Confirmation 2 (r4177813681): "how many they cancelled" read as the members or admins cancelling. The trust profile
    // counts the member's own trades that were cancelled, whoever cancelled them.
    assert(![policy, operatorPage, guide, consentText, privacyPage].some((t) => /how many they cancelled|the share they finished/.test(t)),
        'no text says "how many they cancelled": the trust profile counts how many of the member\'s trades were cancelled, whoever cancelled them');
    assert(/## What any admin can see of your trades/.test(guide) && /\*\*A trade that isn't finished yet, or that an admin settled\.\*\* Both members, the listing, the price, and the messages in the one-to-one chat of the two members\./.test(guide)
        && /\*\*Fraud alerts that name members,\*\* with Beans\. One names two members who buy from each other back and forth, about evenly, past a limit\. It shows the Beans in total and how evenly they went each way\. Another names a member and the members they invited, when those members send them Beans past a limit within a set number of days\. It shows the Beans in total and how many of the members they invited have traded with no one but them\./.test(guide)
        && /\*\*A fraud alert that names a group of members,\*\* at least half of them new, who trade mostly with each other\. It shows how much of the group's trading is with each other, but no Beans\./.test(guide)
        && /\*\*An alert that names the members who have had no Beans move in or out\*\* for a set number of days\./.test(guide)
        && /\*\*A trade whose Beans were left stuck when a member was removed on an older server\.\*\* The trade's status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one's amount and note, so that an owner can write the stuck Beans off\./.test(guide)
        && /\*\*Every look at one of these trades is logged:\*\* who looked, when, and at which trades\. \*\*A look at the alerts that name a member is logged\*\* the first time each admin opens them, and again at that admin's first look after 24 hours; the looks in between add no line\. The owner and the admins can see that log in Community health, as a list of its own beside the list of who looked at a balance\./.test(guide)
        && guide.includes("The member stats the admins see show how many posts each member has up and messages they have sent, and of trades only the whole community's totals: how many trades were finished or cancelled and what the finished ones came to, never one member's.\n\n" + trustProfile.replace("each member's trust profile", "each member's **trust profile**") + "\n\nNothing else of your trades.\n")
        && !/not logged/.test(guide),
        'the members\' guide lists the same five, says every look at a trade is logged and an alerts look once in 24 hours per admin and member, the owner sees the log, member stats carry only totals, every member sees the trust profile, and nothing else');
    assert(/Every look at one of those trades is logged, and a look at the alerts that name you is logged the first time each admin opens them in 24 hours\. The owner and the admins can see that log\. The admins also see how many posts you have up and messages you have sent, and of trades only the whole community's totals, not yours; and, as every member does, your trust profile, unlogged\./.test(privacyPage)
        && privacyPage.includes("- Your trust badge, your reviews, and your trust profile: how many of your trades were finished and how many were cancelled, and the share finished, how many Bean payments you have sent to or received from members plus the trades you have finished, with how many different members you have paid, been paid by or traded with, how many payments and trades you have done with the member looking, and your Trust Points. The admins see it as any member does, and it isn't logged.")
        && /an admin settled, a trade whose Beans were left stuck when a member was removed on an older server, fraud alerts,/.test(privacyPage),
        'the guide\'s privacy page says the same in short');
    const wholeDb = /holds its whole database, (balances and trades|your balance and trades) included, and its backups, snapshots and standby copies/;
    assert(wholeDb.test(policy) && wholeDb.test(guide) && /holds its whole database, with its backups, snapshots and standby copies/.test(privacyPage),
        'the policy and both guide pages say whoever runs the server holds the whole database, with its backups, snapshots and standby copies');
    assert(/any admin can see some of your trades: a trade that isn't finished yet or that an admin settled \(who with, the listing, the price, and your one-to-one chat with them, which they can't read if it is private\), so a stuck trade can be settled; a trade whose Beans were left stuck when a member was removed on an older server \(the trade's status, the listing, the price, its dates, the Beans left stuck, how many payments went through it, and the last one's amount and note\); a fraud alert/.test(consentText)
        && /a fraud alert that names you if you and one member buy from each other back and forth, about evenly, past a limit, with the Beans in total and how evenly they went each way; one that names you, with the Beans in total and how many of the members you invited have traded with no one but you, if members you invited send you Beans past a limit within a set number of days, or if you are one of those members;/.test(consentText)
        && /one that names you, with how much of the group's trading is with each other but no Beans, if you are in a group of members, at least half of them new, who trade mostly with each other;/.test(consentText)
        && /an alert that names you if no Beans have moved in or out of your account for a set number of days\. Every look at one of those trades is logged, with who looked, when, and at which trades; a look at the alerts that name you is logged the first time each admin opens them, and again at that admin's first look after 24 hours, and the looks in between add no line\. The owner and the admins can see that log\. The member stats the admins see show how many posts you have up and messages you have sent, and of trades only the whole community's totals, not yours\. Every member, admins included, sees your trust profile: how many of your trades were finished and how many were cancelled, and the share finished, how many Bean payments you have sent to or received from members plus the trades you have finished, with how many different members you have paid, been paid by or traded with, how many payments and trades you have done with the member looking, and your Trust Points\. That isn't logged, because every member can see it\. Nothing else of your trades\. Whoever runs/.test(consentText)
        && !/not logged/.test(consentText)
        && /Nothing else of your trades\. Whoever runs this community's server holds its whole database, your balance and trades included, and its backups, snapshots and standby copies\.$/.test(consentText)
        && /Every time an admin opens the list of members past those lines, and every time an admin looks at your balance while removing you, it is logged\. In a vote on removing you, everyone who can vote in it sees your balance and any debt, in that vote only, and those looks aren't logged\. You can take this back at any time in Settings\./.test(consentText),
        `the wording a member agrees to says what any admin sees of trades, that every look is logged and the owner sees the log, that member stats carry only the community's totals, which looks at a balance are logged and that the looks in a vote on removing them are not, and that whoever runs the server holds it all (${show(terms9)})`);
    // #1610's deciding review, Question 2: wording 5 said "Every look at your balance is logged", and the looks in a vote on
    // removing a member (section 8b) write no line. Every text now names the voters, says no other admin or owner sees it
    // there, and says those looks aren't logged.
    assert(![policy, guide, operatorPage, privacyPage, consentText].some((t) => /every look at your balance is logged/i.test(t)),
        'no text says every look at a balance is logged: a look in a vote on removing a member is not');
    const notThere = "An admin or an owner who can't vote in it doesn't see them there. Those looks aren't logged.";
    assert(policy.includes(`<li><strong>When the community votes on removing you:</strong> everyone who can vote in it sees your balance and any debt, in that vote only. ${notThere}</li>`)
        && policy.includes('A look at your balance in a vote on removing you isn\'t recorded.'),
        'the policy says only the voters see a balance in a vote on removing you, no other admin or owner, and that it is not recorded');
    assert(guide.includes(`- **When your community votes on removing you.** Everyone who can vote in it sees your balance and any debt, in that vote only. ${notThere}`)
        && privacyPage.includes(`- If the community votes on removing you, everyone who can vote in it sees your balance and any debt, in that vote only. ${notThere}`)
        && operatorPage.includes("In a vote on removing a member, everyone who can vote in it sees that member's balance and any debt, in that vote only. An owner or an admin who can't vote in it doesn't see them there. Those looks aren't logged.")
        && operatorPage.includes("Every time an admin sees a member's balance while removing them, it writes who, whose and when."),
        'both guide pages and the operator page say the same, and the operator page says a look while removing a member is logged');
    const quoted = consentText.replace(/past \d+% of/, 'past 50% of').replace(/debit for \d+ days/, 'debit for 60 days');
    assert(guide.includes(`"${quoted}"`), 'the guide quotes the wording a member agrees to, word for word (at 50% and 60 days)');
    assert(String(terms9.body?.version ?? '').startsWith('6:'), `the wording is version 6, so a member who agreed to wording 5 ("Every look at your balance is logged") is asked again (${show(terms9)})`);
    // Queue item 29 (Marty, 4 Oct: "Keep disputes, log every look, totals only in member stats").
    const lastLines = (n: number) => db.prepare('SELECT actor_pubkey, action, subject_pubkey, detail FROM health_access_log ORDER BY at DESC, rowid DESC LIMIT ?').all(n) as any[];
    const before9 = logRows();
    const disputes9 = await call('GET', null, '/api/local/admin/disputes?minDays=0', undefined, adaSession);
    const listLine9 = lastLines(1)[0];
    const shownIds9 = (disputes9.body?.disputes ?? []).map((d: any) => d.id);
    assert(disputes9.status === 200 && logRows() === before9 + 1 && listLine9?.action === 'disputes_listed' && listLine9?.actor_pubkey === ada.pk
        && JSON.stringify(JSON.parse(listLine9?.detail ?? 'null')) === JSON.stringify(shownIds9),
        `an admin's read of the disputes list is a line: who, and the ids of the trades it showed (${disputes9.status} ${JSON.stringify(listLine9)} ${JSON.stringify(shownIds9)})`);
    // An alert that names a member: Bea, invited by Ada (the inactivity alert passes over the genesis-invited) and here
    // 200 days, has moved no Beans in the 30 days it looks back (inactive_member names her).
    db.prepare('UPDATE members SET invited_by = ? WHERE public_key = ?').run(ada.pk, bea.pk);
    const before9b = logRows();
    const data9 = await call('POST', null, '/api/local/admin/data', {}, adaSession);
    const named9 = [...new Set(((data9.body?.health?.flags ?? []) as any[]).flatMap((f) => f.members ?? []))].sort();
    const alertLines9 = lastLines(logRows() - before9b);
    assert(data9.status === 200 && named9.length > 0 && alertLines9.length === named9.length
        && alertLines9.every((l) => l.action === 'alerts_read' && l.actor_pubkey === ada.pk)
        && JSON.stringify(alertLines9.map((l) => l.subject_pubkey).sort()) === JSON.stringify(named9),
        `an admin's read of the fraud alerts is a line per member they named (${data9.status} ${named9.length} named, ${alertLines9.length} lines)`);
    const healthBefore9 = logRows();
    const health9 = await call('POST', null, '/api/local/admin/health', {}, adaSession);
    const named9h = new Set(((health9.body?.flags ?? []) as any[]).flatMap((f) => f.members ?? []));
    assert(health9.status === 200 && named9h.size > 0 && logRows() === healthBefore9,
        `the same admin reading the same members' alerts again within 24 hours writes no new line (${health9.status} ${named9h.size} named, ${logRows() - healthBefore9} lines)`);
    const healthO9 = await call('POST', null, '/api/local/admin/health', {}, owner);
    const named9o = new Set(((healthO9.body?.flags ?? []) as any[]).flatMap((f) => f.members ?? []));
    assert(healthO9.status === 200 && named9o.size > 0 && logRows() === healthBefore9 + named9o.size,
        `another admin's read of the alerts from /admin/health is a line per member named (${healthO9.status} ${named9o.size} named, ${logRows() - healthBefore9} lines)`);
    // One that names someone new logs that one: Ada's earlier lines for Bea stay, and a line for a newly named member is added.
    db.prepare("UPDATE health_access_log SET at = ? WHERE action = 'alerts_read' AND actor_pubkey = ?").run(ago(2 * DAY), ada.pk);
    const again9 = logRows();
    await call('POST', null, '/api/local/admin/health', {}, adaSession);
    assert(logRows() === again9 + named9h.size, `after 24 hours the same read is logged again (${logRows() - again9} lines)`);
    // The background check (the manager's five-minute tick, the built-in page's reloads) is no look: names-free, unlogged.
    const bgBefore9 = logRows();
    const bg9 = await call('POST', null, '/api/local/admin/alerts-summary', {}, adaSession);
    const bgData9 = await call('POST', null, '/api/local/admin/data', { alerts: 'summary' }, adaSession);
    const bgHealth9 = await call('POST', null, '/api/local/admin/health', { alerts: 'summary' }, adaSession);
    const namedKeys9 = [...named9h] as string[];
    const namedCallsigns9 = namedKeys9.map((k) => (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(k) as any)?.callsign).filter(Boolean);
    const bgText9 = JSON.stringify(bg9.body ?? null);
    assert(bg9.status === 200 && Array.isArray(bg9.body?.flags) && bg9.body.flags.length > 0 && logRows() === bgBefore9
        && bg9.body.flags.some((f: any) => f.namesHidden === true && Array.isArray(f.members) && f.members.length === 0)
        && namedKeys9.every((k) => !bgText9.includes(k)) && namedCallsigns9.every((c) => !bgText9.includes(c)) && !/Beans|\d+(\.\d+)? ?B\b/.test(bgText9),
        `the background summary writes no line and carries no member key or name, and no Beans (${bg9.status} ${bgText9.slice(0, 200)})`);
    const bgFlags9 = [...(bgData9.body?.health?.flags ?? []), ...(bgHealth9.body?.flags ?? [])] as any[];
    assert(bgData9.status === 200 && bgHealth9.status === 200 && logRows() === bgBefore9 && bgFlags9.length > 0
        && bgFlags9.every((f) => !(f.members ?? []).length) && namedKeys9.every((k) => !JSON.stringify(bgFlags9).includes(k)),
        `/admin/data and /admin/health asked for the alerts' summary write no line and their alerts name nobody (${logRows() - bgBefore9} lines)`);
    // A report filed since the manager's last full read lights its ALERT dot from the summary (confirmation 1, r4177719213):
    // the summary carries each report's id, the same reports /admin/data lists, and nobody's key, callsign or reason.
    const reportId9 = 't9-report-' + crypto.randomBytes(4).toString('hex');
    const reportTarget9 = namedKeys9[0];
    db.prepare("INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason) VALUES (?, ?, ?, 'T9 reason: spam in the market')")
        .run(reportId9, ada.pk, reportTarget9);
    const rpBefore9 = logRows();
    const rpSummary9 = await call('POST', null, '/api/local/admin/alerts-summary', {}, adaSession);
    const rpData9 = await call('POST', null, '/api/local/admin/data', { alerts: 'summary' }, adaSession);
    const rpText9 = JSON.stringify(rpSummary9.body ?? null);
    const rpDataIds9 = ((rpData9.body?.reports ?? []) as any[]).map((r) => r.id);
    assert(rpSummary9.status === 200 && Array.isArray(rpSummary9.body?.reportIds) && rpSummary9.body.reportIds.includes(reportId9)
        && JSON.stringify([...rpSummary9.body.reportIds].sort()) === JSON.stringify([...rpDataIds9].sort())
        && typeof rpSummary9.body?.reportCount === 'number' && rpSummary9.body.reportCount >= 1
        && !rpText9.includes(ada.pk) && !rpText9.includes(reportTarget9) && !rpText9.includes('T9 reason') && logRows() === rpBefore9,
        `the summary carries each report's id (the reports /admin/data lists) and no reporter, member or reason, and writes no line (${rpSummary9.status} ${rpText9.slice(0, 160)})`);
    db.prepare('DELETE FROM abuse_reports WHERE id = ?').run(reportId9);
    // An escrow left stuck by a member's removal on an older node: reading the list is a look, logged like the disputes.
    // It gets a line of its own (stranded_escrows_read), so the log says which view the admin opened.
    db.prepare("INSERT INTO accounts (public_key, balance) VALUES ('escrow_t9-stranded', -5)").run();
    const strandedBefore9 = logRows();
    const stranded9 = await call('GET', null, '/api/local/admin/stranded-escrows', undefined, adaSession);
    const strandedLine9 = lastLines(1)[0];
    const strandedIds9 = ((stranded9.body?.escrows ?? []) as any[]).map((e) => e.tradeId ?? e.escrowId);
    db.prepare("DELETE FROM accounts WHERE public_key = 'escrow_t9-stranded'").run();
    assert(stranded9.status === 200 && logRows() === strandedBefore9 + 1 && strandedLine9?.action === 'stranded_escrows_read' && strandedLine9?.actor_pubkey === ada.pk
        && strandedIds9.length > 0 && JSON.stringify(JSON.parse(strandedLine9?.detail ?? 'null')) === JSON.stringify(strandedIds9),
        `an admin's read of the stranded escrows is a stranded_escrows_read line naming their trades (${stranded9.status} ${JSON.stringify(strandedLine9)} ${JSON.stringify(strandedIds9)})`);
    const stats9 = (data9.body?.memberStats ?? {}) as Record<string, Record<string, unknown>>;
    assert(Object.keys(stats9).length > 0 && Object.values(stats9).every((s) => !('deals' in s) && !('volume' in s) && !('cancelled' in s))
        && typeof stats9[kim.pk]?.posts === 'number' && typeof stats9[kim.pk]?.messages === 'number',
        `member stats carry no member's trades (deals, volume, cancelled), only their posts and messages (${JSON.stringify(stats9[kim.pk])})`);
    const sums9 = db.prepare(`SELECT SUM(status = 'completed') AS deals, ROUND(COALESCE(SUM(CASE WHEN status = 'completed' THEN credits ELSE 0 END), 0), 2) AS volume,
        SUM(status = 'cancelled') AS cancelled FROM marketplace_transactions`).get() as any;
    const totals9 = data9.body?.tradeTotals;
    assert(totals9 && totals9.deals === (sums9.deals ?? 0) && totals9.volume === sums9.volume && totals9.cancelled === (sums9.cancelled ?? 0),
        `of trades, the community's totals: each trade once (${JSON.stringify(totals9)} vs ${JSON.stringify(sums9)})`);
    const panel9 = await call('GET', null, '/api/local/admin/community-health', undefined, adaSession);
    const panelLog9 = (panel9.body?.tradeLog ?? []) as any[];
    assert(panel9.status === 200 && panelLog9.some((l) => l.action === 'disputes_listed' && JSON.stringify(l.tradeIds) === JSON.stringify(shownIds9))
        && panelLog9.some((l) => l.action === 'alerts_read' && named9.includes(l.subject))
        && panelLog9.some((l) => l.action === 'stranded_escrows_read' && JSON.stringify(l.tradeIds) === JSON.stringify(strandedIds9))
        && ((panel9.body?.log ?? []) as any[]).every((l) => ['exceptions_opened', 'offboard_preview', 'offboard_settled'].includes(l.action)),
        `the looks at trades and alerts are in their own list beside the balance looks, in the panel the owner and admins read (${panel9.status})`);
    // 100 alert reads by different admins can't push a balance look out of the balance list (review r4177560410).
    db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, at) VALUES ('t9-balance-look', ?, 'offboard_preview', ?, ?)").run(ada.pk, una.pk, ago(DAY));
    const flood9 = db.prepare("INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey) VALUES (?, ?, 'alerts_read', ?)");
    for (let i = 0; i < 100; i++) flood9.run(`t9-flood-${i}`, `actor-${i}`, bea.pk);
    await call('POST', null, '/api/local/admin/data', {}, adaSession);
    const panelF9 = await call('GET', null, '/api/local/admin/community-health', undefined, adaSession);
    assert(panelF9.status === 200 && (panelF9.body?.log ?? []).some((l: any) => l.id === 't9-balance-look')
        && (panelF9.body?.tradeLog ?? []).length === 100,
        `after 100 alert reads the balance look is still in the balance list (${(panelF9.body?.log ?? []).length} balance, ${(panelF9.body?.tradeLog ?? []).length} trade lines)`);
    // Fail closed: a look that can't be logged isn't answered (review r4177560417).
    db.prepare("CREATE TEMP TRIGGER t9_no_log BEFORE INSERT ON health_access_log BEGIN SELECT RAISE(ABORT, 't9: no log'); END").run();
    db.prepare("DELETE FROM health_access_log WHERE action = 'alerts_read'").run();
    const closed9 = await call('POST', null, '/api/local/admin/data', {}, adaSession);
    const closedDisputes9 = await call('GET', null, '/api/local/admin/disputes?minDays=0', undefined, adaSession);
    db.prepare('DROP TRIGGER t9_no_log').run();
    assert(closed9.status === 200 && ((closed9.body?.health?.flags ?? []) as any[]).every((f) => !(f.members ?? []).length)
        && namedKeys9.every((k) => !JSON.stringify(closed9.body?.health ?? null).includes(k)),
        `when the alerts' line can't be written, the alerts carry no flag that names a member (${closed9.status})`);
    assert(closedDisputes9.status === 503 && closedDisputes9.body?.code === 'LOOK_NOT_LOGGED' && !('disputes' in (closedDisputes9.body ?? {})),
        `and the disputes answer 503 LOOK_NOT_LOGGED with no trades (${show(closedDisputes9)})`);
    const roleBefore9 = getNodeRole();
    setNodeRole('backup');
    const standbyDisputes9 = await call('GET', null, '/api/local/admin/disputes?minDays=0', undefined, adaSession);
    setNodeRole(roleBefore9);
    assert(standbyDisputes9.status === 503 && standbyDisputes9.body?.code === 'LOOK_NOT_LOGGED' && !('disputes' in (standbyDisputes9.body ?? {})),
        `a standby, which writes no plain table, answers the disputes 503 LOOK_NOT_LOGGED with no trades (${show(standbyDisputes9)})`);

    // "A trade that isn't finished yet or that an admin settled", and nothing else: one trade read by its id is a trade the
    // list can show (round 4, item 1), and its chat is the two members' one-to-one chat, never a group they share (item 3).
    const ivy = makeMember('Ivy');
    const jon = makeMember('Jonquil');
    const stall = createPost('offer', 'produce', 'Jonquil\'s jam', 'Preserves', 5, 'fixed', jon.pk)!;
    const trade = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, dispute_resolution)
                              VALUES (?, ?, ?, ?, 5, ?, ?, ?)`);
    trade.run('t9-done', stall.id, ivy.pk, jon.pk, 'completed', ago(20 * DAY), null);
    trade.run('t9-cancelled', stall.id, ivy.pk, jon.pk, 'cancelled', ago(20 * DAY), null);
    trade.run('t9-settled', stall.id, ivy.pk, jon.pk, 'completed', ago(20 * DAY), 'release_to_seller');
    trade.run('t9-open', stall.id, ivy.pk, jon.pk, 'pending', ago(20 * DAY), null);
    const one9 = (id: string) => call('GET', null, `/api/local/admin/disputes/${id}`, undefined, adaSession);
    const [done9, cancelled9, settled9, open9] = [await one9('t9-done'), await one9('t9-cancelled'), await one9('t9-settled'), await one9('t9-open')];
    assert(done9.status === 404 && cancelled9.status === 404 && !/Ivy|Jonquil|jam/.test(done9.text + cancelled9.text),
        `a finished or cancelled trade nobody disputed is not an admin's to read by its id: 404, no names (${done9.status} ${cancelled9.status})`);
    assert(settled9.status === 200 && settled9.body?.dispute?.id === 't9-settled' && open9.status === 200 && open9.body?.dispute?.id === 't9-open',
        `a trade an admin settled, and one not finished yet, are (${settled9.status} ${open9.status})`);
    const openLines9 = lastLines(2);
    assert(openLines9[0]?.action === 'dispute_opened' && openLines9[0]?.detail === JSON.stringify(['t9-open']) && openLines9[0]?.actor_pubkey === ada.pk
        && openLines9[1]?.action === 'dispute_opened' && openLines9[1]?.detail === JSON.stringify(['t9-settled']),
        `each read of one dispute is a line naming that trade; a 404 is none (${JSON.stringify(openLines9)})`);
    const listed9 = new Set(((await call('GET', null, '/api/local/admin/disputes?minDays=0&limit=200', undefined, adaSession)).body?.disputes ?? []).map((d: any) => d.id));
    assert(['t9-settled', 't9-open'].every(id => listed9.has(id)) && !['t9-done', 't9-cancelled'].some(id => listed9.has(id)),
        `the same trades the list shows (${[...listed9].filter(id => String(id).startsWith('t9-')).join(', ')})`);
    // With finished and cancelled trades on the books (Ivy and Jonquil's), the totals still count each trade once, and
    // neither member's stats carry them.
    const dataT9 = await call('POST', null, '/api/local/admin/data', {}, adaSession);
    const sumsT9 = db.prepare(`SELECT SUM(status = 'completed') AS deals, ROUND(COALESCE(SUM(CASE WHEN status = 'completed' THEN credits ELSE 0 END), 0), 2) AS volume,
        SUM(status = 'cancelled') AS cancelled FROM marketplace_transactions`).get() as any;
    const totT9 = dataT9.body?.tradeTotals;
    const statsT9 = (dataT9.body?.memberStats ?? {}) as Record<string, Record<string, unknown>>;
    assert(dataT9.status === 200 && sumsT9.deals >= 2 && sumsT9.cancelled >= 1 && sumsT9.volume >= 10
        && totT9?.deals === sumsT9.deals && totT9?.volume === sumsT9.volume && totT9?.cancelled === sumsT9.cancelled
        && [ivy, jon].every((m) => statsT9[m.pk] && !('deals' in statsT9[m.pk]) && !('volume' in statsT9[m.pk]) && !('cancelled' in statsT9[m.pk])),
        `with trades finished and cancelled, the totals equal the sums and no member's stats carry them (${JSON.stringify(totT9)} vs ${JSON.stringify(sumsT9)})`);

    const chatOf = db.prepare(`INSERT INTO conversations (id, type, post_id, name, created_by) VALUES (?, ?, NULL, ?, ?)`);
    const inChat = db.prepare(`INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)`);
    const line = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type) VALUES (?, ?, ?, ?, 'n', 'text')`);
    chatOf.run('c9-group', 'group', 'Jam makers', ivy.pk);
    for (const m of [ivy, jon, sam]) inChat.run('c9-group', m.pk);
    line.run('m9-group', 'c9-group', ivy.pk, 'a line in the group');
    const groupOnly = await one9('t9-open');
    assert(groupOnly.status === 200 && !groupOnly.body?.dispute?.chat && (groupOnly.body?.dispute?.chatContext ?? []).length === 0 && !/a line in the group/.test(groupOnly.text),
        `a group chat the two share is not their chat: the trade shows none (${JSON.stringify(groupOnly.body?.dispute?.chat ?? null).slice(0, 120)})`);
    chatOf.run('c9-dm', 'dm', null, ivy.pk);
    for (const m of [ivy, jon]) inChat.run('c9-dm', m.pk);
    line.run('m9-dm', 'c9-dm', jon.pk, 'a line between the two');
    const withDm = await one9('t9-open');
    assert(withDm.status === 200 && withDm.body?.dispute?.chat?.conversationId === 'c9-dm' && /a line between the two/.test(withDm.text) && !/a line in the group/.test(withDm.text),
        `their one-to-one chat is (${JSON.stringify(withDm.body?.dispute?.chat ?? null).slice(0, 120)})`);

    // The node's plaintext notices in that chat (escrow placed, released: amounts and both keys) are this trade's only, never
    // the pair's other trades', finished ones included (review r4177156576). A pair with an older finished trade and the
    // disputed one; the notices go where the node puts them (injectSystemMessage), next to a line the two wrote.
    const max = makeMember('Maxine');
    const nia = makeMember('Niamh');
    const oldPost = createPost('offer', 'produce', 'Niamh\'s old bread', 'Baking', 7, 'fixed', nia.pk)!;
    const newPost = createPost('offer', 'produce', 'Niamh\'s honey', 'Preserves', 9, 'fixed', nia.pk)!;
    chatOf.run('c9-pair', 'dm', null, max.pk);
    for (const m of [max, nia]) inChat.run('c9-pair', m.pk);
    trade.run('t9-old', oldPost.id, max.pk, nia.pk, 'completed', ago(40 * DAY), null);
    // Each notice carries its trade's transactionId, as engine/escrow.ts writes it.
    const notice = (post: { id: string }, txId: string, type: string, amount: number, extra: object = {}) =>
        injectSystemMessage(post.id, type, { amount, postId: post.id, transactionId: txId, buyerPubkey: max.pk, sellerPubkey: nia.pk, ...extra } as any, max.pk, nia.pk);
    notice(oldPost, 't9-old', 'ESCROW_FUNDED', 7);
    notice(oldPost, 't9-old', 'ESCROW_RELEASED', 7);
    line.run('m9-pair', 'c9-pair', max.pk, 'a line the pair wrote');
    trade.run('t9-pair', newPost.id, max.pk, nia.pk, 'pending', ago(20 * DAY), null);
    notice(newPost, 't9-pair', 'ESCROW_FUNDED', 9);
    const pairOne = await one9('t9-pair');
    const pairListed = ((await call('GET', null, '/api/local/admin/disputes?minDays=0&limit=200', undefined, adaSession)).body?.disputes ?? [])
        .find((d: any) => d.id === 't9-pair');
    for (const [where, d] of [['by its id', pairOne.body?.dispute], ['on the list', pairListed]] as const) {
        const shown = JSON.stringify({ chat: d?.chat ?? null, chatContext: d?.chatContext ?? null });
        assert(pairOne.status === 200 && d?.chat?.conversationId === 'c9-pair' && /a line the pair wrote/.test(shown) && /9 Beans placed in escrow/.test(shown)
            && !/7 Beans/.test(shown) && !shown.includes(oldPost.id)
            && (d?.chat?.messages ?? []).length === 2 && (d?.chatContext ?? []).length === 2,
            `${where}, the dispute's chat shows the pair's line and this trade's notice, none of their older trade's (${shown.slice(0, 300)})`);
    }

    // A repeatable listing (a weekly box) the same pair traded before shares the post id with the disputed trade, so a
    // notice is this trade's only by its transactionId (review r4177209847): the earlier trade's notices, a ruling on
    // another trade with its reason, and a notice with no transactionId all stay out.
    const boxPost = createPost('offer', 'produce', 'Niamh\'s weekly box', 'Produce', 13, 'fixed', nia.pk, undefined, undefined, undefined, true)!;
    trade.run('t9-box-old', boxPost.id, max.pk, nia.pk, 'completed', ago(30 * DAY), null);
    notice(boxPost, 't9-box-old', 'ESCROW_FUNDED', 13);
    notice(boxPost, 't9-box-old', 'ESCROW_RELEASED', 13);
    notice(boxPost, 't9-box-ruled', 'ESCROW_DISPUTE_RESOLVED', 11, { resolution: 'refund', resolvedByName: 'Ada', reason: 'an older ruling' });
    injectSystemMessage(boxPost.id, 'ESCROW_FUNDED', { amount: 17, postId: boxPost.id, buyerPubkey: max.pk, sellerPubkey: nia.pk } as any, max.pk, nia.pk);
    trade.run('t9-box-new', boxPost.id, max.pk, nia.pk, 'pending', ago(10 * DAY), null);
    notice(boxPost, 't9-box-new', 'ESCROW_FUNDED', 5);
    const boxOne = await one9('t9-box-new');
    const boxShown = JSON.stringify({ chat: boxOne.body?.dispute?.chat ?? null, chatContext: boxOne.body?.dispute?.chatContext ?? null });
    const boxSystem = (boxOne.body?.dispute?.chat?.messages ?? []).filter((m: any) => m.type === 'system' || m.authorPubkey === 'SYSTEM');
    assert(boxOne.status === 200 && /5 Beans placed in escrow/.test(boxShown) && !/13 Beans/.test(boxShown) && !/older ruling/.test(boxShown)
        && !/11 Beans/.test(boxShown) && !/17 Beans/.test(boxShown) && !/t9-box-old|t9-box-ruled/.test(boxShown) && boxSystem.length === 1,
        `a repeatable listing's dispute shows this trade's notice only, not the pair's earlier trade of it, another ruling or a notice with no trade id (${boxShown.slice(0, 400)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
