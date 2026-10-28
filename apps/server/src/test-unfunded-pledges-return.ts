/**
 * A project that ends short of its goal gives its backers their Beans back a week after its end date (Marty, board,
 * 27 Oct 2026: "Return them a week after the end date", unless the leader moves the date in that week; backers are told
 * either way). Before this, an unfunded project's pledges stayed held after its end date until its leader cancelled it or
 * moved the date, so a leader who walked away left the backers' Beans stuck.
 *
 * Over real HTTP with real signatures: projects made through POST /api/enterprise, pledges through both pledge doors, the
 * date moved through POST /api/crowdfund/projects/update, the project page read through GET /api/treasury/:id, and each
 * member's notices through GET /api/notices. The return is run as the main server's minute tick runs it
 * (engine/unfunded-pledges.ts returnUnfundedPledges, with the node's own transfer, conservingTransaction, broadcast and push
 * watched), and through the wrapper that tick calls (state-engine.ts returnUnfundedProjectPledges).
 *
 *  1. The page says nothing has gone back: GET /api/treasury/:id answers `pledgesReturnedAt: null`.
 *  2. Not a millisecond before the end date + 7 (the deadline's instant + 7 days, #2500's day rule): nothing moves.
 *  3. From then, every backer gets back exactly what they pledged, once: one fee-free row each out of the project's escrow,
 *     naming the project; the escrow empty; the node's total unchanged; the ledger audit 0 drift; the raised figure 0; the
 *     page says when they went back. A node that was off on the day returns them at its next tick, however late.
 *  4. Each backer and the leader are told: a notice kept for each (read over HTTP), live to their own sockets with that
 *     notice's id, and a push of kind community.notice on the escrow category. The leader's counts the backers and the
 *     Beans and names nobody.
 *  5. A second tick moves nothing and tells nobody.
 *  6. The leader moves the date in that week: the backers are told (the leader is not), nothing goes back when the old week
 *     ends, and the project takes pledges again. A move before the end date is over tells nobody.
 *  7. A project that reached its goal: nothing goes back, however long ago its end date, even with Beans planted in its
 *     escrow (those are the stranded-pledges boot step's). A project with no end date: nothing.
 *  8. On a standby nothing moves and nobody is told; the same project goes back once the server is the main one again,
 *     through the wrapper the main server's minute tick calls.
 *  9. A backer whose account is closed (Marty, board, 27 Oct 2026: "To the Commons"). The measured case: Dan 40, Eve 25,
 *     Zed 0.01, and Zed deletes his account (purgeMemberSelf); 8 days after the end date the tick pays Dan 40 and Eve 25,
 *     the Commons gains Zed's 0.01 in a row naming the project and nobody, the escrow is 0, the audit 0 drift, nothing is
 *     left for the operator, and the page says the Beans went back. The paid backers and the leader are told as before
 *     (the leader's notice counts 2 backers, 65 Beans); nobody is told of the closed account. A wound-up enterprise as a
 *     backer goes the same way. A backer who still can't be paid here (a live visitor's row) leaves the whole project
 *     exactly as it is, for the operator, tick after tick. (Until this rule, a pruned backer was that case: part 9 changed
 *     with the rule.)
 * 10. A node killed in the middle of a return (separate processes on one data dir of their own): nothing of it was kept;
 *     at its next boot the main server's own minute tick returns every pledge exactly once, and a third boot moves nothing.
 * 11. After the return, the date moved and a new pledge: the leader's cancel pays nobody twice.
 * 12. The leader moves an end date that is over again and again, to dates over or a moment from over, renaming it too:
 *     each backer is told once a day, and once more when it is taken off; a day on, a move tells them again.
 * 13. Pledges not exact in binary (0.1, 0.3, 0.2, 0.6, 0.7): once they went back, the projects row, the page and the
 *     project's read all say 0 raised, not a float residue; its leader can move its date and lower its goal; and when the
 *     new date ends with nothing pledged, nothing goes back and the page says nothing is held.
 * 14. The lead handed to another keeper, the projects row still naming its maker: the new lead's move of the end date
 *     reaches the row the return reads; its maker can neither move it nor cancel it, nor can a stranger, nor the new lead
 *     while an admin has switched their operator access off; the new lead's cancel gives each backer their pledge back
 *     once, the escrow ends at 0 and the audit holds.
 *
 * Run: node scripts/run-server-suites.mjs with SERVER_SUITES_ONLY=test-unfunded-pledges-return
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import * as stateEngine from './state-engine.js';
import {
    initStateEngine, payFromCommons, transfer, conservingTransaction, broadcast, dispatchPushNotification, runLedgerAudit,
    reconcileLedgerFromDb, moveToCommons, purgeMemberSelf, getCommonsBalanceExact,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, createCrowdfundProject, getCrowdfundProject, pledgeToProject } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { isPastDeadline } from '@beanpool/core';

// Loaded so that this suite runs to the end on a tree without the return (it fails there, with a count, rather than
// stopping at the import).
type UnfundedModule = typeof import('./engine/unfunded-pledges.js');
let unfunded: UnfundedModule | null = null;
/** The wrapper the main server's minute tick calls, when this tree has it. */
const tickWrapper = (): ((now?: number) => { returned: number; left: number }) | null =>
    (stateEngine as any).returnUnfundedProjectPledges ?? null;

const SCRIPT = fileURLToPath(import.meta.url);
const PHASE = process.argv[2] ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DUST = 1e-6;
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(pubKeyHex, callsign);
    setMemberPhoto(db, pubKeyHex, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pubKeyHex);
    return { pubKeyHex, privateKey, callsign };
}

const balanceOf = (key: string): number =>
    (db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(key) as { balance: number } | undefined)?.balance ?? 0;
const escrowOf = (projectId: string) => balanceOf(`escrow_${projectId}`);
const raisedOf = (projectId: string): number =>
    (db.prepare('SELECT current_amount FROM projects WHERE id = ?').get(projectId) as { current_amount: number } | undefined)?.current_amount ?? NaN;
