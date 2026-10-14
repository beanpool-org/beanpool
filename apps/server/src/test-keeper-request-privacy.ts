/**
 * A keeper join request never hands the applicant's credit-line figure to anyone but the applicant (#1612 review,
 * queue item 33).
 *
 * What a member has left to back an enterprise with (getAvailableBacking) is their unpledged earned credit plus what is
 * left of half their known grant. The known grant is private: an owner or admin may lower or raise it for one member,
 * and a freeze takes it to 0. So the lead keeper, who decides on a request, gets only whether the applicant can still
 * back their pledge; the figure stays on the applicant's own view of their request (myPendingRequest).
 *
 * Over real HTTPS, through the real middleware, with the known-floor dial on:
 *   1. the lead keeper, on the enterprise read and on the requests list: a yes, no figure
 *   2. another keeper, an unrelated member, no one signed in: no request rows, and the list is refused
 *   3. the applicant: their own figure on myPendingRequest, and no one else's rows
 *   4. a node admin (signed), an owner's key session, an admin automation token, the admin password session: never the figure
 *   5. the applicant's known grant lowered below the pledge: the lead keeper sees a no; approving is refused in words
 *      that do not carry the figure, and the applicant still sees their own
 *   6. a sole keeper approves an applicant whose own debt is using their known floor (#1638 review B1): the row said no,
 *      and the refusal carries no balance or floor
 *   7. a two-keeper enterprise, the scheduler refuses the change at the end of its window, on the own-debt lock and on a
 *      freeze (#1638 review B2): the stored reason is in words, and enterprise_keeper_change_resolved reaches the lead
 *      keeper and the applicant over a signed /ws, never an unrelated member's socket; "frozen" reaches no one
 *   8. closed rows carry no canBackPledge (#1638 review NB): no live view of a closed applicant's standing
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'KeeperPrivacy123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import WebSocket from 'ws';
import { initStateEngine, seedGenesisMember, createPost, createTreasury, adminAssignTreasuryOperator, getAvailableBacking, getBalance, applyDueKeeperChanges, transfer } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders, ownerTokenHeaders, turnOn2faForTests } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';

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
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
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
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

function sessionHeaders(pub: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

/** Every keeper request row anywhere in a response: the enterprise read's keeperRequests, the list's requests. */
function requestRows(r: Res): any[] {
    return [...(r.body?.keeperRequests ?? []), ...(r.body?.requests ?? [])];
}

/** True when no keeper request row in the response carries a figure of what the applicant has left to back with. */
function rowsCarryNoFigure(r: Res): boolean {
    return requestRows(r).every(row => !('availableToBack' in row));
}

// ── signed member sockets ───────────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = () => new Promise(r => setTimeout(r, 400));
/** Every event on this socket that names this change. */
const resolvedOn = (s: Sock, changeId: string) => s.events.filter(e => JSON.stringify(e).includes(changeId));
/** The member buys something: the beans go into a purchase's escrow (a direct send needs a completed trade first). */
function spend(from: Id, beans: number): boolean {
    return !!transfer(from.pk, `escrow_${crypto.randomUUID()}`, beans, 'a purchase', 'escrow', true);
}
/** Words a refusal someone else reads must never carry: a figure, or what the figure comes from. */
const leaksStanding = (text: string) => /\d/.test(text) || /frozen|freeze|balance|floor|grant|available/i.test(text);

