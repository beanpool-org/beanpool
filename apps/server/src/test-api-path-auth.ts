/**
 * API path matching and request authentication — over a REAL HTTPS round trip.
 *
 * The signature middleware and every other path-based decision must classify a request the same way the
 * router dispatches it. This suite starts the actual server, drives each identity-bearing route with path
 * spellings that differ only in letter case, and asserts that nothing reaches a handler and nothing changes —
 * ledger rows, the node total (account balances + the Commons pot), and every table those routes write.
 *
 * It also pins the other half: handlers take the actor from authentication only, and a correctly signed
 * request on the canonical path still works.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-api-path-auth.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, reconcileLedgerFromDb, getCommonsBalanceExact, createConversation, sendMessage,
    registerPushToken, addFriend,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { createCommunityRoutes } from './routes/community.js';
import { ledger } from './engine/ledger.js';
import { db, createCrowdfundProject } from './db/db.js';

const PORT = 8641;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function seedMember(pk: string, callsign: string, balance: number) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
}

let seq = 0;
/** A completed marketplace trade, so the member has earned credit and may make direct sends. */
function completedTrade(buyer: string, seller: string, credits: number) {
    const pid = `pat-post-${seq++}`;
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status)
                VALUES (?, 'offer', 'misc', 'test', 'test', ?, ?, 'completed')`).run(pid, credits, seller);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status)
                VALUES (?, ?, ?, ?, ?, 'completed')`).run(`pat-mtx-${seq++}`, pid, buyer, seller, credits);
}

const balanceOf = (pk: string) => r4((db.prepare('SELECT balance FROM accounts WHERE public_key=?').get(pk) as any)?.balance ?? 0);
const nodeTotal = () => r4((db.prepare(
    `SELECT COALESCE(SUM(balance), 0) t FROM accounts WHERE public_key != 'COMMONS_POOL'`,
).get() as any).t + getCommonsBalanceExact());

/** Every table except logs, metrics and derived indexes, which background work may write at any time.
 *  Filled once the schema exists; a quiet-period check below proves the remainder holds still on its own. */
let WATCHED_TABLES: string[] = [];
const UNWATCHED = new Set(['system_logs', 'system_metrics', 'sync_audit_log', 'sync_cursors', 'pulse_items', 'sqlite_sequence']);
/** Everything the routes under test can write. `members.last_active_at` is excluded: the body parser
 *  records activity before authentication runs, and that is not what this suite is about. */
