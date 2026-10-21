/**
 * Test Suite: the boot's count of enterprises whose joining figure is above their pledges (state-engine.ts
 * backingFigureDrift, reportBackingFigureDriftAtBoot) moves no Beans (#2313's deciding pass). It used to read each
 * drifted enterprise through getBalance, which charges demurrage as it reads, right after the ledger was loaded: before
 * the treasuries were registered exempt and before the Commons pot was restored. A drifted treasury holding 1,000, last
 * read 60 days ago, lost 20.86 Beans at a restart, with a `Circulation fee` row, the pot still 0 and the boot's
 * conservation warning.
 *
 * Two processes on one data dir (takeover-test-harness.ts), each booting as index.ts does:
 *  1. The first writes the rows as a node holds them 60 days on, then is killed:
 *     - Drift Co, a treasury holding 1,000, last read 60 days ago; its keeper joined with 500 and has released it since,
 *       so the joining figure (500) is above its pledges (0);
 *     - Even Co, the same in every way but that its keeper's 500 is still pledged: no drift;
 *     - Owe Co, owing 300 on a joining figure of 500 whose pledge was released: drifted and spend-frozen;
 *     - Pat, owing what the three hold between them, so the ledger sums to 0, and the Commons pot at 0.
 *  2. The second boots on it. Drift Co and Even Co still hold exactly 1,000, in memory and in their rows, after the
 *     demurrage flush; there is no `Circulation fee` row, the pot and the ledger's sum are unchanged, and the boot says no
 *     conservation warning. The count read Drift Co's account no more than Even Co's (the same last-read day in memory),
 *     and it still counts: 2 enterprises, 1 of them spend-frozen, as getBalance reads them once the boot is done. All of it
 *     on the confirmation dial's default (on, no row).
 *  3. A third boots with nothing changed: no line (the counts are said once per change, node_config backing_drift_said),
 *     and still no Bean moved. Even Co's keeper then releases its pledge.
 *  4. A fourth boots: the changed count is said, 3 enterprises, 1 of them spend-frozen.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-boot-drift-count-moves-nothing.ts
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Boot-Drift-Count-Pw-5512!';
const DAY_MS = 24 * 60 * 60 * 1000;

interface World { owner: string; kai: string; lee: string; ola: string; pat: string; driftCo: string; evenCo: string; oweCo: string }

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine. */
function guardFetch(): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
}

