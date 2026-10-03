/**
 * test-codes-out-of-logs.ts — re-key and invite codes never reach a log (scratch/reviews FABLE-sec-errors M1, M2).
 *
 * A re-key code (RK-XXXX-XXXX) binds any new key to a member for 24 hours; an invite code (INV-XXXX-XXXX) lets anyone
 * join for 30 days, and an admin's seed invite brings a tier with it. The admin who makes one sees it in the answer.
 * Anyone else who reads the logs must not: another admin, a standby holding the replication token
 * (/api/local/admin/logs), whoever reads Docker's log on the host, and every copy of the database.
 *
 * Real HTTPS server. Everything the process prints (stdout and stderr), every frame the /ws/logs stream sends (a log
 * client in logger.ts's set) and every system_logs row is captured while:
 *   1. the boot step scrubs lines written before this version: planted rows with a re-key or an invite code lose it,
 *      an invite code becoming the same short tag new lines carry; every other row is left byte for byte;
 *   2. an admin makes a seed invite on a fresh node (the genesis path) and on a node with members;
 *   3. a member makes an invite;
 *   4. an admin issues a re-key code and completes the re-key with it.
 * Then no code appears in any of the three, and the lines still say what happened: the invite's tag, and the re-key
 * line naming the member by a short key prefix.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminPass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { addLogClient } from './logger.js';
import { generateInvite } from './engine/invites.js';

// Capture everything printed from here on, passing it through.
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: any[]) => boolean;
    (stream as any).write = (chunk: any, ...rest: any[]) => {
        printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return write(chunk, ...rest);
    };
}

const PW = 'TestAdminPass123!';
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** The tag a log line carries for an invite code: the first 4 hex characters of its SHA-256, computed here on its own. */
const tagOf = (code: string) => 'inv#' + crypto.createHash('sha256').update(code.toUpperCase()).digest('hex').slice(0, 4);

async function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let resBody: any = {};
    try { resBody = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: resBody };
}

function newKey(): string {
    return newKeyPair().pubKeyHex;
}

function newKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

/** A redeem as the apps send one: signed by the key it registers (the node registers no key a redeem isn't signed by). */
async function redeemAs(kp: ReturnType<typeof newKeyPair>, body: { code: string; publicKey: string; callsign: string }): Promise<{ status: number; body: any }> {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`POST\n/api/invite/redeem\n${ts}\n${nonce}\n${JSON.stringify(body)}`), kp.privateKey).toString('base64');
    return postJson('/api/invite/redeem', body, { 'X-Public-Key': kp.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce });
}

type Row = { id: number; message: string | null; metadata: string | null };
const logRows = () => db.prepare('SELECT id, message, metadata FROM system_logs ORDER BY id').all() as Row[];
const logText = () => logRows().map((r) => `${r.message ?? ''} ${r.metadata ?? ''}`).join('\n');