function snapshot(): string {
    const out: Record<string, string[]> = {};
    for (const t of WATCHED_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${t}`).all() as any[];
        out[t] = rows.map(r => { const c = { ...r }; delete c.last_active_at; return JSON.stringify(c); }).sort();
    }
    return JSON.stringify({ tables: out, commons: r4(getCommonsBalanceExact()) });
}
function diffTables(a: string, b: string): string[] {
    const A = JSON.parse(a), B = JSON.parse(b);
    const changed = WATCHED_TABLES.filter(t => JSON.stringify(A.tables[t]) !== JSON.stringify(B.tables[t]));
    if (A.commons !== B.commons) changed.push('commons');
    return changed;
}

async function send(method: string, path: string, body: unknown, signer?: Identity): Promise<{ status: number; error?: string }> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let error: string | undefined;
    try { error = (await res.json())?.error; } catch { /* not json */ }
    return { status: res.status, error };
}

/** Spellings of a lowercase path that differ only in letter case. */
function caseVariants(path: string): string[] {
    const segs = path.split('/'); // ['', 'api', 'ledger', 'transfer']
    const firstUpper = ['', segs[1].toUpperCase(), ...segs.slice(2)].join('/');
    const secondTitle = ['', segs[1], segs[2][0].toUpperCase() + segs[2].slice(1), ...segs.slice(3)].join('/');
    return [path.toUpperCase(), firstUpper, secondTitle];
}

async function main() {
    console.log('Running API path matching / request authentication tests (real HTTPS)...\n');
    await initTls();
    initStateEngine();
    WATCHED_TABLES = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[])
        .map(r => r.name as string)
        .filter(n => !UNWATCHED.has(n) && !n.startsWith('posts_fts'));

    const victim = keypair();
    const other = keypair();
    const third = keypair();
    seedMember(victim.pub, `victim-${victim.pub.slice(0, 6)}`, 100);
    seedMember(other.pub, `other-${other.pub.slice(0, 6)}`, 20);
    seedMember(third.pub, `third-${third.pub.slice(0, 6)}`, 0);
    completedTrade(victim.pub, third.pub, 5);
    reconcileLedgerFromDb();

    const conv = createConversation('dm', [victim.pub, other.pub], victim.pub);
    if (!conv) throw new Error('fixture: conversation not created');
    const msg = sendMessage(conv.id, victim.pub, 'original-ciphertext', 'original-nonce');
    if (!msg) throw new Error('fixture: message not created');
    registerPushToken(victim.pub, 'victim-existing-token', 'android');
    addFriend(victim.pub, other.pub);
    const crowdfundId = crypto.randomUUID();
    createCrowdfundProject(crowdfundId, third.pub, `Fixture project ${crowdfundId.slice(0, 6)}`, 'fixture', [], 500, null);
    reconcileLedgerFromDb();

    await startHttpsServer(PORT);

    {
        const a = snapshot();
        await new Promise(r => setTimeout(r, 1500));
        const quiet = diffTables(a, snapshot());
        if (quiet.length) throw new Error(`fixture: watched tables change with no requests (${quiet.join(', ')}) — exclude them`);
    }

    // Every route whose actor used to be read from the body when authentication was absent.
    const routes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [
        { method: 'POST', path: '/api/ledger/transfer', body: { from: victim.pub, to: other.pub, amount: 10 } },
        { method: 'POST', path: '/api/profile/update', body: { publicKey: victim.pub, bio: 'changed by someone else' } },
        { method: 'POST', path: '/api/push-tokens', body: { publicKey: victim.pub, token: 'foreign-token', platform: 'android' } },
        { method: 'DELETE', path: '/api/push-tokens', body: { publicKey: victim.pub, token: 'victim-existing-token' } },
        { method: 'POST', path: '/api/members/preferences', body: { publicKey: victim.pub, preferences: { messages: false } } },
        { method: 'POST', path: '/api/reports', body: { reporterPubkey: victim.pub, targetPubkey: other.pub, reason: 'filed in their name' } },
        { method: 'POST', path: '/api/friends/add', body: { ownerPubkey: victim.pub, friendPubkey: third.pub } },
        { method: 'POST', path: '/api/friends/remove', body: { ownerPubkey: victim.pub, friendPubkey: other.pub } },
        { method: 'POST', path: '/api/messages/edit', body: { messageId: msg.id, ciphertext: 'replaced', nonce: 'replaced', authorPubkey: victim.pub } },
        { method: 'POST', path: '/api/messages/mark-read', body: { pubkey: victim.pub, conversationId: conv.id } },
        { method: 'POST', path: '/api/messages/react', body: { messageId: msg.id, authorPubkey: victim.pub, emoji: '👍' } },
        { method: 'POST', path: `/api/crowdfund/projects/${crowdfundId}/pledge`, body: { fromPubkey: victim.pub, amount: 5 } },
        { method: 'POST', path: '/api/crowdfund/projects', body: { creatorPubkey: victim.pub, title: 'Made in their name', goalAmount: 50 } },
        { method: 'POST', path: '/api/commons/projects', body: { proposerPubkey: victim.pub, title: 'Proposed in their name', requestedAmount: 50 } },
        { method: 'POST', path: '/api/commons/vote', body: { voterPubkey: victim.pub, projectId: 'none' } },
    ];

    // ── 1. The ledger transfer route, spelled differently, unsigned, naming another member as `from` ──────
    {
        const path = '/api/ledger/transfer';
        for (const variant of caseVariants(path)) {
            const vBefore = balanceOf(victim.pub), oBefore = balanceOf(other.pub), totalBefore = nodeTotal();
            const res = await send('POST', variant, { from: victim.pub, to: other.pub, amount: 10 });
            const vAfter = balanceOf(victim.pub), oAfter = balanceOf(other.pub), totalAfter = nodeTotal();
            console.log(`   ${variant}: HTTP ${res.status}; victim ${vBefore} → ${vAfter}, recipient ${oBefore} → ${oAfter}, node total ${totalBefore} → ${totalAfter}`);
            assert(res.status >= 400, `POST ${variant} unsigned is refused (got ${res.status} ${res.error ?? ''})`);
            assert(vAfter === vBefore, `POST ${variant}: the named sender's balance is unchanged (${vBefore} → ${vAfter})`);
            assert(oAfter === oBefore, `POST ${variant}: the recipient's balance is unchanged (${oBefore} → ${oAfter})`);
            assert(totalAfter === totalBefore, `POST ${variant}: SUM(balances) + Commons is unchanged (${totalBefore} → ${totalAfter})`);
        }
    }

    // ── 2. Every identity-bearing route, every case spelling, unsigned: refused and nothing changes ───────
    for (const r of routes) {
        for (const variant of caseVariants(r.path)) {
            const before = snapshot();
            const res = await send(r.method, variant, r.body);
            const changed = diffTables(before, snapshot());
            assert(res.status >= 400, `${r.method} ${variant} unsigned is refused (got ${res.status} ${res.error ?? ''})`);
            assert(changed.length === 0, `${r.method} ${variant} unsigned changes nothing${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`);
        }
    }

    // ── 3. The canonical lowercase path, unsigned: 401, nothing changes ──────────────────────────────────
    for (const r of routes) {
        const before = snapshot();
        const res = await send(r.method, r.path, r.body);
        const changed = diffTables(before, snapshot());
        assert(res.status === 401, `${r.method} ${r.path} unsigned → 401 (got ${res.status} ${res.error ?? ''})`);
        assert(changed.length === 0, `${r.method} ${r.path} unsigned changes nothing${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`);
    }

    // ── 3b. The dead GitHub exchange path is no longer exempt from the signature check ───────────────────
    // It sat on the bypass list with no handler anywhere (left from the web-flow attempt the device flow
    // replaced), so an unsigned write sailed past authentication and fell through to a 404. Off the list,
    // anything ever mounted there starts out behind the signature check instead of in front of it.
    {
        const before = snapshot();
        const res = await send('POST', '/api/recovery/sso/github-exchange', { code: 'x', state: 'y' });
        assert(res.status === 401, `POST /api/recovery/sso/github-exchange unsigned → 401 (got ${res.status} ${res.error ?? ''})`);
        assert(diffTables(before, snapshot()).length === 0, 'POST /api/recovery/sso/github-exchange unsigned changes nothing');
    }

    // ── 4. Signed, but by someone else naming the victim as sender: refused, no beans move ───────────────
    {
        const before = snapshot();
        const res = await send('POST', '/api/ledger/transfer', { from: victim.pub, to: other.pub, amount: 10 }, other);
        assert(res.status === 403, `a transfer signed by another key naming the victim as from → 403 (got ${res.status} ${res.error ?? ''})`);
        assert(diffTables(before, snapshot()).length === 0, 'and nothing changes');
    }

    // ── 5. Signed by the victim, but on a differently-cased path: still refused, nothing changes ─────────
    for (const variant of caseVariants('/api/ledger/transfer')) {
        const before = snapshot();
        const res = await send('POST', variant, { to: other.pub, amount: 1 }, victim);
        assert(res.status >= 400, `a signed POST ${variant} is refused (got ${res.status} ${res.error ?? ''})`);
        assert(diffTables(before, snapshot()).length === 0, `signed POST ${variant} changes nothing`);
    }

    // ── 6. Correctly signed requests on the canonical path still work ────────────────────────────────────
    {
        const vBefore = balanceOf(victim.pub), oBefore = balanceOf(other.pub), totalBefore = nodeTotal();
        const res = await send('POST', '/api/ledger/transfer', { to: other.pub, amount: 7 }, victim);
        assert(res.status === 200, `a signed transfer by the sender succeeds (got ${res.status} ${res.error ?? ''})`);
        assert(balanceOf(victim.pub) === r4(vBefore - 7), `the signer is debited 7 (${vBefore} → ${balanceOf(victim.pub)})`);
        assert(balanceOf(other.pub) === r4(oBefore + 7), `the recipient is credited 7 (${oBefore} → ${balanceOf(other.pub)})`);
        assert(nodeTotal() === totalBefore, `SUM(balances) + Commons is conserved (${totalBefore} → ${nodeTotal()})`);

        const withFrom = await send('POST', '/api/ledger/transfer', { from: victim.pub, to: other.pub, amount: 1 }, victim);
        assert(withFrom.status === 200, `a signed transfer that also names itself as from succeeds (got ${withFrom.status} ${withFrom.error ?? ''})`);
    }
    {
        const r = await send('POST', '/api/profile/update', { publicKey: victim.pub, bio: 'my own bio' }, victim);
        assert(r.status === 200, `signed profile update succeeds (got ${r.status} ${r.error ?? ''})`);
        const bio = (db.prepare('SELECT bio FROM members WHERE public_key=?').get(victim.pub) as any)?.bio;
        assert(bio === 'my own bio', `and the signer's own profile is the one updated (bio=${bio})`);
    }
    {
        const r = await send('POST', '/api/push-tokens', { publicKey: victim.pub, token: 'my-new-token', platform: 'ios' }, victim);
        assert(r.status === 200, `signed push-token register succeeds (got ${r.status} ${r.error ?? ''})`);
        const d = await send('DELETE', '/api/push-tokens', { publicKey: victim.pub, token: 'my-new-token' }, victim);
        assert(d.status === 200, `signed push-token delete succeeds (got ${d.status} ${d.error ?? ''})`);
    }
    {
        const r = await send('POST', '/api/members/preferences', { publicKey: victim.pub, preferences: { messages: false } }, victim);
        assert(r.status === 200, `signed preferences update succeeds (got ${r.status} ${r.error ?? ''})`);
    }
    {
        const r = await send('POST', '/api/friends/add', { ownerPubkey: victim.pub, friendPubkey: third.pub }, victim);
        assert(r.status === 200, `signed friends/add succeeds (got ${r.status} ${r.error ?? ''})`);
        const rm = await send('POST', '/api/friends/remove', { ownerPubkey: victim.pub, friendPubkey: third.pub }, victim);
        assert(rm.status === 200, `signed friends/remove succeeds (got ${rm.status} ${rm.error ?? ''})`);
    }
    {
        const r = await send('POST', '/api/reports', { reporterPubkey: victim.pub, targetPubkey: other.pub, reason: 'a real report' }, victim);
        assert(r.status === 200, `signed report succeeds (got ${r.status} ${r.error ?? ''})`);
    }
    {
        const e = await send('POST', '/api/messages/edit', { messageId: msg.id, ciphertext: 'my-edit', nonce: 'my-nonce' }, victim);
        assert(e.status === 200, `signed message edit by the author succeeds (got ${e.status} ${e.error ?? ''})`);
        const mr = await send('POST', '/api/messages/mark-read', { conversationId: conv.id }, victim);
        assert(mr.status === 200, `signed mark-read by a participant succeeds (got ${mr.status} ${mr.error ?? ''})`);
        const re = await send('POST', '/api/messages/react', { messageId: msg.id, emoji: '👍' }, victim);
        assert(re.status === 200, `signed reaction by a participant succeeds (got ${re.status} ${re.error ?? ''})`);
    }
    {
        const vBefore = balanceOf(victim.pub), totalBefore = nodeTotal();
        const r = await send('POST', `/api/crowdfund/projects/${crowdfundId}/pledge`, { amount: 3 }, victim);
        assert(r.status === 200, `signed crowdfund pledge succeeds (got ${r.status} ${r.error ?? ''})`);
        assert(balanceOf(victim.pub) === r4(vBefore - 3), `the pledger is debited 3 (${vBefore} → ${balanceOf(victim.pub)})`);
        assert(nodeTotal() === totalBefore, `SUM(balances) + Commons is conserved by the pledge (${totalBefore} → ${nodeTotal()})`);
    }

    // ── 6b. Route parameters keep their case: only a route's literal segments must be lowercase ──────────
    {
        const r = await fetch(`${BASE}/api/members/callsign-available/SomeMixedCaseName`);
        assert(r.status === 200, `a mixed-case callsign parameter still reaches its route (got ${r.status})`);
        const unrouted = await fetch(`${BASE}/Api/not-a-route`);
        assert(unrouted.status === 404, `an unrouted path under a non-lowercase /api prefix is 404 (got ${unrouted.status})`);
        const nonApi = await fetch(`${BASE}/SETTINGS-LEGACY`);
        assert(nonApi.status === 404, `a non-API route reached only by ignoring case is 404 (got ${nonApi.status})`);
    }

    // ── 7. The transfer handler itself refuses without a matching authenticated signer ───────────────────
    // Reached only if some future middleware change let a request through unauthenticated; driven directly.
    {
        const router = createCommunityRoutes({
            checkAdminAuth: async () => false, rateLimit: () => true, clampLimit: () => 50, clampOffset: () => 0,
            activeConnections: new Map(), calculateAnalytics: () => ({}), enforceReadAuth: false, broadcast: () => {},
        } as any);
        const dispatch = router.routes();
        const cases: Array<[string, Record<string, unknown>]> = [
            ['no actor, from in body', {}],
            ['actor without a signature', { actor: victim.pub }],
            ['actor and signer disagree', { actor: victim.pub, authSig: { signer: other.pub, signature: 'x', payload: 'x' } }],
        ];
        for (const [label, state] of cases) {
            const before = snapshot();
            const ctx: any = {
                method: 'POST', path: '/api/ledger/transfer', state, request: {},
                requestBody: { from: victim.pub, to: other.pub, amount: 5 },
                set() {}, get() { return ''; },
            };
            await dispatch(ctx, async () => {});
            assert(ctx.status === 401, `transfer handler, ${label} → 401 (got ${ctx.status})`);
            assert(diffTables(before, snapshot()).length === 0, `transfer handler, ${label}: nothing changes`);
        }
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ ALL API PATH / REQUEST AUTH CHECKS PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
