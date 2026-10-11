/**
 * Test Suite: a member's replacement phone takes over their account with the admin's RK- code, by number match (#1768;
 * design scratch/global-node/DESIGN-rekey-redeem-fable.md §4, §8, decided by Marty 2026-10-11).
 *
 * Scanning or typing the code binds nothing: POST /api/member/re-enroll registers a proposal and answers two digits, and
 * the admin binds the key whose digits match the phone in front of them (…/rekey/complete with that key) or declines it.
 *
 * Every request goes over real HTTPS through the app's own middleware (startHttpsServer): phones sign format 2 for this
 * community's host, operators use a key session as the app does. Nothing here contacts a host but this machine; pushes
 * are caught where they would leave for Expo.
 *
 *  A. Happy path: ask → the proposal in the admin's status → complete with that key → the phone's poll says bound, with
 *     the member's name; balance and role moved; the old key refused.
 *  B. Wrong codes: one answer for unknown, used, expired and cancelled; the 16th ask in a minute is 429; the node-wide
 *     ceiling trips, refuses a good code too, and logs once.
 *  C. A stolen code: the thief asks first, the member second, two different numbers; the admin declines the thief and binds
 *     the member; the thief's poll is declined, then gone, and the thief's key is no member.
 *  D. Replay and idempotence: the same ask twice is one proposal with the same number; a replayed request is refused; a
 *     completed code answers bound to its key and not valid to others; a second complete is refused; five phones at most,
 *     three declines stop the code.
 *  E. The middleware: unsigned 401; body key ≠ signer refused; a statement or headers for another host 421; a visitor's
 *     key, a member's key and a closed account's key refused with the plain sentence, whatever the code.
 *  F. Authorization: an owner's code for an admin, completed or declined by an admin session → 403; the owner binds it.
 *     A code on the operator's own key is refused (nobody would be left to confirm it).
 *     A member's signature on the status answers gone; the admin status shows no proposals to a viewer who can't read
 *     the code.
 *  G. A standby refuses the ask and the decline.
 *  H. A lost answer: the complete committed, the phone asks again and is told bound.
 *  I. The member's own sign-in recovery copies are gone after the move (with a tombstone), a copy they keep for someone
 *     else names the new key, and hub-fragment answers none for the new key.
 *  J. Making a code pushes the old key's phone, with the fixed words and never the code.
 *
 * Run (from apps/server): mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-rekey-redeem" node ../../scripts/run-server-suites.mjs
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.EXPO_ACCESS_TOKEN;
// This community's one name: a statement or request signed for any other host is another community's.
process.env.BEANPOOL_ADDRESSES = 'mullum.test';

import crypto from 'node:crypto';
import https from 'node:https';
import { db } from './db/db.js';
import { initStateEngine, seedGenesisMember, generateInvite, redeemInvite, getBalance, adminPruneUser, reconcileLedgerFromDb } from './state-engine.js';
import { grantNodeRole, nodeRoleOf as getMemberNodeRole } from './engine/node-roles.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { initTls } from './services/tls.js';
import { startHttpsServer } from './https-server.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { cleanRekeyCode, resetRekeyWrongCodesForTests, REKEY_CODE_NOT_VALID, REKEY_KEY_HAS_ACCOUNT, REKEY_TOO_MANY_WRONG, REKEY_CODE_FULL } from './engine/rekey-redeem.js';
import { setNodeRole } from './config/node-role.js';
import { REKEY_OWN_KEY } from './engine/member-wizards.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { registerVisitor } from './engine/members.js';

const HOST = 'mullum.test';
const OTHER_HOST = 'bellingen.test';

// No host but this machine; pushes are caught where they would leave for Expo.
const pushed: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'exp.host' || url.hostname.endsWith('expo.dev')) {
        const batch = JSON.parse(String(init?.body ?? '[]'));
        pushed.push(...batch);
        return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
function section(name: string) { console.log(`\n${name}`); }

interface Keypair { privateKey: crypto.KeyObject; pubKeyHex: string }
function makeKeypair(): Keypair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { privateKey, pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
}
const bound = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);

function keySession(kp: Keypair): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) throw new Error(`challenge refused: ${solved.error}`);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(`handshake refused: ${ex.error}`);
    return ex.sessionId!;
}

/** A fresh minute for every per-address limiter (the suite's requests all come from one address). */
const freshMinute = () => pruneAuthAttempts(Date.now() + 61_000);

