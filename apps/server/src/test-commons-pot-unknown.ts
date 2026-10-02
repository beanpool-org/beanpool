/**
 * While the Commons pot is unknown, no Beans move, members are told so in plain words, and nothing the community decided
 * is lost: it is carried out once the pot's row is mended (#1465 deciding review, NON-BLOCKING 1 and 2, 2026-10-02).
 *
 * A COMMONS_POOL row holding text or NULL makes the pot unknown (NaN) at boot (#1465, NB-1 of #1445's confirmation).
 * Every move's conservingTransaction flushes the pot first and that flush refuses it, so no Beans move at all. The review
 * measured two things that went wrong from there, on a real main server:
 *   1. every Decision that came due went to execution_blocked, which the tick never retries, money or not; it stayed so
 *      after the row was mended, and a removal whose grace window ended left its member suspended for good;
 *   2. members read the internal sentence "The Commons pot in memory is not a finite number (NaN), so it was not
 *      written", or Koa's "Internal Server Error".
 *
 * One main-server process (takeover-test-harness.ts): members, a pot of 40, and four Decisions due or in force:
 *   G  a passed grant_hardship of 5 to Ben              (moves Beans: waits)
 *   F  a passed freeze_credit on Cara                   (no Beans: carried out)
 *   R  a remove_member of Dan whose grace window ended  (the prune moves Beans: waits, Dan stays suspended)
 *   S  a passed remove_member of Eve                    (its start only suspends: carried out, grace window begins)
 * The server stops, the pot's row becomes 'abc', it starts again. Then:
 *   - the boot says, in its 🛑 line, that no Beans move until the row is mended;
 *   - the tick carries out F and S, and leaves G (passed) and R (grace window) waiting with words that say why;
 *     a second tick changes nothing;
 *   - over the real HTTPS server: a buyer confirming a held deal, a member deleting their account, an admin's prune and
 *     an admin's accelerate are refused in plain words, never "not a finite number", and nothing moves;
 * The server stops, the row is set back to 40, it starts again, and the first tick carries out G and R, and the ledger
 * adds up.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-commons-pot-unknown.ts
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Pot-Unknown-Pw-6620!';
const POT = 40;
const PAUSED = 'Payments are paused on this community while its admins fix a problem with its accounts. Nothing has moved.';
const WAITING = /^Waiting: payments are paused on this community while its admins fix a problem with its accounts\./;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

type Keys = { anna: string; ben: string; cara: string; dan: string; eve: string; fay: string };

// ── The node process's commands ────────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        ...serveCommands,
        setup: async (k: Keys) => {
            const se = await import('./state-engine.js');
            const core = await import('@beanpool/core');
            const { db } = await import('./db/db.js');
            const { ledger } = await import('./engine/ledger.js');
            se.seedGenesisMember(k.anna, 'Anna');
            const epoch = ledger.getCurrentEpoch();
            for (const [pk, name] of [[k.ben, 'Ben'], [k.cara, 'Cara'], [k.dan, 'Dan'], [k.eve, 'Eve'], [k.fay, 'Fay']] as const) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, earned_credit, invited_by, invite_code)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', 500, ?, 'TEST')`).run(pk, name, AVATAR, k.anna);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(pk, epoch);
            }
            se.reconcileLedgerFromDb();
            se.transfer('genesis', k.ben, 30, 'seed Ben', 'direct', true);
            se.transfer('genesis', k.dan, 3, 'seed Dan', 'direct', true);
            // Ben buys from Cara twice: one deal completed, one held in escrow for the confirm below.
            for (const pk of [k.ben, k.cara]) se.createPost('offer', 'general', 'Odd jobs', 'Help around the place', 5, 'fixed', pk, undefined, undefined, undefined, true);
            const kale = se.createPost('offer', 'food', 'Kale', 'Kale', 6, 'fixed', k.cara)!;
            const done = se.acceptPost(kale.id, k.ben);
            se.completePostTransaction(done.id, k.ben);
            const chard = se.createPost('offer', 'food', 'Chard', 'Chard', 3, 'fixed', k.cara)!;
            const held = se.acceptPost(chard.id, k.ben);
            // A pot of 40, and the audit's baseline taken with it.
            core.setCommonsBalance(POT);   // over the trade's fee: the pot is 40 exactly
            se.persistCommonsBalance();
            db.prepare("DELETE FROM node_config WHERE key = 'ledger_audit_baseline'").run();
            const audit = se.runLedgerAudit();

            const opened = new Date(Date.now() - 8 * 86400_000).toISOString();
            const closed = new Date(Date.now() - 86400_000).toISOString();
            const add = (id: string, touches: string, effect: string, subject: string, params: string | null, status: string, graceEnds: string | null) =>
                db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                                opens_at, closes_at, grace_period_ends_at, created_at, updated_at)
                            VALUES (?, ?, ?, 'Set up by the test', ?, ?, ?, ?, '1m1v', ?, ?, ?, ?, ?, ?)`)
                    .run(id, k.anna, `${effect} (${id})`, touches, effect, subject, params, status, opened, closed, graceEnds, opened, opened);
            add('G', 'pool', 'grant_hardship', k.ben, JSON.stringify({ amount: 5 }), 'passed', null);
            add('F', 'member', 'freeze_credit', k.cara, null, 'passed', null);
            add('R', 'member', 'remove_member', k.dan, null, 'execution_pending_grace', closed);
            add('S', 'member', 'remove_member', k.eve, null, 'passed', null);
            // Dan as the start of his removal left him: suspended, credit frozen.
            db.prepare("UPDATE members SET status = 'disabled', credit_frozen = 1 WHERE public_key = ?").run(k.dan);
            return { audit, pot: se.getCommonsBalanceExact(), heldDeal: held.id };
        },
        tick: async () => {
            const { tickDecisions } = await import('./decisions-engine.js');
            return tickDecisions();
        },
        state: async (k: Keys) => {
            const se = await import('./state-engine.js');
            const core = await import('@beanpool/core');
            const { db } = await import('./db/db.js');
            const decisions = Object.fromEntries((db.prepare("SELECT id, status, execution_error, execution_reason FROM decisions WHERE id IN ('G','F','R','S')").all() as any[])
                .map((r) => [r.id, { status: r.status, error: r.execution_error, reason: r.execution_reason }]));
            const member = (pk: string) => db.prepare('SELECT status, credit_frozen AS frozen FROM members WHERE public_key = ?').get(pk) as { status: string; frozen: number };
            const balances = Object.fromEntries((Object.entries(k) as [string, string][]).map(([n, pk]) => [n,
                String((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: unknown } | undefined)?.balance ?? 'none')]));
            const row = db.prepare("SELECT balance, typeof(balance) AS t FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as { balance: unknown; t: string };
            const audit = se.runLedgerAudit();
            return {
                decisions, cara: member(k.cara), dan: member(k.dan), eve: member(k.eve), fay: member(k.fay), balances,
                potRow: { balance: String(row.balance), t: row.t }, memory: String(core.COMMONS_BALANCE),
                txCount: (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c,
                audit: JSON.parse(JSON.stringify(audit)),
            };
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

type Id = { pk: string; privateKey: crypto.KeyObject };
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

async function signed(base: string, urlPath: string, id: Id, body: unknown): Promise<{ status: number; body: any }> {
    const raw = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${base}${urlPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${urlPath}\n${ts}\n${nonce}\n${raw}`), id.privateKey).toString('base64'),
        },
        body: raw,
    });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const brief = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function setPotRow(dir: string, sql: string): void {
    const sdb = new Database(path.join(dir, 'state.db'));
    sdb.prepare(`UPDATE accounts SET balance = ${sql} WHERE public_key = 'COMMONS_POOL'`).run();
    sdb.pragma('wal_checkpoint(TRUNCATE)');
    sdb.close();
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const dir = path.join(root, 'main');
    const env = { ADMIN_PASSWORD: PW, NODE_ROLE: 'primary', CF_RECORD_NAME: undefined };
    const ids = { anna: keypair(), ben: keypair(), cara: keypair(), dan: keypair(), eve: keypair(), fay: keypair() };
    const k: Keys = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, id.pk])) as Keys;
    const nodes: NodeProc[] = [];
    try {
        console.log('\n— 1. a main server with a pot of 40 and four Decisions due —');
        let node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        const setup = await node.send('setup', k);
        assert(setup.audit?.ok === true && setup.pot === POT && typeof setup.heldDeal === 'string', `the ledger adds up with a pot of ${POT} (${JSON.stringify(setup)})`);
        const before = await node.send('state', k);

        console.log("\n— 2. it stops, the pot's row becomes 'abc', and it starts again —");
        await node.kill('SIGTERM');
        setPotRow(dir, "'abc'");
        node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        const boot = node.output();
        const stop = (boot.match(/🛑 The Commons pot's row.*/) ?? [''])[0];
        assert(/holds text 'abc', not a number of Beans/.test(stop) && /no Beans move at all until it is mended: no deal, refund, removal, account deletion or payment from the Commons/.test(stop),
            `the boot's 🛑 line says no Beans move until the row is mended (${stop.slice(0, 260) || 'no 🛑 line'})`);

        console.log('\n— 3. the tick: what moves no Beans is carried out; what moves Beans waits —');
        await node.send('tick', {});
        const paused = await node.send('state', k);
        const d = paused.decisions;
        assert(d.F.status === 'executed' && paused.cara.frozen === 1, `F, the credit freeze, is carried out whatever the pot is (${JSON.stringify(d.F)})`);
        assert(d.S.status === 'execution_pending_grace' && paused.eve.status === 'disabled',
            `S, a removal's start, suspends Eve and opens the grace window (${JSON.stringify(d.S)}, Eve ${paused.eve.status})`);
        assert(d.G.status === 'passed' && !d.G.error && WAITING.test(String(d.G.reason)),
            `G, the grant, waits as passed, with no error and words that say why (${JSON.stringify(d.G)})`);
        assert(d.R.status === 'execution_pending_grace' && !d.R.error && WAITING.test(String(d.R.reason)) && paused.dan.status === 'disabled',
            `R, the removal whose grace ended, waits in its grace window, Dan suspended, not pruned (${JSON.stringify(d.R)}, Dan ${paused.dan.status})`);
        assert(paused.balances.ben === before.balances.ben && paused.balances.dan === before.balances.dan && paused.txCount === before.txCount,
            `no Beans moved (Ben ${paused.balances.ben}, Dan ${paused.balances.dan}, ${paused.txCount} transactions)`);
        assert(paused.potRow.t === 'text' && paused.potRow.balance === 'abc' && paused.memory === 'NaN',
            `the pot's row still holds 'abc', and the pot in memory is unknown (${JSON.stringify(paused.potRow)}, ${paused.memory})`);
        assert(paused.audit.ok === false && paused.audit.badBalances === 1, `the audit counts the pot as a balance that isn't a number (${JSON.stringify(paused.audit)})`);
        await node.send('tick', {});
        const again = await node.send('state', k);
        assert(JSON.stringify(again.decisions) === JSON.stringify(paused.decisions) && again.balances.ben === paused.balances.ben,
            'a second tick changes nothing: G and R still wait');
        const waitLines = node.output().match(/\[Decisions\] [GR] \(\w+\) waits: the Commons pot is not a number/g) ?? [];
        assert(waitLines.length === 2, `the log says each one waits, once (${waitLines.length} lines)`);

        console.log('\n— 4. over the real HTTPS server, plain words and nothing moves —');
        const base = `https://localhost:${await node.send('serve')}`;
        const confirm = await signed(base, '/api/marketplace/transactions/complete', ids.ben, { transactionId: setup.heldDeal, confirmerPublicKey: k.ben });
        assert(confirm.status >= 400 && confirm.body?.error === PAUSED, `a buyer confirming a held deal: refused in plain words (${brief(confirm)})`);
        const purge = await signed(base, '/api/member/purge', ids.fay, {});
        assert(purge.status >= 400 && purge.body?.error === PAUSED, `a member deleting their account: refused in plain words (${brief(purge)})`);
        const prune = await post(base, `/api/local/admin/users/${k.ben}/prune`, {}, { 'X-Admin-Password': PW });
        assert(prune.status >= 400 && prune.body?.error === PAUSED, `an admin's prune: refused in plain words (${brief(prune)})`);
        const accel = await post(base, '/api/local/admin/decisions/R/accelerate', {}, { 'X-Admin-Password': PW });
        assert(accel.status === 503 && accel.body?.error === PAUSED, `an admin hurrying the removal: 503, in plain words (${brief(accel)})`);
        const answers = JSON.stringify([confirm, purge, prune, accel]);
        assert(!/finite number|NaN|Internal Server Error/.test(answers), 'no answer says "finite number", "NaN" or "Internal Server Error"');
        const after = await node.send('state', k);
        assert(JSON.stringify(after.balances) === JSON.stringify(before.balances) && after.txCount === before.txCount
            && after.fay.status === 'active' && after.decisions.R.status === 'execution_pending_grace',
            `nothing moved: every balance and the history as before, Fay still a member, R still waiting (${JSON.stringify(after.balances)})`);

        console.log('\n— 5. the row is mended, and the first tick carries out what waited —');
        await node.kill('SIGTERM');
        setPotRow(dir, String(POT));
        node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        assert(!/🛑 The Commons pot's row/.test(node.output()), 'the boot after the mend has no 🛑 line');
        await node.send('tick', {});
        const mended = await node.send('state', k);
        assert(mended.decisions.G.status === 'executed' && Number(mended.balances.ben) === Number(before.balances.ben) + 5,
            `G is carried out: Ben has 5 more (${JSON.stringify(mended.decisions.G)}, Ben ${mended.balances.ben})`);
        assert(mended.decisions.R.status === 'executed' && mended.dan.status === 'pruned',
            `R is carried out: Dan's removal completes (${JSON.stringify(mended.decisions.R)}, Dan ${mended.dan.status})`);
        assert(mended.decisions.F.status === 'executed' && mended.decisions.S.status === 'execution_pending_grace', 'F stays done, S stays in its grace window');
        const carried = node.output().match(/\[Decisions\] [GR] \(\w+\) carried out now that the Commons pot is a number again/g) ?? [];
        assert(carried.length === 2, `the log says each was carried out after waiting (${carried.length} lines)`);
        assert(mended.audit.ok === true && mended.audit.badBalances === 0 && Math.abs(mended.audit.drift) < 1e-9 && mended.memory === String(Number(mended.potRow.balance)),
            `the ledger adds up, and the pot in memory is its row (${JSON.stringify(mended.audit)}, pot ${mended.memory})`);

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    } catch (e: any) {
        console.error(`❌ ${e?.message || e}`);
        for (const n of nodes.slice(-1)) console.error(`--- node output (tail) ---\n${n.output().slice(-3000)}`);
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
