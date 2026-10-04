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
import { initTls } from './services/tls.js';
import { initStateEngine, transfer, seedGenesisMember, createPost, getBalance } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
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
    assert(terms.status === 200 && terms.body?.known === true && /50%/.test(terms.body?.text) && /60 days/.test(terms.body?.text) && /can't see your trades/.test(terms.body?.text),
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
    db.prepare('UPDATE known_consents SET version = ? WHERE member_pubkey = ?').run([Number(wordingNow) - 1, ...leaLines].join(':'), lea.pk);
    const ex5 = await exceptions(ada);
    assert(ex5.status === 200 && !(ex5.body?.exceptions ?? []).some((e: any) => e.memberPubkey === lea.pk),
        `Leander, who agreed to wording ${Number(wordingNow) - 1} and not today's ${wordingNow}, is not listed (${show(ex5)})`);
    db.prepare('UPDATE known_consents SET version = ? WHERE member_pubkey = ?').run(leaRow.version, lea.pk);
    const ex6 = await exceptions(ada);
    assert((ex6.body?.exceptions ?? []).some((e: any) => e.memberPubkey === lea.pk), 'with his consent to today\'s wording, he is listed again');

    // ── 7. Settings (the manager) ────────────────────────────────────────────────────────────────
    console.log('── 7. Settings ──');
    const { handshakeToken } = mintHandshakeToken(ada.pk, 'admin');
    const s = consumeHandshakeToken(handshakeToken);
    const adaSession = { 'X-Admin-Session': s.sessionId! };
    const mgr = await call('GET', null, '/api/local/admin/community-health', undefined, adaSession);
    assert(mgr.status === 200 && mgr.body?.totals?.membersInDebit >= 6 && mgr.body?.settings?.debtLinePct === 5 && mgr.body?.log?.length === 7
        && mgr.body?.exceptions === undefined, `an admin's Settings reads the totals, the lines and the access log, and no exceptions (${show(mgr)})`);
    const mgrO = await call('GET', null, '/api/local/admin/community-health', undefined, owner);
    assert(mgrO.status === 200 && mgrO.body?.known === true, `and the owner's (${show(mgrO)})`);
    const mgrSetA = await call('POST', null, '/api/local/admin/community-health', { debtLinePct: 70 }, adaSession);
    assert(mgrSetA.status === 403, `an admin can't move the lines from Settings (${show(mgrSetA)})`);
    const mgrSet = await call('POST', null, '/api/local/admin/community-health', { debtLinePct: 70 }, owner);
    assert(mgrSet.status === 200 && mgrSet.body?.debtLinePct === 70 && mgrSet.body?.quietDays === 7, `the owner does (${show(mgrSet)})`);
    const mgrM = await call('GET', kim, '/api/local/admin/community-health');
    assert(mgrM.status === 401 || mgrM.status === 403, `a member's signed request is refused (${show(mgrM)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
