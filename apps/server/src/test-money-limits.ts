/**
 * W-money: what one account can do with Beans in a day, and an enterprise's own allowances on the main server (design
 * scratch/global-node/DESIGN-replica-flood-bounds-opus.md §7 row 5; every number in config/writer-limits.ts,
 * MONEY_LIMITS and WRITER_LIMITS). Over REAL HTTPS through the real signature middleware and gateway: an enterprise
 * rides the PATH (/api/treasury/:id/…), where the keeper acts for it.
 *
 *  1. Payments, a member's own: a send, a one-step buy, asking to buy an offer, approving help on their own need and a
 *     crowdfund pledge all count; the 101st is 429 money_payments_day in plain words, with Retry-After, and moves
 *     nothing (no balance, account row, transaction or trade: the node still sums to what it did); an act that pays
 *     nothing (approving a request on their own offer) still goes; another key is unaffected; receiving (a send, and a
 *     sale's escrow released) still works past every limit.
 *  2. New people paid: 30 a day; paying one of them again, someone paid three days ago and someone bought from before
 *     is not new; the 31st new person is 429 money_new_recipients_day, and a key with no row gets no row; buying from a
 *     new seller counts too.
 *  3. Marketplace requests: asking, accepting and approving, 100 a day; the 101st is 429 money_requests_day and makes
 *     no trade row.
 *  4. Pledges: backing an enterprise, releasing it (every alias) and a crowdfund pledge, 20 a day; the 21st is 429
 *     money_pledges_day; another member is unaffected.
 *  5. An enterprise: its payments (sweeps to the Commons) count against it, 1,000 a day, and never against the keeper
 *     who signs, nor the keeper's against it; 1,000 approvals of requests on its listings; 300 new people paid (helpers
 *     on its need), and paying one again is not new.
 *  6. Posts (W-main): a keeper's own stop at 100; what they put up for an enterprise counts against the enterprise, up
 *     to 1,000, then 429 enterprise_posts_per_day; their own still stop at 100.
 *  7. The day budget (W-main): writes whose path names an enterprise the signer keeps spend the enterprise's 50,000,
 *     not the signer's 5,000; a made-up, foreign or wound-up enterprise in the path counts against the signer; an
 *     enterprise past its budget is 429 enterprise_day_budget while another enterprise is unaffected.
 *  8. A restart keeps the count: a node killed (SIGKILL) after 60 payments and booted again on the same data takes
 *     40 more and refuses the 101st.
 *  9. Federation purchases count (settlement ON, in a child node with its own libp2p transport and a peer that isn't
 *     there): a purchase escrows the buyer's Beans before it asks, so it is a payment; the next send past 100 is 429,
 *     and a purchase past it is 429 before anything moves. A commission is the link enterprise's payment: 999 sweeps
 *     and one commission make its 1,000, and past them a sweep and a commission are both 429 with nothing moved.
 *
 * Local only: the servers it starts on localhost. The peer a purchase asks is a made-up key at a closed local port.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-money-limits.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, reconcileLedgerFromDb, getCommonsBalanceExact, transfer, getMember, createTreasury } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { resetGatewayRateLimit, gatewayAdmitDayBudget } from './gateway-rate-limit.js';
import { updateGatewayConfig } from './config/local-config.js';
import { DEFAULT_GATEWAY_CONFIG } from './config/gateway.js';
import { WRITER_LIMITS, MONEY_LIMITS } from './config/writer-limits.js';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--money-limits-child';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ── members and signed requests ─────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; headers: Headers }
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function callAt(base: string, method: Method, id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}
let BASE = '';
const call = (method: Method, id: Id | null, urlPath: string, body?: unknown) => callAt(BASE, method, id, urlPath, body);
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 200)}`;
/** `n` requests, `width` at a time: the statuses, in no particular order. */
async function many(n: number, width: number, one: (i: number) => Promise<Res>): Promise<number[]> {
    const statuses: number[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
        while (next < n) { const i = next++; statuses.push((await one(i)).status); }
    }));
    return statuses;
}
const distinct = (statuses: number[]) => [...new Set(statuses)].join(',');

let owner: Id;
/** Everyone's first trading partner: a completed trade with them is what lets a member send Beans at all. */
let tradie: Id;

/** A member who joined a week ago, with a profile photo and name (the marketplace asks for both) and `balance` Beans. */
function member(name: string, balance = 1_000): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(7 * DAY), owner.pk);
    // The epoch now, never 0: epoch 0 is 1970, and the first read would charge decades of demurrage.
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(id.pk, balance, ledger.getCurrentEpoch());
    return id;
}
/** The accounts rows written above, into the ledger's memory. */
const sync = () => reconcileLedgerFromDb();
function setBalance(pk: string, balance: number): void {
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(pk, ledger.getCurrentEpoch());
    db.prepare('UPDATE accounts SET balance = ?, last_demurrage_epoch = ? WHERE public_key = ?').run(balance, ledger.getCurrentEpoch(), pk);
    sync();
}

