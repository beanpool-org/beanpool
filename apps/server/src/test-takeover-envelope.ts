/**
 * Test Suite: the take-over envelope on the main server (sealed keys, slice 2a).
 *
 * Design: scratch/overnight/design/sealed-keys.md §2.1, §2.6, §4, §9 and the slice 2 row of §10.
 *
 *  1. No owner and no code → no envelope on disk, and every status says why, in words.
 *  2. Granting an owner seals; the owner opens it and finds the node key, community key, admin hash and roles.
 *  3. Grant, revoke, disable and prune each yield a NEW envelopeId and the right recipient set, through the
 *     chokepoint's debounced check alone (the periodic check is parked for these).
 *  4. A removed owner cannot open the NEW envelope.
 *  5. A raw-SQL `DELETE FROM node_roles` (no chokepoint) is caught by the periodic consistency check.
 *  6. The recovery code is returned once, is absent from disk, config and logs (grepped in the data dir and the
 *     captured console), opens the envelope, and a rotation locks the old code out of the new envelope.
 *  7. Check-code: true, false, typo (400, before the brake), and the password brake.
 *  8. The replication token gets the sealed envelope with an ETag, a 304 on If-None-Match, and never a plaintext
 *     field; it cannot reach the status or code routes; a public-address change re-seals.
 *  9. Owner-only: an admin's key session cannot make or check a code.
 * 10. The owner header route over real HTTPS: signed by an owner 200, by a member 403, unsigned 401.
 * 11. Boot is idempotent: an unchanged node keeps its envelopeId.
 * 12. Re-key (engine/member-wizards.ts): starting one drops the old key from the lock, completing one re-seals to
 *     the owner's new key — both through their chokepoints, with the periodic check parked.
 * 13. A standby refuses to make a recovery code (409), since it seals nothing the code could open.
 * 14. Recovery seal S2: the bundle carries data/recovery-seal.key byte for byte (2), never in what the token, the status
 *     or the header route answers (8, 10, 14); the status says whether the envelope carries it; the envelope re-seals
 *     without it when the file goes, and, through the periodic check alone, with it when the file appears; a file that
 *     is not a 32-byte key is not carried.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-envelope.ts
 */

process.env.TAKEOVER_RESEAL_DEBOUNCE_MS = '40';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

let testsRun = 0;
let testsPassed = 0;
function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Who { seed: Uint8Array; pub: string; callsign: string }
function member(callsign: string): Who {
    const seed = crypto.randomBytes(32);
    return { seed: new Uint8Array(seed), pub: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), callsign };
}

