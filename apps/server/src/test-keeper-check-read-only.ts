/**
 * A keeper request's "can back their pledge" check reads, it never writes (#1638 confirmation review, queue item 40).
 *
 * The lead keeper's request rows (the requests list, the enterprise read) and Approve share one predicate,
 * applicantCanBackPledge. Its own-debt part used to write the pledge rows in a savepoint and roll them back, which made two
 * GETs write transactions: a write error failed the read (list 400, enterprise read 500) and a write lock held by another
 * process could keep the event loop waiting on a GET for the busy timeout. It now reads the floor binding would leave.
 *
 *   1. an equivalence table, in-process: for each state (clean, frozen, no room, own debt by various amounts and exactly at
 *      the edge, granted credit, the dial off, an exception or a frozen known floor, a pledge in another enterprise,
 *      fractional known pledges at the cent edge) the row's canBackPledge is exactly whether Approve goes through
 *   1b. the same at the cent edge for random cent-valued known pledges (2–4 written, one asked): SQLite's SUM over REAL is
 *      compensated, so the row must sum the ask in SQL as Approve's re-check does (#1640 review F1)
 *   2. over real HTTPS, through the real middleware: with a TEMP trigger refusing any write to enterprise_pledges, the
 *      requests list and the enterprise read answer 200 with the same answers
 *   3. with a second connection holding the write lock, both GETs answer 200 at once (no busy wait)
 *   4. no GET commits anything (data_version, read from a second connection, unchanged)
 *   5. a standby answers the same GETs with the same rows
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'KeeperReadOnly123!';

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createPost, createTreasury, getAvailableBacking, transfer,
    requestToJoinEnterprise, getKeeperRequests, approveKeeperRequest,
} from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { db } from './db/db.js';
import { memberKnownGrant, setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; ms: number };
const show = (r: Res) => `${r.status} in ${r.ms.toFixed(0)} ms ${JSON.stringify(r.body)?.slice(0, 160)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

/** The member buys something: the beans go into a purchase's escrow. */
function spend(from: Id, beans: number): boolean {
    return !!transfer(from.pk, `escrow_${crypto.randomUUID()}`, beans, 'a purchase', 'escrow', true);
}

function setDial(on: boolean): void {
    if (on) db.prepare("INSERT OR REPLACE INTO node_config (key, value) VALUES ('confirmation', 'on')").run();
    else db.prepare("DELETE FROM node_config WHERE key = 'confirmation'").run();
}

async function call(method: string, id: Id | null, path: string): Promise<Res> {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { method, headers });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json, ms: performance.now() - t0 };
}

type Case = {
    name: string;
    pledge: number;
    /** Before the request: the state the applicant asks from. */
    before?: (a: Id, grant: number) => void;
    /** After the request (a freeze or the dial off would refuse the request itself). */
    after?: (a: Id, grant: number) => void;
    expect: boolean;
};