/** The stored rows the suite compares, read from the database only. */
async function storedRows(w: World) {
    const { db } = await import('./db/db.js');
    const row = (pk: string) => db.prepare('SELECT balance, last_demurrage_epoch AS lastRead FROM accounts WHERE public_key = ?').get(pk) as { balance: number; lastRead: number } | undefined;
    return {
        driftCo: row(w.driftCo), evenCo: row(w.evenCo), oweCo: row(w.oweCo), pat: row(w.pat),
        commonsRow: row('COMMONS_POOL')?.balance ?? null,
        sum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
        fees: (db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE memo LIKE 'Circulation fee%'").get() as { c: number }).c,
    };
}

async function child(): Promise<void> {
    guardFetch();
    await runNodeChild({
        setup: async (w: World) => {
            const { db } = await import('./db/db.js');
            const member = (pk: string, name: string, treasury = 0) => db.prepare(`
                INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'), ?, ?, 'active', ?)`).run(pk, name, w.owner, `INV-${name}`, treasury);
            const keeper = (enterprise: string, pk: string, figure: number, released: boolean) => {
                db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing)
                            VALUES (?, ?, 'keeper', ?, ?)`).run(enterprise, pk, w.owner, figure);
                db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                            VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-80 days'), ?)`)
                    .run(crypto.randomUUID(), pk, enterprise, figure, released ? new Date(Date.now() - 70 * DAY_MS).toISOString() : null);
                db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(pk);
            };
            // The day each account was last read: 60 days ago, as the ledger counts days (LedgerManager.getCurrentEpoch).
            const lastRead = Math.floor(Date.now() / DAY_MS) - 60;
            const account = (pk: string, balance: number) => db.prepare(`
                INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)
                ON CONFLICT(public_key) DO UPDATE SET balance = excluded.balance, last_demurrage_epoch = excluded.last_demurrage_epoch`).run(pk, balance, lastRead);
            db.transaction(() => {
                member(w.owner, 'Owen');
                member(w.kai, 'Kai');
                member(w.lee, 'Lee');
                member(w.ola, 'Ola');
                member(w.pat, 'Pat');
                member(w.driftCo, 'Drift Co', 1);
                member(w.evenCo, 'Even Co', 1);
                member(w.oweCo, 'Owe Co', 1);
                keeper(w.driftCo, w.kai, 500, true);
                keeper(w.evenCo, w.lee, 500, false);
                keeper(w.oweCo, w.ola, 500, true);
                account(w.driftCo, 1000);
                account(w.evenCo, 1000);
                account(w.oweCo, -300);
                account(w.pat, -1700);
            })();
            return storedRows(w);
        },
        stored: async (w: World) => storedRows(w),
        /** Lee releases Even Co's pledge: its joining figure is then above its pledges too, so the count changes. */
        'release-even': async (w: World) => {
            const { db } = await import('./db/db.js');
            db.prepare('UPDATE enterprise_pledges SET released_at = ? WHERE enterprise = ? AND released_at IS NULL').run(new Date().toISOString(), w.evenCo);
            return true;
        },
        /**
         * What the boot left: the in-memory accounts as the boot left them (read without getAccount, which would stamp
         * them), then the stored rows after the demurrage flush the 5-minute timer makes, the audit, and last the count and
         * getBalance (safe once the boot is done: the treasuries are exempt by then).
         */
        look: async (w: World) => {
            const { ledger } = await import('./engine/ledger.js');
            const se = await import('./state-engine.js');
            const { persistDecayAndCommons } = await import('./engine/audit.js');
            const inMemory = (pk: string) => {
                const a = ledger.getAllAccounts().find((x) => x.id === pk);
                return a ? { balance: a.balance, lastRead: a.lastDemurrageEpoch } : null;
            };
            const memory = { driftCo: inMemory(w.driftCo), evenCo: inMemory(w.evenCo), commons: se.getCommonsBalanceExact() };
            persistDecayAndCommons();
            const rows = await storedRows(w);
            const audit = se.runLedgerAudit();
            const drift = se.backingFigureDrift();
            const read = (pk: string) => { const b = se.getBalance(pk); return { balance: b.balance, frozen: b.frozen }; };
            // The confirmation dial as this node reads it: on by default, with no row (config/known-floor.ts).
            const { db } = await import('./db/db.js');
            const { confirmationDialOn, CONFIRMATION_DIAL_KEY } = await import('@beanpool/engine');
            const dial = { on: confirmationDialOn(db), row: (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string } | undefined)?.value ?? null };
            return { memory, rows, audit, drift, dial, balances: { driftCo: read(w.driftCo), evenCo: read(w.evenCo), oweCo: read(w.oweCo) } };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const j = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const newKey = () => crypto.randomBytes(32).toString('hex');

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dataDir = path.join(root, 'node');
    const env = { ADMIN_PASSWORD: PW, NODE_ROLE: 'primary', NODE_ENV: 'test' };
    const w: World = {
        owner: newKey(), kai: newKey(), lee: newKey(), ola: newKey(), pat: newKey(),
        driftCo: newKey(), evenCo: newKey(), oweCo: newKey(),
    };
    const nodes: NodeProc[] = [];

    try {
        // ── 1. the rows, 60 days on ──
        console.log('\n— 1. the first process writes the rows as a node holds them 60 days on —');
        const first = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(first);
        const before = await first.send('setup', w as unknown as Record<string, unknown>);
        require_(before.driftCo?.balance === 1000 && before.evenCo?.balance === 1000 && before.oweCo?.balance === -300
            && before.commonsRow === 0 && Math.abs(before.sum) < 1e-9 && before.fees === 0,
            `Drift Co and Even Co hold 1,000 each, Owe Co owes 300, the pot is 0, the ledger sums to 0, no fee row (${j(before)})`);
        require_(before.driftCo.lastRead === before.evenCo.lastRead && before.driftCo.lastRead === Math.floor(Date.now() / DAY_MS) - 60,
            `both treasuries were last read 60 days ago (${before.driftCo.lastRead})`);
        await first.kill();
        nodes.pop();

        // ── 2. a restart on the same data dir ──
        console.log('\n— 2. the second process boots on the same data dir —');
        const second = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(second);
        const out = second.output();
        assert(!/LEDGER CONSERVATION WARNING/.test(out) && !/\[LedgerAudit\] FAILED/.test(out),
            `the boot says no conservation warning (${(/sum\(balances\) = [^\n]*/.exec(out) ?? /\[LedgerAudit\][^\n]*/.exec(out))?.[0] ?? 'no audit line'})`);
        const bootLine = /spend floors read their keepers' pledges only: (\d+) enterprise\(s\) had a joining figure above what is pledged now, (\d+) of them/.exec(out);
        assert(bootLine?.[1] === '2' && bootLine?.[2] === '1',
            `the boot still counts: 2 enterprises (Drift Co, Owe Co), 1 of them spend-frozen (${bootLine?.[0] ?? 'no line'})`);

        const after = await second.send('look', w as unknown as Record<string, unknown>);
        assert(after.memory.driftCo?.balance === 1000 && after.memory.evenCo?.balance === 1000,
            `in memory after the boot, Drift Co and Even Co still hold exactly 1,000 (${j(after.memory)})`);
        assert(after.memory.driftCo?.lastRead === after.memory.evenCo?.lastRead,
            `the boot read Drift Co's account no more than its undrifted twin's: the same last-read day in memory (${after.memory.driftCo?.lastRead} vs ${after.memory.evenCo?.lastRead})`);
        assert(after.rows.driftCo?.balance === 1000 && after.rows.evenCo?.balance === 1000 && after.rows.oweCo?.balance === -300 && after.rows.pat?.balance === -1700,
            `after the demurrage flush, the rows still hold 1,000, 1,000, -300 and -1,700 (${j(after.rows)})`);
        assert(after.rows.fees === 0, `no Circulation fee row was written (${after.rows.fees})`);
        assert(after.rows.commonsRow === before.commonsRow && after.memory.commons === before.commonsRow,
            `the Commons pot is unchanged: row ${after.rows.commonsRow}, in memory ${after.memory.commons}`);
        assert(Math.abs(after.rows.sum - before.sum) < 1e-9 && after.audit.ok === true && Math.abs(after.audit.drift) < 1e-9,
            `the ledger's sum is unchanged and the audit passes (${after.rows.sum}; ${j(after.audit)})`);
        assert(after.drift.enterprises === 2 && after.drift.frozen === 1
            && after.balances.oweCo.frozen === true && after.balances.driftCo.frozen === false && after.balances.evenCo.frozen === false,
            `the count from stored rows agrees with getBalance once the boot is done: Owe Co spend-frozen, the others not (${j(after.drift)}; ${j(after.balances)})`);
        assert(after.balances.driftCo.balance === 1000 && after.balances.evenCo.balance === 1000,
            `and read through getBalance, both still hold 1,000 (${j(after.balances)})`);
        assert(after.dial.on === true && after.dial.row === null,
            `all of it on the confirmation dial's default, on with no row (${j(after.dial)})`);
        await second.kill();
        nodes.pop();

        // ── 3. a restart with nothing changed says nothing ──
        console.log('\n— 3. a third boot, nothing changed —');
        const third = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(third);
        assert(!/spend floors read their keepers' pledges only/.test(third.output()),
            'the boot says the counts once per change: the same 2 and 1 again, no line');
        const unchanged = await third.send('stored', w as unknown as Record<string, unknown>);
        assert(unchanged.driftCo?.balance === 1000 && unchanged.evenCo?.balance === 1000 && unchanged.fees === 0,
            `and still no Bean moved (${j(unchanged)})`);
        await third.send('release-even', w as unknown as Record<string, unknown>);
        await third.kill();
        nodes.pop();

        // ── 4. a changed count is said again ──
        console.log('\n— 4. a fourth boot, after Even Co\'s pledge was released —');
        const fourth = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(fourth);
        const changed = /spend floors read their keepers' pledges only: (\d+) enterprise\(s\) had a joining figure above what is pledged now, (\d+) of them/.exec(fourth.output());
        assert(changed?.[1] === '3' && changed?.[2] === '1',
            `a changed count is said: 3 enterprises (Even Co too), 1 of them spend-frozen (${changed?.[0] ?? 'no line'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The boot count moves no Beans.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        process.exit(1);
    });
}
