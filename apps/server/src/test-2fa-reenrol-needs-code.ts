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
 *   6. One wrong current code does not throttle the owner's own dashboard (Fable's review of #955, B1). The wrong
 *      code stays on the source's record (3), so each later request from it used to spend the node-wide allowance
 *      (12 a minute); the manager polls about 22 a minute, so it was refused, and so was signing in again. A right
 *      password with a valid 2FA session now hands its check back. Wrong codes still spend one and still back off.
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
import { SOURCE_FREE_FAILURES, NODE_CHECKS_PER_MIN, acquirePasswordAttempt, settlePasswordAttempt } from './password-brake.js';
import { limiterKeyForIp } from './client-ip.js';

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

    async function call(path: string, headers: Record<string, string>, body: any, method = 'POST'): Promise<{ status: number; body: any; retryAfter: number }> {
        const res = await fetch(`${base}${path}`, method === 'GET'
            ? { headers }
            : { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
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

        // ── 6. One wrong current code does not throttle the owner's own dashboard ──
        // Each caller is its own address (the test server is on loopback, which is a trusted proxy, so
        // X-Forwarded-For names the client). The password is PW again and 2FA is on after 5.
        set2fa(true);
        const HOME = { 'X-Forwarded-For': '203.0.113.7' };
        const ELSEWHERE = { 'X-Forwarded-For': '192.0.2.44' };
        const status = (headers: Record<string, string>) => call('/api/local/admin/2fa/status', headers, null, 'GET');
        async function signIn(from: Record<string, string>): Promise<{ status: number; session: Record<string, string> }> {
            const r = await call('/api/local/verify-password', from, { password: PW, totpCode: generateTotpCode(SECRET) });
            return { status: r.status, session: { ...from, 'X-Admin-Password': PW, 'X-Admin-2FA-Session': r.body.tfaSessionToken } };
        }
        /** Fill the node-wide allowance to `n` checks from other /24s, as a guesser would: each source's second wrong password is charged. */
        async function fillAllowance(n: number): Promise<void> {
            for (let i = 0; i < n; i++) {
                const key = limiterKeyForIp(`198.18.${i}.1`);
                for (let k = 0; k < 2; k++) {
                    const a = await acquirePasswordAttempt(key);
                    if (a.admitted) settlePasswordAttempt(key, false);
                }
            }
        }
        {
            // 6a. The manager's cadence (diagnostics every 5 s, registrar every 10 s, harvester every 15 s) for 90 s.
            resetAdminAuthTarpit();
            const home = await signIn(HOME);
            assert(home.status === 200, `owner signs in from home (got ${home.status})`);
            const typo = await call('/api/local/admin/2fa/disable', home.session, { code: wrongCode() });
            assert(typo.status === 401 && getLocalConfig().totpEnabled === true, `one mistyped current code on Disable 2FA → 401 (got ${typo.status})`);
            const polled: number[] = [];
            const until = Date.now() + 90_000;
            const poll = async (everyMs: number, offsetMs: number) => {
                await sleep(offsetMs);
                while (Date.now() < until) {
                    polled.push((await status(home.session)).status);
                    await sleep(everyMs);
                }
            };
            // Signing in again with the right code, a minute in, while the polling goes on (it clears the record, so
            // the polling after it is from a clean source; the minute before it is the measure).
            let again = { status: 0, session: {} as Record<string, string> };
            const reSignIn = async () => { await sleep(60_000); again = await signIn(HOME); };
            await Promise.all([poll(5_000, 0), poll(10_000, 1_700), poll(15_000, 3_300), reSignIn()]);
            const refused = polled.filter(st => st === 429).length;
            assert(polled.length >= 30 && refused === 0 && polled.every(st => st === 200),
                `…then 90 s of the manager's polling with its 2FA session: ${polled.length} requests, ${refused} × 429 (statuses ${[...new Set(polled)].join(',')})`);
            assert(again.status === 200, `…and signing in again with the right code, mid-polling, works straight away (got ${again.status})`);

            // 6b. A guesser's wrong current codes still back off, from the same session and address.
            const statuses: number[] = [];
            const took401: number[] = [];
            let sourceWait = 0;
            for (let i = 0; i < SOURCE_FREE_FAILURES + 3 && !sourceWait; i++) {
                const t0 = Date.now();
                const r = await call('/api/local/admin/2fa/disable', again.session, { code: wrongCode() });
                statuses.push(r.status);
                if (r.status === 401) took401.push(Date.now() - t0);
                if (r.status === 429 && /from your network/.test(r.body.error || '')) sourceWait = r.retryAfter;
            }
            assert(sourceWait > 0 && statuses.indexOf(429) <= SOURCE_FREE_FAILURES + 1,
                `…while wrong current codes still brake that address (statuses ${statuses.join(',')}, Retry-After ${sourceWait} s)`);
            assert(took401.length >= 2 && took401[took401.length - 1] > took401[0],
                `…and the tarpit on them grows (401s took ${took401.join(', ')} ms)`);
            assert(getLocalConfig().totpEnabled === true, '…2FA still on');
        }
        {
            // 6c. The same, deterministically: other sources hold all but one check, the owner polls, then signs in
            // again. Before the fix the first poll took the last check, and everything after it was refused.
            resetAdminAuthTarpit();
            const home = await signIn(HOME);
            await call('/api/local/admin/2fa/disable', home.session, { code: wrongCode() });
            await fillAllowance(NODE_CHECKS_PER_MIN - 1);
            const polls: number[] = [];
            for (let i = 0; i < 5; i++) polls.push((await status(home.session)).status);
            const back = await signIn(HOME);
            assert(polls.every(st => st === 200) && back.status === 200,
                `with the allowance one short of full, the owner's polls pass (${polls.join(',')}) and signing in again works (got ${back.status})`);
        }
        {
            // 6d. A check is handed back only for a right password with a valid session; a code check still costs one.
            resetAdminAuthTarpit();
            const home = await signIn(HOME);
            await call('/api/local/admin/2fa/disable', home.session, { code: wrongCode() });
            await fillAllowance(NODE_CHECKS_PER_MIN - 1);
            const polls = [(await status(home.session)).status, (await status(home.session)).status, (await status(home.session)).status];
            assert(polls.every(st => st === 200), `with the allowance one short of full, the owner's polls still pass (${polls.join(',')})`);
            const guess = await call('/api/local/admin/2fa/disable', home.session, { code: wrongCode() });
            assert(guess.status === 401, `a wrong current code is checked, and takes the last check (got ${guess.status})`);
            const after = await status(home.session);
            assert(after.status === 429 && /from elsewhere/.test(after.body.error || ''),
                `…so the allowance is full: that code check was not handed back (next poll → ${after.status})`);

            // 6e. Another address's clean owner is unaffected, while the allowance is full.
            const other = await signIn(ELSEWHERE);
            assert(other.status === 200, `an owner on a clean address signs in while the allowance is full (got ${other.status})`);
            const otherPolls: number[] = [];
            for (let i = 0; i < 5; i++) otherPolls.push((await status(other.session)).status);
            assert(otherPolls.every(st => st === 200), `…and polls without a refusal (${otherPolls.join(',')})`);
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
