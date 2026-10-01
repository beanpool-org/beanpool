/**
 * Test Suite: members' push tokens are locked at rest (scratch/global-node/DESIGN-push-relay-fable.md §4.2, the push
 * design's step 2; services/push-token-seal.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts). Every push is caught at fetch inside
 * each node and answered there: nothing reaches Expo or any other host. The tokens are made up here, new each run, so
 * finding one in a file's bytes means the file holds it.
 *
 *  1. The main server M: members register phones (the engine's registerPushToken, as the route calls it), one leaves a
 *     phone with a statement, and a send whose answer says one phone is gone. A push reaches every phone; the
 *     dead-token ticket removes that one registration and no other, with its tombstone. No file in M's data folder
 *     (state.db, its WAL), no snapshot, no plain backup and no copy M serves a standby holds a token in the clear.
 *  2. The standby S's whole copy: its push rows are M's, column for column, and none of its files holds a token; it has
 *     no key to open them with.
 *  3. A copy of S promoted by hand (its role changed, no take-over, so no key comes): it boots, removes every phone it
 *     can't open with one line in its log, and a phone that registers again there is reached.
 *  4. M dies; S takes over with the recovery code, which brings M's key in the bundle: the promoted server reaches every
 *     phone M did, and a dead-token ticket there removes only that phone.
 *  5. A server from before (tokens in the clear in push_tokens, a leave statement and a tombstone naming one): its first
 *     boot on this code is killed (SIGKILL on the node process) half way through locking them, and every row is still
 *     there, none half done. The next boot locks them all: every phone is reached, the leave statement still refuses the
 *     late registration it was made for, the tombstone names the phone by id, and no file holds a token in the clear.
 *  6. The rollback command (services/push-token-seal.ts --unlock-push-tokens), run with that server stopped, rebuilds both
 *     tables in the shape the code before reads, every token put back; the next boot on this code locks them again.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-tokens-at-rest.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, copyDir, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.EXPO_ACCESS_TOKEN;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'AtRest-Main-Pw-4410!';
const PW_STANDBY = 'AtRest-Standby-Pw-7302!';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A phone's token as Expo gives one, new each run: finding it in a file means the file holds it. */
const newToken = () => `ExponentPushToken[${crypto.randomBytes(16).toString('base64url')}]`;

// ── The node processes' commands ───────────────────────────────────────────────────────────

/**
 * Pushes to Expo are caught here and answered as Expo does; a token in `dead` is answered DeviceNotRegistered. `to`: each
 * push's token and its notice's kind.
 */