let seq = 0;
/** A listing as the marketplace stores one. */
function plantPost(author: string, type: 'offer' | 'need', credits = 1, repeatable = true): string {
    const id = `ml-post-${++seq}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, repeatable)
                VALUES (?, ?, 'other', ?, 'test', ?, ?, 'active', ?)`).run(id, type, `${type} ${seq}`, credits, author, repeatable ? 1 : 0);
    return id;
}
/**
 * A trade `buyer` completed with `seller` 40 days ago: earned credit for both, and the seller someone the buyer has paid.
 * Past the wash-trading check's 30 days (engine trust.ts: many members whose one trade is with one person read as an
 * insular cluster, and earn nothing from it).
 */
function completedTrade(buyer: string, seller: string, credits = 50): void {
    const pid = plantPost(seller, 'offer', credits, false);
    db.prepare("UPDATE posts SET status = 'completed' WHERE id = ?").run(pid);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`).run(`ml-trade-${++seq}`, pid, buyer, seller, credits, ago(40 * DAY), ago(40 * DAY));
}
/** A request waiting on the listing's author, exactly the row asking to buy or to help writes (engine/escrow.ts requestPost). */
function plantRequest(postId: string, buyer: string, seller: string, credits = 1): string {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'requested', ?)`).run(id, postId, buyer, seller, credits, new Date().toISOString());
    return id;
}
/** A crowdfund project (never funded: its goal is far off), as the crowdfund route stores one. */
function plantProject(creator: string): string {
    const id = `ml-proj-${++seq}`;
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, status)
                VALUES (?, ?, 'A community orchard', 'test', '[]', 1000000, 'ACTIVE')`).run(id, creator);
    return id;
}

/** Every account but the COMMONS_POOL shadow, plus the live Commons: a refusal moves none of it. */
const nodeTotal = () => r4((db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as { s: number }).s + getCommonsBalanceExact());
const bal = (pk: string) => r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0);
interface Books { total: number; accounts: number; transactions: number; trades: number; pledges: number; members: number }
const books = (): Books => ({
    total: nodeTotal(),
    accounts: count('SELECT COUNT(*) AS n FROM accounts'),
    transactions: count('SELECT COUNT(*) AS n FROM transactions'),
    trades: count('SELECT COUNT(*) AS n FROM marketplace_transactions'),
    pledges: count('SELECT COUNT(*) AS n FROM enterprise_pledges'),
    members: count('SELECT COUNT(*) AS n FROM members'),
});
const sameBooks = (a: Books, b: Books) => JSON.stringify(a) === JSON.stringify(b);

/** A refusal by one of the money limits: 429 with its code, plain words (Beans, never Ʀ), when it lets up, and nothing moved. */
function refused(r: Res, code: string, words: RegExp, before: Books, what: string): void {
    const retry = Number(r.headers.get('retry-after'));
    assert(r.status === 429 && r.body?.code === code && typeof r.body?.resetsAt === 'string' && retry > 0 && retry <= 24 * 3600,
        `${what}: 429 ${code}, with Retry-After ${retry}s and resetsAt (${show(r)})`);
    const error = String(r.body?.error ?? '');
    assert(words.test(error) && /in about/.test(error) && !/Ʀ/.test(error), `${what}: says so in plain words, with when (${error})`);
    const after = books();
    assert(sameBooks(before, after), `${what}: moves nothing, no balance, account row, transaction, trade, pledge or member (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
}

