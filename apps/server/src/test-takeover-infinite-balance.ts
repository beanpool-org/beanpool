/**
 * A take-over whose ledger holds an infinite balance still finishes, and says the ledger doesn't add up (review of #1445,
 * BLOCKING 1, 2026-10-02).
 *
 * The take-over's audit record lives in local-config.json and is read back from the file. One balance of 9e999 (SQLite's
 * REAL Infinity) makes the sum and the drift Infinity, which JSON writes as null. The audit's words then called
 * `null.toFixed(4)`: every start logged "Boot check failed … reading 'toFixed'", the take-over stayed at `restarting`,
 * and the announcement, the reseal, the tunnel and done never ran. The record was already written, so mending the
 * balance didn't help either.
 *
 * Every node is its own process (takeover-test-harness.ts): the main server, a standby that copies it, the main server
 * killed, the recovery code typed on the standby over the real admin routes, the real restart. While the standby is down
 * for that restart, one of its own `accounts` rows is set to 9e999. Then:
 *   1. it starts as the main server with no boot-check failure, and the take-over completes, every step done;
 *   2. the progress route (what Settings reads) and the journal say the ledger does NOT add up, name the balance that
 *      isn't a number, and give the difference as "not a number", never "null" or "NaN";
 *   3. a second start is quiet and the take-over stays complete.
 *
 * Five runs: a member's row at 9e999, and the Commons pot's own row at 9e999, -9e999, the text 'NaN', and NULL (on a table
 * from before NOT NULL). For the pot's row it also checks that nothing wrote over the row (the boot's flush, audit and
 * sweep, the routes, the timer's flush), that the pot in memory is unknown (NaN) for text or NULL, never 0, and that a
 * settled deal's dust stays in its escrow rather than going into a pot that isn't a number (confirmation of #1445, NB-1).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-takeover-infinite-balance.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, runNodeChild, inspectNode, serveCommands, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-5531!';
const PW_STANDBY = 'Standby-Own-Pw-8820!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const anna = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(anna, 'Anna');
            const ben = crypto.randomBytes(32).toString('hex');
            db.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)')
                .run(ben, 'Ben', new Date().toISOString(), anna, 'TEST');
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(ben);
            // A real grant, so the copy has a ledger with Beans in it.
            const paid = !!se.payFromCommons(ben, 5, 'a commons grant', { allowDeficit: true });
            se.updateNodeConfig({ publicAddress: { name: 'primary', mode: 'direct', hostname: 'primary.beanpool.org', status: 'live' } } as any);
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId, anna, ben, paid, audit: se.runLedgerAudit() };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        inspect: (a: { ownerSeedHex?: string }) => inspectNode(a),
        // The Commons pot's row as stored, the pot in memory, and a dust escrow's row: what the boot, its flush and its
        // sweep left. Then the timer's flush is run as the timer runs it (it refuses an unknown pot and writes nothing),
        // and the row is read again.
        'pot-row': async (a: { dust: string }) => {
            const { db } = await import('./db/db.js');
            const core = await import('@beanpool/core');
            const se = await import('./state-engine.js');
            // As a string: the reply is JSON, where Infinity would come back as null.
            const read = () => {
                const r = db.prepare("SELECT balance, typeof(balance) AS t FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as { balance: unknown; t: string };
                return { balance: String(r.balance), t: r.t };
            };
            const afterBoot = read();
            const dust = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(a.dust) as { balance: number } | undefined;
            let flush = 'wrote';
            try { se.persistDecayAndCommons(); } catch (e: any) { flush = `refused: ${e?.message}`; }
            return { afterBoot, memory: String(core.COMMONS_BALANCE), dust: dust?.balance ?? null, flush, afterFlush: read() };
        },
        'ledger-audit': async () => {
            const se = await import('./state-engine.js');
            const r = se.runLedgerAudit();
            // As the route answers it: JSON, where Infinity is null.
            return JSON.parse(JSON.stringify(r));
        },
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
        throw new Error(`Assertion failed: ${msg}`);
    }
}

/**
 * Whose balance the restart breaks, and to what: a member's (the first review), the Commons pot's own at ±Infinity (the
 * re-review), or the pot's own row holding text or NULL (the confirmation's NB-1). A row of text or NULL was skipped at
 * boot, so the pot stayed 0 in memory and the boot's flush wrote 0 over the row: the audit then found no broken balance,
 * the take-over reported the old pot as drift, and a rebaseline answered 200.
 */