async function main(): Promise<void> {
    console.log('Keeper join requests: who sees the applicant\'s figure (real HTTPS)\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ownerSession = owner;
    const adminToken = ownerTokenHeaders('admin');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const adaAdmin = sessionHeaders(ada.pk, 'admin');

    const on = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(on.status === 200 && on.body?.confirmation === true, `the owner turns the known-floor dial on (${show(on)})`);

    const lead = makeMember('Lena');
    const otto = makeMember('Otto');
    const ana = makeMember('Ana');
    const sid = makeMember('Sid');
    createPost('offer', 'produce', 'Ana mends nets', 'Nets', 20, 'fixed', ana.pk);
    confirm(ana, lead);

    const ent = createTreasury(`Net Loft ${lead.pk.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
    adminAssignTreasuryOperator(ent, otto.pk, 'admin');

    const figure = getAvailableBacking(ana.pk);
    assert(figure > 5, `precondition: a confirmed applicant with a live offer has backing room from the known grant (${figure})`);

    const asked = await call('POST', ana, `/api/enterprise/${ent}/keepers/request`, { pledgedBacking: 5 });
    assert(asked.status === 200 && asked.body?.success === true, `Ana asks to keep the enterprise with a pledge of 5 (${show(asked)})`);

    const detail = (who: Id | null, extra: Record<string, string> = {}) => call('GET', who, `/api/enterprise/${ent}`, undefined, extra);
    const list = (who: Id | null, extra: Record<string, string> = {}) => call('GET', who, `/api/enterprise/${ent}/keepers/requests?status=pending`, undefined, extra);

    // ── 1. the lead keeper ────────────────────────────────────────────────────────────────────
    console.log('── 1. the lead keeper ──');
    const leadDetail = await detail(lead);
    const leadRow = leadDetail.body?.keeperRequests?.[0];
    assert(leadDetail.status === 200 && leadRow?.memberPubkey === ana.pk, `the lead keeper sees Ana's request on the enterprise (${show(leadDetail)})`);
    assert(leadRow && !('availableToBack' in leadRow), `and it carries no figure of what Ana has left to back with (got ${JSON.stringify(leadRow?.availableToBack)})`);
    assert(leadRow?.canBackPledge === true, `but says yes, Ana can still back her pledge of 5 (got ${JSON.stringify(leadRow?.canBackPledge)})`);
    assert(leadRow?.pledgedBacking === 5, 'and shows the pledge itself, 5');
    assert(leadDetail.body?.myPendingRequest === null, 'the lead keeper has no request of their own');
    const leadList = await list(lead);
    const leadListRow = leadList.body?.requests?.[0];
    assert(leadList.status === 200 && leadListRow?.memberPubkey === ana.pk, `the requests list answers the lead keeper (${show(leadList)})`);
    assert(rowsCarryNoFigure(leadList) && leadListRow?.canBackPledge === true, `with the same yes and no figure (${JSON.stringify(leadListRow)})`);

    // ── 2. another keeper, an unrelated member, no one ─────────────────────────────────────────
    console.log('── 2. another keeper, an unrelated member, no one signed in ──');
    for (const [who, label] of [[otto, 'another keeper'], [sid, 'an unrelated member']] as const) {
        const d = await detail(who);
        assert(d.status === 200 && (d.body?.keeperRequests ?? []).length === 0 && d.body?.myPendingRequest === null,
            `${label} reads the enterprise with no request rows (${show(d)})`);
        const l = await list(who);
        assert(l.status === 403 && requestRows(l).length === 0, `${label} is refused the requests list (${show(l)})`);
    }
    const anon = await detail(null);
    assert(requestRows(anon).length === 0 && !anon.body?.myPendingRequest, `no one signed in gets no request rows (${anon.status})`);
    const anonList = await list(null);
    assert(anonList.status === 401 && requestRows(anonList).length === 0, `no one signed in is refused the list (${show(anonList)})`);

    // ── 3. the applicant ──────────────────────────────────────────────────────────────────────
    console.log('── 3. the applicant ──');
    const anaDetail = await detail(ana);
    const mine = anaDetail.body?.myPendingRequest;
    assert(anaDetail.status === 200 && mine?.memberPubkey === ana.pk, `Ana sees her own request (${show(anaDetail)})`);
    assert(mine?.availableToBack === figure, `with her own figure on it, ${figure} (got ${JSON.stringify(mine?.availableToBack)})`);
    assert(mine?.canBackPledge === true, 'and the same yes the lead keeper sees');
    assert(anaDetail.body?.availableToBack === figure, 'the enterprise read\'s top-level figure is Ana\'s own too');
    assert((anaDetail.body?.keeperRequests ?? []).length === 0, 'and she sees no one\'s request rows');
    const anaList = await list(ana);
    assert(anaList.status === 403, `Ana is refused the requests list (${show(anaList)})`);

    // ── 4. a node admin, an owner's session, a token, the password ─────────────────────────────
    console.log('── 4. admins, sessions and tokens ──');
    const adminDetail = await detail(ada);
    const adminRow = adminDetail.body?.keeperRequests?.[0];
    assert(adminDetail.status === 200 && adminRow?.memberPubkey === ana.pk && rowsCarryNoFigure(adminDetail) && adminRow?.canBackPledge === true,
        `a node admin (signed) sees the request with a yes and no figure (${JSON.stringify(adminRow)})`);
    const adminList = await list(ada);
    assert(adminList.status === 200 && rowsCarryNoFigure(adminList) && adminList.body?.requests?.[0]?.canBackPledge === true,
        `and the same on the list (${show(adminList)})`);

    const twoFa = turnOn2faForTests(process.env.ADMIN_PASSWORD!);
    const viaHeaders: Array<[string, Record<string, string>]> = [
        ['an owner\'s key session', ownerSession],
        ['a node admin\'s key session', adaAdmin],
        ['an admin automation token', adminToken],
        ['the admin password', twoFa.headers()],
    ];
    for (const [label, headers] of viaHeaders) {
        const d = await detail(null, headers);
        const l = await list(null, headers);
        assert(rowsCarryNoFigure(d) && rowsCarryNoFigure(l) && !JSON.stringify(d.body?.myPendingRequest ?? null).includes('availableToBack'),
            `${label}: no request row carries a figure (enterprise ${d.status}, ${requestRows(d).length} rows; list ${l.status}, ${requestRows(l).length} rows)`);
    }

    // ── 5. the applicant's room drops below the pledge ─────────────────────────────────────────
    console.log('── 5. the applicant can no longer back the pledge ──');
    const lowered = await call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: ana.pk, amount: 6 }, adaAdmin);
    assert(lowered.status === 200, `an admin lowers Ana's known floor to 6 (${show(lowered)})`);
    const lowFigure = getAvailableBacking(ana.pk);
    assert(lowFigure < 5, `precondition: Ana now has less than her pledge of 5 to back with (${lowFigure})`);
    const leadAfter = await detail(lead);
    const rowAfter = leadAfter.body?.keeperRequests?.[0];
    assert(rowAfter?.canBackPledge === false && !('availableToBack' in rowAfter), `the lead keeper sees a no, still with no figure (${JSON.stringify(rowAfter)})`);
    const listAfter = await list(lead);
    assert(listAfter.body?.requests?.[0]?.canBackPledge === false && rowsCarryNoFigure(listAfter), 'and the same no on the list');
    const approve = await call('POST', lead, `/api/enterprise/${ent}/keepers/requests/${rowAfter?.id}/approve`, {});
    const approveError = String(approve.body?.error ?? '');
    assert(approve.status >= 400 && /standing doesn't cover this pledge/.test(approveError),
        `approving is refused (${show(approve)})`);
    assert(!new RegExp(`\\(${lowFigure} available\\)|\\b${lowFigure} available`).test(approveError) && !/\(\d+ available\)/.test(approveError),
        `and the refusal the lead keeper reads does not carry Ana's figure (${approveError})`);
    const anaAfter = await detail(ana);
    assert(anaAfter.body?.myPendingRequest?.availableToBack === lowFigure && anaAfter.body?.myPendingRequest?.canBackPledge === false,
        `Ana still sees her own figure, ${lowFigure}, and the no (${JSON.stringify(anaAfter.body?.myPendingRequest)})`);

    // ── 6. sole keeper, the applicant's own debt is using their known floor ────────────────────────
    console.log('── 6. sole keeper: the own-debt lock refuses with no figure ──');
    const solo = createTreasury(`Rope Walk ${lead.pk.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
    const bea = makeMember('Bea');
    createPost('offer', 'produce', 'Bea splices rope', 'Rope', 20, 'fixed', bea.pk);
    confirm(bea, lead);
    const beaAsk = await call('POST', bea, `/api/enterprise/${solo}/keepers/request`, { pledgedBacking: 400 });
    assert(beaAsk.status === 200, `Bea asks to keep a one-keeper enterprise with a pledge of 400 (${show(beaAsk)})`);
    const beaSpent = spend(bea, 700);
    const beaBalance = getBalance(bea.pk).balance;
    assert(beaSpent && beaBalance === -700 && getAvailableBacking(bea.pk) >= 400,
        `precondition: Bea spends 700 (balance ${beaBalance}) and still has room for 400 on paper (${getAvailableBacking(bea.pk)})`);
    const soloList = await call('GET', lead, `/api/enterprise/${solo}/keepers/requests?status=pending`);
    const soloRow = soloList.body?.requests?.[0];
    assert(soloRow?.memberPubkey === bea.pk && soloRow?.canBackPledge === false && rowsCarryNoFigure(soloList),
        `the lead keeper's row says no, since approving would be refused (${JSON.stringify(soloRow)})`);
    const soloApprove = await call('POST', lead, `/api/enterprise/${solo}/keepers/requests/${soloRow?.id}/approve`, {});
    const soloError = String(soloApprove.body?.error ?? '');
    assert(soloApprove.status === 400 && /standing doesn't cover this pledge/.test(soloError), `the sole keeper's Approve is refused (${show(soloApprove)})`);
    assert(!leaksStanding(soloError), `and the refusal carries no figure, balance, floor or freeze (${soloError})`);
    const beaOwn = await call('GET', bea, `/api/enterprise/${solo}`);
    assert(beaOwn.body?.myPendingRequest?.canBackPledge === false && typeof beaOwn.body?.myPendingRequest?.availableToBack === 'number',
        `Bea still sees her own request, with her own figure (${JSON.stringify(beaOwn.body?.myPendingRequest)})`);

    // ── 7. two keepers, the scheduler refuses at the end of the window ─────────────────────────────
    console.log('── 7. two keepers: a failed change tells only the lead keeper and the applicant, in words ──');
    const pair = createTreasury(`Sail Loft ${lead.pk.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
    adminAssignTreasuryOperator(pair, otto.pk, 'admin');
    const cal = makeMember('Cal');
    createPost('offer', 'produce', 'Cal sews sails', 'Sails', 20, 'fixed', cal.pk);
    confirm(cal, lead);
    const dee = makeMember('Dee');
    createPost('offer', 'produce', 'Dee tars hulls', 'Tar', 20, 'fixed', dee.pk);
    confirm(dee, lead);
    const socks = { lead: await socket(lead), cal: await socket(cal), dee: await socket(dee), sid: await socket(sid) };

    const calAsk = await call('POST', cal, `/api/enterprise/${pair}/keepers/request`, { pledgedBacking: 400 });
    const calApprove = await call('POST', lead, `/api/enterprise/${pair}/keepers/requests/${calAsk.body?.request?.id ?? calAsk.body?.id}/approve`, {});
    const calChange = calApprove.body?.change?.id;
    assert(calApprove.status === 200 && calApprove.body?.applied === false && !!calChange,
        `the lead keeper approves Cal's pledge of 400 and the objection window opens (${show(calApprove)})`);
    spend(cal, 700);
    assert(getBalance(cal.pk).balance === -700, `precondition: Cal spends 700 inside the window (${getBalance(cal.pk).balance})`);

    const deeAsk = await call('POST', dee, `/api/enterprise/${pair}/keepers/request`, { pledgedBacking: 5 });
    const deeApprove = await call('POST', lead, `/api/enterprise/${pair}/keepers/requests/${deeAsk.body?.request?.id ?? deeAsk.body?.id}/approve`, {});
    const deeChange = deeApprove.body?.change?.id;
    assert(deeApprove.status === 200 && !!deeChange, `the lead keeper approves Dee's pledge of 5 (${show(deeApprove)})`);
    db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(dee.pk);

    for (const s of Object.values(socks)) s.events.length = 0;
    const due = applyDueKeeperChanges(pair, Date.now() + 4 * DAY);
    assert(due.failed === 2 && due.applied === 0, `the scheduler refuses both changes at the end of the window (${JSON.stringify(due)})`);
    await settle();
    const reasonOf = (id: string) => String((db.prepare('SELECT reason FROM enterprise_keeper_changes WHERE id = ?').get(id) as any)?.reason ?? '');
    for (const [label, id] of [['Cal (own-debt lock)', calChange], ['Dee (frozen)', deeChange]] as const) {
        const reason = reasonOf(id);
        assert(reason.length > 0 && !leaksStanding(reason), `${label}: the stored reason is in words, no figure and no freeze (${reason})`);
        const toSid = [...resolvedOn(socks.sid, id), ...socks.sid.events.filter(e => e?.type === 'enterprise_keeper_change_resolved')];
        assert(toSid.length === 0, `${label}: an unrelated member's socket hears nothing of it (${JSON.stringify(toSid)})`);
        const toLead = resolvedOn(socks.lead, id).filter(e => e.changeId === id);
        assert(toLead.length === 1 && toLead[0].status === 'failed' && !leaksStanding(String(toLead[0].reason ?? '')),
            `${label}: the lead keeper hears it failed, in words (${JSON.stringify(toLead)})`);
    }
    const toCal = resolvedOn(socks.cal, calChange).filter(e => e.changeId === calChange);
    assert(toCal.length === 1 && resolvedOn(socks.cal, deeChange).length === 0, `Cal hears of his own change and not of Dee's (${JSON.stringify(socks.cal.events)})`);
    const toDee = resolvedOn(socks.dee, deeChange).filter(e => e.changeId === deeChange);
    assert(toDee.length === 1 && resolvedOn(socks.dee, calChange).length === 0, `Dee hears of her own change and not of Cal's (${JSON.stringify(socks.dee.events)})`);
    const everywhere = JSON.stringify(Object.entries(socks).filter(([k]) => k !== 'dee').map(([, s]) => s.events));
    assert(!/frozen|freeze/i.test(everywhere), 'no socket but Dee\'s carries a word of her freeze');
    for (const s of Object.values(socks)) s.ws.close();

    // ── 8. closed rows carry no live bit ─────────────────────────────────────────────────────────
    console.log('── 8. closed rows: no canBackPledge ──');
    const all = await call('GET', lead, `/api/enterprise/${pair}/keepers/requests`);
    const closed = (all.body?.requests ?? []).filter((r: any) => r.status !== 'pending');
    assert(all.status === 200 && closed.length === 2 && closed.every((r: any) => r.canBackPledge === null) && rowsCarryNoFigure(all),
        `the two cancelled rows carry canBackPledge null (${JSON.stringify(closed.map((r: any) => [r.status, r.canBackPledge]))})`);
    db.prepare('UPDATE members SET credit_frozen = 0 WHERE public_key = ?').run(dee.pk);
    const allAfter = await call('GET', lead, `/api/enterprise/${pair}/keepers/requests`);
    assert((allAfter.body?.requests ?? []).filter((r: any) => r.status !== 'pending').every((r: any) => r.canBackPledge === null),
        'and still null once Dee\'s freeze is lifted: the lead keeper cannot watch it end');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error(e); process.exit(1); });