async function main() {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR is set');

    // Imported after the env above: the debounce is read at import.
    const { initStateEngine, grantNodeRole, revokeNodeRole, adminSetUserStatus, adminPruneUser, updateNodeConfig } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { updateLocalConfig, getLocalConfig, setReplicationToken } = await import('./config/local-config.js');
    const { checkAdminAuth, resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { resetPasswordBrake } = await import('./password-brake.js');
    const { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { createTakeoverEnvelopeRoutes } = await import('./routes/takeover-envelope.js');
    const svc = await import('./services/takeover-envelope.js');
    const core = await import('@beanpool/core');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir!, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    const adminPass = 'TakeoverEnvelope-Secret-123!';
    const salt = crypto.randomBytes(16).toString('hex');
    const adminHash = crypto.scryptSync(adminPass, salt, 64).toString('hex');
    updateLocalConfig({ adminHash, salt });
    const repToken = 'rep-token-takeover-777';
    setReplicationToken(repToken);

    const deps: any = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true, clampLimit: (_v: unknown, d = 20) => d, clampOffset: () => 0,
        activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false,
    };
    const router = createTakeoverEnvelopeRoutes(deps);
    async function call(method: string, urlPath: string, opts: { headers?: Record<string, string>; body?: any; state?: any; keepBrake?: boolean } = {}) {
        const layer = (router.stack as any[]).find((l) => l.path === urlPath && l.methods.includes(method));
        if (!layer) throw new Error(`${method} ${urlPath} not mounted`);
        const h: Record<string, string> = { ...(opts.headers || {}) };
        const out: Record<string, string> = {};
        const ctx: any = {
            method, path: urlPath, headers: h, request: { header: h, headers: h, body: opts.body || {} },
            requestBody: opts.body || {}, status: 200, body: undefined, state: { ...(opts.state || {}) },
            set: (k: string, v: string) => { out[k.toLowerCase()] = v; }, get: (k: string) => h[k.toLowerCase()],
            ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' }, req: { socket: { remoteAddress: '203.0.113.7' } },
            res: { on: () => {} },
        };
        if (!opts.keepBrake) resetAdminAuthTarpit(); // it also clears the password brake
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
        return { status: ctx.status, body: ctx.body, headers: out };
    }
    const admin = { 'x-admin-password': adminPass };

    const stored = () => {
        const p = path.join(dataDir!, svc.TAKEOVER_ENVELOPE_FILE);
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
    };
    const envelopeBytes = () => new Uint8Array(Buffer.from(stored().envelope, 'base64'));
    const headerNow = () => core.readSealedHeader(envelopeBytes());
    const ownersIn = (h: any) => h.recipients.filter((r: any) => r.type === 'owner').map((r: any) => r.pubkey).sort();
    const opens = async (bytes: Uint8Array, key: any) => {
        try { return (await core.openEnvelope(bytes, key, { kind: 'takeover' })).payload; } catch { return null; }
    };

    function addMember(w: Who) {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(w.pub, w.callsign);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(w.pub);
    }

    // ── 1. Nobody to seal to ──
    console.log('\n— 1. no owner, no code —');
    // The periodic check is parked (an hour) until section 5, so every re-seal before then is a chokepoint's.
    const boot = await svc.startTakeoverEnvelopeService({ checkIntervalMs: 3_600_000 });
    assert(boot.state === 'no-recipients', `1. boot with no owner and no code reports no-recipients (got ${boot.state})`);
    assert(/no owner and no recovery code/.test(boot.message), `1. …and says why in words: "${boot.message}"`);
    assert(stored() === null, '1. no envelope file on disk');
    const st1 = await call('POST', '/api/local/admin/takeover/status', { headers: admin });
    assert(st1.status === 200 && st1.body.state === 'no-recipients' && st1.body.envelopeId === null, '1. the status route says the same');
    const tok1 = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken } });
    assert(tok1.status === 404 && tok1.body.state === 'no-recipients' && /nobody to lock/.test(tok1.body.error), `1. the token gets 404 with the reason (got ${tok1.status})`);

    // ── 2. First owner ──
    console.log('\n— 2. first owner —');
    const anna = member('Anna'), ben = member('Ben'), cleo = member('Cleo'), dan = member('Dan'), eve = member('Eve');
    const mo = member('Mo'); // an admin, never an owner
    for (const w of [anna, ben, cleo, dan, eve, mo]) addMember(w);
    grantNodeRole(anna.pub, 'owner', 'owner:password');
    await sleep(150);
    const s2 = stored();
    assert(!!s2, '2. granting the first owner sealed an envelope via the chokepoint');
    assert(JSON.stringify(ownersIn(headerNow())) === JSON.stringify([anna.pub]), '2. sealed to Anna alone');
    const payload2 = await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed });
    assert(!!payload2, '2. Anna opens it with her member key');
    const bundle = JSON.parse(Buffer.from(payload2!).toString('utf-8'));
    assert(bundle.files.libp2p_key === fs.readFileSync(path.join(dataDir!, 'libp2p_key')).toString('base64'), '2. the bundle holds data/libp2p_key byte for byte');
    assert(bundle.files['community.key'] === fs.readFileSync(path.join(dataDir!, 'community.key')).toString('base64'), '2. …and community.key');
    const sealKeyPath = path.join(dataDir!, 'recovery-seal.key');
    const sealKeyBytes = fs.readFileSync(sealKeyPath);
    assert(sealKeyBytes.length === 32 && bundle.files['recovery-seal.key'] === sealKeyBytes.toString('base64'),
        "2. …and data/recovery-seal.key, byte for byte (S2: the key that opens members' sign-in recovery copies)");
    assert(stored().carriesRecoverySealKey === true && !JSON.stringify(stored()).replace(stored().envelope, '').includes(sealKeyBytes.toString('base64')),
        '2. the file on disk records that it carries it, and holds the key only inside the sealed bytes');
    assert(bundle.localConfig.adminHash === adminHash && bundle.localConfig.salt === salt, '2. …and the admin hash and salt');
    assert(bundle.nodeRoles.some((r: any) => r.member_pubkey === anna.pub && r.role === 'owner'), '2. …and the node_roles rows');
    assert(!('replicationTokenHash' in bundle.localConfig) && !JSON.stringify(bundle).includes(getLocalConfig().replicationTokenHash!), '2. …and not the replication token hash');
    const genesis = JSON.parse(fs.readFileSync(path.join(dataDir!, 'genesis.json'), 'utf-8'));
    assert(headerNow().communityId === genesis.communityId, '2. the header names this community');

    // ── 3/4. Each chokepoint re-seals, and a removed owner is locked out of the new envelope ──
    console.log('\n— 3. grant / revoke / disable / prune —');
    const seen = new Set<string>([s2.envelopeId]);
    async function afterChokepoint(label: string, expectOwners: Who[], lockedOut: Who[] = []) {
        await sleep(150); // > debounce; the periodic check is parked
        const s = stored();
        assert(!!s && !seen.has(s.envelopeId), `3. ${label}: a new envelopeId (${s?.envelopeId?.slice(0, 8)})`);
        seen.add(s.envelopeId);
        const want = expectOwners.map((w) => w.pub).sort();
        assert(JSON.stringify(ownersIn(headerNow())) === JSON.stringify(want), `3. ${label}: recipients are exactly ${expectOwners.map((w) => w.callsign).join(', ')}`);
        for (const w of expectOwners) assert(!!(await opens(envelopeBytes(), { type: 'owner', privateKey: w.seed })), `3. ${label}: ${w.callsign} opens it`);
        for (const w of lockedOut) assert((await opens(envelopeBytes(), { type: 'owner', privateKey: w.seed })) === null, `4. ${label}: ${w.callsign} cannot open the NEW envelope`);
        return s;
    }
    grantNodeRole(ben.pub, 'owner', anna.pub);
    const sBen = await afterChokepoint('grant Ben', [anna, ben]);
    const benEnvelope = new Uint8Array(Buffer.from(sBen.envelope, 'base64'));
    revokeNodeRole(ben.pub, 'owner', anna.pub);
    await afterChokepoint('revoke Ben', [anna], [ben]);
    assert(!!(await opens(benEnvelope, { type: 'owner', privateKey: ben.seed })), '4. (as designed: Ben still opens the envelope sealed while he was an owner — removal cannot un-share the past)');

    grantNodeRole(cleo.pub, 'owner', anna.pub);
    await afterChokepoint('grant Cleo', [anna, cleo]);
    adminSetUserStatus(cleo.pub, 'disabled');
    await afterChokepoint('disable Cleo', [anna], [cleo]);

    grantNodeRole(dan.pub, 'owner', anna.pub);
    await afterChokepoint('grant Dan', [anna, dan]);
    adminPruneUser(dan.pub, 'owner:password');
    await afterChokepoint('prune Dan', [anna], [dan]);

    // An admin is never a recipient: only owners are.
    grantNodeRole(mo.pub, 'admin', anna.pub);
    await sleep(150);
    assert(!ownersIn(headerNow()).includes(mo.pub), '3. an admin is not a recipient');

    // ── 5. A raw-SQL delete, which no chokepoint sees ──
    console.log('\n— 5. raw SQL —');
    grantNodeRole(eve.pub, 'owner', anna.pub);
    await afterChokepoint('grant Eve', [anna, eve]);
    const beforeRaw = stored().envelopeId;
    const eveRow = db.prepare('SELECT * FROM node_roles WHERE member_pubkey = ?').get(eve.pub) as any;
    db.prepare('DELETE FROM node_roles WHERE member_pubkey = ?').run(eve.pub);
    await sleep(200);
    assert(stored().envelopeId === beforeRaw, '5. (control) with no chokepoint and the periodic check parked, nothing re-seals');
    // Put the row back exactly, start the periodic check (its start-up check finds nothing changed), then delete
    // again: only the periodic tick can see it.
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
                VALUES (?, ?, ?, ?, ?, ?)`).run(eveRow.member_pubkey, eveRow.role, eveRow.granted_at, eveRow.granted_by, eveRow.session_epoch, eveRow.break_glass_hash);
    const restarted = await svc.startTakeoverEnvelopeService({ checkIntervalMs: 100 });
    assert(restarted.envelopeId === beforeRaw, '5. (control) with the row back, the start-up check finds nothing to do');
    db.prepare('DELETE FROM node_roles WHERE member_pubkey = ?').run(eve.pub);
    await sleep(400);
    await svc.startTakeoverEnvelopeService({ checkIntervalMs: 3_600_000 }); // park it again
    const sRaw = stored();
    assert(sRaw.envelopeId !== beforeRaw, '5. the periodic consistency check caught the raw-SQL role delete and re-sealed');
    assert(/consistency check/.test(sRaw.reason), `5. …and records why ("${sRaw.reason}")`);
    assert(JSON.stringify(ownersIn(headerNow())) === JSON.stringify([anna.pub]), '5. Eve is no longer a recipient');
    assert((await opens(envelopeBytes(), { type: 'owner', privateKey: eve.seed })) === null, '5. Eve cannot open the new envelope');

    // ── 11. Idempotent boot ──
    const again = await svc.startTakeoverEnvelopeService({ checkIntervalMs: 3_600_000 });
    assert(again.state === 'sealed' && again.envelopeId === sRaw.envelopeId, '11. a boot with nothing changed keeps the same envelopeId');

    // ── 6. The recovery code ──
    console.log('\n— 6. recovery code —');
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, write: process.stdout.write.bind(process.stdout), ewrite: process.stderr.write.bind(process.stderr) };
    const grab = (...a: any[]) => { captured.push(a.map(String).join(' ')); };
    console.log = grab; console.warn = grab; console.error = grab; console.info = grab;
    (process.stdout as any).write = (c: any, ...r: any[]) => { captured.push(String(c)); return true; };
    (process.stderr as any).write = (c: any, ...r: any[]) => { captured.push(String(c)); return true; };
    let made: any;
    try {
        made = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: admin });
    } finally {
        Object.assign(console, { log: orig.log, warn: orig.warn, error: orig.error, info: orig.info });
        (process.stdout as any).write = orig.write; (process.stderr as any).write = orig.ewrite;
    }
    assert(made.status === 200 && typeof made.body.code === 'string' && made.body.codeId === 1, `6. an owner (password) makes code #1 (got ${made.status})`);
    assert(made.headers['cache-control'] === 'no-store', '6. the response is no-store');
    const code1: string = made.body.code;
    assert(/^BPRC-1 {2}([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/.test(code1), '6. it is a printed-form code');
    assert(made.body.status.state === 'sealed' && made.body.status.recipients.codes[0]?.codeId === 1, '6. the envelope was re-sealed to it before the response');
    assert(!!(await opens(envelopeBytes(), { type: 'code', code: code1 })), '6. the code opens the envelope');
    assert(!!(await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed })), '6. Anna still opens it');

    // Absent from disk (every file under the data dir, the database, its WAL and the log table included), from
    // local-config.json, and from everything written to the console while it was made.
    const body = code1.replace(/^BPRC-1\s+/, '');
    const needles = [code1, body, body.replace(/-/g, ''), body.toLowerCase(), body.replace(/-/g, '').toLowerCase()];
    const hits: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else {
                const buf = fs.readFileSync(p);
                for (const n of needles) {
                    if (buf.includes(Buffer.from(n, 'utf-8')) || buf.includes(Buffer.from(n, 'utf16le'))) hits.push(`${p}: ${n.slice(0, 6)}…`);
                }
            }
        }
    };
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL */ }
    walk(dataDir!);
    assert(hits.length === 0, `6. the code is nowhere under the data dir (${hits.join('; ') || 'no hits'})`);
    const cfgRaw = fs.readFileSync(path.join(dataDir!, 'local-config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw);
    assert(cfg.recoveryCode?.codeId === 1 && typeof cfg.recoveryCode.codePub === 'string' && !('code' in cfg.recoveryCode), '6. local-config.json keeps the public record only');
    assert(!needles.some((n) => cfgRaw.includes(n)), '6. …and not the code');
    const logText = (db.prepare('SELECT group_concat(message || COALESCE(metadata, \'\'), \'\n\') t FROM system_logs').get() as any).t || '';
    assert(!needles.some((n) => logText.includes(n)), '6. the system log does not hold it');
    assert(captured.length > 0 && !needles.some((n) => captured.join('\n').includes(n)), `6. nothing written to the console while making it holds it (${captured.length} lines captured)`);

    const dup = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: admin });
    assert(dup.status === 409 && dup.body.needsReplace === true && !('code' in dup.body), '6. making another without replace: true is refused, 409');
    const rotated = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: admin, body: { replace: true } });
    assert(rotated.status === 200 && rotated.body.codeId === 2 && rotated.body.replacedCodeId === 1, '6. replace: true makes code #2');
    const code2: string = rotated.body.code;
    assert(!!(await opens(envelopeBytes(), { type: 'code', code: code2 })), '6. code #2 opens the new envelope');
    assert((await opens(envelopeBytes(), { type: 'code', code: code1 })) === null, '6. code #1 does not open the new envelope');
    assert(ownersIn(headerNow()).length === 1 && headerNow().recipients.filter((r: any) => r.type === 'code').length === 1, '6. sealed to one owner and one code only');

    // ── 7. Check the code ──
    const keySession = (w: Who): string => {
        const chal = createAdminChallenge();
        const signature = Buffer.from(ed25519.sign(Buffer.from(chal.challenge, 'utf-8'), w.seed)).toString('hex');
        const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: w.pub, signature });
        if (!solved.ok) throw new Error('key sign-in failed: ' + solved.error);
        const ex = consumeHandshakeToken(solved.handshakeToken!);
        if (!ex.ok) throw new Error('handshake failed: ' + ex.error);
        return ex.sessionId!;
    };
    console.log('\n— 7. check-code —');
    resetPasswordBrake();
    const c1 = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: admin, body: { code: code2 } });
    assert(c1.status === 200 && c1.body.matches === true && c1.body.codeId === 2, '7. the current code → true');
    const c2 = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: admin, body: { code: code1 } });
    assert(c2.status === 200 && c2.body.matches === false, '7. the replaced code → false');
    const other = (await core.createRecoveryCode(2)).code; // right number, different code: runs scrypt
    const c3 = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: admin, body: { code: other } });
    assert(c3.status === 200 && c3.body.matches === false, '7. a well-formed wrong code → false');
    const chars = code2.split('');
    const i = chars.length - 3;
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    const c4 = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: admin, body: { code: chars.join('') } });
    assert(c4.status === 400 && c4.body.typo === true, '7. a typo is a 400 with typo: true');
    // The brake: SOURCE_FREE_FAILURES (5) wrong guesses are free, the next closes this source for a while. Under an
    // owner's key session (under the password, each right password clears the source's record, as it always has).
    resetPasswordBrake();
    const annaSession = keySession(anna);
    for (let k = 0; k < 6; k++) {
        const r = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: { 'x-admin-session': annaSession }, body: { code: other }, keepBrake: true });
        if (r.status !== 200 || r.body.matches !== false) throw new Error(`wrong-code check ${k} answered ${r.status}`);
    }
    const braked = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: { 'x-admin-session': annaSession }, body: { code: code2 }, keepBrake: true });
    assert(braked.status === 429 && braked.body.passwordBackoff === true, `7. after 6 wrong codes the source is braked, even for the right one (got ${braked.status})`);
    resetPasswordBrake();

    // ── 8. The token ──
    console.log('\n— 8. the replication token —');
    updateNodeConfig({ publicAddress: { name: 'anna-town', mode: 'tunnel', hostname: 'anna-town.beanpool.org', status: 'live', tunnelToken: 'TUNNEL-SECRET-abc123' } } as any);
    await sleep(150);
    const sPa = stored();
    assert(!seen.has(sPa.envelopeId) && sPa.reason.includes('public address'), '8. a public-address change re-sealed');
    const t1 = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken } });
    assert(t1.status === 200 && Buffer.isBuffer(t1.body), `8. the token gets the envelope (got ${t1.status})`);
    assert(t1.headers.etag === `"${sPa.envelopeId}"` && t1.headers['content-type'] === 'application/octet-stream', '8. with ETag = envelopeId, as octet-stream');
    const served = new Uint8Array(t1.body);
    assert(Buffer.compare(Buffer.from(served), Buffer.from(sPa.envelope, 'base64')) === 0, '8. the bytes are the sealed envelope on disk, nothing more');
    const servedText = Buffer.from(served).toString('latin1');
    const tokenPayload = await opens(served, { type: 'owner', privateKey: anna.seed });
    const plain = JSON.parse(Buffer.from(tokenPayload!).toString('utf-8'));
    const plaintextFields: [string, string][] = [
        ['admin hash', adminHash], ['admin salt', salt], ['tunnel token', 'TUNNEL-SECRET-abc123'],
        ['libp2p_key', plain.files.libp2p_key], ['community.key', plain.files['community.key']],
        ['libp2p_key (raw)', fs.readFileSync(path.join(dataDir!, 'libp2p_key')).toString('latin1')],
        ['community.key (raw)', fs.readFileSync(path.join(dataDir!, 'community.key')).toString('latin1')],
        ['a role row', `"member_pubkey":"${anna.pub}"`],
        ['recovery-seal.key (base64)', sealKeyBytes.toString('base64')], ['recovery-seal.key (hex)', sealKeyBytes.toString('hex')],
        ['recovery-seal.key (raw)', sealKeyBytes.toString('latin1')],
    ];
    for (const [name, v] of plaintextFields) assert(!servedText.includes(v), `8. the token's response does not contain the ${name}`);
    assert(plain.publicAddress?.tunnelToken === 'TUNNEL-SECRET-abc123', '8. (the tunnel token is inside, sealed — Anna sees it once opened)');
    const t304 = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken, 'if-none-match': `"${sPa.envelopeId}"` } });
    assert(t304.status === 304 && t304.body === undefined, '8. If-None-Match with the current id → 304, no body');
    const tOld = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken, 'if-none-match': `"${s2.envelopeId}"` } });
    assert(tOld.status === 200, '8. an old id → 200 with the new envelope');
    const tBad = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': 'wrong' } });
    assert(tBad.status === 401, '8. a wrong token → 401');
    const tNone = await call('GET', '/api/local/admin/takeover-envelope');
    assert(tNone.status === 401, '8. no credentials → 401');
    const tAdmin = await call('GET', '/api/local/admin/takeover-envelope', { headers: admin });
    assert(tAdmin.status === 200 && Buffer.isBuffer(tAdmin.body), '8. the admin password gets it too');
    for (const [m, p, b] of [
        ['POST', '/api/local/admin/takeover/status', {}],
        ['POST', '/api/local/admin/takeover/recovery-code', { replace: true }],
        ['POST', '/api/local/admin/takeover/recovery-code/check', { code: code2 }],
    ] as const) {
        const r = await call(m, p, { headers: { 'x-replication-token': repToken }, body: b });
        assert(r.status === 401 && !r.body?.code, `8. the token cannot reach ${p} (got ${r.status})`);
    }
    const access = (db.prepare(`SELECT value FROM node_config WHERE key = 'replication_access'`).get() as any)?.value || '';
    assert(access.includes('takeover envelope'), '8. token fetches are in the replication access log');

    // ── 9. Owner-only code routes ──
    console.log('\n— 9. owner only —');
    const moSession = keySession(mo);
    const moMake = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: { 'x-admin-session': moSession }, body: { replace: true } });
    assert(moMake.status === 403 && !moMake.body?.code, `9. an admin's key session cannot make a code (got ${moMake.status})`);
    const moCheck = await call('POST', '/api/local/admin/takeover/recovery-code/check', { headers: { 'x-admin-session': moSession }, body: { code: code2 } });
    assert(moCheck.status === 403, '9. …nor check one');
    const moStatus = await call('POST', '/api/local/admin/takeover/status', { headers: { 'x-admin-session': moSession } });
    assert(moStatus.status === 200 && moStatus.body.state === 'sealed', '9. an admin may read the status');
    const annaMake = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: { 'x-admin-session': keySession(anna) }, body: { replace: true } });
    assert(annaMake.status === 200 && annaMake.body.codeId === 3, "9. an owner's key session makes code #3");
    assert(JSON.stringify(annaMake.body.status).indexOf(annaMake.body.code) === -1, '9. the status in that response does not repeat the code');
    // With 2FA on, the password alone reaches none of the admin routes here (checkAdminAuth); the token is unaffected.
    const { generateTotpSecret, generateTotpCode } = await import('./totp.js');
    const totpSecret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret });
    await svc.flushTakeoverChecks(); // the 2FA secret is in the bundle: this re-seals
    for (const p of ['/api/local/admin/takeover/status', '/api/local/admin/takeover/recovery-code', '/api/local/admin/takeover/recovery-code/check']) {
        const r = await call('POST', p, { headers: admin, body: { replace: true, code: 'x' } });
        assert(r.status === 401 && r.body?.totpRequired === true, `9. 2FA on: the password alone is refused on ${p}`);
    }
    const with2fa = await call('POST', '/api/local/admin/takeover/status', { headers: { ...admin, 'x-admin-totp': generateTotpCode(totpSecret) } });
    assert(with2fa.status === 200 && with2fa.body.state === 'sealed', '9. 2FA on: password + code reads the status');
    const opened2fa = JSON.parse(Buffer.from((await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed }))!).toString('utf-8'));
    assert(opened2fa.localConfig.totpEnabled === true && opened2fa.localConfig.totpSecret === totpSecret, '9. turning 2FA on re-sealed with the 2FA secret inside');
    const tok2fa = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken } });
    assert(tok2fa.status === 200 && !Buffer.from(tok2fa.body).toString('latin1').includes(totpSecret), '9. 2FA on: the token still gets the envelope, and not the 2FA secret');
    updateLocalConfig({ totpEnabled: false, totpSecret: null });

    // ── 10. The owner header route, over real HTTPS ──
    console.log('\n— 10. owner header fetch (real HTTPS) —');
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    const PORT = 8677;
    process.env.PORT_HTTPS = String(PORT);
    await startHttpsServer(PORT);
    const signedGet = async (p: string, w?: Who) => {
        const headers: Record<string, string> = {};
        if (w) {
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            headers['X-Public-Key'] = w.pub;
            headers['X-Signature'] = Buffer.from(ed25519.sign(Buffer.from(`GET\n${p}\n${ts}\n${nonce}\n`), w.seed)).toString('base64');
            headers['X-Timestamp'] = String(ts);
            headers['X-Nonce'] = nonce;
        }
        const res = await fetch(`https://localhost:${PORT}${p}`, { headers });
        let json: any = null;
        try { json = await res.json(); } catch { /* none */ }
        return { status: res.status, json };
    };
    const HP = '/api/node/takeover-envelope/header';
    const hAnna = await signedGet(HP, anna);
    const current = stored();
    assert(hAnna.status === 200 && hAnna.json.envelopeId === current.envelopeId && hAnna.json.youAreARecipient === true, `10. signed by an owner → 200 with the current header (got ${hAnna.status})`);
    assert(hAnna.json.header.sig && Array.isArray(hAnna.json.header.recipients), '10. …the public header: recipients and signature');
    const headerText = JSON.stringify(hAnna.json);
    assert(!headerText.includes(adminHash) && !headerText.includes('TUNNEL-SECRET') && !headerText.includes(plain.files.libp2p_key), '10. …and no plaintext field');
    assert(!headerText.includes(sealKeyBytes.toString('base64')) && !headerText.includes(sealKeyBytes.toString('hex')), '10. …nor the recovery-seal key');
    const hMo = await signedGet(HP, mo);
    assert(hMo.status === 403, `10. signed by a member who is not an owner → 403 (got ${hMo.status})`);
    const hNone = await signedGet(HP);
    assert(hNone.status === 401, `10. unsigned → 401 (got ${hNone.status})`);
    const tokOverHttp = await fetch(`https://localhost:${PORT}/api/local/admin/takeover-envelope`, { headers: { 'X-Replication-Token': repToken } });
    const tokBytes = Buffer.from(await tokOverHttp.arrayBuffer());
    assert(tokOverHttp.status === 200 && tokOverHttp.headers.get('etag') === `"${current.envelopeId}"` && tokBytes.equals(Buffer.from(current.envelope, 'base64')), '10. the envelope route over real HTTPS serves the sealed bytes to the token');

    // ── 12. Re-key: the lock follows an owner's new key through the chokepoint, not the periodic check ──
    console.log('\n— 12. re-key an owner —');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const fay = member('Fay');
    addMember(fay);
    grantNodeRole(fay.pub, 'owner', anna.pub);
    await sleep(150);
    assert(ownersIn(headerNow()).includes(fay.pub), '12. (setup) Fay is an owner and a recipient');
    const fayNew = member('Fay');
    const rk = issueRekeyCode(fay.pub, anna.pub);
    await sleep(150); // > debounce; the periodic check is still parked
    assert(!ownersIn(headerNow()).includes(fay.pub), '12. starting a re-key (old key suspended) drops the old key from the lock');
    assert(/member re-key started/.test(stored().reason), `12. …through its own chokepoint ("${stored().reason}")`);
    const beforeComplete = stored().envelopeId;
    completeRekey(fay.pub, fayNew.pub, rk.code, anna.pub);
    await sleep(150);
    assert(stored().envelopeId !== beforeComplete, '12. completing a re-key re-seals');
    // The session-epoch bump inside completeRekey also notes a change today (even though the old key no longer has
    // a row), so the reason is what shows the re-key's own chokepoint fired, not a side effect of another one.
    assert(/member re-keyed/.test(stored().reason), `12. …through the re-key's own chokepoint ("${stored().reason}")`);
    assert(ownersIn(headerNow()).includes(fayNew.pub) && !ownersIn(headerNow()).includes(fay.pub), '12. …to the owner\'s NEW key, not the old one');
    assert(!!(await opens(envelopeBytes(), { type: 'owner', privateKey: fayNew.seed })), '12. Fay\'s new key opens the file on disk');
    assert((await opens(envelopeBytes(), { type: 'owner', privateKey: fay.seed })) === null, '12. Fay\'s old key cannot');

    // ── 13. A standby makes no code: it seals nothing, so the paper would open nothing ──
    console.log('\n— 13. standby —');
    const recordBefore = JSON.stringify((getLocalConfig() as any).recoveryCode);
    await svc.startTakeoverEnvelopeService({ standby: true, checkIntervalMs: 3_600_000 });
    const onStandby = await call('POST', '/api/local/admin/takeover/recovery-code', { headers: admin, body: { replace: true } });
    assert(onStandby.status === 409 && onStandby.body.standby === true && !onStandby.body.code, `13. making a code on a standby → 409, no code (got ${onStandby.status})`);
    assert(/main server/.test(onStandby.body.error || ''), `13. …and says where to make it: "${onStandby.body.error}"`);
    assert(JSON.stringify((getLocalConfig() as any).recoveryCode) === recordBefore, '13. …and the stored record is unchanged');
    await svc.startTakeoverEnvelopeService({ checkIntervalMs: 3_600_000 });

    // ── 14. Recovery seal S2: whether the envelope carries the key, and it follows the file ──
    console.log('\n— 14. the recovery-seal key —');
    const keyNeedles = [sealKeyBytes.toString('base64'), sealKeyBytes.toString('hex'), sealKeyBytes.toString('base64url')];
    const noKeyIn = (text: string) => !keyNeedles.some((n) => text.includes(n));
    const st14 = await call('POST', '/api/local/admin/takeover/status', { headers: admin });
    assert(st14.status === 200 && st14.body.recoverySealKey?.carried === true
        && st14.body.recoverySealKey.message === "The locked keys carry the key that opens members' sign-in recovery copies, so a server that takes over opens them.",
        `14. the status says the envelope carries the key, in words (${JSON.stringify(st14.body.recoverySealKey)})`);
    assert(noKeyIn(JSON.stringify(st14.body)), '14. …and never the key itself');
    const withKey = stored().envelopeId;
    const aside = path.join(fs.mkdtempSync(path.join(path.dirname(dataDir!), 'seal-key-aside-')), 'recovery-seal.key');
    fs.renameSync(sealKeyPath, aside);
    const gone = await svc.flushTakeoverChecks();
    const openedGone = JSON.parse(Buffer.from((await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed }))!).toString('utf-8'));
    assert(gone.state === 'sealed' && stored().envelopeId !== withKey && openedGone.files['recovery-seal.key'] === null && stored().carriesRecoverySealKey === false,
        '14. the key file gone: the envelope is re-sealed without it');
    const stGone = await call('POST', '/api/local/admin/takeover/status', { headers: admin });
    assert(stGone.body.recoverySealKey?.carried === false && /do not carry the key .*this server.s data\/recovery-seal\.key is missing or is not a key\./.test(stGone.body.recoverySealKey.message)
        && /12 words still work/.test(stGone.body.recoverySealKey.message),
        `14. …and the status says so, and what it means (${stGone.body.recoverySealKey?.message})`);
    // The file appears again, and no chokepoint says so: the periodic check alone re-seals with it.
    const withoutKey = stored().envelopeId;
    await svc.startTakeoverEnvelopeService({ checkIntervalMs: 100 });
    await sleep(250);
    assert(stored().envelopeId === withoutKey, '14. (control) with nothing changed, the periodic check keeps the envelope');
    fs.copyFileSync(aside, sealKeyPath);
    fs.chmodSync(sealKeyPath, 0o600);
    await sleep(400);
    await svc.startTakeoverEnvelopeService({ checkIntervalMs: 3_600_000 }); // park it again
    const back = stored();
    const openedBack = JSON.parse(Buffer.from((await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed }))!).toString('utf-8'));
    assert(back.envelopeId !== withoutKey && /consistency check/.test(back.reason) && back.carriesRecoverySealKey === true
        && openedBack.files['recovery-seal.key'] === sealKeyBytes.toString('base64'),
        `14. the key file back: the periodic check re-seals with it, byte for byte ("${back.reason}")`);
    // A file that is not a 32-byte key opens nothing, so it is not carried.
    fs.writeFileSync(sealKeyPath, Buffer.from('not a key'), { mode: 0o600 });
    await svc.flushTakeoverChecks();
    const openedBad = JSON.parse(Buffer.from((await opens(envelopeBytes(), { type: 'owner', privateKey: anna.seed }))!).toString('utf-8'));
    assert(openedBad.files['recovery-seal.key'] === null && stored().carriesRecoverySealKey === false, '14. a key file that is not a 32-byte key is not carried');
    fs.copyFileSync(aside, sealKeyPath);
    fs.chmodSync(sealKeyPath, 0o600);
    await svc.flushTakeoverChecks();
    fs.rmSync(path.dirname(aside), { recursive: true, force: true });
    assert(stored().carriesRecoverySealKey === true, '14. (the real key back, carried again)');
    const tok14 = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken } });
    assert(tok14.status === 200 && noKeyIn(Buffer.from(tok14.body).toString('latin1')) && !Buffer.from(tok14.body).includes(sealKeyBytes),
        "14. the token's envelope holds the key only sealed: none of its bytes, in any form");

    // ── 1 again: removing the last recipient removes the envelope ──
    console.log('\n— 1b. back to nobody —');
    updateLocalConfig({ recoveryCode: null } as any);
    db.prepare('DELETE FROM node_roles').run();
    const nobody = await svc.flushTakeoverChecks();
    assert(nobody.state === 'no-recipients' && stored() === null, '1. with every owner and the code gone, the envelope is removed, not left locked to ex-owners');
    const tok404 = await call('GET', '/api/local/admin/takeover-envelope', { headers: { 'x-replication-token': repToken } });
    assert(tok404.status === 404 && /no owner and no recovery code/.test(tok404.body.error), '1. and the token is told why');

    svc.stopTakeoverEnvelopeService();
    console.log(`\n🎉 All ${testsPassed}/${testsRun} take-over envelope tests PASSED!\n`);
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
