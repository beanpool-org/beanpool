/**
 * A member asks an admin to invite someone (Marty, 3 Nov), through the real HTTPS stack and its signature middleware.
 *
 *  1. Who may ask: only a member in good standing, only where the door is `admins` and invites are on.
 *  2. What an ask holds: two lines, required, length-limited, plain, no phone number and no email.
 *  3. The limits: 3 waiting and 3 a day, in words; asking and taking back still counts.
 *  4. Who is told: owners and admins, a count and no name; a moderator and a member are not; an older app is not.
 *  5. Who reads: owners and admins only, by role on a signature; a token alone reaches nothing.
 *  6. Send invite: an ordinary invite by the admin, with the vouch choice; the code goes to the member; the request is gone.
 *  7. No: a short reason, to the member; the request is gone.
 *  8. Take it back: only your own.
 *  9. After 30 days: gone, and never listed past it.
 * 10. Where it goes: not in a log, the assistant's reads or a member directory; a push or notice holds no code or name.
 * 11. A standby: refuses writes, reads its copy, and a deleted row leaves it.
 * 12. A re-key moves an ask; removing a member takes theirs.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-invite-asks.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, adminPruneUser, adminSetVoucher, setUserStatusRow, purgeMemberSelf, COMMUNITY_DECISION_ACTOR } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { setNodeRole } from './config/node-role.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { setDoor } from './config/door.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { TABLES } from './engine/replication-manifest.js';
import { deletePlainRow } from './engine/plain-tables.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { AGENT_TOOLS } from './agent/tools.js';
import { _forgetAskTimesForTests, tidyInviteAsks } from './engine/invite-asks.js';
import { getAdminQueue } from './engine/admin-queue.js';
import { issueAutomationToken } from './automation-tokens.js';
import { ownerAdminLimit } from './engine/owner-admin-limit.js';

let BASE = '';
const ADMIN_PW = 'Invite-Asks-Admin-Pw-71!';
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
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 200)}` : '-');

const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const ask = (id: Id, firstName: unknown = 'Sam', howKnown: unknown = 'Sam runs the bakery on my street') => call(id, 'POST', '/api/invite/asks', { firstName, howKnown });
const mine = (id: Id) => call(id, 'GET', '/api/invite/asks/mine');
const asks = (id: Id) => call(id, 'GET', '/api/invite/asks');
const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM invite_asks').get() as { n: number }).n;
const tombstone = (id: string) => db.prepare(`SELECT row_key FROM tombstones WHERE table_name = 'invite_asks' AND row_key = ?`).get(id) as { row_key: string } | undefined;
const clear = () => { db.prepare('DELETE FROM invite_asks').run(); db.prepare('DELETE FROM moderation_notices').run(); _forgetAskTimesForTests(); };
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, mod, mel, pat, gus] = ['Ada', 'Mod', 'Mel', 'Pat', 'Gus'].map(newId);
    for (const who of [ada, mod, mel, pat, gus]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }

    // ── 1. Who may ask ───────────────────────────────────────────────────────────────────────────
    console.log('── 1. who may ask ──');
    const onMembersDoor = await ask(mel);
    assert(onMembersDoor.status === 409 && onMembersDoor.body?.code === 'door_not_admins' && rows() === 0, `1. on the members door any member invites: refused, nothing kept (${show(onMembersDoor)})`);
    setDoor('admins');
    const made = await ask(mel);
    assert(made.status === 201 && made.body?.ask?.firstName === 'Sam' && rows() === 1, `1. where only admins invite, a member asks (${show(made)})`);
    const unsigned = await call(null, 'POST', '/api/invite/asks', { firstName: 'Sam', howKnown: 'x' });
    assert(unsigned.status === 401, `1. unsigned: 401 (${show(unsigned)})`);
    const stranger = await ask(newId('Stranger'));
    assert(stranger.status === 403 && stranger.body?.code === 'not_member', `1. a key that is no member: 403 (${show(stranger)})`);
    const spoof = await call(mel, 'POST', '/api/invite/asks', { publicKey: gus.pk, firstName: 'Sam', howKnown: 'x' });
    assert(spoof.status >= 400 && spoof.status < 500, `1. a body naming another key: refused (${show(spoof)})`);
    const adminAsks = await ask(ada);
    assert(adminAsks.status === 409 && adminAsks.body?.code === 'may_invite', `1. an admin makes the invite themselves (${show(adminAsks)})`);
    const ownerAsks = await ask(owen);
    assert(ownerAsks.status === 409 && ownerAsks.body?.code === 'may_invite', `1. so does an owner (${show(ownerAsks)})`);
    const modAsks = await ask(mod);
    assert(modAsks.status === 201, `1. a moderator can't invite here, so they can ask (${show(modAsks)})`);
    setUserStatusRow(pat.pk, 'disabled');
    const paused = await ask(pat);
    assert(paused.status === 403 && /paused/i.test(paused.body?.error ?? ''), `1. a paused member can't ask, and is told (${show(paused)})`);
    setUserStatusRow(pat.pk, 'active');
    setOverride('invites', 'false');
    const invitesOff = await ask(mel);
    assert(invitesOff.status === 404 && invitesOff.body?.code === 'feature_off', `1. invites off: 404 feature_off (${show(invitesOff)})`);
    const info = await call(null, 'GET', '/api/community/info');
    assert(info.body?.features?.inviteAsks === false, `1. and the node says so, so no app offers it (${JSON.stringify(info.body?.features?.inviteAsks)})`);
    dropOverride('invites');
    const infoOn = await call(null, 'GET', '/api/community/info');
    assert(infoOn.body?.features?.inviteAsks === true && infoOn.body?.features?.door === 'admins', '1. invites on: the node says it takes them, and the door');
    clear();

    // ── 2. What an ask holds ─────────────────────────────────────────────────────────────────────
    console.log('── 2. what an ask holds ──');
    for (const [first, how, label] of [['', 'x', 'no name'], ['Sam', '', 'no line'], ['   ', 'x', 'a blank name'], [undefined, 'x', 'a missing name'], ['Sam', 7, 'a number']] as const) {
        const r = await ask(mel, first ?? null, how);
        assert(r.status === 400 && r.body?.code === 'bad_request', `2. ${label}: 400 (${show(r)})`);
    }
    const longName = await ask(mel, 'x'.repeat(31));
    assert(longName.status === 400 && longName.body?.code === 'too_long' && /30/.test(longName.body?.error), `2. a name past 30: said in words (${show(longName)})`);
    const longLine = await ask(mel, 'Sam', 'y'.repeat(141));
    assert(longLine.status === 400 && longLine.body?.code === 'too_long' && /140/.test(longLine.body?.error), `2. a line past 140: said in words (${show(longLine)})`);
    for (const [first, how, label] of [['Sam', 'call 0412 345 678', 'a phone number'], ['sam@example.org', 'the bakery', 'an email address'], ['Sam', 'try +61 (0)2 9999-1234', 'a spaced phone number']] as const) {
        const r = await ask(mel, first, how);
        assert(r.status === 400 && r.body?.code === 'contact_details' && rows() === 0, `2. ${label} is left out of a request: refused (${show(r)})`);
    }
    const years = await ask(mel, 'Sam', 'friends since 2019-2023, met at 12 Main St');
    assert(years.status === 201, `2. a span of years and a house number are no phone number (${show(years)})`);
    clear();
    const hidden = await ask(mel, 'S​am‮', '  from\n\nthe  bakery\u0000 ');
    const heldRow = db.prepare('SELECT first_name, how_known FROM invite_asks').get() as { first_name: string; how_known: string } | undefined;
    assert(hidden.status === 201 && heldRow?.first_name === 'Sam' && heldRow?.how_known === 'from the bakery', `2. hidden characters and line breaks go (${JSON.stringify(heldRow)})`);
    clear();
    const markup = await ask(mel, '<b>Sam</b>', '<img src=x onerror=alert(1)>');
    const list = await asks(owen);
    assert(markup.status === 201 && list.body?.asks?.[0]?.firstName === '<b>Sam</b>', '2. markup is kept as the plain text it is, for the apps to show as text');
    clear();

    // ── 3. The limits ────────────────────────────────────────────────────────────────────────────
    console.log('── 3. limits ──');
    for (const n of [1, 2, 3]) assert((await ask(mel, `Sam${n}`)).status === 201, `3. ask ${n} of 3`);
    const fourth = await ask(mel, 'Sam4');
    assert(fourth.status === 429 && fourth.body?.code === 'too_many_waiting' && /3 asks waiting/.test(fourth.body?.error), `3. a fourth waiting: 429, in words (${show(fourth)})`);
    const someone = (await mine(mel)).body?.waiting?.[0]?.id;
    assert((await call(mel, 'POST', `/api/invite/asks/${someone}/withdraw`)).status === 200, '3. one taken back');
    const stillToday = await ask(mel, 'Sam5');
    assert(stillToday.status === 429 && stillToday.body?.code === 'asked_enough_today' && /3 times today/.test(stillToday.body?.error), `3. it still counts towards the day: a member can't ask and take back for ever (${show(stillToday)})`);
    assert((await ask(pat)).status === 201, "3. one member's limit is not another's");
    _forgetAskTimesForTests();
    const nextDay = await ask(mel, 'Sam6');
    assert(nextDay.status === 201, `3. the day's count over, they can ask (${show(nextDay)})`);
    clear();

    // ── 4. Who is told ───────────────────────────────────────────────────────────────────────────
    console.log('── 4. who is told ──');
    require_((await ask(mel, 'Quentin', 'Quentin mends bikes')).status === 201, 'Mel asks');
    const home = (id: Id, lands = 'enterprise,group,invite,people,asks') => call(id, 'GET', `/api/home?cards=needs&lands=${lands}`);
    const line = (r: Res) => (r.body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'ask');
    for (const [who, label] of [[owen, 'an owner'], [ada, 'an admin']] as const) {
        const l = line(await home(who));
        assert(l?.count === 1 && l?.target?.to === 'people' && !/Quentin|Mel/.test(JSON.stringify(l)), `4. ${label}'s Needs you: a count, landing on People, no name (${JSON.stringify(l)})`);
    }
    assert(!line(await home(mod)), "4. not a moderator's");
    assert(!line(await home(mel)), "4. not a member's");
    assert(!line(await home(owen, 'enterprise,group,invite,people')), '4. nor an older app, which has nowhere to answer it');
    const queue = await call(owen, 'GET', '/api/node-admin/queue?asks=1');
    assert(queue.body?.items?.find((i: any) => i.kind === 'invite_asks')?.count === 1, `4. the header's queue says it (${show(queue)})`);
    const oldQueue = await call(owen, 'GET', '/api/node-admin/queue');
    assert(!oldQueue.body?.items?.some((i: any) => i.kind === 'invite_asks'), "4. an older app's queue doesn't");
    setDoor('members');
    assert(!line(await home(owen)) && (await asks(owen)).body?.total === 1, '4. once any member may invite, Needs you stops counting it, and an admin can still read it');
    setDoor('admins');
    const modQueue = await call(mod, 'GET', '/api/node-admin/queue?asks=1');
    assert(!modQueue.body?.items?.some((i: any) => i.kind === 'invite_asks'), "4. nor a moderator's, whatever it asks");

    // ── 5. Who reads ─────────────────────────────────────────────────────────────────────────────
    console.log('── 5. who reads ──');
    const owenReads = await asks(owen);
    assert(owenReads.status === 200 && owenReads.body?.total === 1 && owenReads.body?.asks?.[0]?.askerCallsign === 'Mel' && owenReads.body?.asks?.[0]?.howKnown === 'Quentin mends bikes', `5. an owner reads it, naming who asked (${show(owenReads)})`);
    assert((await asks(ada)).status === 200, '5. an admin reads it');
    const modReads = await asks(mod);
    assert(modReads.status === 403 && modReads.body?.code === 'admins_only' && !/Quentin/.test(modReads.text), `5. a moderator doesn't (${show(modReads)})`);
    const melReads = await asks(mel);
    assert(melReads.status === 403 && !/Quentin/.test(melReads.text), `5. nor a member, even the one who asked (${show(melReads)})`);
    const askId = owenReads.body?.asks?.[0]?.id as string;
    const issued = issueAutomationToken({ name: 'suite', scope: 'admin', createdBy: owen.pk }) as any;
    const token = issued.token ?? issued.plaintext ?? issued.secret;
    require_(typeof token === 'string', 'an admin token is made');
    for (const [method, path] of [['GET', '/api/invite/asks'], ['POST', `/api/invite/asks/${askId}/send`], ['POST', `/api/invite/asks/${askId}/no`]] as const) {
        const r = await call(null, method, path, {}, { Authorization: `Bearer ${token}`, 'X-Admin-Token': token });
        assert(r.status === 401, `5. a token alone reaches nothing: ${method} ${path.replace(askId, ':id')} (${show(r)})`);
    }
    for (const [who, label] of [[mod, 'a moderator'], [mel, 'the member who asked']] as const) {
        for (const verb of ['send', 'no']) {
            const r = await call(who, 'POST', `/api/invite/asks/${askId}/${verb}`, {});
            assert(r.status === 403 && r.body?.code === 'admins_only', `5. ${label} can't ${verb} (${show(r)})`);
        }
    }
    db.prepare(`DELETE FROM node_roles WHERE member_pubkey = ?`).run(ada.pk);
    const stoodDown = await call(ada, 'POST', `/api/invite/asks/${askId}/no`, {});
    assert(stoodDown.status === 403, `5. an admin stood down can't answer: the role now, not a claim (${show(stoodDown)})`);
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ada.pk, role: 'admin' }, PASSWORD())).status === 200, 'Ada is admin again');
    assert(rows() === 1, '5. and none of those touched the ask');

    // ── 6. Send invite ───────────────────────────────────────────────────────────────────────────
    console.log('── 6. send invite ──');
    const beforeCodes = (db.prepare('SELECT COUNT(*) AS n FROM invite_codes').get() as { n: number }).n;
    const badVouch = await call(ada, 'POST', `/api/invite/asks/${askId}/send`, { vouchLevel: 9 });
    assert(badVouch.status === 400 && badVouch.body?.code === 'bad_vouch_level' && rows() === 1, `6. a refused vouch makes no invite and keeps the ask (${show(badVouch)})`);
    assert((db.prepare('SELECT COUNT(*) AS n FROM invite_codes').get() as { n: number }).n === beforeCodes, '6. no code made');
    adminSetVoucher(ada.pk, true);
    const sent = await call(ada, 'POST', `/api/invite/asks/${askId}/send`, { vouchLevel: 2 });
    assert(sent.status === 200 && rows() === 0 && !!tombstone(askId), `6. the request is deleted, with a tombstone (${show(sent)})`);
    const answered = await mine(mel);
    const answer = answered.body?.answers?.[0];
    assert(answered.status === 200 && answered.body?.waiting?.length === 0 && answer?.outcome === 'invited' && answer?.state === 'ready' && typeof answer?.code === 'string', `6. the code goes back to the member (${show(answered)})`);
    const invite = db.prepare('SELECT created_by, intended_for, vouch_level, names_entry_id FROM invite_codes WHERE code = ?').get(answer?.code) as any;
    assert(invite?.created_by === ada.pk && invite?.intended_for === null && invite?.vouch_level === 2 && invite?.names_entry_id === null, `6. an ordinary invite by the admin, with the vouch, naming nobody (${JSON.stringify(invite)})`);
    const noticeRow = db.prepare('SELECT title, body, data FROM moderation_notices WHERE recipient = ?').get(mel.pk) as { title: string; body: string; data: string };
    assert(!/Quentin|bikes/.test(JSON.stringify(noticeRow)), `6. nothing of the request remains in the answer (${JSON.stringify(noticeRow)})`);
    assert(!noticeRow.title.includes(answer.code) && !noticeRow.body.includes(answer.code) && !/Ada/.test(JSON.stringify(noticeRow)), "6. the notice's words hold no code, and name no admin");
    const again = await call(owen, 'POST', `/api/invite/asks/${askId}/send`, {});
    assert(again.status === 404 && again.body?.code === 'not_found', `6. a second answer finds nothing, and makes no second invite (${show(again)})`);
    const newcomer = newId('Quentin');
    const joined = await redeem(newcomer, answer.code);
    assert(joined.status === 200, `6. someone joins with the code as with any invite (${show(joined)})`);
    assert((await mine(mel)).body?.answers?.[0]?.state === 'used' && (await mine(mel)).body?.answers?.[0]?.code === undefined, '6. the member sees it was used, and the code is off the screen');
    clear();
    require_((await ask(mel, 'Rae')).status === 201, 'Mel asks again');
    const raeId = (await asks(owen)).body?.asks?.[0]?.id;
    setOverride('invites', 'false');
    const offSend = await call(owen, 'POST', `/api/invite/asks/${raeId}/send`, {});
    assert(offSend.status === 404 && offSend.body?.code === 'feature_off', `6. invites switched off: no answer, as no invite (${show(offSend)})`);
    assert(getAdminQueue({ forOwner: true, inviteAsks: true }).items.every((i) => i.kind !== 'invite_asks'), '6. and no count of what nothing can answer');
    dropOverride('invites');
   
    const limit = ownerAdminLimit(owen.pk)!;
    const stamp = new Date().toISOString();
    const fill = db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < limit + 1; i++) fill.run(`INV-FILL-${i}`, owen.pk, stamp); })();
    const overLimit = await call(owen, 'POST', `/api/invite/asks/${raeId}/send`, {});
    assert(overLimit.status === 429 && /limit|invites/i.test(overLimit.body?.error ?? '') && rows() === 1, `6. an admin past their invites a day: the same limit, in words, and the ask stays (${show(overLimit)})`);
    assert((await mine(mel)).body?.answers?.length === 0, '6. and the member is told nothing');
    db.prepare("DELETE FROM invite_codes WHERE code LIKE 'INV-FILL-%'").run();
    clear();

    // ── 7. No ────────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. no ──');
    require_((await ask(mel, 'Tess')).status === 201, 'Mel asks');
    const tessId = (await asks(owen)).body?.asks?.[0]?.id;
    const longNo = await call(owen, 'POST', `/api/invite/asks/${tessId}/no`, { reason: 'z'.repeat(101) });
    assert(longNo.status === 400 && longNo.body?.code === 'too_long' && rows() === 1, `7. a reason past 100: said in words, the ask stays (${show(longNo)})`);
    const said = await call(owen, 'POST', `/api/invite/asks/${tessId}/no`, { reason: 'We​ don’t know "them" yet\n<b>' });
    assert(said.status === 200 && rows() === 0 && !!tombstone(tessId), `7. the request is deleted, with a tombstone (${show(said)})`);
    const told = (await mine(mel)).body?.answers?.[0];
    assert(told?.outcome === 'no' && told?.reason === 'We don’t know "them" yet <b>' && told?.code === undefined, `7. the member is told, the reason as plain text (${JSON.stringify(told)})`);
    const noticeNo = db.prepare('SELECT title, body FROM moderation_notices WHERE recipient = ?').get(mel.pk) as { title: string; body: string };
    assert(!/know/.test(`${noticeNo.title}${noticeNo.body}`), "7. the reason isn't in the notice's words, so it reaches no alert or Home line");
    clear();
    require_((await ask(mel, 'Uma')).status === 201, 'Mel asks');
    const umaId = (await asks(owen)).body?.asks?.[0]?.id;
    assert((await call(owen, 'POST', `/api/invite/asks/${umaId}/no`, {})).status === 200 && (await mine(mel)).body?.answers?.[0]?.reason === undefined, '7. a No can carry no reason at all');
    const worstReason = '"'.repeat(100);
    clear();
    require_((await ask(mel, 'Vi')).status === 201, 'Mel asks');
    const viId = (await asks(owen)).body?.asks?.[0]?.id;
    const worst = await call(owen, 'POST', `/api/invite/asks/${viId}/no`, { reason: worstReason });
    assert(worst.status === 200 && (await mine(mel)).body?.answers?.[0]?.reason === worstReason, `7. the longest reason, all escapes, still fits a notice (${show(worst)})`);
    clear();

    // ── 8. Take it back ──────────────────────────────────────────────────────────────────────────
    console.log('── 8. take it back ──');
    require_((await ask(mel, 'Wyn')).status === 201, 'Mel asks');
    const wynId = (await mine(mel)).body?.waiting?.[0]?.id;
    const notYours = await call(gus, 'POST', `/api/invite/asks/${wynId}/withdraw`, {});
    assert(notYours.status === 404 && rows() === 1, `8. someone else's reads as none (${show(notYours)})`);
    const adminTakes = await call(owen, 'POST', `/api/invite/asks/${wynId}/withdraw`, {});
    assert(adminTakes.status === 404 && rows() === 1, `8. an owner's too: they answer, they don't take back (${show(adminTakes)})`);
    const back = await call(mel, 'POST', `/api/invite/asks/${wynId}/withdraw`, {});
    assert(back.status === 200 && rows() === 0 && !!tombstone(wynId), `8. their own goes, with a tombstone (${show(back)})`);
    assert((await asks(owen)).body?.total === 0, '8. and the admins no longer see it');
    assert((await call(mel, 'POST', `/api/invite/asks/${wynId}/withdraw`, {})).status === 404, '8. twice: nothing to take back');
    clear();

    // ── 9. After 30 days ─────────────────────────────────────────────────────────────────────────
    console.log('── 9. after 30 days ──');
    require_((await ask(mel, 'Xan')).status === 201, 'Mel asks');
    const xanId = (await mine(mel)).body?.waiting?.[0]?.id;
    db.prepare('UPDATE invite_asks SET asked_at = ? WHERE id = ?').run(new Date(Date.now() - 29 * 86_400_000).toISOString(), xanId);
    assert((await asks(owen)).body?.total === 1 && tidyInviteAsks() === 0, '9. at 29 days it waits');
    db.prepare('UPDATE invite_asks SET asked_at = ? WHERE id = ?').run(new Date(Date.now() - 30.1 * 86_400_000).toISOString(), xanId);
    assert((await asks(owen)).body?.total === 0 && (await mine(mel)).body?.waiting?.length === 0, '9. past 30 days nobody reads it, whenever the tidy-up runs');
    assert(tidyInviteAsks() === 1 && rows() === 0 && !!tombstone(xanId), '9. the tidy-up deletes it, with a tombstone');
    clear();

    // ── 10. Where it goes ────────────────────────────────────────────────────────────────────────
    console.log('── 10. where it goes ──');
    const logged: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    const made10 = await ask(mel, 'Yusuf', 'Yusuf teaches at the school');
    const ansId = (await asks(owen)).body?.asks?.[0]?.id;
    await call(owen, 'POST', `/api/invite/asks/${ansId}/no`, { reason: 'Zebra crossing reason' });
    Object.assign(console, real);
    assert(made10.status === 201 && !logged.some((l) => /Yusuf|teaches|Zebra/.test(l)), `10. no log line holds the text (${logged.length} lines read)`);
    require_((await ask(mel, 'Yusuf', 'Yusuf teaches at the school')).status === 201, 'Mel asks');
    const overview = AGENT_TOOLS.find((t) => t.name === 'node_overview')!;
    const toolAnswer = await overview.run({ id: 'g', role: 'owner', memberPubkey: owen.pk } as any, {}, 'boundary');
    assert(!/Yusuf|teaches|invite_asks/.test(JSON.stringify(toolAnswer)), `10. the assistant's overview holds no ask, not even a count (${JSON.stringify(toolAnswer).slice(0, 160)})`);
    assert(!AGENT_TOOLS.some((t) => /invite.?ask/i.test(t.name)), '10. and it has no tool that reads one');
    const directory = await call(owen, 'GET', '/api/members');
    assert(!/Yusuf/.test(directory.text), '10. not in the members list');
    const copy = await exportSyncState('test-invite-asks') as any;
    const copied = copy.plainTables?.invite_asks as any[] | undefined;
    assert(copied?.length === 1 && Object.keys(copied[0]).sort().join() === 'asked_at,asker_pubkey,first_name,how_known,id,updated_at', `10. a standby's copy holds these fields and no others (${Object.keys(copied?.[0] ?? {}).sort().join()})`);
    assert((TABLES.invite_asks as any)?.kind === 'replicated' && (TABLES.invite_asks as any)?.plain === true, '10. the manifest says so');

    // ── 11. A standby ────────────────────────────────────────────────────────────────────────────
    console.log('── 11. a standby ──');
    const yId = (await mine(mel)).body?.waiting?.[0]?.id;
    setNodeRole('backup');
    const onStandby = [await ask(gus, 'Zed'), await call(mel, 'POST', `/api/invite/asks/${yId}/withdraw`, {}), await call(owen, 'POST', `/api/invite/asks/${yId}/send`, {}), await call(owen, 'POST', `/api/invite/asks/${yId}/no`, {})];
    assert(onStandby.every((r) => r.status === 503 && r.body?.code === 'standby') && rows() === 1, `11. a standby refuses all four writes (${onStandby.map((r) => r.status).join()})`);
    assert((await mine(mel)).body?.waiting?.length === 1 && (await asks(owen)).body?.total === 1, '11. and reads from its copy');
    setNodeRole('primary');
    assert(deletePlainRow('invite_asks', yId) === true && rows() === 0, "11. a tombstone's delete takes a standby's copy of the row");

    // ── 12. A re-key, and a member leaving ───────────────────────────────────────────────────────
    console.log('── 12. a re-key, and a member leaving ──');
    clear();
    require_((await ask(mel, 'Ada')).status === 201, 'Mel asks');
    const replacement = newId('Mel2');
    moveMemberKeyRows(mel.pk, replacement.pk, new Date().toISOString(), { keepStamps: false });
    assert((await mine(replacement)).body?.waiting?.length === 1, '12. a re-key moves the ask to the new key');
    moveMemberKeyRows(replacement.pk, mel.pk, new Date().toISOString(), { keepStamps: false });
    const prunedAsk = (await mine(mel)).body?.waiting?.[0]?.id;
    adminPruneUser(mel.pk, COMMUNITY_DECISION_ACTOR);
    assert(rows() === 0 && !!tombstone(prunedAsk), '12. removing a member takes their asks, with a tombstone');
    require_((await ask(pat, 'Zoe')).status === 201, 'Pat asks');
    const leftAsk = (await mine(pat)).body?.waiting?.[0]?.id;
    purgeMemberSelf(pat.pk);
    assert(rows() === 0 && !!tombstone(leftAsk), '12. so does a member deleting their own account');

    setDoor('members');
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
