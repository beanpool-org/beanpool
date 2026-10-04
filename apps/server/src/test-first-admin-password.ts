/**
 * The first admin password never goes into the log, and a new install makes none.
 *
 * With no ADMIN_PASSWORD in .env, a first start used to make one up and print it in a box on stdout, which in Docker IS
 * the container log. Then it went in data/first-admin-password.txt (0600) and the log said only where it was. Since
 * node sign-in step 8 a new install makes no password at all (its first owner claims it with the claim code), so that
 * file is only on an older install that still has it: the cases from B on start from such an install's data folder
 * (olderInstall), as that version left it.
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin
 * password, TLS, the database, the real HTTPS server), and everything it prints on stdout and stderr is kept and
 * searched for the password. Sign-ins and the password change go over HTTP to the real routes.
 *
 *   A. First start of a new install, no ADMIN_PASSWORD: no file, no password hash, and no password-shaped word in the
 *      output signs in.
 *   B. An older install's start with the file still there: the same password, not a new one; the log reminds, without it.
 *      Changing the password deletes the file at once, and the log says so.
 *   C. A start after the change: no file, no reminder, neither password printed.
 *   D. ADMIN_PASSWORD from .env on a new install: no file, nothing printed, and it does not sign in (it is ignored).
 *   E. Wipe & Reset deletes the file; the next start is a new install: no password, no file, the old one does not sign in.
 *   F. A file that no longer holds the admin password (a restore or a take-over replaced it) is deleted at boot.
 *   G. A new install never writes the file: a folder in its place does not stop the start, and nothing is locked.
 *   H. A password change that never reached the disk is reported as a failure and keeps the file: it still holds the
 *      password that works. A first start whose config cannot be saved still starts (there is no password to save),
 *      leaves no file and prints nothing shaped like a password.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-first-admin-password.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateTotpCode } from './totp.js';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--child';
const FILE_NAME = 'first-admin-password.txt';

// ============================================================================
// CHILD: boot as index.ts boots, serve the real HTTPS app, stay up until stdin closes.
// ============================================================================

async function runChild(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const { ensureGenesis } = await import('./genesis.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');

    await ensureGenesis();
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    process.stdout.write('@@ ' + JSON.stringify({ ready: true, port }) + '\n');
    process.stdin.on('data', () => { /* nothing is sent; the parent only closes it */ });
    process.stdin.on('end', () => process.exit(0));
}

// ============================================================================
// PARENT
// ============================================================================

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Boot {
    proc: ChildProcess;
    base: string;
    /** Everything the process printed so far, stdout and stderr. */
    output: () => string;
    stop: () => Promise<void>;
}

/** Start a node on `dataDir`. Resolves once it serves, or with `exited` when it stopped first. */
function boot(dataDir: string, env: Record<string, string | undefined> = {}): Promise<Boot | { exited: number | null; output: string }> {
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: Record<string, string | undefined> = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ...env };
    // A first boot with no password in .env unless the case sets one; no Let's Encrypt, no DNS. Never the suites' seam
    // (BEANPOOL_SUITE_ENV_PASSWORD): this is what a real node does with ADMIN_PASSWORD.
    if (!('ADMIN_PASSWORD' in env)) delete childEnv.ADMIN_PASSWORD;
    delete childEnv.BEANPOOL_SUITE_ENV_PASSWORD;
    delete childEnv.CF_RECORD_NAME;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CF_ZONE_ID;
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, CHILD_FLAG], {
        env: childEnv as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout!.on('data', (d) => { out += d.toString(); });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : null))));
    return new Promise((resolve) => {
        const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
        exited.then((code) => { clearTimeout(timer); resolve({ exited: code, output: out }); });
        const poll = setInterval(() => {
            const line = out.split('\n').find((l) => l.startsWith('@@ '));
            if (!line) return;
            clearInterval(poll);
            clearTimeout(timer);
            const { port } = JSON.parse(line.slice(3));
            resolve({
                proc,
                base: `https://127.0.0.1:${port}`,
                output: () => out,
                stop: async () => {
                    proc.stdin!.end();
                    const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
                    await exited;
                    clearTimeout(t);
                },
            });
        }, 25);
        exited.then(() => clearInterval(poll));
    });
}