async function main() {
    console.log('--- TEST: re-key and invite codes stay out of the logs ---');

    initAdminPassword();
    await initTls();
    initStateEngine();

    // The /ws/logs stream: a client in logger.ts's set, as https-server.ts adds a signed-in admin's socket.
    const frames: string[] = [];
    addLogClient({ readyState: 1, send: (p: string) => frames.push(String(p)) } as any);

    // ── 1. Lines an older version wrote, planted before the server boots ──
    const OLD_RK = 'RK-1A2B-3C4D';
    const OLD_RK_LOWER = 'rk-9f8e-7d6c';
    const OLD_INV = 'INV-ABCD-EFGH';
    // Two days ago, relative to now: the log keeps no line past 30 days (logger.ts LOG_KEEP_DAYS), so a fixed date would
    // one day be pruned at boot before the scrub could be seen.
    const at = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const plant = db.prepare('INSERT INTO system_logs (timestamp, level, category, message, metadata) VALUES (?, ?, ?, ?, ?)');
    const planted = {
        rekeyAudit: plant.run(at, 'INFO', 'AUTH', 'Re-enrolment code issued for member Bob (abcdef1234...) by operator owner:password',
            JSON.stringify({ oldPubkey: 'abcdef1234', operatorPubkey: 'owner:password', code: OLD_RK, expiresAt: at })).lastInsertRowid as number,
        rekeyInfo: plant.run(at, 'INFO', 'AUTH', `[Rekey] Re-enrolment code ${OLD_RK} issued for Bob by owner:password`, null).lastInsertRowid as number,
        rekeyDone: plant.run(at, 'INFO', 'AUTH', 'Member Bob re-keyed: abcdef1234... -> 0123456789... bound to new key by operator owner:password',
            JSON.stringify({ oldPubkey: 'abcdef1234', newPubkey: '0123456789', operatorPubkey: 'owner:password', code: OLD_RK_LOWER })).lastInsertRowid as number,
        seed: plant.run(at, 'SECURITY', 'ADMIN', `Seed invite generated: ${OLD_INV} [elder] issued by owner:password`,
            JSON.stringify({ issuedBy: 'owner:password', code: OLD_INV, type: 'elder', authRole: 'owner' })).lastInsertRowid as number,
    };
    // Text that only looks like a code, and ordinary lines: all left exactly as they are.
    const others = [
        ['INFO', 'LEDGER', 'Invoice INV-2024-0001 settled', null],
        ['INFO', 'SYS', 'INV-ABCD-EFGHI is too long, XINV-ABCD-EFGH has a letter before it, INV-0000-OOOO uses no code letters', null],
        ['INFO', 'SYS', 'RK-12-34 and XRK-1A2B-3C4D and RK-1A2B-3C4DE are not re-key codes', null],
        ['WARN', 'AUTH', 'code 482913 was wrong; exit code 1; statusCode 404', JSON.stringify({ note: 'backup code rotated', count: 3 })],
        ['INFO', 'SYS', 'An ordinary line', JSON.stringify({ ok: true, name: 'INV' })],
    ] as const;
    const otherIds = others.map(([level, category, message, metadata]) => plant.run(at, level, category, message, metadata).lastInsertRowid as number);
    const othersBefore = new Map(logRows().filter((r) => otherIds.includes(r.id)).map((r) => [r.id, JSON.stringify(r)]));

    const PORT = await startHttpsServer(0); // boots: the scrub of older log lines runs here
    // Step 7c: with the node's 2FA off the admin password alone opens no admin route (no member is seeded for a token:
    // step 2 needs a fresh node). 2FA is on and each password goes with a code.
    const tfa = turnOn2faForTests(PW);
    BASE = `https://localhost:${PORT}`;

    console.log('\n1. The boot step scrubs codes from lines already written');
    {
        const byId = new Map(logRows().map((r) => [r.id, r]));
        const audit = byId.get(planted.rekeyAudit)!;
        const info = byId.get(planted.rekeyInfo)!;
        const done = byId.get(planted.rekeyDone)!;
        const seed = byId.get(planted.seed)!;
        const all = [audit, info, done, seed].map((r) => `${r?.message} ${r?.metadata}`).join('\n');
        assert(!all.includes(OLD_RK) && !all.toLowerCase().includes(OLD_RK_LOWER), 'no old re-key code is left in a planted line');
        assert(!all.includes(OLD_INV), 'no old invite code is left in a planted line');
        assert(info?.message === '[Rekey] Re-enrolment code [REDACTED_REKEY_CODE] issued for Bob by owner:password',
            `the rest of the re-key line is unchanged (${info?.message})`);
        let auditMeta: any = null;
        try { auditMeta = JSON.parse(audit?.metadata ?? ''); } catch { /* asserted below */ }
        assert(auditMeta?.code === '[REDACTED_REKEY_CODE]' && auditMeta?.oldPubkey === 'abcdef1234' && auditMeta?.expiresAt === at,
            'the re-key audit metadata stays JSON, with only its code replaced');
        assert(seed?.message === `Seed invite generated: ${tagOf(OLD_INV)} [elder] issued by owner:password`,
            `an old invite code becomes the tag a new line carries (${seed?.message})`);
        const after = new Map(logRows().filter((r) => otherIds.includes(r.id)).map((r) => [r.id, JSON.stringify(r)]));
        assert(otherIds.every((id) => after.get(id) === othersBefore.get(id)), 'every other planted line is left byte for byte');
    }

    // ── 2. Seed invites: a fresh node's (genesis path), then a node with members ──
    console.log('\n2. Seed invites');
    const codes: string[] = [];
    const fresh = await postJson('/api/admin/seed-invite', { password: PW, totpCode: tfa.code(), type: 'ambassador' });
    assert(fresh.status === 200 && /^INV-/.test(fresh.body.code ?? ''), 'the admin gets the fresh node\'s seed invite in the answer');
    codes.push(fresh.body.code);
    const aliceKp = newKeyPair();
    const alice = aliceKp.pubKeyHex;
    const redeem = await redeemAs(aliceKp, { code: fresh.body.code, publicKey: alice, callsign: 'AliceLogs' });
    assert(redeem.status === 200 && redeem.body.success === true, 'the seed invite redeems');
    const elder = await postJson('/api/admin/seed-invite', { password: PW, totpCode: tfa.code(), type: 'elder' });
    assert(elder.status === 200 && /^INV-/.test(elder.body.code ?? ''), 'the admin gets a seed invite on a node with members');
    codes.push(elder.body.code);
    const elderLine = logRows().find((r) => (r.message ?? '').startsWith('Seed invite generated') && (r.message ?? '').includes(tagOf(elder.body.code)));
    assert(!!elderLine, 'the seed invite line carries the code\'s tag, so an operator can still tell one invite from another');

    // ── 3. A member's invite ──
    console.log('\n3. A member\'s invite');
    const memberInvite = generateInvite(alice);
    assert(!!memberInvite && /^INV-/.test(memberInvite.code), 'a member makes an invite');
    if (memberInvite) codes.push(memberInvite.code);

    // ── 4. A re-key code, issued and used ──
    console.log('\n4. A re-key code');
    const issued = await postJson(`/api/local/admin/members/${alice}/rekey/issue-code`, {}, tfa.headers());
    assert(issued.status === 200 && /^RK-[0-9A-F]{4}-[0-9A-F]{4}$/.test(issued.body.code ?? ''), `the admin gets the re-key code in the answer (${issued.status})`);
    const rk: string = issued.body.code ?? 'RK-none';
    codes.push(rk);
    const issueLine = logRows().find((r) => r.id > planted.seed && (r.message ?? '').includes('[Rekey]') && (r.message ?? '').includes('issued'));
    assert(!!issueLine && issueLine.message!.includes(alice.slice(0, 10)) && issueLine.message!.includes('AliceLogs'),
        `the re-key line says a code was made and for whom, by a short key prefix (${issueLine?.message})`);
    const done = await postJson(`/api/local/admin/members/${alice}/rekey/complete`, { code: rk, newPubkey: newKey() }, tfa.headers());
    assert(done.status === 200, `the re-key completes with the code (${done.status})`);

    // Give the log lines and the stream a moment.
    await new Promise((r) => setTimeout(r, 200));

    // ── 5. No code anywhere ──
    console.log('\n5. No code in system_logs, in what the process printed, or on the log stream');
    const out = printed.join('');
    const stream = frames.join('\n');
    const rows = logText();
    assert(frames.length > 0 && rows.length > 0, `something was logged and streamed (${frames.length} frames)`);
    for (const [i, code] of codes.entries()) {
        const label = code.startsWith('RK-') ? `the re-key code` : `invite ${i + 1}`;
        assert(!rows.includes(code), `system_logs holds no trace of ${label}`);
        assert(!out.includes(code), `stdout and stderr hold no trace of ${label}`);
        assert(!stream.includes(code), `the /ws/logs stream holds no trace of ${label}`);
    }

    console.log(`\n${passed}/${run} checks passed`);
    if (passed !== run) throw new Error(`${run - passed} checks failed`);
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('Test failed with error:', e?.message ?? e);
    process.exit(1);
});
