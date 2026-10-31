/**
 * Pause chains (removal by vote S4: scratch/fable-design/DESIGN-removal-by-vote-fable.md §3.4, "Abuse case: a pause chain";
 * Marty 23 Oct "Accept all", 24 Oct "YES to all five"). The rules are enforced where every pause is made (decisions-engine.ts
 * pauseMember, which an admin's suspension and a report's both call); this suite reaches them through the real routes.
 *
 * Boots the real server; every request goes over HTTPS through the real signature middleware and real admin sessions (an
 * admin's key session, an owner's from a computer and from the phone's Manage hand-off, an owner's automation token, and
 * the password with a 2FA code). Expo and the owners' alert channel (a stand-in ntfy on loopback) are answered here:
 * nothing leaves this machine.
 *
 *  1. Within 30 days of a vote that ended without removing a member (the community said No), another admin can't pause
 *     them: refused in the design's words, with the day it ended and the day it lifts, by the route, through a report and
 *     in the engine, and nothing is written. The admin who brought that vote still meets the cool-down first, which now
 *     says an owner can. An owner can, with a new reason: the same reason, trimmed, is refused. That pause's card says
 *     "Second pause in 30 days. The last vote said No.", in its record and to members. The routes ask it what they ask
 *     a co-owner's pause, by the suspend route and through a report: an owner's automation token is refused it, and an
 *     owner's phone hand-off 10 minutes after its unlock is asked to press Manage again; pressed just now, it is made.
 *  2. A third pause within 90 days of the first is refused to everyone, an owner from the phone, an owner's automation
 *     token and the server's password too, by the route, through a report and in the engine; a member with standing can
 *     still propose a Decision on them. Once the first is 90 days old, an owner may pause them again.
 *  3. The other endings: too few voted (an admin's refusal says so, never that the community decided, and so does an
 *     owner's second pause on its card), a vote stopped before it closed (its own words, and its card), a removal the
 *     community passed that an admin halted in its window (no owner needed: the community agreed with that case), and
 *     31 days on (an admin may again, and the card says nothing).
 *  4. The owners are told of every pause: one counted line a day by who acted (an admin, an owner, the admin password),
 *     on the channel and pushed to the owners only; a pause that held a role aside is told by its role line alone, pushed
 *     once; a refused pause tells nothing; with votes off a pause is told too. Nothing names the member or the case.
 *  5. The tripwire: an admin with 5 pauses whose votes are still open is refused a sixth (route, report, engine), nothing
 *     written; an owner is asked the fresh proof (from a computer: do it from the phone), and from the phone it is made;
 *     a pause refused for another reason is answered without asking any proof; the password makes one with its current code.
 *     Before Otto's five: an owner, and the password, inside the cool-down of a pause they made themselves read that
 *     another owner can, never "an owner can".
 *
 * Run (as test-all does, through scripts/run-server-suites.mjs):
 *   SERVER_SUITES_ONLY=test-removal-chain node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
delete process.env.ALERTS_REPORT_FOLD_MINUTES;
for (const k of Object.keys(process.env)) if (k.startsWith('BACKUP_OFFBOX_') || k.startsWith('ALERTS_WEBHOOK_')) delete process.env[k];

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Expo and the stand-in ntfy are answered here; nothing else off this machine is reached.
const realFetch = globalThis.fetch;
const pushes: Array<{ to: string[]; k: string; body: string }> = [];
const offMachine: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    if (url.hostname === 'exp.host') {
        const batch = JSON.parse(String(init?.body ?? '[]')) as any[];
        pushes.push({ to: batch.map((m) => m.to), k: batch[0]?.data?.k, body: JSON.stringify(batch) });
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    offMachine.push(url.hostname);
    throw new Error(`test-removal-chain: refused a request off this machine: ${url.hostname}`);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** The stand-in ntfy: every POST kept, a 200 for each. */
async function startFakeNtfy() {
    const hits: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"id":"x"}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { hits, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string; token: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    // Nothing of the key in the token: a push's wire is read below for any member's key.
    return { pubKeyHex, privateKey, callsign, token: `ExponentPushToken[rc-${crypto.randomBytes(6).toString('hex')}]` };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any };

async function answerOf(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

let BASE = '';

/** A member's signed request. */
async function signed(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...signedHeaders(method, p, body, id) },
        ...(body ? { body } : {}),
    }));
}

