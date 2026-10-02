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
 *     sale's escrow released) still works past every limit. At the limit, an id sent as anything but text (a list
 *     holding the real one, an object, a number, true, null or '') is 400 on every route whose count reads one (a send's
 *     `to`, a buy's or an ask's `postId`, an approval's `transactionId`), and nothing moves or is counted; the other
 *     money routes read no id from the body.
 *  2. New people paid: 30 a day; paying one of them again, someone paid three days ago and someone bought from before
 *     is not new; the 31st new person is 429 money_new_recipients_day, and a key with no row gets no row; buying from a
 *     new seller counts too; so does an id that isn't text (400), buying or asking.
 *  3. Marketplace requests: asking, accepting and approving, 100 a day; the 101st is 429 money_requests_day and makes
 *     no trade row. Asking again for the same offer while the first ask waits returns that ask and counts nothing.
 *  4. Pledges: backing an enterprise, releasing it (every alias) and a crowdfund pledge, 20 a day; the 21st is 429
 *     money_pledges_day, and so is applying to keep another enterprise with a pledge (each way it can be sent), with no
 *     application stored; applying with none still goes; another member is unaffected.
 *  5. An enterprise: its payments (sweeps to the Commons) count against it, 1,000 a day, and never against the keeper
 *     who signs, nor the keeper's against it; 1,000 approvals of requests on its listings; 300 new people paid (helpers
 *     on its need), and paying one again is not new. Past each, the keeper's next is his own (round 3): the 1,001st
 *     sweep is his 100th payment, and his next send and sweep are refused in his own words; the 1,001st approval and
 *     the 301st new helper go as his own. An approval's id that isn't text is 400 at both its doors.
 *  6. Posts (W-main): a keeper's own stop at 100; what they put up for an enterprise counts against the enterprise, up
 *     to 1,000; past that against their own 100, which are spent: 429 posts_per_day naming the enterprise.
 *  7. The day budget (W-main): writes whose path names an enterprise the signer keeps spend the enterprise's 50,000,
 *     not the signer's 5,000; a made-up, foreign or wound-up enterprise in the path counts against the signer; past its
 *     50,000 a keeper's write for it counts on their own day (429 day_budget, naming the enterprise, when that is spent)
 *     while another enterprise is unaffected.
 *  8. A restart keeps the count: a node killed (SIGKILL) after 60 payments and booted again on the same data takes
 *     40 more and refuses the 101st.
 *  9. Federation purchases count (settlement ON, in a child node with its own libp2p transport and a peer that isn't
 *     there): a purchase escrows the buyer's Beans before it asks, so it is a payment; the next send past 100 is 429,
 *     and a purchase past it is 429 before anything moves. A commission is the link enterprise's payment: 999 sweeps
 *     and one commission make its 1,000; the commission also counted against its keeper's enterprise work (step 10), so
 *     his own enterprise's first sweep is 429. Past the link's 1,000, Kit's sweep and commission for it are his own
 *     payments (round 3): his 100th is a commission that goes, recorded as his own for the link; past it a commission
 *     and a sweep are 429 money_payments_day in his words, with no new settlement and the same balance. Then one of his
 *     sweeps for the link leaves the day, and his next goes as the link's 1,000th: his own commission is not the link's.
 * 10. One person's enterprise work, across every enterprise they keep (the review of 362efe26: starting enterprises
 *     multiplied one member's day). Mo starts 3. With his own day spent, his writes for all 3 together stop at 50,000
 *     (429 enterprise_work_day_budget), not 3 × 50,000, while each still has room and another keeper still writes for
 *     one; likewise his posts for them (1,000, enterprise_work_posts_per_day), the people new to them he pays (300),
 *     his payments for them (1,000) and his approvals for them (1,000), each 429 in its words with nothing moved, while
 *     the other keeper still acts and his own limits are apart.
 * 11. A shop with 2 keepers still gets its whole allowance: their writes, payments and posts together make its 50,000,
 *     1,000 and 1,000; past them each keeper's next counts on their own and goes (round 3); each keeper's share counted
 *     to their own ceiling, so the one who did half still acts for their other enterprise.
 * 12. The enterprise thread is a chat: 30 lines a minute per person, the 31st is 429 chat_rate; another member still
 *     posts; a keeper's removals share the same 30.
 * 13. A restart keeps one person's enterprise work: in a child node, 600 sweeps from two enterprises, a SIGKILL, 400
 *     more, and the 1,001st is 429 money_enterprise_work_payments_day though that enterprise has made only 500.
 * 14. One keeper can't lock the others out of a shop (the reviews of 68ff4e4f and 2e3caa2b; the director, 2026-09-30).
 *     Rex, Leah Linens' second keeper, spends its 1,000 posts, 1,000 payments, 1,000 approvals and 50,000 writes. Leah
 *     still sweeps, pays Ivo (new to it) for his help, posts and writes in its thread: each counts as her own, not the
 *     shop's or her enterprise work. Up to her own limits, then each is refused in her own words naming the shop: her
 *     31st new person, 101st payment, 101st deal, 101st post (and her own post after it), and her 5,001st change. Rex
 *     has his own limits for it too and no more: his 100th post, payment and deal for it go, the next are refused in his
 *     words, and his writes stop at his own 5,000 though all his enterprise work went on it. Its governance and settling
 *     count on her own day: with the shop's day and her own payments spent, she completes the job the shop funded (Hugo
 *     is paid), turns a request down, removes Rex, pauses, resumes and starts winding it up, at both path prefixes and
 *     with a trailing slash; those 6 writes spend her own day (the next is 429 day_budget) and not her enterprise work.
 *     The node's total is unchanged.
 * 15. A crowdfund project's id is the server's (the review of 68ff4e4f: Mallory made a "project" whose id was Victor's
 *     key, and her pledge reached his balance and made him `funded`). A project sent with Victor's key, an enterprise's
 *     treasury, the Commons, a deal's id (its escrow holds Beans) or a fresh id of the caller's own is refused, and so is
 *     a pledge to each; nothing moves and no status changes. A projects row made before, under a person's key, takes no
 *     pledge at either door and can't be edited or deleted (which renamed or pruned that person). A project sent with no
 *     id is made with a new one, as its own enterprise, and pledges fund it into its own account.
 * 16. One person's ceiling still holds across three shops when one is spent: Noor spends Noor Acres' 50,000 writes and
 *     1,000 payments herself; her writes and sweeps for her other two, which have room, are 429 in her enterprise-work
 *     words; for Noor Acres they go on her own limits, up to them, then 429 in her own words; Oli, a keeper of one of the
 *     other two, still acts for it; the node's total is unchanged.
 * 17. Past a spent shop's day, whose count each act lands on (the round-4 review of #1329). Kay paid 40 people herself 40
 *     days ago, whom Kay Kitchenware never paid; Otto spent its 1,000 payments; Kay pays all 40 from it: 30 go as her own
 *     new people (new to the SHOP) and the 31st on are 429 money_new_recipients_day. Uma's post as her own for Uma
 *     Upholstery (spent) leaves its count: once one of its own leaves the day, her next for it is the shop's and goes,
 *     though her own 100 are spent. Wes's 3 posts of his own for Yan Yarns (spent) are not his enterprise work: at 999
 *     for his enterprises, his 1,000th for Wes Wares goes.
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
import { initStateEngine, seedGenesisMember, reconcileLedgerFromDb, getCommonsBalanceExact, transfer, getMember, createTreasury, adminAssignTreasuryOperator } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, createCrowdfundProject } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { resetGatewayRateLimit, gatewayAdmitDayBudget } from './gateway-rate-limit.js';
import { updateGatewayConfig } from './config/local-config.js';
import { DEFAULT_GATEWAY_CONFIG } from './config/gateway.js';
import { WRITER_LIMITS, MONEY_LIMITS } from './config/writer-limits.js';
import { admitMoneyActs } from './engine/money-limits.js';

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
/** When each server last answered this suite, for the message of a request that fails. */
const lastAnswer = new Map<string, number>();
async function callAt(base: string, method: Method, id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    // A new connection for every request, never a kept-alive one. The main server runs in this process, and the suite
    // seeds rows synchronously between requests (moneyActs, entPosts, gatewayWrites), which holds the event loop. When
    // that hold outlasts the server's keep-alive timeout (5 s, plus Node 22's 1 s buffer), fetch hands the next request
    // to the idle socket before the timer has run; the timer then fires and the server destroys the socket with the
    // request unread: `fetch failed`, cause `read ECONNRESET` (CI, Node 22, at the two longest holds). A child node's
    // socket goes stale the same way while this process is held.
    const headers: Record<string, string> = { Connection: 'close' };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    let res: Response;
    try {
        res = await fetch(`${base}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    } catch (e) {
        // fetch says only `fetch failed`; why is in its cause (ECONNRESET, ECONNREFUSED, a timeout...).
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const since = lastAnswer.has(base) ? `${Date.now() - lastAnswer.get(base)!} ms after its last answer` : 'before any answer';
        throw new Error(`${method} ${base}${urlPath} failed: ${cause?.code ?? ''} ${cause?.message ?? String(e)} (${since})`, { cause: e });
    }
    lastAnswer.set(base, Date.now());
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
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_ref, status)
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

/** Every way to send an id that isn't text: a list holding the real one, an object, a number, true, null and ''. */
const notText = (real: string): unknown[] => [[real], { id: real }, 7, true, null, ''];
const actsOf = (pk: string) => count('SELECT COUNT(*) AS n FROM money_acts WHERE account = ?', pk);
/**
 * At a limit, `field` sent as anything but text is 400 before the gate counts anything or the handler runs, and nothing
 * moves (the review of 362efe26: `[id]` took payments and new people past every limit, as SQLite binds it as `id`).
 */
async function idNotText(what: string, field: string, real: string, account: string, send: (id: unknown) => Promise<Res>): Promise<void> {
    const before = books();
    const acts = actsOf(account);
    const answers: string[] = [];
    for (const v of notText(real)) answers.push(`${JSON.stringify(v).slice(0, 12)} ${(await send(v)).status}`);
    assert(answers.every((a) => a.endsWith(' 400')), `${what}: ${field} sent as a list, an object, a number, true, null or '' is 400 (${answers.join(', ')})`);
    const after = books();
    assert(sameBooks(before, after) && actsOf(account) === acts, `${what}: and nothing moved or was counted (${JSON.stringify(before)} → ${JSON.stringify(after)}, acts ${acts} → ${actsOf(account)})`);
}

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
    db.prepare("UPDATE members SET avatar_ref = 'https://example.com/e.jpg' WHERE public_key = ?").run(pk);
    return pk;
};
const ownPost = (id: Id) => call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++seq}`, description: 'An offer', credits: 0, authorPublicKey: id.pk });
const entOffer = (keeper: Id, ent: string, extra: Record<string, unknown> = {}) =>
    call('POST', keeper, `/api/treasury/${ent}/offer`, { title: `Eggs ${++seq}`, category: 'food', credits: 1, ...extra });

/** `n` of `keeper`'s writes, as the gateway counts them: their own, or for `ent` (its path) when given. */
function gatewayWrites(keeper: string, n: number, ent: string | null = null): void {
    const now = Date.now();
    const ctx = { state: { actor: keeper }, method: 'POST', path: ent ? `/api/treasury/${ent}/offer` : '/api/community/me/area', status: 200, body: undefined, set: () => {} } as any;
    for (let i = 0; i < n; i++) gatewayAdmitDayBudget(ctx, now, ent);
}
/** `n` payments (to nobody, as a sweep's) or requests `keeper` made for `ent` today, as the gate records them. */
function moneyActs(ent: string, keeper: string, n: number, kind: 'payment' | 'request'): void {
    for (let i = 0; i < n; i++) admitMoneyActs(ent, [{ kind, recipient: null }], Date.now(), keeper);
}
/** `n` payments `keeper` made for `ent` today, each to someone new to it (a key it has never paid). */
function newPeoplePaid(ent: string, keeper: string, n: number): void {
    for (let i = 0; i < n; i++) admitMoneyActs(ent, [{ kind: 'payment', recipient: crypto.randomBytes(32).toString('hex') }], Date.now(), keeper);
}
/** `n` posts `keeper` put up today for `ent`, as the enterprise's offer route stores them (created_by the keeper). */
function entPosts(ent: string, keeper: string, n: number): void {
    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, repeatable, created_by, created_at)
                               VALUES (?, 'offer', 'other', 'Stock', 'test', 1, ?, 'active', 1, ?, ?)`);
    db.transaction(() => { for (let i = 0; i < n; i++) insert.run(`ml-ent-post-${++seq}`, ent, keeper, new Date().toISOString()); })();
}
/** What `keeper` put up in the day for enterprises: the posts they made whose author isn't them. */
const postsForEnterprises = (keeper: string) =>
    count(`SELECT COUNT(*) AS n FROM posts WHERE created_by = ? AND author_pubkey != ? AND created_at > ?`, keeper, keeper, ago(DAY));
/** `n` posts of `member`'s own put up today, as the marketplace stores them. */
function ownPosts(member: string, n: number): void {
    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, repeatable, created_at)
                               VALUES (?, 'offer', 'other', 'Mine', 'test', 1, ?, 'active', 1, ?)`);
    db.transaction(() => { for (let i = 0; i < n; i++) insert.run(`ml-own-post-${++seq}`, member, new Date().toISOString()); })();
}
/** `n` of `member`'s own payments (each to someone new, when `newPeople`) or requests today, as the gate records them. */
function ownActs(member: string, n: number, kind: 'payment' | 'request', newPeople = false): void {
    for (let i = 0; i < n; i++) admitMoneyActs(member, [{ kind, recipient: newPeople ? crypto.randomBytes(32).toString('hex') : null }], Date.now());
}
/** Fill `member`'s own day budget as the gateway counts their own writes, until it refuses: how many more it took. */
function fillOwnDay(member: string): number {
    const ctx = { state: { actor: member }, method: 'POST', path: '/api/community/me/area', status: 200, body: undefined, set: () => {} } as any;
    let n = 0;
    while (gatewayAdmitDayBudget(ctx, Date.now())) n++;
    return n;
}
/** The day's acts of `kind` counted against `account` itself (a keeper's own for an enterprise are theirs, not its). */
const actsAs = (account: string, kind: 'payment' | 'request') => count('SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND kind = ?', account, kind);
/** `keeper`'s own acts of `kind` done for `ent` once its day was spent. */
const ownFor = (keeper: string, ent: string, kind: 'payment' | 'request') =>
    count('SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND for_enterprise = ? AND kind = ?', keeper, ent, kind);