function guardFetch(): { blocked: string[]; to: { to: string; kind: unknown }[]; dead: Set<string> } {
    const seen = { blocked: [] as string[], to: [] as { to: string; kind: unknown }[], dead: new Set<string>() };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') {
            const batch = JSON.parse(String(init?.body ?? '[]')) as { to: string; data?: { k?: unknown } }[];
            const data = batch.map((m) => {
                seen.to.push({ to: m.to, kind: m.data?.k });
                return seen.dead.has(m.to)
                    ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: m.to } }
                    : { status: 'ok', id: crypto.randomUUID() };
            });
            return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string; members: { pk: string; callsign: string }[] }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const { db } = await import('./db/db.js');
            seedGenesisMember(a.genesis, 'Gwen');
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                            VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'seed')`).run(m.pk, m.callsign, a.genesis);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
            }
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** One pull of the kind the loop makes next, and the take-over envelope. */
        pull: async () => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const result = await pullNow();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, mode: getBackupStatus().lastPullMode ?? null, envelope };
        },
        /** A phone registered for `pk`, as the route registers it (state-engine.ts registerPushToken). */
        register: async (a: { pk: string; token: string; stamp?: number }) =>
            (await import('./state-engine.js')).registerPushToken(a.pk, a.token, 'android', a.stamp ?? null),
        /** A leave statement for `pk`'s `token`, already verified, as the route applies it. */
        leave: async (a: { pk: string; token: string; leftAt: number }) =>
            (await import('./state-engine.js')).applyPushLeave(a.pk, a.token, a.leftAt),
        /**
         * A push to every member, as the push service is handed it; `dead` are answered DeviceNotRegistered. The tokens it
         * was handed, sorted, once the answer has been read: its kind's only, so a notice the server sends on its own at
         * the same moment (a take-over's) is not counted.
         */
        'send-all': async (a: { dead?: string[] }) => {
            const { db } = await import('./db/db.js');
            const { dispatchPushNotification } = await import('./state-engine.js');
            const everyone = (db.prepare(`SELECT public_key FROM members WHERE public_key != 'SYSTEM' AND is_visitor = 0
                AND COALESCE(is_treasury, 0) = 0`).all() as { public_key: string }[]).map((r) => r.public_key);
            fetches.to.splice(0);
            fetches.dead = new Set(a.dead ?? []);
            const handed = dispatchPushNotification(everyone, 'SYSTEM', 'At rest', 'A push to every phone', {}, 'chat', 'chat.message');
            await sleep(300);
            fetches.dead = new Set();
            return { handed, to: fetches.to.splice(0).filter((p) => p.kind === 'chat.message').map((p) => p.to).sort() };
        },
        /** The push rows as they lie, every column, and whether a table from before is still set aside. */
        rows: async () => {
            const { db } = await import('./db/db.js');
            const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
            return {
                push: db.prepare('SELECT * FROM push_tokens ORDER BY 1, 2').all(),
                leaves: db.prepare('SELECT * FROM push_token_leaves ORDER BY 1, 2').all(),
                tombstones: db.prepare(`SELECT row_key FROM tombstones WHERE table_name = 'push_tokens' ORDER BY row_key`).pluck().all(),
                aside: has('push_tokens_plain') || has('push_token_leaves_plain'),
            };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** A snapshot now (services/snapshot-scheduler.ts), as the Backup tab takes one: its file. */
        snapshot: async () => {
            const { createSnapshot, SNAPSHOTS_DIR } = await import('./services/snapshot-scheduler.js');
            return path.join(SNAPSHOTS_DIR, createSnapshot().name);
        },
        /** A plain backup (no recovery code: a .tar.gz), written to `to`. */
        'plain-backup': async (a: { to: string }) => {
            const { createPlainBackup } = await import('./services/sealed-backup.js');
            const backup = await createPlainBackup();
            await new Promise<void>((resolve, reject) => {
                const out = fs.createWriteStream(a.to);
                backup.body.pipe(out);
                out.on('finish', () => resolve());
                out.on('error', reject);
            });
            backup.cleanup();
            return true;
        },
        /** A whole copy in pages, as M serves a standby (engine/copy-pages.ts), every page written to `to`. */
        'copy-pages': async (a: { nodeId: string; to: string }) => {
            const se = await import('./state-engine.js');
            const { openCopy, copyPage } = await import('./engine/copy-pages.js');
            const opened = await openCopy({ nodeId: a.nodeId, since: null, commonsBalance: se.getCommonsBalanceExact, sign: se.signSyncBody });
            if (opened.status !== 200) return { pages: 0, last: false };
            const pages = [opened.page];
            let head = JSON.parse(opened.page);
            while (!head.last && pages.length < 1000) {
                const next = await copyPage(head.copyId, head.n + 1);
                if (next.status !== 200) break;
                pages.push(next.page);
                head = JSON.parse(next.page);
            }
            fs.writeFileSync(a.to, pages.join('\n'));
            return { pages: pages.length, last: head.last === true };
        },
        fetches: async () => ({ blocked: fetches.blocked }),
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

/** Every file under `dir` whose bytes hold one of `needles`, as `<file>: <needle>`; and how many files were read. */
function filesHolding(dir: string, needles: string[]): { found: string[]; read: number } {
    const found: string[] = [];
    let read = 0;
    const bytes = needles.map((n) => Buffer.from(n, 'utf8'));
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                read++;
                const file = fs.readFileSync(full);
                bytes.forEach((b, i) => { if (file.includes(b)) found.push(`${path.relative(dir, full)}: ${needles[i].slice(0, 30)}…`); });
            }
        }
    };
    walk(dir);
    return { found, read };
}
const fileHolds = (file: string, needles: string[]) => {
    const bytes = fs.readFileSync(file);
    return needles.filter((n) => bytes.includes(Buffer.from(n, 'utf8')));
};
const shown = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 3).join(' | ')}`);
const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const rowsOf = (rows: any, pk: string) => (rows.push as Record<string, unknown>[]).filter((r) => r.public_key === pk).length;
const ID = /^[0-9a-f]{64}$/;

interface Member { pk: string; callsign: string }
const member = (callsign: string): Member => ({ pk: crypto.randomBytes(32).toString('hex'), callsign });