// ── what members do ─────────────────────────────────────────────────────────────────────────────────────────────
const send = (from: Id, to: string, amount = 1) => call('POST', from, '/api/ledger/transfer', { to, amount });
const accept = (buyer: Id, postId: string) => call('POST', buyer, '/api/marketplace/posts/accept', { postId, buyerPublicKey: buyer.pk });
const request = (who: Id, postId: string) => call('POST', who, '/api/marketplace/posts/request', { postId, buyerPublicKey: who.pk });
const approve = (author: Id, transactionId: string) => call('POST', author, '/api/marketplace/transactions/approve', { transactionId, authorPublicKey: author.pk });
const crowdfund = (who: Id, projectId: string, amount = 1) => call('POST', who, `/api/crowdfund/projects/${projectId}/pledge`, { amount });
const enterprise = async (keeper: Id, name: string): Promise<string> => {
    const r = await call('POST', keeper, '/api/enterprise', { name, purpose: `${name}, a test enterprise` });
    const pk = r.body?.publicKey as string;
    if (!pk) throw new Error(`setup: ${keeper.name} could not start ${name}: ${show(r)}`);
    // The marketplace asks every author for a profile photo first, an enterprise too.
    db.prepare("UPDATE members SET avatar_url = 'https://example.com/e.jpg' WHERE public_key = ?").run(pk);
    return pk;
};
const ownPost = (id: Id) => call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++seq}`, description: 'An offer', credits: 0, authorPublicKey: id.pk });
const entOffer = (keeper: Id, ent: string, extra: Record<string, unknown> = {}) =>
    call('POST', keeper, `/api/treasury/${ent}/offer`, { title: `Eggs ${++seq}`, category: 'food', credits: 1, ...extra });

/** The minute throttle off, so what refuses is the rule under test. The day budget is on whatever it says. */
function minuteThrottleOff(): void {
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    resetGatewayRateLimit();
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD: a node on its own data directory, seeded from ML_SEED, serving until its stdin closes (or it is killed).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface Seed {
    owner: string;
    tradie: string;
    members: { pk: string; name: string; balance: number; trades?: boolean }[];
    /** A trading peer that isn't there: its key, at a closed port on this machine. */
    peer?: { address: string; url: string; peerId: string };
    /** Its link enterprise, kept by `keeper`, holding `balance`; and one of its listings cached here, `postId`, by `seller`. */
    link?: { keeper: string; balance: number; seller: string; postId: string };
}

async function runChild(): Promise<void> {
    const seed = JSON.parse(process.env.ML_SEED ?? '{}') as Seed;
    await initTls();
    initStateEngine();
    if (!getMember(seed.owner)) seedGenesisMember(seed.owner, 'Owner');
    const insert = db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                               VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`);
    // Seeded once: a restart on the same data finds the rows there and changes nothing.
    const first = !getMember(seed.tradie);
    insert.run(seed.tradie, 'Tradie', ago(7 * DAY), seed.owner);
    for (const m of seed.members) {
        insert.run(m.pk, m.name, ago(7 * DAY), seed.owner);
        if (first) {
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(m.pk, m.balance, ledger.getCurrentEpoch());
            if (m.trades) completedTrade(m.pk, seed.tradie);
        }
    }
    sync();
    if (seed.peer) {
        const { addConnector, setConnectorCreditCap } = await import('./connector-manager.js');
        if (first) {
            addConnector(seed.peer.address, 'peer', 'Faraway', seed.peer.url);
            setConnectorCreditCap(seed.peer.address, 500);
        }
        // This node's own transport, listening on this machine only for the test's life: the purchase route asks it.
        const { startP2P } = await import('./p2p.js');
        await startP2P(0, 0);
    }
    let linkPk: string | null = null;
    if (seed.peer && seed.link) {
        const { ensureFederationLink, setCommissionCeiling } = await import('./federation-link.js');
        const link = ensureFederationLink(seed.peer.peerId, 'Faraway', createTreasury, seed.link.keeper)!;
        linkPk = link.treasuryPubkey;
        if (first) {
            setCommissionCeiling(seed.peer.peerId, 500);
            db.prepare('UPDATE accounts SET balance = ?, last_demurrage_epoch = ? WHERE public_key = ?').run(seed.link.balance, ledger.getCurrentEpoch(), linkPk);
            // The seller is a member of the other community (a visitor's row with its home), and the listing came from there.
            db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, home_node_url, is_visitor) VALUES (?, 'Far Seller', ?, ?, 1)`)
                .run(seed.link.seller, ago(7 * DAY), seed.peer.url);
            db.prepare(`INSERT OR IGNORE INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, origin_node)
                        VALUES (?, 'offer', 'other', 'A far thing', 'test', 1, ?, 'active', 1, ?)`).run(seed.link.postId, seed.link.seller, seed.peer.url);
            sync();
        }
    }
    const port = await startHttpsServer(0);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    process.stdout.write('@@ ' + JSON.stringify({ port, link: linkPk }) + '\n');
    process.stdin.on('data', () => { /* nothing is sent; the parent only closes it */ });
    process.stdin.on('end', () => process.exit(0));
}

interface Node { base: string; link: string | null; proc: ChildProcess; output: () => string; stop: () => Promise<void>; kill: () => Promise<void> }

/** Start a child node on `dataDir`, resolved once it serves. */
function startNode(dataDir: string, seed: Seed, env: Record<string, string> = {}): Promise<Node> {
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: Record<string, string | undefined> = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ENABLE_PEER_CONNECTORS: 'true', ML_SEED: JSON.stringify(seed), ...env };
    delete childEnv.CF_RECORD_NAME;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CF_ZONE_ID;
    delete childEnv.NODE_ROLE;
    delete childEnv.NODE_PROFILE;
    // The script under node itself with tsx's loader (process.execArgv), never the tsx wrapper: SIGKILL reaches the node.
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, CHILD_FLAG], { env: childEnv as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => { out += d.toString(); });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`the child node did not serve within 90s:\n${out}`)); }, 90_000);
        exited.then(() => { clearTimeout(timer); reject(new Error(`the child node exited before it served:\n${out}`)); });
        const poll = setInterval(() => {
            const line = out.split('\n').find((l) => l.startsWith('@@ '));
            if (!line) return;
            clearInterval(poll);
            clearTimeout(timer);
            const { port, link } = JSON.parse(line.slice(3));
            resolve({
                base: `https://127.0.0.1:${port}`,
                link,
                proc,
                output: () => out,
                stop: async () => { proc.stdin!.end(); const t = setTimeout(() => proc.kill('SIGKILL'), 10_000); await exited; clearTimeout(t); },
                kill: async () => { proc.kill('SIGKILL'); await exited; },
            });
        }, 25);
        exited.then(() => clearInterval(poll));
    });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PARENT
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    console.log('W-money: what one account can do with Beans in a day, and an enterprise\'s own allowances\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);
    tradie = member('Tradie', 0);
    minuteThrottleOff();

    const M = MONEY_LIMITS;
    assert(M.paymentsPerDay === 100 && M.newRecipientsPerDay === 30 && M.marketRequestsPerDay === 100 && M.pledgesPerDay === 20,
        `a member's numbers are Marty's (${JSON.stringify(M)})`);
    assert(M.enterprisePaymentsPerDay === 1_000 && M.enterpriseNewRecipientsPerDay === 300 && M.enterpriseMarketRequestsPerDay === 1_000
        && WRITER_LIMITS.enterprisePostsPerDay === 1_000 && WRITER_LIMITS.enterpriseSignedWritesPerDay === 50_000,
        'an enterprise\'s are ten times a member\'s');

    // ── 1. Payments, a member's own ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. payments: 100 a day, every route that moves a member\'s Beans out ---');
    {
        const ann = member('Ann');
        const ben = member('Ben', 0);
        const cal = member('Cal');
        const sella = member('Sella', 0);
        const hal = member('Hal', 0);
        const bo = member('Bo');
        for (const who of [ann, cal, bo]) { completedTrade(who.pk, tradie.pk); plantPost(who.pk, 'offer'); }
        const sellaOffer = plantPost(sella.pk, 'offer');
        const annNeed = plantPost(ann.pk, 'need');
        const annOffer = plantPost(ann.pk, 'offer');
        const project = plantProject(owner.pk);
        sync();

        const kinds: [string, Res][] = [];
        kinds.push(['a one-step buy (accept)', await accept(ann, sellaOffer)]);
        kinds.push(['asking to buy an offer', await request(ann, sellaOffer)]);
        const halAsks = await request(hal, annNeed);
        assert(halAsks.status === 200, `setup: Hal offers to help with Ann's need (${show(halAsks)})`);
        kinds.push(['approving help on her own need', await approve(ann, halAsks.body?.transaction?.id)]);
        kinds.push(['a crowdfund pledge', await crowdfund(ann, project)]);
        for (const [what, r] of kinds) assert(r.status === 200, `Ann makes a payment by ${what} (${show(r)})`);
        const sends = await many(M.paymentsPerDay - kinds.length, 8, () => send(ann, ben.pk));
        assert(sends.every(s => s === 200), `and ${M.paymentsPerDay - kinds.length} sends to Ben: 100 payments in all (${distinct(sends)})`);

        const before = books();
        const annBefore = bal(ann.pk), benBefore = bal(ben.pk);
        refused(await send(ann, ben.pk), 'money_payments_day', /100 payments/, before, 'the 101st payment, a send');
        refused(await accept(ann, sellaOffer), 'money_payments_day', /100 payments/, before, 'a one-step buy past it');
        refused(await request(ann, sellaOffer), 'money_payments_day', /100 payments/, before, 'asking to buy an offer past it');
        refused(await crowdfund(ann, project), 'money_payments_day', /100 payments/, before, 'a crowdfund pledge past it');
        assert(bal(ann.pk) === annBefore && bal(ben.pk) === benBefore, `neither balance moved (Ann ${annBefore}, Ben ${benBefore})`);

        const boAsks = plantRequest(annOffer, bo.pk, ann.pk);
        const approveOwnOffer = await approve(ann, boAsks);
        assert(approveOwnOffer.status === 200, `an act that pays nothing still goes: Ann approves Bo's request on her offer (${show(approveOwnOffer)})`);
        const other = await send(cal, ben.pk);
        assert(other.status === 200, `another key is unaffected: Cal sends to Ben (${show(other)})`);
        const gift = await send(cal, ann.pk, 5);
        assert(gift.status === 200 && bal(ann.pk) === r4(annBefore + 5), `receiving is never limited: Cal sends Ann 5 (${show(gift)}, Ann ${bal(ann.pk)})`);
        const calBuys = await accept(cal, annOffer);
        const done = await call('POST', cal, '/api/marketplace/transactions/complete', { transactionId: calBuys.body?.transaction?.id, confirmerPublicKey: cal.pk });
        assert(calBuys.status === 200 && done.status === 200 && bal(ann.pk) > r4(annBefore + 5),
            `and a sale's escrow reaches her when the buyer completes (${calBuys.status}, ${show(done)}, Ann ${bal(ann.pk)})`);
    }

    // ── 2. New people paid ────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. new people paid: 30 a day ---');
    {
        const dan = member('Dan');
        const old = member('Old', 0);
        const seller = member('Newstall', 0);
        const people = Array.from({ length: M.newRecipientsPerDay + 1 }, (_v, i) => member(`Person ${i}`, 0));
        completedTrade(dan.pk, tradie.pk);
        plantPost(dan.pk, 'offer');
        const newSellerOffer = plantPost(seller.pk, 'offer');
        sync();
        // Three days ago Dan paid Old (the ledger's row, as the send wrote it, moved back in time).
        const paid = transfer(dan.pk, old.pk, 1, 'three days ago');
        db.prepare('UPDATE transactions SET timestamp = ? WHERE id = ?').run(ago(3 * DAY), paid!.id);

        const first = await many(M.newRecipientsPerDay, 8, (i) => send(dan, people[i].pk));
        assert(first.every(s => s === 200), `Dan pays 30 people he has never paid (${distinct(first)})`);
        const again = await send(dan, people[0].pk);
        assert(again.status === 200, `paying one of them again is not a new person (${show(again)})`);
        const regular = await send(dan, old.pk);
        assert(regular.status === 200, `nor is someone he paid three days ago (${show(regular)})`);
        const tradedWith = await send(dan, tradie.pk);
        assert(tradedWith.status === 200, `nor someone he bought from before (${show(tradedWith)})`);

        const before = books();
        refused(await send(dan, people[M.newRecipientsPerDay].pk), 'money_new_recipients_day', /30 people/, before, 'the 31st new person');
        const stranger = newId('Stranger');
        refused(await send(dan, stranger.pk), 'money_new_recipients_day', /30 people/, before, 'a key with no row');
        assert(count('SELECT COUNT(*) AS n FROM members WHERE public_key = ?', stranger.pk) === 0, 'and no row is made for them');
        refused(await accept(dan, newSellerOffer), 'money_new_recipients_day', /30 people/, before, 'buying from a new seller');
    }

    // ── 3. Marketplace requests ───────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. marketplace requests: asking, accepting and approving, 100 a day ---');
    {
        const eve = member('Eve');
        const nia = member('Nia');
        const bo2 = member('Bo Two');
        const eveOffer = plantPost(eve.pk, 'offer');
        plantPost(bo2.pk, 'offer');
        const needs = Array.from({ length: M.marketRequestsPerDay }, () => plantPost(nia.pk, 'need', 1, false));
        sync();
        const boAsks = await request(bo2, eveOffer);
        const eveApproves = await approve(eve, boAsks.body?.transaction?.id);
        assert(boAsks.status === 200 && eveApproves.status === 200, `Eve approves Bo's request on her offer, her first (${boAsks.status}, ${show(eveApproves)})`);
        const asks = await many(M.marketRequestsPerDay - 1, 8, (i) => request(eve, needs[i]));
        assert(asks.every(s => s === 200), `and asks to help with 99 needs: 100 in all (${distinct(asks)})`);
        const before = books();
        refused(await request(eve, needs[M.marketRequestsPerDay - 1]), 'money_requests_day', /100 deals/, before, 'the 101st request');
        refused(await accept(eve, plantPost(nia.pk, 'offer')), 'money_requests_day', /100 deals/, before, 'a one-step buy past it');
        const boAsksToo = await request(bo2, needs[M.marketRequestsPerDay - 1]);
        assert(boAsksToo.status === 200, `another member still asks (${show(boAsksToo)})`);
    }

    // ── 4. Pledges ────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. pledges: backing, releasing and crowdfund pledges, 20 a day ---');
    {
        const fay = member('Fay');
        const gil = member('Gil');
        completedTrade(fay.pk, tradie.pk, 200);
        sync();
        const ent = await enterprise(fay, 'Fay Farm');
        const project = plantProject(owner.pk);
        const backs = [] as number[];
        for (let i = 0; i < 10; i++) backs.push((await call('POST', fay, `/api/treasury/${ent}/backing`, { amount: 1 })).status);
        const releases = [] as number[];
        const aliases: [Method, string][] = [
            ['POST', `/api/treasury/${ent}/release`], ['DELETE', `/api/treasury/${ent}/pledge`], ['POST', `/api/treasury/${ent}/pledge/release`],
            ['DELETE', `/api/treasury/${ent}/backing`], ['POST', `/api/treasury/${ent}/backing/release`], ['POST', `/api/enterprise/${ent}/release`],
            ['DELETE', `/api/enterprise/${ent}/pledge`], ['POST', `/api/enterprise/${ent}/pledge/release`], ['POST', `/api/enterprise/${ent}/backing/release`],
        ];
        for (const [method, p] of aliases) releases.push((await call(method, fay, p, { amount: 1 })).status);
        const pledged = await crowdfund(fay, project);
        assert(backs.every(s => s === 200) && releases.every(s => s === 200) && pledged.status === 200,
            `Fay backs her enterprise 10 times, releases 9 (every alias) and pledges to a crowdfund: 20 (${distinct(backs)} / ${distinct(releases)} / ${pledged.status})`);
        const before = books();
        refused(await call('POST', fay, `/api/treasury/${ent}/backing`, { amount: 1 }), 'money_pledges_day', /20 pledges/, before, 'the 21st, a backing');
        refused(await call('POST', fay, `/api/enterprise/${ent}/pledge`, { type: 'backing', amount: 1 }), 'money_pledges_day', /20 pledges/, before, 'a backing by its other door');
        refused(await call('DELETE', fay, `/api/enterprise/${ent}/backing`, { amount: 1 }), 'money_pledges_day', /20 pledges/, before, 'a release');
        refused(await crowdfund(fay, project), 'money_pledges_day', /20 pledges/, before, 'a crowdfund pledge');
        const gilPledges = await crowdfund(gil, project);
        assert(gilPledges.status === 200, `another member still pledges (${show(gilPledges)})`);
    }

    // ── 5. An enterprise ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. an enterprise: 1,000 payments, 1,000 approvals and 300 new people, counted against it ---');
    {
        const gus = member('Gus');
        const ben = member('Ben Two', 0);
        completedTrade(gus.pk, tradie.pk);
        sync();
        const y = await enterprise(gus, 'Gus Grocer');
        setBalance(y, 5_000);

        const own = await many(M.paymentsPerDay - 1, 8, () => send(gus, ben.pk));
        assert(own.every(s => s === 200), `Gus, Gus Grocer's keeper, makes 99 payments of his own (${distinct(own)})`);
        const sweeps = await many(M.enterprisePaymentsPerDay, 8, () => call('POST', gus, `/api/treasury/${y}/sweep`, { amount: 1 }));
        assert(sweeps.every(s => s === 200), `and 1,000 for Gus Grocer, sweeping to the Commons: his own 99 took none of its room (${distinct(sweeps)})`);
        const before = books();
        refused(await call('POST', gus, `/api/treasury/${y}/sweep`, { amount: 1 }), 'money_payments_day', /Gus Grocer can make 1,000 payments/, before, 'Gus Grocer\'s 1,001st payment');
        const hundredth = await send(gus, ben.pk);
        assert(hundredth.status === 200, `its 1,000 took none of Gus's: his 100th payment goes (${show(hundredth)})`);
        const beforeOwn = books();
        refused(await send(gus, ben.pk), 'money_payments_day', /You can make 100 payments/, beforeOwn, 'and his 101st is refused in his own words');

        // 1,000 approvals of requests on its offer (each buyer's Beans go into escrow: not the enterprise's payment).
        const offer = (await entOffer(gus, y)).body?.post?.id as string;
        const buyers = Array.from({ length: 11 }, (_v, i) => member(`Buyer ${i}`));
        sync();
        const asks = Array.from({ length: M.enterpriseMarketRequestsPerDay + 1 }, (_v, i) => plantRequest(offer, buyers[i % 11].pk, y));
        const approvals = await many(M.enterpriseMarketRequestsPerDay, 8, (i) => call('POST', gus, `/api/treasury/${y}/approve`, { transactionId: asks[i] }));
        assert(approvals.every(s => s === 200), `Gus approves 1,000 requests on Gus Grocer's offer, though it has made all its payments (${distinct(approvals)})`);
        const beforeApproval = books();
        refused(await call('POST', gus, `/api/treasury/${y}/approve`, { transactionId: asks[M.enterpriseMarketRequestsPerDay] }), 'money_requests_day', /Gus Grocer can approve 1,000 deals/, beforeApproval, 'the 1,001st approval');

        // 300 new people: helpers on another enterprise's need, paid from its escrow when approved.
        const zed = member('Zed');
        sync();
        const z = await enterprise(zed, 'Zed Works');
        setBalance(z, 5_000);
        assert((await entOffer(zed, z)).status === 200, 'setup: Zed Works lists an offer (a need needs one)');
        const need = (await call('POST', zed, `/api/treasury/${z}/need`, { title: 'Help at the working bee', category: 'other', credits: 1, repeatable: true })).body?.post?.id as string;
        assert(!!need, 'setup: Zed Works needs help');
        const helpers = Array.from({ length: M.enterpriseNewRecipientsPerDay + 1 }, (_v, i) => member(`Helper ${i}`, 0));
        sync();
        const offers = helpers.map((h) => plantRequest(need, z, h.pk));
        const paidHelpers = await many(M.enterpriseNewRecipientsPerDay, 8, (i) => call('POST', zed, `/api/treasury/${z}/approve`, { transactionId: offers[i] }));
        assert(paidHelpers.every(s => s === 200), `Zed Works pays 300 helpers it has never paid (${distinct(paidHelpers)})`);
        const beforeHelper = books();
        refused(await call('POST', zed, `/api/treasury/${z}/approve`, { transactionId: offers[M.enterpriseNewRecipientsPerDay] }), 'money_new_recipients_day', /Zed Works can pay 300 people/, beforeHelper, 'the 301st new helper');
        const againOffer = plantRequest(need, z, helpers[0].pk);
        const paidAgain = await call('POST', zed, `/api/treasury/${z}/approve`, { transactionId: againOffer });
        assert(paidAgain.status === 200, `paying a helper it paid today again is not a new person (${show(paidAgain)})`);
    }

    // ── 6. Posts (W-main) ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. posts: 100 a member\'s own, 1,000 an enterprise\'s ---');
    {
        const max = member('Max');
        sync();
        const p = await enterprise(max, 'Max Market');
        const own = await many(WRITER_LIMITS.postsPerDay, 8, () => ownPost(max));
        const overOwn = await ownPost(max);
        assert(own.every(s => s === 200) && overOwn.status === 429 && overOwn.body?.code === 'posts_per_day',
            `Max's own 100 posts go and the 101st is 429 posts_per_day (${distinct(own)}, then ${show(overOwn)})`);
        const forP = await many(WRITER_LIMITS.enterprisePostsPerDay, 8, () => entOffer(max, p));
        assert(forP.every(s => s === 200), `and he still puts up 1,000 for Max Market: none count against him (${distinct(forP)})`);
        const overP = await entOffer(max, p);
        assert(overP.status === 429 && overP.body?.code === 'enterprise_posts_per_day' && /Max Market can put up 1,000 new posts/.test(overP.body?.error ?? '') && typeof overP.body?.resetsAt === 'string',
            `the enterprise's 1,001st is 429 enterprise_posts_per_day, in its words (${show(overP)})`);
        assert(count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', p) === 1_000, 'and 1,000 are stored');
        const stillOwn = await ownPost(max);
        assert(stillOwn.status === 429 && stillOwn.body?.code === 'posts_per_day', `his own still stop at 100 (${show(stillOwn)})`);
    }

    // ── 7. The day budget (W-main) ────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. the day budget: an enterprise\'s writes spend its own 50,000 ---');
    {
        const quinn = member('Quinn');
        const rae = member('Rae');
        sync();
        const r = await enterprise(quinn, 'Quinn Quarry');
        const closed = await enterprise(quinn, 'Quinn Closed');
        db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(closed);
        const foreign = await enterprise(rae, 'Rae Rentals');
        const now = Date.now();
        const ctx = (actor: string, p = '/api/community/me/area') => ({ state: { actor }, method: 'POST', path: p, status: 200, body: undefined, set: () => {} }) as any;
        // Quinn's own writes to 5 short of the budget, as the gateway counts them (so far: two enterprises started).
        for (let i = 0; i < WRITER_LIMITS.signedWritesPerDay - 2 - 5; i++) gatewayAdmitDayBudget(ctx(quinn.pk), now);
        const forR = await many(10, 4, () => entOffer(quinn, r));
        assert(forR.every(s => s === 200), `10 writes for Quinn Quarry, at 5 short of her own budget, all go (${distinct(forR)})`);
        const mine = await many(5, 1, () => call('POST', quinn, '/api/community/me/area', {}));
        assert(!mine.includes(429), `and her own 5 still go: the enterprise's 10 spent none of hers (${distinct(mine)})`);
        const over = await call('POST', quinn, '/api/community/me/area', {});
        assert(over.status === 429 && over.body?.code === 'day_budget', `her next own write is 429 day_budget (${show(over)})`);
        const stillR = await entOffer(quinn, r);
        assert(stillR.status === 200, `a write for Quinn Quarry still goes (${show(stillR)})`);
        const madeUp = await call('POST', quinn, `/api/treasury/${crypto.randomBytes(32).toString('hex')}/offer`, { title: 'x', category: 'food' });
        assert(madeUp.status === 429 && madeUp.body?.code === 'day_budget', `a made-up enterprise in the path counts against her: 429 day_budget (${show(madeUp)})`);
        const notHers = await entOffer(quinn, foreign);
        assert(notHers.status === 429 && notHers.body?.code === 'day_budget', `so does one she doesn't keep (${show(notHers)})`);
        const woundUp = await entOffer(quinn, closed);
        assert(woundUp.status === 429 && woundUp.body?.code === 'day_budget', `and one wound up (${show(woundUp)})`);

        // Quinn Quarry's own budget, filled as the gateway counts its writes, to one short.
        const used = 10 + 1;
        for (let i = 0; i < WRITER_LIMITS.enterpriseSignedWritesPerDay - used - 1; i++) {
            (gatewayAdmitDayBudget as (c: any, n: number, e?: string | null) => boolean)(ctx(quinn.pk, `/api/treasury/${r}/offer`), now, r);
        }
        const last = await entOffer(quinn, r);
        assert(last.status === 200, `its 50,000th write goes (${show(last)})`);
        const past = await entOffer(quinn, r);
        assert(past.status === 429 && past.body?.code === 'enterprise_day_budget' && /50,000 changes/.test(past.body?.error ?? '') && !!past.headers.get('retry-after'),
            `its 50,001st is 429 enterprise_day_budget, in words (${show(past)})`);
        const raeWrites = await entOffer(rae, foreign);
        assert(raeWrites.status === 200, `another enterprise is unaffected (${show(raeWrites)})`);
        resetGatewayRateLimit();
    }

    // ── 8. A restart keeps the count ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. a restart keeps the count ---');
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-limits-restart-'));
        const ann = newId('Ann'), ben = newId('Ben');
        const seed: Seed = { owner: newId('Owner').pk, tradie: newId('Tradie').pk, members: [{ pk: ann.pk, name: 'Ann', balance: 1_000, trades: true }, { pk: ben.pk, name: 'Ben', balance: 0 }] };
        const one = await startNode(dir, seed);
        const firstSixty = await many(60, 8, () => callAt(one.base, 'POST', ann, '/api/ledger/transfer', { to: ben.pk, amount: 1 }));
        assert(firstSixty.every(s => s === 200), `a node takes 60 of Ann's payments (${distinct(firstSixty)})`);
        await one.kill();
        const two = await startNode(dir, seed);
        try {
            const nextForty = await many(40, 8, () => callAt(two.base, 'POST', ann, '/api/ledger/transfer', { to: ben.pk, amount: 1 }));
            assert(nextForty.every(s => s === 200), `killed (SIGKILL) and booted again on the same data, it takes 40 more (${distinct(nextForty)})`);
            const past = await callAt(two.base, 'POST', ann, '/api/ledger/transfer', { to: ben.pk, amount: 1 });
            assert(past.status === 429 && past.body?.code === 'money_payments_day', `and refuses the 101st: the restart kept the count (${show(past)})`);
        } finally {
            await two.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── 9. Federation purchases count ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. federation purchases count ---');
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-limits-federation-'));
        const { generateKeyPair } = await import('@libp2p/crypto/keys');
        const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
        const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
        // Port 9 on this machine: nothing listens, so the ask fails at once and nothing leaves the box.
        const peerAddress = `/ip4/127.0.0.1/tcp/9/p2p/${peer}`;
        const jo = newId('Jo'), ben = newId('Ben'), kit = newId('Kit');
        const remoteSeller = crypto.randomBytes(32).toString('hex');
        const seed: Seed = {
            owner: newId('Owner').pk, tradie: newId('Tradie').pk,
            members: [{ pk: jo.pk, name: 'Jo', balance: 1_000, trades: true }, { pk: ben.pk, name: 'Ben', balance: 0 }, { pk: kit.pk, name: 'Kit', balance: 100, trades: true }],
            peer: { address: peerAddress, url: 'https://faraway.invalid', peerId: peer },
            link: { keeper: kit.pk, balance: 2_000, seller: crypto.randomBytes(32).toString('hex'), postId: 'far-post' },
        };
        const node = await startNode(dir, seed, { FEDERATION_SETTLEMENT: 'true' });
        const their = new Database(path.join(dir, 'state.db'));
        const outbound = () => (their.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE direction = 'outbound' AND buyer_pubkey = ?`).get(jo.pk) as { n: number }).n;
        const balance = () => r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(jo.pk) as { balance: number }).balance);
        const purchase = () => callAt(node.base, 'POST', jo, '/api/federation/purchase', { peerAddress, sellerPublicKey: remoteSeller, amount: 1 });
        try {
            const sends = await many(M.paymentsPerDay - 1, 8, () => callAt(node.base, 'POST', jo, '/api/ledger/transfer', { to: ben.pk, amount: 1 }));
            assert(sends.every(s => s === 200), `Jo makes 99 payments (${distinct(sends)})`);
            const bought = await purchase();
            assert(outbound() === 1 && bought.status !== 429, `and a purchase from another community: it escrows her Beans before it asks, so its settlement is there (${show(bought)}, ${outbound()} outbound)`);
            const afterPurchase = balance();
            const past = await callAt(node.base, 'POST', jo, '/api/ledger/transfer', { to: ben.pk, amount: 1 });
            assert(past.status === 429 && past.body?.code === 'money_payments_day', `the purchase counted: her next send is 429 money_payments_day (${show(past)})`);
            const again = await purchase();
            assert(again.status === 429 && again.body?.code === 'money_payments_day' && outbound() === 1 && balance() === afterPurchase,
                `and a purchase past it is 429 before anything moves: no new settlement, the same balance (${show(again)}, ${outbound()}, ${balance()})`);

            // A commission: the link enterprise's payment, counted against it (Kit, its keeper, signs).
            const link = node.link!;
            const linkOutbound = () => (their.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE direction = 'outbound' AND buyer_pubkey = ?`).get(link) as { n: number }).n;
            const sweeps = await many(M.enterprisePaymentsPerDay - 1, 8, () => callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 }));
            assert(sweeps.every(s => s === 200), `Kit sweeps 999 from the link enterprise to the Commons (${distinct(sweeps)})`);
            const commissioned = await callAt(node.base, 'POST', kit, '/api/federation/commission', { postId: 'far-post' });
            assert(linkOutbound() === 1 && commissioned.status !== 429, `and commissions a listing from the other community: its settlement is there, the enterprise's 1,000th payment (${show(commissioned)}, ${linkOutbound()} outbound)`);
            const linkBalance = r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(link) as { balance: number }).balance);
            const sweepPast = await callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 });
            assert(sweepPast.status === 429 && sweepPast.body?.code === 'money_payments_day' && /can make 1,000 payments/.test(sweepPast.body?.error ?? ''),
                `the commission counted: the enterprise's next sweep is 429 money_payments_day (${show(sweepPast)})`);
            const commissionPast = await callAt(node.base, 'POST', kit, '/api/federation/commission', { postId: 'far-post' });
            const linkAfter = r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(link) as { balance: number }).balance);
            assert(commissionPast.status === 429 && commissionPast.body?.code === 'money_payments_day' && linkOutbound() === 1 && linkAfter === linkBalance,
                `and a commission past it is 429 before anything moves: no new settlement, the same balance (${show(commissionPast)}, ${linkOutbound()}, ${linkAfter})`);
            const kitOwn = await callAt(node.base, 'POST', kit, '/api/ledger/transfer', { to: ben.pk, amount: 1 });
            assert(kitOwn.status === 200, `the enterprise's 1,000 took none of Kit's: his own payment goes (${show(kitOwn)})`);
        } finally {
            their.close();
            await node.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ money-limits checks PASSED.');
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error('child failed:', e); process.exit(1); });
} else {
    main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
}