/** The posts that count against `ent` itself: its own, less those its keepers put up as their own. */
const postsAs = (ent: string) => count('SELECT COUNT(*) AS n FROM posts p WHERE author_pubkey = ? AND NOT EXISTS (SELECT 1 FROM keeper_own_posts k WHERE k.post_id = p.id)', ent);
/** The sentence a keeper's own refusal adds when the act was for `ent`, whose own day is spent. */
const spentNote = (ent: string) => new RegExp(`${ent} has reached its own limit for today, so what you do for it counts against yours\\.`);
const line = (who: Id, ent: string, text = `A line ${++seq}`) => call('POST', who, `/api/treasury/${ent}/thread/message`, { text });
const sweep = (who: Id, ent: string, amount = 1) => call('POST', who, `/api/treasury/${ent}/sweep`, { amount });

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
    const insert = db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_ref, status)
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
    assert(WRITER_LIMITS.enterpriseWorkSignedWritesPerDay === 50_000 && WRITER_LIMITS.enterpriseWorkPostsPerDay === 1_000
        && M.enterpriseWorkPaymentsPerDay === 1_000 && M.enterpriseWorkNewRecipientsPerDay === 300 && M.enterpriseWorkMarketRequestsPerDay === 1_000,
        'one person\'s enterprise work, across every enterprise they keep, is one enterprise\'s worth');

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
        const sellaOther = plantPost(sella.pk, 'offer');
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
        refused(await request(ann, sellaOther), 'money_payments_day', /100 payments/, before, 'asking to buy another offer past it');
        const askedAgain = await request(ann, sellaOffer);
        assert(askedAgain.status === 200 && askedAgain.body?.transaction?.id === kinds[1][1].body?.transaction?.id && sameBooks(before, books()),
            `asking again for the offer her first ask still waits on is no new payment: that ask comes back and nothing moves (${show(askedAgain)})`);
        refused(await crowdfund(ann, project), 'money_payments_day', /100 payments/, before, 'a crowdfund pledge past it');
        assert(bal(ann.pk) === annBefore && bal(ben.pk) === benBefore, `neither balance moved (Ann ${annBefore}, Ben ${benBefore})`);
        await idNotText('a send past it', 'to', ben.pk, ann.pk, (to) => call('POST', ann, '/api/ledger/transfer', { to, amount: 1 }));
        await idNotText('a one-step buy past it', 'postId', sellaOffer, ann.pk, (postId) => call('POST', ann, '/api/marketplace/posts/accept', { postId, buyerPublicKey: ann.pk }));
        await idNotText('asking to buy past it', 'postId', sellaOffer, ann.pk, (postId) => call('POST', ann, '/api/marketplace/posts/request', { postId, buyerPublicKey: ann.pk }));
        const halAgain = plantRequest(annNeed, ann.pk, hal.pk);
        await idNotText('approving help on her own need past it', 'transactionId', halAgain, ann.pk,
            (transactionId) => call('POST', ann, '/api/marketplace/transactions/approve', { transactionId, authorPublicKey: ann.pk }));

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
        await idNotText('buying from a new seller', 'postId', newSellerOffer, dan.pk, (postId) => call('POST', dan, '/api/marketplace/posts/accept', { postId, buyerPublicKey: dan.pk }));
        await idNotText('asking to buy from a new seller', 'postId', newSellerOffer, dan.pk, (postId) => call('POST', dan, '/api/marketplace/posts/request', { postId, buyerPublicKey: dan.pk }));
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

        // Asking twice for the same offer (a double tap, or a retry after a timeout): one ask, counted once.
        const ivy = member('Ivy');
        plantPost(ivy.pk, 'offer');
        const ivyWants = plantPost(eve.pk, 'offer');
        sync();
        const kinds = (kind: string) => count('SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND kind = ?', ivy.pk, kind);
        const [first, second] = [await request(ivy, ivyWants), await request(ivy, ivyWants)];
        const rows = count(`SELECT COUNT(*) AS n FROM marketplace_transactions WHERE post_id = ? AND buyer_pubkey = ?`, ivyWants, ivy.pk);
        assert(first.status === 200 && second.status === 200 && second.body?.transaction?.id === first.body?.transaction?.id && rows === 1,
            `Ivy asks twice for the same offer: the same request comes back, one stored (${show(second)}, ${rows} rows)`);
        assert(kinds('request') === 1 && kinds('payment') === 1, `and it counts once: 1 request and 1 payment, not 2 (${kinds('request')}, ${kinds('payment')})`);
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
        // Applying to keep an enterprise with a pledge: it becomes her backing once the lead says yes.
        const lea = member('Lea');
        completedTrade(lea.pk, tradie.pk);
        sync();
        const loom = await enterprise(lea, 'Lea Loom');
        const applications = () => count('SELECT COUNT(*) AS n FROM enterprise_keeper_requests WHERE member_pubkey = ?', fay.pk);
        for (const field of ['pledgedBacking', 'amount', 'backing']) {
            const beforeApplying = books();
            refused(await call('POST', fay, `/api/enterprise/${loom}/keepers/request`, { [field]: 5 }), 'money_pledges_day', /20 pledges/, beforeApplying,
                `applying to keep Lea Loom with a pledge (${field})`);
        }
        assert(applications() === 0, 'and no application is stored');
        const noPledge = await call('POST', fay, `/api/treasury/${loom}/keepers/request`, { pledgedBacking: 0 });
        assert(noPledge.status === 200 && applications() === 1, `applying with no pledge still goes: it pledges nothing (${show(noPledge)})`);
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
        // Round 3 (the director, 2026-09-30): past its 1,000, a keeper's sweep is his own payment. Before, the 1,001st was
        // refused in Gus Grocer's words, and one keeper who spent a shop's day stopped every other.
        const past = await call('POST', gus, `/api/treasury/${y}/sweep`, { amount: 1 });
        assert(past.status === 200 && actsAs(y, 'payment') === M.enterprisePaymentsPerDay && ownFor(gus.pk, y, 'payment') === 1,
            `Gus Grocer's 1,000 are spent, so its 1,001st sweep is Gus's own payment, his 100th: its 1,000 took none of his (${show(past)}, ${actsAs(y, 'payment')} its own, ${ownFor(gus.pk, y, 'payment')} his for it)`);
        const beforeOwn = books();
        refused(await send(gus, ben.pk), 'money_payments_day', /You can make 100 payments/, beforeOwn, 'and his 101st, a send, is refused in his own words');
        const beforeSweep = books();
        refused(await call('POST', gus, `/api/treasury/${y}/sweep`, { amount: 1 }), 'money_payments_day', new RegExp(`You can make 100 payments[^]*${spentNote('Gus Grocer').source}`), beforeSweep,
            'and so is his next sweep, in his own words, naming Gus Grocer');

        // 1,000 approvals of requests on its offer (each buyer's Beans go into escrow: not the enterprise's payment).
        const offer = (await entOffer(gus, y)).body?.post?.id as string;
        const buyers = Array.from({ length: 11 }, (_v, i) => member(`Buyer ${i}`));
        sync();
        const asks = Array.from({ length: M.enterpriseMarketRequestsPerDay + 1 }, (_v, i) => plantRequest(offer, buyers[i % 11].pk, y));
        const approvals = await many(M.enterpriseMarketRequestsPerDay, 8, (i) => call('POST', gus, `/api/treasury/${y}/approve`, { transactionId: asks[i] }));
        assert(approvals.every(s => s === 200), `Gus approves 1,000 requests on Gus Grocer's offer, though it has made all its payments (${distinct(approvals)})`);
        const pastApproval = await call('POST', gus, `/api/treasury/${y}/approve`, { transactionId: asks[M.enterpriseMarketRequestsPerDay] });
        assert(pastApproval.status === 200 && actsAs(y, 'request') === M.enterpriseMarketRequestsPerDay && ownFor(gus.pk, y, 'request') === 1,
            `its 1,001st approval is Gus's own deal, and goes (round 3; before, 429 in Gus Grocer's words) (${show(pastApproval)})`);
        // At its 1,000 payments and its 1,000 approvals, a helper on its need: the approval's id must be text, at both doors.
        const yNeed = (await call('POST', gus, `/api/treasury/${y}/need`, { title: 'Stock the shelves', category: 'other', credits: 1, repeatable: true })).body?.post?.id as string;
        assert(!!yNeed, 'setup: Gus Grocer needs help');
        const yHelper = member('Shelf Helper', 0);
        sync();
        const yOffer = plantRequest(yNeed, y, yHelper.pk);
        for (const door of ['treasury', 'enterprise']) {
            await idNotText(`Gus Grocer paying a helper by /api/${door}/:id/approve`, 'transactionId', yOffer, y,
                (transactionId) => call('POST', gus, `/api/${door}/${y}/approve`, { transactionId }));
        }

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
        const pastHelper = await call('POST', zed, `/api/treasury/${z}/approve`, { transactionId: offers[M.enterpriseNewRecipientsPerDay] });
        assert(pastHelper.status === 200 && ownFor(zed.pk, z, 'payment') === 1 && actsAs(z, 'request') === M.enterpriseNewRecipientsPerDay + 1,
            `the 301st new helper is Zed's own payment and his own new person, and goes; the approval itself is still Zed Works' (round 3; before, 429 in its words) (${show(pastHelper)})`);
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
        // Round 3: past Max Market's 1,000, his posts for it count against his own 100, which are spent. Before, this was 429
        // enterprise_posts_per_day in its words.
        const overP = await entOffer(max, p);
        assert(overP.status === 429 && overP.body?.code === 'posts_per_day' && /You can put up 100 new posts/.test(overP.body?.error ?? '')
            && spentNote('Max Market').test(overP.body?.error ?? '') && typeof overP.body?.resetsAt === 'string',
            `the enterprise's 1,001st counts against his own 100, which are spent: 429 posts_per_day, in his words, naming Max Market (${show(overP)})`);
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
        // Round 3: past its 50,000, her writes for it count on her own day, which is spent. Before, 429 enterprise_day_budget.
        const past = await entOffer(quinn, r);
        assert(past.status === 429 && past.body?.code === 'day_budget' && /5,000 changes/.test(past.body?.error ?? '') && spentNote('This enterprise').test(past.body?.error ?? '') && !!past.headers.get('retry-after'),
            `its 50,001st counts on Quinn's own day, which is spent: 429 day_budget, in her words, saying the enterprise's is spent (${show(past)})`);
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

            // A commission: the link enterprise's payment, counted against it (Kit, its keeper, signs), and against Kit's
            // enterprise work, which he also spends on an enterprise of his own.
            const link = node.link!;
            const kiosk = (await callAt(node.base, 'POST', kit, '/api/enterprise', { name: 'Kit Kiosk', purpose: 'Kit Kiosk, a test enterprise' })).body?.publicKey as string;
            const funded = await callAt(node.base, 'POST', kit, '/api/ledger/transfer', { to: kiosk, amount: 5 });
            assert(!!kiosk && funded.status === 200, `setup: Kit starts Kit Kiosk and gives it 5 Beans (${show(funded)})`);
            const linkOutbound = () => (their.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE direction = 'outbound' AND buyer_pubkey = ?`).get(link) as { n: number }).n;
            const sweeps = await many(M.enterprisePaymentsPerDay - 1, 8, () => callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 }));
            assert(sweeps.every(s => s === 200), `Kit sweeps 999 from the link enterprise to the Commons (${distinct(sweeps)})`);
            const commissioned = await callAt(node.base, 'POST', kit, '/api/federation/commission', { postId: 'far-post' });
            assert(linkOutbound() === 1 && commissioned.status !== 429, `and commissions a listing from the other community: its settlement is there, the enterprise's 1,000th payment (${show(commissioned)}, ${linkOutbound()} outbound)`);
            const kioskSweep = await callAt(node.base, 'POST', kit, `/api/treasury/${kiosk}/sweep`, { amount: 1 });
            assert(kioskSweep.status === 429 && kioskSweep.body?.code === 'money_enterprise_work_payments_day',
                `and the commission was Kit's 1,000th payment for his enterprises: a sweep from Kit Kiosk, which has made none, is 429 money_enterprise_work_payments_day (${show(kioskSweep)})`);
            const kitOwn = await callAt(node.base, 'POST', kit, '/api/ledger/transfer', { to: ben.pk, amount: 1 });
            assert(kitOwn.status === 200, `the enterprise's 1,000 took none of Kit's: his own payment goes (${show(kitOwn)})`);
            // Round 3: past the link's 1,000, what Kit pays for it is his own payment (before, the next sweep and commission were
            // 429 in the link's words). His own: Kit Kiosk's 5 and the send above, then a sweep, 96 sends, and a commission.
            const ownRows = (kind: string) => their.prepare(`SELECT account, for_enterprise AS forEnt, settlement_key AS key FROM money_acts WHERE account = ? AND kind = ?`).all(kit.pk, kind) as { account: string; forEnt: string | null; key: string | null }[];
            const linkSweepOwn = await callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 });
            assert(linkSweepOwn.status === 200 && ownRows('payment').filter((r) => r.forEnt === link).length === 1,
                `the link's day is spent, so Kit's next sweep from it is his own payment, his 3rd, and goes (${show(linkSweepOwn)})`);
            const kitSends = await many(M.paymentsPerDay - 4, 8, () => callAt(node.base, 'POST', kit, '/api/ledger/transfer', { to: ben.pk, amount: 0.01 }));
            assert(kitSends.every(s => s === 200), `Kit makes 96 more of his own (${distinct(kitSends)})`);
            const ownCommission = await callAt(node.base, 'POST', kit, '/api/federation/commission', { postId: 'far-post' });
            const commissionRow = ownRows('payment').find((r) => r.key !== null);
            assert(ownCommission.status !== 429 && linkOutbound() === 2 && commissionRow?.forEnt === link,
                `so a commission now is his own 100th payment: it goes, the link's second settlement, and its row is Kit's own for the link (${show(ownCommission)}, ${linkOutbound()} outbound, ${JSON.stringify(commissionRow)})`);
            const linkBalance = r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(link) as { balance: number }).balance);
            const commissionPast = await callAt(node.base, 'POST', kit, '/api/federation/commission', { postId: 'far-post' });
            const linkAfter = r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(link) as { balance: number }).balance);
            assert(commissionPast.status === 429 && commissionPast.body?.code === 'money_payments_day' && /You can make 100 payments/.test(commissionPast.body?.error ?? '')
                && /has reached its own limit for today, so what you do for it counts against yours/.test(commissionPast.body?.error ?? '') && linkOutbound() === 2 && linkAfter === linkBalance,
                `and a commission past it is 429 money_payments_day in his own words, before anything moves: no new settlement, the same balance (${show(commissionPast)}, ${linkOutbound()}, ${linkAfter})`);
            const sweepPast = await callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 });
            assert(sweepPast.status === 429 && sweepPast.body?.code === 'money_payments_day' && /You can make 100 payments/.test(sweepPast.body?.error ?? ''),
                `so is the link's next sweep (${show(sweepPast)})`);
            // The link's count leaves out the commission Kit made as his own (purchasesToday; the round-4 review of #1329).
            // One of Kit's sweeps for the link leaves the day: the link is at 998 sweeps and 1 commission, 999, and so is Kit's
            // enterprise work. Counting his own commission's settlement too would read 1,000: the link spent, and the sweep his
            // own 101st payment, 429.
            their.prepare(`UPDATE money_acts SET made_at = ? WHERE rowid = (SELECT rowid FROM money_acts
                            WHERE account = ? AND keeper = ? AND kind = 'payment' AND settlement_key IS NULL ORDER BY made_at LIMIT 1)`).run(ago(DAY + HOUR), link, kit.pk);
            const linkActs = () => (their.prepare(`SELECT COUNT(*) AS n FROM money_acts WHERE account = ? AND kind = 'payment' AND made_at > ?`).get(link, ago(DAY)) as { n: number }).n;
            const linkActsBefore = linkActs();
            const roomAgain = await callAt(node.base, 'POST', kit, `/api/treasury/${link}/sweep`, { amount: 1 });
            assert(roomAgain.status === 200 && linkActs() === linkActsBefore + 1 && linkOutbound() === 2,
                `a sweep of Kit's for the link leaves the day, so the link has room again: his next sweep is the link's 1,000th and goes, as his own commission is his and not the link's (${show(roomAgain)}, link rows ${linkActsBefore} → ${linkActs()})`);
        } finally {
            their.close();
            await node.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── 10. One person's enterprise work, across every enterprise they keep ───────────────────────────────────
    console.log('\n--- 10. one person\'s enterprise work: one enterprise\'s worth across every enterprise they keep ---');
    {
        const W = WRITER_LIMITS;
        const mo = member('Mo');
        const nell = member('Nell');
        completedTrade(mo.pk, tradie.pk);
        completedTrade(nell.pk, tradie.pk);
        sync();
        const [a, b, c] = [await enterprise(mo, 'Mo Apples'), await enterprise(mo, 'Mo Bakes'), await enterprise(mo, 'Mo Cycles')];
        for (const e of [a, b, c]) setBalance(e, 5_000);
        adminAssignTreasuryOperator(a, nell.pk, owner.pk);
        assert((await entOffer(mo, a)).status === 200 && (await entOffer(mo, c)).status === 200, 'setup: Mo Apples and Mo Cycles list offers (a need needs one)');
        const needOf = async (e: string) => (await call('POST', mo, `/api/treasury/${e}/need`, { title: 'Help out', category: 'other', credits: 1, repeatable: true })).body?.post?.id as string;
        const [needA, needC] = [await needOf(a), await needOf(c)];
        assert(!!needA && !!needC, 'setup: and needs');

        // Writes. His own day spent, then 49,990 for his three together (20,000 + 20,000 + 9,990), as the gateway counts.
        resetGatewayRateLimit();
        gatewayWrites(mo.pk, W.signedWritesPerDay);
        const ownOver = await call('POST', mo, '/api/community/me/area', {});
        assert(ownOver.status === 429 && ownOver.body?.code === 'day_budget', `Mo's own day is spent: 429 day_budget (${show(ownOver)})`);
        gatewayWrites(mo.pk, 20_000, a);
        gatewayWrites(mo.pk, 20_000, b);
        gatewayWrites(mo.pk, W.enterpriseWorkSignedWritesPerDay - 40_000 - 10, c);
        const lines = await many(10, 1, () => line(mo, c));
        assert(lines.every(s => s === 201), `his lines in Mo Cycles' thread take his three to 50,000 (${distinct(lines)})`);
        for (const [name, e] of [['Mo Apples', a], ['Mo Bakes', b], ['Mo Cycles', c]] as const) {
            const over = await line(mo, e);
            assert(over.status === 429 && over.body?.code === 'enterprise_work_day_budget' && /50,000 changes today for the enterprises you keep/.test(over.body?.error ?? '') && !!over.headers.get('retry-after'),
                `then a write for ${name} is 429 enterprise_work_day_budget, in his words: 50,000 for all three, not 3 × 50,000 (${show(over)})`);
        }
        const nellWrites = await line(nell, a);
        assert(nellWrites.status === 201, `Mo Apples still has room: Nell, its other keeper, writes for it (${show(nellWrites)})`);
        resetGatewayRateLimit();

        // Posts: what he put up for the three, to 999, then one more for Mo Cycles, then none for Mo Apples.
        const have = postsForEnterprises(mo.pk);
        const toFill = W.enterpriseWorkPostsPerDay - 1 - have;
        entPosts(a, mo.pk, 400);
        entPosts(b, mo.pk, 400);
        entPosts(c, mo.pk, toFill - 800);
        const thousandth = await entOffer(mo, c);
        assert(thousandth.status === 200, `his 1,000th post for his enterprises goes, for Mo Cycles (${show(thousandth)})`);
        const postOver = await entOffer(mo, a);
        assert(postOver.status === 429 && postOver.body?.code === 'enterprise_work_posts_per_day' && /1,000 new posts in any 24 hours for the enterprises you keep/.test(postOver.body?.error ?? '') && typeof postOver.body?.resetsAt === 'string',
            `his next, for Mo Apples, is 429 enterprise_work_posts_per_day though it has put up ${count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', a)} (${show(postOver)})`);
        const nellPosts = await entOffer(nell, a);
        assert(nellPosts.status === 200, `Nell still puts one up for Mo Apples (${show(nellPosts)})`);
        const moOwnPost = await ownPost(mo);
        assert(moOwnPost.status === 200, `and his own posts are apart (${show(moOwnPost)})`);

        // New people: 299 new to Mo Apples or Mo Bakes, then a helper new to Mo Cycles (300), then none new to Mo Apples.
        newPeoplePaid(a, mo.pk, 150);
        newPeoplePaid(b, mo.pk, M.enterpriseWorkNewRecipientsPerDay - 1 - 150);
        const [h1, h2] = [member('Helper One', 0), member('Helper Two', 0)];
        sync();
        const paysH1 = await call('POST', mo, `/api/treasury/${c}/approve`, { transactionId: plantRequest(needC, c, h1.pk) });
        assert(paysH1.status === 200, `the 300th person new to his enterprises goes: Mo Cycles pays Helper One (${show(paysH1)})`);
        const h2Ask = plantRequest(needA, a, h2.pk);
        const beforeNew = books();
        refused(await call('POST', mo, `/api/treasury/${a}/approve`, { transactionId: h2Ask }), 'money_enterprise_work_new_recipients_day',
            /300 people new to the enterprises you keep/, beforeNew, 'the 301st, Mo Apples paying Helper Two (it has paid 150 new people)');
        const nellPaysH2 = await call('POST', nell, `/api/treasury/${a}/approve`, { transactionId: h2Ask });
        assert(nellPaysH2.status === 200, `Nell pays Helper Two for Mo Apples (${show(nellPaysH2)})`);

        // Payments: his 300 so far, 699 more across the three (233 each), then a sweep for Mo Cycles, then none for Mo Apples.
        for (const e of [a, b, c]) moneyActs(e, mo.pk, 233, 'payment');
        const sweepC = await sweep(mo, c);
        assert(sweepC.status === 200, `his 1,000th payment for his enterprises goes: a sweep from Mo Cycles (${show(sweepC)})`);
        const beforePay = books();
        refused(await sweep(mo, a), 'money_enterprise_work_payments_day', /1,000 payments in any 24 hours for the enterprises you keep/, beforePay,
            'his next, a sweep from Mo Apples (which has made under 400)');
        const nellSweeps = await sweep(nell, a);
        const moOwnPays = await send(mo, tradie.pk);
        assert(nellSweeps.status === 200 && moOwnPays.status === 200, `Nell still sweeps from Mo Apples, and Mo's own payments are apart (${show(nellSweeps)}, ${show(moOwnPays)})`);

        // Approvals: his 1 so far (Helper One), 998 more across the three, then one for Mo Cycles, then none for Mo Apples.
        moneyActs(a, mo.pk, 333, 'request');
        moneyActs(b, mo.pk, 333, 'request');
        moneyActs(c, mo.pk, 332, 'request');
        const buyer = member('Buyer Mo');
        sync();
        const offerA = (db.prepare(`SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer' ORDER BY created_at LIMIT 1`).get(a) as { id: string }).id;
        const offerC = (db.prepare(`SELECT id FROM posts WHERE author_pubkey = ? AND type = 'offer' ORDER BY created_at LIMIT 1`).get(c) as { id: string }).id;
        const approvesC = await call('POST', mo, `/api/treasury/${c}/approve`, { transactionId: plantRequest(offerC, buyer.pk, c) });
        assert(approvesC.status === 200, `his 1,000th approval for his enterprises goes, on Mo Cycles' offer (${show(approvesC)})`);
        const askA = plantRequest(offerA, buyer.pk, a);
        const beforeApprove = books();
        refused(await call('POST', mo, `/api/treasury/${a}/approve`, { transactionId: askA }), 'money_enterprise_work_requests_day',
            /approve 1,000 deals in any 24 hours for the enterprises you keep/, beforeApprove, 'his next, on Mo Apples\' offer');
        const nellApproves = await call('POST', nell, `/api/treasury/${a}/approve`, { transactionId: askA });
        assert(nellApproves.status === 200, `Nell approves it (${show(nellApproves)})`);
    }

    // ── 11. A shop with 2 keepers still gets its whole allowance ──────────────────────────────────────────────
    console.log('\n--- 11. a shop with 2 keepers gets its whole allowance, each keeper\'s share on their own ceiling ---');
    {
        const W = WRITER_LIMITS;
        const pia = member('Pia');
        const quin = member('Quin');
        completedTrade(pia.pk, tradie.pk);
        sync();
        const shop = await enterprise(pia, 'Pia Pantry');
        const other = await enterprise(pia, 'Pia Plants');
        for (const e of [shop, other]) setBalance(e, 5_000);
        adminAssignTreasuryOperator(shop, quin.pk, owner.pk);

        resetGatewayRateLimit();
        gatewayWrites(pia.pk, W.enterpriseSignedWritesPerDay / 2, shop);
        gatewayWrites(quin.pk, W.enterpriseSignedWritesPerDay / 2 - 1, shop);
        const quinLast = await line(quin, shop);
        assert(quinLast.status === 201, `Pia's 25,000 and Quin's 24,999 writes, then Quin's line: Pia Pantry's 50,000th goes (${show(quinLast)})`);
        // Round 3: past its 50,000, each keeper's writes for it count on their own day (before, 429 enterprise_day_budget).
        const [piaPast, quinPast] = [await line(pia, shop), await line(quin, shop)];
        assert(piaPast.status === 201 && quinPast.status === 201, `then Pia's line and Quin's count on their own days, and go (${show(piaPast)}, ${show(quinPast)})`);
        const piaElsewhere = await line(pia, other);
        assert(piaElsewhere.status === 201, `Pia's half counted to her own ceiling: she still writes for Pia Plants (${show(piaElsewhere)})`);
        resetGatewayRateLimit();

        moneyActs(shop, pia.pk, M.enterprisePaymentsPerDay / 2, 'payment');
        moneyActs(shop, quin.pk, M.enterprisePaymentsPerDay / 2 - 1, 'payment');
        const quinSweeps = await sweep(quin, shop);
        assert(quinSweeps.status === 200, `500 payments by Pia and 499 by Quin, then Quin's sweep: its 1,000th goes (${show(quinSweeps)})`);
        const piaPastSweep = await sweep(pia, shop);
        assert(piaPastSweep.status === 200 && actsAs(shop, 'payment') === M.enterprisePaymentsPerDay && ownFor(pia.pk, shop, 'payment') === 1,
            `then Pia's sweep is her own payment, and goes; the shop still has its 1,000 (round 3; before, 429 in its words) (${show(piaPastSweep)})`);
        const piaSweepsOther = await sweep(pia, other);
        assert(piaSweepsOther.status === 200, `and Pia still sweeps from Pia Plants (${show(piaSweepsOther)})`);

        entPosts(shop, pia.pk, W.enterprisePostsPerDay / 2);
        entPosts(shop, quin.pk, W.enterprisePostsPerDay / 2 - 1);
        const quinPosts = await entOffer(quin, shop);
        assert(quinPosts.status === 200, `500 posts by Pia and 499 by Quin, then Quin's: its 1,000th goes (${show(quinPosts)})`);
        const piaPastPost = await entOffer(pia, shop);
        assert(piaPastPost.status === 200 && postsAs(shop) === W.enterprisePostsPerDay && count('SELECT COUNT(*) AS n FROM keeper_own_posts WHERE keeper = ?', pia.pk) === 1,
            `then Pia's post counts against her own 100, and goes; the shop still has its 1,000 (round 3; before, 429 enterprise_posts_per_day) (${show(piaPastPost)})`);
        const piaPostsOther = await entOffer(pia, other);
        assert(piaPostsOther.status === 200, `and Pia still puts one up for Pia Plants (${show(piaPostsOther)})`);
    }

    // ── 12. The enterprise thread is a chat ───────────────────────────────────────────────────────────────────
    console.log('\n--- 12. the enterprise thread: 30 lines a minute per person ---');
    {
        const kip = member('Kip');
        const sam = member('Sam');
        const tia = member('Tia');
        completedTrade(kip.pk, tradie.pk);
        sync();
        const t = await enterprise(kip, 'Kip Kitchen');
        const lines = await many(WRITER_LIMITS.chatLinesPerMinute, 1, () => line(sam, t));
        assert(lines.every(s => s === 201), `Sam posts 30 lines in Kip Kitchen's thread in a minute (${distinct(lines)})`);
        const ids = (db.prepare(`SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'enterprise_thread' AND m.author_pubkey = ? LIMIT 2`)
            .all(sam.pk) as { id: string }[]).map((r) => r.id);
        const stored = count(`SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?`, sam.pk);
        const over = await line(sam, t);
        assert(over.status === 429 && over.body?.code === 'chat_rate' && !!over.headers.get('retry-after'), `the 31st is 429 chat_rate (${show(over)})`);
        assert(count(`SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?`, sam.pk) === stored, 'and is not stored');
        const tiaPosts = await line(tia, t);
        assert(tiaPosts.status === 201, `another member still posts (${show(tiaPosts)})`);
        const kipLines = await many(WRITER_LIMITS.chatLinesPerMinute - 1, 1, () => line(kip, t));
        const removed = await call('POST', kip, `/api/treasury/${t}/thread/remove`, { messageId: ids[0] });
        const removedOver = await call('POST', kip, `/api/treasury/${t}/thread/remove`, { messageId: ids[1] });
        assert(kipLines.every(s => s === 201) && removed.status === 200 && removedOver.status === 429 && removedOver.body?.code === 'chat_rate',
            `a keeper's removals share his 30: 29 lines and a removal go, the next removal is 429 chat_rate (${distinct(kipLines)}, ${show(removed)}, ${show(removedOver)})`);
    }

    // ── 13. A restart keeps one person's enterprise work ──────────────────────────────────────────────────────
    console.log('\n--- 13. a restart keeps one person\'s enterprise work ---');
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-limits-work-restart-'));
        const moe = newId('Moe');
        const seed: Seed = { owner: newId('Owner').pk, tradie: newId('Tradie').pk, members: [{ pk: moe.pk, name: 'Moe', balance: 1_000, trades: true }] };
        const one = await startNode(dir, seed);
        let two: Node | null = null;
        try {
            const start = async (name: string) => {
                const r = await callAt(one.base, 'POST', moe, '/api/enterprise', { name, purpose: `${name}, a test enterprise` });
                if (!r.body?.publicKey) throw new Error(`setup: Moe could not start ${name}: ${show(r)}`);
                const funded = await callAt(one.base, 'POST', moe, '/api/ledger/transfer', { to: r.body.publicKey, amount: 20 });
                if (funded.status !== 200) throw new Error(`setup: Moe could not fund ${name}: ${show(funded)}`);
                return r.body.publicKey as string;
            };
            const [x, y] = [await start('Moe Mill'), await start('Moe Mart')];
            const sweepsAt = (node: Node, e: string, n: number) => many(n, 8, () => callAt(node.base, 'POST', moe, `/api/treasury/${e}/sweep`, { amount: 0.01 }));
            const before = [...await sweepsAt(one, x, 300), ...await sweepsAt(one, y, 300)];
            assert(before.every(s => s === 200), `Moe sweeps 300 from each of his two enterprises (${distinct(before)})`);
            await one.kill();
            two = await startNode(dir, seed);
            const after = [...await sweepsAt(two, x, 200), ...await sweepsAt(two, y, 200)];
            assert(after.every(s => s === 200), `killed (SIGKILL) and booted again on the same data, it takes 200 more from each: 1,000 for the two (${distinct(after)})`);
            const past = await callAt(two.base, 'POST', moe, `/api/treasury/${x}/sweep`, { amount: 0.01 });
            assert(past.status === 429 && past.body?.code === 'money_enterprise_work_payments_day',
                `and refuses his 1,001st, from Moe Mill, which has made only 500: the restart kept his enterprise work (${show(past)})`);
        } finally {
            if (two) await two.stop(); else await one.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── 14. One keeper can't lock the others out of a shop ────────────────────────────────────────────────────
    console.log('\n--- 14. a keeper who spends a shop\'s day blocks only themselves: past it, each keeper\'s acts for it count on their own limits ---');
    {
        const W = WRITER_LIMITS;
        const lea = member('Leah');
        const rex = member('Rex');
        const hugo = member('Hugo', 0);
        const hana = member('Hana', 0);
        const ivo = member('Ivo', 0);
        const bea = member('Bea');
        completedTrade(lea.pk, tradie.pk);
        sync();
        const shop = await enterprise(lea, 'Leah Linens');
        const loft = await enterprise(lea, 'Leah Loft');
        setBalance(shop, 5_000);
        adminAssignTreasuryOperator(shop, rex.pk, owner.pk);
        const total = nodeTotal();
        // A job the shop funded before Rex spent its day: Hugo helps on its need and Leah approves, its 5 Beans into escrow.
        const need = plantPost(shop, 'need', 5);
        const offer = plantPost(shop, 'offer', 1);
        const job = plantRequest(need, shop, hugo.pk, 5);
        const funded = await call('POST', lea, `/api/treasury/${shop}/approve`, { transactionId: job });
        assert(funded.status === 200, `setup: Leah approves Hugo's help on Leah Linens' need, and the shop pays 5 into escrow (${show(funded)})`);
        const hanaAsks = plantRequest(need, shop, hana.pk, 5);
        const ivoAsks = plantRequest(need, shop, ivo.pk, 5);
        const leaForShop = count('SELECT COUNT(*) AS n FROM money_acts WHERE keeper = ?', lea.pk);

        // Rex spends the shop's posts, payments, approvals and writes, each last one his over HTTPS.
        entPosts(shop, rex.pk, W.enterprisePostsPerDay - postsAs(shop) - 1);
        const rexPosts = await entOffer(rex, shop);
        moneyActs(shop, rex.pk, M.enterprisePaymentsPerDay - actsAs(shop, 'payment') - 1, 'payment');
        const rexSweeps = await sweep(rex, shop, 0.0001);
        moneyActs(shop, rex.pk, M.enterpriseMarketRequestsPerDay - actsAs(shop, 'request') - 1, 'request');
        const rexApproves = await call('POST', rex, `/api/treasury/${shop}/approve`, { transactionId: plantRequest(offer, bea.pk, shop) });
        resetGatewayRateLimit();
        gatewayWrites(rex.pk, W.enterpriseSignedWritesPerDay - 1, shop);
        const rexLine = await line(rex, shop);
        assert(rexPosts.status === 200 && rexSweeps.status === 200 && rexApproves.status === 200 && rexLine.status === 201,
            `Rex, its second keeper, puts up its 1,000th post and makes its 1,000th payment, approval and write (${show(rexPosts)}, ${show(rexSweeps)}, ${show(rexApproves)}, ${show(rexLine)})`);
        const shopDay = () => JSON.stringify([postsAs(shop), actsAs(shop, 'payment'), actsAs(shop, 'request')]);
        const spent = shopDay();

        // Leah's acts for it now count on her own limits, and go: a sweep, paying Ivo (new to the shop) for his help, a
        // post and a line in its thread.
        const leaSweep = await sweep(lea, shop);
        const leaPaysIvo = await call('POST', lea, `/api/treasury/${shop}/approve`, { transactionId: ivoAsks });
        const leaPost = await entOffer(lea, shop);
        const leaLine = await line(lea, shop);
        assert(leaSweep.status === 200 && leaPaysIvo.status === 200 && leaPost.status === 200 && leaLine.status === 201,
            `Leah still sweeps, pays Ivo for his help, posts and writes in the thread for it (${show(leaSweep)}, ${show(leaPaysIvo)}, ${show(leaPost)}, ${show(leaLine)})`);
        assert(ownFor(lea.pk, shop, 'payment') === 2 && ownFor(lea.pk, shop, 'request') === 1 && count('SELECT COUNT(*) AS n FROM keeper_own_posts WHERE keeper = ?', lea.pk) === 1
            && shopDay() === spent && count('SELECT COUNT(*) AS n FROM money_acts WHERE keeper = ?', lea.pk) === leaForShop,
            `each counted as her own (2 payments, 1 approval, 1 post), not the shop's (${spent} → ${shopDay()}) and not her enterprise work`);

        // Up to her own limits, then each is refused in her own words, naming the shop, and moves nothing.
        ownActs(lea.pk, M.newRecipientsPerDay - 1, 'payment', true);
        let before = books();
        refused(await call('POST', lea, `/api/treasury/${shop}/approve`, { transactionId: hanaAsks }), 'money_new_recipients_day',
            new RegExp(`You can pay 30 people you have never paid before[^]*${spentNote('Leah Linens').source}`), before, 'with Ivo and 29 more, her 31st new person, paying Hana for the shop');
        ownActs(lea.pk, M.paymentsPerDay - actsAs(lea.pk, 'payment'), 'payment');
        before = books();
        refused(await sweep(lea, shop), 'money_payments_day', new RegExp(`You can make 100 payments[^]*${spentNote('Leah Linens').source}`), before, 'her 101st payment, a sweep for the shop');
        ownActs(lea.pk, M.marketRequestsPerDay - actsAs(lea.pk, 'request'), 'request');
        const beaOrders = plantRequest(offer, bea.pk, shop);
        before = books();
        refused(await call('POST', lea, `/api/treasury/${shop}/approve`, { transactionId: beaOrders }), 'money_requests_day',
            new RegExp(`You can ask for, accept or approve 100 deals[^]*${spentNote('Leah Linens').source}`), before, 'her 101st deal, approving Bea\'s order for the shop');
        ownPosts(lea.pk, W.postsPerDay - 1);
        before = books();
        refused(await entOffer(lea, shop), 'posts_per_day', new RegExp(`You can put up 100 new posts[^]*${spentNote('Leah Linens').source}`), before, 'her 101st post, for the shop');
        const leaOwnPost = await ownPost(lea);
        assert(leaOwnPost.status === 429 && leaOwnPost.body?.code === 'posts_per_day' && !spentNote('Leah Linens').test(leaOwnPost.body?.error ?? ''),
            `and her own post is refused too, in her words alone: the shop's took from her 100 (${show(leaOwnPost)})`);

        // Rex, once the shop's day is spent, has his own limits for it too, and no more.
        ownPosts(rex.pk, W.postsPerDay - 1);
        ownActs(rex.pk, M.paymentsPerDay - 1, 'payment');
        ownActs(rex.pk, M.marketRequestsPerDay - 1, 'request');
        const [rexPost100, rexSweep100, rexDeal100] = [await entOffer(rex, shop), await sweep(rex, shop, 0.0001),
            await call('POST', rex, `/api/treasury/${shop}/approve`, { transactionId: plantRequest(offer, bea.pk, shop) })];
        assert(rexPost100.status === 200 && rexSweep100.status === 200 && rexDeal100.status === 200,
            `Rex, 1 short of his own 100 posts, payments and deals, makes each one more for the shop (${show(rexPost100)}, ${show(rexSweep100)}, ${show(rexDeal100)})`);
        const beaAgain = plantRequest(offer, bea.pk, shop);
        before = books();
        const his = (words: string) => new RegExp(`${words}[^]*${spentNote('Leah Linens').source}`);
        refused(await entOffer(rex, shop), 'posts_per_day', his('You can put up 100 new posts'), before, 'then his post for it is refused in his own words');
        refused(await sweep(rex, shop, 0.0001), 'money_payments_day', his('You can make 100 payments'), before, 'his sweep');
        refused(await call('POST', rex, `/api/treasury/${shop}/approve`, { transactionId: beaAgain }), 'money_requests_day', his('You can ask for, accept or approve 100 deals'), before, 'and his approval');
        assert(shopDay() === spent, `and the shop's own day took none of theirs (${spent} → ${shopDay()})`);

        // Writes, afresh: Rex spends the shop's 50,000 (all his enterprise work too). Leah's and Rex's writes for it then
        // count on their own days: each one line, then 4,999 more of their own, then day_budget naming the enterprise.
        resetGatewayRateLimit();
        gatewayWrites(rex.pk, W.enterpriseSignedWritesPerDay, shop);
        for (const who of [lea, rex]) {
            const first = await line(who, shop);
            const more = fillOwnDay(who.pk);
            before = books();
            assert(first.status === 201 && more === W.signedWritesPerDay - 1,
                `${who.name}'s line for the shop goes on their own day, and ${W.signedWritesPerDay - 1} more of their own fill it (${show(first)}, ${more})`);
            refused(await line(who, shop), 'day_budget', new RegExp(`You have made 5,000 changes today[^]*${spentNote('This enterprise').source}`), before, `then ${who.name}'s next line for it`);
        }
        const leaLoft = await line(lea, loft);
        assert(leaLoft.status === 201, `none of it was Leah's enterprise work: she still writes for Leah Loft (${show(leaLoft)})`);

        // Governance and settling (fix round 2), on her own day still: afresh, the shop's day spent by Rex, Leah's own day
        // 6 short, her enterprise work 1 short (writes for Leah Loft), and her own payments spent.
        resetGatewayRateLimit();
        gatewayWrites(rex.pk, W.enterpriseSignedWritesPerDay, shop);
        const governance = 6;
        gatewayWrites(lea.pk, W.signedWritesPerDay - governance);
        gatewayWrites(lea.pk, W.enterpriseWorkSignedWritesPerDay - 1, loft);
        assert(actsAs(lea.pk, 'payment') === M.paymentsPerDay, `setup: Leah's own 100 payments are spent (${actsAs(lea.pk, 'payment')})`);

        const hugoBefore = bal(hugo.pk);
        const completed = await call('POST', lea, `/api/treasury/${shop}/complete`, { transactionId: job });
        assert(completed.status === 200 && completed.body?.transaction?.status === 'completed' && bal(hugo.pk) > hugoBefore,
            `Leah completes the job the shop funded, and Hugo is paid from its escrow: no money limit refuses settling (${show(completed)}, Hugo ${hugoBefore} → ${bal(hugo.pk)})`);
        const rejected = await call('POST', lea, `/api/treasury/${shop}/reject/`, { transactionId: hanaAsks });
        assert(rejected.status === 200, `she turns Hana's request down (${show(rejected)})`);
        const removed = await call('POST', lea, `/api/enterprise/${shop}/keepers/${rex.pk}/remove`, {});
        assert(removed.status === 200 && removed.body?.success === true, `she removes Rex (${show(removed)})`);
        console.log(`  (the removal is a keeper change like any other: applied ${removed.body?.applied}, it applies at ${removed.body?.change?.appliesAt}, after its objection window)`);
        const paused = await call('POST', lea, `/api/enterprise/${shop}/pause`, {});
        assert(paused.status === 200 && paused.body?.paused === true, `she pauses it (${show(paused)})`);
        const resumed = await call('POST', lea, `/api/treasury/${shop}/resume`, {});
        assert(resumed.status === 200 && resumed.body?.paused === false, `and resumes it (${show(resumed)})`);
        const windUp = await call('POST', lea, `/api/enterprise/${shop}/wind-up/initiate`, {});
        assert(windUp.status === 200 && windUp.body?.status === 'winding_up', `she starts winding it up (${show(windUp)})`);

        const leaOwn = await call('POST', lea, '/api/community/me/area', {});
        assert(leaOwn.status === 429 && leaOwn.body?.code === 'day_budget',
            `those ${governance} writes counted on Leah's own day: her next own write is 429 day_budget (${show(leaOwn)})`);
        const leaLoftAgain = await line(lea, loft);
        assert(leaLoftAgain.status === 201, `and not on her enterprise work: she still writes for Leah Loft (${show(leaLoftAgain)})`);
        assert(nodeTotal() === total, `the node's total is what it was: nothing refused moved a bean (${total} → ${nodeTotal()})`);
        resetGatewayRateLimit();
    }

    // ── 15. A crowdfund project's id is the server's ──────────────────────────────────────────────────────────
    console.log('\n--- 15. a crowdfund project\'s id is made by the server: never a person, an enterprise, the Commons or an escrow ---');
    {
        const mal = member('Mallory');
        const vic = member('Victor', 10);
        const vera = member('Vera');
        const sal = member('Sal', 0);
        const wendy = member('Wendy', 0);
        for (const who of [mal, vic, vera]) { completedTrade(who.pk, tradie.pk); plantPost(who.pk, 'offer'); }
        sync();
        const vats = await enterprise(vera, 'Vera Vats');
        setBalance(vats, 50);
        // A deal whose buyer's Beans are held in trust: its escrow account, escrow_<the deal's id>, holds 4.
        const bought = await accept(vic, plantPost(sal.pk, 'offer', 4, false));
        const deal = bought.body?.transaction?.id as string;
        assert(bal(`escrow_${deal}`) === 4, `setup: Victor buys from Sal, and 4 Beans wait in the deal's escrow (${show(bought)})`);

        const statusOf = (pk: string) => (db.prepare('SELECT status FROM members WHERE public_key = ?').get(pk) as { status: string } | undefined)?.status;
        const rowOf = (pk: string) => JSON.stringify(db.prepare('SELECT callsign, bio, is_treasury, status, goal_amount FROM members WHERE public_key = ?').get(pk) ?? null);
        const state = () => JSON.stringify({
            books: books(), projects: count('SELECT COUNT(*) AS n FROM projects'), keepers: count('SELECT COUNT(*) AS n FROM treasury_operators'),
            vic: rowOf(vic.pk), wendy: rowOf(wendy.pk), vats: rowOf(vats), commons: rowOf('COMMONS_POOL'), escrow: bal(`escrow_${deal}`),
        });
        const start = (id: unknown, goalAmount = 1) => call('POST', mal, '/api/crowdfund/projects', { id, title: `Mallory fund ${++seq}`, description: 'For me', goalAmount });

        const before = state();
        const ids: [string, string][] = [
            ['Victor\'s key', vic.pk], ['Vera Vats\' treasury', vats], ['the Commons', 'COMMONS_POOL'],
            ['the deal\'s id, whose escrow holds 4', deal], ['a fresh id of the caller\'s choosing', crypto.randomUUID()],
        ];
        for (const [what, id] of ids) {
            const made = await start(id);
            assert(made.status === 400 && /made by the server/.test(made.body?.error ?? ''), `a project with ${what} as its id is refused, in words (${show(made)})`);
            const pledged = await crowdfund(mal, id);
            assert(pledged.status === 400, `and Mallory's pledge of 1 to it is refused (${show(pledged)})`);
        }
        const after = state();
        assert(after === before, `nothing moved and no status changed: no balance, escrow, project, keeper or member row (${before} → ${after})`);
        assert(statusOf(vic.pk) === 'active' && statusOf(vats) === 'active', `Victor and Vera Vats are still active (${statusOf(vic.pk)}, ${statusOf(vats)})`);
        // The same below the route, for any caller: createCrowdfundProject takes only an id nothing else has.
        const refusals = [vic.pk, vats, 'COMMONS_POOL', deal, `escrow_${deal}`].map((id) => {
            try { createCrowdfundProject(id, mal.pk, 'Mallory fund', 'For me', [], 1, null); return 'made'; } catch (e: any) { return String(e?.message); }
        });
        assert(refusals.every((m) => /an id nothing else has/.test(m)) && state() === before,
            `and createCrowdfundProject refuses each of them, and the deal's escrow's own name, writing nothing (${refusals.join(' | ')})`);

        // A projects row under a person's key, as the route wrote one before it made ids itself: nothing reaches it.
        const plantBadProject = (pk: string) => db.prepare(`INSERT OR REPLACE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
            VALUES (?, ?, 'Mallory fund', 'For me', '[]', 1, NULL, 'ACTIVE', ?, ?, ?, ?)`).run(pk, mal.pk, new Date().toISOString(), pk, new Date().toISOString(), new Date().toISOString());
        plantBadProject(vic.pk);
        plantBadProject(wendy.pk);
        const planted = state();
        const oldPledge = await crowdfund(mal, vic.pk);
        const oldDoor = await call('POST', mal, `/api/treasury/${vic.pk}/pledge`, { amount: 1, memo: 'For you' });
        const oldEdit = await call('POST', mal, '/api/crowdfund/projects/update', { id: vic.pk, title: 'Renamed', description: 'Mine now', goalAmount: 1 });
        const oldDelete = await call('POST', mal, '/api/crowdfund/projects/delete', { id: wendy.pk });
        assert(oldPledge.status === 400 && oldDoor.status >= 400 && oldEdit.status === 400 && oldDelete.status === 400,
            `a projects row made before, under Victor's or Wendy's key: pledging at either door, editing it and deleting it are all refused (${show(oldPledge)}, ${show(oldDoor)}, ${show(oldEdit)}, ${show(oldDelete)})`);
        assert(state() === planted && statusOf(vic.pk) === 'active' && statusOf(wendy.pk) === 'active',
            `and Victor is not paid, renamed or funded, and Wendy is not pruned (${planted} → ${state()})`);
        db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(vic.pk, wendy.pk);

        // A project as the apps would start one: no id sent. The server makes it, and it is funded into its own account.
        const made = await start(undefined, 3);
        const pid = made.body?.project?.id as string;
        assert(made.status === 200 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pid ?? '')
            && (db.prepare('SELECT is_treasury, lifecycle FROM members WHERE public_key = ?').get(pid) as any)?.lifecycle === 'bounded',
            `a project with no id is made, and the server gives it a new one, its own enterprise (${show(made)})`);
        const vicBefore = bal(vic.pk);
        const first = await crowdfund(vic, pid, 1);
        const second = await crowdfund(mal, pid, 2);
        assert(first.status === 200 && second.status === 200 && bal(pid) === 3 && statusOf(pid) === 'funded' && bal(vic.pk) === r4(vicBefore - 1),
            `pledges of 1 and 2 fund it: its own account holds 3 and it is funded (${show(first)}, ${show(second)}, ${bal(pid)}, ${statusOf(pid)})`);
        assert(statusOf(vic.pk) === 'active' && statusOf(mal.pk) === 'active', `and its backers are still active (${statusOf(vic.pk)}, ${statusOf(mal.pk)})`);
    }

    // ── 16. One person's ceiling still holds across three shops, one of them spent ────────────────────────────
    console.log('\n--- 16. one person\'s enterprise work across three shops, one spent: one enterprise\'s worth and their own, no more ---');
    {
        const W = WRITER_LIMITS;
        const noor = member('Noor');
        const oli = member('Oli');
        completedTrade(noor.pk, tradie.pk);
        sync();
        const [a, b, c] = [await enterprise(noor, 'Noor Acres'), await enterprise(noor, 'Noor Bakes'), await enterprise(noor, 'Noor Cider')];
        for (const e of [a, b, c]) setBalance(e, 5_000);
        adminAssignTreasuryOperator(b, oli.pk, owner.pk);
        const total = nodeTotal();

        // Writes: Noor spends Noor Acres' whole day herself, which is also all her enterprise work.
        resetGatewayRateLimit();
        gatewayWrites(noor.pk, W.enterpriseSignedWritesPerDay, a);
        for (const [name, e] of [['Noor Bakes', b], ['Noor Cider', c]] as const) {
            const over = await line(noor, e);
            assert(over.status === 429 && over.body?.code === 'enterprise_work_day_budget', `a write for ${name}, which has room, is 429 enterprise_work_day_budget: her ceiling holds (${show(over)})`);
        }
        const forA = await line(noor, a);
        const more = fillOwnDay(noor.pk);
        assert(forA.status === 201 && more === W.signedWritesPerDay - 1, `for Noor Acres, spent, her line goes on her own day, and ${W.signedWritesPerDay - 1} more of her own fill it (${show(forA)}, ${more})`);
        let before = books();
        refused(await line(noor, a), 'day_budget', spentNote('This enterprise'), before, 'then her next for Noor Acres');
        const oliWrites = await line(oli, b);
        assert(oliWrites.status === 201, `so she made 50,000 for her three and 5,000 of her own, no more; Oli still writes for Noor Bakes (${show(oliWrites)})`);
        resetGatewayRateLimit();

        // Payments: the same with sweeps.
        moneyActs(a, noor.pk, M.enterprisePaymentsPerDay, 'payment');
        for (const [name, e] of [['Noor Bakes', b], ['Noor Cider', c]] as const) {
            before = books();
            refused(await sweep(noor, e), 'money_enterprise_work_payments_day', /1,000 payments in any 24 hours for the enterprises you keep/, before, `a sweep from ${name}, which has room`);
        }
        const sweepA = await sweep(noor, a);
        ownActs(noor.pk, M.paymentsPerDay - actsAs(noor.pk, 'payment'), 'payment');
        before = books();
        assert(sweepA.status === 200 && ownFor(noor.pk, a, 'payment') === 1, `from Noor Acres, spent, her sweep is her own payment and goes (${show(sweepA)})`);
        refused(await sweep(noor, a), 'money_payments_day', new RegExp(`You can make 100 payments[^]*${spentNote('Noor Acres').source}`), before, 'and past her own 100, her next from Noor Acres');
        const oliSweeps = await sweep(oli, b);
        assert(oliSweeps.status === 200, `Oli still sweeps from Noor Bakes (${show(oliSweeps)})`);
        assert(nodeTotal() === total, `the node's total is what it was (${total} → ${nodeTotal()})`);
    }

    // ── 17. Past a spent shop's day: whose count each act lands on (the round-4 review of #1329) ──────────────────
    console.log('\n--- 17. past a spent shop\'s day: new means new to the shop, and a keeper\'s own posts leave the shop\'s count and their enterprise work ---');
    {
        const W = WRITER_LIMITS;
        // New people (money-limits.ts judge): past the shop's day, a keeper's payment from it to someone the SHOP has never
        // paid is one of the keeper's own new people, though the keeper paid them personally before.
        const kay = member('Kay');
        const otto = member('Otto');
        completedTrade(kay.pk, tradie.pk);
        const regulars = Array.from({ length: 40 }, (_v, i) => member(`Regular ${i}`, 0));
        for (const p of regulars) completedTrade(kay.pk, p.pk);
        sync();
        const shop = await enterprise(kay, 'Kay Kitchenware');
        setBalance(shop, 5_000);
        adminAssignTreasuryOperator(shop, otto.pk, owner.pk);
        const need = plantPost(shop, 'need', 1);
        moneyActs(shop, otto.pk, M.enterprisePaymentsPerDay - actsAs(shop, 'payment'), 'payment');
        const paid: Res[] = [];
        for (const p of regulars) paid.push(await call('POST', kay, `/api/treasury/${shop}/approve`, { transactionId: plantRequest(need, shop, p.pk) }));
        const statuses = paid.map((r) => (r.status === 200 ? '200' : `${r.status} ${r.body?.code}`));
        assert(statuses.slice(0, M.newRecipientsPerDay).every((s) => s === '200')
            && statuses.slice(M.newRecipientsPerDay).every((s) => s === '429 money_new_recipients_day')
            && ownFor(kay.pk, shop, 'payment') === M.newRecipientsPerDay,
            `Otto spent Kay Kitchenware's 1,000 payments; Kay pays 40 people she paid herself 40 days ago, whom the shop never paid: 30 go as her own new people and the 31st on is 429 money_new_recipients_day (${[...new Set(statuses)].join(', ')}; ${ownFor(kay.pk, shop, 'payment')} hers for it)`);

        // The shop's posts (writer-bounds.ts postTimes): a keeper's own post for it leaves the shop's count, so when one of
        // the shop's own leaves the day it has room again, whatever the keeper's own 100.
        const uma = member('Uma');
        const vin = member('Vin');
        completedTrade(uma.pk, tradie.pk);
        sync();
        const studio = await enterprise(uma, 'Uma Upholstery');
        adminAssignTreasuryOperator(studio, vin.pk, owner.pk);
        entPosts(studio, vin.pk, W.enterprisePostsPerDay - postsAs(studio));
        const umaForIt = await entOffer(uma, studio);
        const umaOwn = () => count('SELECT COUNT(*) AS n FROM keeper_own_posts WHERE keeper = ?', uma.pk);
        ownPosts(uma.pk, W.postsPerDay - 1 - count('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?', uma.pk));
        const umaSpent = await ownPost(uma);
        assert(umaForIt.status === 200 && umaOwn() === 1 && umaSpent.status === 429 && umaSpent.body?.code === 'posts_per_day',
            `setup: Vin spent Uma Upholstery's 1,000 posts, Uma put one up for it as her own, and her own 100 are spent (${show(umaForIt)}, ${show(umaSpent)})`);
        db.prepare(`UPDATE posts SET created_at = ? WHERE id = (SELECT id FROM posts WHERE author_pubkey = ? AND created_by = ? ORDER BY created_at LIMIT 1)`)
            .run(ago(DAY + HOUR), studio, vin.pk);
        const studioAgain = await entOffer(uma, studio);
        assert(studioAgain.status === 200 && umaOwn() === 1,
            `one of Vin's posts for it leaves the day: the shop is at 999, her own post not counted, so her next for it is the shop's and goes (${show(studioAgain)}, ${umaOwn()} of hers)`);

        // A keeper's enterprise work (writer-bounds.ts assertEnterpriseMayPostToday): the posts they put up as their own for
        // a spent shop are theirs, not their enterprise work.
        const wes = member('Wes');
        const yan = member('Yan');
        completedTrade(wes.pk, tradie.pk);
        completedTrade(yan.pk, tradie.pk);
        sync();
        const spentShop = await enterprise(yan, 'Yan Yarns');
        adminAssignTreasuryOperator(spentShop, wes.pk, owner.pk);
        const [roomy, spare] = [await enterprise(wes, 'Wes Wares'), await enterprise(wes, 'Wes Wool')];
        entPosts(spentShop, yan.pk, W.enterprisePostsPerDay - postsAs(spentShop));
        const wesOwn = await many(3, 1, () => entOffer(wes, spentShop));
        const wesOwnRows = count('SELECT COUNT(*) AS n FROM keeper_own_posts WHERE keeper = ?', wes.pk);
        entPosts(roomy, wes.pk, 500);
        entPosts(spare, wes.pk, W.enterpriseWorkPostsPerDay - 1 - (postsForEnterprises(wes.pk) - wesOwnRows));
        const work = postsForEnterprises(wes.pk) - wesOwnRows;
        const wesForRoomy = await entOffer(wes, roomy);
        assert(wesOwn.every((s) => s === 200) && wesOwnRows === 3 && work === W.enterpriseWorkPostsPerDay - 1 && wesForRoomy.status === 200,
            `Wes put up 3 posts of his own for Yan Yarns (spent) and ${work} for his enterprises: his next for Wes Wares, which has room, is his 1,000th and goes (${distinct(wesOwn)}, ${show(wesForRoomy)})`);
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
