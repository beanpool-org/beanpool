/**
 * test-ws-logs-session.ts — the live log stream (/ws/logs) lives no longer than the sign-in that opened it.
 *
 * "Sign out everywhere" (#1563) ends every sign-in on every computer and phone. The log stream is opened on a single-use
 * ticket from POST /api/local/admin/ws-ticket; the ticket was bound to no session, and an open log socket was never
 * closed, so a stream already open on another computer kept streaming after its member signed out everywhere. Now each
 * ticket is bound to the session that asked for it, and each log socket to that session.
 *
 * Real HTTPS server, key sessions over the admin_session cookie and its CSRF token (as Settings and the manager send
 * them), a real ws client. Then:
 *   1. a ticket issued before its member signs out everywhere is refused (401) after it;
 *   2. a ticket issued before its session logs out is refused after it;
 *   3. an open log socket is closed within a second of its member signing out everywhere (close code 4401), and another
 *      member's socket stays open and still streams;
 *   4. a fresh sign-in afterwards gets a ticket and a working stream;
 *   5. an open log socket is closed within a second of its session logging out;
 *   6. an open log socket is closed within two seconds of its member losing their admin role;
 *   7. a password session's socket is closed when that session logs out;
 *   8. a stream opened with the password and a 2FA code (no session) is closed when 2FA is turned off, break-glass is
 *      turned on, or the password changes, and a ticket issued before 2FA off or break-glass on is refused after it,
 *      while a key session's stream stays open through all three.
 *
 * Local only: it talks to the server it starts on localhost and nothing else.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { revokeNodeRole } from './engine/node-roles.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { consumeHandshakeToken, createAdminChallenge, createPasswordSession, verifyAndSolveChallenge } from './admin-key-auth.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, forgetUsedTotpCodesForTests } from './totp.js';
import { logger } from './logger.js';

let BASE = '', WSS = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Who { pub: string; priv: crypto.KeyObject }
function seedMember(callsign: string): Who {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return { pub, priv: privateKey };
}

/** A key sign-in, as the app's link or the QR pairing ends: the cookie's session and its CSRF token. */
interface Session { sessionId: string; csrf: string }
function keySession(who: Who): Session {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), who.priv).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: who.pub, signature });
    if (!solved.ok) throw new Error(solved.error);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(ex.error);
    return { sessionId: ex.sessionId!, csrf: ex.csrfToken! };
}
const asCookie = (s: Session) => ({ Cookie: `admin_session=${s.sessionId}`, 'X-CSRF-Token': s.csrf });