/** An admin route under `session`'s headers (a key session, or the password with a 2FA code). */
async function admin(p: string, session: Record<string, string>, payload?: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...session },
        body: JSON.stringify(payload ?? {}),
    }));
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const ADMIN_PW = 'Removal-Chain-Admin-Pw-58!';
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main() {
    console.log('Pause chains: an owner and a new reason within 30 days, no third pause in 90, owners told, the tripwire...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { resetAdminAuthTarpit, TOKEN_REFUSED_CODE } = await import('./admin-auth.js');
    const { db } = await import('./db/db.js');
    const { setSwitchOverride } = await import('./config/node-profile.js');
    const { hashPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { ownerSessionHeaders, ownerPhoneSessionHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests, STEP_UP_REQUIRED_CODE } = await import('./admin-key-auth.js');
    const { issueAutomationToken } = await import('./automation-tokens.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { setSimulatedDiskUsageForTesting } = await import('./engine/storage-health.js');
    const alerts = await import('./services/alerts.js');

    const ntfy = await startFakeNtfy();
    const TOPIC = `bp-chain-${crypto.randomBytes(9).toString('hex')}`;

    await initTls();
    se.initStateEngine();
    // This machine's own disk may be full enough to alert: the lines here are the pauses'.
    setSimulatedDiskUsageForTesting(10);
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null, communityName: 'Chain Test Commons' });
    const twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // ── The people ──────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(60 * DAY), gen.pubKeyHex);
    se.registerPushToken(gen.pubKeyHex, gen.token, 'android');
    const people: Id[] = [gen];
    const seed = (callsign: string): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, ago(30 * DAY), gen.pubKeyHex, `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        se.transfer('genesis', id.pubKeyHex, 20, `seed ${callsign}`, 'direct', true);
        se.registerPushToken(id.pubKeyHex, id.token, 'android');
        people.push(id);
        return id;
    };
    const otto = seed('OwnerOtto');
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seed('AdminAda');
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    const abe = seed('AdminAbe');
    grantNodeRole(abe.pubKeyHex, 'admin', gen.pubKeyHex);
    const voters = ['VoterVi', 'VoterWu', 'VoterXo', 'VoterYa', 'VoterZed'].map(seed);
    const [vi] = voters;
    const kim = seed('KeenKim');      // a member with a completed trade: she may propose a Decision
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, 5, 'completed', ?, ?)`).run(`tx-${crypto.randomUUID()}`, `post-${crypto.randomUUID()}`, kim.pubKeyHex, vi.pubKeyHex, ago(DAY), ago(DAY));
    const dave = seed('DaveDoe');     // No, an owner's second pause, then no third
    const erin = seed('ErinEast');    // too few voted
    const finn = seed('FinnFox');     // stopped before it closed
    const gus = seed('GusGrey');      // passed, then halted in its grace window
    const hal = seed('HalHill');      // 31 days on
    const mo = seed('ModeratorMo');   // a pause that holds a role aside
    grantNodeRole(mo.pubKeyHex, 'moderator', gen.pubKeyHex);
    const tams = [1, 2, 3, 4, 5, 6, 7].map(n => seed(`TripTam${n}`));
    const sid = seed('SixthSid');
    // The second pause at the routes' owner gates: one member each, so a pause let through spoils no other check.
    const [ivy, jude, kit] = ['IvyIrons', 'JudeJay', 'KitKerr'].map(seed);   // by the suspend route
    const [leo, mia, ned] = ['LeoLane', 'MiaMoss', 'NedNash'].map(seed);     // through a report

    const sessionOf = (id: Id, role: 'admin' | 'owner') => {
        const { handshakeToken } = mintHandshakeToken(id.pubKeyHex, role);
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open ${id.callsign}'s key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    };
    const adaSession = sessionOf(ada, 'admin');
    const abeSession = sessionOf(abe, 'admin');
    const ottoSession = ownerSessionHeaders(otto.pubKeyHex);          // an owner from a computer: no fresh proof
    const ottoPhone = () => ownerPhoneSessionHeaders(otto.pubKeyHex);  // pressed Manage on the phone just now
    const gwenSession = ownerSessionHeaders(gen.pubKeyHex);
    const gwenPhone = () => ownerPhoneSessionHeaders(gen.pubKeyHex);
    const password = () => twoFa.headers();
    // Otto's hand-off with its unlock 10 minutes old: past the phone's 5-minute step-up, so an owner-only change asks Manage again.
    const ottoPhoneStale = () => {
        const headers = ottoPhone();
        backdateAdminSessionForTests(headers['X-Admin-Session'], 10 * 60_000);
        return headers;
    };
    // An admin-scope automation token Gwen (an owner) made: it acts for her at admin level, and never makes an owner-only change.
    const madeToken = issueAutomationToken({ name: 'Chain test script', scope: 'admin', createdBy: gen.pubKeyHex });
    if (!madeToken.ok) throw new Error(`setup: could not make Gwen's automation token: ${madeToken.error}`);
    const gwenToken = { Authorization: `Bearer ${madeToken.token}` };
    const fresh = () => { resetAdminAuthTarpit(); resetAdminRateLimit(); resetGatewayRateLimit(); };
    const statusOf = (id: Id) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(id.pubKeyHex) as { status: string }).status;
    const row = (decisionId: string): any => {
        const r: any = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
        return r ? { ...r, params: JSON.parse(r.params || '{}') } : r;
    };
    const removalsOf = (id: Id) => (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE effect = 'remove_member' AND subject = ?").get(id.pubKeyHex) as { n: number }).n;
    const reportStatus = (reportId: string) => (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(reportId) as { status: string }).status;
    const pause = async (session: Record<string, string>, who: Id, reason: string) => {
        fresh();
        return admin(`/api/local/admin/users/${who.pubKeyHex}/suspend`, session, { reason });
    };
    const lift = async (who: Id) => {
        fresh();
        const r = await admin(`/api/local/admin/users/${who.pubKeyHex}/status`, gwenSession, { status: 'active' });
        if (r.status !== 200) throw new Error(`setup: could not lift ${who.callsign}'s pause (${r.status} ${r.text})`);
    };
    const reportAction = async (session: Record<string, string>, reportId: string, payload: Record<string, unknown> = {}) => {
        fresh();
        return admin(`/api/local/admin/reports/${reportId}/action`, session, { suspendUser: true, ...payload });
    };
    /** The community votes on Decision `id` (Yes, or No; none at all with `null`), it closes now, and the tick runs. */
    const voteAndClose = (id: string, yes: boolean | null) => {
        if (yes !== null) for (const v of voters) de.castDecisionVote(id, v.pubKeyHex, yes);
        db.prepare('UPDATE decisions SET closes_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), id);
        de.tickDecisions();
    };
    /** A vote moved `days` back in time, as if made then: when it opened, closed, paused and was halted. */
    const age = (decisionId: string, days: number) => {
        const r: any = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId);
        const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) - days * DAY).toISOString() : iso);
        const params = JSON.parse(r.params || '{}');
        if (params.pausedAt) params.pausedAt = shift(params.pausedAt);
        db.prepare(`UPDATE decisions SET opens_at = ?, closes_at = ?, created_at = ?, admin_halted_at = ?, grace_period_ends_at = ?, params = ?
            WHERE id = ?`).run(shift(r.opens_at), shift(r.closes_at), shift(r.created_at), shift(r.admin_halted_at), shift(r.grace_period_ends_at),
            JSON.stringify(params), decisionId);
    };
    const cardFor = async (reader: Id, decisionId: string) => {
        fresh();
        const r = await signed('GET', '/api/commons/decisions', reader);
        return (r.body?.decisions ?? []).find((d: any) => d.id === decisionId);
    };
    const endedOn = (decisionId: string) => Date.parse(row(decisionId).status === 'admin_halted' ? row(decisionId).admin_halted_at : row(decisionId).closes_at);

    // ── 1. Within 30 days, an owner and a new reason ────────────────────────────────────────────────────────────────
    console.log('1. Within 30 days of a vote that said No, only an owner pauses them again, with a new reason');
    const DAVE_CASE = 'Took deposits for repairs and never came back';
    const p1 = await pause(adaSession, dave, DAVE_CASE);
    const vote1 = p1.body?.decision?.id as string;
    assert(p1.status === 200 && !!vote1 && statusOf(dave) === 'disabled', `Ada pauses Dave; his vote opens (${p1.status})`);
    assert(!row(vote1).params.secondPause && !row(vote1).description.startsWith('Second pause'), "a first pause's record says nothing of a second");
    voteAndClose(vote1, false);
    assert(row(vote1).status === 'failed' && statusOf(dave) === 'active', `the community says No, and Dave is back (${row(vote1).status})`);
    const ended1 = endedOn(vote1);
    const until1 = dayOf(ended1 + 30 * DAY);
    const NEEDS_OWNER = `The community decided on DaveDoe on ${dayOf(ended1)}. Only an owner can pause them again before ${until1}.`;
    let before = removalsOf(dave);
    const abeTry = await pause(abeSession, dave, 'Took a deposit for a fence and never built it');
    assert(abeTry.status === 403 && abeTry.body?.code === de.REPAUSE_NEEDS_OWNER_CODE && abeTry.body?.error === NEEDS_OWNER,
        `another admin, Abe, is refused in the design's words (${abeTry.status} ${abeTry.body?.code}: ${abeTry.body?.error})`);
    assert(statusOf(dave) === 'active' && removalsOf(dave) === before, 'nothing is written: Dave is active, no vote opens');
    const fenceReport = se.submitReport(vi.pubKeyHex, dave.pubKeyHex, 'Took a deposit for a fence and never built it')!;
    const abeReport = await reportAction(abeSession, fenceReport.id, { reason: 'Took a deposit for a fence and never built it' });
    assert(abeReport.status === 403 && abeReport.body?.code === de.REPAUSE_NEEDS_OWNER_CODE && reportStatus(fenceReport.id) === 'pending'
        && statusOf(dave) === 'active' && removalsOf(dave) === before,
        `nor through a report: 403, the report left as it was (${abeReport.status} ${abeReport.body?.code} ${reportStatus(fenceReport.id)})`);
    const engineSays = de.adminEmergencySuspend(dave.pubKeyHex, abe.pubKeyHex, 'Asked of the engine directly, a fence');
    assert(!engineSays.success && engineSays.status === 403 && engineSays.code === de.REPAUSE_NEEDS_OWNER_CODE && statusOf(dave) === 'active',
        `the engine refuses underneath (${engineSays.code})`);
    let thrown: any = null;
    try { se.actionReport(fenceReport.id, false, true, false, { actor: abe.pubKeyHex }); } catch (e) { thrown = e; }
    assert(thrown?.status === 403 && thrown?.code === de.REPAUSE_NEEDS_OWNER_CODE && reportStatus(fenceReport.id) === 'pending' && statusOf(dave) === 'active',
        `and so does the report's, before any write (${thrown?.code})`);
    // Called with a pause the guards above let through, pauseMember still refuses: the rule lives where the pause is made.
    let inner: any = null;
    try { db.transaction(() => { de.pauseMember(se.getMember(dave.pubKeyHex)!, abe.pubKeyHex, 'Straight to the pause', { actor: abe.pubKeyHex, how: 'suspended' }); })(); } catch (e) { inner = e; }
    assert(inner instanceof de.PauseRefusedError && inner.code === de.REPAUSE_NEEDS_OWNER_CODE && statusOf(dave) === 'active' && removalsOf(dave) === before,
        `pauseMember itself refuses, and its transaction is undone (${inner?.code})`);
    const adaTry = await pause(adaSession, dave, 'Took another deposit this week');
    assert(adaTry.status === 403 && adaTry.body?.code === de.REMOVAL_COOL_DOWN_CODE && /An owner can, with a new reason\.$/.test(adaTry.body?.error ?? ''),
        `Ada, who brought the vote, meets her cool-down first, which says an owner can, not another admin (${adaTry.body?.error})`);
    const same = await pause(ottoSession, dave, `   ${DAVE_CASE}  `);
    assert(same.status === 400 && same.body?.code === de.REPAUSE_SAME_REASON_CODE
        && same.body?.error === `The last pause of DaveDoe gave this same reason. Pausing them again before ${until1} needs a new one.`
        && statusOf(dave) === 'active' && removalsOf(dave) === before,
        `an owner, Otto, with the same reason (trimmed): refused, nothing written (${same.status} ${same.body?.code}: ${same.body?.error})`);
    const DAVE_CASE_2 = 'Took two more deposits this week and stopped answering';
    const p2 = await pause(ottoSession, dave, DAVE_CASE_2);
    const vote2 = p2.body?.decision?.id as string;
    assert(p2.status === 200 && !!vote2 && statusOf(dave) === 'disabled', `Otto, with a new reason, pauses Dave again (${p2.status} ${p2.text.slice(0, 160)})`);
    assert(row(vote2).params.secondPause?.after === 'no' && row(vote2).params.secondPause?.endedAt === new Date(ended1).toISOString(),
        `its record says it is a second pause, after a No (${JSON.stringify(row(vote2).params.secondPause)})`);
    assert(row(vote2).description.startsWith('Second pause in 30 days. The last vote said No. An owner paused DaveDoe'),
        `its record opens with the design's sentence (${row(vote2).description.slice(0, 90)})`);
    const card2 = await cardFor(vi, vote2);
    assert(card2?.params?.secondPause?.after === 'no' && card2?.description?.startsWith('Second pause in 30 days. The last vote said No.'),
        `members read it on the card (${JSON.stringify(card2?.params?.secondPause)})`);
    // The routes ask that pause what they ask every owner-only one (routes/admin.ts stepUpIfOwnerOnly), as they do a
    // co-owner's: never an automation token, and from the phone's Manage hand-off its unlock again. The chain rules answer first.
    for (const m of [ivy, jude, kit, leo, mia, ned]) {
        const r = await pause(adaSession, m, `Took deposits for repairs and never came back, ${m.callsign}`);
        if (r.status !== 200) throw new Error(`setup: Ada's pause of ${m.callsign}: ${r.status} ${r.text}`);
        voteAndClose(r.body.decision.id, false);
        if (row(r.body.decision.id).status !== 'failed' || statusOf(m) !== 'active') throw new Error(`setup: the vote on ${m.callsign} did not say No`);
    }
    const untouched = (m: Id) => statusOf(m) === 'active' && removalsOf(m) === 1;
    const abeOnIvy = await pause(abeSession, ivy, 'Took a deposit for a shed and never built it');
    assert(abeOnIvy.status === 403 && abeOnIvy.body?.code === de.REPAUSE_NEEDS_OWNER_CODE && untouched(ivy),
        `a plain admin is still refused by the rule itself (${abeOnIvy.status} ${abeOnIvy.body?.code})`);
    const tokenOnCoOwner = await pause(gwenToken, otto, 'A case about a co-owner, sent by a script');
    assert(tokenOnCoOwner.status === 403 && tokenOnCoOwner.body?.code === TOKEN_REFUSED_CODE && statusOf(otto) === 'active',
        `Gwen's admin-scope automation token is refused a co-owner's pause (${tokenOnCoOwner.status} ${tokenOnCoOwner.body?.code})`);
    const tokenSame = await pause(gwenToken, ivy, `Took deposits for repairs and never came back, ${ivy.callsign}`);
    assert(tokenSame.status === 400 && tokenSame.body?.code === de.REPAUSE_SAME_REASON_CODE && untouched(ivy),
        `with the last pause's reason, the token meets the same-reason rule first (${tokenSame.status} ${tokenSame.body?.code})`);
    const tokenOnIvy = await pause(gwenToken, ivy, 'Took two more deposits this week, seen by a script');
    assert(tokenOnIvy.status === 403 && tokenOnIvy.body?.code === TOKEN_REFUSED_CODE && untouched(ivy),
        `with a new reason, the token is refused Ivy's second pause as it is a co-owner's, nothing written (${tokenOnIvy.status} ${tokenOnIvy.body?.code ?? tokenOnIvy.text.slice(0, 120)})`);
    const leoReport = se.submitReport(vi.pubKeyHex, leo.pubKeyHex, 'Took two more deposits this week')!;
    const tokenOnLeo = await reportAction(gwenToken, leoReport.id, { reason: 'Took two more deposits this week, seen by a script' });
    assert(tokenOnLeo.status === 403 && tokenOnLeo.body?.code === TOKEN_REFUSED_CODE && reportStatus(leoReport.id) === 'pending' && untouched(leo),
        `and Leo's through a report, the report left as it was (${tokenOnLeo.status} ${tokenOnLeo.body?.code ?? tokenOnLeo.text.slice(0, 120)} ${reportStatus(leoReport.id)})`);
    const stale = ottoPhoneStale();
    const staleOnCoOwner = await pause(stale, gen, 'A case about a co-owner, from a phone left signed in');
    assert(staleOnCoOwner.status === 403 && staleOnCoOwner.body?.code === STEP_UP_REQUIRED_CODE && statusOf(gen) === 'active',
        `Otto's phone hand-off 10 minutes after its unlock is asked to press Manage again for a co-owner's pause (${staleOnCoOwner.status} ${staleOnCoOwner.body?.code})`);
    const staleOnJude = await pause(stale, jude, 'Took two more deposits this week, from a phone left signed in');
    assert(staleOnJude.status === 403 && staleOnJude.body?.code === STEP_UP_REQUIRED_CODE && untouched(jude),
        `and for Jude's second pause, nothing written (${staleOnJude.status} ${staleOnJude.body?.code ?? staleOnJude.text.slice(0, 120)})`);
    const miaReport = se.submitReport(vi.pubKeyHex, mia.pubKeyHex, 'Took two more deposits this week')!;
    const staleOnMia = await reportAction(stale, miaReport.id, { reason: 'Took two more deposits this week, from a phone left signed in' });
    assert(staleOnMia.status === 403 && staleOnMia.body?.code === STEP_UP_REQUIRED_CODE && reportStatus(miaReport.id) === 'pending' && untouched(mia),
        `and for Mia's through a report, the report left as it was (${staleOnMia.status} ${staleOnMia.body?.code ?? staleOnMia.text.slice(0, 120)} ${reportStatus(miaReport.id)})`);
    const kitByPhone = await pause(ottoPhone(), kit, 'Took two more deposits this week, an owner on the phone');
    assert(kitByPhone.status === 200 && statusOf(kit) === 'disabled' && row(kitByPhone.body?.decision?.id ?? '')?.params?.secondPause?.after === 'no',
        `with Manage pressed just now, Otto makes Kit's second pause (${kitByPhone.status} ${kitByPhone.text.slice(0, 140)})`);
    const nedReport = se.submitReport(vi.pubKeyHex, ned.pubKeyHex, 'Took two more deposits this week')!;
    const nedByPhone = await reportAction(ottoPhone(), nedReport.id, { reason: 'Took two more deposits this week, an owner on the phone' });
    const nedVote = db.prepare("SELECT id FROM decisions WHERE subject = ? AND effect = 'remove_member' AND status = 'open'").get(ned.pubKeyHex) as { id: string } | undefined;
    assert(nedByPhone.status === 200 && reportStatus(nedReport.id) === 'actioned' && statusOf(ned) === 'disabled'
        && row(nedVote?.id ?? '')?.params?.secondPause?.after === 'no',
        `and Ned's through a report (${nedByPhone.status} ${reportStatus(nedReport.id)} ${nedByPhone.text.slice(0, 140)})`);
    // Lifted, so Otto's open pauses are as they were for the tripwire (5).
    for (const m of [ivy, jude, kit, leo, mia, ned]) if (statusOf(m) === 'disabled') await lift(m);

    // ── 2. No third pause in 90 days ────────────────────────────────────────────────────────────────────────────────
    console.log('\n2. A third pause within 90 days of the first is refused to everyone');
    voteAndClose(vote2, false);
    assert(row(vote2).status === 'failed' && statusOf(dave) === 'active', `the community says No again (${row(vote2).status})`);
    const THIRD = 'DaveDoe has been paused twice in 90 days already. A third time needs the community: propose a Decision.';
    before = removalsOf(dave);
    const gwenThird = await pause(gwenPhone(), dave, 'A third case about the deposits, from the market');
    assert(gwenThird.status === 403 && gwenThird.body?.code === de.THIRD_PAUSE_CODE && gwenThird.body?.error === THIRD,
        `an owner from the phone is refused in the design's words (${gwenThird.status} ${gwenThird.body?.code}: ${gwenThird.body?.error})`);
    fresh();
    const pwThird = await admin(`/api/local/admin/users/${dave.pubKeyHex}/suspend`, password(), { reason: 'A third case, with the password' });
    assert(pwThird.status === 403 && pwThird.body?.code === de.THIRD_PAUSE_CODE, `so is the server's password (${pwThird.status} ${pwThird.body?.code})`);
    const abeThird = await pause(abeSession, dave, 'A third case about the deposits, Abe');
    assert(abeThird.status === 403 && abeThird.body?.code === de.THIRD_PAUSE_CODE, `and an admin (${abeThird.status} ${abeThird.body?.code})`);
    const tokenThird = await pause(gwenToken, dave, 'A third case about the deposits, sent by a script');
    assert(tokenThird.status === 403 && tokenThird.body?.code === de.THIRD_PAUSE_CODE && tokenThird.body?.error === THIRD,
        `and an owner's automation token, in the rule's words (${tokenThird.status} ${tokenThird.body?.code})`);
    const ottoThird = await pause(ottoSession, dave, 'A third case about the deposits, Otto');
    assert(ottoThird.status === 403 && ottoThird.body?.code === de.REMOVAL_COOL_DOWN_CODE
        && new RegExp(`until ${dayOf(endedOn(vote2) + de.REMOVAL_COOL_DOWN_DAYS * DAY)}\\.$`).test(ottoThird.body?.error ?? ''),
        `Otto, who brought the second, meets his cool-down, which names nobody else who can (${ottoThird.body?.error})`);
    const thirdReport = se.submitReport(voters[1].pubKeyHex, dave.pubKeyHex, 'Deposits again')!;
    const gwenReport = await reportAction(gwenPhone(), thirdReport.id, { reason: 'Deposits again, a third report' });
    assert(gwenReport.status === 403 && gwenReport.body?.code === de.THIRD_PAUSE_CODE && reportStatus(thirdReport.id) === 'pending',
        `through a report too, the report left as it was (${gwenReport.status} ${gwenReport.body?.code})`);
    const engineThird = de.adminEmergencySuspend(dave.pubKeyHex, gen.pubKeyHex, 'A third case, asked of the engine');
    assert(!engineThird.success && engineThird.code === de.THIRD_PAUSE_CODE, `and in the engine (${engineThird.code})`);
    assert(statusOf(dave) === 'active' && removalsOf(dave) === before, 'nothing is written: Dave is active, no vote opens');
    fresh();
    const proposal = await signed('POST', '/api/commons/decisions', kim, {
        title: 'Suspend DaveDoe for a while', description: 'Two pauses, two votes, and the deposits still go missing',
        touches: 'member', effect: 'suspend_member', subject: dave.pubKeyHex,
    });
    assert(proposal.status === 200 && proposal.body?.decision?.effect === 'suspend_member',
        `a member with standing, Kim, can still propose a Decision on him (${proposal.status} ${proposal.body?.error ?? ''})`);
    age(vote1, de.THIRD_PAUSE_DAYS + 1);
    const fourth = await pause(gwenSession, dave, 'Months later, the deposits again');
    assert(fourth.status === 200 && row(fourth.body?.decision?.id).params.secondPause?.after === 'no',
        `once the first is ${de.THIRD_PAUSE_DAYS} days old, an owner may pause him (the second ended inside 30 days, so it says so) (${fourth.status} ${fourth.body?.error ?? ''})`);
    await lift(dave);

    // ── 3. The other endings ────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n3. Too few voting, a vote stopped before it closed, a removal halted in its window, and 31 days on');
    const e1 = (await pause(adaSession, erin, 'Threatened a stallholder at the market')).body?.decision?.id as string;
    voteAndClose(e1, null);
    assert(row(e1).status === 'unresolved' && statusOf(erin) === 'active', `too few vote on Erin's: unresolved, and she is back (${row(e1).status})`);
    const abeOnErin = await pause(abeSession, erin, 'Threatened another stallholder');
    assert(abeOnErin.status === 403 && abeOnErin.body?.code === de.REPAUSE_NEEDS_OWNER_CODE
        && abeOnErin.body?.error === `Too few members voted on ErinEast by ${dayOf(endedOn(e1))}. Only an owner can pause them again before ${dayOf(endedOn(e1) + 30 * DAY)}.`,
        `another admin is refused in words that say too few voted, as the card does, never that the community decided (${abeOnErin.body?.error})`);
    const e2 = await pause(ottoSession, erin, 'Threatened another stallholder, on video');
    assert(e2.status === 200 && row(e2.body?.decision?.id).params.secondPause?.after === 'too_few'
        && row(e2.body?.decision?.id).description.startsWith('Second pause in 30 days. Too few members voted on the last one. '),
        `an owner's second pause says too few voted on the last (${e2.status} ${row(e2.body?.decision?.id)?.description?.slice(0, 70)})`);
    await lift(erin);
    const f1 = (await pause(adaSession, finn, 'Sold a stolen bike at the market')).body?.decision?.id as string;
    fresh();
    const liftedByHand = await admin(`/api/local/admin/users/${finn.pubKeyHex}/status`, abeSession, { status: 'active' });
    assert(liftedByHand.status === 200 && row(f1).status === 'admin_halted' && !row(f1).grace_period_ends_at && statusOf(finn) === 'active',
        `Abe lifts Finn's pause before its vote closes (${liftedByHand.status} ${row(f1).status})`);
    const abeOnFinn = await pause(abeSession, finn, 'Sold another stolen bike');
    assert(abeOnFinn.status === 403 && abeOnFinn.body?.code === de.REPAUSE_NEEDS_OWNER_CODE
        && abeOnFinn.body?.error === `A vote on FinnFox was stopped on ${dayOf(endedOn(f1))} without removing them. Only an owner can pause them again before ${dayOf(endedOn(f1) + 30 * DAY)}.`,
        `a vote stopped before it closed counts too, in its own words (${abeOnFinn.body?.error})`);
    const f2 = await pause(ottoSession, finn, 'Sold another stolen bike, a second owner saw it');
    assert(f2.status === 200 && row(f2.body?.decision?.id).params.secondPause?.after === 'stopped'
        && row(f2.body?.decision?.id).description.startsWith('Second pause in 30 days. The last vote was stopped before it closed. '),
        `an owner's second pause says the last vote was stopped (${f2.status})`);
    await lift(finn);
    const g1 = (await pause(adaSession, gus, 'Sold a bike that was not his')).body?.decision?.id as string;
    voteAndClose(g1, true);
    assert(row(g1).status === 'execution_pending_grace', `the community votes to remove Gus: his grace window starts (${row(g1).status})`);
    fresh();
    const halted = await admin(`/api/local/admin/decisions/${g1}/halt`, abeSession, { reason: "The bike was his brother's, lent to him" });
    assert(halted.status === 200 && statusOf(gus) === 'active', `Abe halts it in the window; Gus is back (${halted.status})`);
    const abeOnGus = await pause(abeSession, gus, 'Sold another bike that was not his');
    assert(abeOnGus.status === 200 && !row(abeOnGus.body?.decision?.id).params.secondPause,
        `a removal the community passed doesn't make the next pause an owner's: Abe may, and its card says nothing (${abeOnGus.status} ${abeOnGus.text.slice(0, 140)})`);
    await lift(gus);
    const h1 = (await pause(adaSession, hal, 'Spammed the market chat with adverts')).body?.decision?.id as string;
    voteAndClose(h1, false);
    const abeOnHal = await pause(abeSession, hal, 'Spammed the market chat again');
    assert(abeOnHal.status === 403 && abeOnHal.body?.code === de.REPAUSE_NEEDS_OWNER_CODE, `Abe can't pause Hal inside the 30 days (${abeOnHal.status})`);
    age(h1, 31);
    const abeLater = await pause(abeSession, hal, 'Spammed the market chat again, a month on');
    assert(abeLater.status === 200 && !row(abeLater.body?.decision?.id).params.secondPause,
        `31 days on, he may, and its card says nothing of a second pause (${abeLater.status} ${abeLater.text.slice(0, 140)})`);
    await lift(hal);

    // ── 4. The owners are told of every pause ───────────────────────────────────────────────────────────────────────
    console.log('\n4. The owners are told of every pause, by who acted, never whom');
    let offset = 0;
    const advance = (ms: number) => { offset += ms; alerts.setAlertsClockForTests(offset); };
    const ownerPushes = () => pushes.filter((p) => p.k === 'owner.alert');
    const topicHits = () => ntfy.hits.filter((h) => h.path === `/${TOPIC}`);
    const pausedLines = () => alerts.getAlertsStatus().history.filter((e) => e.key === 'sec.members');
    alerts.resetAlertsForTests();
    fresh();
    const set = await admin('/api/local/admin/alerts/settings', gwenSession, { url: ntfy.url(`/${TOPIC}`) });
    assert(set.status === 200, `setup: the owner sets the alert channel (${set.status} ${set.text.slice(0, 120)})`);
    alerts.resetAlertsForTests();
    advance(2 * HOUR);
    const ownersTokens = [gen.token, otto.token].sort();
    // A moderator's pause holds the role aside: its role line tells the owners (sec.role, pushed), and it is the only one.
    let q0 = ownerPushes().length;
    const moPause = await pause(abeSession, mo, 'Deleted reports about a friend of his');
    await settle();
    const roleLines = alerts.getAlertsStatus().history.filter((e) => e.key === 'sec.role');
    assert(moPause.status === 200 && roleLines.length === 1 && /^A moderator lost that role, suspended by an admin\./.test(roleLines[0].detail)
        && pausedLines().length === 0 && ownerPushes().length === q0 + 1,
        `Abe pauses Mo, a moderator: one line, his role's, pushed once (${moPause.status} ${roleLines.map(e => e.detail).join(' | ')}; ${pausedLines().length} pause lines)`);
    await lift(mo);
    await settle(); // his role back is told too, on its own line: counted before the next step's lines are
    advance(2 * HOUR);
    const h0 = topicHits().length;
    q0 = ownerPushes().length;
    const t1 = await pause(adaSession, tams[0], 'Sent threats in the market chat');
    await settle();
    assert(t1.status === 200 && pausedLines()[0]?.detail === 'A member was paused in the last day, by an admin.',
        `Ada pauses Tam1: "A member was paused in the last day, by an admin." (${JSON.stringify(pausedLines().map(e => e.detail))})`);
    assert(topicHits().length === h0 + 1 && /A member was paused in the last day, by an admin\./.test(topicHits().at(-1)?.body ?? '')
        && /members removed, moved or paused/.test(String(topicHits().at(-1)?.headers.title ?? '')),
        `one line on the owners' channel (${topicHits().length - h0}: ${topicHits().at(-1)?.headers.title})`);
    const pushed = ownerPushes().slice(q0);
    assert(pushed.length === 1 && JSON.stringify(pushed[0].to.slice().sort()) === JSON.stringify(ownersTokens),
        `pushed once, to the owners only (${JSON.stringify(pushed.map(p => p.to))})`);
    const t2 = await pause(ottoSession, tams[1], 'Sent threats in the market chat, too');
    fresh();
    const t3 = await admin(`/api/local/admin/users/${tams[2].pubKeyHex}/suspend`, password(), { reason: 'Sent threats in the market chat as well' });
    await settle();
    const details = pausedLines().map(e => e.detail);
    assert(t2.status === 200 && t3.status === 200 && details.includes('A member was paused in the last day, by an owner.')
        && details.includes('A member was paused in the last day, by the admin password.') && details.includes('A member was paused in the last day, by an admin.'),
        `an owner's and the password's are counted on lines of their own (${JSON.stringify(details)})`);
    const told = pausedLines().length;
    const refused = await pause(abeSession, dave, 'A refused pause tells nothing');
    await settle();
    assert(refused.status === 403 && pausedLines().length === told && pausedLines().every(e => !/2 members/.test(e.detail)),
        `a refused pause tells nothing (${refused.status} ${refused.body?.code})`);
    setSwitchOverride('decisions', false);
    try {
        const off = await pause(abeSession, hal, 'Spammed the market chat, votes off');
        await settle();
        assert(off.status === 200 && off.body?.decision?.effect === 'keep_suspension' && pausedLines().some(e => e.detail === '2 members were paused in the last day, by an admin.'),
            `with votes off a pause is told too: the admins' count goes to 2 (${off.status} ${JSON.stringify(pausedLines().map(e => e.detail))})`);
    } finally {
        setSwitchOverride('decisions', true);
    }
    await lift(hal);
    const wire = [...ntfy.hits.map(h => `${JSON.stringify(h.headers)}${h.body}`), ...pushes.filter(p => p.k === 'owner.alert').map(p => p.body),
        JSON.stringify(alerts.getAlertsStatus())];
    const named = people.filter(i => wire.some(w => w.includes(i.callsign) || w.includes(i.pubKeyHex.slice(0, 12))));
    const quoted = ['Sent threats', 'Deleted reports', 'Spammed the market'].filter(s => wire.some(w => w.includes(s)));
    assert(named.length === 0 && quoted.length === 0,
        `nothing on the channel, in a push or in the book names a member or quotes a case (${named.map(i => i.callsign).join(', ')}${quoted.join(', ')})`);
    assert(offMachine.length === 0, `nothing off this machine was asked (${offMachine.join(', ')})`);

    // ── 5. The tripwire ─────────────────────────────────────────────────────────────────────────────────────────────
    console.log("\n5. A sixth open pause by one admin asks the owner's fresh proof");
    // Ada has Tam1's open; four more make five.
    for (const [i, t] of tams.slice(3, 7).entries()) {
        const r = await pause(adaSession, t, `Spam from a new account, number ${i + 2}`);
        if (r.status !== 200) throw new Error(`setup: Ada's pause of ${t.callsign}: ${r.status} ${r.text}`);
    }
    assert(de.openPausesBy(ada.pubKeyHex) === 5, `Ada has 5 pauses whose votes are open (${de.openPausesBy(ada.pubKeyHex)})`);
    const TRIP = "You have 5 pauses whose votes are still open, so another needs an owner's fresh proof.";
    before = removalsOf(sid);
    const adaSixth = await pause(adaSession, sid, 'Spam from a new account, number 6');
    assert(adaSixth.status === 403 && adaSixth.body?.code === de.OPEN_PAUSES_PROOF_CODE && adaSixth.body?.error === TRIP
        && statusOf(sid) === 'active' && removalsOf(sid) === before,
        `Ada's sixth is refused, nothing written (${adaSixth.status} ${adaSixth.body?.code}: ${adaSixth.body?.error})`);
    const sixthReport = se.submitReport(vi.pubKeyHex, sid.pubKeyHex, 'Spam from a new account')!;
    const adaSixthReport = await reportAction(adaSession, sixthReport.id, {});
    assert(adaSixthReport.status === 403 && adaSixthReport.body?.code === de.OPEN_PAUSES_PROOF_CODE && reportStatus(sixthReport.id) === 'pending'
        && statusOf(sid) === 'active', `through a report too (${adaSixthReport.status} ${adaSixthReport.body?.code})`);
    const engineSixth = de.adminEmergencySuspend(sid.pubKeyHex, ada.pubKeyHex, 'Spam from a new account, the engine');
    assert(!engineSixth.success && engineSixth.code === de.OPEN_PAUSES_PROOF_CODE && statusOf(sid) === 'active',
        `and in the engine, unless the route says the proof was given (${engineSixth.code})`);
    // An owner with five open is asked the proof: from a computer, to do it from the phone; from the phone, it is made.
    // His five are on members he has not paused before (his own pause of Tam2 holds him to its cool-down).
    for (const t of [...tams.slice(0, 7)]) await lift(t).catch(() => undefined);
    // Those lifts stopped their votes. Inside their 30 days an owner who made one meets its cool-down, which names another
    // owner, not "an owner": he is one, and may have a new reason. So does the password, on the one it made.
    const ottoOwn = await pause(ottoSession, tams[1], 'Sent threats in the market chat again');
    assert(ottoOwn.status === 403 && ottoOwn.body?.code === de.REMOVAL_COOL_DOWN_CODE && /until \d{4}-\d\d-\d\d\. Another owner can, with a new reason\.$/.test(ottoOwn.body?.error ?? ''),
        `Otto, an owner, meets the cool-down of his own pause of Tam2: another owner can (${ottoOwn.status} ${ottoOwn.body?.code}: ${ottoOwn.body?.error})`);
    fresh();
    const pwOwn = await admin(`/api/local/admin/users/${tams[2].pubKeyHex}/suspend`, password(), { reason: 'Sent threats in the market chat, once more' });
    assert(pwOwn.status === 403 && pwOwn.body?.code === de.REMOVAL_COOL_DOWN_CODE && /until \d{4}-\d\d-\d\d\. Another owner can, with a new reason\.$/.test(pwOwn.body?.error ?? ''),
        `so does the password, on its own pause of Tam3 (${pwOwn.status} ${pwOwn.body?.code}: ${pwOwn.body?.error})`);
    const ottosFive = [tams[0], tams[2], tams[3], tams[4], tams[5]];
    for (const [i, t] of ottosFive.entries()) {
        const r = await pause(ottoSession, t, `A spam wave from new accounts, case ${i + 1} seen by an owner`);
        if (r.status !== 200) throw new Error(`setup: Otto's pause of ${t.callsign}: ${r.status} ${r.text}`);
    }
    assert(de.openPausesBy(otto.pubKeyHex) === 5, `Otto has 5 pauses whose votes are open (${de.openPausesBy(otto.pubKeyHex)})`);
    const ownSelf = await pause(ottoSession, otto, 'A pause refused for another reason');
    assert(ownSelf.status === 400 && !ownSelf.body?.code && /cannot suspend yourself/.test(ownSelf.body?.error ?? ''),
        `a pause refused for another reason is answered so, before any proof is asked (${ownSelf.status} ${ownSelf.body?.error})`);
    const ottoComputer = await pause(ottoSession, sid, 'Spam from a new account, seen by an owner');
    assert(ottoComputer.status === 403 && ottoComputer.body?.code === 'phone_required' && statusOf(sid) === 'active',
        `from a computer, Otto is asked the fresh proof: do it from the phone (${ottoComputer.status} ${ottoComputer.body?.code})`);
    const ottoFromPhone = await pause(ottoPhone(), sid, 'Spam from a new account, seen by an owner');
    assert(ottoFromPhone.status === 200 && statusOf(sid) === 'disabled' && de.openPausesBy(otto.pubKeyHex) === 6,
        `from the phone's Manage, his sixth is made (${ottoFromPhone.status} ${ottoFromPhone.text.slice(0, 140)})`);
    // The password with five open (rows made here): its current code is the fresh proof.
    for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status, opens_at, closes_at, created_at, updated_at)
            VALUES (?, 'SYSTEM', 'Remove someone?', 'An admin paused someone.', 'member', 'remove_member', ?, ?, '1m1v', 'open', ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), `pk-elsewhere-${i}`, JSON.stringify({ rule: de.PAUSE_VOTE_RULE, pausedBy: 'owner:password', reason: 'A case made elsewhere' }),
                ago(HOUR), new Date(Date.now() + 6 * DAY).toISOString(), ago(HOUR), ago(HOUR));
    }
    fresh();
    const pwSixth = await admin(`/api/local/admin/users/${tams[6].pubKeyHex}/suspend`, password(), { reason: 'Spam from a new account, the password' });
    assert(pwSixth.status === 200 && statusOf(tams[6]) === 'disabled', `the password, with five open, pauses with its current code (${pwSixth.status} ${pwSixth.text.slice(0, 140)})`);
    const engineNoProof = de.adminEmergencySuspend(tams[1].pubKeyHex, 'owner:password', 'Spam from a new account, no proof');
    assert(!engineNoProof.success && engineNoProof.code === de.OPEN_PAUSES_PROOF_CODE && statusOf(tams[1]) === 'active',
        `in the engine, the password's next asks the proof too (${engineNoProof.code})`);

    await ntfy.close();
    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch((err) => {
    console.error('test-removal-chain crashed:', err);
    process.exit(1);
});