async function started(dataDir: string, env: Record<string, string | undefined> = {}): Promise<Boot> {
    const b = await boot(dataDir, env);
    if ('exited' in b) {
        console.error(b.output);
        throw new Error(`the node on ${dataDir} exited (${b.exited}) before it served`);
    }
    bootDirs.set(b, dataDir);
    const t = twoFactorOf.get(dataDir);
    if (t) t.lastStep = 0; // a new process has taken no code yet
    return b;
}

// Step 7c: with the node's 2FA off, the admin password sent with a request opens only the password sign-in (its session
// held to the 2FA setup card). So "it signs in" is that sign-in; and changing the password or resetting the node first
// turns the node's 2FA on, as an owner does in Settings, and sends a code with the password from then on.
const bootDirs = new WeakMap<Boot, string>();
/** By data dir (2FA is in the config, so it outlives a restart): the secret, and the last code step used on that node. */
const twoFactorOf = new Map<string, { secret: string; lastStep: number }>();

/** A code the node has not taken yet (it takes each 30-second step once, one step either side of now); null with 2FA off. */
async function nextCode(b: Boot): Promise<{ code: string; use: () => void } | null> {
    const t = twoFactorOf.get(bootDirs.get(b) ?? '');
    if (!t) return null;
    for (;;) {
        const now = Math.floor(Date.now() / 30_000);
        // The step before now too, unless it is about to fall out of the node's window (the next step starts within 3 s).
        const earliest = Date.now() % 30_000 < 27_000 ? now - 1 : now;
        const step = Math.max(t.lastStep + 1, earliest);
        if (step <= now + 1) return { code: generateTotpCode(t.secret, step - now), use: () => { t.lastStep = step; } };
        await new Promise((r) => setTimeout(r, 1000));
    }
}

async function send(base: string, route: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; res: Response }> {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let parsed: any = null;
    try { parsed = JSON.parse(await res.text()); } catch { /* */ }
    return { status: res.status, body: parsed, res };
}

/** The password sign-in to Settings, with a code once the node's 2FA is on. A wrong password uses no code. */
async function signsIn(b: Boot, password: string): Promise<boolean> {
    const c = await nextCode(b);
    const r = await send(b.base, '/api/local/admin/auth/password', { password }, c ? { 'X-Admin-TOTP': c.code } : {});
    if (r.status === 200) c?.use();
    return r.status === 200;
}

/** Turn the node's 2FA on from Settings: sign in with the password, set up an authenticator, confirm a code. */
async function turnOn2fa(b: Boot, password: string): Promise<void> {
    const dir = bootDirs.get(b) ?? '';
    if (twoFactorOf.has(dir)) return;
    const signIn = await send(b.base, '/api/local/admin/auth/password', { password });
    const cookie = (signIn.res.headers.getSetCookie().find((h) => h.startsWith('admin_session=')) ?? '').split(';')[0];
    const asSession = { Cookie: cookie, 'X-CSRF-Token': String(signIn.body?.csrfToken ?? '') };
    const setup = await send(b.base, '/api/local/admin/2fa/setup', {}, asSession);
    if (signIn.status !== 200 || setup.status !== 200 || !setup.body?.secret) {
        throw new Error(`could not set up 2FA (sign-in ${signIn.status}, setup ${setup.status} ${JSON.stringify(setup.body)})`);
    }
    const t = { secret: String(setup.body.secret), lastStep: 0 };
    twoFactorOf.set(dir, t);
    const c = (await nextCode(b))!;
    const verify = await send(b.base, '/api/local/admin/2fa/verify', { code: c.code }, asSession);
    if (verify.status !== 200) throw new Error(`could not turn 2FA on (verify ${verify.status} ${JSON.stringify(verify.body)})`);
    c.use();
}

/** An owner's request with the password and a code (the node's 2FA turned on first). */
async function postAsOwner(b: Boot, password: string, route: string, body: unknown): Promise<number> {
    await turnOn2fa(b, password);
    const c = (await nextCode(b))!;
    const r = await send(b.base, route, body, { 'X-Admin-TOTP': c.code });
    c.use();
    return r.status;
}

