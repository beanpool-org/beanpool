/**
 * While the Commons pot is unknown, no Beans move, people are told so in plain words, nothing the community decided is
 * lost, and what moves no Beans still works (#1465 deciding review and re-review, 2026-10-02).
 *
 * A COMMONS_POOL row holding text or NULL makes the pot unknown (NaN) at boot (#1465, NB-1 of #1445's confirmation).
 * Every move's conservingTransaction flushes the pot first and that flush refuses it, so no Beans move at all. The reviews
 * measured, on a real main server, what went wrong from there:
 *   round 1: every due Decision went to execution_blocked for good, money or not, and members read the internal sentence
 *            "The Commons pot in memory is not a finite number (NaN)…" or "Internal Server Error";
 *   round 2: (1) a grant of any size could be proposed (the cap compared against NaN); (2) no Decision could be halted,
 *            and a removal whose grace window ended in the pause was carried out 30 s after the mend, with no brake;
 *            (3) a moderator couldn't take down a listing with no deal on it (single, bulk, or through a report);
 *            (4) the treasury sweep answered 500 "please try again"; (5) a queued grant past 90 days was failed at the
 *            mend with "expired … without sufficient pool funds" when the mended pot covered it.
 *
 * One main-server process (takeover-test-harness.ts), a pot of 100, and:
 *   G  a passed grant_hardship of 5 to Ben                 waits; carried out at the mend
 *   Q  a grant_hardship of 50 queued for funds, 95 days old waits, never expired; paid at the mend
 *   F  a passed freeze_credit on Cara                       carried out in the pause (no Beans)
 *   S  a passed remove_member of Eve                        its start (a suspension) carried out in the pause
 *   R1 a removal of Dan whose grace window has ended        waits; at the mend a fresh 24-hour window, then carried out
 *   R2 a removal of Hal whose grace window has ended        waits; at the mend a fresh window, in which it is halted
 *   O  an open vote (grant_voucher on Cara)                 halted in the pause
 *   H  a removal of Gus in its grace window                 halted in the pause: Gus is a member again
 * and listings: three with no deal (removed in the pause: single, bulk, through a report) and one with a held deal
 * (refused in the pause words), an enterprise Ivy keeps (its sweep refused in the pause words), and a grant proposal.
 *
 * Every check is counted, not thrown, so a run on an older tree reports each finding that fails there.
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
const POT = 100;
const PAUSED = 'Payments are paused on this community while its admins fix a problem with its accounts. Nothing has moved.';
const WAITING = /^Waiting: payments are paused on this community while its admins fix a problem with its accounts\./;
const REOPENED = /^Payments were paused when the grace window ended, so it was reopened for 24 hours after they worked again\./;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const HOUR = 3600_000;

const NAMES = ['anna', 'ben', 'cara', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy'] as const;
type Keys = Record<(typeof NAMES)[number], string>;
type Setup = { audit: any; pot: number; heldDeal: string; heldPost: string; posts: string[]; report: string; treasury: string };

// ── The node process's commands ────────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        ...serveCommands,
        setup: async (k: Keys): Promise<Setup> => {
            const se = await import('./state-engine.js');
            const core = await import('@beanpool/core');
            const { db } = await import('./db/db.js');
            const { ledger } = await import('./engine/ledger.js');
            se.seedGenesisMember(k.anna, 'Anna');
            const epoch = ledger.getCurrentEpoch();
            for (const name of NAMES.slice(1)) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, earned_credit, invited_by, invite_code)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', 500, ?, 'TEST')`).run(k[name], name, AVATAR, k.anna);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(k[name], epoch);
            }
            se.reconcileLedgerFromDb();
            se.transfer('genesis', k.ben, 30, 'seed Ben', 'direct', true);
            se.transfer('genesis', k.dan, 3, 'seed Dan', 'direct', true);
            // Ben buys from Cara twice: one deal completed, one held in escrow.
            for (const pk of [k.ben, k.cara]) se.createPost('offer', 'general', 'Odd jobs', 'Help around the place', 5, 'fixed', pk, undefined, undefined, undefined, true);
            const kale = se.createPost('offer', 'food', 'Kale', 'Kale', 6, 'fixed', k.cara)!;
            const done = se.acceptPost(kale.id, k.ben);
            se.completePostTransaction(done.id, k.ben);
            const chard = se.createPost('offer', 'food', 'Chard', 'Chard', 3, 'fixed', k.cara)!;
            const held = se.acceptPost(chard.id, k.ben);
            // Three listings with no deal on them, one of them reported.
            const posts = ['Eggs', 'Plums', 'Honey'].map((t) => se.createPost('offer', 'food', t, t, 2, 'fixed', k.cara)!.id);
            const report = crypto.randomUUID();
            db.prepare("INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status) VALUES (?, ?, ?, ?, 'spam', 'pending')")
                .run(report, k.ben, k.cara, posts[2]);
            // An enterprise Ivy keeps, holding 20.
            const treasury = se.createTreasury('Seed Library', AVATAR, 0, { leadKeeperPubkey: k.ivy }).publicKey;
            se.transfer('genesis', treasury, 20, 'seed the library', 'direct', true);
            // A pot of 100, and the audit's baseline taken with it.
            core.setCommonsBalance(POT);
            se.persistCommonsBalance();
            db.prepare("DELETE FROM node_config WHERE key = 'ledger_audit_baseline'").run();
            const audit = se.runLedgerAudit();

            const at = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
            const add = (id: string, touches: string, effect: string, subject: string, params: string | null, status: string, closes: string, graceEnds: string | null) =>
                db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                                opens_at, closes_at, grace_period_ends_at, created_at, updated_at)
                            VALUES (?, ?, ?, 'Set up by the test', ?, ?, ?, ?, '1m1v', ?, ?, ?, ?, ?, ?)`)
                    .run(id, k.anna, `${effect} (${id})`, touches, effect, subject, params, status, at(-8), closes, graceEnds, at(-8), at(-8));
            add('G', 'pool', 'grant_hardship', k.ben, JSON.stringify({ amount: 5 }), 'passed', at(-1), null);
            add('Q', 'pool', 'grant_hardship', k.ben, JSON.stringify({ amount: 50 }), 'passed_queued_for_funds', at(-95), null);
            add('F', 'member', 'freeze_credit', k.cara, null, 'passed', at(-1), null);
            add('S', 'member', 'remove_member', k.eve, null, 'passed', at(-1), null);
            add('R1', 'member', 'remove_member', k.dan, null, 'execution_pending_grace', at(-8), at(-1));
            add('R2', 'member', 'remove_member', k.hal, null, 'execution_pending_grace', at(-8), at(-1));
            add('O', 'member', 'grant_voucher', k.cara, null, 'open', at(6), null);
            add('H', 'member', 'remove_member', k.gus, null, 'execution_pending_grace', at(-4), at(3));
            // Dan, Hal and Gus as the start of their removal left them: suspended, credit frozen.
            for (const pk of [k.dan, k.hal, k.gus]) db.prepare("UPDATE members SET status = 'disabled', credit_frozen = 1 WHERE public_key = ?").run(pk);
            return { audit, pot: se.getCommonsBalanceExact(), heldDeal: held.id, heldPost: chard.id, posts, report, treasury };
        },
        tick: async (a: { asOfMs?: number }) => {
            const { tickDecisions } = await import('./decisions-engine.js');
            return tickDecisions(a?.asOfMs);
        },
        state: async (a: { k: Keys; setup?: Setup }) => {
            const se = await import('./state-engine.js');
            const core = await import('@beanpool/core');
            const { db } = await import('./db/db.js');
            const k = a.k;
            const decisions = Object.fromEntries((db.prepare('SELECT id, status, execution_error, execution_reason, grace_period_ends_at FROM decisions').all() as any[])
                .map((r) => [r.id, { status: r.status, error: r.execution_error, reason: r.execution_reason, graceEnds: r.grace_period_ends_at }]));
            const members = Object.fromEntries(NAMES.map((n) => [n, db.prepare('SELECT status, credit_frozen AS frozen FROM members WHERE public_key = ?').get(k[n])]));
            const balances = Object.fromEntries([...NAMES.map((n) => [n, k[n]]), ...(a.setup ? [['treasury', a.setup.treasury]] : [])].map(([n, pk]) => [n,
                String((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: unknown } | undefined)?.balance ?? 'none')]));
            const posts = a.setup ? Object.fromEntries([...a.setup.posts, a.setup.heldPost].map((id) => [id,
                (db.prepare('SELECT active, status FROM posts WHERE id = ?').get(id) as any)])) : {};
            const report = a.setup ? (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(a.setup.report) as any)?.status : null;
            const row = db.prepare("SELECT balance, typeof(balance) AS t FROM accounts WHERE public_key = 'COMMONS_POOL'").get() as { balance: unknown; t: string };
            const audit = se.runLedgerAudit();
            return {
                decisions, members, balances, posts, report,
                potRow: { balance: String(row.balance), t: row.t }, memory: String(core.COMMONS_BALANCE),
                txCount: (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c,
                decisionCount: (db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as { c: number }).c,
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
const live = (p: any) => p?.active === 1;

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
    const ids = Object.fromEntries(NAMES.map((n) => [n, keypair()])) as Record<(typeof NAMES)[number], Id>;
    const k = Object.fromEntries(NAMES.map((n) => [n, ids[n].pk])) as Keys;
    const admin = { 'X-Admin-Password': PW };
    const nodes: NodeProc[] = [];
    try {
        console.log(`\n— 1. a main server with a pot of ${POT}, Decisions due, listings and an enterprise —`);
        let node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        const setup: Setup = await node.send('setup', k);
        assert(setup.audit?.ok === true && setup.pot === POT, `the ledger adds up with a pot of ${POT} (${JSON.stringify(setup.audit)})`);
        const before = await node.send('state', { k, setup });

        console.log("\n— 2. it stops, the pot's row becomes 'abc', and it starts again —");
        await node.kill('SIGTERM');
        setPotRow(dir, "'abc'");
        node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        const stop = (node.output().match(/🛑 The Commons pot's row.*/) ?? [''])[0];
        assert(/holds text 'abc', not a number of Beans/.test(stop) && /no Beans move at all until it is mended: no deal, refund, removal, account deletion or payment from the Commons/.test(stop),
            `the boot's 🛑 line says no Beans move until the row is mended (${stop.slice(0, 200) || 'no 🛑 line'})`);

        console.log('\n— 3. the tick: what moves no Beans is carried out; what moves Beans waits —');
        await node.send('tick', {});
        const paused = await node.send('state', { k, setup });
        const d = paused.decisions;
        assert(d.F.status === 'executed' && paused.members.cara.frozen === 1, `F, the credit freeze, is carried out (${JSON.stringify(d.F)})`);
        assert(d.S.status === 'execution_pending_grace' && paused.members.eve.status === 'disabled', `S, a removal's start, suspends Eve (${JSON.stringify(d.S)})`);
        assert(d.G.status === 'passed' && !d.G.error && WAITING.test(String(d.G.reason)), `G, the grant, waits as passed (${JSON.stringify(d.G)})`);
        assert(d.Q.status === 'passed_queued_for_funds', `Q, queued 95 days, is not expired while the pot is unknown (${JSON.stringify(d.Q)})`);
        for (const [id, who] of [['R1', 'dan'], ['R2', 'hal']] as const) {
            assert(d[id].status === 'execution_pending_grace' && !d[id].error && WAITING.test(String(d[id].reason)) && paused.members[who].status === 'disabled',
                `${id}, a removal whose grace ended, waits in its grace window, not carried out (${JSON.stringify(d[id])})`);
        }
        assert(paused.balances.ben === before.balances.ben && paused.balances.dan === before.balances.dan && paused.txCount === before.txCount,
            `no Beans moved (Ben ${paused.balances.ben}, Dan ${paused.balances.dan}, ${paused.txCount} transactions)`);
        assert(paused.potRow.balance === 'abc' && paused.memory === 'NaN' && paused.audit.badBalances === 1,
            `the pot's row still holds 'abc', the pot is unknown, the audit counts it (${JSON.stringify(paused.potRow)}, ${paused.memory})`);
        await node.send('tick', {});
        const again = await node.send('state', { k, setup });
        assert(['G', 'Q', 'R1', 'R2'].every((id) => JSON.stringify(again.decisions[id]) === JSON.stringify(paused.decisions[id])), 'a second tick changes nothing');

        console.log('\n— 4. over the real HTTPS server, in the pause —');
        const base = `https://localhost:${await node.send('serve')}`;
        // Re-review NB-2: a halt moves no Beans, so it works in the pause.
        const haltO = await post(base, '/api/local/admin/decisions/O/halt', { reason: 'Halting this vote while we look into it' }, admin);
        const haltH = await post(base, '/api/local/admin/decisions/H/halt', { reason: 'Halting this removal while we look into it' }, admin);
        const afterHalts = await node.send('state', { k, setup });
        assert(haltO.status === 200 && afterHalts.decisions.O.status === 'admin_halted', `an open vote can be halted (${brief(haltO)})`);
        assert(haltH.status === 200 && afterHalts.decisions.H.status === 'admin_halted' && afterHalts.members.gus.status === 'active' && afterHalts.members.gus.frozen === 0,
            `a removal in its grace window can be halted, and Gus is a member again (${brief(haltH)}, Gus ${JSON.stringify(afterHalts.members.gus)})`);
        // Re-review NB-1: a grant can't be proposed while there is no cap to measure it against.
        const propose = await signed(base, '/api/commons/decisions', ids.fay, {
            title: 'A big grant', description: 'A grant far bigger than the Commons could ever pay', touches: 'pool', effect: 'grant_hardship',
            subject: k.ben, params: { amount: 1_000_000 },
        });
        const afterPropose = await node.send('state', { k, setup });
        assert(propose.status === 503 && propose.body?.error === PAUSED && afterPropose.decisionCount === afterHalts.decisionCount,
            `a grant of 1,000,000 can't be proposed: 503, in the pause words, and no Decision written (${brief(propose)})`);
        // Re-review NB-3: listings with no deal come down; one with a held deal doesn't.
        const [eggs, plums, honey] = setup.posts;
        const del = await post(base, `/api/local/admin/posts/${eggs}/delete`, {}, admin);
        const bulk = await post(base, '/api/local/admin/posts/bulk-delete', { postIds: [plums] }, admin);
        const action = await post(base, `/api/local/admin/reports/${setup.report}/action`, { deletePost: true }, admin);
        const heldDel = await post(base, `/api/local/admin/posts/${setup.heldPost}/delete`, {}, admin);
        const afterPosts = await node.send('state', { k, setup });
        assert(del.status === 200 && !live(afterPosts.posts[eggs]), `a listing with no deal is removed (${brief(del)})`);
        assert(bulk.status === 200 && !live(afterPosts.posts[plums]), `bulk removal of a listing with no deal works (${brief(bulk)})`);
        assert(action.status === 200 && !live(afterPosts.posts[honey]) && afterPosts.report !== 'pending',
            `a report's "remove the post" works, and the report is closed (${brief(action)}, report ${afterPosts.report})`);
        assert(heldDel.status === 503 && heldDel.body?.error === PAUSED && live(afterPosts.posts[setup.heldPost]),
            `a listing with a held deal is not removed: 503, in the pause words (${brief(heldDel)})`);
        // Members' money steps, and NB-4 of the re-review: the sweep answers in the pause words, not "please try again".
        const confirm = await signed(base, '/api/marketplace/transactions/complete', ids.ben, { transactionId: setup.heldDeal, confirmerPublicKey: k.ben });
        const purge = await signed(base, '/api/member/purge', ids.fay, {});
        const prune = await post(base, `/api/local/admin/users/${k.ben}/prune`, {}, admin);
        const accel = await post(base, '/api/local/admin/decisions/R1/accelerate', {}, admin);
        const sweep = await signed(base, `/api/treasury/${setup.treasury}/sweep`, ids.ivy, { amount: 5 });
        assert(confirm.status >= 400 && confirm.body?.error === PAUSED, `a buyer confirming a held deal: refused in the pause words (${brief(confirm)})`);
        assert(purge.status >= 400 && purge.body?.error === PAUSED, `a member deleting their account: refused in the pause words (${brief(purge)})`);
        assert(prune.status >= 400 && prune.body?.error === PAUSED, `an admin's prune: refused in the pause words (${brief(prune)})`);
        assert(accel.status === 503 && accel.body?.error === PAUSED, `an admin hurrying a removal: 503, in the pause words (${brief(accel)})`);
        assert(sweep.status === 503 && sweep.body?.error === PAUSED, `a keeper's sweep: 503, in the pause words (${brief(sweep)})`);
        const answers = JSON.stringify([propose, heldDel, confirm, purge, prune, accel, sweep]);
        assert(!/finite number|NaN|Internal Server Error|try again/.test(answers), 'no answer says "finite number", "NaN", "Internal Server Error" or "try again"');
        const afterAll = await node.send('state', { k, setup });
        assert(JSON.stringify(afterAll.balances) === JSON.stringify(before.balances) && afterAll.txCount === before.txCount && afterAll.members.fay.status === 'active',
            `nothing moved: every balance and the history as before (${JSON.stringify(afterAll.balances)})`);

        console.log('\n— 5. the row is mended; the first tick pays what waited, and reopens the removals\' brake —');
        await node.kill('SIGTERM');
        setPotRow(dir, String(POT));
        node = await spawnNode(SCRIPT, dir, env);
        nodes.push(node);
        assert(!/🛑 The Commons pot's row/.test(node.output()), 'the boot after the mend has no 🛑 line');
        const mendedAt = Date.now();
        await node.send('tick', {});
        const mended = await node.send('state', { k, setup });
        assert(mended.decisions.G.status === 'executed', `G is carried out (${JSON.stringify(mended.decisions.G)})`);
        assert(mended.decisions.Q.status === 'executed',
            `Q, past 90 days, is paid by the mended pot, not failed as "expired without sufficient pool funds" (${JSON.stringify(mended.decisions.Q)})`);
        assert(Number(mended.balances.ben) === Number(before.balances.ben) + 55, `Ben has 5 + 50 more (${mended.balances.ben})`);
        for (const [id, who] of [['R1', 'dan'], ['R2', 'hal']] as const) {
            const r = mended.decisions[id];
            const ends = Date.parse(r.graceEnds);
            assert(r.status === 'execution_pending_grace' && REOPENED.test(String(r.reason)) && ends > mendedAt + 23 * HOUR && ends < mendedAt + 25 * HOUR
                && mended.members[who].status === 'disabled',
                `${id} is not carried out at once: its grace window reopens for 24 hours (${JSON.stringify(r)})`);
        }
        const haltR2 = await post(base.replace(/:\d+$/, `:${await node.send('serve')}`), '/api/local/admin/decisions/R2/halt', { reason: 'Halting it in the reopened window' }, admin);
        const afterHaltR2 = await node.send('state', { k, setup });
        assert(haltR2.status === 200 && afterHaltR2.decisions.R2.status === 'admin_halted' && afterHaltR2.members.hal.status === 'active',
            `in that window an admin can halt R2, and Hal is a member again (${brief(haltR2)})`);
        await node.send('tick', { asOfMs: Date.now() + 25 * HOUR });
        const later = await node.send('state', { k, setup });
        assert(later.decisions.R1.status === 'executed' && later.members.dan.status === 'pruned',
            `25 hours on, R1 is carried out: Dan's removal completes (${JSON.stringify(later.decisions.R1)}, Dan ${later.members.dan.status})`);
        assert(later.decisions.R2.status === 'admin_halted', 'R2 stays halted');
        const carried = node.output().match(/\[Decisions\] (G|R1) \(\w+\) carried out now that the Commons pot is a number again/g) ?? [];
        assert(carried.length === 2, `the log says G and R1 were carried out after waiting (${carried.length} lines)`);
        assert(later.audit.ok === true && later.audit.badBalances === 0 && Math.abs(later.audit.drift) < 1e-9,
            `the ledger adds up (${JSON.stringify(later.audit)})`);

        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        if (testsPassed !== testsRun) process.exitCode = 1;
    } catch (e: any) {
        console.error(`❌ ${e?.message || e}`);
        for (const n of nodes.slice(-1)) console.error(`--- node output (tail) ---\n${n.output().slice(-3000)}`);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
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