/**
 * A node's first start on `dataDir` as its own node process (process.execPath with this process's loader flags, never
 * the tsx CLI, whose child would outlive a kill of its PID), with `env`. Resolves once it writes `marker` (held there by
 * BEANPOOL_TEST_PUSH_LOCK_HOLD) or says it is ready, whichever comes first, or exits.
 */
function startHeld(dataDir: string, env: Record<string, string>, marker: string, timeoutMs: number):
    Promise<{ pid: number; held: boolean; ready: boolean; exitCode: number | null; kill: () => Promise<void> }> {
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child'], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TAKEOVER_RESEAL_DEBOUNCE_MS: '40', ...env, BEANPOOL_TEST_PUSH_LOCK_HOLD: marker },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : null))));
    let ready = false;
    let exitCode: number | null = null;
    let done = false;
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => { if (line.startsWith('@@ ') && line.includes('"ready":true')) ready = true; });
    proc.stderr!.on('data', () => {});
    void exited.then((c) => { exitCode = c; done = true; });
    const kill = async () => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        await exited;
    };
    return (async () => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && !fs.existsSync(marker) && !ready && !done) await sleep(50);
        return { pid: proc.pid!, held: fs.existsSync(marker), ready, exitCode, kill };
    })();
}

async function main(): Promise<void> {
    console.log('\nPush tokens locked at rest\n');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-at-rest-'));
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const held: { kill: () => Promise<void> }[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = member('Gwen');
    const [ann, bo, cy] = ['Ann', 'Bo', 'Cy'].map(member);
    const phone = { annPhone: newToken(), annTablet: newToken(), annOld: newToken(), bo: newToken(), boLeft: newToken(), cy: newToken(), gwen: newToken() };
    const every = Object.values(phone);
    const refused: string[] = [];

    try {
        // ── 1. M ──
        console.log('— 1. the main server: phones registered, one left, one gone; every file it writes —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk, members: [ann, bo, cy] });
        for (const [who, token, stamp] of [[ann, phone.annPhone, 1000], [ann, phone.annTablet, 1100], [ann, phone.annOld, 1200],
            [bo, phone.bo, 2000], [bo, phone.boLeft, 2100], [cy, phone.cy, 3000], [gwen, phone.gwen, 4000]] as [Member, string, number][]) {
            require_(await main.send('register', { pk: who.pk, token, stamp }) === 'registered', `M: ${who.callsign} registers a phone`);
        }
        require_(await main.send('leave', { pk: bo.pk, token: phone.boLeft, leftAt: 2200 }) === 1, 'M: Bo leaves one phone with a statement (its row goes)');
        const live = [phone.annPhone, phone.annTablet, phone.annOld, phone.bo, phone.cy, phone.gwen];
        const sent = await main.send('send-all', { dead: [phone.annOld] });
        assert(sent.handed === live.length && sameSet(sent.to, live),
            `a push to every member reaches each of their ${live.length} phones (${sent.handed} handed to the push service)`);
        const m1 = await main.send('rows');
        assert(rowsOf(m1, ann.pk) === 2 && rowsOf(m1, bo.pk) === 1 && rowsOf(m1, cy.pk) === 1 && rowsOf(m1, gwen.pk) === 1,
            `Expo's ticket for one of Ann's phones removes that registration and no other: Ann 2, Bo 1, Cy 1, Gwen 1 (${m1.push.length} rows)`);
        const again = await main.send('send-all', {});
        assert(sameSet(again.to, live.filter((t) => t !== phone.annOld)), 'and the next push reaches every phone but that one');
        assert(m1.push.every((r: any) => ID.test(String(r.token_id)) && typeof r.token_box === 'string' && !('token' in r)),
            `each row names its phone by an id and holds the token only in a box (columns ${Object.keys(m1.push[0] ?? {}).join(', ')})`);
        assert(m1.tombstones.length === 2 && m1.tombstones.every((k: string) => ID.test(k.split('|')[1] ?? '')),
            `the gone phone's and the left phone's tombstones name each by id (${m1.tombstones.map((k: string) => k.slice(65, 85)).join(', ')})`);
        assert(m1.leaves.length === 1 && ID.test(String(m1.leaves[0]?.token_id)), "Bo's leave statement names his phone by id");

        await main.send('checkpoint');
        const onM = filesHolding(dir('main'), every);
        assert(onM.read > 0 && onM.found.length === 0, `no file in M's data folder holds a token: state.db, its WAL, the keys (${onM.read} files; found ${shown(onM.found)})`);
        const snapshot = await main.send('snapshot');
        assert(fs.existsSync(snapshot) && fileHolds(snapshot, every).length === 0, `a snapshot holds none (${path.basename(snapshot)}; found ${shown(fileHolds(snapshot, every))})`);
        const tarball = path.join(root, 'backup.tar.gz');
        await main.send('plain-backup', { to: tarball });
        const unpacked = path.join(root, 'backup');
        fs.mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
        const inBackup = filesHolding(unpacked, every);
        assert(fs.existsSync(path.join(unpacked, 'state.db')) && inBackup.found.length === 0,
            `a plain backup holds none (${inBackup.read} files, state.db among them; found ${shown(inBackup.found)})`);
        assert(!fs.existsSync(path.join(unpacked, 'recovery-seal.key')), 'and not the key that opens them');
        const pagesFile = path.join(root, 'copy-pages.txt');
        const copy = await main.send('copy-pages', { nodeId: main.ready.peerId, to: pagesFile });
        assert(copy.last && fileHolds(pagesFile, every).length === 0 && fs.readFileSync(pagesFile, 'utf8').includes('token_box'),
            `a whole copy M serves a standby, in pages, carries the boxes and no token (${copy.pages} page(s))`);

        // ── 2. S ──
        console.log('\n— 2. the standby: its whole copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const firstPull = await standby.send('pull');
        require_(firstPull.ok === true, `S: its first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        const s1 = await standby.send('rows');
        assert(JSON.stringify(s1.push) === JSON.stringify(m1.push) && JSON.stringify(s1.leaves) === JSON.stringify(m1.leaves),
            `S's push rows and leave statements are M's, column for column: each phone's id and box (${s1.push.length} rows)`);
        await standby.send('checkpoint');
        const onS = filesHolding(dir('standby'), every);
        assert(onS.read > 0 && onS.found.length === 0, `no file in S's data folder holds a token (${onS.read} files; found ${shown(onS.found)})`);
        assert(!fs.existsSync(path.join(dir('standby'), 'recovery-seal.key')), 'and S holds no key to open them');
        const sSent = await standby.send('send-all', {});
        assert(sSent.handed === 0 && sSent.to.length === 0, 'S sends no push itself');
        refused.push(...(await standby.send('fetches')).blocked);

        // ── 3. A copy of S promoted by hand: no key comes ──
        console.log('\n— 3. a copy of the standby promoted by hand: the phones it cannot open —');
        await standby.kill('SIGTERM');
        copyDir(dir('standby'), dir('by-hand'));
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const byHand = await spawnNode(SCRIPT, dir('by-hand'), env(PW_STANDBY, 'primary'));
        nodes.push(byHand);
        assert(byHand.ready.role === 'primary', 'it boots as a main server: nothing waits on the phones');
        const h = await byHand.send('rows');
        assert(h.push.length === 0 && s1.push.every((r: any) => h.tombstones.includes(`${r.public_key}|${r.token_id}`)),
            `every phone it holds, locked with a key it doesn't have, is removed, each with a tombstone (${h.push.length} left, ${h.tombstones.length} tombstones)`);
        assert(/Push tokens: removed 5 phone registrations locked with a key this server doesn't have/.test(byHand.output()),
            'and its log says so, in one line');
        assert(await byHand.send('register', { pk: ann.pk, token: phone.annPhone, stamp: 1300 }) === 'registered', 'Ann\'s phone registers again there');
        const hSent = await byHand.send('send-all', {});
        assert(hSent.handed === 1 && sameSet(hSent.to, [phone.annPhone]), `and is reached (${hSent.handed})`);
        refused.push(...(await byHand.send('fetches')).blocked);
        await byHand.kill('SIGTERM');

        // ── 4. The take-over: M's key comes in the bundle ──
        console.log('\n— 4. M dies; S takes over with the recovery code and its key —');
        const last = await standby.send('pull');
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error})`);
        refused.push(...(await main.send('fetches')).blocked);
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary', `promoted (${standby.ready.role})`);
        const p1 = await standby.send('rows');
        assert(JSON.stringify(p1.push) === JSON.stringify(m1.push), `the promoted server keeps M's rows as they were: it opens them (${p1.push.length})`);
        const reached = live.filter((t) => t !== phone.annOld);
        const pSent = await standby.send('send-all', { dead: [phone.annTablet] });
        assert(pSent.handed === reached.length && sameSet(pSent.to, reached), `a push from it reaches every phone M did (${pSent.handed} of ${reached.length})`);
        const p2 = await standby.send('rows');
        assert(rowsOf(p2, ann.pk) === 1 && rowsOf(p2, bo.pk) === 1 && rowsOf(p2, cy.pk) === 1 && rowsOf(p2, gwen.pk) === 1,
            `and a dead-token ticket there removes only that phone (${p2.push.length} rows)`);
        assert(!/Push tokens: removed/.test(standby.output()), 'it removed no phone at its boot');
        await standby.send('checkpoint');
        const onP = filesHolding(dir('standby'), every);
        assert(onP.read > 0 && onP.found.length === 0, `and having sent to them, no file in its data folder holds a token (${onP.read} files; found ${shown(onP.found)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');

        // ── 5. A server from before: its first boot, killed half way through the lock ──
        console.log('\n— 5. a server from before, tokens in the clear: its first boot killed mid-lock, then booted again —');
        const old = await spawnNode(SCRIPT, dir('old'), env(PW_MAIN, 'primary'));
        nodes.push(old);
        const crowd = Array.from({ length: 8 }, (_v, i) => member(`Crowd${i}`));
        await old.send('setup-primary', { replicationToken, genesis: gwen.pk, members: crowd });
        await old.send('checkpoint');
        await old.kill('SIGTERM');
        const planted: { pk: string; token: string }[] = crowd.flatMap((m) => [0, 1, 2, 3, 4].map(() => ({ pk: m.pk, token: newToken() })));
        const leftToken = newToken(), goneToken = newToken();
        const plantedNeedles = [...planted.map((p) => p.token), leftToken, goneToken];
        {
            // As the code before stored them: each token in the clear, and in the key.
            const d = new Database(path.join(dir('old'), 'state.db'));
            d.pragma('foreign_keys = OFF');
            d.exec(`DROP TABLE IF EXISTS push_tokens; DROP TABLE IF EXISTS push_token_leaves;
                CREATE TABLE push_tokens (public_key TEXT NOT NULL REFERENCES members(public_key), token TEXT NOT NULL,
                    platform TEXT DEFAULT 'ios', created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), registered_at INTEGER,
                    PRIMARY KEY (public_key, token));
                CREATE TABLE push_token_leaves (public_key TEXT NOT NULL, token TEXT NOT NULL, left_at INTEGER NOT NULL,
                    applied_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), PRIMARY KEY (public_key, token));`);
            const put = d.prepare(`INSERT INTO push_tokens (public_key, token, platform, registered_at) VALUES (?, ?, 'android', 100)`);
            for (const p of planted) put.run(p.pk, p.token);
            d.prepare('INSERT INTO push_token_leaves (public_key, token, left_at) VALUES (?, ?, 5000)').run(crowd[0].pk, leftToken);
            d.prepare(`INSERT INTO tombstones (table_name, row_key) VALUES ('push_tokens', ?)`).run(`${crowd[1].pk}|${goneToken}`);
            d.pragma('wal_checkpoint(TRUNCATE)');
            d.close();
        }
        const marker = path.join(root, 'held-mid-lock');
        const first = await startHeld(dir('old'), env(PW_MAIN, 'primary'), marker, 60_000);
        held.push(first);
        assert(first.held && !first.ready, `its first boot stops half way through locking the phones (${first.held ? 'held' : first.ready ? 'it booted to ready instead' : `exited ${first.exitCode}`})`);
        await first.kill();
        const afterKill = (() => {
            // Read-write: opening it plays the WAL back as the next boot would, the killed transaction's frames left out.
            const d = new Database(path.join(dir('old'), 'state.db'));
            try {
                const has = (t: string) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
                const tokensIn = (t: string) => (has(t) && (d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, 'token'))
                    ? d.prepare(`SELECT token FROM ${t}`).pluck().all() as string[] : []);
                return {
                    inTheClear: [...tokensIn('push_tokens'), ...tokensIn('push_tokens_plain')],
                    locked: (d.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('push_tokens', 'token_id'))
                        ? (d.prepare('SELECT COUNT(*) AS n FROM push_tokens').get() as { n: number }).n : 0,
                };
            } finally { d.close(); }
        })();
        assert(first.held && sameSet(afterKill.inTheClear, planted.map((p) => p.token)) && afterKill.locked === 0,
            `killed there (SIGKILL on the node process, ${first.pid}), it changed nothing it can't do again: every phone is still there as it was, none half locked (${afterKill.inTheClear.length} of ${planted.length}, ${afterKill.locked} locked)`);
        const again5 = await spawnNode(SCRIPT, dir('old'), env(PW_MAIN, 'primary'));
        nodes.push(again5);
        assert(new RegExp(`Push tokens: locked the ${planted.length} phone registrations and named 1 leave statement\\(s\\) and 1 deletion record\\(s\\) by id`).test(again5.output()),
            'its next boot locks them all, and says so');
        const o = await again5.send('rows');
        assert(o.push.length === planted.length && !o.aside && o.push.every((r: any) => ID.test(String(r.token_id)) && !('token' in r)),
            `every phone is a locked row, and nothing is left aside in the clear (${o.push.length} rows)`);
        const oSent = await again5.send('send-all', {});
        assert(oSent.handed === planted.length && sameSet(oSent.to, planted.map((p) => p.token)),
            `a push reaches every one of the ${planted.length} phones it held (${oSent.handed})`);
        assert(await again5.send('register', { pk: crowd[0].pk, token: leftToken, stamp: 4000 }) === 'left',
            'the leave statement it held still refuses the registration the phone sent before it');
        assert(o.tombstones.length === 1 && String(o.tombstones[0]).startsWith(`${crowd[1].pk}|`) && ID.test(String(o.tombstones[0]).slice(crowd[1].pk.length + 1)),
            `and the tombstone names its phone by id (${String(o.tombstones[0]).slice(0, 80)}…)`);
        await again5.send('checkpoint');
        const onOld = filesHolding(dir('old'), plantedNeedles);
        assert(onOld.read > 0 && onOld.found.length === 0, `no file in its data folder holds a token any more (${onOld.read} files; found ${shown(onOld.found)})`);
        refused.push(...(await again5.send('fetches')).blocked);
        await again5.kill('SIGTERM');

        // ── 6. A rollback past this change, and back ──
        console.log('\n— 6. the rollback command puts the tables back as the code before reads them; the next boot locks them again —');
        let unlocked = '';
        try {
            unlocked = execFileSync(process.execPath, [...process.execArgv, path.join(path.dirname(SCRIPT), 'services', 'push-token-seal.ts'), '--unlock-push-tokens'],
                { env: { ...process.env, BEANPOOL_DATA_DIR: dir('old') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e: any) {
            unlocked = `failed: ${String(e?.stderr ?? e?.message ?? e).slice(-300)}`;
        }
        const rolled = (() => {
            const d = new Database(path.join(dir('old'), 'state.db'));
            try {
                const columns = (t: string) => (d.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(t) as string[]).join(' ');
                return {
                    tokens: columns('push_tokens').split(' ').includes('token') ? d.prepare('SELECT token FROM push_tokens').pluck().all() as string[] : [],
                    shape: `${columns('push_tokens')} / ${columns('push_token_leaves')}`,
                };
            } finally { d.close(); }
        })();
        assert(/Put back 40 phone registrations in the clear/.test(unlocked) && sameSet(rolled.tokens, planted.map((p) => p.token))
            && rolled.shape === 'public_key token platform created_at registered_at updated_at / public_key token left_at applied_at updated_at',
            `with the server stopped, the command rebuilds both tables as the code before reads them, every phone's token put back (${rolled.tokens.length}; ${unlocked.trim().slice(0, 120)})`);
        const back = await spawnNode(SCRIPT, dir('old'), env(PW_MAIN, 'primary'));
        nodes.push(back);
        const backRows = await back.send('rows');
        const backSent = await back.send('send-all', {});
        assert(/Push tokens: locked the 40 phone registrations/.test(back.output()) && backRows.push.length === planted.length
            && sameSet(backSent.to, planted.map((p) => p.token)),
            `the next boot on this code locks them again, and a push reaches every phone (${backRows.push.length} rows, ${backSent.handed} reached)`);
        refused.push(...(await back.send('fetches')).blocked);

        assert(refused.length === 0, `no node reached anything off this machine (${refused.join(', ') || 'nothing'})`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
        for (const k of held) await k.kill().catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ push tokens at rest checks PASSED.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e);
        process.exit(1);
    });
}