const sumBalances = (): number => (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

interface OutRow { id: string; to_pubkey: string; amount: number; tax_fee: number | null; memo: string; project_id: string | null; timestamp: string }
/** Every ledger row paid out of a project's escrow. */
const rowsOutOf = (projectId: string): OutRow[] => db.prepare(`
    SELECT id, to_pubkey, amount, tax_fee, memo, project_id, timestamp FROM transactions WHERE from_pubkey = ? ORDER BY timestamp, rowid
`).all(`escrow_${projectId}`) as OutRow[];

/** A project's deadline on both its rows: the enterprise's (members) and the crowdfund project's (projects). */
function setDeadline(projectId: string, deadline: string | null): void {
    db.prepare('UPDATE members SET deadline_at = ? WHERE public_key = ?').run(deadline, projectId);
    db.prepare('UPDATE projects SET deadline_at = ? WHERE id = ?').run(deadline, projectId);
}

interface KeptRow { id: string; recipient: string; title: string; body: string; data: string }
/** The notices the node keeps for a member, newest last. */
const keptFor = (pubkey: string): KeptRow[] =>
    db.prepare('SELECT id, recipient, title, body, data FROM moderation_notices WHERE recipient = ? ORDER BY created_at, rowid').all(pubkey) as KeptRow[];
const kindOf = (row: { data: string }) => { try { return JSON.parse(row.data)?.kind as string | undefined; } catch { return undefined; } };
const enterpriseOf = (row: { data: string }) => { try { return JSON.parse(row.data)?.enterprise as string | undefined; } catch { return undefined; } };

type Signed = { status: number; body: any };
/** The replay-proof scheme the real middleware requires: method + path (without its query) + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST', route: string, body: unknown, id: Id): Promise<Signed> {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

/** A project made as both apps make one: a bounded enterprise with a goal and an end date. */
async function makeProject(leader: Id, name: string, goal: number, deadlineAt: string): Promise<string> {
    const made = await signedFetch('POST', '/api/enterprise', { name, purpose: `${name}, for the valley`, lifecycle: 'bounded', goalAmount: goal, deadlineAt }, leader);
    assert(made.status === 200 && typeof made.body?.publicKey === 'string', `"${name}" is made through POST /api/enterprise (${made.status} ${made.body?.error ?? ''})`);
    return made.body?.publicKey as string;
}

/** A pledge through one of the two doors both apps have used. */
async function pledge(who: Id, projectId: string, amount: number, door: 'treasury' | 'crowdfund'): Promise<void> {
    const route = door === 'treasury' ? `/api/treasury/${projectId}/pledge` : `/api/crowdfund/projects/${projectId}/pledge`;
    const res = await signedFetch('POST', route, { amount, memo: `${who.callsign}'s pledge` }, who);
    assert(res.status === 200 && res.body?.success === true, `${who.callsign} pledges ${amount} through the ${door} door (${res.status} ${res.body?.error ?? ''})`);
}

/** The project page as a member reads it. */
const readPage = async (who: Id, projectId: string) => (await signedFetch('GET', `/api/treasury/${projectId}`, null, who)).body;

/** The node's own primitives, with what goes out live and as a push written down. */
function watchedHooks() {
    const live: { event: any; to: string[] | undefined }[] = [];
    const pushes: { targets: string[]; actor: string; title: string; body: string; data: Record<string, any>; category: string; kind: string }[] = [];
    const hooks = {
        transfer,
        conservingTransaction,
        moveToCommons: (from: string, amount: number, memo: string) => moveToCommons(from, amount, memo),
        broadcast: (event: any, to?: string[]) => { live.push({ event, to }); return broadcast(event, to); },
        dispatchPushNotification: (targets: string[], actor: string, title: string, body: string, data: Record<string, any>, category: any, kind: any) => {
            pushes.push({ targets: [...targets], actor, title, body, data, category, kind });
            return dispatchPushNotification(targets, actor, title, body, data, category, kind);
        },
    };
    return { hooks, live, pushes };
}

// ── The node killed in the middle of a return: its processes ─────────────────────────────────────────────────────────

/** Where the processes of part 10 write what they saw, for this one to read: a file, written before any kill. */
const sawFile = (dir: string, phase: string) => path.join(dir, `saw-${phase}.json`);

interface World { lea: string; ann: string; ben: string; cal: string; project: string; pledged: Record<string, number> }
interface Seen { ann: number; ben: number; cal: number; lea: number; escrow: number; sum: number; outRows: number; notices: number; raised: number }

function seen(w: World): Seen {
    const notices = (db.prepare('SELECT COUNT(*) AS c FROM moderation_notices WHERE recipient IN (?, ?, ?, ?)').get(w.lea, w.ann, w.ben, w.cal) as { c: number }).c;
    return {
        ann: balanceOf(w.ann), ben: balanceOf(w.ben), cal: balanceOf(w.cal), lea: balanceOf(w.lea),
        escrow: escrowOf(w.project), sum: sumBalances(), outRows: rowsOutOf(w.project).length, notices, raised: raisedOf(w.project),
    };
}

async function child(phase: string): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR!;
    const write = (what: unknown) => fs.writeFileSync(sawFile(dir, phase), JSON.stringify(what));
    // No node reaches anything but this machine.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    initStateEngine();
    unfunded = await import('./engine/unfunded-pledges.js').catch(() => null);

    if (phase === 'crash-mid-return') {
        const lea = makeMember('Lea'), ann = makeMember('Ann'), ben = makeMember('Ben'), cal = makeMember('Cal');
        for (const m of [lea, ann, ben, cal]) payFromCommons(m.pubKeyHex, 100, 'Beans to pledge', { allowDeficit: true });
        const project = crypto.randomUUID();
        createCrowdfundProject(project, lea.pubKeyHex, 'Seed Library', 'Seeds for the valley', [], 100, new Date(Date.now() + 5 * DAY).toISOString());
        const pledged = { [ann.pubKeyHex]: 10, [ben.pubKeyHex]: 15, [cal.pubKeyHex]: 20 };
        for (const [who, amount] of Object.entries(pledged)) pledgeToProject(crypto.randomUUID(), project, who, amount, 'Project Pledge');
        const w: World = { lea: lea.pubKeyHex, ann: ann.pubKeyHex, ben: ben.pubKeyHex, cal: cal.pubKeyHex, project, pledged };
        fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(w));
        // Its end date over 8 days ago: due. From here to the kill nothing awaits, so no timer of this process runs between.
        setDeadline(project, new Date(Date.now() - 8 * DAY).toISOString());
        write({ before: seen(w), module: !!unfunded });
        if (!unfunded) process.exit(0);
        let paid = 0;
        // Killed right after the second payment, inside the return's one transaction: the way a power cut or an OOM kill
        // stops a node mid-write.
        unfunded.returnUnfundedPledges({
            ...watchedHooks().hooks,
            transfer: (...args: Parameters<typeof transfer>) => {
                const txn = transfer(...args);
                if (++paid === 2) process.kill(process.pid, 'SIGKILL');
                return txn;
            },
        });
        write({ before: seen(w), module: true, finished: true });
        process.exit(0);
    }

    const w = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')) as World;
    if (phase === 'boot-and-tick') {
        // Read at once: the boot's own timers have not run yet.
        const atBoot = seen(w);
        // The main server's own minute tick (state-engine.ts armMainServerTimers) is what returns them here.
        const until = Date.now() + 150 * 1000;
        while (Date.now() < until && escrowOf(w.project) > DUST) await new Promise((r) => setTimeout(r, 500));
        const afterTick = seen(w);
        const audit = runLedgerAudit();
        const outRows = rowsOutOf(w.project).map((r) => ({ to: r.to_pubkey, amount: r.amount, fee: r.tax_fee, project: r.project_id }));
        const wrapper = tickWrapper();
        const again = wrapper ? wrapper() : null;
        write({ atBoot, afterTick, audit, outRows, again, afterAgain: seen(w) });
        process.exit(0);
    }
    if (phase === 'boot-again') {
        const atBoot = seen(w);
        const wrapper = tickWrapper();
        const again = wrapper ? wrapper() : null;
        write({ atBoot, again, after: seen(w), audit: runLedgerAudit() });
        process.exit(0);
    }
    throw new Error(`no such phase: ${phase}`);
}

