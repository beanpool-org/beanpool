/**
 * Test Suite: the boot's count of enterprises whose opening line a known pledge cleared before only earned pledges could
 * clear one (state-engine.ts openingLinesClearedByKnownPledges, reportOpeningLinesClearedByKnownPledgesAtBoot; Marty,
 * 21 Oct). It counts, it restores no line, and it moves no Beans: it reads stored rows and no balance, and sits after the
 * Commons restore and the treasuries' exemptions, as #2313's count does (test-boot-drift-count-moves-nothing).
 *
 * Two processes on one data dir (takeover-test-harness.ts), each booting as index.ts does:
 *  1. The first writes the rows as origin/main left them, then is killed:
 *     - Lost Co, a treasury holding 1,000, last read 60 days ago, started with a 200 line (its earned_credit) and a keeper's
 *       known 200 joining pledge, which cleared the line (legacy_credit_floor NULL): counted;
 *     - Kept Co, the same but its line still stands at 200: not counted;
 *     - Earned Co, a 200 line cleared by a keeper's earned 250, with a known 100 beside it: not counted;
 *     - Old Co, no line on record and a known 250, its line gone: it may have held the grandfathered 200 (`maybe`);
 *     - Pat, owing what they hold between them, so the ledger sums to 0, and the Commons pot at 0.
 *  2. The second boots on it. Its boot line counts 1 enterprise, and 1 more that may have; no line is restored; Lost Co
 *     still holds exactly 1,000 in memory and in its row after the demurrage flush; there is no `Circulation fee` row, the
 *     pot and the ledger's sum are unchanged, and the boot says no conservation warning.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-boot-opening-line-count.ts
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Boot-Opening-Line-Pw-7731!';
const DAY_MS = 24 * 60 * 60 * 1000;

interface World { owner: string; ivy: string; joe: string; pat: string; lostCo: string; keptCo: string; earnedCo: string; oldCo: string }

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
    const line = (pk: string) => (db.prepare('SELECT legacy_credit_floor AS l FROM members WHERE public_key = ?').get(pk) as { l: number | null }).l;
    return {
        lostCo: row(w.lostCo), pat: row(w.pat),
        lines: { lostCo: line(w.lostCo), keptCo: line(w.keptCo), earnedCo: line(w.earnedCo), oldCo: line(w.oldCo) },
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
            const member = (pk: string, name: string, treasury = 0, line = 0, legacy: number | null = null) => db.prepare(`
                INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury, earned_credit, legacy_credit_floor)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'), ?, ?, 'active', ?, ?, ?)`).run(pk, name, w.owner, `INV-${name}`, treasury, line, legacy);
            const keeper = (enterprise: string, pk: string, figure: number) => {
                db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by, backing)
                            VALUES (?, ?, 'keeper', ?, ?)`).run(enterprise, pk, w.owner, figure);
                db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(pk);
            };
            const pledge = (enterprise: string, pk: string, amount: number, known: boolean) => db.prepare(`
                INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-80 days'), NULL)`)
                .run(`${known ? 'known:' : ''}${crypto.randomUUID()}`, pk, enterprise, amount);
            // The day each account was last read: 60 days ago, as the ledger counts days (LedgerManager.getCurrentEpoch).
            const lastRead = Math.floor(Date.now() / DAY_MS) - 60;
            const account = (pk: string, balance: number) => db.prepare(`
                INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)
                ON CONFLICT(public_key) DO UPDATE SET balance = excluded.balance, last_demurrage_epoch = excluded.last_demurrage_epoch`).run(pk, balance, lastRead);
            db.transaction(() => {
                member(w.owner, 'Owen');
                member(w.ivy, 'Ivy');
                member(w.joe, 'Joe');
                member(w.pat, 'Pat');
                member(w.lostCo, 'Lost Co', 1, 200, null);
                member(w.keptCo, 'Kept Co', 1, 200, 200);
                member(w.earnedCo, 'Earned Co', 1, 200, null);
                member(w.oldCo, 'Old Co', 1, 0, null);
                keeper(w.lostCo, w.ivy, 200);
                pledge(w.lostCo, w.ivy, 200, true);
                keeper(w.keptCo, w.ivy, 200);
                pledge(w.keptCo, w.ivy, 200, true);
                keeper(w.earnedCo, w.joe, 350);
                pledge(w.earnedCo, w.joe, 250, false);
                pledge(w.earnedCo, w.joe, 100, true);
                keeper(w.oldCo, w.joe, 250);
                pledge(w.oldCo, w.joe, 250, true);
                account(w.lostCo, 1000);
                account(w.pat, -1000);
            })();
            return storedRows(w);
        },
        /**
         * What the boot left: Lost Co's in-memory account as the boot left it (read without getAccount, which would stamp
         * it), then the stored rows after the demurrage flush the 5-minute timer makes, the audit, and last the count.
         */
        look: async (w: World) => {
            const { ledger } = await import('./engine/ledger.js');
            const se = await import('./state-engine.js');
            const { persistDecayAndCommons } = await import('./engine/audit.js');
            const a = ledger.getAllAccounts().find((x) => x.id === w.lostCo);
            const memory = { lostCo: a ? { balance: a.balance, lastRead: a.lastDemurrageEpoch } : null, commons: se.getCommonsBalanceExact() };
            persistDecayAndCommons();
            const rows = await storedRows(w);
            const audit = se.runLedgerAudit();
            return { memory, rows, audit, count: se.openingLinesClearedByKnownPledges() };
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
        owner: newKey(), ivy: newKey(), joe: newKey(), pat: newKey(),
        lostCo: newKey(), keptCo: newKey(), earnedCo: newKey(), oldCo: newKey(),
    };
    const nodes: NodeProc[] = [];

    try {
        // ── 1. the rows as origin/main left them ──
        console.log('\n— 1. the first process writes the rows as origin/main left them —');
        const first = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(first);
        const before = await first.send('setup', w as unknown as Record<string, unknown>);
        require_(before.lostCo?.balance === 1000 && before.pat?.balance === -1000 && before.commonsRow === 0 && Math.abs(before.sum) < 1e-9 && before.fees === 0,
            `Lost Co holds 1,000, Pat owes 1,000, the pot is 0, the ledger sums to 0, no fee row (${j(before)})`);
        require_(before.lines.lostCo === null && before.lines.keptCo === 200 && before.lines.earnedCo === null && before.lines.oldCo === null,
            `Lost Co's, Earned Co's and Old Co's lines are gone, Kept Co's stands at 200 (${j(before.lines)})`);
        await first.kill();
        nodes.pop();

        // ── 2. a restart on the same data dir ──
        console.log('\n— 2. the second process boots on the same data dir —');
        const second = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(second);
        const out = second.output();
        assert(!/LEDGER CONSERVATION WARNING/.test(out) && !/\[LedgerAudit\] FAILED/.test(out),
            `the boot says no conservation warning (${(/sum\(balances\) = [^\n]*/.exec(out) ?? /\[LedgerAudit\][^\n]*/.exec(out))?.[0] ?? 'no audit line'})`);
        const bootLine = /opening lines clear on earned pledges only now: (\d+) enterprise\(s\) lost their opening line to a known pledge before \((\d+) more may have/.exec(out);
        assert(bootLine?.[1] === '1' && bootLine?.[2] === '1',
            `the boot counts 1 enterprise (Lost Co) and 1 more that may have held the grandfathered 200 (Old Co) (${bootLine?.[0] ?? 'no line'})`);
        assert(!/Could not count enterprises whose opening line/.test(out), 'and the count did not fail');

        const after = await second.send('look', w as unknown as Record<string, unknown>);
        assert(after.rows.lines.lostCo === null && after.rows.lines.oldCo === null && after.rows.lines.keptCo === 200 && after.rows.lines.earnedCo === null,
            `no line is restored, and none is cleared: Lost Co's and Old Co's are still gone, Kept Co's still 200 (${j(after.rows.lines)})`);
        assert(after.memory.lostCo?.balance === 1000 && after.rows.lostCo?.balance === 1000 && after.rows.pat?.balance === -1000,
            `Lost Co still holds exactly 1,000, in memory and in its row after the demurrage flush (${j(after.memory)}; ${j(after.rows.lostCo)})`);
        assert(after.rows.fees === 0, `no Circulation fee row was written (${after.rows.fees})`);
        assert(after.rows.commonsRow === before.commonsRow && after.memory.commons === before.commonsRow,
            `the Commons pot is unchanged: row ${after.rows.commonsRow}, in memory ${after.memory.commons}`);
        assert(Math.abs(after.rows.sum - before.sum) < 1e-9 && after.audit.ok === true && Math.abs(after.audit.drift) < 1e-9,
            `the ledger's sum is unchanged and the audit passes (${after.rows.sum}; ${j(after.audit)})`);
        assert(after.count.enterprises === 1 && after.count.maybe === 1, `read again once the boot is done, the count agrees (${j(after.count)})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The opening-line count restores nothing and moves no Beans.');
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