/** The password, or either half of it (a box or a wrapped line could split it), anywhere in the output. */
function printed(output: string, password: string): boolean {
    const half = Math.floor(password.length / 2);
    return [password, password.slice(0, half), password.slice(half)].some((p) => output.includes(p));
}

/**
 * Every word in the output shaped like a made-up password (20 of the generator's characters, one of each kind), so
 * the log is searched without knowing the password: none of them may sign in.
 */
function passwordShapedWords(output: string): string[] {
    return [...new Set(output.split(/\s+/).filter((w) => /^[A-Za-z0-9!@#$%^&*()]{20}$/.test(w) && strong(w)))];
}

const fileIn = (dir: string) => path.join(dir, FILE_NAME);
const readFile = (dir: string) => fs.readFileSync(fileIn(dir), 'utf-8').trim();
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;
const strong = (p: string) => p.length >= 20 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
const tmpLeft = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith(FILE_NAME) && n !== FILE_NAME);
/** An older install's data folder, as that version left it: its config locked with `password`, and the file holding it. */
function olderInstall(dir: string, password: string): void {
    fs.mkdirSync(dir, { recursive: true });
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dir, 'local-config.json'), JSON.stringify({
        isLocked: true, callsign: null, location: null, adminHash: crypto.scryptSync(password, salt, 64).toString('hex'), salt,
        joinedAt: Date.now() - 86_400_000, communityName: null, contactEmail: null, contactPhone: null, replicationTokenOnly: true,
    }, null, 2));
    fs.writeFileSync(fileIn(dir), password + '\n', { mode: 0o600 });
}

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'first-pw-'));
    const NEW_PW = 'Changed-Pw-4-Test!';
    const ENV_PW = 'FromEnv-Pw-7-Test!';
    const OLD_PW = 'Older-Install-Pw-3-Test!';

    // ── A. First start of a new install, no ADMIN_PASSWORD ──────────────────────────────────
    console.log('\nA. First start of a new install with no ADMIN_PASSWORD');
    const dirA0 = path.join(root, 'a0');
    let a = await started(dirA0);
    const bootA = a.output();
    assert(!fs.existsSync(fileIn(dirA0)), `A1. no ${FILE_NAME}: a new install makes no admin password`);
    const cfgA = JSON.parse(fs.readFileSync(path.join(dirA0, 'local-config.json'), 'utf-8'));
    assert(!cfgA.isLocked && !cfgA.adminHash, 'A2. its config holds no password hash and is not locked');
    assert(!bootA.includes(FILE_NAME), 'A3. the log does not mention the file');
    assert(tmpLeft(dirA0).length === 0, `A4. no temporary copy is left in the data folder (${tmpLeft(dirA0).join(', ') || 'none'})`);
    // Whatever the server printed, no word of it is a password that works.
    const shaped = passwordShapedWords(bootA).slice(0, 5);
    const working: string[] = [];
    for (const w of shaped) if (await signsIn(a, w)) working.push(w);
    assert(working.length === 0, `A5. no password-shaped word in the first boot's output signs in (${shaped.length} looked like one, ${working.length} worked)`);
    await a.stop();

    // The rest starts from an older install that still has its file.
    const dirA = path.join(root, 'a');
    olderInstall(dirA, OLD_PW);
    const fileA = fileIn(dirA);
    const firstPw = OLD_PW;

    // ── B. A later start with the file still there; then change the password ────────────────
    console.log('\nB. A later start before the password is changed, then the change');
    a = await started(dirA);
    const bootB = a.output();
    assert(fs.existsSync(fileA) && readFile(dirA) === firstPw, 'B1. the file is still there with the same password: a restart makes no new one');
    assert(fs.existsSync(fileA) && modeOf(fileA) === 0o600, 'B2. still 0600');
    assert(bootB.includes(fileA) && bootB.includes(`cat ${fileA}`), 'B3. the log reminds where it is and how to read it');
    assert(!printed(bootB, firstPw), 'B4. without printing it');
    assert(await signsIn(a, firstPw), 'B5. it still signs in');
    const beforeChange = a.output().length;
    const changed = await postAsOwner(a, firstPw, '/api/local/change-password', { currentPassword: firstPw, newPassword: NEW_PW });
    assert(changed === 200, `B6. changing the password in Settings works (${changed})`);
    assert(!fs.existsSync(fileA), 'B7. the file is gone the moment the password is changed, with no restart');
    // The log line is written before the answer goes back, so it is in the output already, give or take a pipe.
    await new Promise((r) => setTimeout(r, 200));
    const changeLog = a.output().slice(beforeChange);
    assert(changeLog.includes(fileA) && /deleted/i.test(changeLog), 'B8. the log says the file was deleted');
    assert(await signsIn(a, NEW_PW), 'B9. the new password signs in');
    assert(!(await signsIn(a, firstPw)), 'B10. the first one no longer does');
    assert(!printed(a.output(), firstPw) && !printed(a.output(), NEW_PW), 'B11. neither password was printed');
    await a.stop();

    // ── C. A start after the change ─────────────────────────────────────────────────────────
    console.log('\nC. A start after the password was changed');
    a = await started(dirA);
    const bootC = a.output();
    assert(!fs.existsSync(fileA), 'C1. the file is not made again');
    assert(!bootC.includes(FILE_NAME), 'C2. and the log does not mention it');
    assert(!printed(bootC, firstPw) && !printed(bootC, NEW_PW), 'C3. neither password is printed');
    assert(await signsIn(a, NEW_PW), 'C4. the changed password signs in');
    await a.stop();

    // ── D. ADMIN_PASSWORD from .env ─────────────────────────────────────────────────────────
    console.log('\nD. ADMIN_PASSWORD from .env');
    const dirD = path.join(root, 'd');
    const d = await started(dirD, { ADMIN_PASSWORD: ENV_PW });
    assert(!fs.existsSync(fileIn(dirD)), 'D1. no file is written');
    assert(!d.output().includes(FILE_NAME), 'D2. the log does not mention one');
    assert(!printed(d.output(), ENV_PW), 'D3. the password is not printed');
    assert(!(await signsIn(d, ENV_PW)), 'D4. it does not sign in: a new install ignores ADMIN_PASSWORD');
    await d.stop();

    // ── E. Wipe & Reset ─────────────────────────────────────────────────────────────────────
    console.log('\nE. Wipe & Reset, then the start after it');
    const dirE = path.join(root, 'e');
    olderInstall(dirE, OLD_PW);
    let e = await started(dirE);
    const pwBefore = fs.existsSync(fileIn(dirE)) ? readFile(dirE) : '';
    assert(!!pwBefore && await signsIn(e, pwBefore), 'E1. (setup) a first password in the file, and it signs in');
    const beforeReset = e.output().length;
    const reset = await postAsOwner(e, pwBefore, '/api/local/reset', { password: pwBefore });
    if (reset === 200) twoFactorOf.delete(dirE); // Wipe & Reset wipes the 2FA with the rest
    assert(reset === 200, `E2. Wipe & Reset works (${reset})`);
    assert(!fs.existsSync(fileIn(dirE)), 'E3. it deletes the file at once: the password in it is gone');
    await new Promise((r) => setTimeout(r, 200));
    assert(/deleted/i.test(e.output().slice(beforeReset)), 'E4. and the log says so');
    await e.stop();
    e = await started(dirE);
    assert(!fs.existsSync(fileIn(dirE)), 'E5. the next start is a new install: it makes no password and no file');
    const cfgE = JSON.parse(fs.readFileSync(path.join(dirE, 'local-config.json'), 'utf-8'));
    assert(!cfgE.isLocked && !cfgE.adminHash, 'E6. no password hash, not locked');
    assert(!printed(e.output(), pwBefore), 'E7. the old one is printed nowhere');
    assert(!(await signsIn(e, pwBefore)), 'E8. the old one does not sign in');
    await e.stop();

    // ── F. A file whose password is no longer the admin password ────────────────────────────
    console.log('\nF. A file left over from a password that was replaced (a restore, a take-over)');
    const STALE = 'Stale-Pw-9-Leftover!';
    const dirF = path.join(root, 'f');
    olderInstall(dirF, OLD_PW);
    fs.writeFileSync(fileIn(dirF), STALE + '\n', { mode: 0o600 });
    const f = await started(dirF, { ADMIN_PASSWORD: ENV_PW });
    assert(!fs.existsSync(fileIn(dirF)), 'F1. the boot deletes it: it would send the operator to a password that does not work');
    assert(f.output().includes(fileIn(dirF)) && /deleted/i.test(f.output()), 'F2. and the log says so');
    assert(!printed(f.output(), STALE), 'F3. without printing what was in it');
    assert(await signsIn(f, OLD_PW), 'F4. the admin password is untouched');
    await f.stop();

    // ── G. A new install never writes the file ──────────────────────────────────────────────
    console.log('\nG. A new install never writes the file');
    const dirG = path.join(root, 'g');
    fs.mkdirSync(fileIn(dirG), { recursive: true }); // a folder in its place: a write would fail, whatever the user
    const g = await boot(dirG);
    assert(!('exited' in g), `G1. the server starts (${'exited' in g ? g.exited : 'it served'})`);
    const gOut = 'exited' in g ? g.output : g.output();
    if (!('exited' in g)) await g.stop();
    const cfgG = JSON.parse(fs.existsSync(path.join(dirG, 'local-config.json')) ? fs.readFileSync(path.join(dirG, 'local-config.json'), 'utf-8') : '{}');
    assert(!cfgG.isLocked && !cfgG.adminHash, 'G2. nothing is locked, no password hash');
    assert(fs.statSync(fileIn(dirG)).isDirectory() && tmpLeft(dirG).length === 0, 'G3. the folder is left as it was, and no temporary copy is beside it');
    assert(passwordShapedWords(gOut).length === 0, 'G4. nothing shaped like a password is printed');

    // ── H. A change that never reached the disk ─────────────────────────────────────────────
    console.log('\nH. A password change whose save failed');
    if (process.getuid?.() === 0) {
        // Root writes through a read-only file, so the failure cannot be made here. CI runs as a normal user.
        console.log('  (not run: this runs as root, and a read-only file does not stop root writing)');
    } else {
        const dirH = path.join(root, 'h');
        olderInstall(dirH, OLD_PW);
        const h = await started(dirH);
        const pwH = fs.existsSync(fileIn(dirH)) ? readFile(dirH) : '';
        const cfgH = path.join(dirH, 'local-config.json');
        await turnOn2fa(h, pwH); // before the config is made read-only: turning 2FA on writes it
        fs.chmodSync(cfgH, 0o444); // saveLocalConfig's write fails, and it only logs that
        const failedChange = await postAsOwner(h, pwH, '/api/local/change-password', { currentPassword: pwH, newPassword: NEW_PW });
        fs.chmodSync(cfgH, 0o644);
        assert(failedChange >= 500, `H0. the change is reported as a failure, not a success (${failedChange})`);
        assert(!!pwH && fs.existsSync(fileIn(dirH)) && readFile(dirH) === pwH, 'H1. the file is kept: the password in it is still the one on disk');
        assert(await signsIn(h, pwH), 'H2. and it still signs in');
        assert(!(await signsIn(h, NEW_PW)), 'H3. (control) the new one was never saved');
        await h.stop();

        // A new install's first start whose config cannot be saved: it has no password to lose.
        const dirI = path.join(root, 'i');
        fs.mkdirSync(dirI, { recursive: true });
        fs.writeFileSync(path.join(dirI, 'local-config.json'), '{}', { mode: 0o444 });
        const i = await boot(dirI);
        const iOut = 'exited' in i ? i.output : i.output();
        if (!('exited' in i)) await i.stop();
        assert(!('exited' in i), `H4. a first start whose config cannot be saved still starts: there is no password to save (${'exited' in i ? i.exited : 'it served'})`);
        assert(!fs.existsSync(fileIn(dirI)), 'H5. and leaves no file');
        assert(iOut.includes('local-config.json') && passwordShapedWords(iOut).length === 0, 'H6. it says which file, and prints nothing shaped like a password');
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The first admin password stays out of the log.');
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error('❌ BeanPool Node failed to start:', e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
