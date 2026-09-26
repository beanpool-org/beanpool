/**
 * An admin route that waits (a password check runs scrypt off the event loop) never writes back a copy of the
 * settings file it read before the wait.
 *
 * The change-password route read local-config.json at its start, waited for the password check, then saved that
 * whole copy: whatever another request wrote meanwhile (two-factor setup, a gateway setting, another owner's new
 * password) was silently undone. It also answered success when the new hash never reached the disk. Update identity
 * did the same whole-file save, and verify-password wrote back the backup-code list it read before its waits, so a
 * backup code spent (or a whole new set enrolled) meanwhile came back.
 *
 * Each case holds one scrypt run open (the request's password check), makes a write while it is held, then lets it
 * go. A Koa app with the real checkAdminAuth and the real community and settings routes, without the per-IP auth
 * rate limit (the password brake is real). No request leaves this process.
 *
 *   A. Change password while two-factor setup and a gateway setting land: all three survive, and the first-password
 *      file is deleted once the new hash is on disk.
 *   B. Change password while another owner's new password lands: refused (409); the other owner's password stands.
 *   C. Change password whose save fails: reported as a failure; the old password still works; the first-password
 *      file is kept.
 *   D. Update identity while two-factor setup lands: both survive.
 *   E. Verify-password spends a backup code while another is spent: both stay spent.
 *   F. Verify-password with an old backup code while two-factor is re-enrolled: refused; the new codes stay.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-config-write-races.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import Koa from 'koa';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { checkAdminAuth } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import {
    updateLocalConfig, getLocalConfig, hashPassword, verifyPassword, updateGatewayConfig, firstPasswordPath,
} from './config/local-config.js';
import { generateTotpSecret, generateBackupCodes, hashBackupCode } from './totp.js';
import { createCommunityRoutes } from './routes/community.js';
import { createSettingsRoutes } from './routes/settings.js';
import { resetPasswordBrake } from './password-brake.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// Hold one scrypt run open. local-config.ts imports `scrypt` by name from node:crypto; syncBuiltinESMExports makes
// the named export follow this replacement. holdNextScrypt() arms it: the next run computes as usual, but its answer
// waits for release(), so whatever the test writes meanwhile lands while that request is between its awaits.
const realScrypt = crypto.scrypt as any;
let armed: { entered: () => void; gate: Promise<void> } | null = null;
(crypto as any).scrypt = (...args: any[]) => {
    const hold = armed;
    armed = null;
    if (!hold) return realScrypt(...args);
    hold.entered();
    const cb = args[args.length - 1];
    return realScrypt(...args.slice(0, -1), (err: Error | null, key: Buffer) => { hold.gate.then(() => cb(err, key)); });
};
syncBuiltinESMExports();

function holdNextScrypt(): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const enteredP = new Promise<void>((r) => { entered = r; });
    armed = { entered, gate };
    return { entered: enteredP, release };
}

const PW = 'RaceFirst-123!';
const NEW_PW = 'RaceSecond-456!';
const OTHER_PW = 'RaceOther-789!';

const works = (pw: string) => {
    const c = getLocalConfig();
    return !!(c.adminHash && c.salt && verifyPassword(pw, c.adminHash, c.salt));
};
function setPassword(pw: string): void {
    const { hash, salt } = hashPassword(pw);
    updateLocalConfig({ adminHash: hash, salt });
}
function set2fa(secret: string | null, codes: string[] = []): void {
    updateLocalConfig(secret
        ? { totpEnabled: true, totpSecret: secret, totpBackupCodesHashes: codes.map(hashBackupCode), totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}
const sameSet = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && [...a].sort().join() === [...b].sort().join();

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { privateKey, pubKeyHex };
}
function keySession(kp: ReturnType<typeof makeKeypair>): string {
    const chal = createAdminChallenge();
    const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
    const solved = verifyAndSolveChallenge({ challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature });
    if (!solved.ok) throw new Error(solved.error);
    const ex = consumeHandshakeToken(solved.handshakeToken!);
    if (!ex.ok) throw new Error(ex.error);
    return ex.sessionId!;
}

async function main() {
    console.log('--- TEST: a route that waits never writes back a settings file it read before the wait ---');
    initStateEngine();
    setPassword(PW);
    set2fa(null);
    const olive = makeKeypair();
    seedGenesisMember(olive.pubKeyHex, 'Olive');

    const app = new Koa();
    app.use(async (ctx, next) => {
        if (ctx.method !== 'GET') {
            const chunks: Buffer[] = [];
            for await (const chunk of ctx.req) chunks.push(chunk as Buffer);
            const str = Buffer.concat(chunks).toString('utf8');
            try { (ctx as any).requestBody = str ? JSON.parse(str) : {}; } catch { (ctx as any).requestBody = {}; }
        }
        await next();
    });
    const deps: any = {
        checkAdminAuth,
        rateLimit: () => true,
        clampLimit: (v: unknown, d = 50) => Number(v) || d,
        clampOffset: (v: unknown) => Number(v) || 0,
        enforceReadAuth: false,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
    };
    const community = createCommunityRoutes(deps);
    const settings = createSettingsRoutes(deps);
    app.use(community.routes()).use(community.allowedMethods());
    app.use(settings.routes()).use(settings.allowedMethods());
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as any).port}`;

    async function call(path: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: any }> {
        const res = await fetch(`${base}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        });
        let b: any = {};
        try { b = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: b };
    }
    /** Start `path` as a password caller, and resolve once its password check is under way and held. */
    async function heldCall(path: string, body: any) {
        const hold = holdNextScrypt();
        const answer = call(path, {}, body);
        await hold.entered;
        return { answer, release: hold.release };
    }

    try {
        // Key sessions are made while 2FA is off (a key sign-in under 2FA asks for the code too). They take no
        // scrypt and no password brake, so their writes land while a password caller is held.
        const asOwner = { 'x-admin-session': keySession(olive) };

        // ── A ────────────────────────────────────────────────────────────────────────────────
        console.log('\nA. Change password while two-factor setup and a gateway setting land');
        fs.writeFileSync(firstPasswordPath(), PW + '\n', { mode: 0o600 });
        const a = await heldCall('/api/local/change-password', { password: PW, currentPassword: PW, newPassword: NEW_PW });
        const setupA = await call('/api/local/admin/2fa/setup', asOwner, {});
        assert(setupA.status === 200, `A0. (setup) two-factor setup lands while the change is held (${setupA.status})`);
        updateGatewayConfig({ corsAllowedOrigins: ['https://pwa.example.org'] });
        const pendingA = getLocalConfig().totpPendingSecret;
        a.release();
        const changedA = await a.answer;
        assert(changedA.status === 200, `A1. the change succeeds (${changedA.status})`);
        assert(works(NEW_PW) && !works(PW), 'A2. the new password is on disk and the old one no longer works');
        assert(!!pendingA && getLocalConfig().totpPendingSecret === pendingA, 'A3. the two-factor setup it waited through is still there');
        assert(sameSet(getLocalConfig().totpPendingBackupCodesHashes, (setupA.body.backupCodes || []).map(hashBackupCode)),
            'A4. with its backup codes');
        assert(sameSet(getLocalConfig().gateway?.corsAllowedOrigins, ['https://pwa.example.org']), 'A5. and so is the gateway setting');
        assert(!fs.existsSync(firstPasswordPath()), 'A6. the first-password file is deleted: the new hash is on disk');

        // ── B ────────────────────────────────────────────────────────────────────────────────
        console.log("\nB. Change password while another owner's new password lands");
        setPassword(PW);
        const b = await heldCall('/api/local/change-password', { password: PW, currentPassword: PW, newPassword: NEW_PW });
        setPassword(OTHER_PW); // what another owner's change-password writes
        b.release();
        const changedB = await b.answer;
        assert(changedB.status === 409, `B1. refused: the password it proved was replaced while it was checked (${changedB.status})`);
        assert(works(OTHER_PW), "B2. the other owner's password stands");
        assert(!works(NEW_PW) && !works(PW), 'B3. (control) neither the refused one nor the replaced one works');

        // ── C ────────────────────────────────────────────────────────────────────────────────
        console.log('\nC. Change password whose save fails');
        if (process.getuid?.() === 0) {
            // Root writes through a read-only file, so the failure cannot be made here. CI runs as a normal user.
            console.log('  (not run: this runs as root, and a read-only file does not stop root writing)');
        } else {
            setPassword(PW);
            fs.writeFileSync(firstPasswordPath(), PW + '\n', { mode: 0o600 });
            const cfgPath = `${process.env.BEANPOOL_DATA_DIR}/local-config.json`;
            fs.chmodSync(cfgPath, 0o444); // saveLocalConfig's write fails, and it only logs that
            let changedC: { status: number; body: any };
            try {
                changedC = await call('/api/local/change-password', {}, { password: PW, currentPassword: PW, newPassword: NEW_PW });
            } finally {
                fs.chmodSync(cfgPath, 0o644);
            }
            assert(changedC.status >= 500 && !changedC.body?.success && typeof changedC.body?.error === 'string',
                `C1. reported as a failure, with an error (${changedC.status} ${JSON.stringify(changedC.body)})`);
            assert(works(PW) && !works(NEW_PW), 'C2. the old password still works; the new one was never saved');
            assert(fs.existsSync(firstPasswordPath()), 'C3. the first-password file is kept: it holds the password that works');
            fs.rmSync(firstPasswordPath(), { force: true });
        }

        // ── D ────────────────────────────────────────────────────────────────────────────────
        console.log('\nD. Update identity while two-factor setup lands');
        const d = await heldCall('/api/local/update-identity', { password: PW, callsign: 'RaceTown', communityName: 'Race Town' });
        const setupD = await call('/api/local/admin/2fa/setup', asOwner, {});
        assert(setupD.status === 200, `D0. (setup) two-factor setup lands while the update is held (${setupD.status})`);
        const pendingD = getLocalConfig().totpPendingSecret;
        d.release();
        const updatedD = await d.answer;
        assert(updatedD.status === 200, `D1. the update succeeds (${updatedD.status})`);
        assert(getLocalConfig().callsign === 'RaceTown' && getLocalConfig().communityName === 'Race Town', 'D2. the new name is saved');
        assert(!!pendingD && getLocalConfig().totpPendingSecret === pendingD, 'D3. the two-factor setup it waited through is still there');
        assert(works(PW), 'D4. (control) the password is untouched');

        // ── E ────────────────────────────────────────────────────────────────────────────────
        console.log('\nE. Verify-password spends a backup code while another one is spent');
        const secret = generateTotpSecret();
        const codes = generateBackupCodes(4);
        set2fa(secret, codes);
        resetPasswordBrake();
        const e = await heldCall('/api/local/verify-password', { password: PW, totpCode: codes[0] });
        // What checkAdminAuth writes when another request signs in with codes[1].
        updateLocalConfig({ totpBackupCodesHashes: [codes[0], codes[2], codes[3]].map(hashBackupCode) });
        e.release();
        const signedE = await e.answer;
        assert(signedE.status === 200, `E1. the sign-in with a backup code succeeds (${signedE.status})`);
        assert(sameSet(getLocalConfig().totpBackupCodesHashes, [codes[2], codes[3]].map(hashBackupCode)),
            `E2. both spent codes stay spent (${getLocalConfig().totpBackupCodesHashes?.length} left, expected 2)`);

        // ── F ────────────────────────────────────────────────────────────────────────────────
        console.log('\nF. Verify-password with an old backup code while two-factor is re-enrolled');
        const newSecret = generateTotpSecret();
        const newCodes = generateBackupCodes(4);
        const f = await heldCall('/api/local/verify-password', { password: PW, totpCode: codes[2] });
        set2fa(newSecret, newCodes); // what /2fa/verify writes when it replaces the authenticator
        f.release();
        const signedF = await f.answer;
        assert(signedF.status === 401, `F1. refused: that code belonged to the authenticator just replaced (${signedF.status})`);
        assert(getLocalConfig().totpSecret === newSecret, 'F2. the new authenticator stays');
        assert(sameSet(getLocalConfig().totpBackupCodesHashes, newCodes.map(hashBackupCode)), 'F3. with all its backup codes; the old ones do not come back');
    } finally {
        server.close();
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ No admin route writes back a settings file it read before a wait.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
