/**
 * The first admin password never goes into the log.
 *
 * With no ADMIN_PASSWORD in .env, the first start makes one up. It used to print it in a box on stdout, which in
 * Docker IS the container log: the password stayed in `docker logs` (and any log shipper, support bundle or
 * screenshot) for the life of the container, and the admin password counts as an owner. Now it goes in
 * data/first-admin-password.txt (0600) and the log says only where it is and how to read it.
 *
 * Each boot is its own process on its own data dir, booted in the order index.ts boots (genesis, the admin
 * password, TLS, the database, the real HTTPS server), and everything it prints on stdout and stderr is kept and
 * searched for the password. Sign-ins and the password change go over HTTP to the real routes.
 *
 *   A. First start, no ADMIN_PASSWORD: the file exists, 0600, holds a password that signs in; the password is in
 *      no line of the output; the output says where the file is.
 *   B. A later start with the file still there: the same password, not a new one; the log reminds, without it.
 *      Changing the password deletes the file at once, and the log says so.
 *   C. A start after the change: no file, no reminder, neither password printed.
 *   D. ADMIN_PASSWORD from .env: no file, nothing printed, it signs in.
 *   E. Wipe & Reset deletes the file; the next start makes a new password in a new file, printed nowhere.
 *   F. A file that no longer holds the admin password (a restore or a take-over replaced it) is deleted at boot.
 *   G. The file cannot be written: the server does not start, prints no password, locks nothing; the next start
 *      after the fix works.
 *   H. A password change that never reached the disk is reported as a failure and keeps the file: it still holds the
 *      password that works. A first start whose config cannot be saved does not start, and leaves no file.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-first-admin-password.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    // A first boot with no password in .env unless the case sets one; no Let's Encrypt, no DNS.
    if (!('ADMIN_PASSWORD' in env)) delete childEnv.ADMIN_PASSWORD;
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
    return b;
}

async function post(base: string, route: string, body: unknown): Promise<number> {
    const res = await fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try { await res.text(); } catch { /* */ }
    return res.status;
}

const signsIn = async (b: Boot, password: string) => (await post(b.base, '/api/local/admin/data', { password })) === 200;

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

