/**
 * The 2FA gaps Fable's review of #953 left open (optional findings 2, 3 and 5).
 *
 *   1. Replacing the authenticator needs a current code. /2fa/setup then /2fa/verify used to swap the active secret
 *      for any owner session, so a stolen session could enrol its own authenticator and then turn 2FA off with it.
 *      With 2FA on, verify now also needs a code that is right now from the CURRENT authenticator, or a backup code.
 *   2. A stolen owner session (key session, or password + 2FA session) cannot swap the secret and then disable.
 *   3. Wrong current codes add up and back off, like wrong passwords. A password caller with a 2FA session used to
 *      have each wrong code wiped by its own next request (checkAdminAuth cleared the brake on every valid session),
 *      so the count never passed 1. Measured here: the source gets 429, and Retry-After grows.
 *   4. /2fa/verify with no setup in progress used to check codes against the active secret with no brake at all.
 *   5. Change password on the password path: the current password is still required, and scrypt runs once.
 *
 * A Koa app with the real checkAdminAuth and the real community and settings routes, without the per-IP auth rate
 * limit (the password brake is real). No request leaves this process.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-2fa-reenrol-needs-code.ts
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import Koa from 'koa';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { updateLocalConfig, getLocalConfig, hashPassword } from './config/local-config.js';
import { generateTotpSecret, generateTotpCode, verifyTotpCode, generateBackupCodes, hashBackupCode } from './totp.js';
import { createCommunityRoutes } from './routes/community.js';
import { createSettingsRoutes } from './routes/settings.js';
import { SOURCE_FREE_FAILURES } from './password-brake.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

// Count scrypt runs. local-config.ts imports `scrypt` by name from node:crypto; syncBuiltinESMExports makes the
// named export follow this replacement.
let scryptRuns = 0;
const realScrypt = crypto.scrypt;
(crypto as any).scrypt = (...args: any[]) => { scryptRuns++; return (realScrypt as any)(...args); };
syncBuiltinESMExports();

const PW = 'ReEnrol123!';
const SECRET = generateTotpSecret();
const BACKUP = generateBackupCodes(4);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setPassword(): void {
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt });
}
function set2fa(on: boolean): void {
    updateLocalConfig(on
        ? { totpEnabled: true, totpSecret: SECRET, totpBackupCodesHashes: BACKUP.map(hashBackupCode), totpPendingSecret: null, totpPendingBackupCodesHashes: [] }
        : { totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], totpPendingSecret: null, totpPendingBackupCodesHashes: [] });
}
/** A six-digit code the current authenticator would not show now (nor in the windows either side). */
function wrongCode(secret = SECRET): string {
    for (;;) {
        const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        if (!verifyTotpCode(c, secret)) return c;
    }
}

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
    console.log('--- TEST: replacing or removing 2FA needs a current code, and wrong ones back off ---');
    initStateEngine();
    setPassword();
    set2fa(false);
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

    async function call(path: string, headers: Record<string, string>, body: any): Promise<{ status: number; body: any; retryAfter: number }> {
        const res = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        let b: any = {};
        try { b = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: b, retryAfter: Number(res.headers.get('retry-after') || 0) };
    }
    /** /2fa/setup, returning the new secret (and its backup codes). */
    async function setup(headers: Record<string, string>): Promise<{ secret: string; backupCodes: string[] }> {
        const r = await call('/api/local/admin/2fa/setup', headers, {});
        if (r.status !== 200) throw new Error(`setup → ${r.status} ${JSON.stringify(r.body)}`);
        return { secret: r.body.secret, backupCodes: r.body.backupCodes };
    }
    const activeSecret = () => getLocalConfig().totpSecret;

    try {
        // Key sessions are made while 2FA is off (a key sign-in under 2FA asks for the code too).
        const ownerSid = keySession(olive);
        const asOwner = { 'x-admin-session': ownerSid };

        set2fa(true);
        resetAdminAuthTarpit();
        const login = await call('/api/local/verify-password', {}, { password: PW, totpCode: generateTotpCode(SECRET) });
        const tfa = login.body.tfaSessionToken as string;
        assert(login.status === 200 && typeof tfa === 'string', 'password + a right code signs in and gets a 2FA session');
        const pwWith2fa = { 'X-Admin-Password': PW, 'X-Admin-2FA-Session': tfa };

        // ── 1. Re-enrolling with 2FA on needs a current code ──
        for (const [who, headers] of [['owner key session', asOwner], ['password + 2FA session', pwWith2fa]] as const) {
            resetAdminAuthTarpit();
            set2fa(true);
            const s = await setup(headers);
            const noCurrent = await call('/api/local/admin/2fa/verify', headers, { code: generateTotpCode(s.secret) });
            assert(noCurrent.status === 401 && noCurrent.body.totpRequired === true && activeSecret() === SECRET,
                `${who}: verify of a new authenticator with no current code → 401, secret unchanged (got ${noCurrent.status})`);
            const wrongCurrent = await call('/api/local/admin/2fa/verify', headers, { code: generateTotpCode(s.secret), currentCode: wrongCode() });
            assert(wrongCurrent.status === 401 && activeSecret() === SECRET,
                `${who}: …with a wrong current code → 401, secret unchanged (got ${wrongCurrent.status})`);
            // The new authenticator's code in currentCode is not a current code.
            const newAsCurrent = await call('/api/local/admin/2fa/verify', headers, { code: generateTotpCode(s.secret), currentCode: generateTotpCode(s.secret) });
            assert(newAsCurrent.status === 401 && activeSecret() === SECRET,
                `${who}: …with the NEW authenticator's code as the current one → 401 (got ${newAsCurrent.status})`);
            const withCurrent = await call('/api/local/admin/2fa/verify', headers, { code: generateTotpCode(s.secret), currentCode: generateTotpCode(SECRET) });
            assert(withCurrent.status === 200 && activeSecret() === s.secret && getLocalConfig().totpEnabled === true,
                `${who}: …with a right current code → 200 and the new secret is active (got ${withCurrent.status})`);
            assert(getLocalConfig().totpBackupCodesHashes?.length === s.backupCodes.length,
                `${who}: …and the new backup codes replace the old`);
        }

        // A backup code counts as the current factor (the owner who lost the phone can still move to a new one).
        resetAdminAuthTarpit();
        set2fa(true);
        {
            const s = await setup(asOwner);
            const withBackup = await call('/api/local/admin/2fa/verify', asOwner, { code: generateTotpCode(s.secret), currentCode: BACKUP[1] });
            assert(withBackup.status === 200 && activeSecret() === s.secret, `a backup code as the current code → 200, new secret active (got ${withBackup.status})`);
        }
        // The legacy page's shape: password + X-Admin-TOTP (no session). The one code signs in and is the current code.
        resetAdminAuthTarpit();
        set2fa(true);
        {
            const s = await setup(pwWith2fa);
            const inline = await call('/api/local/admin/2fa/verify', { 'X-Admin-Password': PW, 'X-Admin-TOTP': generateTotpCode(SECRET) }, { code: generateTotpCode(s.secret) });
            assert(inline.status === 200 && activeSecret() === s.secret, `password + X-Admin-TOTP (current code) → 200 (got ${inline.status})`);
            // With a 2FA session, X-Admin-TOTP is read as the current code too.
            set2fa(true);
            const s2 = await setup(pwWith2fa);
            const hdr = await call('/api/local/admin/2fa/verify', { ...pwWith2fa, 'X-Admin-TOTP': generateTotpCode(SECRET) }, { code: generateTotpCode(s2.secret) });
            assert(hdr.status === 200 && activeSecret() === s2.secret, `password + 2FA session + X-Admin-TOTP → 200 (got ${hdr.status})`);
        }
        // First-time setup (2FA off) is unchanged: no current code exists to ask for.
        resetAdminAuthTarpit();
        set2fa(false);
        {
            const s = await setup(asOwner);
            const first = await call('/api/local/admin/2fa/verify', asOwner, { code: generateTotpCode(s.secret) });
            assert(first.status === 200 && getLocalConfig().totpEnabled === true && activeSecret() === s.secret,
                `turning 2FA on for the first time needs only the new code (got ${first.status})`);
        }

        // ── 2. A stolen owner session: swap the secret, then disable ──
        for (const [who, headers] of [['stolen key session', asOwner], ['password + stolen 2FA session', pwWith2fa]] as const) {
            resetAdminAuthTarpit();
            set2fa(true);
            const theirs = await setup(headers);
            const swap = await call('/api/local/admin/2fa/verify', headers, { code: generateTotpCode(theirs.secret) });
            assert(swap.status === 401 && activeSecret() === SECRET, `${who}: swapping in the attacker's authenticator is refused (got ${swap.status})`);
            const off = await call('/api/local/admin/2fa/disable', headers, { code: generateTotpCode(theirs.secret) });
            assert(off.status === 401 && getLocalConfig().totpEnabled === true, `${who}: …so its code cannot turn 2FA off either (got ${off.status})`);
            const offBackup = await call('/api/local/admin/2fa/disable', headers, { code: theirs.backupCodes[0] });
            assert(offBackup.status === 401 && getLocalConfig().totpEnabled === true, `${who}: …nor can a backup code from its own setup (got ${offBackup.status})`);
        }

        // ── 3. Wrong current codes back off ──
        // Measures, per route and caller:
        //   - the brake: how many wrong codes are checked before the first 429, and this source's Retry-After on two
        //     429s in a row, waiting each out (wrong passwords: SOURCE_FREE_FAILURES free, then 2 s, 4 s, …);
        //   - the tarpit: how long each wrong code's 401 takes (250 ms more per failure, up to 5 s).
        // Before this PR, a password + 2FA session caller never reached a 429 (each request's sign-in cleared the
        // count) and a key session's wrong codes were not counted at all; neither's 401 slowed down.
        // Only the source's own 429s count ("from your network"): after two, the node-wide allowance for sources in
        // backoff (6 a minute, shared with the free failures) is spent, and that refusal is a different measure.
        async function measureBackoff(label: string, send: () => Promise<{ status: number; body: any; retryAfter: number }>): Promise<void> {
            resetAdminAuthTarpit();
            set2fa(true);
            const statuses: number[] = [];
            const waits: number[] = [];
            const took401: number[] = [];
            const started = Date.now();
            while (waits.length < 2 && statuses.length < 20) {
                const t0 = Date.now();
                const r = await send();
                statuses.push(r.status);
                if (r.status === 401) took401.push(Date.now() - t0);
                if (r.status === 429) {
                    if (!/from your network/.test(r.body.error || '')) break;
                    waits.push(r.retryAfter);
                    await sleep(r.retryAfter * 1000 + 100);
                }
            }
            const checkedBeforeBrake = statuses.indexOf(429);
            assert(checkedBeforeBrake !== -1 && checkedBeforeBrake <= SOURCE_FREE_FAILURES + 1,
                `${label}: braked after at most ${SOURCE_FREE_FAILURES + 1} wrong codes (checked ${checkedBeforeBrake}; statuses ${statuses.join(',')})`);
            assert(waits.length === 2 && waits[1] > waits[0],
                `${label}: the source's wait grows (Retry-After ${waits.join(' s, then ')} s; ${Math.round((Date.now() - started) / 1000)} s in all)`);
            assert(took401.length >= SOURCE_FREE_FAILURES && took401[took401.length - 1] >= took401[0] + 1000,
                `${label}: the tarpit grows (401s took ${took401.join(', ')} ms)`);
            assert(getLocalConfig().totpEnabled === true && activeSecret() === SECRET, `${label}: 2FA still on, secret unchanged`);
        }
        await measureBackoff('disable, password + 2FA session', () => call('/api/local/admin/2fa/disable', pwWith2fa, { code: wrongCode() }));
        await measureBackoff('disable, owner key session', () => call('/api/local/admin/2fa/disable', asOwner, { code: wrongCode() }));
        let pending = '';
        await measureBackoff('re-enrol verify, password + 2FA session', async () => {
            // A fresh setup each time is allowed; the new code is right, the current one wrong.
            if (!getLocalConfig().totpPendingSecret) pending = (await setup(asOwner)).secret;
            return call('/api/local/admin/2fa/verify', pwWith2fa, { code: generateTotpCode(pending), currentCode: wrongCode() });
        });
        await measureBackoff('re-enrol verify, owner key session', async () => {
            if (!getLocalConfig().totpPendingSecret) pending = (await setup(asOwner)).secret;
            return call('/api/local/admin/2fa/verify', asOwner, { code: generateTotpCode(pending), currentCode: wrongCode() });
        });

        // The right code from a braked source is not even checked: the brake holds until it lapses.
        resetAdminAuthTarpit();
        set2fa(true);
        for (let i = 0; i <= SOURCE_FREE_FAILURES; i++) await call('/api/local/admin/2fa/disable', asOwner, { code: wrongCode() });
        const rightWhileBraked = await call('/api/local/admin/2fa/disable', asOwner, { code: generateTotpCode(SECRET) });
        assert(rightWhileBraked.status === 429 && getLocalConfig().totpEnabled === true, `a right code from a braked source → 429, 2FA still on (got ${rightWhileBraked.status})`);

        // Right codes still work, and one clears the source's record.
        resetAdminAuthTarpit();
        set2fa(true);
        for (let i = 0; i < SOURCE_FREE_FAILURES - 1; i++) await call('/api/local/admin/2fa/disable', asOwner, { code: wrongCode() });
        {
            const s = await setup(asOwner);
            const ok = await call('/api/local/admin/2fa/verify', asOwner, { code: generateTotpCode(s.secret), currentCode: generateTotpCode(SECRET) });
            assert(ok.status === 200, `after ${SOURCE_FREE_FAILURES - 1} wrong codes, a right one still re-enrols (got ${ok.status})`);
            const statuses: number[] = [];
            for (let i = 0; i < SOURCE_FREE_FAILURES; i++) statuses.push((await call('/api/local/admin/2fa/disable', asOwner, { code: wrongCode(s.secret) })).status);
            assert(statuses.every(st => st === 401), `…and it cleared the record: ${SOURCE_FREE_FAILURES} more wrong codes are free again (${statuses.join(',')})`);
        }

        // ── 4. Verify with no setup in progress is braked ──
        resetAdminAuthTarpit();
        set2fa(true);
        {
            const statuses: number[] = [];
            for (let i = 0; i < SOURCE_FREE_FAILURES + 3; i++) {
                statuses.push((await call('/api/local/admin/2fa/verify', asOwner, { code: wrongCode() })).status);
            }
            assert(statuses.includes(429), `verify with no setup in progress, wrong codes against the active secret: braked (${statuses.join(',')})`);
            assert(statuses.filter(st => st !== 429).length <= SOURCE_FREE_FAILURES + 1, `…after at most ${SOURCE_FREE_FAILURES + 1} checked`);
            resetAdminAuthTarpit();
            const right = await call('/api/local/admin/2fa/verify', asOwner, { code: generateTotpCode(SECRET) });
            assert(right.status === 200 && activeSecret() === SECRET && getLocalConfig().totpEnabled === true,
                `…a right code there changes nothing (got ${right.status})`);
            set2fa(false);
            const off = await call('/api/local/admin/2fa/verify', asOwner, { code: '123456' });
            assert(off.status === 400, `with 2FA off and no setup, verify → 400 "call /2fa/setup first" (got ${off.status})`);
        }

        // ── 5. Change password: current password required, one scrypt ──
        set2fa(false);
        resetAdminAuthTarpit();
        {
            const NEW = 'ChangedPw456!';
            scryptRuns = 0;
            const ok = await call('/api/local/change-password', { 'X-Admin-Password': PW }, { currentPassword: PW, newPassword: NEW });
            assert(ok.status === 200, `password caller, right current password → 200 (got ${ok.status})`);
            assert(scryptRuns === 1, `…with one scrypt run (got ${scryptRuns})`);
            // The body-only client: currentPassword is its sign-in.
            scryptRuns = 0;
            const bodyOnly = await call('/api/local/change-password', {}, { currentPassword: NEW, newPassword: PW });
            assert(bodyOnly.status === 200 && scryptRuns === 1, `body-only client → 200 with one scrypt run (got ${bodyOnly.status}, ${scryptRuns})`);

            // The rule holds: the header password is right but currentPassword is wrong.
            scryptRuns = 0;
            const wrongCurrent = await call('/api/local/change-password', { 'X-Admin-Password': PW }, { currentPassword: 'NotTheOne1!', newPassword: NEW });
            assert(wrongCurrent.status === 401 && scryptRuns === 2, `right sign-in, wrong currentPassword → 401 (both checked: ${scryptRuns} scrypt runs)`);
            const missing = await call('/api/local/change-password', { 'X-Admin-Password': PW }, { newPassword: NEW });
            assert(missing.status === 401, `right sign-in, no currentPassword → 401 (got ${missing.status})`);
            // Surrounding space: sign-in trims it, currentPassword is checked as sent.
            const spaced = await call('/api/local/change-password', { 'X-Admin-Password': PW }, { currentPassword: ` ${PW}`, newPassword: NEW });
            assert(spaced.status === 401, `currentPassword with a leading space is checked as sent → 401 (got ${spaced.status})`);
            // A key session is not proof of the password.
            const keyNo = await call('/api/local/change-password', asOwner, { newPassword: NEW });
            assert(keyNo.status === 401, `key session, no currentPassword → 401 (got ${keyNo.status})`);
            scryptRuns = 0;
            const keyOk = await call('/api/local/change-password', asOwner, { currentPassword: PW, newPassword: NEW });
            assert(keyOk.status === 200 && scryptRuns === 1, `key session + right currentPassword → 200, one scrypt run (got ${keyOk.status}, ${scryptRuns})`);
            const oldGone = await call('/api/local/verify-password', {}, { password: PW });
            assert(oldGone.status === 401, `the old password no longer signs in (got ${oldGone.status})`);

            // Under 2FA, password + 2FA session: still one scrypt.
            set2fa(true);
            resetAdminAuthTarpit();
            const l = await call('/api/local/verify-password', {}, { password: NEW, totpCode: generateTotpCode(SECRET) });
            scryptRuns = 0;
            const under2fa = await call('/api/local/change-password', { 'X-Admin-Password': NEW, 'X-Admin-2FA-Session': l.body.tfaSessionToken }, { currentPassword: NEW, newPassword: PW });
            assert(under2fa.status === 200 && scryptRuns === 1, `under 2FA, password + 2FA session → 200 with one scrypt run (got ${under2fa.status}, ${scryptRuns})`);
        }
    } finally {
        server.close();
    }

    console.log(`\n========================================`);
    console.log(`Test Results: ${passed}/${run} assertions passed`);
    console.log(`========================================`);
    if (passed !== run) throw new Error(`${run - passed} assertions failed`);
}

main().then(() => process.exit(0)).catch(e => {
    console.error('Test failed with error:', e);
    process.exit(1);
});