type Scenario = { label: string; account: 'ben' | 'COMMONS_POOL'; value: '9e999' | '-9e999' | "'NaN'" | 'NULL' };

/** How the row stores each value (typeof), and how the audit's list words it. */
const STORED: Record<Scenario['value'], { t: string; holds: string; drift: 'null' | 'finite' }> = {
    '9e999': { t: 'real', holds: 'Infinity', drift: 'null' },
    '-9e999': { t: 'real', holds: '-Infinity', drift: 'null' },
    "'NaN'": { t: 'text', holds: "text 'NaN'", drift: 'finite' },
    NULL: { t: 'null', holds: 'NULL', drift: 'finite' },
};

/**
 * A node whose `accounts.balance` predates NOT NULL (db.ts makeAccountBalanceNotNull): the only place a NULL can be
 * stored. Its boot finds the NULL row, refuses the rebuild, and keeps the old table, as a real old node would.
 */
function makeBalanceNullable(sdb: Database.Database): void {
    const sql = (sdb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get() as { sql: string }).sql;
    const nullable = sql.replace(/\bbalance\s+REAL\s+NOT\s+NULL\b/i, 'balance REAL').replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?accounts"?/i, 'CREATE TABLE accounts_nullable');
    if (nullable === sql || !/accounts_nullable/.test(nullable)) throw new Error(`can't make accounts.balance nullable from: ${sql}`);
    sdb.transaction(() => {
        sdb.exec(nullable);
        sdb.exec('INSERT INTO accounts_nullable SELECT * FROM accounts');
        sdb.exec('DROP TABLE accounts');
        sdb.exec('ALTER TABLE accounts_nullable RENAME TO accounts');
        sdb.exec('CREATE INDEX IF NOT EXISTS idx_accounts_last_updated_at ON accounts(last_updated_at)');
    })();
}