async function main(): Promise<void> {
    console.log('A keeper request\'s standing check reads, never writes\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    ownerSessionHeaders();
    setDial(true);
    const lead = makeMember('Lena');

    // ── 1. equivalence: the row's answer is exactly whether Approve goes through ─────────────────────
    console.log('── 1. the row says yes exactly when Approve goes through ──');
    let n = 0;
    const freshApplicant = (): { a: Id; ent: string; grant: number } => {
        n++;
        const a = makeMember(`App${n}`);
        createPost('offer', 'produce', `App${n} mends nets`, 'Nets', 20, 'fixed', a.pk);
        confirm(a, lead);
        const ent = createTreasury(`Loft ${n} ${lead.pk.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
        return { a, ent, grant: memberKnownGrant(db, a.pk) };
    };
    /** A known pledge in another enterprise, bound through the same request + Approve. */
    const keepElsewhere = (a: Id, amount: number): void => {
        const other = createTreasury(`Other ${a.name} ${crypto.randomBytes(2).toString('hex')}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
        const r = requestToJoinEnterprise(other, a.pk, amount);
        approveKeeperRequest(r.id, lead.pk);
    };
    const half = (g: number) => Math.floor(g / 2);
    const cases: Case[] = [
        { name: 'clean, a small pledge', pledge: 5, expect: true },
        { name: 'clean, no pledge', pledge: 0, expect: true },
        { name: 'clean, the whole known room', pledge: 500, expect: true },
        { name: 'frozen after asking', pledge: 5, after: a => db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(a.pk), expect: false },
        { name: 'frozen after asking, no pledge', pledge: 0, after: a => db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(a.pk), expect: false },
        { name: 'no room: known floor lowered by an exception', pledge: 100,
          after: a => db.prepare('INSERT OR REPLACE INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by) VALUES (?, 50, 0, ?)').run(a.pk, lead.pk), expect: false },
        { name: 'no room: known floor frozen by an exception', pledge: 100,
          after: a => db.prepare('INSERT OR REPLACE INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by) VALUES (?, NULL, 1, ?)').run(a.pk, lead.pk), expect: false },
        { name: 'no room: the dial turned off', pledge: 100, after: () => setDial(false), expect: false },
        { name: 'own debt well inside the line', pledge: 400, before: a => { spend(a, 100); }, expect: true },
        { name: 'own debt one bean short of the edge', pledge: 400, before: (a, g) => { spend(a, g - 400 - 1); }, expect: true },
        { name: 'own debt exactly at the edge', pledge: 400, before: (a, g) => { spend(a, g - 400); }, expect: true },
        { name: 'own debt one bean past the edge', pledge: 400, before: (a, g) => { spend(a, g - 400 + 1); }, expect: false },
        { name: 'own debt using the whole line', pledge: 400, before: (a, g) => { spend(a, g); }, expect: false },
        { name: 'own debt 700, pledge 400 (#1638 B1)', pledge: 400, before: a => { spend(a, 700); }, expect: false },
        { name: 'own debt and frozen', pledge: 400, before: (a, g) => { spend(a, g - 100); },
          after: a => db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(a.pk), expect: false },
        { name: 'granted credit 100, debt at the edge', pledge: 300,
          before: (a, g) => { db.prepare('UPDATE members SET earned_credit = 100 WHERE public_key = ?').run(a.pk); spend(a, g - 300); }, expect: true },
        { name: 'granted credit 100, debt past the edge (100 deeper)', pledge: 300,
          before: (a, g) => { db.prepare('UPDATE members SET earned_credit = 100 WHERE public_key = ?').run(a.pk); spend(a, g - 300 + 100 + 1); }, expect: false },
        { name: 'a known pledge of 200 elsewhere, at the edge', pledge: 250,
          before: (a, g) => { keepElsewhere(a, 200); spend(a, g - 200 - 250); }, expect: true },
        { name: 'a known pledge of 200 elsewhere, past the edge', pledge: 250,
          before: (a, g) => { keepElsewhere(a, 200); spend(a, g - 200 - 250 + 1); }, expect: false },
        { name: 'a known pledge made elsewhere after asking leaves no room', pledge: 400,
          after: a => { keepElsewhere(a, 200); }, expect: false },
        { name: 'own debt then the dial off', pledge: 400, before: (a, g) => { spend(a, g - 400); }, after: () => setDial(false), expect: false },
        // #1640 review F1: SUM(193.86, 113.78) + 1.03 in JS is not the double SQLite's compensated SUM gives with the 1.03 row
        // written. Approve's re-check reads the SQL sum (floor -691.3299999999999), so it refuses; the row must say so too.
        { name: 'known pledges 193.86 + 113.78 elsewhere, ask 1.03, debt at the cent edge (#1640 F1)', pledge: 1.03,
          before: (a, g) => { keepElsewhere(a, 193.86); keepElsewhere(a, 113.78); spend(a, (g * 100 - 19386 - 11378 - 103) / 100); }, expect: false },
    ];
    for (const c of cases) {
        setDial(true);
        const { a, ent, grant } = freshApplicant();
        if (c.name.includes('whole known room')) c.pledge = half(grant);
        c.before?.(a, grant);
        const req = requestToJoinEnterprise(ent, a.pk, c.pledge);
        c.after?.(a, grant);
        const row = getKeeperRequests(ent, 'pending').find(r => r.id === req.id);
        let approved = false, refusal = '';
        try { approved = approveKeeperRequest(req.id, lead.pk).applied === true; } catch (e: any) { refusal = String(e?.message ?? e); }
        assert(row?.canBackPledge === approved && approved === c.expect,
            `${c.name} (grant ${grant}, pledge ${c.pledge}): row ${row?.canBackPledge}, Approve ${approved ? 'went through' : `refused: ${refusal}`}`);
    }
    setDial(true);

    // ── 1b. random cent-valued known pledges at the cent edge ─────────────────────────────────────
    console.log('── 1b. random fractional known pledges at the cent edge: the row agrees with Approve ──');
    const SEED = Number(process.env.KEEPER_CHECK_SEED ?? 1640);
    const RUNS = Number(process.env.KEEPER_CHECK_RUNS ?? 300);
    let rnd = SEED >>> 0;
    const random = (): number => { // mulberry32: the same sets on every run for a seed
        rnd = (rnd + 0x6D2B79F5) >>> 0;
        let t = rnd;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const cents = (max: number) => 1 + Math.floor(random() * max);
    const elsewhere = createTreasury(`Elsewhere ${lead.pk.slice(0, 4)}`, AVATAR, 0, { leadKeeperPubkey: lead.pk }).publicKey;
    const writeKnown = db.prepare(`INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at, released_at)
                                   VALUES (?, ?, ?, ?, ?, NULL)`);
    let agree = 0, yes = 0, no = 0;
    const disagreements: string[] = [];
    for (let i = 0; i < RUNS; i++) {
        const { a, ent, grant } = freshApplicant();
        // Up to 4 written known pledges of at most 100.00 and an ask of at most 100.00: inside half of a grant of 1,000.
        const written = Array.from({ length: 2 + Math.floor(random() * 3) }, () => cents(10_000));
        const ask = cents(10_000);
        for (const c of written) writeKnown.run(`known:${crypto.randomUUID()}`, a.pk, elsewhere, c / 100, new Date().toISOString());
        const edge = grant * 100 - written.reduce((x, y) => x + y, 0) - ask;
        spend(a, edge / 100);
        const req = requestToJoinEnterprise(ent, a.pk, ask / 100);
        const row = getKeeperRequests(ent, 'pending').find(r => r.id === req.id)?.canBackPledge;
        let approved = false;
        try { approved = approveKeeperRequest(req.id, lead.pk).applied === true; } catch { /* a refusal */ }
        if (row === approved) agree++;
        else disagreements.push(`[${written.map(c => c / 100).join(', ')}] + ${ask / 100}, debt ${edge / 100}: row ${row}, Approve ${approved}`);
        if (approved) yes++; else no++;
    }
    assert(agree === RUNS, `seed ${SEED}: the row agrees with Approve in ${agree}/${RUNS} random sets at the cent edge `
        + `(Approve ${yes} yes, ${no} no)${disagreements.length ? `; first: ${disagreements.slice(0, 3).join('; ')}` : ''}`);

    // ── 2–5. over HTTPS: the GETs never write ─────────────────────────────────────────────────────
    const { a: bea, ent: solo, grant: beaGrant } = freshApplicant();
    const { a: cal } = freshApplicant();
    requestToJoinEnterprise(solo, bea.pk, 400);
    requestToJoinEnterprise(solo, cal.pk, 5);
    spend(bea, beaGrant - 400 + 1);
    assert(getAvailableBacking(bea.pk) >= 400, 'precondition: Bea has room for 400 on paper, her own debt is past the edge');
    const list = () => call('GET', lead, `/api/enterprise/${solo}/keepers/requests?status=pending`);
    const detail = () => call('GET', lead, `/api/enterprise/${solo}`);
    const answers = (r: Res) => Object.fromEntries([...(r.body?.requests ?? []), ...(r.body?.keeperRequests ?? [])]
        .map((row: any) => [row.memberPubkey, row.canBackPledge]));
    const expected = { [bea.pk]: false, [cal.pk]: true };
    const same = (r: Res) => JSON.stringify(answers(r)) === JSON.stringify(expected)
        || (answers(r)[bea.pk] === false && answers(r)[cal.pk] === true && Object.keys(answers(r)).length === 2);

    const baseList = await list();
    const baseDetail = await detail();
    assert(baseList.status === 200 && same(baseList), `the lead keeper's list: Bea no, Cal yes (${show(baseList)})`);
    assert(baseDetail.status === 200 && same(baseDetail), `the enterprise read: the same (${show(baseDetail)})`);

    console.log('── 2. a write to enterprise_pledges fails: the GETs still answer ──');
    db.exec("CREATE TEMP TRIGGER keeper_check_no_write BEFORE INSERT ON enterprise_pledges BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
    const trigList = await list();
    const trigDetail = await detail();
    assert(trigList.status === 200 && same(trigList), `the list answers 200 with the same answers (${show(trigList)})`);
    assert(trigDetail.status === 200 && same(trigDetail), `the enterprise read answers 200 with the same answers (${show(trigDetail)})`);
    db.exec('DROP TRIGGER keeper_check_no_write');

    console.log('── 3. another connection holds the write lock: no busy wait on a GET ──');
    const other = new Database(db.name);
    const before = Number(other.pragma('data_version', { simple: true }));
    other.exec('BEGIN IMMEDIATE');
    const lockList = await list();
    const lockDetail = await detail();
    other.exec('ROLLBACK');
    assert(lockList.status === 200 && same(lockList) && lockList.ms < 1500, `the list answers 200 at once (${show(lockList)})`);
    assert(lockDetail.status === 200 && same(lockDetail) && lockDetail.ms < 1500, `the enterprise read answers 200 at once (${show(lockDetail)})`);

    console.log('── 4. no GET commits anything ──');
    for (let i = 0; i < 20; i++) { await list(); await detail(); }
    const after = Number(other.pragma('data_version', { simple: true }));
    assert(after === before, `data_version from a second connection is unchanged over 42 GETs (${before} → ${after})`);
    other.close();

    console.log('── 5. a standby answers the same ──');
    setNodeRole('backup');
    const standbyList = await list();
    const standbyDetail = await detail();
    setNodeRole('primary');
    assert(standbyList.status === 200 && same(standbyList), `a standby's list: the same answers (${show(standbyList)})`);
    assert(standbyDetail.status === 200 && same(standbyDetail), `a standby's enterprise read: the same answers (${show(standbyDetail)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch(err => { console.error(err); process.exit(1); });