let BASE = '';

interface Answer { status: number; json: any }
interface SendOpts { host?: string; nonce?: string; ts?: string; unsigned?: boolean }

/** A request signed by `kp` (format 2, for `host`), as the apps send it; the query is not signed. */
async function signedReq(kp: Keypair | null, method: 'GET' | 'POST', path: string, body?: unknown, opts: SendOpts = {}): Promise<Answer & { sent: { headers: Record<string, string>; body: string } }> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (kp && !opts.unsigned) {
        const host = opts.host ?? HOST;
        const ts = opts.ts ?? String(Date.now());
        const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
        const text = `beanpool-request/2\n${host}\n${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyStr}`;
        headers['X-Public-Key'] = kp.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, bound(text), kp.privateKey).toString('base64');
        headers['X-Timestamp'] = ts;
        headers['X-Nonce'] = nonce;
        headers['X-Signed-For'] = host;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyStr });
    return { status: res.status, json: await res.json().catch(() => ({})), sent: { headers, body: bodyStr } };
}

/** One signed POST over node:https, which never re-sends (fetch re-sends a request answered 421). */
function sendOnce(kp: Keypair, path: string, body: unknown): Promise<Answer> {
    const bodyStr = JSON.stringify(body);
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const text = `beanpool-request/2\n${HOST}\nPOST\n${path}\n${ts}\n${nonce}\n${bodyStr}`;
    const headers = {
        'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)),
        'X-Public-Key': kp.pubKeyHex, 'X-Signature': crypto.sign(null, bound(text), kp.privateKey).toString('base64'),
        'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signed-For': HOST,
    };
    return new Promise((resolve, reject) => {
        const req = https.request(`${BASE}${path}`, { method: 'POST', headers, rejectUnauthorized: false, agent: false }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => { let json: any = {}; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json }); });
        });
        req.on('error', reject);
        req.end(bodyStr);
    });
}

async function replay(sent: { headers: Record<string, string>; body: string }, path: string): Promise<Answer> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: sent.headers, body: sent.body });
    return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** What the phone sends: the ask, its statement signed for `statementHost`. */
function askBody(kp: Keypair, code: string, opts: { statementHost?: string; newPublicKey?: string; signer?: Keypair } = {}) {
    const host = opts.statementHost ?? HOST;
    // Over the code as the admin's screen spells it (cleanRekeyCode), whatever the member typed: the apps sign that too.
    const signature = crypto.sign(null, bound(`beanpool-re-enroll/2\n${host}\n${cleanRekeyCode(code)}`), (opts.signer ?? kp).privateKey).toString('base64');
    return { code, newPublicKey: opts.newPublicKey ?? kp.pubKeyHex, signature, signedFor: host };
}
const ask = (kp: Keypair, code: string, opts: SendOpts & { statementHost?: string; newPublicKey?: string } = {}) =>
    signedReq(kp, 'POST', '/api/member/re-enroll', askBody(kp, code, opts), opts);
const poll = (kp: Keypair | null, code: string) => signedReq(kp, 'GET', `/api/member/re-enroll/status?code=${encodeURIComponent(code)}`);