/** One process of part 10 on `dir`, to its end: its exit code and signal, and what it saw. */
function runPhase(dir: string, phase: string): { status: number | null; signal: NodeJS.Signals | null; saw: any; output: string } {
    const res = spawnSync(process.execPath, [...process.execArgv, SCRIPT, phase], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dir },
        encoding: 'utf8',
        timeout: 200 * 1000,
        maxBuffer: 64 * 1024 * 1024,
    });
    let saw: any = null;
    try { saw = JSON.parse(fs.readFileSync(sawFile(dir, phase), 'utf8')); } catch { /* it wrote nothing */ }
    return { status: res.status, signal: res.signal, saw, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

// ── The suite ────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (PHASE) return child(PHASE);
    console.log('\nA project that ends short of its goal gives its backers their Beans back a week after its end date\n');
    unfunded = await import('./engine/unfunded-pledges.js').catch(() => null);
    assert(unfunded !== null, 'the return has its module (engine/unfunded-pledges.ts)');
    assert(tickWrapper() !== null, "the main server's minute tick has its wrapper (state-engine.ts returnUnfundedProjectPledges)");
    const tick = (hooks: ReturnType<typeof watchedHooks>['hooks'], now?: number) =>
        unfunded?.returnUnfundedPledges(hooks, now) ?? { returned: -1, left: -1 };

    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const lea = makeMember('Lea');
    const max = makeMember('Max');
    const ann = makeMember('Ann');
    const ben = makeMember('Ben');
    const cal = makeMember('Cal');
    for (const m of [lea, max, ann, ben, cal]) payFromCommons(m.pubKeyHex, 200, 'Beans to pledge', { allowDeficit: true });

    // ── 1. A project, pledged to through both doors; its page says nothing has gone back ───────────────────────────────
    console.log('── 1. The project and its pledges ──');
    const roof = await makeProject(lea, 'Village Hall Roof', 100, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(ann, roof, 10, 'treasury');
    await pledge(ben, roof, 5, 'crowdfund');
    await pledge(ben, roof, 10, 'treasury');
    await pledge(cal, roof, 20, 'crowdfund');
    assert(near(escrowOf(roof), 45) && near(raisedOf(roof), 45), `the roof's escrow holds the 45 Beans pledged (${escrowOf(roof)}), raised 45 (${raisedOf(roof)})`);
    const pageBefore = await readPage(ann, roof);
    assert(!!pageBefore && 'pledgesReturnedAt' in pageBefore && pageBefore.pledgesReturnedAt === null,
        `the page says nothing has gone back: pledgesReturnedAt null (${JSON.stringify(pageBefore?.pledgesReturnedAt)})`);

    const roofBefore = { ann: balanceOf(ann.pubKeyHex), ben: balanceOf(ben.pubKeyHex), cal: balanceOf(cal.pubKeyHex), lea: balanceOf(lea.pubKeyHex) };
    const totalBefore = sumBalances();
    const watched = watchedHooks();

    // ── 2 and 3. Its end date 20 days ago: not a millisecond before the end date + 7, then everything, once ─────────────
    // A node that was off on the day returns them at its next tick, however late. The deadline is set and the return run
    // with nothing awaited between, so this process's own minute tick can't run in the middle.
    console.log('── 2. Not before the end date + 7 ──');
    const roofDeadline = new Date(Date.now() - 20 * DAY).toISOString();
    setDeadline(roof, roofDeadline);
    const dueAt = Date.parse(roofDeadline) + 7 * DAY;
    const early = tick(watched.hooks, dueAt - 1);
    const roofEarly = { escrow: escrowOf(roof), rows: rowsOutOf(roof).length, ann: balanceOf(ann.pubKeyHex) };
    console.log('── 3. The return ──');
    const first = tick(watched.hooks, dueAt);
    assert(early.returned === 0 && near(roofEarly.escrow, 45) && roofEarly.rows === 0 && near(roofEarly.ann, roofBefore.ann),
        `a millisecond before its end date + 7 nothing moves (${JSON.stringify(early)}, escrow ${roofEarly.escrow}, rows ${roofEarly.rows})`);
    assert(first.returned === 1 && first.left === 0, `at its end date + 7 the project's pledges go back (${JSON.stringify(first)})`);

    assert(near(balanceOf(ann.pubKeyHex), roofBefore.ann + 10), `Ann gets back exactly her 10 (${balanceOf(ann.pubKeyHex) - roofBefore.ann})`);
    assert(near(balanceOf(ben.pubKeyHex), roofBefore.ben + 15), `Ben gets back exactly his 5 + 10 (${balanceOf(ben.pubKeyHex) - roofBefore.ben})`);
    assert(near(balanceOf(cal.pubKeyHex), roofBefore.cal + 20), `Cal gets back exactly their 20 (${balanceOf(cal.pubKeyHex) - roofBefore.cal})`);
    assert(near(balanceOf(lea.pubKeyHex), roofBefore.lea), `the leader's own balance is untouched (${balanceOf(lea.pubKeyHex)})`);
    assert(near(stateEngine.getBalance(ann.pubKeyHex).balance, roofBefore.ann + 10), 'and the in-memory ledger agrees with the rows');
    assert(escrowOf(roof) <= DUST, `the roof's escrow is empty (${escrowOf(roof)})`);
    assert(near(balanceOf(roof), 0), `the enterprise's own account is untouched (${balanceOf(roof)})`);
    assert(near(sumBalances(), totalBefore), `the node's total is unchanged (${sumBalances()} vs ${totalBefore})`);
    const audit = runLedgerAudit();
    assert(audit.ok && Math.abs(audit.drift) < 0.0001, `the ledger audit holds with 0 drift (ok ${audit.ok}, drift ${audit.drift})`);
    const roofRows = rowsOutOf(roof);
    const rowTo = (who: Id) => roofRows.filter((r) => r.to_pubkey === who.pubKeyHex);
    assert(roofRows.length === 3 && rowTo(ann).length === 1 && rowTo(ben).length === 1 && rowTo(cal).length === 1,
        `one ledger row each, Ben's two pledges as one (${JSON.stringify(roofRows.map((r) => [r.to_pubkey.slice(0, 6), r.amount]))})`);
    assert(near(rowTo(ben)[0]?.amount ?? 0, 15) && roofRows.every((r) => !r.tax_fee),
        `fee-free, each the backer's own sum (${JSON.stringify(roofRows.map((r) => [r.amount, r.tax_fee]))})`);
    assert(roofRows.every((r) => r.project_id === roof && /^Pledge returned: "Village Hall Roof"/.test(r.memo)),
        `each row names the project and says why ("${roofRows[0]?.memo}")`);
    assert(near(raisedOf(roof), 0), `the roof shows 0 raised (${raisedOf(roof)})`);
    const pageAfter = await readPage(ann, roof);
    const returnedAt = roofRows.map((r) => r.timestamp).sort().at(-1);
    assert(pageAfter?.pledgesReturnedAt === returnedAt && pageAfter?.currentAmount === 0,
        `the page says when they went back (${pageAfter?.pledgesReturnedAt} = ${returnedAt}), and 0 raised (${pageAfter?.currentAmount})`);

    // ── 4. Each backer and the leader are told ────────────────────────────────────────────────────────────────────
    console.log('── 4. The notices ──');
    for (const who of [ann, ben, cal]) {
        const kept = keptFor(who.pubKeyHex).filter((n) => kindOf(n) === 'pledges_returned');
        assert(kept.length === 1 && kept[0].body.includes('"Village Hall Roof"') && /went back to you/.test(kept[0].body),
            `${who.callsign} has one notice kept that their pledge to "Village Hall Roof" went back ("${kept[0]?.title}": "${kept[0]?.body}")`);
        const read = await signedFetch('GET', '/api/notices?unseen=1', null, who);
        assert(read.status === 200 && (read.body?.notices ?? []).some((n: any) => n.id === kept[0]?.id),
            `${who.callsign} reads it over HTTP (GET /api/notices: ${read.status})`);
        const theirs = watched.live.filter((l) => l.event?.type === 'system_announcement' && l.to?.length === 1 && l.to[0] === who.pubKeyHex);
        assert(theirs.length === 1 && theirs[0].event.noticeId === kept[0]?.id && theirs[0].event.body === kept[0]?.body,
            `${who.callsign} is told live, on their own sockets only, with that notice's id`);
    }
    const leaKept = keptFor(lea.pubKeyHex).filter((n) => kindOf(n) === 'pledges_returned');
    assert(leaKept.length === 1 && leaKept[0].body.includes('"Village Hall Roof"') && /3 backers/.test(leaKept[0].body) && /45 Beans/.test(leaKept[0].body),
        `the leader has one notice kept, counting the backers and the Beans ("${leaKept[0]?.body}")`);
    assert(!!leaKept[0] && ![ann, ben, cal].some((m) => leaKept[0].body.includes(m.callsign) || leaKept[0].body.includes(m.pubKeyHex.slice(0, 8))),
        "the leader's notice names none of the backers");
    assert(watched.live.some((l) => l.event?.type === 'system_announcement' && l.to?.[0] === lea.pubKeyHex && l.event.noticeId === leaKept[0]?.id),
        'the leader is told live too, with their notice\'s id');
    const backerPush = watched.pushes.find((p) => p.targets.includes(ann.pubKeyHex));
    assert(!!backerPush && [...backerPush.targets].sort().join() === [ann, ben, cal].map((m) => m.pubKeyHex).sort().join()
        && backerPush.kind === 'community.notice' && backerPush.category === 'escrow',
        `one push to the three backers, kind community.notice, on the escrow category (${backerPush?.kind}, ${backerPush?.category}, ${backerPush?.targets.length})`);
    const leaderPush = watched.pushes.find((p) => p.targets.includes(lea.pubKeyHex));
    assert(!!leaderPush && leaderPush.targets.length === 1 && leaderPush.kind === 'community.notice' && leaderPush.category === 'escrow',
        `and one to the leader (${leaderPush?.kind}, ${leaderPush?.category})`);

    // ── 5. A second tick moves nothing and tells nobody ─────────────────────────────────────────────────────────────
    console.log('── 5. Once ──');
    const counts = { live: watched.live.length, pushes: watched.pushes.length, kept: keptFor(ann.pubKeyHex).length };
    const sumNow = sumBalances();
    const second = tick(watched.hooks);
    const third = tick(watched.hooks, Date.now() + 365 * DAY);
    assert(second.returned === 0 && third.returned === 0, `a second tick, and one a year on, return nothing (${JSON.stringify(second)} ${JSON.stringify(third)})`);
    assert(rowsOutOf(roof).length === 3 && near(sumBalances(), sumNow) && near(balanceOf(ann.pubKeyHex), roofBefore.ann + 10),
        'and move nothing');
    assert(watched.live.length === counts.live && watched.pushes.length === counts.pushes && keptFor(ann.pubKeyHex).length === counts.kept,
        'and tell nobody');

    // ── 6. The leader moves the date in that week ────────────────────────────────────────────────────────────────────
    console.log('── 6. The date moved in the week ──');
    const shed = await makeProject(lea, 'Tool Shed', 80, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(ann, shed, 8, 'treasury');
    await pledge(ben, shed, 4, 'crowdfund');
    // A move before the end date is over is an ordinary edit: nobody is told.
    const earlyMove = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: shed, creatorPubkey: lea.pubKeyHex, title: 'Tool Shed', description: 'Tool Shed, for the valley', goalAmount: 80, deadlineAt: new Date(Date.now() + 12 * DAY).toISOString() }, lea);
    assert(earlyMove.status === 200, `the leader moves the date before it is over (${earlyMove.status} ${earlyMove.body?.error ?? ''})`);
    assert(keptFor(ann.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved').length === 0, 'and nobody is told of that');
    // Its end date 3 days gone: in the week. Not due at this process's real time, so its own tick leaves it alone.
    const shedOldDeadline = new Date(Date.now() - 3 * DAY).toISOString();
    setDeadline(shed, shedOldDeadline);
    const shedNewDeadline = new Date(Date.now() + 10 * DAY).toISOString();
    const moved = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: shed, creatorPubkey: lea.pubKeyHex, title: 'Tool Shed', description: 'Tool Shed, for the valley', goalAmount: 80, deadlineAt: shedNewDeadline }, lea);
    assert(moved.status === 200, `the leader moves the date in the week after it (${moved.status} ${moved.body?.error ?? ''})`);
    const shedRow = db.prepare('SELECT deadline_at FROM projects WHERE id = ?').get(shed) as { deadline_at: string };
    assert(shedRow?.deadline_at === shedNewDeadline, `the project's end date is the new one (${shedRow?.deadline_at})`);
    for (const who of [ann, ben]) {
        const kept = keptFor(who.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved');
        assert(kept.length === 1 && kept[0].body.includes('"Tool Shed"'),
            `${who.callsign}, a backer, is told the end date moved ("${kept[0]?.title}": "${kept[0]?.body}")`);
    }
    assert(keptFor(lea.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved').length === 0, 'the leader, who moved it, is not told');
    assert(keptFor(cal.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved').length === 0, 'a member who did not back it is not told');
    const oldWeekOver = tick(watched.hooks, Date.parse(shedOldDeadline) + 7 * DAY + HOUR);
    assert(near(escrowOf(shed), 12) && rowsOutOf(shed).length === 0,
        `when the old week is over nothing goes back (${JSON.stringify(oldWeekOver)}, escrow ${escrowOf(shed)})`);
    await pledge(cal, shed, 3, 'crowdfund');
    assert(near(escrowOf(shed), 15), `and the project takes pledges again (escrow ${escrowOf(shed)})`);

    // ── 7. A project that reached its goal, and one with no end date ─────────────────────────────────────────────────────
    console.log('── 7. Funded, and no end date ──');
    const well = await makeProject(max, 'Village Well', 20, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(ann, well, 10, 'treasury');
    await pledge(ben, well, 10, 'crowdfund');
    const wellStatus = (db.prepare('SELECT status FROM projects WHERE id = ?').get(well) as { status: string }).status;
    assert(wellStatus === 'FUNDED' && near(balanceOf(well), 20) && escrowOf(well) <= DUST, `the well reached its goal: FUNDED, 20 swept to it (${wellStatus}, ${balanceOf(well)})`);
    // A pledge planted after the goal, as the old pledgeToProject took them: the stranded-pledges boot step's, never this.
    const late = crypto.randomUUID();
    db.prepare('UPDATE accounts SET balance = balance - 4 WHERE public_key = ?').run(cal.pubKeyHex);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(`escrow_${well}`);
    db.prepare('UPDATE accounts SET balance = balance + 4 WHERE public_key = ?').run(`escrow_${well}`);
    db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, project_id) VALUES (?, ?, ?, 4, ?, ?)').run(late, cal.pubKeyHex, `escrow_${well}`, 'Project Pledge', well);
    reconcileLedgerFromDb();
    const open = await makeProject(max, 'Open Solar', 500, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(cal, open, 6, 'treasury');
    const wellBefore = { ann: balanceOf(ann.pubKeyHex), ben: balanceOf(ben.pubKeyHex), cal: balanceOf(cal.pubKeyHex) };
    setDeadline(well, new Date(Date.now() - 30 * DAY).toISOString());
    setDeadline(open, null);
    const funded = tick(watched.hooks);
    assert(funded.returned === 0 && near(balanceOf(well), 20) && near(escrowOf(well), 4) && rowsOutOf(well).every((r) => r.to_pubkey === well),
        `a funded project's Beans stay where they are, the planted pledge too (${JSON.stringify(funded)}, ${balanceOf(well)}, escrow ${escrowOf(well)})`);
    assert(near(escrowOf(open), 6) && rowsOutOf(open).length === 0, `a project with no end date keeps its pledges (escrow ${escrowOf(open)})`);
    assert(near(balanceOf(ann.pubKeyHex), wellBefore.ann) && near(balanceOf(ben.pubKeyHex), wellBefore.ben) && near(balanceOf(cal.pubKeyHex), wellBefore.cal),
        'and no backer is paid anything');
    // The planted pledge goes back to Cal by hand, so the node's books are as they were.
    db.prepare('UPDATE accounts SET balance = balance + 4 WHERE public_key = ?').run(cal.pubKeyHex);
    db.prepare('UPDATE accounts SET balance = balance - 4 WHERE public_key = ?').run(`escrow_${well}`);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(late);
    reconcileLedgerFromDb();

    // ── 8. On a standby nothing moves; on the main server the wrapper its minute tick calls returns it ────────────────────
    console.log('── 8. A standby, then the main server again ──');
    const hall = crypto.randomUUID();
    createCrowdfundProject(hall, max.pubKeyHex, 'Hall Kitchen', 'A kitchen for the hall', [], 50, new Date(Date.now() + 10 * DAY).toISOString());
    pledgeToProject(crypto.randomUUID(), hall, ann.pubKeyHex, 6, 'Project Pledge');
    const annBeforeHall = balanceOf(ann.pubKeyHex);
    const hallCounts = { live: watched.live.length, pushes: watched.pushes.length, kept: keptFor(ann.pubKeyHex).length };
    // From here to the end of the part nothing awaits.
    setDeadline(hall, new Date(Date.now() - 8 * DAY).toISOString());
    setNodeRole('backup');
    let onStandby: { returned: number; left: number } | undefined;
    let wrapperOnStandby: { returned: number; left: number } | null | undefined;
    try {
        onStandby = tick(watched.hooks);
        wrapperOnStandby = tickWrapper()?.() ?? null;
    } finally {
        setNodeRole('primary');
    }
    const hallOnStandby = { escrow: escrowOf(hall), ann: balanceOf(ann.pubKeyHex), live: watched.live.length, pushes: watched.pushes.length, kept: keptFor(ann.pubKeyHex).length };
    const wrapper = tickWrapper();
    const onMain = wrapper ? wrapper() : { returned: -1, left: -1 };
    assert(onStandby?.returned === 0 && (wrapperOnStandby === null || wrapperOnStandby?.returned === 0) && near(hallOnStandby.escrow, 6) && near(hallOnStandby.ann, annBeforeHall),
        `on a standby nothing moves (${JSON.stringify(onStandby)} ${JSON.stringify(wrapperOnStandby)}, escrow ${hallOnStandby.escrow})`);
    assert(hallOnStandby.live === hallCounts.live && hallOnStandby.pushes === hallCounts.pushes && hallOnStandby.kept === hallCounts.kept, 'and nobody is told');
    assert(onMain.returned === 1 && escrowOf(hall) <= DUST && near(balanceOf(ann.pubKeyHex), annBeforeHall + 6),
        `on the main server the wrapper the minute tick calls returns it (${JSON.stringify(onMain)}, Ann +${balanceOf(ann.pubKeyHex) - annBeforeHall})`);
    assert(keptFor(ann.pubKeyHex).filter((n) => kindOf(n) === 'pledges_returned' && n.body.includes('"Hall Kitchen"')).length === 1,
        'and Ann is told, through the node\'s own notices');

    // ── 9. A backer whose account is closed: their share goes to the Commons, and everyone else is paid ─────────────────
    // Review of #2525 (discussion_r4382922607), measured: a 0.01 pledge, then its backer deleting his account, stopped the
    // return for every other backer of the project, for good. Marty, board, 27 Oct 2026: "To the Commons".
    console.log('── 9. A backer who closed their account ──');
    const dan = makeMember('Dan'), eve = makeMember('Eve'), zed = makeMember('Zed');
    for (const m of [dan, eve, zed]) payFromCommons(m.pubKeyHex, 100, 'Beans to pledge', { allowDeficit: true });
    const bench = await makeProject(max, 'Park Bench', 200, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(dan, bench, 40, 'treasury');
    await pledge(eve, bench, 25, 'crowdfund');
    await pledge(zed, bench, 0.01, 'treasury');
    assert(near(escrowOf(bench), 65.01), `the bench's escrow holds the 65.01 pledged (${escrowOf(bench)})`);
    const purged = purgeMemberSelf(zed.pubKeyHex);
    const zedRow = db.prepare('SELECT status FROM members WHERE public_key = ?').get(zed.pubKeyHex) as { status: string } | undefined;
    assert(purged.ok === true && zedRow?.status === 'pruned', `Zed deletes his account (${JSON.stringify(purged)}, ${zedRow?.status})`);
    const benchBefore = {
        dan: balanceOf(dan.pubKeyHex), eve: balanceOf(eve.pubKeyHex), commons: getCommonsBalanceExact(), sum: sumBalances(),
        zedKept: keptFor(zed.pubKeyHex).length, live: watched.live.length, pushes: watched.pushes.length,
    };
    // Its end date 8 days gone: due. Set and returned with nothing awaited between, so this process's own tick can't take it.
    setDeadline(bench, new Date(Date.now() - 8 * DAY).toISOString());
    const closedTick = tick(watched.hooks);
    assert(closedTick.returned === 1 && closedTick.left === 0, `the tick returns the project, and leaves nothing for the operator (${JSON.stringify(closedTick)})`);
    assert(near(balanceOf(dan.pubKeyHex), benchBefore.dan + 40), `Dan gets back exactly his 40 (${balanceOf(dan.pubKeyHex) - benchBefore.dan})`);
    assert(near(balanceOf(eve.pubKeyHex), benchBefore.eve + 25), `Eve gets back exactly her 25 (${balanceOf(eve.pubKeyHex) - benchBefore.eve})`);
    assert(near(getCommonsBalanceExact(), benchBefore.commons + 0.01), `the Commons gains Zed's 0.01 (${getCommonsBalanceExact() - benchBefore.commons})`);
    assert(escrowOf(bench) <= DUST && near(raisedOf(bench), 0), `the bench's escrow is 0 (${escrowOf(bench)}), raised 0 (${raisedOf(bench)})`);
    assert(near(sumBalances(), benchBefore.sum), `the node's total is unchanged (${sumBalances()} vs ${benchBefore.sum})`);
    const closedAudit = runLedgerAudit();
    assert(closedAudit.ok && Math.abs(closedAudit.drift) < 0.0001, `the ledger audit holds with 0 drift (ok ${closedAudit.ok}, drift ${closedAudit.drift})`);
    const benchRows = rowsOutOf(bench);
    const toCommonsRows = benchRows.filter((r) => r.to_pubkey === 'COMMONS_POOL');
    assert(benchRows.length === 3 && toCommonsRows.length === 1 && near(toCommonsRows[0]?.amount ?? 0, 0.01) && !toCommonsRows[0]?.tax_fee
        && benchRows.every((r) => r.project_id === bench) && !benchRows.some((r) => r.to_pubkey === zed.pubKeyHex),
        `one row each to Dan and Eve, and one of 0.01 to the Commons, each naming the project (${JSON.stringify(benchRows.map((r) => [r.to_pubkey.slice(0, 8), r.amount, r.project_id === bench]))})`);
    assert(toCommonsRows[0]?.memo === 'Pledge from a closed account, returned to the Commons',
        `the Commons row says what it is, in plain words ("${toCommonsRows[0]?.memo}")`);
    assert(!!toCommonsRows[0] && !/Zed|Deleted Member/.test(toCommonsRows[0].memo) && !toCommonsRows[0].memo.includes(zed.pubKeyHex.slice(0, 8)),
        'and names nobody');
    assert(near(sumBalances(), benchBefore.sum) && tick(watched.hooks).left === 0, 'a second tick leaves nothing for the operator either');
    const benchPage = await readPage(dan, bench);
    const benchReturnedAt = benchRows.map((r) => r.timestamp).sort().at(-1);
    // 0 raised as both apps read it, in cents (pledgeReturnLine, the funding box): 65.01 less 40, 25 and 0.01 leaves the
    // escrow a float residue far below a cent (5e-15, measured), under the dust the return and the hygiene sweep ignore.
    assert(benchPage?.pledgesReturnedAt === benchReturnedAt && Math.round(Number(benchPage?.currentAmount) * 100) === 0,
        `the page, which both apps read, says the Beans went back (${benchPage?.pledgesReturnedAt} = ${benchReturnedAt}), and 0 raised (${benchPage?.currentAmount})`);
    for (const who of [dan, eve]) {
        const kept = keptFor(who.pubKeyHex).filter((n) => kindOf(n) === 'pledges_returned' && n.body.includes('"Park Bench"'));
        assert(kept.length === 1 && /went back to you/.test(kept[0].body), `${who.callsign} is told their pledge went back, as before ("${kept[0]?.body}")`);
    }
    const maxBench = keptFor(max.pubKeyHex).filter((n) => kindOf(n) === 'pledges_returned' && n.body.includes('"Park Bench"'));
    assert(maxBench.length === 1 && /2 backers/.test(maxBench[0].body) && /65 Beans/.test(maxBench[0].body),
        `the leader's notice counts the 2 backers paid and their 65 Beans ("${maxBench[0]?.body}")`);
    assert(!!maxBench[0] && !/closed|Commons|Zed|Deleted Member/.test(maxBench[0].body), "and says nothing of the closed account");
    assert(keptFor(zed.pubKeyHex).length === benchBefore.zedKept
        && !watched.live.slice(benchBefore.live).some((l) => l.to?.includes(zed.pubKeyHex))
        && !watched.pushes.slice(benchBefore.pushes).some((p) => p.targets.includes(zed.pubKeyHex)),
        'nobody tells the closed account anything: no notice kept, live or pushed');
    assert(!watched.live.slice(benchBefore.live).some((l) => JSON.stringify(l.event ?? {}).match(/closed account|Zed/))
        && !watched.pushes.slice(benchBefore.pushes).some((p) => /closed account|Zed/.test(`${p.title} ${p.body}`)),
        'and nobody is told of it');

    // A wound-up enterprise as a backer: its account closed when it wound up, and what it had went to the Commons. So does its
    // pledge, and the other backer is paid.
    const kit = makeMember('Kit Co-op');
    payFromCommons(kit.pubKeyHex, 20, 'Beans to pledge', { allowDeficit: true });
    const swing = crypto.randomUUID();
    createCrowdfundProject(swing, max.pubKeyHex, 'Creek Swing', 'A swing by the creek', [], 40, new Date(Date.now() + 10 * DAY).toISOString());
    pledgeToProject(crypto.randomUUID(), swing, ann.pubKeyHex, 5, 'Project Pledge');
    pledgeToProject(crypto.randomUUID(), swing, kit.pubKeyHex, 3, 'Project Pledge');
    db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(kit.pubKeyHex);
    const swingBefore = { ann: balanceOf(ann.pubKeyHex), kit: balanceOf(kit.pubKeyHex), commons: getCommonsBalanceExact() };
    setDeadline(swing, new Date(Date.now() - 8 * DAY).toISOString());
    const woundUp = tick(watched.hooks);
    assert(woundUp.returned === 1 && woundUp.left === 0 && escrowOf(swing) <= DUST && near(balanceOf(ann.pubKeyHex), swingBefore.ann + 5)
        && near(balanceOf(kit.pubKeyHex), swingBefore.kit) && near(getCommonsBalanceExact(), swingBefore.commons + 3),
        `a wound-up enterprise's pledge goes to the Commons, and Ann is paid (${JSON.stringify(woundUp)}, Ann +${balanceOf(ann.pubKeyHex) - swingBefore.ann}, Commons +${getCommonsBalanceExact() - swingBefore.commons})`);

    // A backer who still can't be paid here, a live visitor's row: the whole project is left for the operator.
    const vic = makeMember('Vic');
    payFromCommons(vic.pubKeyHex, 50, 'Beans to pledge', { allowDeficit: true });
    const shade = crypto.randomUUID();
    createCrowdfundProject(shade, max.pubKeyHex, 'Shade Sail', 'Shade for the playground', [], 40, new Date(Date.now() + 10 * DAY).toISOString());
    pledgeToProject(crypto.randomUUID(), shade, ann.pubKeyHex, 5, 'Project Pledge');
    pledgeToProject(crypto.randomUUID(), shade, vic.pubKeyHex, 7, 'Project Pledge');
    db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(vic.pubKeyHex);
    const annBeforeShade = balanceOf(ann.pubKeyHex);
    const shadeCounts = { kept: keptFor(ann.pubKeyHex).length, live: watched.live.length, commons: getCommonsBalanceExact() };
    setDeadline(shade, new Date(Date.now() - 8 * DAY).toISOString());
    const visitor = tick(watched.hooks);
    const visitorAgain = tick(watched.hooks);
    assert(visitor.returned === 0 && visitor.left === 1 && visitorAgain.left === 1,
        `the project is left for the operator, tick after tick (${JSON.stringify(visitor)} ${JSON.stringify(visitorAgain)})`);
    assert(near(escrowOf(shade), 12) && near(balanceOf(ann.pubKeyHex), annBeforeShade) && rowsOutOf(shade).length === 0
        && near(getCommonsBalanceExact(), shadeCounts.commons),
        `exactly as it was: Ann is not paid her part alone, and nothing goes to the Commons (escrow ${escrowOf(shade)})`);
    assert(keptFor(ann.pubKeyHex).length === shadeCounts.kept && watched.live.length === shadeCounts.live, 'and nobody is told');
    const finalAudit = runLedgerAudit();
    assert(Math.abs(finalAudit.drift) < 0.0001, `the ledger audit still holds with 0 drift (${finalAudit.drift})`);

    // ── 11. After the return the project is still there: its date moved, then its leader's cancel pays nobody twice ──────
    // The leader's cancel (POST /api/crowdfund/projects/delete, db.ts deleteCrowdfundProject) refunds the pledges its escrow
    // holds. The ones that went back a week after the end date are not held any more: refunding them again would pay the
    // backers twice and leave the escrow below 0.
    console.log('── 11. The date moved after the return, a new pledge, then the leader cancels ──');
    // Review of #2525: first to the return's own UTC day, what a date picker sends for "today". The project takes pledges
    // until that day is over, so its page must not say its Beans went back: that return was for the old end date.
    const returnDay = new Date();
    returnDay.setUTCHours(0, 0, 0, 0);
    const toReturnDay = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: roof, creatorPubkey: lea.pubKeyHex, title: 'Village Hall Roof', description: 'Village Hall Roof, for the valley', goalAmount: 100, deadlineAt: returnDay.toISOString() }, lea);
    assert(toReturnDay.status === 200, `the leader moves the roof's end date to the return's own day (${toReturnDay.status} ${toReturnDay.body?.error ?? ''})`);
    const returnDayPage = await readPage(ann, roof);
    assert(returnDayPage?.pledgesReturnedAt === null, `its page no longer says they went back: the return was for the old end date (${returnDayPage?.pledgesReturnedAt})`);
    const reopened = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: roof, creatorPubkey: lea.pubKeyHex, title: 'Village Hall Roof', description: 'Village Hall Roof, for the valley', goalAmount: 100, deadlineAt: new Date(Date.now() + 10 * DAY).toISOString() }, lea);
    assert(reopened.status === 200, `the leader moves the roof's end date after its pledges went back (${reopened.status} ${reopened.body?.error ?? ''})`);
    assert(keptFor(ann.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved' && n.body.includes('"Village Hall Roof"')).length === 0,
        'nobody is told: nothing of theirs is held');
    const reopenedPage = await readPage(ann, roof);
    assert(reopenedPage?.pledgesReturnedAt === null, `its page no longer says they went back: its end date is ahead again (${reopenedPage?.pledgesReturnedAt})`);
    await pledge(ann, roof, 7, 'treasury');
    assert(near(escrowOf(roof), 7), `it takes a new pledge (escrow ${escrowOf(roof)})`);
    const beforeCancel = { ann: balanceOf(ann.pubKeyHex), ben: balanceOf(ben.pubKeyHex), cal: balanceOf(cal.pubKeyHex), sum: sumBalances() };
    const cancelled = await signedFetch('POST', '/api/crowdfund/projects/delete', { id: roof, creatorPubkey: lea.pubKeyHex }, lea);
    assert(cancelled.status === 200, `the leader cancels it (${cancelled.status} ${cancelled.body?.error ?? ''})`);
    assert(near(balanceOf(ann.pubKeyHex), beforeCancel.ann + 7), `Ann gets back only the 7 still held, not her 10 again (${balanceOf(ann.pubKeyHex) - beforeCancel.ann})`);
    assert(near(balanceOf(ben.pubKeyHex), beforeCancel.ben) && near(balanceOf(cal.pubKeyHex), beforeCancel.cal),
        `Ben and Cal, paid back a week after the end date, are not paid again (Ben ${balanceOf(ben.pubKeyHex) - beforeCancel.ben}, Cal ${balanceOf(cal.pubKeyHex) - beforeCancel.cal})`);
    assert(near(escrowOf(roof), 0) && near(sumBalances(), beforeCancel.sum), `its escrow ends at 0, not below (${escrowOf(roof)}), and the total is unchanged`);
    const cancelAudit = runLedgerAudit();
    assert(cancelAudit.ok && Math.abs(cancelAudit.drift) < 0.0001, `the ledger audit holds with 0 drift (ok ${cancelAudit.ok}, drift ${cancelAudit.drift})`);

    // ── 12. The leader moves an end date that is over again and again: each backer is told once a day ──────────────────
    // Review of #2525: the update route takes a date back to 36 hours ago (routes/project-deadline.ts, "today anywhere"),
    // and one more than a day old is already over. Moved from one date over to another, request after request, the backers
    // were told every time (6 moves, 6 notices and 6 pushes each), and each copy kept pushed one of their other notices out
    // (kept-notices.ts KEPT_NOTICES.perMember). Refusing a date already over would not stop it: one a moment from over is
    // taken, and is over a moment later. The notice names no date, so another the same day only repeats it.
    console.log('── 12. The end date moved again and again ──');
    const racks = await makeProject(lea, 'Bike Racks', 60, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(ann, racks, 6, 'treasury');
    await pledge(ben, racks, 4, 'crowdfund');
    // Its end date 5 days gone: in the week. Not due at this process's real time, so its own tick leaves it alone.
    setDeadline(racks, new Date(Date.now() - 5 * DAY).toISOString());
    const toldOfRacks = (who: Id) => keptFor(who.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved' && enterpriseOf(n) === racks);
    const moveRacks = (deadlineAt: string, title = 'Bike Racks') => signedFetch('POST', '/api/crowdfund/projects/update',
        { id: racks, creatorPubkey: lea.pubKeyHex, title, description: 'Bike Racks, for the valley', goalAmount: 60, deadlineAt }, lea);
    const moves: number[] = [];
    // Each time to another date already over, a second apart, and renamed every other time: the notice's words change too.
    for (let i = 0; i < 6; i++) moves.push((await moveRacks(new Date(Date.now() - 30 * HOUR - i * 1000).toISOString(), i % 2 ? 'Bike Racks' : 'Bike Racks!')).status);
    assert(moves.every((s) => s === 200), `the leader moves the date six times, each time to another date already over (${moves.join(' ')})`);
    for (const who of [ann, ben]) {
        const kept = toldOfRacks(who);
        assert(kept.length === 1 && kept[0].body.includes('"Bike Racks') && /has moved the date/.test(kept[0].body),
            `${who.callsign} is told once, not six times (${kept.length}: "${kept[0]?.body}")`);
    }
    const nearlyOver = new Date(Date.now() - DAY + 3000).toISOString();
    const nearly = await moveRacks(nearlyOver);
    while (!isPastDeadline(nearlyOver, Date.now())) await new Promise((r) => setTimeout(r, 250));
    const fromNearly = await moveRacks(new Date(Date.now() - 30 * HOUR).toISOString());
    assert(nearly.status === 200 && fromNearly.status === 200,
        `a date a moment from over is taken, and moved again once it is over (${nearly.status} ${fromNearly.status} ${nearly.body?.error ?? ''}${fromNearly.body?.error ?? ''})`);
    assert([ann, ben].every((who) => toldOfRacks(who).length === 1), `and nobody is told again (${toldOfRacks(ann).length}, ${toldOfRacks(ben).length})`);
    // Taking off an end date that is over says something else: no date, so nothing goes back on its own. That is told, the
    // same day.
    const takenOff = await moveRacks('');
    assert(takenOff.status === 200 && [ann, ben].every((who) => toldOfRacks(who).length === 2 && /taken the end date off/.test(toldOfRacks(who)[1]?.body ?? '')),
        `taking the end date off is told, once (${takenOff.status}: ${toldOfRacks(ann).length}, "${toldOfRacks(ann)[1]?.body}")`);
    // A date again (none was over, so nobody is told), and off again: not told twice in a day either.
    const dateAgain = await moveRacks(new Date(Date.now() - 30 * HOUR).toISOString());
    const offAgain = await moveRacks('');
    assert(dateAgain.status === 200 && offAgain.status === 200 && [ann, ben].every((who) => toldOfRacks(who).length === 2),
        `a date again and off again tells nobody again (${dateAgain.status} ${offAgain.status}: ${toldOfRacks(ann).length}, ${toldOfRacks(ben).length})`);
    // A day on, a move tells them again: once a day, not once.
    const dayOn = Date.now() + DAY + MINUTE;
    const movesDayOn = watchedHooks();
    setDeadline(racks, new Date(dayOn + 10 * DAY).toISOString());
    const toldDayOn = unfunded?.noticeEndDateMoved(movesDayOn.hooks, racks, new Date(dayOn - 3 * DAY).toISOString(), lea.pubKeyHex, dayOn) ?? -1;
    assert(toldDayOn === 2 && [ann, ben].every((who) => toldOfRacks(who).length === 3 && /has moved the date/.test(toldOfRacks(who)[2]?.body ?? '')),
        `a day on, a move tells both backers again (${toldDayOn}: ${toldOfRacks(ann).length}, ${toldOfRacks(ben).length})`);
    const pushDayOn = movesDayOn.pushes.filter((p) => p.data?.kind === 'project_end_date_moved');
    assert(pushDayOn.length === 1 && [...pushDayOn[0].targets].sort().join() === [ann, ben].map((m) => m.pubKeyHex).sort().join()
        && pushDayOn[0].kind === 'community.notice' && pushDayOn[0].category === 'escrow',
        `with one push to the two of them (${pushDayOn.length}, ${pushDayOn[0]?.targets.length}, ${pushDayOn[0]?.kind}, ${pushDayOn[0]?.category})`);
    assert(near(escrowOf(racks), 10) && rowsOutOf(racks).length === 0, `and nothing went back meanwhile (escrow ${escrowOf(racks)})`);

    // ── 13. Pledges not exact in binary: once they went back the raised figure is 0, not what the floats leave ───────────
    // Review of #2525: SQLite adds a project's pledges up in the order they came, the return adds them up backer by backer,
    // and with amounts not exact in binary the two sums differ in their last bits. Lowering the raised figure by one sum left
    // a residue of the other where everything went back, and the project's read (db.ts rowToProjectRow, its pledge rows less
    // the return's) left one of its own. The leader's update read either as pledges received and refused a new goal, and the
    // page read the first as Beans still held, so both apps said they were due back. Every amount the parts above use is
    // exact in binary, so none of them could see it.
    console.log('── 13. Pledges not exact in binary ──');
    // A leader of its own: Lea has started three enterprises today, as many as the node lets anyone start in 24 hours.
    const ola = makeMember('Ola');
    const seeds = await makeProject(ola, 'Seed Swap', 50, new Date(Date.now() + 10 * DAY).toISOString());
    // Interleaved, so the raised figure adds them up in another order than the return does.
    await pledge(ann, seeds, 0.1, 'treasury');
    await pledge(ben, seeds, 0.3, 'crowdfund');
    await pledge(ann, seeds, 0.2, 'crowdfund');
    await pledge(ben, seeds, 0.6, 'treasury');
    await pledge(ann, seeds, 0.7, 'treasury');
    const seedsBefore = { ann: balanceOf(ann.pubKeyHex), ben: balanceOf(ben.pubKeyHex) };
    // Its end date 8 days gone: due. Set and returned with nothing awaited between, so this process's own tick can't take it.
    setDeadline(seeds, new Date(Date.now() - 8 * DAY).toISOString());
    const seedsReturn = tick(watched.hooks);
    assert(seedsReturn.returned === 1 && escrowOf(seeds) <= DUST
        && near(balanceOf(ann.pubKeyHex), seedsBefore.ann + 1) && near(balanceOf(ben.pubKeyHex), seedsBefore.ben + 0.9),
        `the pledges go back, Ann her 0.1 + 0.2 + 0.7 and Ben his 0.3 + 0.6 (${JSON.stringify(seedsReturn)}, Ann +${balanceOf(ann.pubKeyHex) - seedsBefore.ann}, Ben +${balanceOf(ben.pubKeyHex) - seedsBefore.ben}, escrow ${escrowOf(seeds)})`);
    assert(raisedOf(seeds) === 0, `the projects row says 0 raised, not a residue (${raisedOf(seeds)})`);
    const seedsPage = await readPage(ann, seeds);
    assert(seedsPage?.currentAmount === 0, `the page says 0 raised (${seedsPage?.currentAmount})`);
    assert(getCrowdfundProject(seeds)?.current_amount === 0, `and so does the project's read (${getCrowdfundProject(seeds)?.current_amount})`);
    // Its leader takes it up again: a later end date, then a lower goal. Nothing of anyone's is held, so the goal can change.
    const seedsNewDeadline = new Date(Date.now() + 10 * DAY).toISOString();
    const updateSeeds = (goalAmount: number) => signedFetch('POST', '/api/crowdfund/projects/update',
        { id: seeds, creatorPubkey: ola.pubKeyHex, title: 'Seed Swap', description: 'Seed Swap, for the valley', goalAmount, deadlineAt: seedsNewDeadline }, ola);
    const seedsMoved = await updateSeeds(50);
    assert(seedsMoved.status === 200, `its leader moves its end date after the return (${seedsMoved.status} ${seedsMoved.body?.error ?? ''})`);
    const seedsLowered = await updateSeeds(20);
    assert(seedsLowered.status === 200 && seedsLowered.body?.project?.goal_amount === 20 && seedsLowered.body?.project?.current_amount === 0,
        `and lowers its goal to 20 (${seedsLowered.status} ${seedsLowered.body?.error ?? ''}: goal ${seedsLowered.body?.project?.goal_amount}, raised ${seedsLowered.body?.project?.current_amount})`);
    // Nobody pledges to it again, and its new end date ends too: nothing goes back, and the page has nothing held to say is due.
    // Read only: a tick that far on would return the other parts' projects as well.
    const seedsLater = unfunded?.findUnfundedProjectsDue(Date.parse(seedsNewDeadline) + 12 * DAY).filter((p) => p.projectId === seeds);
    const seedsPageLater = await readPage(ann, seeds);
    assert(seedsLater?.length === 0 && escrowOf(seeds) <= DUST && rowsOutOf(seeds).length === 2,
        `12 days after the new end date the return finds nothing of it to give back (${JSON.stringify(seedsLater)}, escrow ${escrowOf(seeds)}, ${rowsOutOf(seeds).length} rows out)`);
    assert(seedsPageLater?.currentAmount === 0 && seedsPageLater?.pledgesReturnedAt === null,
        `and the page says 0 raised and nothing went back for that date, so neither app says Beans are due back (${seedsPageLater?.currentAmount}, ${seedsPageLater?.pledgesReturnedAt})`);

    // ── 14. A new lead moves the end date: it reaches the row the return reads ─────────────────────────────────────────
    // Review of #2525: the update wrote the projects row only where its creator_pubkey matched, and that column holds the
    // project's maker. Once the lead had changed (the leader closed their account, a keeper took over) the new lead's move
    // was answered 200, but the return, the end-date notice and the pledge gate still read the old date.
    console.log('── 14. A new lead moves the end date ──');
    const uma = makeMember('Uma');
    const kim = makeMember('Kim');
    const gate = await makeProject(uma, 'Garden Gate', 60, new Date(Date.now() + 10 * DAY).toISOString());
    await pledge(ann, gate, 4, 'treasury');
    // The lead passes to Kim, as a handover leaves it: the operators row moves, the projects row still names its maker, and
    // Kim's operator switch is on, as every way of making someone a keeper leaves it (adminAssignTreasuryOperator).
    db.prepare("UPDATE treasury_operators SET member_pubkey = ? WHERE treasury_pubkey = ? AND role = 'lead'").run(kim.pubKeyHex, gate);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(kim.pubKeyHex);
    assert(getCrowdfundProject(gate)?.creator_pubkey === kim.pubKeyHex, `Kim is the project's lead now (${getCrowdfundProject(gate)?.creator_pubkey})`);
    // Its end date 3 days gone, in the week: Kim moves it 10 days on.
    setDeadline(gate, new Date(Date.now() - 3 * DAY).toISOString());
    const gateNewDeadline = new Date(Date.now() + 10 * DAY).toISOString();
    const gateMoved = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: gate, creatorPubkey: kim.pubKeyHex, title: 'Garden Gate', description: 'Garden Gate, for the valley', goalAmount: 60, deadlineAt: gateNewDeadline }, kim);
    assert(gateMoved.status === 200, `Kim, the lead, moves the end date (${gateMoved.status} ${gateMoved.body?.error ?? ''})`);
    const gateRow = db.prepare('SELECT deadline_at FROM projects WHERE id = ?').get(gate) as { deadline_at: string };
    assert(gateRow?.deadline_at === gateNewDeadline, `the projects row the return reads has the new end date (${gateRow?.deadline_at})`);
    const gateKept = keptFor(ann.pubKeyHex).filter((n) => kindOf(n) === 'project_end_date_moved' && n.body.includes('"Garden Gate"'));
    assert(gateKept.length === 1, `Ann, a backer, is told the end date moved (${gateKept.length})`);
    await pledge(ben, gate, 2, 'crowdfund');
    assert(near(escrowOf(gate), 6), `and the project takes pledges again (escrow ${escrowOf(gate)})`);
    // Uma, its maker but no longer its lead, can't change it.
    const umaMove = await signedFetch('POST', '/api/crowdfund/projects/update',
        { id: gate, creatorPubkey: uma.pubKeyHex, title: 'Garden Gate', description: 'Garden Gate, for the valley', goalAmount: 60, deadlineAt: new Date(Date.now() + 30 * DAY).toISOString() }, uma);
    const gateAfter = db.prepare('SELECT deadline_at FROM projects WHERE id = ?').get(gate) as { deadline_at: string };
    assert(umaMove.status !== 200 && gateAfter?.deadline_at === gateNewDeadline,
        `Uma, who made it but no longer leads it, can't move it (${umaMove.status}; end date ${gateAfter?.deadline_at})`);
    // Nor cancel it: the cancel asked the projects row's creator_pubkey, its maker, so Uma could refund every backer and
    // delete it, and Kim, its lead, could not (db.ts leadsProject). Cal, who neither made nor leads it, can't either.
    const gateBefore = { ann: balanceOf(ann.pubKeyHex), ben: balanceOf(ben.pubKeyHex), uma: balanceOf(uma.pubKeyHex), sum: sumBalances() };
    const umaCancel = await signedFetch('POST', '/api/crowdfund/projects/delete', { id: gate, creatorPubkey: uma.pubKeyHex }, uma);
    assert(umaCancel.status !== 200 && near(escrowOf(gate), 6) && rowsOutOf(gate).length === 0,
        `Uma can't cancel it: nothing moves (${umaCancel.status} ${umaCancel.body?.error ?? ''}; escrow ${escrowOf(gate)})`);
    const calCancel = await signedFetch('POST', '/api/crowdfund/projects/delete', { id: gate, creatorPubkey: cal.pubKeyHex }, cal);
    assert(calCancel.status !== 200 && near(escrowOf(gate), 6), `nor can Cal (${calCancel.status} ${calCancel.body?.error ?? ''})`);
    // Nor Kim while an admin has switched Kim's operator access off: such a keeper acts for no enterprise, and the signed
    // request still reaches the route (db.ts mayCancelProject, review of #2554).
    stateEngine.adminSetOperator(kim.pubKeyHex, false);
    const kimOffCancel = await signedFetch('POST', '/api/crowdfund/projects/delete', { id: gate, creatorPubkey: kim.pubKeyHex }, kim);
    assert(kimOffCancel.status !== 200 && near(escrowOf(gate), 6) && rowsOutOf(gate).length === 0,
        `nor Kim, its lead, with operator access switched off: nothing moves (${kimOffCancel.status} ${kimOffCancel.body?.error ?? ''}; escrow ${escrowOf(gate)})`);
    stateEngine.adminSetOperator(kim.pubKeyHex, true);
    const kimCancel = await signedFetch('POST', '/api/crowdfund/projects/delete', { id: gate, creatorPubkey: kim.pubKeyHex }, kim);
    assert(kimCancel.status === 200, `Kim, its lead, cancels it (${kimCancel.status} ${kimCancel.body?.error ?? ''})`);
    assert(near(balanceOf(ann.pubKeyHex), gateBefore.ann + 4) && near(balanceOf(ben.pubKeyHex), gateBefore.ben + 2) && near(balanceOf(uma.pubKeyHex), gateBefore.uma),
        `Ann gets back her 4 and Ben his 2, once each; Uma's balance doesn't move (${balanceOf(ann.pubKeyHex) - gateBefore.ann}, ${balanceOf(ben.pubKeyHex) - gateBefore.ben})`);
    assert(near(escrowOf(gate), 0) && near(sumBalances(), gateBefore.sum), `its escrow ends at 0 (${escrowOf(gate)}) and the total is unchanged`);
    const gateAudit = runLedgerAudit();
    assert(gateAudit.ok && Math.abs(gateAudit.drift) < 0.0001, `the ledger audit holds with 0 drift (ok ${gateAudit.ok}, drift ${gateAudit.drift})`);

    // ── 10. A node killed in the middle of a return ───────────────────────────────────────────────────────────────────
    console.log('── 10. Killed in the middle of a return, then booted again ──');
    const dir = path.join(process.env.BEANPOOL_DATA_DIR!, 'killed-node');
    fs.mkdirSync(dir, { recursive: true });
    const crash = runPhase(dir, 'crash-mid-return');
    const w = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')) as World; } catch { return null; } })();
    assert(crash.signal === 'SIGKILL' && crash.saw?.module === true && !crash.saw?.finished,
        `the node is killed after the return's second payment (signal ${crash.signal}, status ${crash.status}, saw ${JSON.stringify(crash.saw)})`);
    const before: Seen | undefined = crash.saw?.before;
    assert(!!w && !!before && near(before.escrow, 45) && before.outRows === 0, `before the return its escrow held the 45 pledged (${JSON.stringify(before)})`);
    if (crash.signal !== 'SIGKILL') {
        console.error(crash.output.slice(-3000));
        assert(false, 'the rest of part 10 needs a node killed in the middle of its return');
        console.log(`\n${passed}/${run} assertions passed`);
        process.exit(1);
    }

    const boot = runPhase(dir, 'boot-and-tick');
    if (boot.status !== 0) console.error(boot.output.slice(-3000));
    const s = boot.saw;
    assert(boot.status === 0 && !!s, `it boots again on the same data dir (status ${boot.status})`);
    const sameAs = (a: Seen | undefined, b: Seen | undefined) => !!a && !!b && (['ann', 'ben', 'cal', 'lea', 'escrow', 'sum', 'outRows', 'notices', 'raised'] as const).every((k) => near(a[k], b[k]));
    assert(sameAs(s?.atBoot, before), `nothing of the killed return was kept: no backer paid, the escrow whole, no row, no notice (${JSON.stringify(s?.atBoot)})`);
    if (w && before) {
        const after: Seen | undefined = s?.afterTick;
        assert(!!after && near(after.ann, before.ann + 10) && near(after.ben, before.ben + 15) && near(after.cal, before.cal + 20),
            `the main server's own minute tick returns every pledge exactly once (${JSON.stringify(after)})`);
        assert(!!after && after.escrow <= DUST && near(after.sum, before.sum) && after.outRows === 3 && after.notices === 4 && near(after.raised, 0),
            'the escrow empty, the total unchanged, one row per backer, a notice for each backer and the leader');
        assert(s?.audit?.ok === true && Math.abs(s?.audit?.drift ?? 1) < 0.0001, `the ledger audit holds with 0 drift (${JSON.stringify(s?.audit)})`);
        assert(s?.again?.returned === 0 && sameAs(s?.afterAgain, after), `a second tick in that process moves nothing (${JSON.stringify(s?.again)})`);
        const again = runPhase(dir, 'boot-again');
        if (again.status !== 0) console.error(again.output.slice(-3000));
        assert(again.status === 0 && again.saw?.again?.returned === 0 && sameAs(again.saw?.after, after) && sameAs(again.saw?.atBoot, after),
            `a third boot and its tick move nothing (${JSON.stringify(again.saw?.again)})`);
        assert(again.saw?.audit?.ok === true, 'and its audit holds');
    }

    console.log(`\n${passed}/${run} assertions passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error('Unhandled failure:', e);
    process.exit(1);
});