async function takeOver(root: string, sc: Scenario, nodes: NodeProc[]): Promise<void> {
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const stored = STORED[sc.value];
    const potRow = sc.account === 'COMMONS_POOL';
    const DUST = 'escrow_dust-of-a-settled-deal';
    {
        console.log(`\n═══ ${sc.label} ═══`);
        console.log('\n— 1. a main server and a standby that copies it —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', CF_RECORD_NAME: undefined });
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerSeedHex, replicationToken });
        assert(/^BPRC-1 /.test(setup.code) && setup.envelopeId && setup.paid && setup.audit?.ok === true,
            `the main server has a recovery code, a take-over envelope and a ledger that adds up (${JSON.stringify(setup.audit)})`);
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored', `the standby copied the database and holds the envelope (${JSON.stringify(pulled.resync)})`);

        console.log('\n— 2. the main server dies; the standby takes over with the code —');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));
        assert(opened.status === 200 && opened.body?.preview?.sessionId, `the code opens the keys (${opened.status})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200 && /^[0-9a-f]{64}$/.test(confirmed.body?.progressToken),
            `the take-over is confirmed (${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 160)})`);
        const progressToken = confirmed.body.progressToken;
        const exitCode = await standby.exited;
        assert(exitCode === 0, `the standby restarts itself (exit ${exitCode})`);

        // While it is down for that restart, one of its own balances becomes ±9e999 (SQLite stores REAL ±Infinity), the
        // text 'NaN', or NULL (on a table from before NOT NULL). The Commons pot's row is restored into memory at boot: as
        // ±Infinity, or as unknown (NaN) for a row holding no number. A pot run also gets a settled deal's escrow holding
        // dust, which the boot's sweep would move into the pot with a raw `balance + ?` on its row.
        const key = sc.account === 'ben' ? setup.ben : 'COMMONS_POOL';
        const sdb = new Database(path.join(dirs.standby, 'state.db'));
        if (sc.value === 'NULL') makeBalanceNullable(sdb);
        const changed = sdb.prepare(`UPDATE accounts SET balance = ${sc.value} WHERE public_key = ?`).run(key).changes;
        if (potRow) sdb.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0.0000005, 0)').run(DUST);
        const row = sdb.prepare('SELECT balance, typeof(balance) AS t FROM accounts WHERE public_key = ?').get(key) as { balance: unknown; t: string };
        sdb.pragma('wal_checkpoint(TRUNCATE)');
        sdb.close();
        assert(changed === 1 && row.t === stored.t && String(row.balance) === (sc.value === 'NULL' ? 'null' : stored.holds.replace(/^text '(.*)'$/, '$1')),
            `${sc.account}'s balance on the standby is now ${stored.holds} (${String(row.balance)}, ${row.t})`);

        console.log('\n— 3. it starts as the main server, and the take-over finishes —');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined });
        nodes.push(standby);
        assert(standby.ready.role === 'primary', `it is the main server (${standby.ready.role})`);
        const firstStart = standby.output();
        assert(!/Boot check failed/.test(firstStart) && !/toFixed/.test(firstStart),
            `no boot check failed (${(firstStart.match(/.*Boot check failed.*/) ?? ['none'])[0].slice(0, 200)})`);
        assert(standby.ready.auditRan === true, 'the audit ran at this start');

        const prog = await post(standby.base, '/api/local/admin/takeover/progress', {}, { 'X-Takeover-Progress': progressToken });
        const stepsDone = (prog.body?.steps ?? []).filter((s: any) => !s.done).map((s: any) => s.step);
        assert(prog.status === 200 && prog.body?.state === 'complete' && stepsDone.length === 0,
            `the take-over is complete, every step done: audit, announcement, reseal, tunnel, done (${prog.body?.state}; not done: ${JSON.stringify(stepsDone)})`);

        console.log('\n— 4. and it says the ledger does NOT add up, in plain words —');
        const audit = prog.body?.result?.audit;
        assert(audit && audit.ok === false && audit.addsUp === false && audit.badBalances === 1,
            `the progress Settings reads: not ok, doesn't add up, one balance that isn't a number (${JSON.stringify(audit && { ok: audit.ok, addsUp: audit.addsUp, badBalances: audit.badBalances, drift: audit.drift })})`);
        if (stored.drift === 'null') {
            assert(audit.drift === null, `the difference that isn't a number goes out as null, never a made-up number (${audit.drift})`);
        } else {
            // The pot's row holds no number, so SUM leaves it out: the difference is the members' side, a real number.
            assert(typeof audit.drift === 'number' && Number.isFinite(audit.drift), `the difference is a number (${audit.drift})`);
        }
        assert(audit.copy && audit.copy.match === false, `and the ledger is not the main server's as last copied (${JSON.stringify(audit.copy)})`);
        const auditStep = (prog.body?.steps ?? []).find((s: any) => s.step === 'audit');
        const words = String(auditStep?.detail);
        assert(new RegExp(`the ledger does NOT add up \\(drift ${stored.drift === 'null' ? 'not a number' : '-?[0-9.]+'}, 0 stranded escrow\\(s\\), 1 balance\\(s\\) that are not a finite number\\)`).test(words)
            && /check before members trade/.test(words) && !/null|NaN|Infinity/.test(words),
            `the audit step's words say so, with "not a number" for the difference (${words})`);

        const inspected = await standby.send('inspect', {});
        const record = inspected.lastPromotionAudit;
        assert(record && record.ok === false && record.badBalances === 1 && (stored.drift === 'null' ? record.drift === null : Number.isFinite(record.drift)) && inspected.promotionAuditPending === false,
            `the audit record in local-config.json: not ok, one bad balance, drift null, nothing pending (${JSON.stringify(record && { ok: record.ok, drift: record.drift, sum: record.sumBalances, bad: record.badBalances })})`);
        const journal = JSON.parse(fs.readFileSync(path.join(dirs.standby, 'takeover-journal.json'), 'utf-8'));
        assert(journal.state === 'complete' && journal.result?.audit?.addsUp === false && journal.result?.audit?.badBalances === 1
            && /does NOT add up/.test(String(journal.steps?.audit?.detail)),
            `the journal on disk says the same (${journal.state}, ${journal.steps?.audit?.detail})`);
        assert(journal.result?.announcement && journal.result?.reseal !== null && journal.steps?.tunnel && journal.steps?.done,
            'the announcement went out, the keys were locked again on this server, and the tunnel step ran');
        const live = await standby.send('ledger-audit');
        assert(live.ok === false && live.badBalances === 1, `the live ledger audit on the new main server agrees (${JSON.stringify(live)})`);
        // The operator's own audit, over the real HTTPS server and admin auth: 200 (it answered 500 for the pot), naming
        // the account and how to mend it; the rebaseline refuses with 409 and names it too.
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const httpsBase = `https://localhost:${await standby.send('serve')}`;
        const route = await post(httpsBase, '/api/local/admin/ledger-audit', {}, pw(PW_MAIN));
        const listed = (route.body?.brokenBalances ?? []) as { account: string; callsign: string | null; holds: string }[];
        assert(route.status === 200 && route.body?.ok === false && route.body?.badBalances === 1
            && listed.length === 1 && listed[0].account === key && listed[0].holds === stored.holds
            && listed[0].callsign === (sc.account === 'ben' ? 'Ben' : 'the Commons pot') && /^Stop the server/.test(String(route.body?.repair)),
            `the admin ledger audit answers 200 and names ${sc.account} (${route.status} ${JSON.stringify(route.body).slice(0, 400)})`);
        const rebase = await post(httpsBase, '/api/local/admin/ledger-rebaseline', { reason: 'checking the refusal names it' }, pw(PW_MAIN));
        assert(rebase.status === 409 && String(rebase.body?.error).includes(`${key} (${listed[0].callsign}) holds ${stored.holds}`),
            `the rebaseline is refused with 409 and names it (${rebase.status} ${String(rebase.body?.error).slice(0, 300)})`);

        if (potRow) {
            // The pot's own row: nothing wrote over it, not the boot's flush, its audit, its sweep, the routes above, nor
            // the timer's flush; the pot in memory is what the row says (unknown for text or NULL); the dust stayed put.
            const pot = await standby.send('pot-row', { dust: DUST });
            const unchanged = (r: { balance: unknown; t: string }) => r.t === row.t && String(r.balance) === String(row.balance);
            assert(unchanged(pot.afterBoot) && unchanged(pot.afterFlush),
                `the pot's row still holds ${stored.holds} after the boot, the audits and the flush (${JSON.stringify(pot.afterBoot)} → ${JSON.stringify(pot.afterFlush)})`);
            assert(pot.memory === (stored.t === 'real' ? String(row.balance) : 'NaN'),
                `the pot in memory is ${stored.t === 'real' ? 'what the row holds' : 'unknown (NaN), never 0'} (${pot.memory})`);
            assert(/^refused: Payments are paused on this community/.test(pot.flush), `the timer's flush refuses it and writes nothing (${pot.flush})`);
            assert(pot.dust === 0.0000005, `the settled deal's dust was not moved into a pot that isn't a number (${pot.dust})`);
            // The boot says so, for ±Infinity as for text or NULL, and never "Restored" or "IN DEFICIT" (#1465 review, NB-2).
            const stop = (firstStart.match(/🛑 The Commons pot's row.*/) ?? [''])[0];
            assert(stop.includes(`holds ${stored.holds}, not a number of Beans`) && /no Beans move at all until it is mended/.test(stop)
                && !/Restored Commons Pool balance/.test(firstStart),
                `the boot's 🛑 line names the row and says no Beans move until it is mended (${stop.slice(0, 200) || 'none'})`);
        }

        console.log('\n— 5. a second start is quiet, and the take-over stays complete —');
        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup', CF_RECORD_NAME: undefined });
        nodes.push(standby);
        const second = standby.output();
        const again = await post(standby.base, '/api/local/admin/takeover/progress', {}, pw(PW_MAIN));
        assert(!/Boot check failed/.test(second) && standby.ready.role === 'primary' && again.status === 200 && again.body?.state === 'complete',
            `the second start: no boot check failed, still the main server, still complete (${again.status} ${again.body?.state})`);

    }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const nodes: NodeProc[] = [];
    const scenarios: Scenario[] = [
        { label: "a member's balance at 9e999", account: 'ben', value: '9e999' },
        { label: "the Commons pot's own row at 9e999", account: 'COMMONS_POOL', value: '9e999' },
        { label: "the Commons pot's own row at -9e999", account: 'COMMONS_POOL', value: '-9e999' },
        { label: "the Commons pot's own row holding the text 'NaN'", account: 'COMMONS_POOL', value: "'NaN'" },
        { label: "the Commons pot's own row holding NULL (a table from before NOT NULL)", account: 'COMMONS_POOL', value: 'NULL' },
    ];
    try {
        for (const [i, sc] of scenarios.entries()) {
            await takeOver(path.join(root, `run${i}`), sc, nodes);
            for (const n of nodes.splice(0)) await n.kill('SIGKILL').catch(() => {});
        }
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    } catch (e: any) {
        console.error(`❌ ${e?.message || e}`);
        for (const n of nodes) console.error(`--- node output (tail) ---\n${n.output().slice(-2500)}`);
        process.exitCode = 1;
    } finally {
        for (const n of nodes) await n.kill('SIGKILL').catch(() => {});
    }
    process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--child')) {
    child().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