async function post(path: string, s: Session, body: unknown = {}) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...asCookie(s) }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}
/** A ticket asked for with the password and a current 2FA code, and no session. */
async function passwordTicket(password: string, totpSecret: string): Promise<string> {
    forgetUsedTotpCodesForTests();
    const res = await fetch(`${BASE}/api/local/admin/ws-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, totpCode: generateTotpCode(totpSecret) }) });
    const body: any = await res.json().catch(() => null);
    if (res.status !== 200 || typeof body?.ticket !== 'string') throw new Error(`ws-ticket (password + code) answered ${res.status} ${JSON.stringify(body)}`);
    return body.ticket;
}
async function ticketFor(s: Session): Promise<string> {
    const r = await post('/api/local/admin/ws-ticket', s);
    if (r.status !== 200 || typeof r.body?.ticket !== 'string') throw new Error(`ws-ticket answered ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.ticket;
}

interface LogSocket { ws: WebSocket; lines: string[]; closed: Promise<{ code: number; reason: string; at: number }> }
/** Opens /ws/logs with this ticket: the socket, or the status its upgrade was refused with. */
function openLogs(ticket: string): Promise<LogSocket | number> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${WSS}/ws/logs?ticket=${ticket}`, { rejectUnauthorized: false });
        const lines: string[] = [];
        ws.on('message', d => lines.push(d.toString()));
        const closed = new Promise<{ code: number; reason: string; at: number }>(r =>
            ws.on('close', (code, reason) => r({ code, reason: reason.toString(), at: Date.now() })));
        ws.on('open', () => resolve({ ws, lines, closed }));
        ws.on('unexpected-response', (req, res) => { resolve(res.statusCode ?? 0); req.destroy(); });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
}
async function mustOpen(ticket: string, label: string): Promise<LogSocket> {
    const s = await openLogs(ticket);
    if (typeof s === 'number') throw new Error(`${label}: /ws/logs upgrade refused ${s}`);
    return s;
}
/** Whether `s` closes within `ms`, and how. */
async function closesWithin(s: LogSocket, ms: number): Promise<{ code: number; reason: string } | null> {
    return Promise.race([s.closed, sleep(ms).then(() => null)]);
}
/** Whether a log line written now reaches `s`. */
async function streams(s: LogSocket): Promise<boolean> {
    const marker = 'wslogsmarker' + Array.from(crypto.randomBytes(8), b => String.fromCharCode(97 + (b % 26))).join('');
    logger.info('SYS', marker);
    for (let i = 0; i < 20; i++) {
        if (s.lines.some(l => l.includes(marker))) return true;
        await sleep(50);
    }
    return false;
}

async function main() {
    console.log('--- TEST: /ws/logs lives no longer than the sign-in that opened it ---');
    await initTls();
    initStateEngine();
    const PW = 'WsLogs-Session-123!';
    const { hash, salt } = hashPassword(PW);
    // 2FA on, so a password session is not held to the 2FA setup routes.
    const SECRET = generateTotpSecret();
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: [], breakGlassMode: false } as any);
    const PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    WSS = `wss://localhost:${PORT}`;

    const owner = seedMember('wsOwner');
    const admin = seedMember('wsAdmin');
    grantNodeRole(owner.pub, 'owner', 'SYSTEM');
    grantNodeRole(admin.pub, 'admin', owner.pub);

    // ── 1. a ticket issued before sign out everywhere is refused after it ──
    {
        const s = keySession(owner);
        const ticket = await ticketFor(s);
        const revoked = await post('/api/local/admin/auth/revoke-all', s);
        assert(revoked.status === 200, `the owner signs out everywhere (got ${revoked.status} ${JSON.stringify(revoked.body)})`);
        const after = await openLogs(ticket);
        assert(after === 401, `a ticket issued before sign out everywhere is refused after it → 401 (got ${typeof after === 'number' ? after : 'an open socket'})`);
        if (typeof after !== 'number') after.ws.terminate();
    }

    // ── 2. a ticket issued before its session logs out is refused after it ──
    {
        const s = keySession(owner);
        const ticket = await ticketFor(s);
        const out = await post('/api/local/admin/auth/logout', s);
        assert(out.status === 200, `the owner's session logs out (got ${out.status})`);
        const after = await openLogs(ticket);
        assert(after === 401, `a ticket issued before its session logged out is refused → 401 (got ${typeof after === 'number' ? after : 'an open socket'})`);
        if (typeof after !== 'number') after.ws.terminate();
    }

    // ── 3. sign out everywhere closes the member's open socket within a second, and no one else's ──
    const adminSession = keySession(admin);
    const adminLogs = await mustOpen(await ticketFor(adminSession), "the admin's stream");
    {
        const s = keySession(owner);
        const ownerLogs = await mustOpen(await ticketFor(s), "the owner's stream");
        // Two streams open and no member socket: a log line is one frame on each, and no ws_traffic line. The traffic
        // lines describe members' sockets; one about a log socket's frame went to the other log socket, whose frame
        // made one for the first, until the stack ran out: thousands of frames a line, ahead of any close frame.
        adminLogs.lines.length = 0;
        ownerLogs.lines.length = 0;
        assert(await streams(ownerLogs), 'with two streams open, a log line reaches the owner');
        await sleep(300);
        const traffic = (l: LogSocket) => l.lines.filter(x => x.includes('"ws_traffic"')).length;
        assert(traffic(ownerLogs) === 0 && traffic(adminLogs) === 0,
            `…and neither stream gets a ws_traffic line about the other (got ${traffic(ownerLogs)} and ${traffic(adminLogs)})`);
        assert(await streams(ownerLogs), "the owner's stream carries a log line while signed in");
        const revokedAt = Date.now();
        const revoked = await post('/api/local/admin/auth/revoke-all', s);
        assert(revoked.status === 200, `the owner signs out everywhere with the stream open (got ${revoked.status})`);
        const closed = await closesWithin(ownerLogs, 1000);
        assert(!!closed, `the owner's open stream is closed within a second of sign out everywhere (${closed ? `${Date.now() - revokedAt} ms` : 'still open'})`);
        assert(closed?.code === 4401, `…with close code 4401 (got ${closed?.code} "${closed?.reason}")`);
        if (!closed) ownerLogs.ws.terminate();
        assert(adminLogs.ws.readyState === WebSocket.OPEN, "the admin's stream stays open");
        assert(await streams(adminLogs), "the admin's stream still carries log lines");
    }

    // ── 4. a fresh sign-in gets a working stream ──
    {
        const s = keySession(owner);
        const fresh = await openLogs(await ticketFor(s));
        assert(typeof fresh !== 'number', `a fresh sign-in opens the stream (got ${typeof fresh === 'number' ? fresh : 101})`);
        if (typeof fresh !== 'number') {
            assert(await streams(fresh), 'the fresh stream carries log lines');

            // ── 5. logging out closes that session's socket ──
            const out = await post('/api/local/admin/auth/logout', s);
            assert(out.status === 200, `the owner's fresh session logs out (got ${out.status})`);
            const closed = await closesWithin(fresh, 1000);
            assert(closed?.code === 4401, `the stream is closed within a second of its session logging out (got ${closed ? closed.code : 'still open'})`);
            if (!closed) fresh.ws.terminate();
        }
    }

    // ── 6. losing the admin role closes the member's socket ──
    {
        revokeNodeRole(admin.pub, 'admin', owner.pub);
        const closed = await closesWithin(adminLogs, 2000);
        assert(closed?.code === 4401, `the admin's stream is closed within two seconds of losing the admin role (got ${closed ? closed.code : 'still open'})`);
        if (!closed) adminLogs.ws.terminate();
    }

    // ── 7. a password session's socket closes when it logs out ──
    {
        const p = createPasswordSession();
        const s = { sessionId: p.sessionId, csrf: p.csrfToken };
        const logs = await mustOpen(await ticketFor(s), "the password session's stream");
        assert(await streams(logs), "the password session's stream carries log lines");
        const out = await post('/api/local/admin/auth/logout', s);
        assert(out.status === 200, `the password session logs out (got ${out.status})`);
        const closed = await closesWithin(logs, 1000);
        assert(closed?.code === 4401, `the password session's stream is closed within a second of logging out (got ${closed ? closed.code : 'still open'})`);
        if (!closed) logs.ws.terminate();
    }

    // ── 8. a stream opened with the password and a 2FA code (no session) ends with that password, its 2FA, or break-glass off ──
    {
        const keyLogs = await mustOpen(await ticketFor(keySession(owner)), "the owner's key-session stream");

        // 2FA turned off.
        const beforeOff = await passwordTicket(PW, SECRET);
        const offLogs = await mustOpen(await passwordTicket(PW, SECRET), 'the password + code stream');
        assert(await streams(offLogs), 'the password + code stream carries log lines');
        updateLocalConfig({ totpEnabled: false, totpSecret: '' } as any);
        const offClosed = await closesWithin(offLogs, 2000);
        assert(offClosed?.code === 4401, `the password + code stream is closed within two seconds of 2FA turned off (got ${offClosed ? offClosed.code : 'still open'})`);
        if (!offClosed) offLogs.ws.terminate();
        const afterOff = await openLogs(beforeOff);
        assert(afterOff === 401, `a password + code ticket issued before 2FA off is refused after it → 401 (got ${typeof afterOff === 'number' ? afterOff : 'an open socket'})`);
        if (typeof afterOff !== 'number') afterOff.ws.terminate();

        // Break-glass turned on (2FA back on, with a new secret, as setting it up again makes).
        const SECRET2 = generateTotpSecret();
        updateLocalConfig({ totpEnabled: true, totpSecret: SECRET2 } as any);
        const beforeBg = await passwordTicket(PW, SECRET2);
        const bgLogs = await mustOpen(await passwordTicket(PW, SECRET2), 'the second password + code stream');
        assert(await streams(bgLogs), 'the second password + code stream carries log lines');
        updateLocalConfig({ breakGlassMode: true } as any);
        const bgClosed = await closesWithin(bgLogs, 2000);
        assert(bgClosed?.code === 4401, `the password + code stream is closed within two seconds of break-glass turned on (got ${bgClosed ? bgClosed.code : 'still open'})`);
        if (!bgClosed) bgLogs.ws.terminate();
        const afterBg = await openLogs(beforeBg);
        assert(afterBg === 401, `a password + code ticket issued before break-glass on is refused after it → 401 (got ${typeof afterBg === 'number' ? afterBg : 'an open socket'})`);
        if (typeof afterBg !== 'number') afterBg.ws.terminate();
        updateLocalConfig({ breakGlassMode: false } as any);

        // The password changed.
        const pwLogs = await mustOpen(await passwordTicket(PW, SECRET2), 'the third password + code stream');
        assert(await streams(pwLogs), 'the third password + code stream carries log lines');
        const PW2 = 'WsLogs-Session-456!';
        const next = hashPassword(PW2);
        updateLocalConfig({ adminHash: next.hash, salt: next.salt } as any);
        const pwClosed = await closesWithin(pwLogs, 2000);
        assert(pwClosed?.code === 4401, `the password + code stream is closed within two seconds of the password changing (got ${pwClosed ? pwClosed.code : 'still open'})`);
        if (!pwClosed) pwLogs.ws.terminate();

        // The new password and a code still open a stream, and the key session's stream was never touched.
        const fresh = await mustOpen(await passwordTicket(PW2, SECRET2), 'a stream on the new password');
        assert(await streams(fresh), 'a password + code stream on the new password carries log lines');
        fresh.ws.terminate();
        assert(keyLogs.ws.readyState === WebSocket.OPEN, "the owner's key-session stream stays open through 2FA off, break-glass and a password change");
        assert(await streams(keyLogs), "…and still carries log lines");
        keyLogs.ws.terminate();
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch(err => { console.error(err); process.exit(1); });