async function main(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'first-pw-'));
    const NEW_PW = 'Changed-Pw-4-Test!';
    const ENV_PW = 'FromEnv-Pw-7-Test!';

    // ── A. First start, no ADMIN_PASSWORD ────────────────────────────────────────────────────
    console.log('\nA. First start with no ADMIN_PASSWORD');
    const dirA = path.join(root, 'a');
    let a = await started(dirA);
    const fileA = fileIn(dirA);
    assert(fs.existsSync(fileA), `A1. the password is in ${FILE_NAME} in the data folder`);
    const firstPw = fs.existsSync(fileA) ? readFile(dirA) : '';
    assert(fs.existsSync(fileA) && modeOf(fileA) === 0o600, `A2. the file is 0600 (${fs.existsSync(fileA) ? modeOf(fileA).toString(8) : 'missing'})`);
    assert(strong(firstPw), 'A3. it holds one strong, 20-character password');
    // The check this change is for. On a first boot the log used to carry the password in a box.
    const bootA = a.output();
    assert(!!firstPw && !printed(bootA, firstPw), 'A4. the password is in NO line the server printed, stdout or stderr');
    assert(bootA.includes(fileA) && bootA.includes(`cat ${fileA}`), 'A5. the log says where the file is and how to read it');
    assert(tmpLeft(dirA).length === 0, `A6. no temporary copy is left beside it (${tmpLeft(dirA).join(', ') || 'none'})`);
    assert(await signsIn(a, firstPw), 'A7. the password in the file signs in to Settings');
    assert(!(await signsIn(a, firstPw + 'x')), 'A8. (control) a wrong password does not');
    assert(!printed(a.output(), firstPw), 'A9. and the sign-ins did not print it either');
    // The same check without the file: whatever the server made up, no word it printed is a password that works.
    const shaped = passwordShapedWords(bootA).slice(0, 5);
    const working: string[] = [];
    for (const w of shaped) if (await signsIn(a, w)) working.push(w);
    assert(working.length === 0, `A10. no password-shaped word in the first boot's output signs in (${shaped.length} looked like one, ${working.length} worked)`);
    await a.stop();

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
    const changed = await post(a.base, '/api/local/change-password', { currentPassword: firstPw, newPassword: NEW_PW });
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
    assert(await signsIn(d, ENV_PW), 'D4. it signs in');
    await d.stop();

    // ── E. Wipe & Reset ─────────────────────────────────────────────────────────────────────
    console.log('\nE. Wipe & Reset, then the start that makes a new password');
    const dirE = path.join(root, 'e');
    let e = await started(dirE);
    const pwBefore = fs.existsSync(fileIn(dirE)) ? readFile(dirE) : '';
    assert(!!pwBefore && await signsIn(e, pwBefore), 'E1. (setup) a first password in the file, and it signs in');
    const beforeReset = e.output().length;
    const reset = await post(e.base, '/api/local/reset', { password: pwBefore });
    assert(reset === 200, `E2. Wipe & Reset works (${reset})`);
    assert(!fs.existsSync(fileIn(dirE)), 'E3. it deletes the file at once: the password in it is gone');
    await new Promise((r) => setTimeout(r, 200));
    assert(/deleted/i.test(e.output().slice(beforeReset)), 'E4. and the log says so');
    await e.stop();
    e = await started(dirE);
    const pwAfter = fs.existsSync(fileIn(dirE)) ? readFile(dirE) : '';
    assert(strong(pwAfter) && pwAfter !== pwBefore, 'E5. the next start makes a new password, in a new file');
    assert(fs.existsSync(fileIn(dirE)) && modeOf(fileIn(dirE)) === 0o600, 'E6. 0600');
    assert(!!pwAfter && !printed(e.output(), pwAfter) && !printed(e.output(), pwBefore), 'E7. printed nowhere, and neither is the old one');
    assert(await signsIn(e, pwAfter), 'E8. the new one signs in');
    assert(!(await signsIn(e, pwBefore)), 'E9. the old one does not');
    await e.stop();

    // ── F. A file whose password is no longer the admin password ────────────────────────────
    console.log('\nF. A file left over from a password that was replaced (a restore, a take-over)');
    const STALE = 'Stale-Pw-9-Leftover!';
    fs.writeFileSync(fileIn(dirD), STALE + '\n', { mode: 0o600 });
    const f = await started(dirD, { ADMIN_PASSWORD: ENV_PW });
    assert(!fs.existsSync(fileIn(dirD)), 'F1. the boot deletes it: it would send the operator to a password that does not work');
    assert(f.output().includes(fileIn(dirD)) && /deleted/i.test(f.output()), 'F2. and the log says so');
    assert(!printed(f.output(), STALE), 'F3. without printing what was in it');
    assert(await signsIn(f, ENV_PW), 'F4. the admin password is untouched');
    await f.stop();

    // ── G. The file cannot be written ───────────────────────────────────────────────────────
    console.log('\nG. The file cannot be written');
    const dirG = path.join(root, 'g');
    fs.mkdirSync(fileIn(dirG), { recursive: true }); // a folder in its place: the write fails, whatever the user
    const g = await boot(dirG);
    assert('exited' in g && g.exited !== 0, `G1. the server does not start (${'exited' in g ? g.exited : 'it served'})`);
    const gOut = 'exited' in g ? g.output : g.output();
    if (!('exited' in g)) await g.stop();
    assert(gOut.includes(fileIn(dirG)), 'G2. it says which file it could not write');
    const cfgG = JSON.parse(fs.existsSync(path.join(dirG, 'local-config.json')) ? fs.readFileSync(path.join(dirG, 'local-config.json'), 'utf-8') : '{}');
    assert(!cfgG.isLocked && !cfgG.adminHash, 'G3. nothing is locked, so the next start makes a password again');
    assert(tmpLeft(dirG).length === 0, 'G4. no temporary copy is left behind');
    fs.rmSync(fileIn(dirG), { recursive: true });
    const g2 = await started(dirG);
    const pwG = fs.existsSync(fileIn(dirG)) ? readFile(dirG) : '';
    assert(strong(pwG) && !printed(gOut + g2.output(), pwG), 'G5. once it can be written, the next start writes it, printed nowhere');
    assert(await signsIn(g2, pwG), 'G6. and it signs in');
    await g2.stop();

    // ── H. A change that never reached the disk ─────────────────────────────────────────────
    console.log('\nH. A password change whose save failed');
    if (process.getuid?.() === 0) {
        // Root writes through a read-only file, so the failure cannot be made here. CI runs as a normal user.
        console.log('  (not run: this runs as root, and a read-only file does not stop root writing)');
    } else {
        const dirH = path.join(root, 'h');
        const h = await started(dirH);
        const pwH = fs.existsSync(fileIn(dirH)) ? readFile(dirH) : '';
        const cfgH = path.join(dirH, 'local-config.json');
        fs.chmodSync(cfgH, 0o444); // saveLocalConfig's write fails, and it only logs that
        const failedChange = await post(h.base, '/api/local/change-password', { currentPassword: pwH, newPassword: NEW_PW });
        fs.chmodSync(cfgH, 0o644);
        assert(failedChange >= 500, `H0. the change is reported as a failure, not a success (${failedChange})`);
        assert(!!pwH && fs.existsSync(fileIn(dirH)) && readFile(dirH) === pwH, 'H1. the file is kept: the password in it is still the one on disk');
        assert(await signsIn(h, pwH), 'H2. and it still signs in');
        assert(!(await signsIn(h, NEW_PW)), 'H3. (control) the new one was never saved');
        await h.stop();

        // The first start's own save fails: the file would name a password that was never stored.
        const dirI = path.join(root, 'i');
        fs.mkdirSync(dirI, { recursive: true });
        fs.writeFileSync(path.join(dirI, 'local-config.json'), '{}', { mode: 0o444 });
        const i = await boot(dirI);
        const iOut = 'exited' in i ? i.output : i.output();
        if (!('exited' in i)) await i.stop();
        assert('exited' in i && i.exited !== 0, `H4. a first start whose config cannot be saved does not start (${'exited' in i ? i.exited : 'it served'})`);
        assert(!fs.existsSync(fileIn(dirI)), 'H5. and leaves no file naming a password that was never saved');
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