async function as(session: string | null, method: string, path: string, body?: unknown): Promise<Answer> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (session) headers['x-admin-session'] = session;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
}
const issue = (session: string, pk: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/issue-code`, {});
const status = (session: string, pk: string) => as(session, 'GET', `/api/local/admin/members/${pk}/rekey/status`);
const complete = (session: string, pk: string, code: string, newPubkey: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/complete`, { code, newPubkey });
const decline = (session: string, pk: string, newPubkey: string) => as(session, 'POST', `/api/local/admin/members/${pk}/rekey/proposals/${newPubkey}/decline`, {});

const proposalCount = (code: string) => (db.prepare('SELECT COUNT(*) AS n FROM rekey_proposals WHERE code = ?').get(code) as { n: number }).n;
const isMember = (pk: string) => !!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pk);

async function runTests() {
    console.log('--- TEST: a replacement phone takes over the account with the admin\'s code, by number match ---');
    initStateEngine();
    const owner = makeKeypair();
    seedGenesisMember(owner.pubKeyHex, 'OwnerOlive');
    const join = (name: string): Keypair => {
        const kp = makeKeypair();
        const inv = generateInvite(owner.pubKeyHex)!;
        const r = redeemInvite(inv.code, kp.pubKeyHex, name);
        if (!r.success) throw new Error(`join ${name} failed: ${r.error}`);
        return kp;
    };
    const admin = join('AdminAda');
    grantNodeRole(admin.pubKeyHex, 'admin', owner.pubKeyHex);

    initTls();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const ownerSession = keySession(owner);
    const adminSession = keySession(admin);

    // ── A ──
    section('A. Happy path: ask, the admin sees the number, binds that key, the phone is told bound');
    {
        const mia = join('MiaMember');
        // Seven Beans she holds, from a trade with Ada (a conserving pair of rows, read into the ledger).
        db.prepare('UPDATE accounts SET balance = 7 WHERE public_key = ?').run(mia.pubKeyHex);
        db.prepare('UPDATE accounts SET balance = -7 WHERE public_key = ?').run(admin.pubKeyHex);
        reconcileLedgerFromDb();
        const before = getBalance(mia.pubKeyHex).balance;
        const code = (await issue(adminSession, mia.pubKeyHex)).json.code as string;
        assert(/^RK-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code), `the admin makes a code (${code})`);
        const phone = makeKeypair();
        const a = await ask(phone, code.toLowerCase());
        assert(a.status === 200 && a.json.state === 'waiting' && /^\d\d$/.test(a.json.match) && !!a.json.expiresAt,
            `the phone's ask answers waiting with two digits (got ${a.status} ${JSON.stringify(a.json)})`);
        assert(!isMember(phone.pubKeyHex) && isMember(mia.pubKeyHex), 'the ask binds nothing: the account stays on the old key');
        const p0 = await poll(phone, code);
        assert(p0.status === 200 && p0.json.state === 'waiting' && p0.json.match === a.json.match, `the poll says waiting, same digits (got ${JSON.stringify(p0.json)})`);
        const st = await status(adminSession, mia.pubKeyHex);
        const props = st.json.proposals as any[];
        assert(st.status === 200 && props?.length === 1 && props[0].newPubkey === phone.pubKeyHex && props[0].match === a.json.match && !!props[0].proposedAt,
            'the admin\'s status shows the phone: its key, the same two digits, when it asked');
        const c = await complete(adminSession, mia.pubKeyHex, code, props[0].newPubkey);
        assert(c.status === 200 && c.json.success === true && c.json.newPubkey === phone.pubKeyHex, `Bind this phone completes with the key shown (got ${c.status})`);
        const p1 = await poll(phone, code);
        assert(p1.status === 200 && p1.json.state === 'bound' && p1.json.callsign === 'MiaMember' && p1.json.linkSignInAgain === true,
            `the phone's poll says bound with the member's name and to link the sign-in again (got ${JSON.stringify(p1.json)})`);
        assert(before === 7 && getBalance(phone.pubKeyHex).balance === before && !isMember(mia.pubKeyHex), `the balance moved to the new key (${before} → ${getBalance(phone.pubKeyHex).balance} Beans)`);
        const me = await signedReq(phone, 'GET', '/api/community/me');
        assert(me.status === 200, `the new key reads its own account (got ${me.status})`);
        const old = await signedReq(mia, 'GET', '/api/community/me');
        assert(old.status === 403 && old.json.code === 'key_invalidated', `the old key is refused (got ${old.status} ${old.json.code})`);
    }

    // ── B ──
    section('B. Wrong codes: one answer for every kind, the per-address limit, the node-wide ceiling');
    {
        freshMinute();
        resetRekeyWrongCodesForTests();
        const ben = join('BenMember');
        const cancelled = (await issue(adminSession, ben.pubKeyHex)).json.code as string;
        await as(adminSession, 'POST', `/api/local/admin/members/${ben.pubKeyHex}/rekey/cancel`, {});
        const expired = (await issue(adminSession, ben.pubKeyHex)).json.code as string;
        db.prepare('UPDATE rekey_requests SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), expired);
        const usedCode = (await status(ownerSession, ben.pubKeyHex)).json; // nothing pending now but the expired one
        void usedCode;
        const used = (db.prepare("SELECT code FROM rekey_requests WHERE status = 'completed' LIMIT 1").get() as { code: string }).code;
        const phone = makeKeypair();
        const answers = [] as Answer[];
        for (const c of ['RK-0000-0000', cancelled, expired, used, 'not a code']) answers.push(await ask(phone, c));
        assert(answers.every(r => r.status === 404 && r.json.error === REKEY_CODE_NOT_VALID && r.json.code === 'code_not_valid'),
            `unknown, cancelled, expired, used and malformed codes get the same answer (${answers.map(r => r.status).join(' ')})`);
        assert(!db.prepare('SELECT 1 FROM rekey_proposals WHERE new_pubkey = ?').get(phone.pubKeyHex), '...and no proposal was written for any of them');

        freshMinute();
        const statuses: number[] = [];
        for (let i = 0; i < 16; i++) statuses.push((await ask(phone, `RK-1111-${String(i).padStart(4, '0')}`)).status);
        assert(statuses.slice(0, 15).every(s => s === 404) && statuses[15] === 429, `the 16th ask in a minute from one address is 429 (${statuses.join(',')})`);

        // The ceiling: 60 wrong codes an hour, node-wide (fresh minutes stand for many addresses).
        resetRekeyWrongCodesForTests();
        const logLines = () => (db.prepare("SELECT COUNT(*) AS n FROM system_logs WHERE message LIKE '%wrong re-key codes%'").get() as { n: number }).n;
        const linesBefore = logLines();
        let wrong = 0;
        while (wrong < 60) {
            freshMinute();
            for (let i = 0; i < 15 && wrong < 60; i++, wrong++) await ask(phone, `RK-2222-${String(wrong).padStart(4, '0')}`);
        }
        freshMinute();
        const ben2 = join('BenTwo');
        const good = (await issue(adminSession, ben2.pubKeyHex)).json.code as string;
        const tripped = await ask(makeKeypair(), good);
        assert(tripped.status === 429 && tripped.json.error === REKEY_TOO_MANY_WRONG, `after 60 wrong codes even a good code is refused for the hour (got ${tripped.status})`);
        assert(proposalCount(good) === 0, '...and nothing was proposed on it');
        await ask(phone, 'RK-2222-9999');
        assert(logLines() - linesBefore === 1, `the log gets one security line, not one per ask (${logLines() - linesBefore})`);
        resetRekeyWrongCodesForTests();
        freshMinute();
        const after = await ask(makeKeypair(), good);
        assert(after.status === 200 && after.json.state === 'waiting', `a new hour takes asks again (got ${after.status})`);
    }

    // ── C ──
    section('C. A stolen code: the thief asks first, the admin binds the member\'s number');
    {
        freshMinute();
        const cal = join('CalMember');
        const code = (await issue(adminSession, cal.pubKeyHex)).json.code as string;
        const thief = makeKeypair();
        const phone = makeKeypair();
        const t = await ask(thief, code);
        const m = await ask(phone, code);
        assert(t.json.state === 'waiting' && m.json.state === 'waiting' && t.json.match !== m.json.match,
            `two phones, two different numbers (thief ${t.json.match}, member ${m.json.match})`);
        const st = await status(adminSession, cal.pubKeyHex);
        assert((st.json.proposals as any[]).length === 2, 'the admin sees both phones');
        const d = await decline(adminSession, cal.pubKeyHex, thief.pubKeyHex);
        assert(d.status === 200 && d.json.declined === true, `Not theirs declines the thief (got ${d.status})`);
        const tp = await poll(thief, code);
        assert(tp.json.state === 'declined', `the thief's poll says declined (got ${tp.json.state})`);
        const again = await ask(thief, code);
        assert(again.status === 200 && again.json.state === 'declined' && proposalCount(code) === 2, 'asking again changes nothing: still declined, no new proposal');
        const st2 = await status(adminSession, cal.pubKeyHex);
        assert((st2.json.proposals as any[]).length === 1 && st2.json.proposals[0].newPubkey === phone.pubKeyHex, 'the admin now sees only the member\'s phone');
        const c = await complete(adminSession, cal.pubKeyHex, code, phone.pubKeyHex);
        assert(c.status === 200, `the admin binds the member's phone (got ${c.status})`);
        const tp2 = await poll(thief, code);
        assert(tp2.json.state === 'gone' && !isMember(thief.pubKeyHex), `the thief's poll says gone and the thief's key is no member (got ${tp2.json.state})`);
        const tc = await complete(adminSession, cal.pubKeyHex, code, thief.pubKeyHex);
        assert(tc.status >= 400 && !isMember(thief.pubKeyHex), `the spent code binds nothing more (got ${tc.status})`);
    }

    // ── D ──
    section('D. Replay and idempotence; five phones at most, three declines stop the code');
    {
        freshMinute();
        const dee = join('DeeMember');
        const code = (await issue(adminSession, dee.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        const first = await ask(phone, code);
        const second = await ask(phone, code);
        assert(first.json.match === second.json.match && proposalCount(code) === 1, 'the same ask twice is one proposal with the same number');
        const replayed = await replay(first.sent, '/api/member/re-enroll');
        assert(replayed.status === 403 && /nonce already used/.test(replayed.json.error), `a replayed request (same nonce) is refused (got ${replayed.status} ${replayed.json.error})`);
        assert(proposalCount(code) === 1, '...and writes nothing');
        await complete(adminSession, dee.pubKeyHex, code, phone.pubKeyHex);
        const boundAgain = await ask(phone, code);
        assert(boundAgain.status === 200 && boundAgain.json.state === 'bound' && boundAgain.json.callsign === 'DeeMember', 'the completed code answers bound to its key');
        const other = await ask(makeKeypair(), code);
        assert(other.status === 404 && other.json.error === REKEY_CODE_NOT_VALID, 'and not valid to any other key');
        const twice = await complete(adminSession, phone.pubKeyHex, code, makeKeypair().pubKeyHex);
        assert(twice.status >= 400, `a second complete is refused (got ${twice.status})`);

        freshMinute();
        const eve = join('EveMember');
        const full = (await issue(adminSession, eve.pubKeyHex)).json.code as string;
        const phones = Array.from({ length: 6 }, makeKeypair);
        const asks = [] as Answer[];
        for (const p of phones) asks.push(await ask(p, full));
        assert(asks.slice(0, 5).every(a => a.json.state === 'waiting') && new Set(asks.slice(0, 5).map(a => a.json.match)).size === 5,
            'five phones each get a number of their own');
        assert(asks[5].status === 409 && asks[5].json.error === REKEY_CODE_FULL, `the sixth phone is refused (got ${asks[5].status})`);

        freshMinute();
        const fay = join('FayMember');
        const stops = (await issue(adminSession, fay.pubKeyHex)).json.code as string;
        const three = Array.from({ length: 3 }, makeKeypair);
        for (const p of three) { await ask(p, stops); await decline(adminSession, fay.pubKeyHex, p.pubKeyHex); }
        const fourth = await ask(makeKeypair(), stops);
        assert(fourth.status === 409 && fourth.json.error === REKEY_CODE_FULL, `three declines stop the code taking phones (got ${fourth.status})`);
    }

    // ── E ──
    section('E. The middleware and the keys that may not ask');
    {
        freshMinute();
        const gus = join('GusMember');
        const code = (await issue(adminSession, gus.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        const unsigned = await signedReq(phone, 'POST', '/api/member/re-enroll', askBody(phone, code), { unsigned: true });
        assert(unsigned.status === 401, `an unsigned ask is 401 (got ${unsigned.status})`);
        const unsignedPoll = await poll(null, code);
        assert(unsignedPoll.status === 401, `an unsigned poll is 401 (got ${unsignedPoll.status})`);
        const other = makeKeypair();
        const spoof = await signedReq(phone, 'POST', '/api/member/re-enroll', askBody(other, code));
        assert(spoof.status === 403 && proposalCount(code) === 0, `a body naming another key than the signer is refused (got ${spoof.status})`);
        // Measured with a client that sends once: fetch re-sends a request answered 421 on a new connection (the fetch spec),
        // and the re-sent copy, its nonce spent by the first, is refused as a replay. Refused either way.
        const wrongStatement = await sendOnce(phone, '/api/member/re-enroll', askBody(phone, code, { statementHost: OTHER_HOST }));
        assert(wrongStatement.status === 421 && wrongStatement.json.code === 'wrong_community',
            `a statement signed for another community is 421 (got ${wrongStatement.status} ${JSON.stringify(wrongStatement.json)})`);
        const viaFetch = await ask(phone, code, { statementHost: OTHER_HOST });
        assert(viaFetch.status === 421 || (viaFetch.status === 403 && /nonce already used/.test(viaFetch.json.error)),
            `...and through fetch, which re-sends after a 421, still refused (got ${viaFetch.status})`);
        const wrongHeaders = await ask(phone, code, { host: OTHER_HOST });
        assert(wrongHeaders.status === 421, `headers signed for another community are 421 (got ${wrongHeaders.status})`);
        assert(proposalCount(code) === 0, '...and none of them proposed anything');

        const visitor = makeKeypair();
        registerVisitor(visitor.pubKeyHex, 'VisitorVi');
        const v = await ask(visitor, code);
        assert(v.status === 409 && v.json.error === REKEY_KEY_HAS_ACCOUNT, `a visitor's key gets the plain sentence (got ${v.status} ${v.json.error})`);
        const memberKey = await ask(admin, code);
        assert(memberKey.status === 409 && memberKey.json.error === REKEY_KEY_HAS_ACCOUNT, `a member's key is refused: it can't re-key someone else (got ${memberKey.status})`);
        const memberGuess = await ask(admin, 'RK-ABCD-EF01');
        assert(memberGuess.status === 409 && memberGuess.json.error === REKEY_KEY_HAS_ACCOUNT, '...with the same answer for a made-up code, so it learns nothing about codes');
        const closed = join('ClosedCleo');
        adminPruneUser(closed.pubKeyHex, owner.pubKeyHex);
        const cl = await ask(closed, code);
        assert(cl.status === 403 && proposalCount(code) === 0, `a closed account's key is refused (got ${cl.status})`);
    }

    // ── F ──
    section('F. Authorization: an owner\'s code for an admin');
    {
        freshMinute();
        const ivy = join('IvyAdmin');
        grantNodeRole(ivy.pubKeyHex, 'admin', owner.pubKeyHex);
        const made = await issue(ownerSession, ivy.pubKeyHex);
        const code = made.json.code as string;
        assert(made.status === 200 && !!code, 'the owner makes a code for an admin');
        const phone = makeKeypair();
        const thief = makeKeypair();
        await ask(phone, code);
        await ask(thief, code);
        const adminView = await status(adminSession, ivy.pubKeyHex);
        assert(adminView.status === 200 && !adminView.json.pendingRequest?.code && adminView.json.proposals.length === 0,
            'another admin reads neither the code nor the phones');
        const byAdmin = await complete(adminSession, ivy.pubKeyHex, code, phone.pubKeyHex);
        assert(byAdmin.status === 403 && !isMember(phone.pubKeyHex), `an admin session can't bind it (got ${byAdmin.status})`);
        const declineByAdmin = await decline(adminSession, ivy.pubKeyHex, thief.pubKeyHex);
        assert(declineByAdmin.status === 403, `nor decline a phone on it (got ${declineByAdmin.status})`);
        const noSession = await decline('', ivy.pubKeyHex, thief.pubKeyHex);
        assert(noSession.status === 401 || noSession.status === 403, `no session can't decline (got ${noSession.status})`);
        const memberPoll = await poll(admin, code);
        assert(memberPoll.status === 200 && memberPoll.json.state === 'gone', `a member's signature on the status answers gone (got ${memberPoll.json.state})`);
        const ownerView = await status(ownerSession, ivy.pubKeyHex);
        assert(ownerView.json.proposals.length === 2, 'the owner sees both phones');
        const byOwner = await complete(ownerSession, ivy.pubKeyHex, code, phone.pubKeyHex);
        assert(byOwner.status === 200 && getMemberNodeRole(phone.pubKeyHex) === 'admin', `the owner binds it, and the admin role moves (got ${byOwner.status})`);
        // A code on the operator's own key would end the session that could confirm it: refused, and nothing changes.
        const own = await issue(adminSession, admin.pubKeyHex);
        assert(own.status === 409 && own.json.error === REKEY_OWN_KEY && !db.prepare("SELECT 1 FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending'").get(admin.pubKeyHex),
            `an admin is refused a code on their own key, and none is made (got ${own.status})`);
        const stillIn = await status(adminSession, makeKeypair().pubKeyHex);
        assert(stillIn.status !== 401, `…and their session goes on (got ${stillIn.status})`);
    }

    // ── G ──
    section('G. A standby refuses the ask and the decline');
    {
        freshMinute();
        const hal = join('HalMember');
        const code = (await issue(adminSession, hal.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        await ask(phone, code);
        setNodeRole('backup');
        try {
            const a = await ask(makeKeypair(), code);
            assert(a.status === 503 || a.status === 409 || a.status === 403, `a standby refuses the ask (got ${a.status})`);
            const d = await decline(adminSession, hal.pubKeyHex, phone.pubKeyHex);
            assert(d.status >= 400 && d.status !== 404, `a standby refuses the decline (got ${d.status})`);
            assert(proposalCount(code) === 1 && !(db.prepare('SELECT declined_at FROM rekey_proposals WHERE code = ?').get(code) as any).declined_at,
                '...and nothing was written');
        } finally {
            setNodeRole('primary');
        }
    }

    // ── H ──
    section('H. A lost answer: the complete committed, the phone asks again');
    {
        freshMinute();
        const jo = join('JoMember');
        const code = (await issue(adminSession, jo.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        await ask(phone, code);
        await complete(adminSession, jo.pubKeyHex, code, phone.pubKeyHex);
        // The phone never heard: it was killed between the ask and the next poll, and on its next launch it asks again.
        const again = await ask(phone, code);
        assert(again.status === 200 && again.json.state === 'bound' && again.json.callsign === 'JoMember', `asking again says bound (got ${JSON.stringify(again.json)})`);
        const hist = await status(adminSession, phone.pubKeyHex);
        assert(hist.json.history?.length === 1 && hist.json.history[0].new_pubkey === phone.pubKeyHex, 'the admin\'s re-read shows the move in the history');
    }

    // ── I ──
    section('I. The member\'s own sign-in copies are deleted; a copy they keep for someone else moves');
    {
        freshMinute();
        const kit = join('KitMember');
        const lou = join('LouMember');
        const row = (owner_: string, type: string, ref: string, idx: number) => db.prepare(`
            INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
            VALUES (?, ?, ?, ?, 'ab', 'cd', 'ef', 1)`).run(owner_, type, ref, idx);
        row(kit.pubKeyHex, 'hub', 'self', 1);
        row(kit.pubKeyHex, 'sso', 'google', 2);
        row(lou.pubKeyHex, 'member', kit.pubKeyHex, 3);
        const code = (await issue(adminSession, kit.pubKeyHex)).json.code as string;
        const phone = makeKeypair();
        await ask(phone, code);
        const c = await complete(adminSession, kit.pubKeyHex, code, phone.pubKeyHex);
        assert(c.status === 200 && c.json.signInCopiesRemoved === 2, `the move answers the copies it removed (got ${c.json.signInCopiesRemoved})`);
        const owned = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(pk) as { n: number }).n;
        assert(owned(kit.pubKeyHex) === 0 && owned(phone.pubKeyHex) === 0, 'neither key owns a recovery copy: the old seed\'s copies are gone');
        const tomb = db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'recovery_shares' AND row_key = ?").get(`${kit.pubKeyHex}|1`);
        assert(!!tomb, '...with a tombstone, so a standby drops them too');
        const kept = db.prepare("SELECT holder_ref FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'member'").get(lou.pubKeyHex) as { holder_ref: string };
        assert(kept.holder_ref === phone.pubKeyHex, 'the copy they keep for someone else names the new key');
        const hub = await signedReq(phone, 'POST', '/api/recovery/shares/hub-fragment', {});
        assert(hub.status === 200 && hub.json.hubFragment === null, `hub-fragment answers none for the new key (got ${hub.status} ${JSON.stringify(hub.json)})`);
    }

    // ── J ──
    section('J. Making a code pushes the old phone, never the code');
    {
        freshMinute();
        const max = join('MaxMember');
        putPushTokenRow(max.pubKeyHex, 'ExponentPushToken[max-old-phone]', 'android');
        const bystander = join('BystanderBo');
        putPushTokenRow(bystander.pubKeyHex, 'ExponentPushToken[bystander]', 'android');
        pushed.length = 0;
        const made = await issue(adminSession, max.pubKeyHex);
        await flush();
        const code = made.json.code as string;
        assert(pushed.length === 1 && pushed[0].to === 'ExponentPushToken[max-old-phone]', `one push, to the old phone's token (${pushed.map(m => m.to).join(', ')})`);
        const msg = pushed[0] ?? {};
        assert(msg.body === 'An admin started moving your account to a new phone. If you still have this phone and didn\'t ask for this, tell an owner now.',
            `with the fixed words (got "${msg.body}")`);
        assert(!JSON.stringify(msg).includes(code), 'the push carries no code');
        const kept = db.prepare('SELECT title, body, data FROM push_notices WHERE recipient = ?').all(max.pubKeyHex) as any[];
        assert(kept.length === 1 && !JSON.stringify(kept).includes(code), 'nor do the details kept for the old key');
        const phone = makeKeypair();
        await ask(phone, code);
        await complete(adminSession, max.pubKeyHex, code, phone.pubKeyHex);
        assert(!(db.prepare('SELECT 1 FROM push_tokens WHERE public_key = ?').get(max.pubKeyHex)), 'the old phone\'s tokens go with the move');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

runTests().catch((e) => { console.error(e); process.exit(1); });
